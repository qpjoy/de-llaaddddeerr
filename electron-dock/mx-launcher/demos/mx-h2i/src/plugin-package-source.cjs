'use strict';

// AppCenter 插件包的来源解析与校验。
//
// 插件的「身份」仍然是 npm 包（name + semver），但「投递」不再 spawn npm CLI：
// 打包后的 Electron 里没有可靠的 npm/pnpm（Windows 上 spawn npm 常年失败），
// 而且 npm install 会拉整棵依赖树，无法做完整性校验和原子回滚。
//
// 取而代之的是一条有序的来源链：registry packument -> mirror registry -> OSS/
// Release Center 直链 tarball。每一段都用同一个 launcher 网络栈下载（带 Host
// Resolve + SNI 覆写），用 dist.integrity / shasum 校验后解包到独立 slot。

const crypto = require('crypto');
const zlib = require('zlib');

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_MIRROR_REGISTRY = 'https://registry.npmmirror.com';
const TAR_BLOCK_SIZE = 512;

function nullableText(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

function normalizeBase(value) {
  const text = nullableText(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/**
 * 解析来源链。顺序即优先级，重复的 baseUrl 会被折叠，
 * 这样「主源和镜像配成同一个地址」不会白白多试一次。
 */
function normalizePluginSources(config = {}) {
  const rows = [
    { id: 'registry', kind: 'registry', baseUrl: normalizeBase(config.registryUrl) || DEFAULT_REGISTRY },
    { id: 'mirror', kind: 'registry', baseUrl: normalizeBase(config.mirrorRegistryUrl) || DEFAULT_MIRROR_REGISTRY },
    { id: 'oss', kind: 'tarball', baseUrl: normalizeBase(config.tarballBaseUrl) }
  ].filter((row) => row.baseUrl);
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.kind}:${row.baseUrl}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** scoped 包在 registry 路径里的 `/` 必须转义成 %2f。 */
function packumentUrl(source, packageName) {
  const name = nullableText(packageName);
  if (!source?.baseUrl || !name || source.kind !== 'registry') return null;
  return `${source.baseUrl}/${name.replace(/\//g, '%2f')}`;
}

/**
 * OSS/Release Center 直链约定：
 * `{base}/{@scope/name 里的 / 换成 -}/{basename}-{version}.tgz`
 * 与 npm pack 产出的文件名保持一致，便于 CI 直接上传。
 */
function tarballMirrorUrl(source, packageName, version) {
  const name = nullableText(packageName);
  const semver = nullableText(version);
  if (!source?.baseUrl || !name || !semver || source.kind !== 'tarball') return null;
  const flat = name.replace(/^@/, '').replace(/\//g, '-');
  return `${source.baseUrl}/${flat}/${flat}-${semver}.tgz`;
}

function selectPackumentVersion(packument, requestedVersion) {
  if (!packument || typeof packument !== 'object') return null;
  const versions = packument.versions && typeof packument.versions === 'object' ? packument.versions : {};
  const distTags = packument['dist-tags'] && typeof packument['dist-tags'] === 'object' ? packument['dist-tags'] : {};
  const requested = nullableText(requestedVersion);
  const resolved = requested && versions[requested]
    ? requested
    : nullableText(distTags[requested || 'latest']) || nullableText(distTags.latest);
  const manifest = resolved ? versions[resolved] : null;
  if (!manifest || typeof manifest !== 'object') return null;
  const dist = manifest.dist && typeof manifest.dist === 'object' ? manifest.dist : {};
  return {
    version: nullableText(manifest.version) || resolved,
    tarball: nullableText(dist.tarball),
    integrity: nullableText(dist.integrity),
    shasum: nullableText(dist.shasum)
  };
}

/**
 * registry 返回的 tarball 地址可能指向公网 CDN。如果这条来源本身是镜像，
 * 就把 host 换成镜像 host —— 否则「配了镜像但仍然去 npmjs 拉包」。
 */
function rewriteTarballToSource(source, tarballUrl) {
  const url = nullableText(tarballUrl);
  if (!url || !source?.baseUrl) return url;
  try {
    const target = new URL(url);
    const base = new URL(source.baseUrl);
    if (target.host === base.host) return url;
    target.protocol = base.protocol;
    target.host = base.host;
    return target.toString();
  } catch {
    return url;
  }
}

/** 把 sha512-<base64> / sha1 hex 统一成 {algorithm, expected}。 */
function parseIntegrity(integrity, shasum) {
  const text = nullableText(integrity);
  if (text) {
    const [algorithm, ...rest] = text.split('-');
    const digest = rest.join('-');
    if (algorithm && digest && crypto.getHashes().includes(algorithm)) {
      return { algorithm, expected: digest, encoding: 'base64' };
    }
  }
  const sha1 = nullableText(shasum);
  if (sha1 && /^[0-9a-f]{40}$/i.test(sha1)) {
    return { algorithm: 'sha1', expected: sha1.toLowerCase(), encoding: 'hex' };
  }
  return null;
}

/**
 * 没有 integrity 时返回 ok:false 而不是默默放行：
 * 未校验的 tarball 不应该被当成可安装产物。
 */
function verifyTarballIntegrity(buffer, { integrity, shasum } = {}) {
  const parsed = parseIntegrity(integrity, shasum);
  if (!parsed) {
    return { ok: false, reason: 'missing-integrity', algorithm: null, expected: null, actual: null };
  }
  const actual = crypto.createHash(parsed.algorithm).update(buffer).digest(parsed.encoding);
  const normalizedActual = parsed.encoding === 'hex' ? actual.toLowerCase() : actual;
  return {
    ok: normalizedActual === parsed.expected,
    reason: normalizedActual === parsed.expected ? null : 'integrity-mismatch',
    algorithm: parsed.algorithm,
    expected: parsed.expected,
    actual: normalizedActual
  };
}

function tarFieldText(block, offset, length) {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8').trim();
}

function tarFieldOctal(block, offset, length) {
  const text = tarFieldText(block, offset, length).replace(/[^0-7]/g, '');
  return text ? parseInt(text, 8) : 0;
}

/**
 * 最小 ustar 解包器。npm tarball 的结构是固定的：gzip 包一层 tar，
 * 所有条目都在 `package/` 前缀下，只有普通文件和目录。
 * 自己解析可以避免在打包产物里再背一个原生依赖。
 */
function extractNpmTarball(gzipped) {
  const tar = zlib.gunzipSync(gzipped);
  const entries = [];
  let offset = 0;
  let longName = null;
  while (offset + TAR_BLOCK_SIZE <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;
    const rawName = tarFieldText(header, 0, 100);
    const size = tarFieldOctal(header, 124, 12);
    const typeFlag = tarFieldText(header, 156, 1) || '0';
    const prefix = tarFieldText(header, 345, 155);
    const mode = tarFieldOctal(header, 100, 8);
    const dataStart = offset + TAR_BLOCK_SIZE;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;

    if (typeFlag === 'L') {
      // GNU long name: 名字放在下一个条目的数据段里。
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    const fullName = longName || (prefix ? `${prefix}/${rawName}` : rawName);
    longName = null;
    if (typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '') continue;
    const relativePath = stripPackagePrefix(fullName);
    if (!relativePath) continue;
    entries.push({ path: relativePath, mode: mode || 0o644, content: Buffer.from(data) });
  }
  return entries;
}

/**
 * 去掉 npm 的 `package/` 顶层目录，同时挡住 `..` 和绝对路径 —— tarball 是
 * 远端产物，解包时必须假设它可能想写到 slot 目录之外。
 */
function stripPackagePrefix(name) {
  const normalized = String(name || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.endsWith('/')) return null;
  const parts = normalized.split('/');
  if (parts[0] === 'package') parts.shift();
  if (!parts.length) return null;
  if (parts.some((part) => part === '..' || part === '' || part === '.')) return null;
  if (/^([a-zA-Z]:|\/)/.test(parts[0])) return null;
  return parts.join('/');
}

/**
 * 候选下载地址：registry 源先查 packument 再取 dist.tarball，
 * tarball 源直接按约定拼地址。调用方按顺序试，第一个校验通过的就赢。
 */
function pluginDownloadPlan({ packageName, version, sources } = {}) {
  const rows = Array.isArray(sources) ? sources : [];
  return rows.map((source) => (source.kind === 'registry'
    ? { sourceId: source.id, kind: 'registry', packumentUrl: packumentUrl(source, packageName), source }
    : { sourceId: source.id, kind: 'tarball', tarballUrl: tarballMirrorUrl(source, packageName, version), source }
  )).filter((row) => row.packumentUrl || row.tarballUrl);
}

module.exports = {
  DEFAULT_MIRROR_REGISTRY,
  DEFAULT_REGISTRY,
  extractNpmTarball,
  normalizePluginSources,
  packumentUrl,
  parseIntegrity,
  pluginDownloadPlan,
  rewriteTarballToSource,
  selectPackumentVersion,
  stripPackagePrefix,
  tarballMirrorUrl,
  verifyTarballIntegrity
};
