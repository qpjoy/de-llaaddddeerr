import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { RUNTIME_CONFIG } from './tokens.js';
import type { RuntimeConfig } from './types.js';

const app = await NestFactory.create(AppModule);
const config = app.get<RuntimeConfig>(RUNTIME_CONFIG);

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
  address: `http://${config.host}:${config.port}`
}));
