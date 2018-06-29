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
const { eraseJlinkDevice, getJlinkDevice } = require('./util/common');
const { setupDevice } = require('../');

jest.setTimeout(20000);

const NRF51_SERIALNUMBER_REGEX = /^.*680[0-9]{6}/;
const OPTIONS = {
    jprog: {
        nrf51: {
            fw: path.join(__dirname, '..', 'bin', 'fw', 'connectivity_1.2.2_1m_with_s130_2.0.1.hex'),
            fwVersion: {
                length: 24,
                validator: data => {
                    const major = data[12];
                    const minor = data[13];
                    const patch = data[14];
                    return major === 1 && minor === 2 && patch === 2;
                },
            },
            fwIdAddress: 0x20000,
        },
    },
    detailedOutput: true,
};

describe('nrf51', () => {
    it('is programmed when firmware is not present, but skips programming when firmware is already present', () => (
        getJlinkDevice(NRF51_SERIALNUMBER_REGEX)
            .then(device => eraseJlinkDevice(device))
            .then(device => setupDevice(device, OPTIONS))
            .then(result => {
                expect(result.details.wasProgrammed).toEqual(true);
                return result.device;
            })
            .then(device => setupDevice(device, OPTIONS))
            .then(result => expect(result.details.wasProgrammed).toEqual(false))
    ));
});
