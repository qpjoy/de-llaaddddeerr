#!/usr/bin/env node
/**
 * End-to-end smoke test of the marketplace install pipeline.
 *
 * What it does (without booting Electron):
 *   1. Spins up a fake marketplace HTTP server that serves a registry
 *      pointing at `@qpjoy/electron-tunnel`.
 *   2. Constructs a PluginStore + PluginRegistry against a temp `userData`.
 *   3. Runs `PluginStore.installFrom({ source: { type: 'local-dir',
 *      path: <repo>/electron-plugin/packages/electron-mihomo-tunnel } })`
 *      — i.e. seeds the tunnel offline.
 *   4. Verifies the registry row exists in `awaitingGrant`.
 *   5. Grants every permission the manifest asks for.
 *   6. Reads the entry-point module from disk and confirms the default
 *      export looks like a PluginModule.
 *
 * Run from the workspace root after `pnpm -r build`:
 *   node electron-market/scripts/smoke-marketplace.mjs
 *
 * Activation itself needs Electron's `app/ipcMain/session`, so we stop
 * just before `runtime.activate(...)`; the existing `electron-test` app
 * is the natural place to exercise that step.
 */
import { createServer } from 'node:http';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { PluginRegistry } from '../packages/electron-market/dist/registry/PluginRegistry.js';
import { MarketplaceClient } from '../packages/electron-market/dist/registry/MarketplaceClient.js';
import { PluginStore } from '../packages/electron-market/dist/store/PluginStore.js';

const TUNNEL_SRC = resolve(
  new URL('.', import.meta.url).pathname,
  '../../electron-plugin/packages/electron-mihomo-tunnel'
);

if (!existsSync(join(TUNNEL_SRC, 'dist', 'plugin.js'))) {
  console.error('!! Build the tunnel first:');
  console.error('   (cd electron-plugin && pnpm --filter @qpjoy/electron-tunnel build)');
  process.exit(1);
}

// 1. Fake marketplace.
const index = JSON.parse(
  readFileSync(new URL('../registry/index.json', import.meta.url), 'utf8')
);
const market = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(index));
});
await new Promise((r) => market.listen(0, '127.0.0.1', r));
const port = market.address().port;
console.log('• fake marketplace on http://127.0.0.1:' + port);

// 2. Temp userData.
const userData = mkdtempSync(join(tmpdir(), 'qpjoy-plugin-test-'));
const pluginsRoot = join(userData, 'plugins');
const dbPath = join(userData, 'electron-plugin.db');
console.log('• userData =', userData);

const registry = new PluginRegistry(dbPath);
const store = new PluginStore({ pluginsRoot, registry });
const marketplace = new MarketplaceClient({
  indexUrl: `http://127.0.0.1:${port}`,
  ttlMs: 0
});

// 3. Resolve from marketplace, then seed from local dir.
const entry = await marketplace.resolve('qpjoy.electron-tunnel');
if (!entry) throw new Error('marketplace did not return tunnel entry');
console.log('• marketplace resolved:', entry.npm + '@' + entry.latest);

const manifest = await store.installFrom({
  id: entry.id,
  npm: entry.npm,
  source: { type: 'local-dir', path: TUNNEL_SRC }
});
console.log('• installed manifest:', { id: manifest.id, version: manifest.version });

// 4. Registry check.
const record = registry.get(entry.id);
if (!record) throw new Error('no registry row');
if (record.state !== 'awaitingGrant') {
  throw new Error('expected state=awaitingGrant, got ' + record.state);
}
console.log('• state:', record.state);

// 5. Grant.
registry.grant(entry.id, manifest.permissions);
registry.setState(entry.id, 'installed');
console.log('• granted', manifest.permissions.length, 'permissions');

// 6. Confirm entry module shape.
const pkg = JSON.parse(
  readFileSync(join(record.installPath, 'node_modules', entry.npm, 'package.json'), 'utf8')
);
const entryAbs = join(record.installPath, 'node_modules', entry.npm, pkg.qpjoyPlugin.entry);
const mod = await import(entryAbs);
const plugin = mod.default ?? mod;
if (typeof plugin.activate !== 'function') {
  throw new Error('plugin entry has no activate()');
}
console.log('• plugin entry ok:', entryAbs);

market.close();
registry.close();
console.log('\nSMOKE PASS — every step works except runtime.activate(),');
console.log('which needs Electron app/ipcMain/session and is exercised by electron-test.');
