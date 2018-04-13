import buble from 'rollup-plugin-buble';
import async from 'rollup-plugin-async';
import json from 'rollup-plugin-json';
import pkg from './package.json';

export default [
    {
        input: 'src/index.js',
        output: [
            { file: pkg.main, format: 'cjs', sourcemap: true },
        ],
        external: ['events', 'debug', 'usb', 'serialport', 'pc-nrfjprog-js', 'nrf-device-lister'],
        plugins: [
            json({
                include: 'src/**/*.json',
                preferConst: true,
                indent: '  ',
            }),
            async(),
            buble({
                exclude: ['src/**/*.json'],
                transforms: { generator: false },
            }),
        ],
    },
];
