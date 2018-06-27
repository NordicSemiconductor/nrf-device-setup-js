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

const nrfjprog = require('pc-nrfjprog-js');
const DeviceLister = require('nrf-device-lister');
const Debug = require('debug');

const debug = Debug('device-setup:test');

module.exports.eraseJlinkDevice = device => {
    return new Promise((resolve, reject) => {
        nrfjprog.erase(parseInt(device.serialNumber, 10), {}, error => {
            if (error) {
                reject(error);
            } else {
                resolve(device);
            }
        });
    });
};

module.exports.getJlinkDevice = serialNumberRegex => {
    const lister = new DeviceLister({
        serialport: true,
        jlink: true,
    });
    lister.on('error', error => debug(error.message));
    return lister.reenumerate()
        .then(deviceMap => {
            const serialNumbers = Array.from(deviceMap.keys());
            const serialNumber = serialNumbers.find(sn => (
                serialNumberRegex.test(sn)
            ));
            if (serialNumber) {
                return deviceMap.get(serialNumber);
            }
            throw new Error(`No JLink device with serial number ${serialNumberRegex} found.`);
        });
};

module.exports.getNordicUsbDevice = () => {
    const lister = new DeviceLister({
        serialport: true,
        nordicUsb: true,
        nordicDfu: true,
    });
    lister.on('error', error => debug(error.message));
    return lister.reenumerate()
        .then(deviceMap => {
            const devices = Array.from(deviceMap.values());
            const device = devices.find(dev => (
                dev.traits.includes('nordicUsb') || dev.traits.includes('nordicDfu')
            ));
            if (device) {
                return device;
            }
            throw new Error('No Nordic USB device found.');
        });
};
