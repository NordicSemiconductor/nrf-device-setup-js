/* Copyright (c) 2010 - 2018, Nordic Semiconductor ASA
 *
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * 1. Redistributions of source code must retain the above copyright notice, this
 *    list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * 3. Neither the name of Nordic Semiconductor ASA nor the names of its
 *    contributors may be used to endorse or promote products derived from this
 *    software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY, AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL NORDIC SEMICONDUCTOR ASA OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import Debug from 'debug';
import SerialPort from 'serialport';

import DeviceLister from 'nrf-device-lister';
import MemoryMap from 'nrf-intel-hex';
import { DfuUpdates, DfuTransportUsbSerial, DfuOperation } from 'pc-nrf-dfu-js';
import * as initPacket from './util/initPacket';
import * as dfuTrigger from './dfuTrigger';
import * as jprogFunc from './jprogFunc';

/**
 * @const {number} DEFAULT_DEVICE_WAIT_TIME Default wait time for UART port to
 * show up in operating system
 */
const DEFAULT_DEVICE_WAIT_TIME = 10000;
const BASEPATH = path.dirname(require.resolve('.'));
const LATEST_BOOTLOADER = 'graviton_bootloader_v1.0.1-[nRF5_SDK_15.0.1-1.alpha_f76d012].zip';
const LATEST_BOOTLOADER_PATH = path.resolve(BASEPATH, '../bootloader', LATEST_BOOTLOADER);
const LATEST_BOOTLOADER_VERSION = 3; // check with nrfutil pkg display ...

const {
    getDFUInterfaceNumber,
    getSemVersion,
    detach,
} = dfuTrigger;

const {
    InitPacket, FwType, HashType, createInitPacketUint8Array,
} = initPacket;

const {
    openJLink,
    closeJLink,
    verifySerialPortAvailable,
    getDeviceFamily,
    validateFirmware,
    programFirmware,
} = jprogFunc;

const debug = Debug('device-setup');
const debugError = Debug('device-setup:error');

/**
 * Aux function. Returns a promise that resolves after the given time.
 *
 * @param {number} ms Time, in milliseconds, to wait until promise resolution
 * @returns {Promise<undefined>} Promise that resolves after a time
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if the device is currently running DFU Bootloader
 *
 * @param {object} device nrf-device-lister device
 * @returns {boolean} true if device is currently in DFU Bootloader
 */
function isDeviceInDFUBootloader(device) {
    if (!device) {
        return false;
    }
    if (device.usb) {
        const { deviceDescriptor: d } = device.usb.device;
        return (d.idVendor === 0x1915 && d.idProduct === 0x521f);
    }
    if (device.serialport) {
        const { vendorId, productId } = device.serialport;
        return (vendorId === '1915' && productId.toUpperCase() === '521F');
    }
    return false;
}

/**
 * Waits until a device (with a matching serial number) is listed by
 * nrf-device-lister, up to a maximum of `timeout` milliseconds.
 *
 * If `expectedTraits` is given, then the device must (in addition to
 * a matching serial number) also have the given traits. See the
 * nrf-device-lister library for the full list of traits.
 *
 * @param {string} serialNumber of the device expected to appear
 * @param {number} [timeout] Timeout, in milliseconds, to wait for device enumeration
 * @param {Array} [expectedTraits] The traits that the device is expected to have
 * @returns {Promise} resolved to the expected device
 */
export function waitForDevice(serialNumber, timeout = DEFAULT_DEVICE_WAIT_TIME, expectedTraits = ['serialport']) {
    debug(`Will wait for device ${serialNumber}`);

    return new Promise((resolve, reject) => {
        let timeoutId;
        const lister = new DeviceLister({
            nordicUsb: true, nordicDfu: true, serialport: true,
        });

        function checkConflation(deviceMap) {
            const device = deviceMap.get(serialNumber);
            if (device && expectedTraits.every(trait => device.traits.includes(trait))) {
                clearTimeout(timeoutId);
                lister.removeListener('conflated', checkConflation);
                lister.removeListener('error', debugError);
                lister.stop();
                debug(`... found ${serialNumber}`);
                resolve(device);
            }
        }

        timeoutId = setTimeout(() => {
            debug(`Timeout when waiting for attachment of device with serial number ${serialNumber}`);
            lister.removeListener('conflated', checkConflation);
            lister.removeListener('error', debugError);
            lister.stop();
            reject(new Error(`Timeout while waiting for device  ${serialNumber} to be attached and enumerated`));
        }, timeout);

        lister.on('error', debugError);
        lister.on('conflated', checkConflation);
        lister.start();
    });
}

