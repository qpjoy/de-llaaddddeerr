import { generateKeyPairSync, randomBytes, randomUUID, X509Certificate, createPrivateKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, linkSync, unlinkSync, lstatSync, mkdtempSync, rmSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';

import { validatePublicEntry } from './identity-public-profile.mjs';
import { validApplicationList } from './identity-app-profile.mjs';

export const PROFILE = '/var/lib/mx-launcher/identity/profile.json';
export function internalOrigin(value) {
  const url = new URL(value);
  const octets = url.hostname.split('.').map(Number);
  const privateIp = isIP(url.hostname) === 4 && (octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168));
  if (url.protocol !== 'https:' || !privateIp || url.username || url.password || url.search || url.hash || url.pathname !== '/' || Number(url.port) < 1024 || [5432, 8008, 18090, 19190, 19290].includes(Number(url.port))) {
    throw new Error('内网试点地址须为 HTTPS 私有 IPv4 和独立端口，例如 https://10.88.88.88:18443；不修改原 18090 入口');
  }
  return url.origin;
}
export function savePrivate(file, value, createOnly = false) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || parent.uid !== process.getuid()) throw new Error('身份配置目录须为当前用户拥有的私有目录（700）');
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  if (createOnly) { try { linkSync(temp, file); } finally { unlinkSync(temp); } }
  else renameSync(temp, file);
  const dir = openSync(dirname(file), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
function loadProfile(file = PROFILE) {
  if (!existsSync(file)) return null;
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.uid !== process.getuid()) throw new Error('身份配置须为当前用户拥有的私有文件（600）');
  let p;
  try { p = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('身份档案 JSON 损坏；请恢复备份（不输出文件内容）'); }
  return validateProfileContent(p);
}
function validateProfileContent(p) {
  if (p.version !== 1 || p.origin !== internalOrigin(p.origin) || p.issuer !== `${p.origin}/identity` || !p.installationId
    || p.clientId !== 'mx-launcher-admin' || !/^[A-Za-z0-9_-]{43}$/.test(p.clientSecret) || !Array.isArray(p.cookieKeys)
    || p.cookieKeys.length !== 2 || p.cookieKeys.some(key => !/^[A-Za-z0-9_-]{43}$/.test(key)) || p.jwks?.keys?.length !== 1) throw new Error('身份配置不完整；请从备份恢复，不能自动重建密钥');
  createPrivateKey({ key: p.jwks.keys[0], format: 'jwk' });
  if (p.applications !== undefined && !validApplicationList(p.applications, p.clientId)) throw new Error('身份应用配置无效；请恢复原配置，不能自动重建客户端密钥');
  validatePublicEntry(p.publicEntry, p.origin);
  return p;
}

