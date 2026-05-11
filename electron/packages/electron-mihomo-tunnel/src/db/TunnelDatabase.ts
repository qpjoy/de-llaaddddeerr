import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USER,
  DEFAULT_MODE,
  DEFAULT_PORTS,
  createControllerSecret
} from '../defaults';
import type {
  DomainRule,
  DomainRuleKind,
  EventRecord,
  RuntimeSettings,
  SubscriptionInput,
  SubscriptionRecord,
  TunnelPorts
} from '../types';
import { hashPassword } from '../security';
import { SCHEMA_SQL } from './schema';

type Row = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function toBool(value: unknown): boolean {
  return Number(value) === 1;
}

function mergePorts(ports: Partial<TunnelPorts>): TunnelPorts {
  return {
    admin: ports.admin ?? DEFAULT_PORTS.admin,
    controller: ports.controller ?? DEFAULT_PORTS.controller,
    mixed: ports.mixed ?? DEFAULT_PORTS.mixed,
    dns: ports.dns ?? DEFAULT_PORTS.dns
  };
}

function mapSettings(row: Row): RuntimeSettings {
  return {
    id: Number(row.id),
    mode: String(row.mode) as RuntimeSettings['mode'],
    ports: {
      admin: Number(row.admin_port),
      controller: Number(row.controller_port),
      mixed: Number(row.mixed_port),
      dns: Number(row.dns_port)
    },
    adminUser: String(row.admin_user),
    adminPasswordHash: String(row.admin_password_hash),
    controllerSecret: String(row.controller_secret),
    corePath: row.core_path ? String(row.core_path) : null,
    tunInstalled: toBool(row.tun_installed),
    activeSubscriptionId: row.active_subscription_id ? Number(row.active_subscription_id) : null,
    updatedAt: String(row.updated_at)
  };
}

function mapSubscription(row: Row): SubscriptionRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    url: String(row.url),
    username: String(row.username ?? ''),
    password: String(row.password ?? ''),
    localPath: row.local_path ? String(row.local_path) : null,
    content: row.content ? String(row.content) : null,
    active: toBool(row.active),
    lastUpdatedAt: row.last_updated_at ? String(row.last_updated_at) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function mapRule(row: Row): DomainRule {
  return {
    id: Number(row.id),
    kind: String(row.kind) as DomainRuleKind,
    domain: String(row.domain),
    source: String(row.source),
    enabled: toBool(row.enabled),
    createdAt: String(row.created_at)
  };
}

export class TunnelDatabase {
  private readonly db: Database.Database;