/**
 * Sends a detach request to a device and waits until it gets reattached.
 *
 * @param {object} usbdev instance of usb device
 * @param {number} interfaceNumber of the trigger interface
 * @param {string} serialNumber of the device expected after reattach
 * @return {Promise} resolves to reattached device
 */
export function detachAndWaitFor(usbdev, interfaceNumber, serialNumber) {
    debug('Sending detach, will wait for attach');
    return detach(usbdev)
        .then(() => waitForDevice(serialNumber));
}

/**
 * Calculates SHA256 hash of image
 *
 * @param {Uint8Array} image to calculate hash from
 * @return {Buffer} SHA256 hash
 */
function calculateSHA256Hash(image) {
    const digest = createHash('sha256');
    digest.update(image);
    return Buffer.from(digest.digest().reverse());
}


/**
 * Loads firmware image from HEX file
 *
 * @param {Buffer|string} firmware contents of HEX file if Buffer otherwhise path of HEX file
 * @return {Uint8Array} the loaded firmware
 */
function parseFirmwareImage(firmware) {
    const contents = (firmware instanceof Buffer) ? firmware : fs.readFileSync(firmware);
    const memMap = MemoryMap.fromHex(contents);
    let startAddress;
    let endAddress;
    memMap.forEach((block, address) => {
        startAddress = !startAddress ? address : startAddress;
        endAddress = address + block.length;
    });
    return memMap.slicePad(startAddress, Math.ceil((endAddress - startAddress) / 4) * 4);
}

/**
 * Ensures that device has a serialport that is ready to be opened
 * @param {object} device nrf-device-lister's device
 * @param {boolean} needSerialport indicates if the device is expected to have a serialport
 * @returns {Promise} resolved to device
 */
async function validateSerialPort(device, needSerialport) {
    if (!needSerialport) {
        debug('device doesn`t need serialport');
        return device;
    }

    const checkOpen = comName => new Promise(resolve => {
        const port = new SerialPort(comName, { baudRate: 115200 }, err => {
            if (!err) port.close();
            resolve(!err);
        });
    });

    for (let i = 10; i > 1; i -= 1) {
        /* eslint-disable-next-line no-await-in-loop */
        await sleep(2000 / i);
        debug('validating serialport', device.serialport.comName, i);
        /* eslint-disable-next-line no-await-in-loop */
        if (await checkOpen(device.serialport.comName)) {
            debug('resolving', device);
            return device;
        }
    }
    throw new Error('couldn`t open serialport');
}

/**
 * Prepares a device which is expected to be in DFU Bootlader.
 * First it loads the firmware from HEX file specified by dfu argument,
 * then performs the DFU operation.
 * This causes the device to be detached, so finally it waits for it to be attached again.
 *
 * @param {object} device nrf-device-lister's device
 * @param {object} dfu configuration object for performing the DFU
 * @returns {Promise} resolved to prepared device
 */
