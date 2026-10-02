import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

if (process.platform !== 'win32') {
  console.log('Windows ownership live probe skipped: Windows host required.');
} else {
  const require = createRequire(import.meta.url);
  const { probeWindowsOwnershipInactive } = require('../src/windows-ownership-recovery.cjs');
  // Read-only smoke against inbox PowerShell 5.1. A live tunnel or other Node
  // process is allowed here; we validate observation, never run cleanup.
  const proof = probeWindowsOwnershipInactive([]);
  assert.equal(proof.observed, true);
  assert.equal(proof.currentProcessFound, true);
  for (const key of ['otherProcessIds', 'serviceStates', 'adapterNames', 'addresses']) {
    assert.ok(Array.isArray(proof[key]), `${key} must stay an array even with zero/one result`);
  }
  console.log('Windows ownership PowerShell process/service/address probe passed.');
}
