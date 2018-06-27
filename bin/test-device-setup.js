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
const path = require('path');
const fs = require('fs');

const DeviceLister = require('nrf-device-lister');
const { setupDevice } = require('../');

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
            lister.removeAllListeners('error');

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

async function testSetup() {
    try {
        const preparedDevice = await setupDevice(
            await chooseDevice(),
            {
                dfu: {
                    connectivity: {
                        application: fs.readFileSync(path.resolve(__dirname, 'fw/connectivity_1.2.2_usb_for_s132_3.0.hex')),
                        softdevice: fs.readFileSync(path.resolve(__dirname, 'fw/s132_nrf52_3.0.0_softdevice.hex')),
                        semver: 'ble-connectivity 0.1.0+Apr-17-2018-10-25-40',
                        params: {
                            hwVersion: 52,
                            fwVersion: 0xffffffff,
                            sdReq: [0],
                            sdId: [0x8C],
                        },
                    },
                    pca10056: {
                        application: path.resolve(__dirname, 'fw/rssi-10056.hex'),
                        semver: 'rssi_cdc_acm 2.0.0+dfuMay-22-2018-10-43-22',
                    },
                    pca10059: {
                        application: path.resolve(__dirname, 'fw/rssi-10059.hex'),
                        semver: 'rssi_cdc_acm 2.0.0+dfuMay-22-2018-10-43-22',
                    },
                },
                jprog: {
                    nrf52: {
                        fw: path.resolve(__dirname, 'fw/rssi-10040.hex'),
                        fwVersion: 'rssi-fw-1.0.0',
                        fwIdAddress: 0x2000,
                    },
                },
                needSerialport: true,
                promiseConfirm: async message => (await inquirer.prompt([{
                    type: 'confirm',
                    name: 'isConfirmed',
                    message,
                    default: false,
                }])).isConfirmed,
                promiseChoice: async (message, choices) => (await inquirer.prompt([{
                    type: 'list',
                    name: 'choice',
                    message,
                    choices,
                }])).choice,
            },
        );
        console.log('Device is ready to be opened:', preparedDevice);
    } catch (error) {
        console.log(error.message);
    }
}

testSetup().then(() => process.exit());
