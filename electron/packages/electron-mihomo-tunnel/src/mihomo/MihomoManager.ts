import { EventEmitter } from 'events';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

import { TunnelDatabase } from '../db/TunnelDatabase';
import { DOMAIN_PRESETS, type DomainPresetId } from '../defaults';
import { renderRuntimeConfig } from '../config/renderRuntimeConfig';
import { MihomoApi } from './MihomoApi';
import type {
  DomainRule,
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

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function normalizeSubscriptionInput(input: SubscriptionInput): SubscriptionInput {
  if (!input.url) {
    throw new Error('subscription url is required');
  }

  const parsed = new URL(input.url);
  const username = input.username || decodeURIComponent(parsed.username);
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
    return {
      running: Boolean(this.child && !this.child.killed),
      pid: this.child?.pid ?? null,
      mode: settings.mode,
      tunInstalled: settings.tunInstalled,
      ports: settings.ports,
      activeSubscription: this.db.getActiveSubscription(),
      corePath: settings.corePath,
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
    if (!this.child || this.child.killed) {
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

  createSubscription(input: SubscriptionInput): SubscriptionRecord {
    const subscription = this.db.createSubscription(normalizeSubscriptionInput(input));
    this.log('info', `Subscription created: ${subscription.name}`);
    return subscription;
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

  setMode(mode: RuntimeMode): void {
    this.db.updateSettings({ mode });
    this.log('info', `Runtime mode switched: ${mode}`);
  }

  async setLocalPorts(ports: Partial<Pick<TunnelPorts, 'mixed' | 'dns'>>): Promise<void> {
    const mixed = ports.mixed === undefined ? undefined : normalizePort(ports.mixed, 'mixed port');
    const dns = ports.dns === undefined ? undefined : normalizePort(ports.dns, 'dns port');
    const before = this.db.getSettings().ports;
    const after = this.db.updatePorts({ mixed, dns }).ports;

    this.log('info', `Local ports updated: mixed ${before.mixed}->${after.mixed}, dns ${before.dns}->${after.dns}`);

    if (this.child && !this.child.killed) {
      await this.restart();
    }
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
    this.db.updateSettings({ corePath });
    this.log('info', `Mihomo core path set: ${corePath}`);
  }

  async updateSubscription(id: number): Promise<SubscriptionRecord> {
    const subscription = this.db.getSubscription(id);
    if (!subscription) {
      throw new Error(`subscription not found: ${id}`);
    }

    const headers: Record<string, string> = {};
    if (subscription.username || subscription.password) {
      headers.Authorization = basicAuthHeader(subscription.username, subscription.password);
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

    const localPath = join(this.paths.profiles, `subscription-${subscription.id}.yaml`);
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

  async start(): Promise<void> {
    if (this.child && !this.child.killed) {
      return;
    }

    const settings = this.db.getSettings();
    const corePath = settings.corePath ?? this.paths.core;
    if (!existsSync(corePath)) {
      throw new Error(`mihomo core is not installed: ${corePath}`);
    }

    const configPath = this.renderConfig();
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

  async stop(): Promise<void> {
    if (!this.child || this.child.killed) {
      return;
    }
    this.child.kill('SIGTERM');
    this.log('info', 'Mihomo stop requested');
  }

  async restart(): Promise<void> {
    await this.stop();
    await new Promise((resolve) => setTimeout(resolve, 400));
    await this.start();
  }

  async handleNetworkChanged(reason: string): Promise<void> {
    const settings = this.db.getSettings();
    this.log('info', `Network change detected: ${reason}`);

    if (!this.child || this.child.killed) {
      return;
    }

    if (settings.mode === 'system-tun' && settings.tunInstalled) {
      this.log('info', 'Reapplying TUN routing after network change');
      await this.restart();
      return;
    }

    this.renderConfig();
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