async function prepareInDFUBootloader(device, dfu) {
    const { comName } = device.serialport;
    debug(`${device.serialNumber} on ${comName} is now in DFU-Bootloader...`);

    const { application, softdevice } = dfu;
    let { params } = dfu;
    params = params || {};

    const firmwareUpdates = [];
    if (softdevice) {
        const firmwareImage = parseFirmwareImage(softdevice);

        const initPacketParams = new InitPacket()
            .set('fwType', FwType.SOFTDEVICE)
            .set('fwVersion', 0xffffffff)
            .set('hwVersion', params.hwVersion || 52)
            .set('hashType', HashType.SHA256)
            .set('hash', calculateSHA256Hash(firmwareImage))
            .set('sdSize', firmwareImage.length)
            .set('sdReq', params.sdReq || []);

        const packet = createInitPacketUint8Array(initPacketParams);
        firmwareUpdates.push({ initPacket: packet, firmwareImage });
    }

    const firmwareImage = parseFirmwareImage(application);

    const initPacketParams = new InitPacket()
        .set('fwType', FwType.APPLICATION)
        .set('fwVersion', params.fwVersion || 4)
        .set('hwVersion', params.hwVersion || 52)
        .set('hashType', HashType.SHA256)
        .set('hash', calculateSHA256Hash(firmwareImage))
        .set('appSize', firmwareImage.length)
        .set('sdReq', params.sdId || []);

    const packet = createInitPacketUint8Array(initPacketParams);
    firmwareUpdates.push({ initPacket: packet, firmwareImage });

    const usbSerialTransport = new DfuTransportUsbSerial(device.serialNumber, 0);
    const dfuOperation = new DfuOperation(new DfuUpdates(firmwareUpdates), usbSerialTransport);

    debug('Starting DFU');
    await dfuOperation.start(true);
    debug('DFU completed successfully!');

    return waitForDevice(device.serialNumber, DEFAULT_DEVICE_WAIT_TIME, ['serialport', 'nordicUsb']);
}

/**
 * Helper function that calls optional user defined confirmation e.g. dialog or inquirer.
 *
 * @param {function} promiseConfirm Promise returning function
 * @returns {Promise} resolves to boolean
 */
async function confirmHelper(promiseConfirm) {
    if (!promiseConfirm) return true;
    try {
        return await promiseConfirm('Device must be programmed, do you want to proceed?');
    } catch (err) {
        throw new Error('Preparation cancelled by user');
    }
}

/**
 * Helper function that calls optional user defined choice e.g. dialog or inquirer.
 *
 * @param {array} choices array of choices
 * @param {function} promiseChoice Promise returning function
 * @returns {Promise} resolves to user selected choice or first element
 */
async function choiceHelper(choices, promiseChoice) {
    if (choices.length > 1 && promiseChoice) {
        return promiseChoice('Which firmware do you want to program?', choices);
    }
    return choices.pop();
}

/**
 * Get firmware version of currently running dfu bootloader.
 *
 * @param {Object} device device
 * @returns {Promise<number>} version number of bootloader
 */
async function getBootloaderVersion(device) {
    const usbSerialTransport = new DfuTransportUsbSerial(device.serialNumber, 0);
    const firmwareVersions = await usbSerialTransport.getAllFirmwareVersions();
    await new Promise(resolve => usbSerialTransport.port.close(resolve));

    const bootloaderVersion = firmwareVersions.find(fw => fw.imageType === 'Bootloader');
    if (!bootloaderVersion) {
        throw new Error('Bootloader version couldn`t be found');
    }

    debug(`Bootloader version ${bootloaderVersion.version} is found.`);
    return bootloaderVersion.version;
}

/**
 * Updates the dfu bootloader.
 * The bootloader is loaded from signed official zip file contained in this module.
 *
 * @param {Object} device device
 * @returns {Promise<Object>} device object after dfu is completed and device is enumerated again.
 */
async function updateBootloader(device) {
    const { comName } = device.serialport;
    debug(`Bootloader for device ${device.serialNumber} on ${comName} will be updated`);

    const updates = await DfuUpdates.fromZipFilePath(LATEST_BOOTLOADER_PATH);
    const usbSerialTransport = new DfuTransportUsbSerial(device.serialNumber, 0);
    const dfuOperation = new DfuOperation(updates, usbSerialTransport);

    debug('Starting Bootloader DFU');
    await dfuOperation.start(true);
    debug('Bootloader DFU completed successfully!');

    return waitForDevice(device.serialNumber, DEFAULT_DEVICE_WAIT_TIME, ['serialport']);
}

/**
 * Procedure of checking firmware version of the currently running bootloader,
 * in case it's not the latest - after confirmation - it is updated.
 *
 * @param {Object} device device
 * @param {function} promiseConfirm funtion that returns Promise<boolean> for confirmation
 * @returns {Promise<Object>} updated device
 */
