import { EventEmitter } from 'events';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { gunzipSync } from 'zlib';
import { validateSubscriptionYaml } from '@qpjoy/electron-core-mihomo';

import { TunnelDatabase } from '../db/TunnelDatabase';
import { DOMAIN_PRESETS, type DomainPresetId } from '../defaults';
import { renderRuntimeConfig } from '../config/renderRuntimeConfig';
import { MihomoApi } from './MihomoApi';
import type {
  DomainRule,
  ManagedTunnelConfigInput,
  ManagedTunnelConfigResult,
  RuntimeSettings,
  RuntimeMode,
  SubscriptionInput,
  SubscriptionUpdateInput,
  SubscriptionRecord,
  TunnelManagerOptions,
  TunnelSnapshot,
  TunnelPorts,
  TunnelStatus
} from '../types';

interface ManagerPaths {
  root: string;
  db: string;
  profiles: string;
  runtime: string;
  config: string;
  core: string;
}

interface StopOptions {
  allowElevatedPrompt?: boolean;
}

function pathsFromOptions(options: TunnelManagerOptions): ManagerPaths {
  const root = join(options.userDataPath, 'mihomo-tunnel');
  return {
    root,
    db: join(root, 'tunnel.sqlite'),
    profiles: join(root, 'profiles'),
    runtime: join(root, 'runtime'),
    config: join(root, 'runtime', 'config.yaml'),
    core: join(root, 'bin', coreExecutableName())
  };
}

function coreExecutableName(): string {
  return process.platform === 'win32' ? 'mihomo.exe' : 'mihomo';
}

function platformArchKey(): string {
  const arch = process.arch === 'x64' ? 'x64' : process.arch;
  return `${process.platform}-${arch}`;
}

function isRootUser(): boolean {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

function needsElevatedTun(settings: RuntimeSettings): boolean {
  return settings.mode === 'system-tun'
    && settings.tunInstalled
    && !isRootUser()
    && (process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32');
}

function tunAdministratorMessage(): string {
  if (process.platform === 'darwin') {
    return '虚拟网卡启动失败：macOS 需要管理员授权。请在应用弹出的系统授权窗口中输入本机管理员账号密码；不要用 sudo 或全局管理员身份启动整个 App。取消授权时请切回 App 模式。';
  }
  if (process.platform === 'win32') {
    return '虚拟网卡启动失败：Windows 拒绝配置 TUN。请确认自动弹出的 UAC/脚本授权窗口已点击“是”，或切回 App 模式。';
  }
  return '虚拟网卡启动失败：当前系统需要通过 pkexec 获取管理员授权。请确认授权窗口已通过，或切回 App 模式。';
}

function tunApprovalRequiredMessage(): string {
  if (process.platform === 'darwin') {
    return 'macOS 虚拟网卡模式需要管理员授权。请在应用弹出的系统授权窗口中输入本机管理员账号密码。';
  }
  if (process.platform === 'win32') {
    return 'Windows 虚拟网卡模式需要管理员授权。应用会自动弹出 UAC/脚本授权窗口，请点击“是”。';
  }
  return '虚拟网卡模式需要管理员授权。请确认 pkexec 授权窗口已通过。';
}

function missingPrivilegeHelperMessage(): string {
  if (process.platform === 'darwin') {
    return 'macOS 缺少 /usr/bin/osascript，无法在应用内请求管理员授权。';
  }
  if (process.platform === 'linux') {
    return '当前系统缺少 pkexec，无法请求虚拟网卡所需的管理员授权。';
  }
  return 'TUN mode requires administrator privileges, but no supported privilege helper was found.';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === 'EPERM';
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cmdQuote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeSubscriptionInput(input: SubscriptionInput): SubscriptionInput {
  const rawUrl = input.url?.trim();
  if (!rawUrl) {
    throw new Error('subscription url is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('subscription url is invalid');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('subscription url must use http or https');
  }

  const username = input.username?.trim() || decodeURIComponent(parsed.username);
  const password = input.password || decodeURIComponent(parsed.password);
  parsed.username = '';
  parsed.password = '';

  const inferredName = input.name?.trim()
    || parsed.pathname.split('/').filter(Boolean).at(-1)
    || parsed.hostname
    || 'remote file';

  return {
    name: inferredName,
    url: parsed.toString(),
    username,
    password
  };
}

function normalizeManagedSource(value: unknown): string {
  const clean = String(value ?? 'server')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_')
    .slice(0, 48);
  return clean || 'server';
}

function normalizeDomainList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => String(item).trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean)));
}

