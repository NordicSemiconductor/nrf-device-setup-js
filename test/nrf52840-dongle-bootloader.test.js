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
const {
    getNordicUsbDevice, getNordicDfuDevice,
    programBootloaderJlinkDevice, getJlinkDevice,
} = require('./util/common');
const { setupDevice } = require('../');

jest.setTimeout(20000);

const confirmYes = () => new Promise(resolve => resolve(true));
const confirmNo = () => new Promise(resolve => resolve(false));

const NRF52_SERIALNUMBER_REGEX = /^.*683[0-9]{6}/;
const BOOTLOADER = path.resolve(__dirname, '../bin/fw/graviton_bootloader_mbr_v1.0.1-[nRF5_SDK_15.0.1-1.alpha_f76d012].hex');
const OPTIONS = {
    dfu: {
        pca10059: {
            application: path.resolve(__dirname, '../bin/fw/rssi-10059.hex'),
            semver: '', // forced update
        },
    },
    detailedOutput: true,
};

describe('nrf52840 dongle bootloader', () => {
    beforeAll(async () => {
        const device = await getJlinkDevice(NRF52_SERIALNUMBER_REGEX);
        await programBootloaderJlinkDevice(device, BOOTLOADER);
        await new Promise(resolve => setTimeout(resolve, 2000));
    }, 20000);

    it('is programmed without bootloader update', async () => {
        const device = await getNordicDfuDevice();
        const result = await setupDevice(
            device,
            { ...OPTIONS, promiseConfirmBootloader: confirmNo }
        );
        expect(result.details.wasProgrammed).toEqual(true);
    });

    it('is programmed with bootloader update', async () => {
        const device = await getNordicUsbDevice();
        const result = await setupDevice(
            device,
            { ...OPTIONS, promiseConfirmBootloader: confirmYes }
        );
        expect(result.details.wasProgrammed).toEqual(true);
    });
});
