// Bundled separately into protected installation resources. This file is never
// loaded from app.asar, a downloaded ASAR, userData, or a client-supplied path.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const YAML = require('yaml');
const core = require('@qpjoy/electron-core-wireguard');
const exec = promisify(execFile);
const MAX_CONFIG = 1024 * 1024;
const PROFILE_NAME = 'mx-h2i';
// Match the launcher's existing corporate address pools and split-DNS
// defaults. This fixed service policy still refuses unrelated private/public
// networks, default routes and public DNS suffixes.
const OFFICE_DNS_DOMAINS = ['mx.cn', 'mxinfo-inc.cn', 'internal.mx', 'corp.mx', 'h2i.mx'];

function refusal(message, code = 'invalid_network_request') { return Object.assign(new Error(message), { code, safeServiceMessage: true }); }
function list(value) { return String(value).split(',').map(v => v.trim()).filter(Boolean); }
function officeIP(value) {
  if (net.isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return (a === 10 && b >= 88 && b <= 90) || (a === 100 && b >= 88 && b <= 91);
}
function officeCIDR(value) {
  const [ip, prefix, extra] = value.split('/');
  return !extra && officeIP(ip) && /^\d+$/.test(prefix || '') && +prefix >= 16 && +prefix <= 32;
}
function keyValue(value) { return /^[A-Za-z0-9+/]{43}=$/.test(value); }
function domains(value) {
  const result = list(value).map(v => v.replace(/^\./, '').toLowerCase());
  if (result.length > 100 || result.some(v =>
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9-]+\.[a-z]{2,63}$/.test(v)
    || !OFFICE_DNS_DOMAINS.some(domain => v === domain || v.endsWith('.' + domain))
  )) throw refusal('无效的企业 DNS 域名。');
  return result;
}

function validateWireGuardConfig(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 || /\0/.test(text)) throw refusal('无效的网络配置。');
  const rows = [];
  let section = '';
  let interfaceSeen = false;
  let peerCount = 0;
  let fields = new Set();
  let privateKey;
  let address;
  let peerReady = true;
  for (const original of text.split(/\r?\n/)) {
    const line = original.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const match = /^# HDO (DNS Servers|DNS Domains|Route Priority CIDRs) = (.+)$/.exec(line);
      if (!match) continue;
      const values = match[1] === 'DNS Domains' ? domains(match[2]) : list(match[2]);
      if (!values.length || values.length > 128 || (match[1] === 'DNS Servers' && values.some(v => !officeIP(v))) || (match[1] === 'Route Priority CIDRs' && values.some(v => !officeCIDR(v)))) throw refusal('企业 DNS 或路由超出允许范围。');
      rows.push(`# HDO ${match[1]} = ${values.join(', ')}`);
      continue;
    }
    if (line === '[Interface]' || line === '[Peer]') {
      if (!peerReady) throw refusal('WireGuard peer 配置不完整。');
      if (line === '[Interface]') {
        if (interfaceSeen || peerCount) throw refusal('只允许一个 MinCave 网络接口。');
        interfaceSeen = true;
      } else {
        if (!privateKey || !address || ++peerCount > 16) throw refusal('无效的 WireGuard peer。');
        peerReady = false;
      }
      section = line;
      fields = new Set();
      rows.push(line);
      continue;
    }
    const entry = /^([A-Za-z]+)\s*=\s*(.+)$/.exec(line);
    if (!entry || !section || fields.has(entry[1])) throw refusal('网络配置包含不支持的指令。');
    const [, name, value] = entry;
    fields.add(name);
    let valid = false;
    if (section === '[Interface]') {
      if (name === 'PrivateKey') { valid = keyValue(value); privateKey = value; }
      if (name === 'Address') { valid = list(value).length === 1 && officeCIDR(value) && value.endsWith('/32'); address = value; }
      if (name === 'DNS') valid = list(value).length <= 4 && list(value).every(officeIP);
      if (name === 'MTU') valid = /^\d+$/.test(value) && +value >= 576 && +value <= 9000;
      if (name === 'ListenPort') valid = /^\d+$/.test(value) && +value >= 1024 && +value <= 65535;
    } else {
      if (name === 'PublicKey' || name === 'PresharedKey') valid = keyValue(value);
      if (name === 'AllowedIPs') valid = list(value).length > 0 && list(value).length <= 256 && list(value).every(officeCIDR);
      if (name === 'PersistentKeepalive') valid = /^\d+$/.test(value) && +value >= 0 && +value <= 65535;
      if (name === 'Endpoint') {
        const endpoint = /^([a-zA-Z0-9.-]+):(\d+)$/.exec(value);
        valid = Boolean(endpoint && endpoint[1].length <= 253 && +endpoint[2] > 0 && +endpoint[2] <= 65535 && !endpoint[1].includes('..'));
      }
      peerReady = fields.has('PublicKey') && fields.has('AllowedIPs') && fields.has('Endpoint');
    }
    if (!valid) throw refusal('网络配置字段超出允许范围。');
    rows.push(`${name} = ${value}`);
  }
  if (!privateKey || !address || !peerCount || !peerReady) throw refusal('网络配置不完整。');
  return rows.join('\n') + '\n';
}