async function checkConfirmUpdateBootloader(device, promiseConfirm) {
    if (!promiseConfirm) {
        // without explicit consent bootloader will not be updated
        return device;
    }
    const bootloaderVersion = await getBootloaderVersion(device);
    if (bootloaderVersion >= LATEST_BOOTLOADER_VERSION) {
        return device;
    }
    if (!await promiseConfirm('Newer version of the bootloader is available, do you want to update it?')) {
        debug('Continuing with old bootloader');
        return device;
    }
    return updateBootloader(device);
}

/**
 * Trigger DFU Bootloader mode if the device is not yet in that mode.
 *
 * @param {Object} device device
 * @returns {Promise<Object>} device object which is already in bootloader.
 */
export async function ensureBootloaderMode(device) {
    const { serialNumber } = device;
    if (isDeviceInDFUBootloader(device)) {
        debug('Device is in bootloader mode');
        return device;
    }
    let usbdev = device.usb;
    let retry = 0;
    while (!usbdev && retry < 3) {
        retry += 1;
        debug('missing usb, looking for it again');
        /* eslint-disable-next-line no-await-in-loop */
        usbdev = await waitForDevice(serialNumber, DEFAULT_DEVICE_WAIT_TIME, ['nordicUsb']).usb;
    }
    if (!usbdev) {
        throw new Error('Couldn`t recognize expected nordic usb device');
    }
    debug('Trying to trigger bootloader mode');
    return detachAndWaitFor(
        usbdev.device,
        getDFUInterfaceNumber(device.usb.device),
        serialNumber,
    );
}

/**
 * Adds detailed output if enabled in options
 *
 * @param {Object} device device
 * @param {Object} details device
 * @param {boolean} detailedOutput device
 * @returns {Object} Either the device or the {device, details} object
 */
const createReturnValue = (device, details, detailedOutput) => (
    detailedOutput ? { device, details } : device
);

/**
 * DFU procedure which also tries to update bootloader in case bootloader mode is
 * set during the process and it happens to be outdated.
 *
 * @param {Object} selectedDevice device
 * @param {Object} options options
 * @returns {Promise} device or { device, details } object
 */
async function performDFU(selectedDevice, options) {
    const {
        dfu, needSerialport, detailedOutput,
        promiseConfirm, promiseConfirmBootloader, promiseChoice,
    } = options;
    const isConfirmed = await confirmHelper(promiseConfirm);
    if (!isConfirmed) {
        // go on without DFU
        return createReturnValue(selectedDevice, { wasProgrammed: false }, detailedOutput);
    }
    const choice = await choiceHelper(Object.keys(dfu), promiseChoice);

    try {
        let device = await ensureBootloaderMode(selectedDevice);
        device = await checkConfirmUpdateBootloader(
            device,
            promiseConfirmBootloader || promiseConfirm,
        );
        device = await ensureBootloaderMode(device);
        device = await prepareInDFUBootloader(device, dfu[choice]);
        device = await validateSerialPort(device, needSerialport);

        debug('DFU finished: ', device);
        return createReturnValue(device, { wasProgrammed: true }, detailedOutput);
    } catch (err) {
        debug('DFU failed: ', err);
        throw err;
    }
}

