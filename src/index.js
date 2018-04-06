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
import Crypto from 'crypto';
import SerialPort from 'serialport';
import Debug from 'debug';

import DeviceLister from 'nrf-device-lister';
import MemoryMap from 'nrf-intel-hex';
import * as dfujs from 'pc-nrf-dfu-js';
import * as initPacket from './util/initPacket';
import * as trigger from './triggerDfuMode';
import * as JProg from './jprogFunc';

const debug = Debug('device-actions');
const debugError = Debug('device-actions:error');

export { trigger };

export function isDeviceInDFUBootloader(device) {
    if (!device) {
        return false;
    }
    if (device.usb) {
        const { deviceDescriptor: d } = device.usb.device;
        return (d.idVendor === 0x1915 && d.idProduct === 0x521f);
    }
    if (device.serialport) {
        const { vendorId, productId } = device.serialport;
        return (vendorId === '1915' && productId === '521F');
    }
    return false;
}

export function waitForDevice(serialNumber, retry = 0, lister = new DeviceLister({
    nordicUsb: true, nordicDfu: true, serialport: true,
})) {
    return new Promise((resolve, reject) => {
        if (retry > 2) {
            reject(new Error(`Expected serialNumber ${serialNumber} not found`));
            return;
        }
        debug(`waiting a bit... then looking for ${serialNumber}, retry #${retry}`);

        setTimeout(() => {
            lister.once('conflated', deviceMap => {
                lister.stop();
                lister.removeAllListeners('error');
                const device = deviceMap.get(serialNumber);
                if (device && device.serialport) {
                    debug(`... found ${serialNumber}`);
                    return resolve(device);
                }
                return waitForDevice(serialNumber, retry + 1, lister)
                    .then(resolve)
                    .catch(reject);
            })
                .on('error', debugError)
                .start();
        }, 500);
    });
}


export function detachAndWaitFor(usbdev, interfaceNumber, serialNumber) {
    debug('Sending detach, will wait for attach');
    return trigger.sendDetachRequest(usbdev, interfaceNumber)
        .catch(debugError)
        .then(() => waitForDevice(serialNumber));
}

function calculateSHA256Hash(image) {
    const digest = Crypto.createHash('sha256');
    digest.update(image);
    return Buffer.from(digest.digest().reverse());
}

function firmwareImageFromFile(filename) {
    const memMap = MemoryMap.fromHex(fs.readFileSync(filename));
    let startAddress;
    let endAddress;
    memMap.forEach((block, address) => {
        startAddress = !startAddress ? address : startAddress;
        endAddress = address + block.length;
    });
    return memMap.slicePad(startAddress, endAddress - startAddress);
}

async function prepareInDFUBootloader(device, dfu) {
    const { comName } = device.serialport;
    debug(`${device.serialNumber} on ${comName} is now in DFU-Bootloader...`);

    const firmwareImage = firmwareImageFromFile(dfu.fw);

    const initPacketParams = new initPacket.InitPacket()
        .set('fwType', initPacket.FwType.APPLICATION)
        .set('fwVersion', dfu.semver)
        .set('hashType', initPacket.HashType.SHA256)
        .set('hash', calculateSHA256Hash(firmwareImage))
        .set('appSize', firmwareImage.length)
        .set('sdReq', 0);
    const packet = await initPacket.createInitPacketUint8Array(initPacketParams);

    const firmwareUpdates = new dfujs.DfuUpdates([{
        initPacket: packet,
        firmwareImage,
    }]);

    const port = new SerialPort(comName, { baudRate: 115200, autoOpen: false });
    const serialTransport = new dfujs.DfuTransportSerial(port, 0);
    const dfuOperation = new dfujs.DfuOperation(firmwareUpdates, serialTransport);

    await dfuOperation.start(true);
    debug('DFU completed successfully!');
    port.close();

    return waitForDevice(device.serialNumber);
}

export function prepareDevice(
    selectedDevice,
    { jprog, dfu, needSerialport },
    { promiseConfirm, promiseChoice }
) {
    return new Promise((resolve, reject) => {
        if (dfu) {
            // check if device is in DFU-Bootlader, it might _only_ have serialport
            if (isDeviceInDFUBootloader(selectedDevice)) {
                debug('Device is in DFU-Bootloader, DFU is defined');
                return Promise.resolve()
                    .then(async () => {
                        if (!promiseConfirm) return;
                        if (!await promiseConfirm('Device must be programmed, do you want to proceed?')) {
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
                    .then(choice => prepareInDFUBootloader(selectedDevice, dfu[choice]))
                    .then(resolve)
                    .catch(reject);
            }

            const usbdevice = selectedDevice.usb || selectedDevice.nordicUsb
                || selectedDevice.nordicDfu || selectedDevice.seggerUsb;

            if (usbdevice) {
                const usbdev = usbdevice.device;
                const interfaceNumber = trigger.getDFUInterfaceNumber(usbdev);
                if (interfaceNumber >= 0) {
                    debug('Device has DFU trigger interface, probably in Application mode');
                    return trigger.getSemVersion(usbdev, interfaceNumber)
                        .then(semver => {
                            if (semver === dfu.semver) {
                                if (needSerialport && selectedDevice.serialport) {
                                    debug('Device is running the correct fw version and has serial port');
                                    return resolve(selectedDevice);
                                }
                                return reject(new Error('Missing serial port'));
                            }
                            debug('Device requires different firmware');
                            return trigger.predictSerialNumberAfterReset(usbdev)
                                .then(newSerNr => {
                                    debug('Serial number after reset should be:', newSerNr);
                                    return detachAndWaitFor(usbdev, interfaceNumber, newSerNr);
                                })
                                .then(async device => {
                                    if (!promiseConfirm) return device;
                                    if (!await promiseConfirm('Device must be programmed, do you want to proceed?')) {
                                        throw new Error('Preparation cancelled by user');
                                    }
                                    return device;
                                })
                                .then(async device => {
                                    const choices = Object.keys(dfu);
                                    if (choices.length > 1 && promiseChoice) {
                                        return { device, choice: await promiseChoice('Which firmware do you want to program?', choices) };
                                    }
                                    return { device, choice: choices.pop() };
                                })
                                .then(({ device, choice }) => (
                                    prepareInDFUBootloader(device, dfu[choice])
                                ))
                                .then(resolve)
                                .catch(reject);
                        });
                }
                debug('Device is not in DFU-Bootloader and has no DFU trigger interface');
            }
        }

        if (jprog) {
            if (selectedDevice.jlink) {
                // JProg.validateFirmware(serialNumber, { onValid, onInvalid })

                // do programming with jprog
                return reject(new Error('TODO: jprog to be implemented'));
            }
        }

        debug('Selected device cannot be prepared, maybe the app still can use it');
        return resolve(selectedDevice);
    });
}
