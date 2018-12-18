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

const commander = require('commander');
const inquirer = require('inquirer');
const path = require('path');
const fs = require('fs');
const { inspect } = require('util');
const DeviceLister = require('nrf-device-lister');
const { setupDevice } = require('../');
const { version } = require('../package.json');

commander
    .version(version)
    .usage('Utility to program a Nordic USB device via USB DFU.')
    .option('-a, --application <path>', 'application')
    .option('-s, --softdevice <path>', 'softdevice')
    .option('-i, --sd-id <id>', 'softdevice id (in hex e.g. A5)')
    .option('-H, --hw-version [hw]', 'hardware version', 52)
    .option('-F, --fw-version [fw]', 'firmware version', 0xffffffff)
    .option('-S, --semver [semver]', 'application semver')
    .parse(process.argv);


const dfu = {};
try {
    dfu.application = {
        application: fs.readFileSync(commander.application),
        semver: commander.semver,
        params: {
            hwVersion: commander.hwVersion,
            fwVersion: commander.fwVersion,
            sdReq: [0],
            sdId: [parseInt(commander.sdId, 16)],
        },
    };
    if (commander.softdevice) {
        dfu.application.softdevice = fs.readFileSync(commander.softdevice);
    }
} catch (err) {
    console.log(err.message);
    process.exit(-1);
}

function chooseDevice() {
    return new Promise((resolve, reject) => {
        const traits = {
            usb: false,
            nordicUsb: true,
            nordicDfu: true,
            serialport: true,
            jlink: false,
        };
        const lister = new DeviceLister(traits);

        lister.once('conflated', deviceMap => {
            lister.stop();
            lister.removeAllListeners('error');

            const choices = [];
            deviceMap.forEach((device, serialNumber) => {
                const type = Object.keys(traits).find(e => Object.keys(device).includes(e));
                choices.push({
                    key: serialNumber.toString(),
                    name: `${serialNumber}: (${device.serialport.comName}) ${device[type].manufacturer} / ${device[type].product || device[type].productId}`,
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
                dfu,
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
        console.log('Device is ready to be opened:', inspect(preparedDevice, false, 1));
    } catch (error) {
        console.log(error.message);
    }
}

testSetup().then(() => process.exit());
