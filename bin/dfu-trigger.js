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
const { inspect } = require('util');
const DeviceLister = require('nrf-device-lister');
const { ensureBootloaderMode } = require('../');
const { version } = require('../package.json');

commander
    .version(version)
    .usage('Utility to interact with DFU trigger interface of Nordic USB devices')
    .option('-s, --serialNumber [sernum]', 'serial number of the device')
    .option('-i, --interactive', 'select device interactively')
    .parse(process.argv);

if (!(commander.serialNumber || commander.interactive)) {
    commander.outputHelp();
    process.exit();
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

            if (commander.serialNumber) {
                resolve(deviceMap.get(commander.serialNumber));
                return;
            }

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

async function main() {
    try {
        let device = await chooseDevice();
        if (!device) {
            console.log('No device selected');
            return;
        }

        device = await ensureBootloaderMode(device);

        console.log('Device is now in bootloader:', inspect(device, false, 1));
    } catch (error) {
        console.log(error.message);
    }
}

main().then(() => process.exit());
