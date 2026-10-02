import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config.js';
import { IdentityRepository } from './repository.js';
import type { IdentitySettings } from './provider.js';
import { createIdentityServer } from './server.js';

const settings = JSON.parse(readFileSync('/run/mx-identity/config.json', 'utf8')) as IdentitySettings;
const origin = new URL(settings.origin);
if (origin.protocol !== 'https:' || settings.issuer !== `${origin.origin}/identity`) throw new Error('Invalid identity HTTPS origin');
const runtime = loadConfig();
if (!runtime.databaseUrl) throw new Error('Identity requires durable PostgreSQL');
const repository = new IdentityRepository(runtime.databaseUrl, runtime.environment,
  createHash('sha256').update(`${runtime.environment}:${settings.issuer}`).digest('hex'), settings.cookieKeys[0]);
await repository.initialize();
const server = createIdentityServer({ settings, repository, cert: readFileSync('/run/mx-identity/tls.crt'), key: readFileSync('/run/mx-identity/tls.key'),
  upstream: new URL('http://mx-launcher-internal.mx-internal-shadow.svc.cluster.local:18090') });
server.listen(Number(origin.port), '0.0.0.0');
const cleanup = setInterval(() => void repository.cleanup().catch(() => console.warn('identity cleanup unavailable')), 60000).unref();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
  clearInterval(cleanup); server.close(() => void repository.close()); server.closeIdleConnections();
});
console.log(JSON.stringify({ event: 'identity.ready', issuer: settings.issuer }));
