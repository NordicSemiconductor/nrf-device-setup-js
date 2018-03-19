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

const readline = require('readline');

const DeviceLister = require('nrf-device-lister');
const DeviceActions = require('../');

const lister = new DeviceLister({
    usb: false,
    nordicUsb: true,
    seggerUsb: false,
    serialport: false,
    jlink: false,
});

function chooseDevice() {
    return new Promise((resolve, reject) => {
        lister.once('conflated', deviceMap => {
            lister.stop();

            console.log();
            deviceMap.forEach((device, serialNumber) => {
                console.log(`${serialNumber}: ${device.usb.manufacturer} / ${device.usb.product}`);
            });

            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
                completer: line => {
                    const completions = [...deviceMap.keys()];
                    const hits = completions.filter(c => c.startsWith(line));
                    return [hits.length ? hits : completions, line];
                },
            });
            rl.question('\nSelect device (serialnumber, tab-completion) > ', serialNumber => {
                rl.close();
                const device = deviceMap.get(serialNumber);
                return device
                    ? resolve(device)
                    : reject(new Error('no device selected'));
            });
        })
            .once('error', console.error)
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
                        .once('error', console.error)
                        .start();
                }, 1000);
            });
    });
}

chooseDevice().then(device => {
    console.log('\nSelected', device.serialNumber);
    const dfuMode = DeviceActions.isDeviceInDFUMode(device);

    if (dfuMode) {
        console.log('Device is already in DFU mode');
        return;
    }

    const usbdev = device.usb.device;
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
        .then(() => '9632826579208d5d') // temporary hack
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
