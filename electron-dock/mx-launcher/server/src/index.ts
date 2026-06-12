import 'reflect-metadata';

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

app.useBodyParser('json', { limit: httpBodyLimit });
app.useBodyParser('urlencoded', { limit: httpBodyLimit, extended: true });

app.enableCors({
  origin: '*',
  allowedHeaders: ['content-type', 'authorization', 'x-request-id'],
  methods: ['GET', 'POST', 'OPTIONS']
});

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
  address: `http://${config.host}:${config.port}`
}));
