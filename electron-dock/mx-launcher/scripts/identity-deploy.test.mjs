import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, readFileSync, chmodSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProfile, readProfile, internalOrigin, savePrivate } from './identity-profile.mjs';
import { activateIdentity, deployIdentity, resources, verifyIdentity } from './identity-deploy.mjs';

test('init/redeploy/restore preserve keys, TLS root and issuer; no credentials in deploy output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-identity-deploy-')); const file = join(dir, 'profile.json');
  const live = new Map(); const calls = []; const logs = [];
  const execute = (args, input) => {
    calls.push(args.join(' '));
    if (args.includes('get')) return JSON.stringify(live.get(`${args[3]}:${args[4]}`) ?? null).replace(/^null$/, '');
    if (args[0] === 'apply') {
      const value = JSON.parse(input);
      if (value.stringData) value.data = Object.fromEntries(Object.entries(value.stringData).map(([k,v]) => [k, Buffer.from(v).toString('base64')]));
      live.set(`${value.kind.toLowerCase()}:${value.metadata.name}`, value);
    }
    return '';
  };
  try {
    const p = initializeProfile('https://10.88.88.88:18443', file);
    const bytes = readFileSync(file, 'utf8');
    assert.deepEqual(initializeProfile(p.origin, file), p);
    for (let i = 0; i < 2; i++) deployIdentity({ file, execute, revision: 'abc123456789', log: line => logs.push(line) });
    assert.equal(readFileSync(file, 'utf8'), bytes);
    assert.equal(live.size, 4);
    assert.ok(calls.indexOf('-n mx-internal-shadow rollout status deployment/mx-identity --timeout=180s') < calls.lastIndexOf('apply --server-side --field-manager=mx-identity-deploy -f -'));
    assert.ok(!logs.join('').includes(p.clientSecret));
    assert.ok(!JSON.stringify(resources(p, 'abc')).includes(p.caKey));
    const activation = [];
    for (let i = 0; i < 2; i++) activateIdentity({ file, execute: args => { activation.push(args); return ''; } });
    assert.deepEqual(activation[0], activation[1], 'same config must not change the API rollout annotation');
    assert.ok(!JSON.stringify(activation).includes(p.clientSecret));
    const verification = [];
    verifyIdentity({ file, execute: args => { verification.push(args); return ''; }, log() {} });
    assert.ok(verification[0].includes('deployment/mx-launcher-internal'));
    assert.throws(() => verifyIdentity({ file, execute() { throw new Error('TLS unreachable'); } }), /TLS unreachable/);
    const copy = join(dir, 'restored', 'profile.json'); savePrivate(copy, p);
    assert.deepEqual(readProfile(copy), p);
    assert.throws(() => initializeProfile('https://10.88.88.89:18443', file), /迁移/);
    unlinkSync(file);
    assert.throws(() => deployIdentity({ file, execute }), /丢失/);
    savePrivate(file, { ...p, installationId: 'different-installation' });
    assert.throws(() => deployIdentity({ file, execute }), /归属/);
    chmodSync(file, 0o644); assert.throws(() => readProfile(file), /私有/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('managed pilot does not expose a public address, old HTTP port or malformed origin', () => {
  for (const url of ['http://10.1.2.3:18443', 'https://1.2.3.4:18443', 'https://10.1.2.3', 'https://10.1.2.3:443', 'https://10.1.2.3:18090', 'https://user:pass@10.1.2.3:18443', 'https://10.1.2.3:18443/path']) assert.throws(() => internalOrigin(url));
});
test('an unconfigured deployment leaves old authentication untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mx-identity-absent-')); const calls = [];
  try {
    deployIdentity({ file: join(dir, 'missing.json'), execute: args => { calls.push(args); return ''; }, log() {} });
    assert.ok(calls.every(args => args.includes('get')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
