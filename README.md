```
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
            custom: {
                fw: path.resolve(__dirname, 'fw/customfirmware.hex'),
                fwVersion: { 
                    length: 20, // number of bytes to read and provide to validator callback
                    validator: data => {
                        // return true if expected data is found
                        // return false if expected data is not found
                    }
                },
                fwIdAddress: <start address of data to check>
            }
        },

        // for USB device in [Bootloader mode] or in [App mode with DFU trigger]
        dfu: {
            pca10056: {
                fw: path.resolve(__dirname, 'fw/rssi-10056.hex'),
                semver: 'rssi_cdc_acm 2.0.0+dfuMar-27-2018-12-41-04',
            },
            pca10059: {
                fw: path.resolve(__dirname, 'fw/rssi-10059.hex'),
                semver: 'rssi_cdc_acm 2.0.0+dfuMar-27-2018-12-41-04',
            },
        },

        needSerialport: true,
        promiseConfirm,
        promiseChoice,
    }
) => Promise with device prepared (mostly)

```