  constructor(dbPath: string, ports: Partial<TunnelPorts> = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA_SQL);
    this.ensureDefaultSettings(mergePorts(ports));
  }

  close(): void {
    this.db.close();
  }

  getSettings(): RuntimeSettings {
    const row = this.db.prepare('SELECT * FROM runtime_settings WHERE id = 1').get() as Row | undefined;
    if (!row) {
      throw new Error('runtime settings row is missing');
    }
    return mapSettings(row);
  }

  updateSettings(patch: Partial<Pick<RuntimeSettings, 'mode' | 'corePath' | 'tunInstalled' | 'activeSubscriptionId'>>): RuntimeSettings {
    const current = this.getSettings();
    const next = {
      mode: patch.mode ?? current.mode,
      corePath: patch.corePath === undefined ? current.corePath : patch.corePath,
      tunInstalled: patch.tunInstalled === undefined ? current.tunInstalled : patch.tunInstalled,
      activeSubscriptionId: patch.activeSubscriptionId === undefined ? current.activeSubscriptionId : patch.activeSubscriptionId,
      updatedAt: nowIso()
    };

    this.db.prepare(`
      UPDATE runtime_settings
      SET mode = @mode,
          core_path = @corePath,
          tun_installed = @tunInstalled,
          active_subscription_id = @activeSubscriptionId,
          updated_at = @updatedAt
      WHERE id = 1
    `).run({
      ...next,
      tunInstalled: next.tunInstalled ? 1 : 0
    });

    return this.getSettings();
  }

  updatePorts(patch: Partial<Pick<TunnelPorts, 'mixed' | 'dns'>>): RuntimeSettings {
    const current = this.getSettings();
    const mixedPort = patch.mixed ?? current.ports.mixed;
    const dnsPort = patch.dns ?? current.ports.dns;

    this.db.prepare(`
      UPDATE runtime_settings
      SET mixed_port = @mixedPort,
          dns_port = @dnsPort,
          updated_at = @updatedAt
      WHERE id = 1
    `).run({
      mixedPort,
      dnsPort,
      updatedAt: nowIso()
    });

    return this.getSettings();
  }

  updateAdminPassword(username: string, password: string): RuntimeSettings {
    this.db.prepare(`
      UPDATE runtime_settings
      SET admin_user = @username,
          admin_password_hash = @passwordHash,
          updated_at = @updatedAt
      WHERE id = 1
    `).run({
      username,
      passwordHash: hashPassword(password),
      updatedAt: nowIso()
    });
    return this.getSettings();
  }

  listSubscriptions(): SubscriptionRecord[] {
    const rows = this.db.prepare('SELECT * FROM subscriptions ORDER BY active DESC, updated_at DESC').all() as Row[];
    return rows.map(mapSubscription);
  }

  getSubscription(id: number): SubscriptionRecord | null {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(id) as Row | undefined;
    return row ? mapSubscription(row) : null;
  }

  getActiveSubscription(): SubscriptionRecord | null {
    const row = this.db.prepare('SELECT * FROM subscriptions WHERE active = 1 ORDER BY updated_at DESC LIMIT 1').get() as Row | undefined;
    return row ? mapSubscription(row) : null;
  }

  createSubscription(input: SubscriptionInput): SubscriptionRecord {
    const stamp = nowIso();
    const result = this.db.prepare(`
      INSERT INTO subscriptions (name, url, username, password, created_at, updated_at)
      VALUES (@name, @url, @username, @password, @createdAt, @updatedAt)
    `).run({
      name: input.name,
      url: input.url,
      username: input.username ?? '',
      password: input.password ?? '',
      createdAt: stamp,
      updatedAt: stamp
    });

    const created = this.getSubscription(Number(result.lastInsertRowid));
    if (!created) {
      throw new Error('failed to create subscription');
    }

    if (this.listSubscriptions().length === 1) {
      this.setActiveSubscription(created.id);
    }

    return this.getSubscription(created.id) ?? created;
  }

  deleteSubscription(id: number): void {
    this.db.prepare('DELETE FROM subscriptions WHERE id = ?').run(id);
    const active = this.getActiveSubscription();
    if (!active) {
      this.updateSettings({ activeSubscriptionId: null });
    }
  }

  setActiveSubscription(id: number): SubscriptionRecord {
    const subscription = this.getSubscription(id);
    if (!subscription) {
      throw new Error(`subscription not found: ${id}`);
    }

    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE subscriptions SET active = 0').run();
      this.db.prepare('UPDATE subscriptions SET active = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
      this.updateSettings({ activeSubscriptionId: id });
    });
    tx();

    const active = this.getSubscription(id);
    if (!active) {
      throw new Error(`subscription not found after activation: ${id}`);
    }
    return active;
  }

  updateSubscriptionContent(id: number, content: string, localPath: string): SubscriptionRecord {
    this.db.prepare(`
      UPDATE subscriptions
      SET content = @content,
          local_path = @localPath,
          last_updated_at = @lastUpdatedAt,
          updated_at = @updatedAt
      WHERE id = @id
    `).run({
      id,
      content,
      localPath,
      lastUpdatedAt: nowIso(),
      updatedAt: nowIso()
    });

    const subscription = this.getSubscription(id);
    if (!subscription) {
      throw new Error(`subscription not found: ${id}`);
    }
    return subscription;
  }

  listRules(): DomainRule[] {
    const rows = this.db.prepare('SELECT * FROM domain_rules ORDER BY kind ASC, source ASC, domain ASC').all() as Row[];
    return rows.map(mapRule);
  }

  upsertRule(kind: DomainRuleKind, domain: string, source = 'manual'): DomainRule {
    const normalized = domain.trim().toLowerCase().replace(/^\.+/, '');
    if (!normalized) {
      throw new Error('domain is required');
    }
    const createdAt = nowIso();
    this.db.prepare(`
      INSERT INTO domain_rules (kind, domain, source, enabled, created_at)
      VALUES (@kind, @domain, @source, 1, @createdAt)
      ON CONFLICT(kind, domain) DO UPDATE SET
        source = excluded.source,
        enabled = 1
    `).run({ kind, domain: normalized, source, createdAt });

    const row = this.db.prepare('SELECT * FROM domain_rules WHERE kind = ? AND domain = ?').get(kind, normalized) as Row | undefined;
    if (!row) {
      throw new Error(`failed to upsert rule: ${normalized}`);
    }
    return mapRule(row);
  }

  removeRule(id: number): void {
    this.db.prepare('DELETE FROM domain_rules WHERE id = ?').run(id);
  }

  addEvent(level: EventRecord['level'], message: string): void {
    this.db.prepare(`
      INSERT INTO events (level, message, created_at)
      VALUES (?, ?, ?)
    `).run(level, message, nowIso());
  }

  listEvents(limit = 200): EventRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM events
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as Row[];

    return rows.map((row) => ({
      id: Number(row.id),
      level: String(row.level) as EventRecord['level'],
      message: String(row.message),
      createdAt: String(row.created_at)
    }));
  }

  private ensureDefaultSettings(ports: TunnelPorts): void {
    const row = this.db.prepare('SELECT id FROM runtime_settings WHERE id = 1').get();
    if (row) {
      return;
    }

    this.db.prepare(`
      INSERT INTO runtime_settings (
        id, mode, admin_port, controller_port, mixed_port, dns_port,
        admin_user, admin_password_hash, controller_secret, tun_installed,
        updated_at
      )
      VALUES (
        1, @mode, @adminPort, @controllerPort, @mixedPort, @dnsPort,
        @adminUser, @adminPasswordHash, @controllerSecret, 0,
        @updatedAt
      )
    `).run({
      mode: DEFAULT_MODE,
      adminPort: ports.admin,
      controllerPort: ports.controller,
      mixedPort: ports.mixed,
      dnsPort: ports.dns,
      adminUser: DEFAULT_ADMIN_USER,
      adminPasswordHash: hashPassword(DEFAULT_ADMIN_PASSWORD),
      controllerSecret: createControllerSecret(),
      updatedAt: nowIso()
    });
  }
}
