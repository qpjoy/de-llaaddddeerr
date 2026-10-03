#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { PROFILE, readProfile, savePrivate } from './identity-profile.mjs';
import { createPublicEntry, publicOrigin } from './identity-public-profile.mjs';
import { inspectIdentity, run, NS } from './identity-deploy.mjs';
import { writeInternalIngress } from './identity-ingress.mjs';
export { renderInternalIngress } from './identity-ingress.mjs';
// Read the versioned handoff document, never import another application's code.
function readSsoProfile(file) {
  if (statSync(file).mode & 0o027) throw new Error('Hub 身份档案须为私有文件，停止覆盖');
  const p = JSON.parse(readFileSync(file, 'utf8'));
  const origin = new URL(p.origin), issuer = new URL(p.issuer);
  if (p.version !== 1 || origin.protocol !== 'https:' || origin.origin !== p.origin || origin.username || origin.password
    || issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash
    || !p.clientId || !p.clientSecret || !p.legacyIssuer?.startsWith('mx-user-center:') || !p.audience
    || !/^[A-Za-z0-9_-]{43}$/.test(p.sessionKey)) throw new Error('Hub 身份档案版本或内容无效，停止覆盖');
  return p;
}

export function registerPublic({ origin, adminOrigin, hubOrigin, environment, audience = 'mx-insight-hub', file = PROFILE, hubFile }) {
  [origin, adminOrigin, hubOrigin].forEach(publicOrigin);
  if (!environment || new Set([origin,adminOrigin,hubOrigin]).size !== 3) throw new Error('需要三个不同的 HTTPS 入口及原环境标识');
  const p = readProfile(file); if (!p) throw new Error('请先启用原内网身份服务');
  const old = p.publicEntry;
  if (old && (old.origin !== origin || old.adminOrigin !== adminOrigin || old.applications[0].origin !== hubOrigin || old.applications[0].audience !== audience)) throw new Error('已有公网入口不同；停止覆盖，请规划迁移');
  const previous = existsSync(hubFile) ? readSsoProfile(hubFile) : null;
  if (previous && (previous.origin !== hubOrigin || previous.legacyIssuer !== `mx-user-center:${environment}` || previous.audience !== audience
    || ![p.issuer,old?.issuer].includes(previous.issuer))) throw new Error('Hub 已有不同身份配置；停止覆盖');
  const entry = old ?? createPublicEntry({ origin,adminOrigin,hubOrigin,audience,privateOrigin:p.origin });
  const app = entry.applications[0];
  if (previous?.issuer === entry.issuer && (previous.clientId !== app.clientId || previous.clientSecret !== app.clientSecret)) throw new Error('Hub 公网客户端密钥与原档案不同；请恢复原配置');
  const hub = previous?.issuer === entry.issuer ? previous : {
    version:1, origin:hubOrigin, issuer:entry.issuer, clientId:app.clientId, clientSecret:app.clientSecret,
    legacyIssuer:`mx-user-center:${environment}`, audience, sessionKey:previous?.sessionKey ?? randomBytes(32).toString('base64url'),
    personalTenant:previous?.personalTenant ?? true,
    // Existing private browser sessions are allowed to finish their original
    // bounded lifetime; new logins use the public issuer. No member ID changes.
    ...(previous ? { previousProviders:[{issuer:previous.issuer,clientId:previous.clientId,clientSecret:previous.clientSecret,caCert:previous.caCert}] } : {})
  };
  if (previous && previous.issuer !== entry.issuer) {
    const backup = join(dirname(hubFile),'profile.before-public.json');
    if (existsSync(backup)) {
      if (JSON.stringify(readSsoProfile(backup)) !== JSON.stringify(previous)) throw new Error('已有不同的 Hub 公网迁移备份，停止覆盖');
    } else savePrivate(backup,previous,true);
  }
  if (!old) savePrivate(file,{...p,publicEntry:entry});
  savePrivate(hubFile,hub);
  return entry;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [origin,adminOrigin,hubOrigin,...extra] = process.argv.slice(2);
    if (!hubOrigin || extra.length) throw new Error('用法：bash scripts/manage.sh ops identity public https://auth域名 https://launcher域名 https://hub域名');
    inspectIdentity(readProfile());
    const config=JSON.parse(run(['-n',NS,'get','configmap','mx-launcher-internal-config','-o','json']));
    const hc=JSON.parse(run(['-n','mx-insight-hub','get','configmap','mx-insight-hub-config','--ignore-not-found','-o','json']) || '{}');
    const hubFile=resolve(dirname(fileURLToPath(import.meta.url)),'../../mx-insight-hub/secrets/identity/profile.json');
    const entry=registerPublic({origin,adminOrigin,hubOrigin,environment:config.data.MX_ENVIRONMENT,audience:hc.data?.MX_INSIGHT_LAUNCHER_AUDIENCE||'mx-insight-hub',hubFile});
    const target=writeInternalIngress(readProfile());
    console.log(`公网配置已保存：${origin} / ${adminOrigin} / ${hubOrigin}`);
    console.log(`Internal Nginx 配置：${target}（含网关凭据，勿上传 Git）。原私网 issuer 和客户账号保持不变。`);
    console.log('下一步运行原 Launcher、Hub deploy；部署会预检并维护私网回源端口 18444。随后加载 Internal 与 Domestic Nginx 配置并验收。');
  } catch(error) { console.error(error.message);process.exitCode=1; }
}
