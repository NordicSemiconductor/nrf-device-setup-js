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

import os from 'os';
import usb from 'usb';
import Debug from 'debug';

const debug = Debug('device-setup:trigger');

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
        usbdev.open();
    } catch (e) { debug(e.message); }
    return decoratee(...args)
        .then(result => {
            try {
                usbdev.close();
            } catch (e) { debug(e.message); }
            return result;
        });
};

/**
 * Asserts that the given interface number exists in the given (open) USB Device,
 * and that the class, subclass and protocol match.
 * Returns nothing on success, but throws an error if the assertion fails.
 *
 * @param {Device} usbdev Instance of USB's Device
 * @param {number} interfaceNumber 0-indexed interface number to check
 * @returns {undefined}
 */
function assertDfuTriggerInterface(usbdev, interfaceNumber) {
    if (!(usbdev.interfaces instanceof Array)) {
        throw new Error('USB Device must be open before performing any operations on the DFU trigger interface');
    }
    const iface = usbdev.interfaces[interfaceNumber];
    if (!iface) {
        throw new Error(`Interface number ${interfaceNumber} does not exist on USB device; cannot perform DFU trigger operation.`);
    }

    if (iface.descriptor.bInterfaceClass !== 255 ||
        iface.descriptor.bInterfaceSubClass !== 1 ||
        iface.descriptor.bInterfaceProtocol !== 1
    ) {
        throw new Error(`Interface number ${interfaceNumber} does not look like a DFU trigger interface; cannot perform DFU trigger operation.`);
    }
}

function getDFUInterfaceNumber(usbdev) {
    const wasClosed = !(usbdev.interfaces instanceof Array);
    if (wasClosed) {
        try {
            usbdev.open();
        } catch (error) {
            debug(error.message);
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
            debug(error.message);
        }
    }

    return dfuTriggerInterface;
}

const getSemVersion = openDecorator((usbdev, interfaceNumber) => (
    new Promise((resolve, reject) => {
        assertDfuTriggerInterface(usbdev, interfaceNumber);
        usbdev.controlTransfer(
            ReqTypeIN,
            NORDIC_SEM_VER_REQUEST, 0, interfaceNumber, 256, (error, data) => (
                error
                    ? reject(error)
                    : resolve(String.fromCharCode.apply('utf16le', data).replace(/\0$/, ''))
            )
        );
    })
));

const getDfuInfo = openDecorator((usbdev, interfaceNumber) => (
    new Promise((resolve, reject) => {
        assertDfuTriggerInterface(usbdev, interfaceNumber);
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

const sendDetachRequest = openDecorator((usbdev, interfaceNumber) => (
    new Promise((resolve, reject) => {
        assertDfuTriggerInterface(usbdev, interfaceNumber);
        debug(`Claiming interface ${interfaceNumber}`);
        usbdev.interfaces[interfaceNumber].claim();
        debug('Sending DFU detach request ');
        usbdev.controlTransfer(
            ReqTypeOUT, DFU_DETACH_REQUEST, 0, interfaceNumber, detachReqBuf,
            err => {
                debug(`Releasing interface ${interfaceNumber}`);
                usbdev.interfaces[interfaceNumber].release(err2 => {
                    if (err2) { reject(err2); }

                    // On Windows, if the detach is successful,
                    // the target device will reboot before sending a response,
                    // so the expected result is that the control transfer will stall.
                    // On MacOS, DFU detach request does not stall as on Windows.
                    // Just regard it as detaching successfully.
                    if (err &&
                        err.errno === usb.LIBUSB_TRANSFER_STALL &&
                        err.message === 'LIBUSB_TRANSFER_STALL') {
                        resolve();
                    } else if (err &&
                        err.errno === usb.LIBUSB_ERROR_IO &&
                        err.message === 'LIBUSB_ERROR_IO') {
                        // This edge case only happens when using the "libusb" kernel
                        // driver on win32 (not "winusb", not "libusbk")
                        resolve();
                    } else if (os.platform() === 'darwin') {
                        resolve();
                    } else {
                        debug('DFU detach request did not stall as expected');
                        reject(new Error('USB DFU detach request sent, but device does not seem to have rebooted'));
                    }
                });
            }
        );
    })
));

/**
 * Sends a detach request to a nRF USB device running in application mode,
 * and waits until it reboots out of application mode.
 *
 * @param {Device} usbdev Instance of USB's Device
 * @param {number} timeout Timeout, in milliseconds, to wait for device detachment
 * @return {Promise} Resolves to undefined
 */
export function detach(usbdev, timeout = 5000) {
    debug('detach', timeout);
    return new Promise((resolve, reject) => {
        let timeoutId;
        function checkDetachment(detachedDev) {
            if (usbdev === detachedDev) {
                debug('Detachment successful');
                clearTimeout(timeoutId);
                usb.removeListener('detach', checkDetachment);
                resolve();
            }
        }

        timeoutId = setTimeout(() => {
            debug('Timeout when waiting for USB detach event');
            usb.removeListener('detach', checkDetachment);
            reject(new Error('USB detach request sent, timeout while waiting for device reboot'));
        }, timeout);

        usb.on('detach', checkDetachment);
        const dfuIface = getDFUInterfaceNumber(usbdev);

        sendDetachRequest(usbdev, dfuIface).catch(err => {
            debug('Error when sending detach request');
            clearTimeout(timeoutId);
            usb.removeListener('detach', checkDetachment);
            reject(err);
        });
    });
}

export {
    getDFUInterfaceNumber,
    getSemVersion,
    getDfuInfo,
    sendDetachRequest,
};
