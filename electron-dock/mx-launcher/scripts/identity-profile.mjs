import { generateKeyPairSync, randomBytes, randomUUID, X509Certificate, createPrivateKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, linkSync, unlinkSync, lstatSync, mkdtempSync, rmSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';

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
export function readProfile(file = PROFILE) {
  if (!existsSync(file)) return null;
  const st = lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) || st.uid !== process.getuid()) throw new Error('身份配置须为当前用户拥有的私有文件（600）');
  let p;
  try { p = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error('身份档案 JSON 损坏；请恢复备份（不输出文件内容）'); }
  if (p.version !== 1 || p.origin !== internalOrigin(p.origin) || p.issuer !== `${p.origin}/identity` || !p.installationId
    || p.clientId !== 'mx-launcher-admin' || !/^[A-Za-z0-9_-]{43}$/.test(p.clientSecret) || !Array.isArray(p.cookieKeys)
    || p.cookieKeys.length !== 2 || p.cookieKeys.some(key => !/^[A-Za-z0-9_-]{43}$/.test(key)) || p.jwks?.keys?.length !== 1) throw new Error('身份配置不完整；请从备份恢复，不能自动重建密钥');
  createPrivateKey({ key: p.jwks.keys[0], format: 'jwk' });
  const ca = new X509Certificate(p.caCert); const leaf = new X509Certificate(p.tlsCert);
  if (!ca.ca || !leaf.verify(ca.publicKey) || !leaf.checkIP(new URL(p.origin).hostname) || !leaf.checkPrivateKey(createPrivateKey(p.tlsKey))
    || !ca.checkPrivateKey(createPrivateKey(p.caKey))) throw new Error('身份 TLS 证书/密钥不匹配');
  return p;
}
function certificates(p) {
  const dir = mkdtempSync(join(tmpdir(), 'mx-identity-cert-'));
  const run = args => { const r = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8', timeout: 30000 }); if (r.error || r.status) throw new Error('生成身份入口证书失败；需要 openssl，未输出私钥'); };
  try {
    if (p.caKey) {
      writeFileSync(join(dir, 'ca.key'), p.caKey, { mode: 0o600 }); writeFileSync(join(dir, 'ca.crt'), p.caCert);
    } else {
      run(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '3650', '-subj', '/CN=MX Internal Identity CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', 'ca.key', '-out', 'ca.crt']);
    }
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=MX Internal Identity', '-keyout', 'tls.key', '-out', 'tls.csr']);
    writeFileSync(join(dir, 'tls.ext'), `subjectAltName=IP:${new URL(p.origin).hostname}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    run(['x509', '-req', '-in', 'tls.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-days', '365', '-sha256', '-extfile', 'tls.ext', '-out', 'tls.crt']);
    return { ...p, caKey: readFileSync(join(dir, 'ca.key'), 'utf8'), caCert: readFileSync(join(dir, 'ca.crt'), 'utf8'), tlsKey: readFileSync(join(dir, 'tls.key'), 'utf8'), tlsCert: readFileSync(join(dir, 'tls.crt'), 'utf8') };
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
    signingKeyId: p.jwks.keys[0].kid } : { configured: false };
}
