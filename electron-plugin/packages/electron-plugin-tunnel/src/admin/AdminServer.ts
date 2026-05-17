import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { parse as parseUrl } from 'url';

import { createSessionToken, verifyPassword } from '../security';
import type { DomainPresetId } from '../defaults';
import type { MihomoManager } from '../mihomo/MihomoManager';
import { adminHtml } from './admin-ui';

type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;

interface AdminServerOptions {
  afterSettingsChange?: () => Promise<void> | void;
  openTestWindow?: (url: string) => Promise<void> | void;
}

const sessions = new Set<string>();

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, data: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    return false;
  }
  return sessions.has(header.slice('Bearer '.length));
}

function normalizeHttpUrl(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) {
    throw new Error('测试网址不能为空');
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error('测试网址格式不正确');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('测试网址必须使用 http 或 https');
  }

  return parsed.toString();
}

export class AdminServer {
  private server: Server | null = null;

  constructor(private readonly manager: MihomoManager, private readonly options: AdminServerOptions = {}) {}

  start(): void {
    if (this.server) {
      return;
    }

    const settings = this.manager.db.getSettings();
    this.server = createServer(async (req, res) => {
      try {
        await this.handle(req, res);
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    this.server.listen(settings.ports.admin, '127.0.0.1');
  }

  /**
   * Stop the HTTP server and wait for the port to actually release. Used
   * by the plugin's `close()` so an immediate re-`activate()` (e.g. after
   * an upgrade) doesn't hit EADDRINUSE.
   */
  async stop(): Promise<void> {
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    // Drop keep-alive sockets so close() returns promptly.
    s.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      s.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const pathname = parseUrl(req.url ?? '/', true).pathname ?? '/';

    if (method === 'GET' && pathname === '/') {
      sendText(res, 200, adminHtml(), 'text/html; charset=utf-8');
      return;
    }

    const body = await readBody(req);

    if (method === 'POST' && pathname === '/api/login') {
      const { username, password } = body as { username?: string; password?: string };
      const settings = this.manager.db.getSettings();
      if (username === settings.adminUser && password && verifyPassword(password, settings.adminPasswordHash)) {
        const token = createSessionToken();
        sessions.add(token);
        sendJson(res, 200, { token });
        return;
      }
      sendJson(res, 401, { error: 'invalid credentials' });
      return;
    }

    if (!isAuthed(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const route = this.route(method, pathname);
    if (!route) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    await route(req, res, body);
  }

  private async applyRuntimeConfigChange(): Promise<void> {
    await this.manager.applyRuntimeConfigChange();
    await this.options.afterSettingsChange?.();
  }

  private async notifySettingsChange(): Promise<void> {
    await this.options.afterSettingsChange?.();
  }

  private route(method: string, pathname: string): RouteHandler | null {
    if (method === 'GET' && pathname === '/api/snapshot') {
      return async (_req, res) => sendJson(res, 200, await this.manager.snapshot());
    }
    if (method === 'POST' && pathname === '/api/mode') {
      return async (_req, res, body) => {
        const { mode } = body as { mode: never };
        const changedMode = this.manager.setMode(mode);
        if (changedMode) {
          await this.applyRuntimeConfigChange();
        } else {
          await this.notifySettingsChange();
        }
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/ports') {
      return async (_req, res, body) => {
        const { mixed, dns } = body as { mixed: number; dns: number };
        await this.manager.setLocalPorts({ mixed, dns });
        await this.notifySettingsChange();
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/tun/install') {
      return async (_req, res) => {
        this.manager.installTunFeature();
        await this.applyRuntimeConfigChange();
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/tun/uninstall') {
      return async (_req, res) => {
        this.manager.uninstallTunFeature();
        await this.applyRuntimeConfigChange();
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/core/start') {
      return async (_req, res) => {
        await this.manager.start();
        await this.notifySettingsChange();
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/core/stop') {
      return async (_req, res) => {
        await this.manager.stop();
        await this.notifySettingsChange();
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/core/restart') {
      return async (_req, res) => {
        await this.manager.restart();
        await this.notifySettingsChange();
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/core/path') {
      return async (_req, res, body) => {
        const { corePath } = body as { corePath: string };
        this.manager.setCorePath(corePath);
        await this.notifySettingsChange();
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/test/window') {
      return async (_req, res, body) => {
        if (!this.options.openTestWindow) {
          throw new Error('当前宿主不支持打开测试窗口');
        }
        const url = normalizeHttpUrl((body as { url?: unknown }).url);
        await this.options.openTestWindow(url);
        sendJson(res, 200, { ok: true, url });
      };
    }
    if (method === 'POST' && pathname === '/api/subscriptions') {
      return async (_req, res, body) => {
        const subscription = await this.manager.createSubscription(body as never);
        if (subscription.active) {
          await this.applyRuntimeConfigChange();
        } else {
          await this.notifySettingsChange();
        }
        sendJson(res, 200, subscription);
      };
    }
    if (method === 'POST' && pathname === '/api/subscriptions/active/update') {
      return async (_req, res) => {
        const subscription = await this.manager.updateActiveSubscription();
        await this.applyRuntimeConfigChange();
        sendJson(res, 200, subscription);
      };
    }

    const activeMatch = pathname.match(/^\/api\/subscriptions\/(\d+)\/active$/);
    if (method === 'POST' && activeMatch) {
      return async (_req, res) => {
        const subscription = this.manager.setActiveSubscription(Number(activeMatch[1]));
        await this.applyRuntimeConfigChange();
        sendJson(res, 200, subscription);
      };
    }
    const updateMatch = pathname.match(/^\/api\/subscriptions\/(\d+)\/update$/);
    if (method === 'POST' && updateMatch) {
      return async (_req, res) => {
        const subscription = await this.manager.updateSubscription(Number(updateMatch[1]));
        if (subscription.active) {
          await this.applyRuntimeConfigChange();
        }
        sendJson(res, 200, subscription);
      };
    }
    const editSubscriptionMatch = pathname.match(/^\/api\/subscriptions\/(\d+)$/);
    if ((method === 'PATCH' || method === 'PUT') && editSubscriptionMatch) {
      return async (_req, res, body) => {
        const input = body as { name: string; url: string; username?: string; password?: string };
        const subscription = await this.manager.editSubscription({
          ...input,
          id: Number(editSubscriptionMatch[1])
        });
        if (subscription.active) {
          await this.applyRuntimeConfigChange();
        } else {
          await this.notifySettingsChange();
        }
        sendJson(res, 200, subscription);
      };
    }
    const deleteSubscriptionMatch = pathname.match(/^\/api\/subscriptions\/(\d+)$/);
    if (method === 'DELETE' && deleteSubscriptionMatch) {
      return async (_req, res) => {
        this.manager.deleteSubscription(Number(deleteSubscriptionMatch[1]));
        await this.applyRuntimeConfigChange();
        sendJson(res, 200, { ok: true });
      };
    }
    if (method === 'POST' && pathname === '/api/rules') {
      return async (_req, res, body) => {
        const { kind, domain } = body as { kind: 'allow' | 'block'; domain: string };
        const rule = this.manager.addDomainRule(kind, domain);
        await this.applyRuntimeConfigChange();
        sendJson(res, 200, rule);
      };
    }
    const ruleDeleteMatch = pathname.match(/^\/api\/rules\/(\d+)$/);
    if (method === 'DELETE' && ruleDeleteMatch) {
      return async (_req, res) => {
        this.manager.removeDomainRule(Number(ruleDeleteMatch[1]));
        await this.applyRuntimeConfigChange();
        sendJson(res, 200, { ok: true });
      };
    }
    const presetMatch = pathname.match(/^\/api\/presets\/([a-z]+)$/);
    if (method === 'POST' && presetMatch) {
      return async (_req, res) => {
        const rules = this.manager.addPreset(presetMatch[1] as DomainPresetId);
        await this.applyRuntimeConfigChange();
        sendJson(res, 200, rules);
      };
    }
    if (method === 'DELETE' && presetMatch) {
      return async (_req, res) => {
        const count = this.manager.removePreset(presetMatch[1] as DomainPresetId);
        await this.applyRuntimeConfigChange();
        sendJson(res, 200, { ok: true, count });
      };
    }

    return null;
  }
}
