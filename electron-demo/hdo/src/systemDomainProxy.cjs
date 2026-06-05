const { execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const STATE_VERSION = 2;
const WINDOWS_PROXY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function createSystemDomainProxyManager(options = {}) {
  const statePath = options.statePath || path.join(options.userDataDir, 'hdo-system-domain-proxy.json');
  const log = options.log || console;
  let localPacServer = null;
  let localPacPort = null;
  let localPacKey = null;

  return {
    async apply(domainProxy) {
      if (!isSupportedPlatform()) return unsupportedStatus();
      const existing = readState(statePath);
      const previous = existing && existing.applied === true && existing.platform === process.platform
        ? existing.previous
        : await capturePlatformState();
      const pac = await resolvePacSource(domainProxy, previous);
      if (!pac) {
        await closeLocalPacServer();
        return this.disable('domain-proxy-disabled');
      }

      await applyPlatformPac(pac.pacUrl, previous);
      if (pac.usesLocalPac !== true) await closeLocalPacServer();
      const next = {
        version: STATE_VERSION,
        applied: true,
        platform: process.platform,
        pacUrl: pac.pacUrl,
        proxy: pac.proxy || null,
        domains: pac.domains,
        previous,
        updatedAt: new Date().toISOString()
      };
      writeState(statePath, next);
      return publicState(next, { changed: !existing || existing.pacUrl !== pac.pacUrl });
    },

    async disable(reason = 'manual') {
      if (!isSupportedPlatform()) return unsupportedStatus({ reason });
      const existing = readState(statePath);
      if (!existing || existing.applied !== true || existing.platform !== process.platform) {
        await closeLocalPacServer();
        return {
          supported: true,
          applied: false,
          platform: process.platform,
          reason,
          skipped: true
        };
      }

      await restorePlatformState(existing.previous);
      await closeLocalPacServer();
      removeState(statePath, log);
      return {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        restored: true
      };
    },

    async restoreStale(reason = 'startup') {
      if (!isSupportedPlatform()) return unsupportedStatus({ reason });
      const existing = readState(statePath);
      if (existing && existing.applied === true && existing.platform === process.platform) {
        await restorePlatformState(existing.previous);
        await closeLocalPacServer();
        removeState(statePath, log);
        return {
          supported: true,
          applied: false,
          platform: process.platform,
          reason,
          restored: true,
          staleState: true
        };
      }
      if (process.platform === 'win32') {
        const stale = await clearStaleWindowsHdoPac();
        if (stale.restored) {
          return {
            supported: true,
            applied: false,
            platform: process.platform,
            reason,
            ...stale
          };
        }
      }
      await closeLocalPacServer();
      return {
        supported: true,
        applied: false,
        platform: process.platform,
        reason,
        skipped: true
      };
    },

    status() {
      if (!isSupportedPlatform()) return unsupportedStatus();
      const state = readState(statePath);
      if (!state || state.applied !== true || state.platform !== process.platform) {
        return {
          supported: true,
          applied: false,
          platform: process.platform
        };
      }
      return publicState(state);
    },

    async statusVerified() {
      if (!isSupportedPlatform()) return unsupportedStatus();
      const state = readState(statePath);
      if (!state || state.applied !== true || state.platform !== process.platform) {
        return {
          supported: true,
          applied: false,
          verified: true,
          platform: process.platform
        };
      }
      try {
        const verification = await verifyPlatformPac(state.pacUrl, state.previous);
        return publicState(state, {
          applied: verification.applied,
          verified: true,
          actual: verification
        });
      } catch (err) {
        return publicState(state, {
          applied: false,
          verified: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }
  };

  async function resolvePacSource(domainProxy, previous) {
    if (!domainProxy || domainProxy.enabled !== true) return null;
    const domains = stringArray(domainProxy.domains);
    const pacUrl = stringValue(domainProxy.pacUrl);
    if (pacUrl) {
      return { pacUrl, domains, proxy: stringValue(domainProxy.proxy), usesLocalPac: false };
    }
    const proxy = normalizeProxyAddress(domainProxy.proxy);
    if (!proxy || domains.length === 0) return null;
    return {
      pacUrl: await ensureLocalPacServer(proxy, domains, previous),
      domains,
      proxy,
      usesLocalPac: true
    };
  }

  async function ensureLocalPacServer(proxy, domains, previous) {
    const fallbackProxy = fallbackProxyForPac(previous);
    const key = JSON.stringify({ proxy, domains, fallbackProxy });
    if (localPacServer && localPacPort && localPacKey === key) {
      return `http://127.0.0.1:${localPacPort}/proxy.pac`;
    }

    await closeLocalPacServer();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/proxy.pac') {
        res.writeHead(404, {
          'Content-Length': '0',
          'Connection': 'close'
        });
        res.end();
        return;
      }
      const body = req.method === 'HEAD' ? '' : renderPacScript(proxy, domains, fallbackProxy);
      res.writeHead(200, {
        'Content-Type': 'application/x-ns-proxy-autoconfig; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        'Connection': 'close'
      });
      res.end(body);
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('failed to allocate HDO system PAC port'));
          return;
        }
        localPacServer = server;
        localPacPort = address.port;
        localPacKey = key;
        resolve();
      });
    });
    return `http://127.0.0.1:${localPacPort}/proxy.pac`;
  }

  async function closeLocalPacServer() {
    const server = localPacServer;
    localPacServer = null;
    localPacPort = null;
    localPacKey = null;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

function isSupportedPlatform() {
  return process.platform === 'darwin' || process.platform === 'win32';
}

function unsupportedStatus(extra = {}) {
  return {
    supported: false,
    applied: false,
    platform: process.platform,
    reason: process.platform === 'linux'
      ? 'linux-system-pac-not-implemented'
      : 'unsupported-platform',
    ...extra
  };
}

async function capturePlatformState() {
  if (process.platform === 'darwin') return captureDarwinState();
  if (process.platform === 'win32') return captureWindowsState();
  return null;
}

async function applyPlatformPac(pacUrl, previous) {
  if (process.platform === 'darwin') {
    await applyDarwinPac(pacUrl, previous);
    return;
  }
  if (process.platform === 'win32') {
    await applyWindowsPac(pacUrl);
  }
}

async function restorePlatformState(previous) {
  if (process.platform === 'darwin') {
    await restoreDarwinState(previous);
    return;
  }
  if (process.platform === 'win32') {
    await restoreWindowsState(previous);
  }
}

async function verifyPlatformPac(pacUrl, previous) {
  if (process.platform === 'darwin') return verifyDarwinPac(pacUrl, previous);
  if (process.platform === 'win32') return verifyWindowsPac(pacUrl);
  return { applied: false, platform: process.platform };
}

async function captureDarwinState() {
  const services = await listDarwinNetworkServices();
  const out = [];
  for (const name of services) {
    try {
      const result = await execFileText('/usr/sbin/networksetup', ['-getautoproxyurl', name]);
      out.push({
        name,
        ...parseDarwinAutoProxy(result.stdout)
      });
    } catch {
      // Ignore transient services that disappear while applying network settings.
    }
  }
  return { services: out };
}

async function applyDarwinPac(pacUrl, previous) {
  let services = darwinServiceNames(previous);
  if (services.length === 0) services = await listDarwinNetworkServices();
  if (services.length === 0) throw new Error('macOS network services not found');
  const commands = [];
  for (const name of services) {
    commands.push(['-setautoproxyurl', name, pacUrl]);
    commands.push(['-setautoproxystate', name, 'on']);
  }
  await runDarwinNetworksetupSetBatch(commands);
}

async function verifyDarwinPac(pacUrl, previous) {
  let services = darwinServiceNames(previous);
  if (services.length === 0) services = await listDarwinNetworkServices();
  const rows = [];
  for (const name of services) {
    try {
      const result = await execFileText('/usr/sbin/networksetup', ['-getautoproxyurl', name]);
      const parsed = parseDarwinAutoProxy(result.stdout);
      rows.push({
        name,
        url: parsed.url,
        enabled: parsed.enabled,
        applied: parsed.enabled === true && parsed.url === pacUrl
      });
    } catch (err) {
      rows.push({
        name,
        applied: false,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return {
    applied: rows.length > 0 && rows.every((row) => row.applied === true),
    platform: process.platform,
    pacUrl,
    services: rows
  };
}

async function restoreDarwinState(previous) {
  const services = Array.isArray(previous && previous.services) ? previous.services : [];
  const commands = [];
  for (const service of services) {
    if (!service || !service.name) continue;
    if (service.url) {
      commands.push(['-setautoproxyurl', service.name, service.url]);
    }
    commands.push([
      '-setautoproxystate',
      service.name,
      service.enabled === true ? 'on' : 'off'
    ]);
  }
  await runDarwinNetworksetupSetBatch(commands);
}

async function listDarwinNetworkServices() {
  const result = await execFileText('/usr/sbin/networksetup', ['-listallnetworkservices']);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('An asterisk') && !line.startsWith('*'));
}

function parseDarwinAutoProxy(stdout) {
  const urlMatch = stdout.match(/^URL:\s*(.*)$/im);
  const enabledMatch = stdout.match(/^Enabled:\s*(.*)$/im);
  const url = stringValue(urlMatch && urlMatch[1]);
  return {
    url: url && url !== '(null)' ? url : null,
    enabled: /^yes$/i.test(String((enabledMatch && enabledMatch[1]) || '').trim())
  };
}

function darwinServiceNames(previous) {
  const services = Array.isArray(previous && previous.services) ? previous.services : [];
  return services.map((service) => service && service.name).filter(Boolean);
}

async function runDarwinNetworksetupSetBatch(commands) {
  if (commands.length === 0) return;
  try {
    for (const args of commands) {
      await execFileText('/usr/sbin/networksetup', args);
    }
  } catch {
    const command = [
      'set -e',
      ...commands.map((args) => ['/usr/sbin/networksetup', ...args].map(shellQuote).join(' '))
    ].join('\n');
    await execFileText('/usr/bin/osascript', [
      '-e',
      `do shell script ${JSON.stringify(command)} with administrator privileges`
    ]);
  }
}

async function captureWindowsState() {
  return {
    autoConfigUrl: await queryWindowsRegistryValue('AutoConfigURL'),
    proxyEnable: await queryWindowsRegistryValue('ProxyEnable'),
    proxyServer: await queryWindowsRegistryValue('ProxyServer'),
    proxyOverride: await queryWindowsRegistryValue('ProxyOverride'),
    autoDetect: await queryWindowsRegistryValue('AutoDetect')
  };
}

async function applyWindowsPac(pacUrl) {
  await addWindowsRegistryValue('AutoConfigURL', 'REG_SZ', pacUrl);
  await addWindowsRegistryValue('ProxyEnable', 'REG_DWORD', '0');
  await notifyWindowsProxyChanged();
}

async function verifyWindowsPac(pacUrl) {
  const autoConfigUrl = await queryWindowsRegistryValue('AutoConfigURL');
  return {
    applied: Boolean(autoConfigUrl && autoConfigUrl.exists && autoConfigUrl.value === pacUrl),
    platform: process.platform,
    pacUrl,
    autoConfigUrl
  };
}

async function restoreWindowsState(previous) {
  const autoConfigUrl = previous && previous.autoConfigUrl;
  const proxyEnable = previous && previous.proxyEnable;
  const proxyServer = previous && previous.proxyServer;
  const proxyOverride = previous && previous.proxyOverride;
  const autoDetect = previous && previous.autoDetect;

  if (autoConfigUrl && autoConfigUrl.exists) {
    await addWindowsRegistryValue('AutoConfigURL', autoConfigUrl.type || 'REG_SZ', autoConfigUrl.value || '');
  } else {
    await deleteWindowsRegistryValue('AutoConfigURL');
  }

  if (proxyServer && proxyServer.exists) {
    await addWindowsRegistryValue('ProxyServer', proxyServer.type || 'REG_SZ', proxyServer.value || '');
  } else {
    await deleteWindowsRegistryValue('ProxyServer');
  }

  if (proxyOverride && proxyOverride.exists) {
    await addWindowsRegistryValue('ProxyOverride', proxyOverride.type || 'REG_SZ', proxyOverride.value || '');
  } else {
    await deleteWindowsRegistryValue('ProxyOverride');
  }

  if (autoDetect && autoDetect.exists) {
    await addWindowsRegistryValue('AutoDetect', autoDetect.type || 'REG_DWORD', autoDetect.value || '0');
  } else {
    await deleteWindowsRegistryValue('AutoDetect');
  }

  if (proxyEnable && proxyEnable.exists) {
    await addWindowsRegistryValue('ProxyEnable', proxyEnable.type || 'REG_DWORD', proxyEnable.value || '0');
  } else {
    await deleteWindowsRegistryValue('ProxyEnable');
  }

  await notifyWindowsProxyChanged();
}

async function clearStaleWindowsHdoPac() {
  const autoConfigUrl = await queryWindowsRegistryValue('AutoConfigURL');
  const value = autoConfigUrl && autoConfigUrl.exists ? autoConfigUrl.value : '';
  if (!isHdoLocalPacUrl(value)) return { restored: false };
  await deleteWindowsRegistryValue('AutoConfigURL');
  const proxyServer = await queryWindowsRegistryValue('ProxyServer');
  if (proxyServer && proxyServer.exists && proxyServer.value) {
    await addWindowsRegistryValue('ProxyEnable', 'REG_DWORD', '1');
  }
  await notifyWindowsProxyChanged();
  return {
    restored: true,
    stalePacUrl: value,
    proxyServerRestored: Boolean(proxyServer && proxyServer.exists && proxyServer.value)
  };
}

function isHdoLocalPacUrl(value) {
  const text = stringValue(value);
  if (!text) return false;
  try {
    const url = new URL(text);
    return /^127\.0\.0\.1$|^localhost$/i.test(url.hostname) && url.pathname === '/proxy.pac';
  } catch {
    return /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/proxy\.pac$/i.test(text);
  }
}

async function queryWindowsRegistryValue(name) {
  try {
    const result = await execFileText('reg.exe', ['query', WINDOWS_PROXY_KEY, '/v', name]);
    const parsed = parseWindowsRegistryValue(result.stdout, name);
    return parsed || { exists: false, name };
  } catch {
    return { exists: false, name };
  }
}

function parseWindowsRegistryValue(stdout, name) {
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const match = line.trim().match(/^(\S+)\s+(REG_\S+)\s*(.*)$/);
    if (!match || match[1] !== name) continue;
    return {
      exists: true,
      name,
      type: match[2],
      value: match[3] || ''
    };
  }
  return null;
}

function addWindowsRegistryValue(name, type, value) {
  return execFileText('reg.exe', ['add', WINDOWS_PROXY_KEY, '/v', name, '/t', type, '/d', String(value), '/f']);
}

function deleteWindowsRegistryValue(name) {
  return execFileText('reg.exe', ['delete', WINDOWS_PROXY_KEY, '/v', name, '/f']).catch(() => undefined);
}

function notifyWindowsProxyChanged() {
  const script = [
    '$sig = @\'',
    '[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);',
    '\'@;',
    '$type = Add-Type -MemberDefinition $sig -Name WinInetNotify -Namespace QPJoy -PassThru;',
    '[void]$type::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0);',
    '[void]$type::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0);'
  ].join(' ');
  return execFileText('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
    .catch(() => undefined);
}

function execFileText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function readState(statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return state && (state.version === STATE_VERSION || state.version === 1) ? state : null;
  } catch {
    return null;
  }
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function removeState(statePath, log) {
  try {
    fs.rmSync(statePath, { force: true });
  } catch (err) {
    log.warn('[hdo] failed to remove system domain proxy state', err);
  }
}

function publicState(state, extra = {}) {
  return {
    supported: true,
    applied: state.applied === true,
    platform: state.platform,
    pacUrl: state.pacUrl || null,
    proxy: state.proxy || null,
    domains: stringArray(state.domains),
    updatedAt: state.updatedAt || null,
    ...extra
  };
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : [];
}

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeProxyAddress(value) {
  const text = stringValue(value);
  if (!text) return null;
  const match = text.match(/^(127\.0\.0\.1|localhost):([1-9]\d{0,4})$/i);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port > 65535) return null;
  return `${match[1]}:${port}`;
}

function fallbackProxyForPac(previous) {
  if (process.platform !== 'win32') return null;
  const enabled = previous && previous.proxyEnable;
  if (!enabled || enabled.exists !== true || String(enabled.value || '').trim() === '0') return null;
  const server = previous && previous.proxyServer;
  if (!server || server.exists !== true || !server.value) return null;
  return normalizeWindowsProxyServer(server.value);
}

function normalizeWindowsProxyServer(value) {
  const text = stringValue(value);
  if (!text) return null;
  if (!text.includes('=')) return normalizeProxyAddress(text);

  const entries = {};
  for (const part of text.split(';')) {
    const [rawKey, ...rawValue] = part.split('=');
    const key = String(rawKey || '').trim().toLowerCase();
    const candidate = rawValue.join('=').trim();
    if (!key || !candidate) continue;
    entries[key] = candidate;
  }

  return normalizeProxyAddress(entries.https)
    || normalizeProxyAddress(entries.http)
    || normalizeProxyAddress(entries.socks)
    || normalizeProxyAddress(Object.values(entries).find(Boolean));
}

function renderPacScript(proxy, domains, fallbackProxy) {
  const fallback = fallbackProxy ? `PROXY ${fallbackProxy}; DIRECT` : 'DIRECT';
  return `
function FindProxyForURL(url, host) {
  var h = String(host || '').toLowerCase();
  var domains = ${JSON.stringify(domains)};
  for (var i = 0; i < domains.length; i++) {
    var d = domains[i];
    if (h === d || h.slice(-(d.length + 1)) === '.' + d) {
      return 'PROXY ${proxy}';
    }
  }
  return ${JSON.stringify(fallback)};
}
`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

module.exports = {
  createSystemDomainProxyManager
};
