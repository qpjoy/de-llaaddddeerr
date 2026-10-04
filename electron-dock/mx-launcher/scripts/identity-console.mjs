import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROFILE, readProfile, savePrivate } from './identity-profile.mjs';
import { publicOrigin } from './identity-public-profile.mjs';
import { validApplicationList } from './identity-app-profile.mjs';
import { registerApplication } from './identity-app.mjs';

const exec = promisify(execFile);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const historyFile = file => join(dirname(file), 'console-changes.json');
const consumerFile = (file, entry, appId) => join(dirname(file), 'applications', entry, `${appId}.json`);
function history(file) {
  const path = historyFile(file);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
}
function validateShape(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['entry', 'appId', 'displayName', 'origin', 'audience', 'revision'].includes(key))) fail('接入配置包含不支持的字段。');
}
export function validateIdentityApplication(profile, input) {
  if (!profile) fail('统一认证尚未初始化，请先按原流程启用 Auth。', 409);
  validateShape(input);
  const { entry, appId, origin, audience, displayName } = input;
  if (typeof origin !== 'string' || origin.length > 2048) fail('应用地址无效或过长。');
  if (!['public', 'private'].includes(entry) || typeof appId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(appId)
    || ['mx-launcher', 'mx-insight-hub', 'mx-h2i'].includes(appId)) fail('请选择认证入口并填写新的应用标识；现有 Launcher、Hub 和 MX-H2I 保持原接入方式。');
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 80 || /[\x00-\x1f\x7f]/.test(displayName)) fail('应用名称需为 1–80 个字符。');
  const target = entry === 'public' ? profile.publicEntry : profile;
  if (!target) fail('所选认证入口尚未启用。', 409);
  const existing = target.applications?.find(app => app.appId === appId);
  if (existing) fail('应用已经登记；现有地址、权限标识与密钥受保护，修改需单独进行迁移。', 409);
  const app = { appId, displayName: displayName.trim(), origin, audience, clientId: `${appId}-web`, clientSecret: 'a'.repeat(43) };
  if (!validApplicationList([...(target.applications ?? []), app], target.clientId, entry === 'public' ? publicOrigin : undefined)
    || origin === target.origin || origin === target.adminOrigin) fail('请填写合法的 HTTPS 应用地址和 audience；公网地址不带路径、端口、通配符或凭据。');
  return { entry, appId, displayName: app.displayName, origin, audience,
    clientId: app.clientId, issuer: target.issuer, callbackUrl: `${origin}/auth/sso/callback`, interactionUrl: `${origin}/auth/sso/interaction` };
}

// The production caller holds /run/mx-launcher-deploy.lock, shared with CLI/deploy.
export function saveIdentityApplication(input, { file = PROFILE, now = () => new Date().toISOString() } = {}) {
  validateShape(input);
  const profile = readProfile(file);
  if (!profile) fail('统一认证尚未初始化。', 409);
  const changes = history(file);
  const target = input?.entry === 'public' ? profile.publicEntry : profile;
  const existing = target?.applications?.find(app => app.appId === input?.appId);
  // A retry after a lost response must not rotate credentials or create another profile.
  const retry = changes.find(change => change.previousRevision === input.revision && change.appId === input.appId && change.entry === input.entry);
  if (existing && retry && existing.origin === input.origin && existing.audience === input.audience && existing.displayName === input.displayName?.trim()) {
    registerApplication({ ...input, file, appFile: consumerFile(file, input.entry, input.appId) });
    if (retry.phase !== 'saved') { Object.assign(retry, { phase: 'saved', savedAt: now(), revision: digest(profile) }); savePrivate(historyFile(file), changes); }
    return { saved: true, repeated: true, revision: digest(profile) };
  }
  if (typeof input?.revision !== 'string' || input.revision !== digest(profile)) fail('配置已变化，请刷新后重新校验。', 409);
  const validated = validateIdentityApplication(profile, input);
  const appFile = consumerFile(file, validated.entry, validated.appId);
  const change = { appId: validated.appId, entry: validated.entry, displayName: validated.displayName, previousRevision: input.revision, phase: 'saving' };
  const nextChanges = [...changes.filter(item => item !== retry), change].slice(-100);
  // Persist intent before changing either file so an interrupted save can resume safely.
  savePrivate(historyFile(file), nextChanges);
  registerApplication({ ...validated, file, appFile });
  const next = readProfile(file);
  Object.assign(change, { phase: 'saved', savedAt: now(), revision: digest(next) });
  savePrivate(historyFile(file), nextChanges);
  return { saved: true, revision: digest(next) };
}

export async function readIdentityRuntime() {
  const get = async args => {
    const { stdout } = await exec('kubectl', ['--request-timeout=5s', '-n', 'mx-internal-shadow', 'get', ...args, '-o', 'json'], {
      timeout: 6500, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, KUBECONFIG: '/etc/kubernetes/admin.conf' }
    });
    return stdout.trim() ? JSON.parse(stdout) : null;
  };
  const [secret, deployments, pods] = await Promise.all([
    get(['secret', 'mx-identity-runtime', '--ignore-not-found']),
    get(['deployments', '-l', 'mx.qpjoy.com/identity-installation']),
    get(['pods', '-l', 'app in (mx-identity,mx-identity-public)'])
  ]);
  return { secret, deployments: deployments?.items ?? [], pods: pods?.items ?? [] };
}

