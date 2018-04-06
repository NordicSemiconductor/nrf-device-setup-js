import buble from 'rollup-plugin-buble';
import async from 'rollup-plugin-async';
import pkg from './package.json';

export default [
    {
        input: pkg.module,
        output: [
            { file: pkg.main, format: 'cjs', sourcemap: true },
        ],
        external: ['events', 'debug', 'usb', 'serialport', 'pc-nrfjprog-js', 'nrf-device-lister'],
        plugins: [
            async(),
            buble({ transforms: { generator: false } }),
        ],
    },
];
