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
import { createHash } from 'crypto';
import SerialPort from 'serialport';
import Debug from 'debug';

import DeviceLister from 'nrf-device-lister';
import MemoryMap from 'nrf-intel-hex';
import { DfuUpdates, DfuTransportSerial, DfuOperation } from 'pc-nrf-dfu-js';
import * as initPacket from './util/initPacket';
import * as dfuTrigger from './dfuTrigger';
import * as jprogFunc from './jprogFunc';

const {
    getDFUInterfaceNumber,
    getSemVersion,
    sendDetachRequest,
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
        const d = device.usb.device.deviceDescriptor;
        return (d.idVendor === 0x1915 && d.idProduct === 0x521f);
    }
    if (device.serialport) {
        const { vendorId, productId } = device.serialport;
        return (vendorId === '1915' && productId === '521F');
    }
    return false;
}

/**
 * Waits until a device (with a matching serial number) is listed by
 * nrf-device-lister, up to a maximum of `timeout` milliseconds.
 *
 * @param {string} serialNumber of the device expected to appear
 * @param {number} timeout Timeout, in milliseconds, to wait for device enumeration
 * @returns {Promise} resolved to the expected device
 */
export function waitForDevice(serialNumber, timeout = 5000) {
    debug(`Will wait for device ${serialNumber}`);

    const lister = new DeviceLister({
        nordicUsb: true, nordicDfu: true, serialport: true,
    });

    return new Promise((resolve, reject) => {
        let timeoutId;

        function checkConflation(deviceMap) {
            const device = deviceMap.get(serialNumber);
            if (device && device.serialport) {
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
 * Given a serial number, requests a reenumeration of devices from
 * nrf-device-lister, and returns a Promise to the device with the given
 * serial number.
 *
 * @param {string|number} serialNumber of the device
 * @returns {Promise<object>} A device record as per nrf-device-lister
 */
function getDeviceBySerialNumber(serialNumber) {
    const lister = new DeviceLister({
        nordicUsb: true, nordicDfu: true, serialport: true, jlink: true,
    });
    lister.on('error', () => {});
    return lister.reenumerate().then(deviceMap => {
        const device = deviceMap.get(serialNumber);
        if (!device) {
            throw new Error('There is no device with the serial number given');
        }
        return device;
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
    return memMap.slicePad(startAddress, endAddress - startAddress);
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
async function prepareInDFUBootloader(dev, dfu) {
    let device = dev;

    if (!isDeviceInDFUBootloader(device)) {
        const usbdev = device.usb.device;
        debug('Switching to bootloader mode.');
        const newSerNr = await predictSerialNumberAfterReset(usbdev);
        debug('Serial number after reset should be:', newSerNr);
        device = await detachAndWaitFor(usbdev, getDFUInterfaceNumber(usbdev), newSerNr);
    }

    const { comName } = device.serialport;
    debug(`${device.serialNumber} on ${comName} is now in DFU-Bootloader...`);

    const { application, softdevice } = dfu;
    let { params } = dfu;
    params = params || {};

    if (softdevice) {
        const firmwareImage = parseFirmwareImage(softdevice);

        const initPacketParams = new InitPacket()
            .set('fwType', FwType.SOFTDEVICE)
            .set('fwVersion', 0xffffffff)
            .set('hwVersion', params.hwVersion || 52)
            .set('hashType', HashType.SHA256)
            .set('hash', calculateSHA256Hash(firmwareImage))
            .set('sdSize', firmwareImage.length)
            .set('sdReq', params.sdReq || [0xFE]);

        const packet = createInitPacketUint8Array(initPacketParams);

        const firmwareUpdates = new DfuUpdates([{ initPacket: packet, firmwareImage }]);

        const port = new SerialPort(comName, { baudRate: 115200, autoOpen: false });
        const serialTransport = new DfuTransportSerial(port, 0);
        const dfuOperation = new DfuOperation(firmwareUpdates, serialTransport);

        await dfuOperation.start(true);
        port.close();
        debug('SoftDevice DFU completed successfully!');

        try {
            await waitForDevice(device.serialNumber);
        } catch (error) {
            debug(error);
        }
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

    const firmwareUpdates = new DfuUpdates([{ initPacket: packet, firmwareImage }]);

    const port = new SerialPort(comName, { baudRate: 115200, autoOpen: false });
    const serialTransport = new DfuTransportSerial(port, 0);
    const dfuOperation = new DfuOperation(firmwareUpdates, serialTransport);

    await dfuOperation.start(true);
    port.close();
    debug('Application DFU completed successfully!');

    return waitForDevice(device.serialNumber);
}

/**
 * Probes a device given its nrf-device-lister entry, testing which setup
 * methods are available, and whether setup is needed.
 *
 * @param {object} selectedDevice nrf-device-lister's device
 * @param {object} options { jprog, dfu, needSerialport }
 * @returns {Promise<string>} Either "dfu", "jlink", "ready" or "impossible"
 */
export function getSetupMode(selectedDevice, options) {
    const {
        jprog, dfu, needSerialport,
    } = options;


    if (dfu && Object.keys(dfu).length !== 0) {
        // check if device is in DFU-Bootlader, it might _only_ have serialport
        if (isDeviceInDFUBootloader(selectedDevice)) {
            debug('Device is in DFU-Bootloader, DFU is defined');
            return Promise.resolve('dfu');
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
                            return 'ready';
                        }
                        debug('Device requires different firmware');
                        return 'dfu';
                    });
            }
            debug('Device is not in DFU-Bootloader and has no DFU trigger interface');
        }
    }

    if (jprog && selectedDevice.traits.includes('jlink')) {
        let firmwareFamily;
        return openJLink(selectedDevice)
            .then(() => getDeviceFamily(selectedDevice))
            .then(family => {
                firmwareFamily = jprog[family];
                if (!firmwareFamily) {
                    debug(`No firmware defined for ${family} family`);
                    return 'impossible';
                }
                return validateFirmware(selectedDevice, firmwareFamily)
                    .then(valid => (valid ? 'ready' : 'jlink'));
            })
            .then(mode => closeJLink(selectedDevice).then(() => mode));
    }

    debug('Selected device cannot be prepared, maybe the app still can use it');
    return Promise.resolve('impossible');
}

/**
 * Probes a device given its serial number, testing which setup methods are
 * available, and whether setup is needed.
 *
 * @param {string|number} serialNumber Serial number of the device to be probed
 * @param {object} options { jprog, dfu, needSerialport }
 * @returns {Promise<string>} Either "dfu", "jlink", "ready" or "impossible"
 */
export function getSetupModeForSerialNumber(serialNumber, options) {
    return getDeviceBySerialNumber(serialNumber).then(device => getSetupMode(device, options));
}

/**
 * Prepares a device listed by nrf-device-lister with expected application firmware
 * configured by options for different device types.
 * Based on the device type it decides whether it should be programmed by DFU or JProg.
 * After successful programming it returns a Promise resolved to the prepared device.
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
 * @param {object} options { jprog, dfu, needSerialport, promiseChoice, promiseConfirm }
 * @returns {Promise} device prepared
 */
export function setupDevice(selectedDevice, options) {
    const {
        jprog, dfu, promiseConfirm, promiseChoice,
    } = options;

    const confirm = promiseConfirm || (() => Promise.resolve(true));

    return getSetupMode(selectedDevice, options).then(mode => {
        debug('Setup mode is: ', mode);

        if (mode === 'ready' || mode === 'impossible') {
            // Device is either already ready, or cannot be set up and we
            // just hope it will work.
            return Promise.resolve(selectedDevice);
        } else if (mode === 'dfu') {
            return confirm('Device must be programmed, do you want to proceed?')
                .then(proceed => {
                    if (!proceed) {
                        throw new Error('Preparation cancelled by user');
                    }
                })
                .then(() => {
                    const choices = Object.keys(dfu);
                    if (choices.length > 1 && promiseChoice) {
                        return promiseChoice('Which firmware do you want to program?', choices);
                    }
                    return choices.pop();
                })
                .then(choice => prepareInDFUBootloader(selectedDevice, dfu[choice]));
        } else if (mode === 'jlink') {
            let firmwareFamily;
            return verifySerialPortAvailable(selectedDevice)
                .then(() => openJLink(selectedDevice))
                .then(() => getDeviceFamily(selectedDevice))
                .then(family => {
                    firmwareFamily = jprog[family];
                    if (!firmwareFamily) {
                        throw new Error(`No firmware defined for ${family} family`);
                    }
                })
                .then(() => confirm('Device must be programmed, do you want to proceed?')
                    .then(proceed => {
                        if (proceed) {
                            return programFirmware(selectedDevice, firmwareFamily);
                        }
                        throw new Error('Preparation cancelled by user');
                    }))
                .then(() => closeJLink(selectedDevice), err => {
                    closeJLink(selectedDevice);
                    return Promise.reject(err);
                });
        }
        throw new Error(`Got unknown setup mode from getSetupMode(): ${mode}`);
    });
}

/**
 * Akin to setupDevice, but sets up a device given only its serial number.
 *
 * @param {string|number} serialNumber Serial number of the device to be set up
 * @param {object} options { jprog, dfu, needSerialport, promiseChoice, promiseConfirm }
 * @returns {Promise} device prepared
 */
export function setupSerialNumber(serialNumber, options) {
    return getDeviceBySerialNumber(serialNumber).then(device => setupDevice(device, options));
}
