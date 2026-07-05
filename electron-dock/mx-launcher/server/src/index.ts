import 'reflect-metadata';
import './env.js';

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module.js';
import { RUNTIME_CONFIG } from './tokens.js';
import type { RuntimeConfig } from './types.js';

const httpBodyLimit = process.env.MX_HTTP_BODY_LIMIT || '10mb';
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  bodyParser: false
});
const config = app.get<RuntimeConfig>(RUNTIME_CONFIG);
const adminStaticDir = resolveAdminStaticDir();

app.useBodyParser('json', { limit: httpBodyLimit });
app.useBodyParser('urlencoded', { limit: httpBodyLimit, extended: true });

app.enableCors({
  origin: '*',
  allowedHeaders: ['content-type', 'authorization', 'x-request-id'],
  methods: ['GET', 'POST', 'OPTIONS']
});

if (adminStaticDir) {
  const express = app.getHttpAdapter().getInstance() as {
    use: (
      handler: (
        req: { originalUrl?: string; url?: string },
        res: { redirect: (status: number, url: string) => void },
        next: () => void
      ) => void
    ) => void;
  };
  express.use((req, res, next) => {
    const pathname = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (pathname === '/admin') {
      res.redirect(302, '/admin/');
      return;
    }
    next();
  });
  app.useStaticAssets(adminStaticDir, {
    prefix: '/admin/'
  });
}

await app.listen(config.port, config.host);

console.log(JSON.stringify({
  level: 'info',
  service: 'mx-launcher-server',
  framework: 'nestjs',
  message: 'listening',
  environment: config.environment,
  siteId: config.siteId,
  siteRole: config.siteRole,
  enabledModules: config.enabledModules,
  httpBodyLimit,
  adminStaticDir,
  adminUrl: adminStaticDir ? `http://${config.host}:${config.port}/admin/` : null,
  address: `http://${config.host}:${config.port}`
}));

function resolveAdminStaticDir(): string | null {
  const runtimeDir = dirname(fileURLToPath(import.meta.url));
  const explicit = process.env.MX_ADMIN_STATIC_DIR?.trim();
  const candidates = [
    explicit,
    resolve(process.cwd(), 'artifacts/admin'),
    resolve(process.cwd(), 'server/artifacts/admin'),
    resolve(process.cwd(), 'desktop'),
    resolve(process.cwd(), '../desktop'),
    resolve(runtimeDir, '../../artifacts/admin'),
    resolve(runtimeDir, '../../desktop'),
    resolve(runtimeDir, '../../../desktop')
  ].filter((item): item is string => Boolean(item));
  return candidates.find((candidate) => existsSync(resolve(candidate, 'index.html'))) ?? null;
}
