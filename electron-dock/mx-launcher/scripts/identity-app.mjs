#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { PROFILE, readProfile, savePrivate } from './identity-profile.mjs';
import { publicOrigin } from './identity-public-profile.mjs';
import { validApplicationList } from './identity-app-profile.mjs';

/** Additive offline registration. Deployment remains the existing separate operation. */
export function registerApplication({ appId, displayName, origin, audience, entry, appFile, file = PROFILE }) {
  if (!['public', 'private'].includes(entry) || !appFile || !appId || appId === 'mx-launcher' || appId === 'mx-insight-hub') throw new Error('请选择 public/private 并提供独立应用 ID、输出文件；Hub 沿用原登记命令。');
  const p = readProfile(file), target = entry === 'public' ? p?.publicEntry : p;
  if (!target) throw new Error('所选身份入口尚未配置。');
  const old = target.applications?.find(app => app.appId === appId);
  if (old && (old.origin !== origin || old.audience !== audience)) throw new Error('应用已绑定其他地址或 audience；请单独规划迁移。');
  const app = old ?? { appId, ...(displayName ? { displayName } : {}), origin, audience, clientId: `${appId}-web`, clientSecret: randomBytes(32).toString('base64url') };
  const applications = old ? target.applications : [...(target.applications ?? []), app];
  if (!validApplicationList(applications, target.clientId, entry === 'public' ? publicOrigin : undefined)
    || origin === target.origin || origin === target.adminOrigin) throw new Error('应用配置无效或客户端 ID 冲突。');
  const consumer = { version: 1, appId, origin, issuer: target.issuer, clientId: app.clientId, clientSecret: app.clientSecret, audience,
    scope: 'openid mx:identity', callbackUrl: `${origin}/auth/sso/callback`, interactionUrl: `${origin}/auth/sso/interaction`, ...(entry === 'private' ? { caCert: p.caCert } : {}) };
  if (existsSync(appFile)) {
    let previous;
    try { previous = JSON.parse(readFileSync(appFile, 'utf8')); } catch { throw new Error('应用身份配置无法解析，请核对备份。'); }
    const { sessionKey, ...registered } = previous;
    if (JSON.stringify(registered) !== JSON.stringify(consumer)) throw new Error('应用已有不同身份配置，停止覆盖。');
    if (sessionKey !== undefined && (!/^[A-Za-z0-9_-]{43}$/.test(sessionKey) || Buffer.from(sessionKey, 'base64url').length !== 32)) throw new Error('应用会话密钥无效，停止覆盖。');
    consumer.sessionKey = sessionKey ?? randomBytes(32).toString('base64url');
  }
  consumer.sessionKey ??= randomBytes(32).toString('base64url');
  if (!old) savePrivate(file, entry === 'public' ? { ...p, publicEntry: { ...target, applications } } : { ...p, applications });
  savePrivate(appFile, consumer);
  return { appId, origin, issuer: target.issuer, clientId: app.clientId, appFile };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { app: { type: 'string' }, origin: { type: 'string' }, audience: { type: 'string' }, entry: { type: 'string' }, output: { type: 'string' }, profile: { type: 'string' } } });
    const result = registerApplication({ appId: values.app, origin: values.origin, audience: values.audience, entry: values.entry, appFile: values.output, file: values.profile || PROFILE });
    console.log(`已登记 ${result.appId}，应用配置保存于 ${result.appFile}。按原流程部署 Auth 后生效；账号与旧客户端凭据保持。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