function normalizePort(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${label} must be an integer between 1024 and 65535`);
  }
  return value;
}

export class MihomoManager extends EventEmitter {
  readonly db: TunnelDatabase;
  readonly api: MihomoApi;
  readonly paths: ManagerPaths;
  private child: ChildProcessWithoutNullStreams | null = null;
  private elevatedPid: number | null = null;
  private operation: Promise<unknown> = Promise.resolve();
  private lastRuntimeError: string | null = null;

  constructor(private readonly options: TunnelManagerOptions) {
    super();
    this.paths = pathsFromOptions(options);
    mkdirSync(this.paths.profiles, { recursive: true });
    mkdirSync(this.paths.runtime, { recursive: true });
    mkdirSync(join(this.paths.root, 'bin'), { recursive: true });

    this.db = new TunnelDatabase(this.paths.db, {
      admin: options.adminPort,
      controller: options.controllerPort,
      mixed: options.mixedPort,
      dns: options.dnsPort
    });
    this.api = new MihomoApi(() => this.db.getSettings());
  }

  status(): TunnelStatus {
    const settings = this.db.getSettings();
    const engine = this.engineStatus(settings);
    const corePath = engine.customPath ?? engine.installedPath ?? engine.bundledPath;
    const running = this.isRunning();
    return {
      platform: process.platform,
      running,
      pid: running ? this.child?.pid ?? this.elevatedPid : null,
      mode: settings.mode,
      tunInstalled: settings.tunInstalled,
      health: this.runtimeHealth(settings, running),
      ports: settings.ports,
      activeSubscription: this.db.getActiveSubscription(),
      corePath,
      engine,
      adminUrl: `http://127.0.0.1:${settings.ports.admin}`,
      controllerUrl: `http://127.0.0.1:${settings.ports.controller}`
    };
  }

  async snapshot(): Promise<TunnelSnapshot> {
    return {
      status: this.status(),
      subscriptions: this.listSubscriptions(),
      rules: this.listRules(),
      events: this.listEvents(),
      traffic: await this.trafficSummary()
    };
  }

  async trafficSummary() {
    if (!this.isRunning()) {
      return {
        available: false,
        connections: 0,
        uploadTotal: 0,
        downloadTotal: 0
      };
    }

    try {
      const response = await this.api.connections();
      const data = response.data as {
        connections?: unknown[];
        uploadTotal?: number;
        downloadTotal?: number;
      } | null;

      return {
        available: response.ok,
        connections: Array.isArray(data?.connections) ? data.connections.length : 0,
        uploadTotal: Number(data?.uploadTotal ?? 0),
        downloadTotal: Number(data?.downloadTotal ?? 0)
      };
    } catch {
      return {
        available: false,
        connections: 0,
        uploadTotal: 0,
        downloadTotal: 0
      };
    }
  }

  listSubscriptions(): SubscriptionRecord[] {
    return this.db.listSubscriptions();
  }

  listRules(): DomainRule[] {
    return this.db.listRules();
  }

  listEvents() {
    return this.db.listEvents();
  }

  async createSubscription(input: SubscriptionInput): Promise<SubscriptionRecord> {
    const normalized = normalizeSubscriptionInput(input);
    const content = await this.fetchSubscriptionContent(normalized);
    const subscription = this.db.createSubscription(normalized);

    try {
      const localPath = this.localSubscriptionPath(subscription.id);
      writeFileSync(localPath, content, 'utf8');
      const updated = this.db.updateSubscriptionContent(subscription.id, content, localPath);
      this.log('info', `Subscription created: ${updated.name}`);
      return updated;
    } catch (error) {
      this.db.deleteSubscription(subscription.id);
      throw error;
    }
  }

  async editSubscription(input: SubscriptionUpdateInput): Promise<SubscriptionRecord> {
    const current = this.db.getSubscription(input.id);
    if (!current) {
      throw new Error(`subscription not found: ${input.id}`);
    }

    const normalized = normalizeSubscriptionInput(input);
    const content = await this.fetchSubscriptionContent(normalized);
    const subscription = this.db.updateSubscription(input.id, normalized);
    const localPath = this.localSubscriptionPath(subscription.id);
    writeFileSync(localPath, content, 'utf8');
    const updated = this.db.updateSubscriptionContent(subscription.id, content, localPath);
    this.log('info', `Subscription edited: ${updated.name}`);
    return updated;
  }

  private localSubscriptionPath(id: number): string {
    return join(this.paths.profiles, `subscription-${id}.yaml`);
  }

  private async fetchSubscriptionContent(subscription: SubscriptionInput): Promise<string> {
    const headers: Record<string, string> = {};
    if (subscription.username || subscription.password) {
      headers.Authorization = basicAuthHeader(subscription.username ?? '', subscription.password ?? '');
    }

    this.log('info', `Fetching subscription: ${subscription.url}`);
    const response = await fetch(subscription.url, { headers });
    if (!response.ok) {
      throw new Error(`subscription update failed: HTTP ${response.status}`);
    }

    const content = await response.text();
    if (!content.trim()) {
      throw new Error('subscription update failed: empty body');
    }

    validateSubscriptionYaml(content);
    return content;
  }

  deleteSubscription(id: number): void {
    this.db.deleteSubscription(id);
    this.log('info', `Subscription deleted: ${id}`);
  }

  setActiveSubscription(id: number): SubscriptionRecord {
    const subscription = this.db.setActiveSubscription(id);
    this.log('info', `Active subscription switched: ${subscription.name}`);
    return subscription;
  }

  setMode(mode: RuntimeMode): boolean {
    const settings = this.db.getSettings();
    this.assertRuntimeModeAvailable({ ...settings, mode });
    const current = settings.mode;
    if (current === mode) {
      return false;
    }

    this.db.updateSettings({ mode });
    this.log('info', `Runtime mode switched: ${mode}`);
    return true;
  }

  async setLocalPorts(ports: Partial<Pick<TunnelPorts, 'mixed' | 'dns'>>): Promise<void> {
    const mixed = ports.mixed === undefined ? undefined : normalizePort(ports.mixed, 'mixed port');
    const dns = ports.dns === undefined ? undefined : normalizePort(ports.dns, 'dns port');
    const before = this.db.getSettings().ports;
    const after = this.db.updatePorts({ mixed, dns }).ports;

    this.log('info', `Local ports updated: mixed ${before.mixed}->${after.mixed}, dns ${before.dns}->${after.dns}`);

    await this.applyRuntimeConfigChange();
  }

  installTunFeature(): void {
    const settings = this.db.getSettings();
    this.assertRuntimeModeAvailable({ ...settings, tunInstalled: true });
    this.db.updateSettings({ tunInstalled: true });
    this.log('info', 'TUN feature enabled for generated runtime config');
  }

  uninstallTunFeature(): void {
    const settings = this.db.getSettings();
    this.db.updateSettings({
      tunInstalled: false,
      mode: settings.mode === 'system-tun' ? 'app-rule' : settings.mode
    });
    this.log('info', 'TUN feature disabled for generated runtime config');
  }

  installCoreFromPath(sourcePath: string): string {
    if (!existsSync(sourcePath)) {
      throw new Error(`Tunnel engine not found: ${sourcePath}`);
    }
    const target = join(this.paths.root, 'bin', basename(sourcePath));
    copyFileSync(sourcePath, target);
    this.db.updateSettings({ corePath: target });
    this.log('info', `Mihomo core installed: ${target}`);
    return target;
  }

  setCorePath(corePath: string): void {
    const normalized = corePath.trim() || null;
    this.db.updateSettings({ corePath: normalized });
    this.log('info', `Mihomo core path set: ${normalized ?? 'bundled/default'}`);
  }

  async updateSubscription(id: number): Promise<SubscriptionRecord> {
    const subscription = this.db.getSubscription(id);
    if (!subscription) {
      throw new Error(`subscription not found: ${id}`);
    }

    const content = await this.fetchSubscriptionContent(subscription);

    const localPath = this.localSubscriptionPath(subscription.id);
    writeFileSync(localPath, content, 'utf8');
    const updated = this.db.updateSubscriptionContent(subscription.id, content, localPath);
    this.log('info', `Subscription updated: ${subscription.name}`);
    return updated;
  }

  async updateActiveSubscription(): Promise<SubscriptionRecord> {
    const active = this.db.getActiveSubscription();
    if (!active) {
      throw new Error('no active subscription configured');
    }
    return this.updateSubscription(active.id);
  }

  async applyManagedConfig(input: ManagedTunnelConfigInput = {}): Promise<ManagedTunnelConfigResult> {
    const source = `managed:${normalizeManagedSource(input.source)}`;
    let subscription: SubscriptionRecord | null = null;

    if (input.subscription?.url) {
      const normalized = normalizeSubscriptionInput(input.subscription);
      const existing = this.listSubscriptions().find((row) => (
        row.url === normalized.url || row.name === normalized.name
      ));
      subscription = existing
        ? await this.editSubscription({
            id: existing.id,
            name: normalized.name,
            url: normalized.url,
            username: normalized.username ?? existing.username,
            password: normalized.password ?? existing.password
          })
        : await this.createSubscription(normalized);
      if (!subscription.active) {
        subscription = this.setActiveSubscription(subscription.id);
      }
    } else if (input.autoUpdate !== false) {
      const active = this.db.getActiveSubscription();
      if (active) {
        subscription = await this.updateSubscription(active.id);
      }
    }

    this.db.removeRulesBySource(source);
    for (const domain of normalizeDomainList(input.rules?.blocklist)) {
      this.addDomainRule('block', domain, source);
    }
    for (const domain of normalizeDomainList(input.rules?.allowlist)) {
      this.addDomainRule('allow', domain, source);
    }

    if (input.mode) {
      if (input.mode === 'system-tun' && !this.db.getSettings().tunInstalled) {
        this.installTunFeature();
      }
      this.setMode(input.mode);
    }

    await this.applyRuntimeConfigChange();

    let started = false;
    if (input.autoStart !== false) {
      const settings = this.db.getSettings();
      if (needsElevatedTun(settings) && input.allowSystemTunPrivilege !== true) {
        this.log('warn', 'Managed config requested system TUN autostart; skipped to avoid an administrator prompt');
      } else {
        await this.start();
        started = true;
      }
    }

    return {
      status: this.status(),
      subscription,
      rules: this.listRules(),
      started
    };
  }

  addDomainRule(kind: 'allow' | 'block', domain: string, source = 'manual'): DomainRule {
    const rule = this.db.upsertRule(kind, domain, source);
    this.log('info', `Domain rule saved: ${kind} ${rule.domain}`);
    return rule;
  }

  addPreset(preset: DomainPresetId): DomainRule[] {
    const domains = DOMAIN_PRESETS[preset];
    const rules = domains.map((domain) => this.db.upsertRule('allow', domain, `preset:${preset}`));
    this.log('info', `Preset allowlist added: ${preset}`);
    return rules;
  }

  removePreset(preset: DomainPresetId): number {
    const changes = this.db.removeRulesBySource(`preset:${preset}`);
    this.log('info', `Preset allowlist removed: ${preset} (${changes} rules)`);
    return changes;
  }

  removeDomainRule(id: number): void {
    this.db.removeRule(id);
    this.log('info', `Domain rule removed: ${id}`);
  }

  renderConfig(): string {
    const settings = this.db.getSettings();
    this.assertRuntimeModeAvailable(settings);
    const active = this.db.getActiveSubscription();
    if (!active?.content) {
      throw new Error('active subscription has no downloaded content');
    }

    const rendered = renderRuntimeConfig({
      baseYaml: active.content,
      settings,
      rules: this.db.listRules()
    });
    writeFileSync(this.paths.config, rendered.yaml, 'utf8');
    this.log('info', `Runtime config rendered with policy ${rendered.proxyPolicyName}`);
    return this.paths.config;
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operation.then(task, task);
    this.operation = next.catch(() => undefined);
    return next;
  }

  async start(): Promise<void> {
    await this.runExclusive(() => this.startUnlocked());
  }

  private async startUnlocked(): Promise<void> {
    if (this.isRunning()) {
      return;
    }

    const settings = this.db.getSettings();
    const active = this.db.getActiveSubscription();
    if (!active) {
      throw new Error('还没有启用订阅。请先在「订阅」里新建并启用一个订阅，然后再启动隧道。');
    }
    if (!active.content) {
      throw new Error('当前订阅还没有下载到本地。请先点击「更新当前订阅」或重新启用这个订阅，然后再启动隧道。');
    }

    const corePath = this.resolveCorePath();
    if (!existsSync(corePath)) {
      throw new Error(`当前安装包缺少适配 ${platformArchKey()} 的隧道引擎。请安装对应平台的 @qpjoy/electron-plugin-tunnel-engine 包，或在「代理」页填写本机 mihomo 可执行文件路径。`);
    }

    const configPath = this.renderConfig();
    this.lastRuntimeError = null;
    if (needsElevatedTun(settings)) {
      await this.startElevated(corePath, configPath);
      return;
    }

    this.child = spawn(corePath, ['-d', this.paths.runtime, '-f', configPath], {
      cwd: this.paths.runtime,
      env: {
        ...process.env,
        NO_COLOR: '1'
      }
    });

    this.child.stdout.on('data', (chunk) => this.handleCoreOutput('info', chunk.toString()));
    this.child.stderr.on('data', (chunk) => this.handleCoreOutput('warn', chunk.toString()));
    this.child.on('exit', (code, signal) => {
      this.log(code === 0 ? 'info' : 'warn', `Mihomo exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      this.child = null;
    });

    this.log('info', `Mihomo started pid=${this.child.pid ?? 'unknown'}`);

    if (this.shouldWatchWindowsTun(settings)) {
      await delay(1200);
      if (this.lastRuntimeError) {
        const errorMessage = this.lastRuntimeError;
        await this.stopUnlocked();
        throw new Error(errorMessage);
      }
    }
  }

  private resolveCorePath(): string {
    const settings = this.db.getSettings();
    const engine = this.engineStatus(settings);

    if (engine.source === 'custom' && engine.customPath) {
      return engine.customPath;
    }

    if (engine.source === 'installed' && engine.installedPath) {
      return this.paths.core;
    }

    if (engine.source === 'bundled' && engine.bundledPath) {
      this.installBundledCore(engine.bundledPath);
      return this.paths.core;
    }

    return settings.corePath || this.paths.core;
  }

  private engineStatus(settings = this.db.getSettings()): TunnelStatus['engine'] {
    const customPath = settings.corePath && settings.corePath !== this.paths.core
      ? settings.corePath
      : null;
    const customAvailable = customPath ? existsSync(customPath) : false;
    const installedPath = existsSync(this.paths.core) ? this.paths.core : null;
    const bundledPath = this.findBundledCore();

    if (customAvailable) {
      return {
        target: platformArchKey(),
        available: true,
        source: 'custom',
        customPath,
        installedPath,
        bundledPath
      };
    }

    if (installedPath) {
      return {
        target: platformArchKey(),
        available: true,
        source: 'installed',
        customPath,
        installedPath,
        bundledPath
      };
    }

    if (bundledPath) {
      return {
        target: platformArchKey(),
        available: true,
        source: 'bundled',
        customPath,
        installedPath,
        bundledPath
      };
    }

    return {
      target: platformArchKey(),
      available: false,
      source: 'missing',
      customPath,
      installedPath,
      bundledPath
    };
  }

  private findBundledCore(): string | null {
    const bundledEngineDir = this.options.bundledEngineDir ?? this.options.bundledCoreDir;
    const packageEngineDir = this.optionalEnginePackageDir();

    const key = platformArchKey();
    const aliases = key.endsWith('-x64') ? [key, key.replace('-x64', '-amd64')] : [key];
    const names = process.platform === 'win32'
      ? ['mihomo.exe', 'mihomo.exe.gz', 'mihomo', 'mihomo.gz']
      : ['mihomo', 'mihomo.gz'];
    const roots = [bundledEngineDir, packageEngineDir].filter(Boolean) as string[];
    const candidates = roots.flatMap((root) => aliases.flatMap((alias) => names.map((name) => join(root, alias, name))));

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private optionalEnginePackageDir(): string | null {
    const packageName = `@qpjoy/electron-plugin-tunnel-engine-${platformArchKey()}`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-var-requires
      const packageJsonPath = require.resolve(`${packageName}/package.json`);
      return join(packageJsonPath, '..', 'resources', 'engine');
    } catch {
      return null;
    }
  }

  private installBundledCore(sourcePath: string): void {
    mkdirSync(join(this.paths.root, 'bin'), { recursive: true });

    if (sourcePath.endsWith('.gz')) {
      writeFileSync(this.paths.core, gunzipSync(readFileSync(sourcePath)));
    } else {
      copyFileSync(sourcePath, this.paths.core);
    }

    chmodSync(this.paths.core, 0o755);
    this.db.updateSettings({ corePath: this.paths.core });
    this.log('info', `Bundled Mihomo core installed: ${this.paths.core}`);
  }

  private runElevatedShell(command: string): Promise<string> {
    if (process.platform === 'win32') {
      throw new Error('Windows elevated shell uses PowerShell Start-Process instead.');
    }

    const launcher = process.platform === 'darwin'
      ? {
          command: '/usr/bin/osascript',
          args: ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`]
        }
      : {
          command: existsSync('/usr/bin/pkexec') ? '/usr/bin/pkexec' : '/bin/pkexec',
          args: ['/bin/sh', '-lc', command]
        };

    if (!existsSync(launcher.command)) {
      throw new Error(missingPrivilegeHelperMessage());
    }

    return new Promise((resolve, reject) => {
      const child = spawn(launcher.command, launcher.args);
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }

        reject(new Error(stderr.trim() || stdout.trim() || tunApprovalRequiredMessage()));
      });
    });
  }

  private runWindowsElevatedScript(script: string): Promise<string> {
    const powershell = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';

    return new Promise((resolve, reject) => {
      const child = spawn(powershell, [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShell(script)
      ], { windowsHide: true });
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }

        reject(new Error(stderr.trim() || stdout.trim() || tunApprovalRequiredMessage()));
      });
    });
  }

  private async startElevated(corePath: string, configPath: string): Promise<void> {
    if (process.platform === 'win32') {
      await this.startElevatedWindows(corePath, configPath);
      return;
    }

    const logPath = join(this.paths.runtime, 'mihomo-elevated.log');
    const command = [
      ':',
      '>',
      shellQuote(logPath),
      ';',
      shellQuote(corePath),
      '-d',
      shellQuote(this.paths.runtime),
      '-f',
      shellQuote(configPath),
      '>>',
      shellQuote(logPath),
      '2>&1',
      '&',
      'echo $!'
    ].join(' ');
    const output = await this.runElevatedShell(command);
    const pid = Number(output.split(/\s+/).at(-1));

    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Failed to start privileged tunnel engine: ${output || 'empty pid'}`);
    }

    this.child = null;
    this.rememberElevatedPid(pid);
    await delay(900);
    if (!isProcessAlive(pid)) {
      this.clearElevatedPid();
      const details = this.readElevatedLogTail(logPath);
      throw new Error(`Privileged mihomo exited immediately.${details ? ` ${details}` : ''}`);
    }

    this.log('info', `Mihomo started with administrator privileges pid=${pid}`);
    this.log('info', `Privileged Mihomo log file: ${logPath}`);
  }

  private async startElevatedWindows(corePath: string, configPath: string): Promise<void> {
    const logPath = join(this.paths.runtime, 'mihomo-elevated.log');
    const commandPath = join(this.paths.runtime, 'mihomo-elevated.cmd');
    writeFileSync(logPath, '', 'utf8');
    writeFileSync(
      commandPath,
      [
        '@echo off',
        `${cmdQuote(corePath)} -d ${cmdQuote(this.paths.runtime)} -f ${cmdQuote(configPath)} >> ${cmdQuote(logPath)} 2>&1`
      ].join('\r\n') + '\r\n',
      'utf8'
    );

    const output = await this.runWindowsElevatedScript([
      "$ErrorActionPreference = 'Stop'",
      `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d','/s','/c',${psQuote(`call "${commandPath}"`)}) -Verb RunAs -WindowStyle Hidden -PassThru`,
      '[Console]::Out.WriteLine($p.Id)'
    ].join('\n'));
    const pid = Number(output.split(/\s+/).at(-1));

    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Failed to start privileged tunnel engine: ${output || 'empty pid'}`);
    }

    this.child = null;
    this.rememberElevatedPid(pid);
    await delay(1500);
    if (!isProcessAlive(pid)) {
      this.clearElevatedPid();
      const details = this.readElevatedLogTail(logPath);
      throw new Error(`Privileged mihomo exited immediately.${details ? ` ${details}` : ''}`);
    }

    const details = this.readElevatedLogTail(logPath);
    const runtimeError = this.detectRuntimeError(details);
    if (runtimeError) {
      await this.stopElevatedProcess(pid, { allowElevatedPrompt: true }).catch(() => undefined);
      this.clearElevatedPid();
      throw new Error(runtimeError);
    }

    this.log('info', `Mihomo started with administrator privileges pid=${pid}`);
    this.log('info', `Privileged Mihomo log file: ${logPath}`);
  }

  private readElevatedLogTail(logPath: string): string {
    try {
      const lines = readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .slice(-12)
        .join('\n');

      return lines ? `Recent log:\n${lines}` : '';
    } catch {
      return '';
    }
  }

  private elevatedPidPath(): string {
    return join(this.paths.runtime, 'mihomo-elevated.pid');
  }

  private readElevatedPid(): number | null {
    if (this.elevatedPid && isProcessAlive(this.elevatedPid)) {
      return this.elevatedPid;
    }

    try {
      const pid = Number(readFileSync(this.elevatedPidPath(), 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        this.elevatedPid = pid;
        return pid;
      }
    } catch {
      // Missing or stale pid files are cleaned up by clearElevatedPid().
    }

    this.clearElevatedPid();
    return null;
  }

  private rememberElevatedPid(pid: number): void {
    this.elevatedPid = pid;
    writeFileSync(this.elevatedPidPath(), `${pid}\n`, 'utf8');
  }

  private clearElevatedPid(): void {
    this.elevatedPid = null;
    try {
      unlinkSync(this.elevatedPidPath());
    } catch {
      // It is fine when the pid file does not exist.
    }
  }

  private isRunning(): boolean {
    if (this.child && !this.child.killed) {
      return true;
    }

    if (this.readElevatedPid()) {
      return true;
    }

    return false;
  }

  private isElevatedRunning(): boolean {
    return Boolean(this.readElevatedPid());
  }

  private async stopElevatedProcess(pid: number, options: StopOptions = {}): Promise<void> {
    if (!options.allowElevatedPrompt) {
      this.log('info', 'Privileged Mihomo is still running; skipped elevated stop to avoid another administrator prompt');
      return;
    }

    if (process.platform === 'win32') {
      await this.runWindowsElevatedScript([
        "$ErrorActionPreference = 'Stop'",
        `Start-Process -FilePath 'taskkill.exe' -ArgumentList @('/PID','${pid}','/T','/F') -Verb RunAs -WindowStyle Hidden -Wait`
      ].join('\n'));
    } else {
      await this.runElevatedShell(`kill ${pid} 2>/dev/null || true`);
    }

    this.clearElevatedPid();
    this.log('info', 'Privileged Mihomo stop requested');
  }

  private async reloadRuntimeConfig(): Promise<boolean> {
    const settings = this.db.getSettings();
    this.lastRuntimeError = null;
    const configPath = this.renderConfig();
    let response;
    try {
      response = await this.api.reloadConfig(configPath);
    } catch (error) {
      this.log('warn', `Runtime config hot reload failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    if (response.ok) {
      if (this.shouldWatchWindowsTun(settings)) {
        await delay(1200);
        if (this.lastRuntimeError) {
          this.log('warn', `Runtime config hot reload failed: ${this.lastRuntimeError}`);
          return false;
        }
      }
      this.log('info', 'Runtime config hot reloaded');
      return true;
    }

    this.log('warn', `Runtime config hot reload failed: HTTP ${response.status}`);
    return false;
  }

  async stop(): Promise<void> {
    await this.runExclusive(() => {
      const settings = this.db.getSettings();
      return this.stopUnlocked({ allowElevatedPrompt: settings.mode === 'system-tun' });
    });
  }

  private async stopUnlocked(options: StopOptions = {}): Promise<void> {
    const elevatedPid = this.readElevatedPid();
    if (elevatedPid) {
      const pid = elevatedPid;
      if (!isProcessAlive(pid)) {
        this.clearElevatedPid();
        this.log('info', 'Privileged Mihomo was already stopped');
        return;
      }

      await this.stopElevatedProcess(pid, options);
      return;
    }

    if (!this.child || this.child.killed) {
      return;
    }
    this.child.kill('SIGTERM');
    this.lastRuntimeError = null;
    this.log('info', 'Mihomo stop requested');
  }

  async restart(): Promise<void> {
    await this.runExclusive(async () => {
      if (this.isElevatedRunning()) {
        const reloaded = await this.reloadRuntimeConfig();
        if (reloaded) {
          return;
        }

        this.log('warn', 'Privileged Mihomo restart skipped because it would require another administrator prompt');
        return;
      }

      await this.stopUnlocked();
      await delay(400);
      await this.startUnlocked();
    });
  }

  async applyRuntimeConfigChange(): Promise<void> {
    await this.runExclusive(async () => {
      if (!this.isRunning()) {
        return;
      }

      const settings = this.db.getSettings();
      this.assertRuntimeModeAvailable(settings);
      if (needsElevatedTun(settings) && !this.isElevatedRunning()) {
        await this.stopUnlocked();
        await delay(400);
        await this.startUnlocked();
        return;
      }

      const reloaded = await this.reloadRuntimeConfig();
      if (!reloaded && !this.isElevatedRunning()) {
        await this.stopUnlocked();
        await delay(400);
        await this.startUnlocked();
      }
    });
  }

  async handleNetworkChanged(reason: string): Promise<void> {
    this.log('info', `Network change detected: ${reason}`);

    if (!this.isRunning()) {
      return;
    }

    await this.applyRuntimeConfigChange();
  }

  async close(): Promise<void> {
    await this.stopUnlocked({ allowElevatedPrompt: false }).catch((err) => {
      this.log('warn', `Mihomo close stop failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    await delay(300);
    this.db.close();
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    const clean = message.trim();
    if (!clean) {
      return;
    }
    this.db.addEvent(level, clean);
    this.emit('event', { level, message: clean });
  }

  private assertRuntimeModeAvailable(settings: RuntimeSettings): void {
    if (settings.mode !== 'system-tun') {
      return;
    }

    if (!settings.tunInstalled) {
      throw new Error('虚拟网卡模式还没有启用 TUN 配置。请先在「代理」页点击「安装 TUN」，或切回 App 模式。');
    }
  }

  private runtimeHealth(settings: RuntimeSettings, running: boolean): TunnelStatus['health'] {
    if (running && this.lastRuntimeError) {
      return {
        ok: false,
        level: 'error',
        message: this.lastRuntimeError
      };
    }

    return {
      ok: true,
      level: 'ok',
      message: null
    };
  }

  private handleCoreOutput(defaultLevel: 'info' | 'warn' | 'error', message: string): void {
    const clean = message.trim();
    if (!clean) {
      return;
    }

    const runtimeError = this.detectRuntimeError(clean);
    if (runtimeError) {
      if (this.lastRuntimeError !== runtimeError) {
        this.log('error', runtimeError);
      }
      this.lastRuntimeError = runtimeError;
    }

    const level = /level=error|\berror\b/i.test(clean) ? 'error' : defaultLevel;
    this.log(level, clean);
  }

  private detectRuntimeError(message: string): string | null {
    if (/Start TUN listening error|configure tun interface|Access is denied/i.test(message)) {
      return tunAdministratorMessage();
    }

    return null;
  }

  private shouldWatchWindowsTun(settings: RuntimeSettings): boolean {
    return process.platform === 'win32' && settings.mode === 'system-tun' && settings.tunInstalled;
  }
}