export function certificateChecks(p) {
  let ca, leaf;
  try { ca = new X509Certificate(p.caCert); leaf = new X509Certificate(p.tlsCert); }
  catch { throw new Error('身份 TLS 证书无法解析；请恢复备份（不输出证书或密钥）'); }
  const check = fn => { try { return Boolean(fn()); } catch { return false; } };
  return {
    caValid: ca.ca,
    signedByCa: check(() => leaf.verify(ca.publicKey)),
    ipMatches: check(() => leaf.checkIP(new URL(p.origin).hostname)),
    tlsKeyMatches: check(() => leaf.checkPrivateKey(createPrivateKey(p.tlsKey))),
    caKeyMatches: check(() => ca.checkPrivateKey(createPrivateKey(p.caKey)))
  };
}
function validateCertificates(p) {
  const labels = { caValid: 'CA 扩展无效或不具备签发资格', signedByCa: '服务证书签名不属于此 CA',
    ipMatches: '服务证书 IP 与入口不同', tlsKeyMatches: '服务证书与私钥不匹配', caKeyMatches: 'CA 证书与私钥不匹配' };
  const failed = Object.entries(certificateChecks(p)).filter(([, valid]) => !valid).map(([key]) => labels[key]);
  if (failed.length) throw new Error(`身份 TLS 校验失败：${failed.join('；')}。可运行 ops identity doctor 查看只读诊断；不要删除 profile.json 或重置密钥。`);
}
export function readProfile(file = PROFILE) {
  const p = loadProfile(file); if (p) validateCertificates(p); return p;
}
export function diagnoseProfile(file = PROFILE) {
  const p = loadProfile(file);
  return p ? { configured: true, node: process.version, nodeOpenSSL: process.versions.openssl, ...certificateChecks(p) } : { configured: false };
}
// Backups may retain the known, not-yet-published CA-extension bug so normal
// startup can repair it. Keys, leaf signature and issuer must still agree.
export function validateProfileForBackup(p) {
  validateProfileContent(p);
  const { caValid, ...checks } = certificateChecks(p);
  if (!Object.values(checks).every(Boolean)) throw new Error('身份档案密钥、签名或入口不一致；停止覆盖恢复备份');
  return p;
}
function openssl(args, cwd, input) {
  const r = spawnSync('openssl', args, { cwd, input, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (r.error || r.status) throw new Error('身份证书 OpenSSL 操作失败；需要 openssl，未输出私钥');
  return r.stdout;
}
function writeCertificateConfig(dir) {
  // OpenSSL 1.1.1 appends -addext to the host's x509_extensions; a stock
  // v3_ca section can therefore produce duplicate basicConstraints. Use one
  // explicit extension section, independent of /etc/pki/tls/openssl.cnf.
  writeFileSync(join(dir, 'request.cnf'), `[req]
distinguished_name = dn
[dn]
CN = MX Internal Identity
[ca_extensions]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
`);
}
function certificates(p) {
  const dir = mkdtempSync(join(tmpdir(), 'mx-identity-cert-'));
  const run = args => openssl(args, dir);
  try {
    writeCertificateConfig(dir);
    if (p.caKey) {
      writeFileSync(join(dir, 'ca.key'), p.caKey, { mode: 0o600 }); writeFileSync(join(dir, 'ca.crt'), p.caCert);
    } else {
      run(['req', '-config', 'request.cnf', '-extensions', 'ca_extensions', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '3650', '-subj', '/CN=MX Internal Identity CA', '-keyout', 'ca.key', '-out', 'ca.crt']);
    }
    run(['req', '-config', 'request.cnf', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=MX Internal Identity', '-keyout', 'tls.key', '-out', 'tls.csr']);
    writeFileSync(join(dir, 'tls.ext'), `subjectAltName=IP:${new URL(p.origin).hostname}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    run(['x509', '-req', '-in', 'tls.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-days', '365', '-sha256', '-extfile', 'tls.ext', '-out', 'tls.crt']);
    const generated = { ...p, caKey: readFileSync(join(dir, 'ca.key'), 'utf8'), caCert: readFileSync(join(dir, 'ca.crt'), 'utf8'), tlsKey: readFileSync(join(dir, 'tls.key'), 'utf8'), tlsCert: readFileSync(join(dir, 'tls.crt'), 'utf8') };
    validateCertificates(generated);
    return generated;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// Only repair this known bootstrap bug, and only after the deploy caller has
// verified that no SSO resources have been published to the local cluster.
export function repairBootstrapCa(file, assertUnpublished) {
  const p = loadProfile(file); if (!p) return null;
  const checks = certificateChecks(p);
  if (Object.values(checks).every(Boolean)) return p;
  const ca = new X509Certificate(p.caCert);
  const text = openssl(['x509', '-noout', '-text'], undefined, p.caCert);
  const duplicateConstraints = (text.match(/X509v3 Basic Constraints:/g) ?? []).length === 2 &&
    (text.match(/X509v3 Basic Constraints:(?: critical)?\s+CA:TRUE\b/g) ?? []).length === 2;
  if (checks.caValid || !checks.signedByCa || !checks.ipMatches || !checks.tlsKeyMatches || !checks.caKeyMatches || !duplicateConstraints ||
    ca.subject !== 'CN=MX Internal Identity CA' || ca.issuer !== ca.subject || !ca.verify(ca.publicKey)) {
    validateCertificates(p); // Includes only actionable check names, no secrets.
  }
  if (typeof assertUnpublished !== 'function') throw new Error('修复初次 CA 前必须确认没有已发布的 SSO 资源');
  assertUnpublished();
  const dir = mkdtempSync(join(tmpdir(), 'mx-identity-ca-repair-'));
  try {
    writeCertificateConfig(dir);
    writeFileSync(join(dir, 'ca.key'), p.caKey, { mode: 0o600 });
    // Keep the CA key, subject and serial so the already issued leaf remains
    // valid. The corrected CA certificate's fingerprint necessarily changes.
    openssl(['req', '-config', 'request.cnf', '-extensions', 'ca_extensions', '-x509', '-key', 'ca.key', '-sha256',
      '-days', '3650', '-set_serial', `0x${ca.serialNumber}`, '-subj', '/CN=MX Internal Identity CA', '-out', 'ca.crt'], dir);
    const fixed = { ...p, caCert: readFileSync(join(dir, 'ca.crt'), 'utf8') };
    validateCertificates(fixed);
    writeFileSync(join(dir, 'tls.crt'), p.tlsCert);
    openssl(['verify', '-CAfile', 'ca.crt', '-purpose', 'sslserver', '-verify_ip', new URL(p.origin).hostname, 'tls.crt'], dir);
    // One bounded, private backup; never overwrite an unrelated older backup.
    const backup = join(dirname(file), 'profile.before-ca-repair.json');
    if (existsSync(backup)) {
      if (JSON.stringify(loadProfile(backup)) !== JSON.stringify(p)) throw new Error('已有不同的 CA 修复备份；停止覆盖，请检查备份');
    } else savePrivate(backup, p, true);
    savePrivate(file, fixed);
    writeFileSync(join(dirname(file), 'ca.crt'), fixed.caCert, { mode: 0o644 });
    return fixed;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
export function initializeProfile(origin, file = PROFILE) {
  origin = internalOrigin(origin);
  const existing = readProfile(file);
  if (existing) {
    if (existing.origin !== origin) throw new Error('已有身份入口地址不同；issuer 变更须单独迁移，不能覆盖');
    return existing;
  }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
  const p = certificates({ version: 1, installationId: randomUUID(), origin, issuer: `${origin}/identity`, clientId: 'mx-launcher-admin',
    clientSecret: randomBytes(32).toString('base64url'), cookieKeys: [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')],
    jwks: { keys: [{ ...privateKey.export({ format: 'jwk' }), kid: randomUUID(), use: 'sig', alg: 'RS256' }] } });
  try { savePrivate(file, p, true); }
  catch (error) { if (error.code === 'EEXIST') return initializeProfile(origin, file); throw error; }
  return p;
}
export function renewProfile(p, file = PROFILE) {
  if (Date.parse(new X509Certificate(p.caCert).validTo) - Date.now() < 370 * 86400000) throw new Error('身份 CA 即将到期；需要安排信任根轮换，不能静默更换 CA');
  if (Date.parse(new X509Certificate(p.tlsCert).validTo) - Date.now() >= 30 * 86400000) return p;
  const renewed = certificates(p); savePrivate(file, renewed); return renewed;
}
export function publicStatus(p) {
  return p ? { configured: true, installationId: p.installationId, origin: p.origin, issuer: p.issuer,
    certificateExpiresAt: new X509Certificate(p.tlsCert).validTo, caFingerprint: new X509Certificate(p.caCert).fingerprint256,
    ...(p.publicEntry ? { publicIdentity:p.publicEntry.origin, publicLauncher:p.publicEntry.adminOrigin, publicHub:p.publicEntry.applications.find(app => app.appId === 'mx-insight-hub').origin } : {}),
    signingKeyId: p.jwks.keys[0].kid } : { configured: false };
}
