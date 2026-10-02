#!/usr/bin/env node
// Idempotent host installation, also invoked by internal-production deploy.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, renameSync, symlinkSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICE_CATALOG, DEFAULT_WORKSPACE, defaultServiceProfile, normalizeServiceProfile } from '../../desktop/service-operations-catalog.js';

const unitName = 'mx-service-operations.service';
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const paths = { root: '/opt/mx-service-operations', configuration: '/etc/mx-service-operations', stateDir: '/var/lib/mx-service-operations', units: '/etc/systemd/system' };
const assert = (condition, message) => { if (!condition) throw new Error(message); };
function atomicWrite(path, content, mode = 0o600) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, content, { mode });
  renameSync(temp, path);
}
function replaceLink(path, target) {
  const temp = `${path}.${randomUUID()}.tmp`;
  symlinkSync(target, temp); renameSync(temp, path);
}
export function parseInstallOptions(args) {
  const options = { workspace: DEFAULT_WORKSPACE, connect: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--connect-k8s') options.connect = true;
    else if (args[i] === '--default-bind' && args[i + 1]) options.defaultBind = args[++i];
    else if (['--workspace', '--bind', '--port'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
    else throw new Error('Usage: node service-operations-install.mjs [--workspace /absolute/electron-dock] [--bind private-IP] [--port 19290] [--connect-k8s]');
  }
  return options;
}
// Dependencies are injectable for isolated tests; the CLI always uses real host paths.
export async function installOperations(options, dependencies = {}) {
  const { root, configuration, stateDir, units } = dependencies.paths || paths;
  const command = dependencies.command || ((program, args, extra = {}) => execFileSync(program, args, { stdio: ['pipe', 'pipe', 'pipe'], ...extra }));
  const request = dependencies.request || (async (config, token, path, body) => {
    const response = await fetch(`http://${config.bind}:${config.port}/v1/${path}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'x-mx-operations-token': token, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    if (!response.ok) throw new Error(`执行器生命周期接口返回 ${response.status}`);
    return response.json();
  });
  const log = dependencies.log || console.log;
  const node = dependencies.node || process.execPath;
  const source = dependencies.source || sourceDirectory;
  assert(options.workspace?.startsWith('/') && !/[\r\n%]/.test(options.workspace), 'workspace 必须为绝对路径');
  assert(!/[\r\n%]/.test(node), 'Node 路径不支持换行或 %');
  assert(statSync(join(options.workspace, 'mx-launcher/scripts/manage.sh')).isFile(), '缺少 Launcher 管理脚本');
  command('systemctl', ['--version']);
  for (const directory of [root, configuration, stateDir, units]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const configFile = join(configuration, 'config.json');
  const tokenFile = join(configuration, 'token');
  let config;
  if (existsSync(configFile)) {
    config = JSON.parse(readFileSync(configFile, 'utf8'));
    assert(!options.bind || options.bind === config.bind, '已有 bind 与显式参数不同；请由主机管理员核对 config.json，不自动覆盖');
    assert(!options.port || Number(options.port) === config.port, '已有 port 与显式参数不同；请由主机管理员核对 config.json，不自动覆盖');
    assert(config.stateDir === stateDir && config.tokenFile === tokenFile, '已有存储目录与标准安装不同，不自动迁移');
    assert(config.instances?.some(i => i.service === 'launcher' && i.profile.cwd === join(options.workspace, 'mx-launcher')), '已有 Launcher 目录与本次部署不符，不自动覆盖');
    for (const instance of config.instances) normalizeServiceProfile(instance.service, instance.profile);
    assert(existsSync(tokenFile), '已有执行器丢失 token，请从备份恢复；不自动生成另一套凭据');
  } else {
    config = {
      host: 'mx-internal-server', bind: options.bind || options.defaultBind || '127.0.0.1', port: Number(options.port || 19290), tokenFile, stateDir,
      // Sibling projects may be absent on a Launcher-only host. Existing
      // installations retain their explicit registry, including custom profiles.
      instances: Object.entries(SERVICE_CATALOG).filter(([, service]) => existsSync(join(options.workspace, service.directory, 'scripts/manage.sh')))
        .map(([service]) => ({ id: service, service, profile: defaultServiceProfile(service, options.workspace) }))
    };
  }
  assert(/^\d{1,3}(?:\.\d{1,3}){3}$/.test(config.bind) && config.bind.split('.').every(n => Number(n) <= 255) && config.bind !== '0.0.0.0', 'bind 必须是明确的主机 IPv4 地址');
  assert(Number.isInteger(config.port) && config.port >= 1024 && config.port <= 65535, 'port 需要 1024–65535');
  assert(!options.connect || !config.bind.startsWith('127.'), 'Kubernetes 接入需要 Pod 可达的主机内网地址；首次部署请设置 MX_SERVICE_OPERATIONS_BIND 或 MX_K8S_APISERVER_ADVERTISE_ADDRESS');
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  chmodSync(tokenFile, 0o600);
  const token = readFileSync(tokenFile, 'utf8').trim();
  assert(token.length >= 32, '已有 token 无效；不自动轮换');
  if (!existsSync(configFile)) atomicWrite(configFile, JSON.stringify(config, null, 2));
  chmodSync(configFile, 0o600);
  const files = {
    'server/scripts/service-operations-agent.mjs': readFileSync(join(source, 'service-operations-agent.mjs')),
    'desktop/service-operations-catalog.js': readFileSync(resolve(source, '../../desktop/service-operations-catalog.js')),
    'package.json': Buffer.from('{"type":"module"}\n')
  };
  const digest = createHash('sha256');
  for (const [path, content] of Object.entries(files)) digest.update(path).update('\0').update(content).update('\0');
  const version = digest.digest('hex');
  const releases = join(root, 'releases'); mkdirSync(releases, { recursive: true, mode: 0o700 });
  const release = join(releases, version);
  if (!existsSync(release)) {
    const stage = join(releases, `.stage-${randomUUID()}`);
    try {
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(dirname(join(stage, path)), { recursive: true, mode: 0o700 });
        writeFileSync(join(stage, path), content, { mode: 0o600 });
      }
      writeFileSync(join(stage, 'release.json'), JSON.stringify({ runtimeVersion: version }), { mode: 0o600 });
      command(node, ['--check', join(stage, 'server/scripts/service-operations-agent.mjs')]);
      command(node, ['--check', join(stage, 'desktop/service-operations-catalog.js')]);
      renameSync(stage, release);
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
  for (const [path, content] of Object.entries(files)) assert(readFileSync(join(release, path)).equals(content), '已安装版本内容被修改，请核对后再部署');
  const unitFile = join(units, unitName);
  const unit = `[Unit]
Description=MX independent service operations executor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=${root}
Environment="PATH=${dirname(node)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=${JSON.stringify(node)} ${root}/current/server/scripts/service-operations-agent.mjs ${configFile}
Restart=on-failure
RestartSec=2
UMask=0077
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
`;
  const unitChanged = !existsSync(unitFile) || readFileSync(unitFile, 'utf8') !== unit;
  let active = false;
  try { command('systemctl', ['is-active', '--quiet', unitName]); active = true; } catch { /* First install or a stopped service. */ }
  let current;
  if (active) {
    try { current = await request(config, token, 'lifecycle'); }
    catch { throw new Error('已有执行器暂不可达或不支持安全更新，保留其运行状态；请核对端口、令牌与版本后重试'); }
    assert(!current.updateRequested || current.updateRequested === version, '执行器已有另一版本等待切换，请等待完成后重试');
  }
  const pointer = join(root, 'current');
  if (!existsSync(pointer) || readlinkSync(pointer) !== release) replaceLink(pointer, release);
  if (unitChanged) atomicWrite(unitFile, unit, 0o644);
  // Reconcile even if a previous install stopped between writing and reloading.
  // daemon-reload rereads units without restarting any running service.
  command('systemctl', ['daemon-reload']);
  // enable does not restart an already running service; also repairs a disabled unit.
  command('systemctl', ['enable', unitName]);
  let deferred = false;
  if (!active) command('systemctl', ['start', unitName]);
  else if (current.runtimeVersion !== version || unitChanged || current.updateRequested) {
    try {
      const drain = await request(config, token, 'lifecycle/update', { runtimeVersion: version });
      deferred = drain.inFlight > 0 || drain.submitting;
    } catch { throw new Error('执行器更新请求结果不确定；未强制重启。重新部署可核对同一版本，不会重放业务任务'); }
    // A task awaiting reconciliation must not be killed or silently unlocked.
    if (existsSync(join(stateDir, 'active.lock'))) deferred = true;
  }
  if (!deferred) {
    const deadline = Date.now() + (dependencies.readyTimeout ?? 30000);
    let ready = false;
    do {
      try {
        const health = await request(config, token, 'lifecycle');
        if (health.runtimeVersion === version && !health.updateRequested && (!current || !unitChanged || health.bootId !== current.bootId)) { ready = true; break; }
      } catch { /* systemd may be starting the new process. */ }
      await sleep(dependencies.pollInterval ?? 250);
    } while (Date.now() < deadline);
    assert(ready, '执行器未在等待期内就绪；保留配置和任务，核对 systemctl status mx-service-operations 后重试 deploy');
  }
  if (options.connect) {
    const secret = {
      apiVersion: 'v1', kind: 'Secret', metadata: { name: 'mx-service-operations', namespace: 'mx-internal-shadow' }, type: 'Opaque',
      stringData: { MX_SERVICE_OPERATIONS_URL: `http://${config.bind}:${config.port}`, MX_SERVICE_OPERATIONS_TOKEN: token }
    };
    try {
      // Safe for a first deployment and does not take ownership of existing labels.
      command('kubectl', ['apply', '--server-side', '--field-manager=mx-service-operations', '-f', '-'], {
        input: JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'mx-internal-shadow' } })
      });
      command('kubectl', ['apply', '-f', '-'], { input: JSON.stringify(secret) });
    } catch { throw new Error('执行器已准备，但 Kubernetes Secret 登记失败；业务 rollout 尚未开始，请核对集群权限后重试'); }
  }
  log(deferred ? `执行器 ${version.slice(0, 12)} 已暂存，当前任务完成并保存结果后自动切换；待核对任务会继续阻止切换。`
    : `执行器 ${version.slice(0, 12)} 已就绪；重复部署保留令牌、实例、任务及同版本进程。`);
  return { version, deferred, config };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.platform === 'linux' && process.getuid?.() === 0, '请在目标 Linux 主机以 root/sudo 安装');
    assert(Number(process.versions.node.split('.')[0]) >= 22, '执行器需要 Node.js 22 或更新版本');
    const locked = process.argv[2] === '--install-under-lock';
    const args = process.argv.slice(locked ? 3 : 2);
    const options = parseInstallOptions(args);
    if (locked) await installOperations(options);
    else {
      // Kernel-owned lock is released on crashes/reboots, without stale PID races.
      mkdirSync(paths.root, { recursive: true, mode: 0o700 });
      try {
        execFileSync('flock', ['-n', '-E', '73', join(paths.root, 'install.lock'), process.execPath, fileURLToPath(import.meta.url), '--install-under-lock', ...args], { stdio: 'inherit' });
      } catch (error) {
        if (error.code === 'ENOENT') throw new Error('安装执行器需要 Linux flock（与现有生产恢复脚本相同）');
        if (error.status === 73) throw new Error('已有执行器安装正在运行，请稍后重试');
        process.exitCode = error.status || 1; // Inner invocation already reported its error.
      }
    }
  } catch (error) {
    // Child-process errors may contain stdin (the Secret). Never print that error object.
    console.error(error.message?.startsWith('Command failed:') ? '安装命令失败；请核对 Node、systemd 与目录权限后重试' : error.message);
    process.exitCode = 1;
  }
}
