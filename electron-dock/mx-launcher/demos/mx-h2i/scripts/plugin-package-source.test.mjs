#!/usr/bin/env node
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_MIRROR_REGISTRY,
  DEFAULT_REGISTRY,
  extractNpmTarball,
  normalizePluginSources,
  packumentUrl,
  pluginDownloadPlan,
  rewriteTarballToSource,
  selectPackumentVersion,
  stripPackagePrefix,
  tarballMirrorUrl,
  verifyTarballIntegrity
} = require('../src/plugin-package-source.cjs');

// --- source chain ---------------------------------------------------------

{
  const sources = normalizePluginSources({});
  assert.deepEqual(
    sources.map((row) => [row.id, row.baseUrl]),
    [['registry', DEFAULT_REGISTRY], ['mirror', DEFAULT_MIRROR_REGISTRY]],
    'default chain is registry then public mirror; OSS only when configured'
  );
}

{
  const sources = normalizePluginSources({
    registryUrl: 'https://registry.npmjs.org/',
    mirrorRegistryUrl: 'https://registry.npmjs.org',
    tarballBaseUrl: 'https://oss.example.com/plugins/'
  });
  assert.deepEqual(
    sources.map((row) => row.id),
    ['registry', 'oss'],
    'a mirror pointing at the primary registry must not be retried twice'
  );
  assert.equal(sources[1].kind, 'tarball');
}

{
  assert.deepEqual(
    normalizePluginSources({ registryUrl: 'ftp://nope', tarballBaseUrl: 'not a url' })
      .map((row) => row.baseUrl),
    [DEFAULT_REGISTRY, DEFAULT_MIRROR_REGISTRY],
    'non-http sources fall back to the defaults instead of being dialled'
  );
}

// --- url shapes -----------------------------------------------------------

{
  const [registry, , oss] = normalizePluginSources({ tarballBaseUrl: 'https://oss.example.com/plugins' });
  assert.equal(
    packumentUrl(registry, '@qpjoy/electron-launcher-app-h2o'),
    `${DEFAULT_REGISTRY}/@qpjoy%2felectron-launcher-app-h2o`,
    'scoped packages escape the scope separator in the packument path'
  );
  assert.equal(
    tarballMirrorUrl(oss, '@qpjoy/electron-launcher-app-h2o', '2.3.15'),
    'https://oss.example.com/plugins/qpjoy-electron-launcher-app-h2o/qpjoy-electron-launcher-app-h2o-2.3.15.tgz',
    'OSS direct links follow the npm pack filename convention'
  );
  assert.equal(packumentUrl(oss, '@qpjoy/x'), null, 'a tarball source has no packument endpoint');
  assert.equal(tarballMirrorUrl(registry, '@qpjoy/x', '1.0.0'), null, 'a registry source has no direct tarball path');
}

{
  const mirror = { id: 'mirror', kind: 'registry', baseUrl: 'https://registry.npmmirror.com' };
  assert.equal(
    rewriteTarballToSource(mirror, 'https://registry.npmjs.org/@qpjoy/pkg/-/pkg-1.0.0.tgz'),
    'https://registry.npmmirror.com/@qpjoy/pkg/-/pkg-1.0.0.tgz',
    'a mirror packument must not send the download back to the public registry'
  );
}

// --- version resolution ---------------------------------------------------

const packument = {
  'dist-tags': { latest: '2.3.15', next: '2.4.0-rc.1' },
  versions: {
    '2.3.14': { version: '2.3.14', dist: { tarball: 'https://r/pkg-2.3.14.tgz', shasum: 'a'.repeat(40) } },
    '2.3.15': { version: '2.3.15', dist: { tarball: 'https://r/pkg-2.3.15.tgz', integrity: 'sha512-abc' } },
    '2.4.0-rc.1': { version: '2.4.0-rc.1', dist: { tarball: 'https://r/pkg-2.4.0-rc.1.tgz' } }
  }
};

assert.equal(selectPackumentVersion(packument, '2.3.14').version, '2.3.14', 'an exact version wins');
assert.equal(selectPackumentVersion(packument, 'latest').version, '2.3.15', 'dist-tags resolve');
assert.equal(selectPackumentVersion(packument, 'next').version, '2.4.0-rc.1', 'gray-release tags resolve');
assert.equal(selectPackumentVersion(packument, null).version, '2.3.15', 'no request means latest');
assert.equal(
  selectPackumentVersion(packument, '9.9.9').version,
  '2.3.15',
  'an unknown version falls back to latest rather than failing the install outright'
);
assert.equal(selectPackumentVersion({ versions: {} }, 'latest'), null, 'an empty packument resolves to nothing');

