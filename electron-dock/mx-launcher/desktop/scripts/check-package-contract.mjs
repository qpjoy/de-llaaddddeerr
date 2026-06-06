import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const projectRoot = new URL('..', import.meta.url);

await assertFile('electron-builder.yml');
await assertFile('products/hdo/product.json');
await assertFile('main.cjs');
await assertBuilderContract();
await assertProductManifest();
await assertNativePolicy();

console.log('[mx-launcher] package contract OK');

async function assertFile(relativePath) {
  await access(new URL(relativePath, projectRoot));
}

async function assertBuilderContract() {
  const text = await readFile(new URL('electron-builder.yml', projectRoot), 'utf8');
  for (const required of [
    'target: zip',
    'target: portable',
    'target: dir',
    '- dmg',
    'hardenedRuntime: true',
    'notarize: true',
    'dmg:',
    'sign: true',
    'requestedExecutionLevel: asInvoker',
    'afterSign: scripts/after-sign.mjs',
    'from: native',
    'from: products'
  ]) {
    if (!text.includes(required)) {
      throw new Error(`electron-builder.yml missing "${required}"`);
    }
  }
}

async function assertProductManifest() {
  const manifest = JSON.parse(await readFile(new URL('products/hdo/product.json', projectRoot), 'utf8'));
  const required = [
    ['id', 'hdo'],
    ['legacyProductId', 'hdo'],
    ['backend.mxLauncherAdminApi', '/api/v1/mx-launcher/admin/products/hdo'],
    ['backend.legacyApiBase', '/api/v1/hdo'],
    ['artifacts.resourcesDirectory', 'products/hdo'],
    ['artifacts.serviceProfile', 'hdo-network']
  ];
  for (const [path, expected] of required) {
    const actual = path.split('.').reduce((value, key) => value && value[key], manifest);
    if (actual !== expected) throw new Error(`products/hdo/product.json ${path} expected ${expected}`);
  }
}

async function assertNativePolicy() {
  if (process.env.MX_LAUNCHER_ALLOW_MISSING_NATIVE === '1') return;
  if (process.platform !== 'win32') return;
  for (const file of ['native/win32-x64/MxLauncher.exe', 'native/win32-x64/MxService.exe']) {
    await access(join(projectRoot.pathname, file));
  }
}
