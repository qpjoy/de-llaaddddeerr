import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProfile, readProfile, savePrivate } from './identity-profile.mjs';
import { createPublicEntry } from './identity-public-profile.mjs';
import { registerPublic } from './identity-public.mjs';
import { registerApplication } from './identity-app.mjs';
import { inspectIdentity, resources } from './identity-deploy.mjs';

test('additional applications preserve existing keys, support both entries and refuse replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'mx-app-profile-')), file = join(root, 'profile.json');
  try {
    const p = initializeProfile('https://10.88.88.88:18443', file);
    const publicEntry = createPublicEntry({ origin: 'https://auth.example.test', adminOrigin: 'https://admin.example.test', hubOrigin: 'https://hub.example.test', audience: 'hub', privateOrigin: p.origin });
    savePrivate(file, { ...p, publicEntry });
    const input = { appId: 'mx-customer', origin: 'https://customer.example.test', audience: 'customer', entry: 'public', appFile: join(root, 'customer', 'profile.json'), file };
    registerApplication(input);
    const bytes = readFileSync(input.appFile, 'utf8'); registerApplication(input);
    assert.equal(readFileSync(input.appFile, 'utf8'), bytes); assert.equal(statSync(input.appFile).mode & 0o777, 0o600);
    const next = readProfile(file);
    const runtime = resources({ ...p, publicEntry }).runtime;
    const execute = args => args.includes('get') && args.includes('mx-identity-runtime') ? JSON.stringify(runtime) : '';
    assert.doesNotThrow(() => inspectIdentity(next, execute));
    assert.throws(() => inspectIdentity({ ...p, publicEntry }, args => args.includes('get') && args.includes('mx-identity-runtime') ? JSON.stringify(resources(next).runtime) : ''), /客户端/);
    assert.deepEqual(next.publicEntry.applications[0], publicEntry.applications[0]);
    assert.deepEqual({ ...next.publicEntry, applications: undefined }, { ...publicEntry, applications: undefined });
    // Adding applications removes the former assumption that Hub occupies slot zero.
    savePrivate(file, { ...next, publicEntry: { ...next.publicEntry, applications: [...next.publicEntry.applications].reverse() } });
    const hubFile = join(root, 'hub', 'profile.json');
    registerPublic({ origin: publicEntry.origin, adminOrigin: publicEntry.adminOrigin, hubOrigin: publicEntry.applications[0].origin,
      environment: 'test', audience: 'hub', file, hubFile });
    assert.equal(JSON.parse(readFileSync(hubFile, 'utf8')).clientId, 'mx-insight-hub-web');
    assert.equal(readProfile(file).publicEntry.applications.length, 2);
    assert.throws(() => registerApplication({ ...input, origin: 'https://changed.example.test' }), /迁移/);
    registerApplication({ ...input, entry: 'private', appFile: join(root, 'private', 'profile.json') });
    assert.deepEqual({ ...readProfile(file), applications: undefined, publicEntry: undefined }, { ...p, applications: undefined, publicEntry: undefined });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
