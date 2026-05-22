import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parse as parseUrl } from 'node:url';

import type { HdoController } from '../HdoController';
import { adminHtml } from './admin-ui';

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown
) => Promise<void> | void;

export interface HdoAdminServerOptions {
  port: number;
}

export class HdoAdminServer {
  private server: Server | null = null;

  constructor(
    private readonly controller: HdoController,
    private readonly options: HdoAdminServerOptions
  ) {}

  start(): void {
    if (this.server) return;
    this.server = createServer(async (req, res) => {
      try {
        await this.handle(req, res);
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    this.server.listen(this.options.port, '127.0.0.1');
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const pathname = parseUrl(req.url ?? '/', true).pathname ?? '/';

    if (method === 'GET' && pathname === '/') {
      sendText(res, 200, adminHtml(), 'text/html; charset=utf-8');
      return;
    }

    const route = this.route(method, pathname);
    if (!route) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const body = method === 'GET' ? {} : await readBody(req);
    await route(req, res, body);
  }

  private route(method: string, pathname: string): RouteHandler | null {
    if (method === 'GET' && pathname === '/api/snapshot') {
      return async (_req, res) => sendJson(res, 200, await this.controller.snapshot());
    }
    if (method === 'GET' && pathname === '/api/install-commands') {
      return (_req, res) => sendJson(res, 200, this.controller.installCommands());
    }
    if (method === 'POST' && pathname === '/api/settings') {
      return (_req, res, body) => {
        sendJson(res, 200, this.controller.updateSettings(body as never));
      };
    }
    if (method === 'POST' && pathname === '/api/client/register') {
      return async (_req, res, body) => {
        sendJson(res, 200, await this.controller.registerDevice(body as never));
      };
    }
    if (method === 'POST' && pathname === '/api/client/manifest') {
      return async (_req, res, body) => {
        const { deviceId } = body as { deviceId?: string | null };
        sendJson(res, 200, await this.controller.refreshManifest(deviceId));
      };
    }
    if (method === 'POST' && pathname === '/api/client/subscription') {
      return async (_req, res, body) => {
        const { deviceId } = body as { deviceId?: string | null };
        sendText(res, 200, await this.controller.refreshSubscription(deviceId), 'text/yaml; charset=utf-8');
      };
    }
    if (method === 'POST' && pathname === '/api/client/plugin-states') {
      return async (_req, res, body) => {
        const { deviceId } = body as { deviceId?: string | null };
        sendJson(res, 200, await this.controller.reportPluginStates(deviceId));
      };
    }
    if (method === 'POST' && pathname === '/api/client/wireguard/prepare') {
      return async (_req, res, body) => {
        sendJson(res, 200, await this.controller.prepareWireGuardPeer(body as never));
      };
    }
    if (method === 'POST' && pathname === '/api/client/wireguard/open') {
      return async (_req, res) => {
        sendJson(res, 200, await this.controller.openWireGuardProfile());
      };
    }
    if (method === 'POST' && pathname === '/api/client/wireguard/connect') {
      return async (_req, res, body) => {
        sendJson(res, 200, await this.controller.connectWireGuardPeer(body as never));
      };
    }
    if (method === 'POST' && pathname === '/api/client/wireguard/recover') {
      return async (_req, res, body) => {
        const { reason, allowPrivileged } = body as { reason?: string | null; allowPrivileged?: boolean | null };
        sendJson(
          res,
          200,
          await this.controller.recoverWireGuardPeer({
            reason: reason || 'api',
            allowPrivileged: allowPrivileged !== false
          })
        );
      };
    }
    if (method === 'GET' && pathname === '/api/client/wireguard/status') {
      return (_req, res) => {
        sendJson(res, 200, this.controller.wireGuardStatus());
      };
    }
    if (method === 'POST' && pathname === '/api/client/wireguard/repair-routes') {
      return async (_req, res) => {
        sendJson(res, 200, await this.controller.repairWireGuardRoutes());
      };
    }
    if (method === 'GET' && pathname === '/api/client/wireguard/daemon/status') {
      return (_req, res) => {
        sendJson(res, 200, this.controller.wireGuardLaunchDaemonStatus());
      };
    }
    if (method === 'POST' && pathname === '/api/client/wireguard/daemon/install') {
      return async (_req, res) => {
        sendJson(res, 200, await this.controller.installWireGuardLaunchDaemon());
      };
    }
    if (method === 'POST' && pathname === '/api/client/wireguard/daemon/uninstall') {
      return async (_req, res, body) => {
        sendJson(res, 200, await this.controller.uninstallWireGuardLaunchDaemon(body as never));
      };
    }
    if (method === 'POST' && pathname === '/api/client/tasks/run') {
      return async (_req, res) => {
        sendJson(res, 200, await this.controller.executePendingTasks());
      };
    }
    if (method === 'POST' && pathname === '/api/client/services/publish') {
      return async (_req, res, body) => {
        sendJson(res, 200, await this.controller.publishService(body as never));
      };
    }
    if (method === 'POST' && pathname === '/api/admin/nodes') {
      return async (_req, res, body) => {
        sendJson(res, 200, await this.controller.upsertNode(body as never));
      };
    }
    const heartbeatMatch = pathname.match(/^\/api\/admin\/nodes\/([^/]+)\/heartbeat$/);
    if (method === 'POST' && heartbeatMatch) {
      return async (_req, res) => {
        sendJson(res, 200, await this.controller.heartbeatNode(decodeURIComponent(heartbeatMatch[1])));
      };
    }
    if (method === 'POST' && pathname === '/api/admin/services') {
      return async (_req, res, body) => {
        sendJson(res, 200, await this.controller.upsertService(body as never));
      };
    }
    if (method === 'POST' && pathname === '/api/admin/rate-limits') {
      return async (_req, res, body) => {
        sendJson(res, 200, await this.controller.upsertRateLimit(body as never));
      };
    }
    return null;
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  sendText(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
}

function sendText(
  res: ServerResponse,
  status: number,
  data: string,
  contentType = 'text/plain; charset=utf-8'
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(data);
}
