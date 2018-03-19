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

/* eslint no-bitwise: 0 */

const usb = require('usb');

const ReqTypeInterfaceClass = usb.LIBUSB_REQUEST_TYPE_CLASS | usb.LIBUSB_RECIPIENT_INTERFACE;
const ReqTypeIN = ReqTypeInterfaceClass | usb.LIBUSB_ENDPOINT_IN;
const ReqTypeOUT = ReqTypeInterfaceClass | usb.LIBUSB_ENDPOINT_OUT;

const NORDIC_SEM_VER_REQUEST = 8;
const NORDIC_DFU_INFO_REQUEST = 7;
const DFU_DETACH_REQUEST = 0;

const nordicInfoStructSize = 24; // 5 DWORD and 2 WORD
const detachReqBuf = Buffer.from('0');

/*
 * Returns a multibyte value from an array of bytes
 * getBytes( [1,2,3,4,5,6], 3, 2 ) => 4 + 5<<8 => 36
 */
function getBytes(array, index, length) {
    return array
        .slice(index, index + length)
        .reduce((c, v, i) => c + (v << (i * 8)), 0);
}

const openDecorator = decoratee => (...args) => {
    const usbdev = args[0];
    if (usbdev.interfaces instanceof Array) {
        return decoratee(...args);
    }
    try {
        console.log('open');
        usbdev.open();
    } catch (e) { console.error(e); }
    return decoratee(...args)
        .then(result => {
            try {
                console.log('close');
                usbdev.close();
            } catch (e) { console.error(e); }
            return result;
        });
};

export function getDFUInterfaceNumber(usbdev) {
    const wasClosed = !(usbdev.interfaces instanceof Array);
    if (wasClosed) {
        try {
            usbdev.open();
        } catch (error) {
            console.error(error);
            return -1;
        }
    }

    const dfuTriggerInterface = usbdev.interfaces.findIndex(iface => (
        iface.descriptor.bInterfaceClass === 255 &&
        iface.descriptor.bInterfaceSubClass === 1 &&
        iface.descriptor.bInterfaceProtocol === 1
    ));

    if (wasClosed) {
        try {
            usbdev.close();
        } catch (error) {
            console.error(error);
        }
    }

    return dfuTriggerInterface;
}

export const getSemVersion = openDecorator((usbdev, interfaceNumber) => (
    new Promise((resolve, reject) => {
        usbdev.controlTransfer(
            ReqTypeIN,
            NORDIC_SEM_VER_REQUEST, 0, interfaceNumber, 256, (error, data) => (
                error
                    ? reject(error)
                    : resolve(String.fromCharCode.apply('utf16le', data))
            )
        );
    })
));

export const getDfuInfo = openDecorator((usbdev, interfaceNumber) => (
    new Promise((resolve, reject) => {
        usbdev.controlTransfer(
            ReqTypeIN,
            NORDIC_DFU_INFO_REQUEST, 0, interfaceNumber, nordicInfoStructSize,
            (error, data) => (
                error
                    ? reject(error)
                    : resolve({
                        address: getBytes(data, 0, 4),
                        firmwareSize: getBytes(data, 4, 4),
                        versionMajor: getBytes(data, 8, 2),
                        versionMinor: getBytes(data, 10, 2),
                        firmwareID: getBytes(data, 12, 4),
                        flashSize: getBytes(data, 16, 4),
                        flashPageSize: getBytes(data, 20, 4),
                    })
            )
        );
    })
));

// TODO: If there's an SDK functionality to predict bootloader serial number,
// that should be used instead, this serial number is not guaranteed
export const predictSerialNumberAfterReset = openDecorator(usbdev => (
    new Promise((resolve, reject) => {
        usbdev.getStringDescriptor(usbdev.deviceDescriptor.iSerialNumber, (error, data) => (
            error ? reject(error) : resolve(data)
        ));
    })
));

export const sendDetachRequest = openDecorator((usbdev, interfaceNumber) => (
    new Promise(resolve => {
        usbdev.controlTransfer(
            ReqTypeOUT, DFU_DETACH_REQUEST, 0, interfaceNumber, detachReqBuf,
            () => {
                // Device is expected to disappear, any further calls would fail
                resolve();
            }
        );
    })
));