export async function identityConsoleOverview({ file = PROFILE, readRuntime = readIdentityRuntime } = {}) {
  const profile = readProfile(file);
  if (!profile) return { configured: false, entries: [], message: '统一认证尚未初始化，请先按原流程启用 Auth。' };
  const changes = history(file);
  let runtime, live;
  try {
    runtime = await readRuntime();
    live = runtime.secret ? JSON.parse(Buffer.from(runtime.secret.data['config.json'], 'base64').toString()) : null;
  } catch { /* Unreachable/invalid runtime is unknown, never reported as published. */ }
  const entries = [];
  for (const entry of ['private', 'public']) {
    const desired = entry === 'public' ? profile.publicEntry : profile;
    if (!desired) continue;
    const running = entry === 'public' ? live?.publicEntry : live;
    const deploymentName = entry === 'public' ? 'mx-identity-public' : 'mx-identity';
    const deployment = runtime?.deployments?.find(item => item.metadata?.name === deploymentName);
    const configDigest = runtime?.secret ? digest(Object.entries(runtime.secret.data).sort(([a], [b]) => a.localeCompare(b))) : '';
    const annotation = 'mx.qpjoy.com/identity-config-digest';
    const ready = Boolean(running && configDigest && deployment?.spec?.template?.metadata?.annotations?.[annotation] === configDigest
      && deployment.status?.observedGeneration >= deployment.metadata?.generation
      && deployment.status?.updatedReplicas === deployment.spec?.replicas && deployment.status?.availableReplicas === deployment.spec?.replicas
      && deployment.status?.replicas === deployment.spec?.replicas && deployment.spec?.replicas > 0);
    const started = ready ? (runtime.pods ?? []).filter(pod => pod.metadata?.labels?.app === deploymentName
      && pod.metadata?.annotations?.[annotation] === configDigest && pod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'))
      .flatMap(pod => (pod.status?.containerStatuses ?? []).map(container => container.state?.running?.startedAt).filter(Boolean)).sort().at(-1) : null;
    const sources = new Set([desired.adminOrigin ?? desired.origin, ...(desired.applications ?? []).map(app => app.origin)]);
    sources.delete(desired.origin);
    const formAction = ["'self'", ...sources].join(' ');
    const apps = [{ appId: 'mx-launcher', displayName: 'MX Launcher', clientId: desired.clientId, origin: desired.adminOrigin ?? desired.origin, audience: 'openid', builtIn: true }, ...(desired.applications ?? [])].map(app => {
      const current = app.builtIn ? (running && { clientId: running.clientId, origin: running.adminOrigin ?? running.origin })
        : running?.applications?.find(candidate => candidate.clientId === app.clientId);
      const matches = current && running.origin === desired.origin && running.issuer === desired.issuer
        && current.origin === app.origin && current.clientId === app.clientId
        && (!app.builtIn || running.clientSecret === desired.clientSecret)
        && (app.builtIn || (current.audience === app.audience && current.appId === app.appId && current.clientSecret === app.clientSecret));
      const change = [...changes].reverse().find(item => item.appId === app.appId && item.entry === entry);
      return { appId: app.appId, displayName: app.displayName || (app.appId === 'mx-insight-hub' ? 'MX Insight Hub' : app.appId),
        clientId: app.clientId, origin: app.origin, audience: app.audience,
        callbackUrl: `${app.origin}${app.builtIn ? '/auth/admin/callback' : '/auth/sso/callback'}`,
        status: !live ? 'unknown' : !matches ? 'pending' : ready ? 'active' : 'unverified',
        savedAt: change?.savedAt ?? null, publishedAt: matches && ready ? started : null,
        ...(change ? { consumerFile: consumerFile(file, entry, app.appId), provisioning: change.phase === 'saved' ? 'saved' : 'incomplete' } : {}) };
    });
    entries.push({ entry, origin: desired.origin, issuer: desired.issuer, apps, formAction,
      feishuCallbackUrl: `${desired.origin}/identity/feishu/callback`, ready,
      runtimeMessage: !live ? '暂时无法读取 Auth 运行配置。' : ready ? 'Auth 已加载当前运行配置。' : 'Auth 配置待发布或运行版本尚未核实。' });
  }
  return { configured: true, revision: digest(profile), checkedAt: new Date().toISOString(), entries };
}

// Invoked by the installed executor, under flock. No arbitrary paths or secrets in requests/responses.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = ''; for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 8192) fail('配置过大。'); }
    const result = saveIdentityApplication(JSON.parse(input));
    process.stdout.write(JSON.stringify(result));
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: true, status: error.status || 400, message: error.status ? error.message : '身份配置保存失败，请核对主机档案与权限；未重置已有凭据。' }));
    process.exitCode = 1;
  }
}
