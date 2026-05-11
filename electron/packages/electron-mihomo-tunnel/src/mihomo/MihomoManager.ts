import { EventEmitter } from 'events';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { gunzipSync } from 'zlib';
import { parse } from 'yaml';

import { TunnelDatabase } from '../db/TunnelDatabase';
import { DOMAIN_PRESETS, type DomainPresetId } from '../defaults';
import { renderRuntimeConfig } from '../config/renderRuntimeConfig';
import { MihomoApi } from './MihomoApi';
import type {
  DomainRule,
  RuntimeSettings,
  RuntimeMode,
  SubscriptionInput,
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

function pathsFromOptions(options: TunnelManagerOptions): ManagerPaths {
  const root = join(options.userDataPath, 'mihomo-tunnel');
  return {
    root,
    db: join(root, 'tunnel.sqlite'),
    profiles: join(root, 'profiles'),
    runtime: join(root, 'runtime'),
    config: join(root, 'runtime', 'config.yaml'),
    core: join(root, 'bin', 'mihomo')
  };
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
    && (process.platform === 'darwin' || process.platform === 'linux');
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

function validateSubscriptionYaml(content: string): void {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch {
    throw new Error('subscription yaml is invalid');
  }

  if (!isRecord(parsed)) {
    throw new Error('subscription yaml is invalid');
  }

  if (
    !Array.isArray(parsed.proxies)
    && !Array.isArray(parsed['proxy-groups'])
    && !isRecord(parsed['proxy-providers'])
  ) {
    throw new Error('subscription yaml has no proxy definitions');
  }
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
    const corePath = settings.corePath ?? (existsSync(this.paths.core) ? this.paths.core : null);
    const running = this.isRunning();
    return {
      running,
      pid: running ? this.child?.pid ?? this.elevatedPid : null,
      mode: settings.mode,
      tunInstalled: settings.tunInstalled,
      ports: settings.ports,
      activeSubscription: this.db.getActiveSubscription(),
      corePath,
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
    const current = this.db.getSettings().mode;
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
      throw new Error(`mihomo core not found: ${sourcePath}`);
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

  removeDomainRule(id: number): void {
    this.db.removeRule(id);
    this.log('info', `Domain rule removed: ${id}`);
  }

  renderConfig(): string {
    const settings = this.db.getSettings();
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
    const corePath = this.resolveCorePath();
    if (!existsSync(corePath)) {
      throw new Error(`mihomo core is not installed: ${corePath}. Put bundled core under ${this.options.bundledCoreDir ?? 'app resources/mihomo'} or set a valid core path.`);
    }

    const configPath = this.renderConfig();
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

    this.child.stdout.on('data', (chunk) => this.log('info', chunk.toString().trim()));
    this.child.stderr.on('data', (chunk) => this.log('warn', chunk.toString().trim()));
    this.child.on('exit', (code, signal) => {
      this.log(code === 0 ? 'info' : 'warn', `Mihomo exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      this.child = null;
    });

    this.log('info', `Mihomo started pid=${this.child.pid ?? 'unknown'}`);
  }

  private resolveCorePath(): string {
    const settings = this.db.getSettings();
    if (settings.corePath && existsSync(settings.corePath)) {
      return settings.corePath;
    }

    if (existsSync(this.paths.core)) {
      return this.paths.core;
    }

    const bundled = this.findBundledCore();
    if (bundled) {
      this.installBundledCore(bundled);
      return this.paths.core;
    }

    return settings.corePath || this.paths.core;
  }

  private findBundledCore(): string | null {
    if (!this.options.bundledCoreDir) {
      return null;
    }

    const key = platformArchKey();
    const aliases = key.endsWith('-x64') ? [key, key.replace('-x64', '-amd64')] : [key];
    const names = ['mihomo', 'mihomo.gz'];
    const candidates = aliases.flatMap((alias) => names.map((name) => join(this.options.bundledCoreDir as string, alias, name)));

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
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
      throw new Error('TUN mode requires administrator privileges, but no supported privilege helper was found.');
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

        reject(new Error(stderr.trim() || stdout.trim() || 'TUN mode requires administrator approval.'));
      });
    });
  }

  private async startElevated(corePath: string, configPath: string): Promise<void> {
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
      throw new Error(`Failed to start privileged mihomo core: ${output || 'empty pid'}`);
    }

    this.child = null;
    this.elevatedPid = pid;
    await delay(900);
    if (!isProcessAlive(pid)) {
      this.elevatedPid = null;
      const details = this.readElevatedLogTail(logPath);
      throw new Error(`Privileged mihomo exited immediately.${details ? ` ${details}` : ''}`);
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

  private isRunning(): boolean {
    if (this.child && !this.child.killed) {
      return true;
    }

    if (this.elevatedPid && isProcessAlive(this.elevatedPid)) {
      return true;
    }

    this.elevatedPid = null;
    return false;
  }

  private isElevatedRunning(): boolean {
    return Boolean(this.elevatedPid && isProcessAlive(this.elevatedPid));
  }

  private async reloadRuntimeConfig(): Promise<boolean> {
    const configPath = this.renderConfig();
    const response = await this.api.reloadConfig(configPath);
    if (response.ok) {
      this.log('info', 'Runtime config hot reloaded');
      return true;
    }

    this.log('warn', `Runtime config hot reload failed: HTTP ${response.status}`);
    return false;
  }

  async stop(): Promise<void> {
    await this.runExclusive(() => this.stopUnlocked());
  }

  private async stopUnlocked(): Promise<void> {
    if (this.elevatedPid) {
      const pid = this.elevatedPid;
      if (!isProcessAlive(pid)) {
        this.elevatedPid = null;
        this.log('info', 'Privileged Mihomo was already stopped');
        return;
      }

      await this.runElevatedShell(`kill ${pid} 2>/dev/null || true`);
      this.elevatedPid = null;
      this.log('info', 'Privileged Mihomo stop requested');
      return;
    }

    if (!this.child || this.child.killed) {
      return;
    }
    this.child.kill('SIGTERM');
    this.log('info', 'Mihomo stop requested');
  }

  async restart(): Promise<void> {
    await this.runExclusive(async () => {
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

  close(): void {
    void this.stop();
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
}
