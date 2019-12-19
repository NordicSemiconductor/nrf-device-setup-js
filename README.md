# nRF Device Setup

[![Build Status](https://dev.azure.com/NordicSemiconductor/Wayland/_apis/build/status/nrf-device-setup-js?branchName=master)](https://dev.azure.com/NordicSemiconductor/Wayland/_build/latest?definitionId=14&branchName=master)
[![License](https://img.shields.io/badge/license-Modified%20BSD%20License-blue.svg)](LICENSE)

`nrf-device-setup` is a Javascript module which ensures that Nordic devices are
programmed with configured firmwares. There are currently two categories of devices
which are programmed by different frameworks, one is programmed by JLink debugger,
the other is DFU'd (Device Firmware Upgrade) via USB CDC ACM transport.
By using this module the caller does _not_ need to use [pc-nrfjprog-js](https://github.com/NordicSemiconductor/pc-nrfjprog-js) and [pc-nrf-dfu-js](https://github.com/NordicSemiconductor/pc-nrf-dfu-js) directly,
only the device/firmware configuration shall be provided.

This module is primarily used by the [nRF Connect](https://github.com/NordicSemiconductor/pc-nrfconnect-launcher) framework and related nRF Connect apps.

The following devices are supported:

* JLink:
    * PCA10028 nRF51 Development Kit
    * PCA10031 nRF51 Dongle
    * PCA10040 nRF52 Development Kit
    * PCA10056 nRF52 Development Kit
* USB SDFU:
    * PCA10059 nRF52 Dongle

## Installation

```
$ npm install nrf-device-setup
```

### Dependency requirements

#### JLink devices

Due to dependency on _pc-nrfjprog-js_, installation of lower level tools and libraries are required, for details please refer to [required setup](https://github.com/NordicSemiconductor/pc-nrfjprog-js#required-setup) section.

#### USB SDFU devices

##### Windows

In order to access Nordic USB devices specific drivers must be installed on Windows, which are automatically installed by nRF Connect for Desktop (starting from version 2.4). The drivers can be found [here](https://github.com/NordicSemiconductor/pc-nrfconnect-launcher/tree/master/build/drivers).

##### Linux
Linux requires correct permissions to access these devices. For this purpose please install udev rules from [nrf-udev](https://github.com/NordicSemiconductor/nrf-udev) repository, follow instructions there.

## Usage

```js
import { setupDevice } from 'nrf-device-setup';

setupDevice(selectedDevice, configuration) // returns a Promise
    .then(device => {
        console.log(device);
    });
```

### Device selection

In the above example `selectedDevice` and also the `device` as the resolved result is
an item from the `deviceMap` of [nrf-device-lister](https://github.com/NordicSemiconductor/nrf-device-lister-js).
Each of these items have a `serialNumber` of some kind which must identify the device regardless
of the means it is interacted with.

### Configuration

```js
const configuration = {
    jprog: {...}, // will be applied if selectedDevice is a JLink device
    dfu: {...},   // will be applied if selectedDevice is a USB SDFU device

    needSerialport: true, // after successful DFU serialport is expected

    // These promises are not required for nRF Connect apps, they provide a way
    // to handle user interaction when confirmation or choice is to be made, see example below
    promiseConfirm,
    promiseChoice,
};
```

For JLink devices _pc-nrfjprog-js_ is used to check for `fwVersion` at `fwIdAddress`, and
in case of a mismatch the referenced `fw` is flashed to the device. These values are grouped
under the device type or board version or family key which is resolved by specificity.
The keys are case-insensitive.
```js
configuration.jprog = {
    NRF52832_xxAA_REV2: {...},

    // fallback if exact device type not specified
    NRF52832: {...},

    // fallback if device type not specified
    PCA10040: {...},

    // fallback to family if board version not specified
    nrf52: {
        fw: path.resolve(__dirname, 'fw/customfirmware-for-nrf52.hex'),

        // fwVersion can be either a fixed string or an object:
        fwVersion: 'magicstring',
        fwVersion: {
            length: 11, // number of bytes to read and provide to validator callback
            validator: data => {
                // return true if expected data is found
                // return false if expected data is not found
                return (data === 'magicstring');
            }
        },

        fwIdAddress: 0x2000,
    },

    nrf51: {...},
}
```

For USB SDFU devices _pc-nrf-dfu-js_ is used to perform the DFU.
```js
configuration.dfu = {
    pca10056: {
        application: path.resolve(__dirname, 'fw/customfirmware-for-pca10056.hex'),

        // softdevice is optional, depends on application firmware
        softdevice: path.resolve(__dirname, 'fw/softdevice.hex'),

        semver: 'my-fw-name 1.0.0+dfuJan-01-2018-01-01-01',

        // DFU initPacket related parameters, optional, listed values are default:
        params: {
            hwVersion: 52,
            fwVersion: 4,
            sdReq: [],
            sdId: [],
        }
    }
}
```

## USB SDFU

PCA10059 is a nRF52840 dongle which does not have a JLink debugger, so the USB device
that the operating system _sees_ depends on the firmware that is currently running on the Nordic chip.

This can be either a _bootloader_ or an _application firmware_.

### Bootloader mode

The bootloader provides a USB device with vendor ID `0x1915` and product ID `0x521f`.
This device has a USB CDC ACM (serialport) interface which handles the DFU operation.
In case you need to manually trigger the bootloader, press the RESET button on the dongle.

### Application mode

The dongle is in application mode if it has an application to run and is simply plugged in,
or after a successful DFU operation.

In application mode the visible USB device depends on the application firmware.
For further documentation please refer to the [Nordic SDK]().

In application mode it is **expected** that the visible USB device has a _DFU trigger interface_.
This interface provides a `semver` string which identifies the application firmware currently running,
and is also able to reset the device into bootloader.
In case the `semver` doesn't match the bootloader will be triggered.

Changing between bootloader and application also implies that the USB device is detached and attached,
so there is an underlying functionality based on _nrf-device-lister_ which looks for the newly
attached USB device and tries to match by its _serialNumber_.

## Example

```js
import { setupDevice } from 'nrf-device-setup';

setupDevice(
    selectedDevice,
    {
        jprog: {
            nrf52: {
                fw: path.resolve(__dirname, 'fw/rssi-10040.hex'),
                fwVersion: 'rssi-fw-1.0.0',
                fwIdAddress: 0x2000,
            },
        },

        dfu: {
            pca10056: {
                application: path.resolve(__dirname, 'fw/rssi-10056.hex'),
                semver: 'rssi_cdc_acm 2.0.0+dfuMar-27-2018-12-41-04',
            },
        },

        needSerialport: true,

        // promise returning function that resolves with true/false
        promiseConfirm: async message => (await inquirer.prompt([{
            type: 'confirm',
            name: 'isConfirmed',
            message,
            default: false,
        }])).isConfirmed,

        // promise returning function that resolves with an element of the input array
        promiseChoice: async (message, choices) => (await inquirer.prompt([{
            type: 'list',
            name: 'choice',
            message,
            choices,
        }])).choice,
    }
) // => Promise with device that is running RSSI fw and has a serialport ready to be opened.
```

## Tests

The project comes with automated integration tests in the `test` directory. In order to run the test, at least one nRF51 device, nRF52 device, and nRF52840 dongle must be attached to the PC. To run the tests:

    npm test

To run tests for only one device type, include the name of the test file e.g.

    npm test -- nrf51
