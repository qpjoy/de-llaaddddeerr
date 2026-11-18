const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const PIPE = '\\\\.\\pipe\\MinCave.Network.v1';
const PROTOCOL = 1;
const MAX_FRAME = 2 * 1024 * 1024;
const OPERATIONS = new Set(['capabilities', 'wireguard', 'legacy-hdo.cleanup', 'mihomo.start', 'mihomo.stop', 'mihomo.status', 'mihomo.api', 'mihomo.reload']);

function serviceError(code, message) {
  return Object.assign(new Error(message), { code, mincaveServiceError: true });
}

function whoamiSID() {
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
  return new Promise((resolve, reject) => {
    execFile(executable, ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 5000, encoding: 'utf8' }, (error, stdout) => {
      const sid = String(stdout || '').match(/S-1-5-(?:\d+-)*\d+/)?.[0];
      if (error || !sid) reject(serviceError('windows_identity_unavailable', '无法确认当前 Windows 登录身份。'));
      else resolve(sid);
    });
  });
}

// The service identity is installed by the elevated installer under Program
// Files. Ephemeral X25519 + pinned Ed25519 authentication protects keys/YAML
// even if another local process creates a pipe with the same name first.
function createWindowsNetworkService(options = {}) {
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const connect = options.connect || (() => net.createConnection(PIPE));
  const currentSID = options.currentSID || whoamiSID;
  let sidPromise;
  async function request(operation, input) {
    if (!OPERATIONS.has(operation)) throw serviceError('unsupported_network_operation', '不支持此网络操作。');
    let identity;
    try {
      identity = JSON.parse(await fs.readFile(path.join(resourcesPath, 'network-service', 'identity.json'), 'utf8'));
      if (identity.protocol !== PROTOCOL || Buffer.from(identity.publicKey, 'base64').length !== 32) throw new Error('identity');
    } catch {
      throw serviceError('mincave_windows_service_required', '请安装或修复 MinCave Windows 完整安装包，以启用网络服务。');
    }
    const sid = await (sidPromise ||= Promise.resolve().then(currentSID).catch((error) => { sidPromise = null; throw error; }));
    const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
    const nonce = crypto.randomBytes(32).toString('base64');
    const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const hello = { protocol: PROTOCOL, nonce, key };
    return new Promise((resolve, reject) => {
      const socket = connect();
      let buffer = Buffer.alloc(0);
      let sharedKey;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      socket.setTimeout(8000);
      socket.once('timeout', () => finish(serviceError('mincave_windows_service_timeout', 'MinCave 网络服务响应超时。请先确认连接状态，再重试。')));
      socket.once('error', () => finish(serviceError('mincave_windows_service_unavailable', 'MinCave 网络服务未运行。请重启电脑或修复完整安装包。')));
      socket.once('close', () => { if (!settled) finish(serviceError('mincave_windows_service_closed', 'MinCave 网络服务连接中断，请确认网络状态后重试。')); });
      socket.once('connect', () => socket.write(JSON.stringify(hello) + '\n'));
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_FRAME) return finish(serviceError('invalid_service_response', '网络服务响应超出限制。'));
        let end;
        while ((end = buffer.indexOf(10)) >= 0 && !settled) {
          const line = buffer.subarray(0, end);
          buffer = buffer.subarray(end + 1);
          try {
            const response = JSON.parse(line.toString('utf8'));
            if (!sharedKey) {
              if (response.protocol !== PROTOCOL || response.version !== '1.0.0' || response.ownerSID !== sid) throw new Error('incompatible service');
              const transcript = Buffer.from(`mincave-network/v1\n${nonce}\n${key}\n${response.key}\n${response.ownerSID}\n${response.version}`);
              const signingKey = crypto.createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(identity.publicKey, 'base64')]) });
              if (!crypto.verify(null, transcript, signingKey, Buffer.from(response.signature, 'base64'))) throw new Error('untrusted service');
              const peer = crypto.createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(response.key, 'base64')]) });
              sharedKey = crypto.createHash('sha256').update(crypto.diffieHellman({ privateKey, publicKey: peer })).update(Buffer.from(nonce, 'base64')).digest();
              const iv = crypto.randomBytes(12);
              const cipher = crypto.createCipheriv('aes-256-gcm', sharedKey, iv);
              cipher.setAAD(Buffer.from('mincave-request/v1'));
              const data = Buffer.concat([cipher.update(JSON.stringify({ operation, input })), cipher.final(), cipher.getAuthTag()]);
              if (data.length > MAX_FRAME / 4 * 3 - 1024) throw new Error('request too large');
              socket.setTimeout(180000);
              socket.write(JSON.stringify({ nonce: iv.toString('base64'), data: data.toString('base64') }) + '\n');
            } else {
              const data = Buffer.from(response.data, 'base64');
              const decipher = crypto.createDecipheriv('aes-256-gcm', sharedKey, Buffer.from(response.nonce, 'base64'));
              decipher.setAAD(Buffer.from('mincave-response/v1'));
              decipher.setAuthTag(data.subarray(-16));
              const result = JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]).toString('utf8'));
              if (result.ok !== true) finish(serviceError(result.code || 'network_service_error', result.message || 'MinCave 网络操作失败。'));
              else finish(null, result.value);
            }
          } catch {
            finish(serviceError('mincave_windows_service_untrusted', 'MinCave 网络服务身份或版本校验失败，请修复完整安装包。'));
          }
        }
      });
    });
  }
  async function ensureAvailable() {
    const status = await request('capabilities');
    if (status?.protocol !== PROTOCOL || !status?.capabilities?.includes('wireguard')) throw serviceError('incompatible_service', '网络服务版本不兼容，请升级完整安装包。');
    return status;
  }
  return Object.freeze({
    ensureAvailable,
    cleanLegacyHdo: async () => {
      const status = await ensureAvailable();
      if (!status.capabilities.includes('legacy-hdo-cleanup')) {
        throw serviceError('legacy_hdo_cleanup_unavailable', '请升级 MinCave Windows 完整安装包以使用旧 HDO 清理。');
      }
      return request('legacy-hdo.cleanup');
    },
    tunnel: (input) => request('wireguard', input),
    mihomo: Object.freeze({
      start: (config) => request('mihomo.start', { config }),
      stop: () => request('mihomo.stop'),
      status: () => request('mihomo.status'),
      reload: (config) => request('mihomo.reload', { config }),
      api: (input) => request('mihomo.api', input),
    }),
  });
}

module.exports = { createWindowsNetworkService };
