#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../src/main-runtime.cjs', import.meta.url)),
  'utf8'
);

function functionSource(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} must exist`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.ok(bodyStart > 1, `${signature} body must exist`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${signature} is not balanced`);
}

const handlerStart = source.indexOf("ipcMain.handle('mx-h2i:provision-h2o-oversea'");
const handlerEnd = source.indexOf('ipcMain.handle(', handlerStart + 1);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'the explicit H2O provision IPC must exist');
const explicitHandler = source.slice(handlerStart, handlerEnd);
assert.match(
  explicitHandler,
  /assignmentMode:\s*'platform-default'/,
  'the explicit 分配系统默认 action must request the authoritative platform default'
);

const provision = functionSource('async function provisionH2oOverseaForCurrentUser(input = {})');
assert.match(provision, /assignmentMode\s*\?\s*\[\[\]\]/, 'platform-default uses one server-authoritative attempt');
assert.match(provision, /assignmentMode \? \{ assignmentMode \} : \{\}/, 'the explicit mode reaches ensure-subscription');
assert.match(
  provision,
  /const existingEntitlement = assignmentMode\s*\?\s*null\s*:/,
  'platform-default must not fall back to the old entitlement'
);

const hydrate = functionSource('async function hydrateH2oSystemSubscriptionsForUser(options = {})');
assert.doesNotMatch(
  hydrate,
  /assignmentMode:\s*'platform-default'/,
  'login, hydrate, and ordinary refresh must continue preserving the admin assignment'
);

console.log('h2o platform-default assignment policy tests passed');