/**
 * Prepares a device listed by nrf-device-lister with expected application firmware
 * configured by options for different device types.
 * Based on the device type it decides whether it should be programmed by DFU or JProg.
 * Resolves if the setup was successful. Rejects with an error if the setup failed.
 * If detailedOutput is enabled, it will resolve with an object on the form
 * { device: {}, details: { wasProgrammed: [true|false] } }. If not, it will resolve
 * with the device object only.
 *
 * @example
 * const preparedDevice = await setupDevice(selectedDevice,
 *     {
 *         dfu: {
 *             // can have several firmwares defined, the key will be offered to choose from
 *             pca10059: {
 *                 fw: path.resolve(__dirname, 'fw/rssi-10059.hex'),
 *                 semver: 'rssi_cdc_acm 2.0.0+dfuMar-27-2018-12-41-04',
 *             },
 *         },
 *         jprog: {
 *             nrf52: {
 *                 fw: path.resolve(__dirname, 'fw/rssi-10040.hex'),
 *                 fwVersion: 'rssi-fw-1.0.0',
 *                 fwIdAddress: 0x2000,
 *             },
 *         },
 *         needSerialport: true,
 *         detailedOutput: false,
 *
 *         // called if programming is needed to be confirmed
 *         promiseConfirm: async message => (await inquirer.prompt([{
 *             type: 'confirm', name: 'isConfirmed', message, default: false,
 *         }])).isConfirmed,
 *
 *         // called if user need make a choice e.g. multiple DFU firmwares are defined
 *         promiseChoice: async (message, choices) => (await inquirer.prompt([{
 *             type: 'list', name: 'choice', message, choices,
 *         }])).choice,
 *     },
 * );
 *
 * @param {object} selectedDevice nrf-device-lister's device
 * @param {object} options Setup options, as shown in the example above. May include
 * { jprog, dfu, needSerialport, detailedOutput, promiseChoice, promiseConfirm }
 * @returns {Promise} Resolves with the device object that was set up, or
 * device and details if detailedOutput is enabled.
 */
export function setupDevice(selectedDevice, options) {
    const {
        jprog, dfu, needSerialport, detailedOutput, promiseConfirm,
    } = options;

    if (dfu && Object.keys(dfu).length !== 0) {
        // check if device is in DFU-Bootlader, it might _only_ have serialport
        if (isDeviceInDFUBootloader(selectedDevice)) {
            debug('Device is in DFU-Bootloader, DFU is defined');
            return performDFU(selectedDevice, options);
        }

        const usbdevice = selectedDevice.usb;

        if (usbdevice) {
            const usbdev = usbdevice.device;
            const interfaceNumber = getDFUInterfaceNumber(usbdev);
            if (interfaceNumber >= 0) {
                debug('Device has DFU trigger interface, probably in Application mode');
                return getSemVersion(usbdev, interfaceNumber)
                    .then(semver => {
                        debug(`'${semver}'`);
                        if (Object.keys(dfu).map(key => dfu[key].semver).includes(semver)) {
                            if (needSerialport && !selectedDevice.serialport) {
                                return Promise.reject(new Error('Missing serial port'));
                            }
                            debug('Device is running the correct fw version');
                            return createReturnValue(
                                selectedDevice,
                                { wasProgrammed: false }, detailedOutput,
                            );
                        }
                        debug('Device requires different firmware');
                        return performDFU(selectedDevice, options);
                    });
            }
            debug('Device is not in DFU-Bootloader and has no DFU trigger interface');
        }
    }


    if (jprog && selectedDevice.traits.includes('jlink')) {
        let firmwareFamily;
        let wasProgrammed = false;
        return Promise.resolve()
            .then(() => needSerialport && verifySerialPortAvailable(selectedDevice))
            .then(() => openJLink(selectedDevice))
            .then(() => getDeviceFamily(selectedDevice))
            .then(family => {
                firmwareFamily = jprog[family];
                if (!firmwareFamily) {
                    throw new Error(`No firmware defined for ${family} family`);
                }
            })
            .then(() => validateFirmware(selectedDevice, firmwareFamily))
            .then(valid => {
                if (valid) {
                    debug('Application firmware id matches');
                    return selectedDevice;
                }
                return confirmHelper(promiseConfirm)
                    .then(isConfirmed => {
                        if (!isConfirmed) {
                            // go on without update
                            return selectedDevice;
                        }
                        return programFirmware(selectedDevice, firmwareFamily)
                            .then(() => {
                                wasProgrammed = true;
                            });
                    });
            })
            .then(
                () => closeJLink(selectedDevice).then(() => selectedDevice),
                err => closeJLink(selectedDevice).then(() => Promise.reject(err))
            )
            .then(() => createReturnValue(selectedDevice, { wasProgrammed }, detailedOutput));
    }

    debug('Selected device cannot be prepared, maybe the app still can use it');
    return Promise.resolve(createReturnValue(
        selectedDevice,
        { wasProgrammed: false }, detailedOutput,
    ));
}
