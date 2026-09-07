#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, '..');
const sourceFiles = [
  ...walk(resolve(appRoot, 'src')),
  ...walk(resolve(appRoot, 'src-electron')),
  resolve(appRoot, 'package.json'),
  resolve(appRoot, 'quasar.config.ts')
];
const sources = new Map(sourceFiles.map((file) => [
  relative(appRoot, file),
  readFileSync(file, 'utf8')
]));
const all = [...sources.values()].join('\n');
const main = sources.get('src-electron/electron-main.ts') || '';
const renderer = [...sources.entries()]
  .filter(([file]) => file.startsWith('src/') || file.endsWith('electron-preload.ts'))
  .map(([, text]) => text)
  .join('\n');
const pkg = JSON.parse(sources.get('package.json'));

const failures = [];

for (const [label, pattern] of [
  ['MX-H2I runtime coupling', /mx-h2i-runtime/i],
  ['legacy compatibility service IP', /10\.88\.88\.88/],
  ['legacy compatibility gateway IP', /10\.88\.0\.1/],
  ['shared local-edge port', /(^|[^0-9])2053([^0-9]|$)/],
  ['tunnel plugin dependency', /electron-plugin-tunnel/],
  ['system proxy ownership', /system-domain-proxy/],
  ['cross-product mode event publishing', /network-mode-events/],
  ['Luopan environment coupling', /LUOPAN_/],
  ['legacy identity migration', /legacyHdo/i],
  ['Internal direct peer mutation', /internal-direct-peer\/sync/]
]) {
  if (pattern.test(all)) failures.push(`forbidden ${label}`);
}

for (const [label, pattern] of [
  ['fixed product identity', /const PRODUCT_ID = 'mx-autotest'/],
  ['standalone mode', /mode: 'standalone'/],
  ['own standalone channel binding', /standaloneChannelProductId !== PRODUCT_ID/],
  ['route-only DNS domains', /dnsDomains: \[\]/],
  ['suppressed interface DNS', /suppressWireGuardDns: true/],
  ['ownership fail closed', /failOnOwnershipConflicts: true/],
  ['no system fallback', /allowSystemFallback: false/],
  ['no app-managed fallback', /fallbackToAppManaged: false/],
  ['no ownership supersession', /supersedeClaims: \[\]/],
  ['lease CIDR route', /routePlan\.leaseCidr/],
  ['service VIP host route', /routePlan\.serviceVip[\s\S]{0,80}\/32/],
  ['safeStorage vault', /safeStorage\.encryptString/],
  ['minimal OAuth audience', /audience: 'mx-sdk'/],
  ['minimal OAuth scope', /scope: 'auth\.read'/],
  ['versioned lease capability factory', /mintLeaseCapability\(\)/],
  ['bounded lease capability handover', /collectEnrollmentLeaseCapabilities\(\{/],
  ['relay-only peer selection', /pathPreference: 'relay'/],
  ['expired platform session rejection', /identityCanResume\(state\.identity, credentialVault\.accessToken\)/],
  ['platform discovery allowlist', /'\/api\/v1'/],
  ['platform member allowlist', /'\/api\/v1\/auth\/me'/],
  ['platform task-list allowlist', /'\/api\/v1\/tasks'/],
  ['platform runner-list allowlist', /'\/api\/v1\/runners'/],
  ['platform run allowlist', /api\\\/v1\\\/tasks/],
  ['renderer isolation', /contextIsolation: true/],
  ['renderer Node disabled', /nodeIntegration: false/],
  ['renderer sandbox', /sandbox: true/],
  ['top-frame-only IPC', /event\.senderFrame !== mainWindow\.webContents\.mainFrame/],
  ['permission requests denied', /setPermissionRequestHandler[\s\S]{0,120}callback\(false\)/]
]) {
  if (!pattern.test(main)) failures.push(`missing ${label}`);
}

if (/accessToken|leaseCapability|privateKey/.test(renderer)) {
  failures.push('renderer/preload mentions a protected credential field');
}

for (const dependency of Object.keys(pkg.dependencies || {})) {
  if (/(tunnel|mihomo|oversea)/i.test(dependency)) {
    failures.push(`forbidden runtime dependency ${dependency}`);
  }
}

if (pkg.name !== '@qpjoy/mx-autotest') failures.push('package identity is not @qpjoy/mx-autotest');
if (!pkg.dependencies?.['@qpjoy/electron-launcher']) failures.push('launcher dependency is missing');
if (!pkg.dependencies?.['@qpjoy/ui-design-neon-void']) failures.push('Neon Void dependency is missing');

if (failures.length) {
  console.error('MX AutoTest standalone safety check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`MX AutoTest standalone safety check passed (${sourceFiles.length} files).`);

function walk(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const file = join(root, name);
    const stat = statSync(file);
    if (stat.isDirectory()) files.push(...walk(file));
    else if (/\.(?:ts|vue|scss|cjs)$/.test(name)) files.push(file);
  }
  return files;
}