function safeMihomoConfig(text, directory, controllerSecret) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_CONFIG) throw refusal('代理配置超出大小限制。');
  let raw;
  try { raw = YAML.parse(text, { maxAliasCount: 50 }); } catch { throw refusal('无效的代理配置。'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw refusal('无效的代理配置。');
  // Reconstruct the document: subscription-supplied file paths, executable
  // hooks, Unix sockets, external UI downloads and arbitrary listeners never
  // reach a SYSTEM process.
  const allowed = ['proxies', 'proxy-groups', 'rules', 'dns', 'tun', 'mixed-port', 'mode', 'log-level', 'external-controller', 'secret', 'ipv6', 'profile', 'proxy-providers', 'rule-providers'];
  const config = Object.fromEntries(allowed.filter(k => k in raw).map(k => [k, raw[k]]));
  const ancestors = new Set();
  function check(value, key = '', depth = 0) {
    if (depth > 24 || (value && typeof value === 'object' && ancestors.has(value))) throw refusal('代理配置嵌套过深或含循环引用。');
    if (value && typeof value === 'object') ancestors.add(value);
    if (typeof value === 'string') {
      if (value.length > 262144 || value.includes('\0')) throw refusal('代理配置字段超出限制。');
      if (/^(certificate|ca|client-cert)$/.test(key) && !value.includes('-----BEGIN CERTIFICATE-----')) throw refusal('特权代理仅支持内嵌证书。');
      if (/^(private-key|public-key|client-key)$/.test(key) && !keyValue(value) && !value.includes('-----BEGIN ')) throw refusal('特权代理不读取外部密钥文件。');
      if (key === 'url') {
        let url;
        try { url = new URL(value); } catch { throw refusal('无效的代理下载地址。'); }
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw refusal('不支持此代理下载地址。');
      }
      if (key === 'type' && value === 'ssh') throw refusal('特权代理不支持 SSH 文件凭据。');
    } else if (Array.isArray(value)) {
      if (value.length > 20000) throw refusal('代理配置条目过多。');
      value.forEach(v => check(v, key, depth + 1));
    } else if (value && typeof value === 'object') {
      for (const [name, child] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype'].includes(name)) throw refusal('代理配置包含不支持的对象字段。');
        if (/(?:^|[-_])(path|file|dir)(?:$|[-_])|script|external-ui|^listeners$|^hosts$|^authentication$/i.test(name)) throw refusal('特权代理不接受文件路径或执行指令。');
        check(child, name, depth + 1);
      }
    }
    if (value && typeof value === 'object') ancestors.delete(value);
  }
  for (const kind of ['proxy-providers', 'rule-providers']) {
    if (!config[kind]) continue;
    if (typeof config[kind] !== 'object' || Array.isArray(config[kind])) throw refusal('无效的代理资源。');
    config[kind] = Object.fromEntries(Object.entries(config[kind]).map(([name, value]) => {
      if (!value || typeof value !== 'object' || value.type !== 'http' || typeof value.url !== 'string') throw refusal('特权代理仅支持 HTTP 资源。');
      const provider = Object.fromEntries(['type', 'url', 'interval', 'behavior', 'format', 'health-check', 'override'].filter(k => k in value).map(k => [k, value[k]]));
      check(provider);
      provider.path = path.join(directory, 'providers', `${kind}-${crypto.createHash('sha256').update(name).digest('hex')}.yaml`);
      return [name, provider];
    }));
  }
  const providers = { 'proxy-providers': config['proxy-providers'], 'rule-providers': config['rule-providers'] };
  delete config['proxy-providers']; delete config['rule-providers'];
  // tun/dns are rebuilt below; no file/provider directives from them survive.
  const incomingTun = config.tun || {};
  const incomingDns = config.dns || {};
  delete config.tun; delete config.dns;
  check(config);
  const controller = /^127\.0\.0\.1:(\d+)$/.exec(String(config['external-controller'] || ''));
  const mixed = config['mixed-port'];
  const dnsListen = /:(\d+)$/.exec(String(incomingDns.listen || ''));
  if (!controller || +controller[1] < 1024 || +controller[1] > 65535 || !Number.isInteger(mixed) || mixed < 1024 || mixed > 65535 || !dnsListen || +dnsListen[1] < 1024 || +dnsListen[1] > 65535 || new Set([+controller[1], mixed, +dnsListen[1]]).size !== 3) throw refusal('无效的代理监听端口。');
  const dns = Object.fromEntries(['enable', 'enhanced-mode', 'fake-ip-range', 'fake-ip-filter', 'default-nameserver', 'nameserver', 'nameserver-policy', 'direct-nameserver', 'proxy-server-nameserver', 'respect-rules', 'use-hosts'].filter(k => k in incomingDns).map(k => [k, incomingDns[k]]));
  check(dns);
  if (!['system', 'mixed', 'gvisor'].includes(incomingTun.stack)) throw refusal('不支持此 TUN 协议栈。');
  Object.assign(config, {
    ...providers,
    'allow-lan': false, 'bind-address': '127.0.0.1', ipv6: false,
    mode: 'rule', 'log-level': 'info', secret: controllerSecret,
    profile: { 'store-selected': true, 'store-fake-ip': false },
    dns: { ...dns, enable: true, listen: `127.0.0.1:${dnsListen[1]}`, ipv6: false },
    tun: { enable: true, device: 'MinCave-TUN', stack: incomingTun.stack, 'auto-route': true, 'auto-detect-interface': true, 'strict-route': incomingTun['strict-route'] === true, 'dns-hijack': ['any:53', 'tcp://any:53'] },
  });
  return { yaml: YAML.stringify(config), controller: +controller[1] };
}

async function readState(directory) {
  try { return JSON.parse(await fs.readFile(path.join(directory, 'state.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw refusal('网络服务状态损坏，请修复安装。', 'service_state_invalid'); }
}
async function writeState(directory, state) {
  const target = path.join(directory, 'state.json');
  await fs.writeFile(target + '.new', JSON.stringify(state), { mode: 0o600 });
  await fs.rename(target + '.new', target);
}
function assertOwner(state, sid) {
  if (state.ownerSID && state.ownerSID !== sid) throw refusal('另一 Windows 账号正在使用 MinCave 网络，请先在该账号中断开连接。', 'network_owner_conflict');
}
function systemPowerShell() { return path.win32.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); }
async function powershell(script) {
  return exec(systemPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
}
async function serviceConfigPath() {
  const { stdout } = await powershell("$ErrorActionPreference='Stop'; $s=Get-CimInstance Win32_Service -Filter 'Name=\"WireGuardTunnel$mx-h2i\"'; if($s){[Console]::Out.Write($s.PathName)}");
  const match = /\/tunnelservice\s+(?:"([^"]+)"|(.+))\s*$/i.exec(stdout.trim());
  return match ? match[1] || match[2] : null;
}
async function attestLegacyTunnel(config, sid) {
  const existing = await serviceConfigPath();
  if (!existing) return null;
  const safePath = existing.replaceAll("'", "''");
  const { stdout } = await powershell(`$o=(Get-Acl -LiteralPath '${safePath}' -ErrorAction Stop).Owner; [Console]::Out.Write(([System.Security.Principal.NTAccount]$o).Translate([System.Security.Principal.SecurityIdentifier]).Value)`);
  if (stdout.trim() !== sid) throw refusal('现有隧道属于其他 Windows 账号，请先在该账号中断开旧客户端。', 'legacy_owner_conflict');
  const previous = await fs.readFile(existing, 'utf8');
  const oldKey = /^PrivateKey\s*=\s*(\S+)\s*$/m.exec(previous)?.[1];
  const newKey = /^PrivateKey\s*=\s*(\S+)\s*$/m.exec(config || '')?.[1];
  if (!oldKey || !newKey || oldKey !== newKey) throw refusal('现有隧道尚未安全移交，请先在旧客户端中断开。', 'legacy_handoff_required');
  return existing;
}

async function aliveMihomo(state, root) {
  if (!Number.isInteger(state.mihomo?.pid) || !state.mihomo?.startedAt) return false;
  const { stdout } = await powershell(`$p=Get-Process -Id ${state.mihomo.pid} -ErrorAction SilentlyContinue; if($p){[Console]::Out.Write(($p.Path+'|'+$p.StartTime.ToUniversalTime().Ticks))}`);
  return stdout.trim().toLowerCase() === `${path.join(root, 'resources', 'network-service', 'mihomo.exe')}|${state.mihomo.startedAt}`.toLowerCase();
}
async function assertControllerOwner(state, root) {
  if (!await aliveMihomo(state, root)) throw refusal('MinCave TUN 尚未启动。', 'tun_not_running');
  const port = state.mihomo.controller;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw refusal('无效的代理端口。');
  const { stdout } = await powershell(`$p=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue); [Console]::Out.Write(($p | Select-Object -ExpandProperty OwningProcess -Unique) -join ',')`);
  if (stdout.trim() !== String(state.mihomo.pid)) throw refusal('代理控制端口尚未就绪。', 'tun_controller_unavailable');
}
function validateAPI(input) {
  const method = input?.method || 'GET';
  let endpoint = input?.path;
  if (method === 'GET' && ['/version', '/proxies', '/connections'].includes(endpoint)) return { method, endpoint };
  if (method === 'PUT' && /^\/proxies\/[^/?#]{1,512}$/.test(endpoint || '') && typeof input?.body?.name === 'string' && input.body.name.length <= 256) {
    let group; try { group = decodeURIComponent(endpoint.slice('/proxies/'.length)); } catch { throw refusal('无效的代理分组。'); }
    if (!group || group === '.' || group === '..' || /[\/\\\0?#]/.test(group)) throw refusal('无效的代理分组。');
    endpoint = '/proxies/' + encodeURIComponent(group);
    return { method, endpoint };
  }
  throw refusal('不支持此代理控制操作。');
}
async function boundedJSON(response) {
  const chunks = []; let length = 0;
  for await (const chunk of response.body || []) {
    length += chunk.length;
    if (length > MAX_CONFIG) throw refusal('代理响应超出大小限制。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}
async function mihomoAPI(state, root, input) {
  const { method, endpoint } = validateAPI(input);
  await assertControllerOwner(state, root);
  const response = await fetch(`http://127.0.0.1:${state.mihomo.controller}${endpoint}`, {
    method, redirect: 'error', headers: { Authorization: `Bearer ${state.mihomo.secret}`, 'Content-Type': 'application/json' },
    ...(method === 'PUT' ? { body: JSON.stringify({ name: input.body.name }) } : {}), signal: AbortSignal.timeout(5000),
  });
  return { ok: response.ok, status: response.status, data: await boundedJSON(response) };
}

async function execute(request) {
  const { root, stateDir, ownerSID, operation, input } = request;
  if (process.platform !== 'win32' || typeof root !== 'string' || typeof stateDir !== 'string' || !/^(SYSTEM|S-1-5-(?:\d+-)*\d+)$/.test(ownerSID || '')) throw refusal('无效的网络服务上下文。');
  const state = await readState(stateDir);
  if (operation !== 'uninstall') assertOwner(state, ownerSID);
  const profileDir = path.join(stateDir, 'wireguard');
  const profile = path.join(profileDir, PROFILE_NAME + '.conf');
  const runtime = () => core.resolveWireGuardConnectionRuntime({ installDir: path.join(root, 'resources', 'wireguard', 'win32-x64'), bundledDir: path.join(root, 'resources', 'wireguard', 'win32-x64'), allowSystemFallback: false });
  const stopMihomo = async () => {
    if (await aliveMihomo(state, root)) await exec(path.win32.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(state.mihomo.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
    delete state.mihomo;
  };
  if (operation === 'wireguard') {
    if (!['up', 'down', 'restart', 'repair'].includes(input?.action)) throw refusal('不支持此隧道操作。');
    const config = input.config == null ? null : validateWireGuardConfig(input.config);
    if (!state.ownerSID) {
      const previous = await attestLegacyTunnel(config, ownerSID);
      if (previous) state.legacyPath = previous;
      state.ownerSID = ownerSID;
      await writeState(stateDir, state);
    }
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
    if (config && (input.action !== 'down' || state.legacyPath)) {
      await fs.writeFile(profile + '.new', config, { mode: 0o600 });
      await fs.rename(profile + '.new', profile);
    }
    if (state.legacyPath) {
      // Only the owner key comes from the attested SCM path. Configuration,
      // scripts and executable paths always remain in protected directories.
      const cleanup = await core.setWireGuardTunnelState({ runtime: runtime(), configPath: profile, action: 'down', windowsServiceExecution: true, windowsEndpointBypassOwnerPath: state.legacyPath });
      if (!cleanup.ok) throw refusal('旧隧道清理未完成，请重试或先在旧客户端中断开。', 'legacy_cleanup_failed');
      delete state.legacyPath;
      await writeState(stateDir, state);
    }
    let result;
    if (input.action === 'repair') result = await core.repairWireGuardTunnelRoutes({ runtime: runtime(), configPath: profile, windowsServiceExecution: true });
    else result = await core.setWireGuardTunnelState({ runtime: runtime(), configPath: profile, action: input.action, windowsServiceExecution: true });
    if (result.ok && input.action === 'down') {
      await fs.rm(profile, { force: true });
      if (!state.mihomo) delete state.ownerSID;
      await writeState(stateDir, state);
    }
    return { ok: result.ok === true, message: result.ok ? result.message : 'MinCave 隧道操作失败，请检查网络服务。' };
  }
  if (operation === 'mihomo.status') return { running: await aliveMihomo(state, root), pid: state.mihomo?.pid || null };
  if (operation === 'mihomo.api') return mihomoAPI(state, root, input);
  if (operation === 'mihomo.stop' || operation === 'uninstall') {
    await stopMihomo();
    if (operation === 'uninstall') {
      if (await fs.stat(profile).catch(() => null)) {
        const result = await core.setWireGuardTunnelState({ runtime: runtime(), configPath: profile, action: 'down', windowsServiceExecution: true, windowsEndpointBypassOwnerPath: state.legacyPath });
        if (!result.ok) throw refusal('隧道清理未完成，已停止卸载。', 'cleanup_incomplete');
        await fs.rm(profile, { force: true });
      }
      delete state.ownerSID; delete state.legacyPath;
    } else if (!await fs.stat(profile).catch(() => null)) delete state.ownerSID;
    await writeState(stateDir, state);
    return { running: false };
  }
  if (operation === 'mihomo.start' || operation === 'mihomo.reload') {
    const directory = path.join(stateDir, 'mihomo');
    const secret = state.mihomo?.secret || crypto.randomBytes(32).toString('hex');
    const config = safeMihomoConfig(input?.config, directory, secret);
    await fs.mkdir(path.join(directory, 'providers'), { recursive: true, mode: 0o700 });
    const isRunning = await aliveMihomo(state, root);
    if (operation === 'mihomo.reload' && !isRunning) throw refusal('TUN 尚未启动，请重新连接。', 'tun_not_running');
    if (isRunning && state.mihomo.controller !== config.controller) throw refusal('代理端口已改变，请先停止 TUN 再重试。');
    if (isRunning && operation === 'mihomo.start') return { running: true, pid: state.mihomo.pid };
    const configPath = path.join(directory, 'config.yaml');
    await fs.writeFile(configPath + '.new', config.yaml, { mode: 0o600 });
    await fs.rename(configPath + '.new', configPath);
    if (operation === 'mihomo.reload') {
      await assertControllerOwner(state, root);
      const response = await fetch(`http://127.0.0.1:${config.controller}/configs?force=true`, { method: 'PUT', redirect: 'error', headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ path: configPath }), signal: AbortSignal.timeout(10000) });
      return { ok: response.ok, status: response.status, data: null };
    }
    if (await aliveMihomo(state, root)) return { running: true, pid: state.mihomo.pid };
    state.ownerSID = ownerSID;
    await writeState(stateDir, state);
    const log = await fs.open(path.join(directory, 'mihomo.log'), 'a', 0o600);
    const child = spawn(path.join(root, 'resources', 'network-service', 'mihomo.exe'), ['-d', directory, '-f', configPath], { detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd], cwd: directory, env: process.env });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    await log.close();
    const { stdout } = await powershell(`$p=Get-Process -Id ${child.pid} -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)`);
    state.mihomo = { pid: child.pid, startedAt: stdout.trim(), secret, controller: config.controller };
    await writeState(stateDir, state);
    // The enclosing native job kills every child if startup or persistence fails.
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await assertControllerOwner(state, root); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    if (!ready) throw refusal('TUN 启动失败，请检查代理配置后重试。', 'tun_start_failed');
    return { running: true, pid: child.pid };
  }
  throw refusal('不支持此网络操作。');
}

if (require.main === module) {
  (async () => {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_CONFIG + 65536) throw refusal('请求超出大小限制。');
    }
    const value = await execute(JSON.parse(raw));
    process.stdout.write(JSON.stringify({ ok: true, value }));
  })().catch(error => {
    process.stdout.write(JSON.stringify({ ok: false, code: error.safeServiceMessage ? error.code : 'network_operation_failed', message: error.safeServiceMessage ? error.message : 'MinCave 网络服务操作失败，请检查安装或网络状态。' }));
  });
}

module.exports = { validateWireGuardConfig, safeMihomoConfig, assertOwner, officeCIDR, validateAPI };
