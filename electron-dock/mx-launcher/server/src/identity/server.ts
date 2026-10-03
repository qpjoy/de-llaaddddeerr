import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { createServer } from 'node:https';
import { request, createServer as createHttpServer, type RequestListener } from 'node:http';
import { createIdentityProvider, type IdentitySettings } from './provider.js';
import type { IdentityRepository } from './repository.js';
import { createRegistrationClient } from '../registration/backchannel.js';

export function createIdentityServer({ settings, repository, cert, key, upstream }: {
  settings: IdentitySettings; repository: IdentityRepository; cert: Buffer; key: Buffer; upstream: URL;
}) {
  const origin = new URL(settings.origin);
  const identity = createIdentityProvider(settings, repository, name => repository.adapter(name),
    createRegistrationClient(upstream, settings.clientId, settings.clientSecret));
  const admin = new URL(settings.adminOrigin ?? settings.origin);
  const publicEntry = Boolean(settings.adminOrigin);
  const handler: RequestListener = async (req, res) => {
    try {
      if (req.headers.host !== origin.host && (!publicEntry || req.headers.host !== admin.host)) { res.writeHead(421).end(); return; }
      if (publicEntry) {
        // Never trust an internet client's forwarding headers. The listener's
        // private hostPort is reached via the fixed edge/Internal Nginx chain.
        req.headers['x-forwarded-proto'] = 'https';
        req.headers['x-forwarded-host'] = req.headers.host;
        delete req.headers.forwarded;
      }
      const path = (req.url ?? '').split('?')[0];
      if (path === '/healthz') { await repository.ready(); res.end('ok'); return; }
      if (publicEntry) {
        const supplied = Buffer.from(String(req.headers['x-mx-identity-gateway'] ?? ''));
        const expected = Buffer.from(settings.ingressToken ?? '');
        if (!expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)
          || !isIP(String(req.headers['x-mx-client-ip'] ?? ''))) { res.writeHead(403).end(); return; }
      }
      if (path.startsWith('/identity/')) {
        if (req.headers.host !== origin.host) { res.writeHead(404).end(); return; }
        await identity.handle(req, res); return;
      }
      if (publicEntry && req.headers.host !== admin.host) { res.writeHead(404).end(); return; }
      if (path === '/') { res.writeHead(302, { location: '/admin/' }).end(); return; }
      if (!(publicEntry ? ['/admin', '/admin/', '/auth/admin/', '/admin-api/'] : ['/admin', '/admin/', '/auth/admin/', '/admin-api/', '/internal/v1/']).some(prefix => path === prefix || (prefix.endsWith('/') && path.startsWith(prefix)))) {
        res.writeHead(404).end(); return;
      }
      // The managed HTTPS endpoint is internal-only. Forward only known admin
      // paths; discard spoofed proxy/connection headers before reaching the API.
      const headers = { ...req.headers, host: publicEntry ? admin.host : upstream.host, 'x-forwarded-for': req.socket.remoteAddress,
        'x-forwarded-proto': 'https', 'x-forwarded-host': admin.host };
      if (publicEntry) {
        delete headers['x-mx-ops-token' as keyof typeof headers];
        delete headers.authorization;
      }
      for (const header of ['connection', 'upgrade', 'transfer-encoding', 'x-mx-forwarded-by', 'forwarded']) delete headers[header as keyof typeof headers];
      const proxy = request({ hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers, timeout: 30000 }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      proxy.on('timeout', () => proxy.destroy());
      proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('管理服务暂不可用，请稍后重试。'); });
      req.on('aborted', () => proxy.destroy()); req.pipe(proxy);
    } catch { if (!res.headersSent) res.writeHead(503); res.end('身份服务暂不可用。'); }
  };
  const server = publicEntry ? createHttpServer(handler) : createServer({ cert, key, minVersion: 'TLSv1.2' }, handler);
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return server;
}