// --- integrity ------------------------------------------------------------

const payload = Buffer.from('mx-h2i appcenter plugin payload');
const sha512 = crypto.createHash('sha512').update(payload).digest('base64');
const sha1 = crypto.createHash('sha1').update(payload).digest('hex');

assert.equal(verifyTarballIntegrity(payload, { integrity: `sha512-${sha512}` }).ok, true);
assert.equal(verifyTarballIntegrity(payload, { shasum: sha1 }).ok, true, 'legacy shasum still verifies');
assert.equal(
  verifyTarballIntegrity(Buffer.from('tampered'), { integrity: `sha512-${sha512}` }).reason,
  'integrity-mismatch'
);
assert.equal(
  verifyTarballIntegrity(payload, {}).ok,
  false,
  'an unverifiable tarball must never be treated as installable'
);
assert.equal(verifyTarballIntegrity(payload, {}).reason, 'missing-integrity');
assert.equal(
  verifyTarballIntegrity(payload, { integrity: 'bogus-AAAA' }).reason,
  'missing-integrity',
  'an unknown hash algorithm is not silently accepted'
);

// --- tarball extraction ---------------------------------------------------

function tarHeader({ name, size, mode = 0o644, typeFlag = '0' }) {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'utf8');
  block.write('0000000\0', 108, 8, 'utf8');
  block.write('0000000\0', 116, 8, 'utf8');
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
  block.write('00000000000\0', 136, 12, 'utf8');
  block.write('        ', 148, 8, 'utf8');
  block.write(typeFlag, 156, 1, 'utf8');
  block.write('ustar\0', 257, 6, 'utf8');
  block.write('00', 263, 2, 'utf8');
  let checksum = 0;
  for (const byte of block) checksum += byte;
  block.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
  return block;
}

function buildTarball(files) {
  const chunks = [];
  for (const file of files) {
    const content = Buffer.from(file.content, 'utf8');
    chunks.push(tarHeader({ name: file.name, size: content.length, mode: file.mode, typeFlag: file.typeFlag }));
    chunks.push(content);
    const padding = (512 - (content.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

{
  const entries = extractNpmTarball(buildTarball([
    { name: 'package/package.json', content: '{"name":"@qpjoy/plugin","version":"1.0.0"}' },
    { name: 'package/src/main.cjs', content: 'module.exports = {};', mode: 0o755 },
    { name: 'package/docs/', content: '', typeFlag: '5' }
  ]));
  assert.deepEqual(
    entries.map((entry) => entry.path).sort(),
    ['package.json', 'src/main.cjs'],
    'the package/ prefix is stripped and directory entries are skipped'
  );
  assert.equal(
    JSON.parse(entries.find((entry) => entry.path === 'package.json').content).version,
    '1.0.0'
  );
  assert.equal(entries.find((entry) => entry.path === 'src/main.cjs').mode, 0o755, 'file mode survives extraction');
}

{
  const entries = extractNpmTarball(buildTarball([
    { name: 'package/../../etc/evil', content: 'pwned' },
    { name: '/etc/absolute', content: 'pwned' },
    { name: 'package/ok.txt', content: 'fine' }
  ]));
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['ok.txt'],
    'path traversal and absolute paths are dropped before anything touches disk'
  );
}

assert.equal(stripPackagePrefix('package/a/../b'), null, 'traversal segments are rejected');
assert.equal(stripPackagePrefix('package/'), null, 'the bare prefix has no file to write');
assert.equal(stripPackagePrefix('package/a/b.js'), 'a/b.js');

// --- download plan --------------------------------------------------------

{
  const plan = pluginDownloadPlan({
    packageName: '@qpjoy/electron-launcher-app-h2o',
    version: '2.3.15',
    sources: normalizePluginSources({ tarballBaseUrl: 'https://oss.example.com/plugins' })
  });
  assert.deepEqual(
    plan.map((row) => [row.sourceId, row.kind]),
    [['registry', 'registry'], ['mirror', 'registry'], ['oss', 'tarball']],
    'the plan degrades registry -> mirror -> OSS so an unreachable npm still installs'
  );
  assert.ok(plan[2].tarballUrl.endsWith('-2.3.15.tgz'));
}

console.log('plugin-package-source: all assertions passed');
