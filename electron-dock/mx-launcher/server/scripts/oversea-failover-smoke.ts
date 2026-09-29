// Uses only loopback ports and synthetic accounts. Never loads a user's proxy config.
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadConfig } from '../src/config.js';
import { MX_H2I_PRODUCT_ID } from '../src/store/domain.js';
import { MemoryStore } from '../src/store/memory.js';

const binary = process.env.MIHOMO_BINARY;
if (!binary) throw new Error('Set MIHOMO_BINARY to a local mihomo executable');
const temp = mkdtempSync(join(tmpdir(), 'mx-oversea-failover-'));
const children: ChildProcess[] = [];
let childLogs = '';
const health = createServer((_req, res) => { res.writeHead(204); res.end(); });

async function freePort(udp = false): Promise<number> {
  const socket = udp ? createSocket('udp4') : createTcpServer();
  if (udp) (socket as ReturnType<typeof createSocket>).bind(0, '127.0.0.1');
  else (socket as ReturnType<typeof createTcpServer>).listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = (socket.address() as AddressInfo).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return port;
}

function start(name: string, yaml: string): ChildProcess {
  const dir = join(temp, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.yaml');
  writeFileSync(file, yaml);
  const child = spawn(binary!, ['-d', dir, '-f', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const output of [child.stdout, child.stderr]) {
    output?.on('data', (chunk) => { childLogs = (childLogs + chunk.toString()).slice(-8000); });
  }
  child.on('error', (err) => { childLogs += err.message; });
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

async function until(check: () => Promise<boolean>, message: string, timeout = 45_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(message);
}

try {
  const serverDir = join(temp, 'server');
  mkdirSync(serverDir);
  const cert = join(serverDir, 'server.crt');
  const key = join(serverDir, 'server.key');
  const certificate = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', key, '-out', cert
  ], { encoding: 'utf8' });
  assert.equal(certificate.status, 0, 'openssl must create a temporary test certificate');
  health.listen(0, '127.0.0.1');
  await once(health, 'listening');
  const healthUrl = `http://127.0.0.1:${(health.address() as AddressInfo).port}/generate_204`;
  const hyPort = await freePort(true);
  const controllerPort = await freePort();
  let mixedPort = await freePort();
  while (mixedPort === controllerPort) mixedPort = await freePort();

  const siteIds = ['smoke-jp', 'smoke-xjp'];
  const store = new MemoryStore(loadConfig());
  for (const siteId of siteIds) store.upsertLauncherNetworkMihomoSite({
    siteId, publicHost: '127.0.0.1', serverPorts: String(hyPort), requestedBy: 'failover-smoke'
  });
  store.upsertLauncherProductNetwork({ productId: MX_H2I_PRODUCT_ID, defaultOverseaSiteId: siteIds[0] });
  const user = store.createUserCenterUser({ account: 'failover-smoke', displayName: 'Failover smoke' });
  const entitlement = store.upsertUserOverseaEntitlement({ userId: user.userId, siteIds });
  const tokens = entitlement.accounts.map((ref) => store.getSiteSlotAccessAccount(ref.siteId, ref.username)!.authToken);
  const yaml = store.renderUserOverseaMihomoSubscription(user.userId)!.yaml;
  // Keep the actual generated nodes and group policy. Only move the probe URL to
  // loopback and omit geo/DNS/routing settings that would require outside services.
  const groupsAndNodes = yaml.slice(yaml.indexOf('proxies:\n'), yaml.indexOf('rules:\n'))
    .replace('https://www.gstatic.com/generate_204', healthUrl);
  assert.ok(groupsAndNodes.includes('Oversea-Auto'));

  const serverConfig = (token: string) => `
mode: rule
log-level: warning
listeners:
  - name: fixture-hy2
    type: hysteria2
    listen: 127.0.0.1
    port: ${hyPort}
    users:
      fixture: ${JSON.stringify(token)}
    certificate: ${JSON.stringify(cert)}
    private-key: ${JSON.stringify(key)}
rules:
  - MATCH,DIRECT
`;
  let server = start('server', serverConfig(tokens[1]));
  start('client', `
mode: rule
log-level: warning
mixed-port: ${mixedPort}
external-controller: 127.0.0.1:${controllerPort}
allow-lan: false
${groupsAndNodes}
rules:
  - MATCH,Oversea
`);

  const proxy = async (name: string) => {
    const response = await fetch(`http://127.0.0.1:${controllerPort}/proxies/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(1000)
    });
    assert.equal(response.status, 200);
    return await response.json() as { now?: string; alive: boolean; history: unknown[] };
  };
  const traffic = () => new Promise<number | undefined>((resolve, reject) => {
    // A real request through the client's default select -> fallback chain.
    const req = request({
      host: '127.0.0.1', port: mixedPort, path: healthUrl,
      headers: { Host: new URL(healthUrl).host }, timeout: 7000
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('proxy request timed out')));
    req.end();
  });
  const jp = 'smoke-jp-hysteria2';
  const xjp = 'smoke-xjp-hysteria2';
  await until(async () => {
    const [first, second, auto] = await Promise.all([proxy(jp), proxy(xjp), proxy('Oversea-Auto')]);
    return !first.alive && second.alive && second.history.length > 0 && auto.now === xjp;
  }, 'JP authentication failure must leave XJP usable');
  assert.equal((await proxy('Oversea')).now, 'Oversea-Auto');
  assert.equal(await traffic(), 204);
  console.log('PASS: JP rejects authentication; Auto sends traffic through XJP.');

  await stop(server);
  await until(async () => !(await proxy(jp)).alive && !(await proxy(xjp)).alive,
    'background checks must detect that all nodes are down');
  assert.notEqual(await traffic().catch(() => 0), 204, 'all-down must not silently route DIRECT');
  console.log('PASS: all nodes down stays unavailable; no automatic DIRECT bypass.');

  server = start('server', serverConfig(tokens[0]));
  // No delay-test API or selection writes: recovery must come from periodic probes.
  await until(async () => {
    const [first, second, auto] = await Promise.all([proxy(jp), proxy(xjp), proxy('Oversea-Auto')]);
    return first.alive && !second.alive && auto.now === jp;
  }, 'JP recovery must be discovered without manual selection or user traffic');
  assert.equal(await traffic(), 204);
  console.log('PASS: JP recovers while XJP rejects authentication; Auto resumes through JP.');
} catch (error) {
  console.error(childLogs);
  throw error;
} finally {
  await Promise.all(children.map(stop));
  health.closeAllConnections();
  if (health.listening) await new Promise<void>((resolve) => health.close(() => resolve()));
  rmSync(temp, { recursive: true, force: true });
}
