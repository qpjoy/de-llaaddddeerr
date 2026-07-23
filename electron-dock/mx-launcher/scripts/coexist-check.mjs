#!/usr/bin/env node
/**
 * Coexistence assertion tool for standalone launcher products (docs/19 §4).
 *
 * Snapshots machine network state (routes, NRPT, system PAC/proxy, standalone
 * ownership registry) and asserts the coexistence invariants I1-I5 for each
 * product, so the C1-C12 matrix can be driven semi-automatically: an operator
 * connects/disconnects the apps, this tool proves nothing leaked or got
 * stolen across products.
 *
 * Usage:
 *   node scripts/coexist-check.mjs snapshot [--out state.json]
 *   node scripts/coexist-check.mjs assert --product mx-h2i --expect connected
 *   node scripts/coexist-check.mjs assert --product luopan --expect disconnected
 *   node scripts/coexist-check.mjs diff before.json after.json
 *   node scripts/coexist-check.mjs run [--scenario C5]      # interactive matrix runner
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const artifactsDir = resolve(here, '..', 'artifacts', 'coexist');

// Expected per-product network shape. Interface alias == WireGuard tunnel name.
// `vipsAnyOf`: at least one must be routed while connected (mx-h2i is in its
// migration window between foundation addresses and 10.88.100.1).
const PRODUCTS = {
  'mx-h2i': {
    iface: 'mx-h2i',
    cidrs: ['10.89.0.0/16'],
    vipsAnyOf: ['10.88.88.88/32', '10.88.100.1/32'],
    optionalRoutes: ['10.88.0.1/32'],
    nrptComment: /^MX-H2I \/ QPJoy MX-H2I/,
    foreign: ['10.91.0.0/16', '10.88.100.3/32']
  },
  luopan: {
    iface: 'luopan',
    cidrs: ['10.91.0.0/16'],
    vipsAnyOf: ['10.88.100.3/32'],
    optionalRoutes: [],
    nrptComment: /^MX-LUOPAN \/ QPJoy Luopan/,
    foreign: ['10.89.0.0/16', '10.88.100.1/32', '10.88.88.88/32', '10.88.0.1/32']
  }
};

const SCENARIOS = [
  { id: 'C1', title: '仅 MX-H2I 连接（基线）', steps: [
    { do: '连接 MX-H2I，等待状态稳定', assert: [['mx-h2i', 'connected'], ['luopan', 'disconnected']] }
  ] },
  { id: 'C2', title: '仅 Luopan 连接', steps: [
    { do: '断开 MX-H2I，连接 Luopan', assert: [['luopan', 'connected'], ['mx-h2i', 'disconnected']] }
  ] },
  { id: 'C3', title: 'H2I 先连，Luopan 后连', steps: [
    { do: '连接 MX-H2I', assert: [['mx-h2i', 'connected']] },
    { do: '再连接 Luopan', assert: [['mx-h2i', 'connected'], ['luopan', 'connected']] }
  ] },
  { id: 'C4', title: 'Luopan 先连，H2I 后连', steps: [
    { do: '全部断开后先连接 Luopan', assert: [['luopan', 'connected']] },
    { do: '再连接 MX-H2I', assert: [['mx-h2i', 'connected'], ['luopan', 'connected']] }
  ] },
  { id: 'C5', title: '双连后断开 H2I（I3）', steps: [
    { do: '双产品都连接', assert: [['mx-h2i', 'connected'], ['luopan', 'connected']] },
    { do: '断开 MX-H2I', assert: [['mx-h2i', 'disconnected'], ['luopan', 'connected']] }
  ] },
  { id: 'C6', title: '双连后断开 Luopan（对称）', steps: [
    { do: '双产品都连接', assert: [['mx-h2i', 'connected'], ['luopan', 'connected']] },
    { do: '断开 Luopan', assert: [['luopan', 'disconnected'], ['mx-h2i', 'connected']] }
  ] },
  { id: 'C7', title: 'kill -9 Luopan 后重启（I4）', steps: [
    { do: '双连后强杀 Luopan 进程（任务管理器/kill -9）', assert: [['mx-h2i', 'connected']] },
    { do: '重启 Luopan 并重连', assert: [['mx-h2i', 'connected'], ['luopan', 'connected']] }
  ] },
  { id: 'C8', title: '双连 + Clash/mihomo TUN', steps: [
    { do: '双连后开启 Clash TUN 模式', assert: [['mx-h2i', 'connected'], ['luopan', 'connected']] }
  ] },
  { id: 'C9', title: '双连 + 系统代理(PAC)', steps: [
    { do: '双连后确认系统 PAC 生效（两产品域名都可解析）', assert: [['mx-h2i', 'connected'], ['luopan', 'connected']] }
  ] },
  { id: 'C10', title: 'H2O embed + Luopan standalone', steps: [
    { do: 'MX-H2I 内启动 H2O，同时 Luopan 在线', assert: [['mx-h2i', 'connected'], ['luopan', 'connected']] }
  ] },
  { id: 'C11', title: '双产品同时检查更新', steps: [
    { do: '两个产品同时点检查更新/下载', assert: [['mx-h2i', 'connected'], ['luopan', 'connected']] }
  ] },
  { id: 'C12', title: '睡眠/网络切换恢复', steps: [
    { do: '双连后睡眠唤醒（或切换 Wi-Fi/有线），等恢复完成', assert: [['mx-h2i', 'connected'], ['luopan', 'connected']] }
  ] }
];

// ---------------------------------------------------------------- snapshot

async function takeSnapshot() {
  const platform = process.platform;
  const snapshot = {
    takenAt: new Date().toISOString(),
    platform,
    routes: [],
    nrpt: [],
    proxy: {},
    ownership: readOwnershipRegistry()
  };
  if (platform === 'win32') {
    snapshot.routes = await winJson(
      'Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object DestinationPrefix,InterfaceAlias,InterfaceIndex,NextHop,RouteMetric | ConvertTo-Json -Compress'
    ) || [];
    snapshot.nrpt = await winJson(
      'Get-DnsClientNrptRule -ErrorAction SilentlyContinue | Select-Object Namespace,NameServers,Comment,DisplayName | ConvertTo-Json -Compress'
    ) || [];
    snapshot.proxy = await winProxySettings();
  } else if (platform === 'darwin') {
    snapshot.routes = await macRoutes();
    snapshot.proxy = await macProxySettings();
  } else {
    throw new Error(`Unsupported platform for coexist-check: ${platform}`);
  }
  if (snapshot.proxy?.pacUrl?.startsWith('http://127.0.0.1')) {
    snapshot.proxy.pacContentSha256 = await fetchSha256(snapshot.proxy.pacUrl);
  }
  return snapshot;
}

function readOwnershipRegistry() {
  const path = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'QPJoy', 'Electron Launcher', 'standalone-ownership.json')
    : join(process.env.APPDATA || homedir(), 'QPJoy', 'Electron Launcher', 'standalone-ownership.json');
  try {
    return { path, claims: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { path, claims: null };
  }
}

function windowsPowerShell() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function winJson(command) {
  const { stdout } = await execFileAsync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 20000 });
  const text = stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function winProxySettings() {
  const [settings] = await winJson(
    "Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' | Select-Object AutoConfigURL,ProxyEnable,ProxyServer | ConvertTo-Json -Compress"
  ).catch(() => [null]);
  return {
    pacUrl: settings?.AutoConfigURL || null,
    proxyEnable: settings?.ProxyEnable === 1,
    proxyServer: settings?.ProxyServer || null
  };
}

async function macRoutes() {
  const { stdout } = await execFileAsync('netstat', ['-rn', '-f', 'inet'], { timeout: 15000 });
  return stdout.split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 4 && /^[0-9]/.test(cols[0] || ''))
    .map((cols) => ({
      DestinationPrefix: normalizeMacDestination(cols[0]),
      NextHop: cols[1],
      InterfaceAlias: cols[cols.length - 1]
    }));
}

function normalizeMacDestination(dest) {
  if (dest.includes('/')) return dest;
  const parts = dest.split('.');
  while (parts.length < 4) parts.push('0');
  const prefix = dest.split('.').length * 8;
  return `${parts.join('.')}/${Math.min(prefix, 32)}`;
}

async function macProxySettings() {
  const { stdout: services } = await execFileAsync('networksetup', ['-listallnetworkservices'], { timeout: 15000 });
  const result = { pacUrl: null, services: [] };
  for (const service of services.split('\n').slice(1).map((s) => s.trim()).filter((s) => s && !s.startsWith('*'))) {
    const { stdout } = await execFileAsync('networksetup', ['-getautoproxyurl', service], { timeout: 15000 }).catch(() => ({ stdout: '' }));
    const url = /URL:\s*(\S+)/.exec(stdout)?.[1];
    const enabled = /Enabled:\s*Yes/.test(stdout);
    result.services.push({ service, pacUrl: url && url !== '(null)' ? url : null, enabled });
    if (enabled && url && url !== '(null)' && !result.pacUrl) result.pacUrl = url;
  }
  return result;
}

function fetchSha256(url) {
  return new Promise((resolvePromise) => {
    const req = httpGet(url, (res) => {
      const hash = createHash('sha256');
      res.on('data', (chunk) => hash.update(chunk));
      res.on('end', () => resolvePromise(hash.digest('hex')));
      res.on('error', () => resolvePromise(null));
    });
    req.on('error', () => resolvePromise(null));
    req.setTimeout(4000, () => { req.destroy(); resolvePromise(null); });
  });
}

// ------------------------------------------------------------------ assert

function assertProduct(snapshot, productId, expect) {
  const product = PRODUCTS[productId];
  if (!product) throw new Error(`Unknown product: ${productId}`);
  const failures = [];
  const warnings = [];
  const ifaceRoutes = snapshot.routes.filter((route) => route.InterfaceAlias === product.iface);
  const ifacePrefixes = new Set(ifaceRoutes.map((route) => route.DestinationPrefix));
  const allPrefixes = new Set(snapshot.routes.map((route) => route.DestinationPrefix));

  if (expect === 'connected') {
    for (const cidr of product.cidrs) {
      if (!ifacePrefixes.has(cidr)) failures.push(`I1: 缺少产品 lease 路由 ${cidr} @ ${product.iface}`);
    }
    if (!product.vipsAnyOf.some((vip) => ifacePrefixes.has(vip))) {
      failures.push(`I1: 产品 VIP 路由缺失（期望以下任一：${product.vipsAnyOf.join(' / ')}）@ ${product.iface}`);
    }
    for (const foreign of product.foreign) {
      if (ifacePrefixes.has(foreign)) failures.push(`I1: 越权 adopt 了其他产品的路由 ${foreign} @ ${product.iface}`);
    }
    if (snapshot.platform === 'win32') {
      const owned = snapshot.nrpt.filter((rule) => product.nrptComment.test(String(rule.Comment || rule.DisplayName || '')));
      if (!owned.length) warnings.push(`I2: 未发现带 ${productId} 归属标签的 NRPT 规则（若本场景不下发 split DNS 可忽略）`);
    }
    const claims = ownershipClaims(snapshot);
    if (!claims || !claims.some((claim) => claimBelongsTo(claim, productId) && ['connecting', 'active'].includes(claim.state))) {
      failures.push(`I2: ownership registry 中没有 ${productId} 的 live claim（${snapshot.ownership.path}）`);
    }
  } else {
    if (ifaceRoutes.length > 0) {
      failures.push(`I1: 断开后接口 ${product.iface} 仍有 ${ifaceRoutes.length} 条路由：${[...ifacePrefixes].slice(0, 6).join(', ')}`);
    }
    for (const cidr of product.cidrs) {
      if (allPrefixes.has(cidr)) failures.push(`I1: 断开后 lease 路由 ${cidr} 仍存在于系统路由表`);
    }
    if (snapshot.platform === 'win32') {
      const owned = snapshot.nrpt.filter((rule) => product.nrptComment.test(String(rule.Comment || rule.DisplayName || '')));
      if (owned.length) failures.push(`I2: 断开后仍残留 ${owned.length} 条 ${productId} 的 NRPT 规则：${owned.map((r) => r.Namespace).join(', ')}`);
    }
    const claims = ownershipClaims(snapshot);
    if (claims && claims.some((claim) => claimBelongsTo(claim, productId) && claim.state !== 'released')) {
      failures.push(`I2: 断开后 ownership registry 仍有 ${productId} 的 live/stale claim`);
    }
  }
  return { productId, expect, failures, warnings };
}

function ownershipClaims(snapshot) {
  const raw = snapshot.ownership?.claims;
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.claims)) return raw.claims;
  return null;
}

function claimBelongsTo(claim, productId) {
  return claim?.productId === productId || String(claim?.ownerId || '').includes(productId);
}

// -------------------------------------------------------------------- diff

function diffSnapshots(before, after) {
  const routeKey = (route) => `${route.DestinationPrefix} @ ${route.InterfaceAlias}`;
  const nrptKey = (rule) => `${rule.Namespace} [${rule.Comment || rule.DisplayName || 'untagged'}]`;
  const beforeRoutes = new Set(before.routes.map(routeKey));
  const afterRoutes = new Set(after.routes.map(routeKey));
  const beforeNrpt = new Set((before.nrpt || []).map(nrptKey));
  const afterNrpt = new Set((after.nrpt || []).map(nrptKey));
  return {
    routesAdded: [...afterRoutes].filter((key) => !beforeRoutes.has(key)),
    routesRemoved: [...beforeRoutes].filter((key) => !afterRoutes.has(key)),
    nrptAdded: [...afterNrpt].filter((key) => !beforeNrpt.has(key)),
    nrptRemoved: [...beforeNrpt].filter((key) => !afterNrpt.has(key)),
    pacChanged: before.proxy?.pacUrl !== after.proxy?.pacUrl
      || before.proxy?.pacContentSha256 !== after.proxy?.pacContentSha256
  };
}

// --------------------------------------------------------------------- cli

function arg(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function printResult(result) {
  const status = result.failures.length ? 'FAIL' : 'PASS';
  console.log(`[${status}] ${result.productId} expect=${result.expect}`);
  for (const failure of result.failures) console.log(`  ✗ ${failure}`);
  for (const warning of result.warnings) console.log(`  ! ${warning}`);
  return result.failures.length === 0;
}

async function promptEnter(message) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolvePromise) => rl.question(`${message}\n  完成后按回车继续 > `, resolvePromise));
  rl.close();
}

const command = process.argv[2];
if (command === 'snapshot') {
  const snapshot = await takeSnapshot();
  const out = arg('--out');
  if (out) {
    writeFileSync(out, JSON.stringify(snapshot, null, 2));
    console.log(`snapshot written: ${out}`);
  } else {
    console.log(JSON.stringify(snapshot, null, 2));
  }
} else if (command === 'assert') {
  const snapshotPath = arg('--snapshot');
  const snapshot = snapshotPath ? JSON.parse(readFileSync(snapshotPath, 'utf8')) : await takeSnapshot();
  const ok = printResult(assertProduct(snapshot, arg('--product'), arg('--expect', 'connected')));
  process.exit(ok ? 0 : 1);
} else if (command === 'diff') {
  const before = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const after = JSON.parse(readFileSync(process.argv[4], 'utf8'));
  console.log(JSON.stringify(diffSnapshots(before, after), null, 2));
} else if (command === 'run') {
  const only = arg('--scenario');
  const scenarios = SCENARIOS.filter((scenario) => !only || scenario.id === only.toUpperCase());
  if (!scenarios.length) { console.error(`unknown scenario: ${only}`); process.exit(2); }
  mkdirSync(artifactsDir, { recursive: true });
  const report = [];
  for (const scenario of scenarios) {
    console.log(`\n=== ${scenario.id} ${scenario.title} ===`);
    let scenarioOk = true;
    for (const [index, step] of scenario.steps.entries()) {
      await promptEnter(`操作：${step.do}`);
      const snapshot = await takeSnapshot();
      const snapshotPath = join(artifactsDir, `${scenario.id}-step${index + 1}-${Date.now()}.json`);
      writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
      for (const [productId, expect] of step.assert) {
        scenarioOk = printResult(assertProduct(snapshot, productId, expect)) && scenarioOk;
      }
      console.log(`  快照: ${snapshotPath}`);
    }
    report.push({ id: scenario.id, title: scenario.title, ok: scenarioOk });
  }
  console.log('\n=== 矩阵结果 ===');
  for (const item of report) console.log(`  ${item.ok ? 'PASS' : 'FAIL'}  ${item.id} ${item.title}`);
  process.exit(report.every((item) => item.ok) ? 0 : 1);
} else {
  console.error('usage: coexist-check.mjs <snapshot|assert|diff|run> [options]');
  process.exit(2);
}
