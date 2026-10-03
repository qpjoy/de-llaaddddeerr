import { createServer } from 'node:https';
import { request } from 'node:http';
import { createIdentityProvider, type IdentitySettings } from './provider.js';
import type { IdentityRepository } from './repository.js';
import { createRegistrationClient } from '../registration/backchannel.js';

export function createIdentityServer({ settings, repository, cert, key, upstream }: {
  settings: IdentitySettings; repository: IdentityRepository; cert: Buffer; key: Buffer; upstream: URL;
}) {
  const origin = new URL(settings.origin);
  const identity = createIdentityProvider(settings, repository, name => repository.adapter(name),
    createRegistrationClient(upstream, settings.clientId, settings.clientSecret));
  const server = createServer({ cert: cert, key: key, minVersion: 'TLSv1.2' }, async (req, res) => {
    try {
      if (req.headers.host !== origin.host) { res.writeHead(421).end(); return; }
      const path = (req.url ?? '').split('?')[0];
      if (path === '/healthz') { await repository.ready(); res.end('ok'); return; }
      if (path.startsWith('/identity/')) { await identity.handle(req, res); return; }
      if (path === '/') { res.writeHead(302, { location: '/admin/' }).end(); return; }
      if (!['/admin', '/admin/', '/auth/admin/', '/admin-api/', '/internal/v1/'].some(prefix => path === prefix || (prefix.endsWith('/') && path.startsWith(prefix)))) {
        res.writeHead(404).end(); return;
      }
      // The managed HTTPS endpoint is internal-only. Forward only known admin
      // paths; discard spoofed proxy/connection headers before reaching the API.
      const headers = { ...req.headers, host: upstream.host, 'x-forwarded-for': req.socket.remoteAddress,
        'x-forwarded-proto': 'https', 'x-forwarded-host': origin.host };
      for (const header of ['connection', 'upgrade', 'transfer-encoding', 'x-mx-forwarded-by', 'forwarded']) delete headers[header as keyof typeof headers];
      const proxy = request({ hostname: upstream.hostname, port: upstream.port, method: req.method, path: req.url, headers, timeout: 30000 }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      proxy.on('timeout', () => proxy.destroy());
      proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('管理服务暂不可用，请稍后重试。'); });
      req.on('aborted', () => proxy.destroy()); req.pipe(proxy);
    } catch { if (!res.headersSent) res.writeHead(503); res.end('身份服务暂不可用。'); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return server;
}
