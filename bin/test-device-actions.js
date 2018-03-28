#!/usr/bin/env node

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

'use strict';

const inquirer = require('inquirer');

const DeviceLister = require('nrf-device-lister');
const DeviceActions = require('../');

const traits = {
    usb: false,
    nordicUsb: true,
    seggerUsb: true,
    nordicDfu: true,
    serialport: true,
    jlink: true,
};

const lister = new DeviceLister(traits);

function chooseDevice() {
    return new Promise((resolve, reject) => {
        lister.once('conflated', deviceMap => {
            lister.stop();

            const choices = [];
            deviceMap.forEach((device, serialNumber) => {
                const type = Object.keys(traits).find(e => Object.keys(device).includes(e));
                choices.push({
                    key: serialNumber.toString(),
                    name: `${serialNumber}: ${device[type].manufacturer} / ${device[type].product || device[type].productId}`,
                    value: serialNumber,
                });
            });

            console.log();
            inquirer.prompt([{
                type: 'list',
                name: 'serialNumber',
                message: 'Select device',
                choices,
            }])
                .then(({ serialNumber }) => {
                    const device = deviceMap.get(serialNumber);
                    return device
                        ? resolve(device)
                        : reject(new Error('no device selected'));
                })
                .catch(console.error);
        })
            .on('error', () => {})
            .start();
    });
}

function detachAndWaitFor(usbdev, interfaceNumber, newSerialNumber) {
    return new Promise((resolve, reject) => {
        DeviceActions.trigger.sendDetachRequest(usbdev, interfaceNumber)
            .catch(console.error)
            .then(() => {
                setTimeout(() => {
                    lister.once('conflated', deviceMap => {
                        lister.stop();
                        if (deviceMap.has(newSerialNumber)) {
                            resolve(deviceMap.get(newSerialNumber));
                        } else {
                            reject(new Error('something attached, but not what we expected'));
                        }
                    })
                        .once('error', () => {})
                        .start();
                }, 1000);
            });
    });
}

chooseDevice().then(device => {
    const ud = device.usb || device.nordicUsb || device.nordicDfu || device.seggerUsb;
    if (!ud) {
        console.log('Device has no USB interface');
        return;
    }
    const usbdev = ud.device;

    const dfuMode = DeviceActions.isDeviceInDFUMode(device);
    if (dfuMode) {
        console.log('Device is already in DFU mode');
        return;
    }

    const interfaceNumber = DeviceActions.trigger.getDFUInterfaceNumber(usbdev);

    if (interfaceNumber < 0) {
        console.log('Device has no DFU interface');
        return;
    }

    DeviceActions.trigger.getSemVersion(usbdev, interfaceNumber)
        .then(semver => console.log('Application semver:', semver))
        .then(() => DeviceActions.trigger.getDfuInfo(usbdev, interfaceNumber))
        .then(dfuInfo => console.log('DFU Info:', dfuInfo))
        .then(() => DeviceActions.trigger.predictSerialNumberAfterReset(usbdev))
        .then(newSerNr => {
            console.log('Serial number after reset should be:', newSerNr);
            return detachAndWaitFor(usbdev, interfaceNumber, newSerNr);
        })
        .then(dfuDevice => {
            console.log('found', dfuDevice);
        })
        .catch(console.error);
})
    .catch(error => {
        console.log(error.message);
    });
