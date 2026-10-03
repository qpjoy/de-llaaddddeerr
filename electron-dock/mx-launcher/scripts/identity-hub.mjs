#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { PROFILE, readProfile, savePrivate } from './identity-profile.mjs';
import { NS, run, inspectIdentity } from './identity-deploy.mjs';

export function registerHub({ origin, environment, audience = 'mx-insight-hub', file = PROFILE, hubFile }) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) throw new Error('Hub 地址须为完整 HTTPS origin，不带路径。');
  if (!environment || !audience) throw new Error('缺少已运行环境的身份标识');
  const p = readProfile(file); if (!p) throw new Error('请先运行 ops identity on。');
  const old = p.applications?.find(app => app.appId === 'mx-insight-hub');
  if (old && (old.origin !== origin || old.audience !== audience)) throw new Error('Hub 已绑定其他地址或 audience；需要单独迁移，不能覆盖。');
  const app = old ?? { clientId: 'mx-insight-hub-web', clientSecret: randomBytes(32).toString('base64url'), origin, appId: 'mx-insight-hub', audience };
  const existing = existsSync(hubFile) ? JSON.parse(readFileSync(hubFile, 'utf8')) : null;
  if (existing && (existing.issuer !== p.issuer || existing.origin !== origin || existing.clientId !== app.clientId || existing.clientSecret !== app.clientSecret
    || existing.legacyIssuer !== `mx-user-center:${environment}` || existing.audience !== audience)) throw new Error('Hub 已有不同的身份配置；停止覆盖。');
  const hub = existing ?? { version: 1, origin, issuer: p.issuer, clientId: app.clientId, clientSecret: app.clientSecret,
    legacyIssuer: `mx-user-center:${environment}`, audience, sessionKey: randomBytes(32).toString('base64url'), caCert: p.caCert, personalTenant: true };
  // Save provider first: a retry can complete the consumer file after a crash.
  if (!old) savePrivate(file, { ...p, applications: [...(p.applications ?? []), app] });
  savePrivate(hubFile, hub);
  return { origin, issuer: p.issuer, clientId: app.clientId, hubFile };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const origin = process.argv[2]; if (!origin || process.argv.length > 3) throw new Error('用法：bash scripts/manage.sh ops identity hub https://Hub地址');
    const p = readProfile(); inspectIdentity(p);
    const config = JSON.parse(run(['-n', NS, 'get', 'configmap', 'mx-launcher-internal-config', '-o', 'json']));
    const hubConfig = JSON.parse(run(['-n', 'mx-insight-hub', 'get', 'configmap', 'mx-insight-hub-config', '--ignore-not-found', '-o', 'json']) || '{}');
    const project = resolve(dirname(fileURLToPath(import.meta.url)), '../../mx-insight-hub');
    const result = registerHub({ origin, environment: config.data.MX_ENVIRONMENT,
      audience: hubConfig.data?.MX_INSIGHT_LAUNCHER_AUDIENCE || 'mx-insight-hub', hubFile: join(project, 'secrets/identity/profile.json') });
    console.log(`Hub SSO 配置已保存：${result.origin}；复用原账号与租户。`);
    console.log('依次运行 Launcher 和 Hub 原有 deploy 命令即可生效；以后重复部署会自动复用。请备份两个系统的身份档案与数据库。');
    console.log(`浏览器必须能访问身份入口 ${result.issuer}；仅配置 Hub 公网域名不会使内网 SSO 在公网可达。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
