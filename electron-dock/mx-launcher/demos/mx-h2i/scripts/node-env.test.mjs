#!/usr/bin/env node
import assert from 'node:assert/strict';

import { cleanElectronNodeEnv } from './node-env.mjs';

const windows = cleanElectronNodeEnv({
  SystemRoot: 'D:\\Windows',
  Path: 'C:\\Program Files\\nodejs;D:\\Windows\\System32',
  NODE_OPTIONS: '--trace-warnings --no-expose-wasm',
  ELECTRON_RUN_AS_NODE: '1'
}, 'win32');

assert.equal(windows.NODE_OPTIONS, '--trace-warnings');
assert.equal(windows.ELECTRON_RUN_AS_NODE, undefined);
assert.deepEqual(windows.Path.split(';'), [
  'D:\\Windows\\System32\\WindowsPowerShell\\v1.0',
  'C:\\Program Files\\nodejs',
  'D:\\Windows\\System32'
]);

const windowsWithoutPath = cleanElectronNodeEnv({ windir: 'C:\\Windows' }, 'win32');
assert.equal(
  windowsWithoutPath.Path,
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Windows\\System32'
);

const nonWindows = cleanElectronNodeEnv({ Path: '/custom/bin' }, 'darwin');
assert.equal(nonWindows.Path, '/custom/bin');

console.log('node-env tests passed');
