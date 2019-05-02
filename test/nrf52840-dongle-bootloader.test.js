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

const path = require('path');
const debug = require('debug')('device-setup:test');

const { getNordicUsbDevice } = require('./util/common');
const { setupDevice, ensureBootloaderMode } = require('../');

jest.setTimeout(20000);

const confirmYes = async () => true;
const confirmNo = async () => false;

const OPTIONS = {
    dfu: {
        pca10059: {
            application: path.resolve(__dirname, '../bin/fw/rssi-10059.hex'),
            semver: '', // forced update
        },
    },
    detailedOutput: true,
};

const serialNumber = process.env.DONGLE_SERIAL_NUMBER;

const testcase = serialNumber ? it : it.skip;

describe('nrf52840 dongle bootloader', () => {
    debug('nrf52840 dongle bootloader');

    testcase('is programmed without bootloader update', async () => {
        debug(`Looking for device ${serialNumber} for programming without bootloader update`);
        const device = await getNordicUsbDevice(serialNumber);
        const result = await setupDevice(
            device,
            { ...OPTIONS, promiseConfirmBootloader: confirmNo }
        );
        debug(`Device ${serialNumber} programmed without bootloader update`);
        expect(result.details.wasProgrammed).toEqual(true);
    });

    testcase('is programmed with bootloader update', async () => {
        debug(`Looking for device ${serialNumber} for programming with bootloader update`);
        const device = await getNordicUsbDevice(serialNumber);
        const result = await setupDevice(
            device,
            { ...OPTIONS, promiseConfirmBootloader: confirmYes }
        );
        expect(result.details.wasProgrammed).toEqual(true);
    });

    testcase('is set back to bootloader mode', async () => {
        debug(`Looking for device ${serialNumber} for setting back to bootloader mode`);
        const device = await getNordicUsbDevice(serialNumber);
        const result = await ensureBootloaderMode(device);
        expect(result.serialNumber).toMatch(device.serialNumber);
    });
});
