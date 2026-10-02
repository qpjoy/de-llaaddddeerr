#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rename, readdir, realpath, stat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SERVICE_CATALOG, SERVICE_CATALOG_VERSION, buildServiceCommand, normalizeServiceProfile } from '../../desktop/service-operations-catalog.js';

const exec = promisify(execFile);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
const assert = (condition, message, status = 400) => { if (!condition) throw Object.assign(new Error(message), { status }); };
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temporary, path);
}

export function redactOutput(text, secrets = []) {
  let result = String(text);
  for (const secret of secrets.filter(value => value && value.length >= 6).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]');
  return result
    .replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
    .replace(/((?:[\w-]*(?:password|passwd|token|secret|api[_-]?key|pepper)[\w-]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[REDACTED]');
}

async function sourceState(cwd) {
  const options = { cwd, timeout: 10000, maxBuffer: 8 * 1024 * 1024 };
  const [head, dirty, diff] = await Promise.all([
    exec('git', ['rev-parse', 'HEAD'], options),
    exec('git', ['status', '--porcelain', '--untracked-files=normal'], options),
    exec('git', ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'], options)
  ]);
  return { revision: head.stdout.trim(), dirty: Boolean(dirty.stdout.trim()), changesDigest: hash([dirty.stdout, diff.stdout]) };
}

async function configFingerprint(cwd, service) {
  const files = service === 'launcher' ? ['server/.env'] : service === 'hub' ? ['.env.internal']
    : ['.env.gpu', `mx-${service}/.env`, `mx-${service}/.env.download`, `mx-${service}/secrets/api-key`];
  const values = [];
  for (const file of files) {
    try { values.push([file, hash(await readFile(join(cwd, file), 'utf8'))]); }
    catch (error) { if (error.code !== 'ENOENT') throw error; values.push([file, null]); }
  }
  return hash(values);
}

async function outputSecrets(cwd, service, token) {
  const secrets = [token];
  for (const name of ['server/.env', '.env.internal', `mx-${service}/.env`, `mx-${service}/.env.download`, `mx-${service}/secrets/api-key`]) {
    try {
      const content = await readFile(join(cwd, name), 'utf8');
      if (name.endsWith('/api-key')) secrets.push(content.trim());
      for (const line of content.split('\n')) {
        const match = line.match(/^\s*(?:export\s+)?[\w]*(?:TOKEN|SECRET|PASSWORD|PEPPER|KEY)[\w]*\s*=\s*(.*?)\s*$/i);
        if (match) secrets.push(match[1].replace(/^(['"])(.*)\1$/, '$2'));
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return secrets;
}

// Environment is explicit. In particular, a status check cannot inherit cluster repair flags.
function commandEnvironment(plan) {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'KUBECONFIG', 'DOCKER_HOST', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, plan.spec.env);
  if (plan.action === 'deploy' && ['embedding', 'ocr'].includes(plan.service)) {
    env.MX_BASE_DEPLOY_APPROVAL = `mx-${plan.service}:${plan.id}`;
  }
  return env;
}

export async function createOperationsAgent({ config, stateDir, token, runCommand, inspectSource = sourceState, runtimeVersion = 'development', onUpdateReady }) {
  assert(typeof token === 'string' && token.length >= 32, '执行器令牌至少需要 32 个字符');
  assert(config?.instances?.length > 0, '没有登记服务实例');
  const ids = new Set();
  for (const instance of config.instances) {
    assert(/^[a-z0-9-]{1,64}$/.test(instance.id) && !ids.has(instance.id), '实例 ID 不正确或重复');
    assert(SERVICE_CATALOG[instance.service], '实例服务不支持');
    instance.profile = normalizeServiceProfile(instance.service, instance.profile);
    ids.add(instance.id);
  }
  for (const subdir of ['', 'plans', 'operations', 'profiles']) await mkdir(join(stateDir, subdir), { recursive: true, mode: 0o700 });
  const lockPath = join(stateDir, 'active.lock');
  const unresolved = [];
  // An executor restart is not proof that external Docker/Kubernetes work was rolled back.
  for (const file of await readdir(join(stateDir, 'operations'))) {
    if (!file.endsWith('.json')) continue;
    const path = join(stateDir, 'operations', file);
    const operation = await readJson(path);
    if (['queued', 'running'].includes(operation.status)) {
      operation.status = 'needs_reconciliation';
      operation.message = '执行器重启，实际执行结果需要核对；不会自动重复部署。';
      operation.updatedAt = now();
      await atomicJson(path, operation);
    }
    if (operation.status === 'needs_reconciliation' && operation.holdsLock) unresolved.push(operation.id);
  }
  assert(unresolved.length <= 1, '发现多个未核对的写任务，请先人工核对任务存储');
  if (unresolved.length) {
    await mkdir(lockPath, { recursive: true, mode: 0o700 });
    await atomicJson(join(lockPath, 'owner.json'), { id: unresolved[0] });
  } else {
    // No command is launched until its durable operation exists. A lock left before
    // that write, or after a persisted completion, can safely be cleared on startup.
    await rm(lockPath, { recursive: true, force: true });
  }
  let submitting = false, running = 0, updateRequested = null, updating = false;
  const bootId = randomUUID();
  const lifecycle = () => ({ runtimeVersion, bootId, updateRequested, inFlight: running, submitting, updating });
  // The installer stages an immutable release and requests a drain. Only this
  // process knows when children AND their durable completion writes have ended.
  let checkingUpdate = false;
  const updateTimer = setInterval(async () => {
    if (!updateRequested || updating || checkingUpdate || submitting || running || !onUpdateReady) return;
    checkingUpdate = true;
    try {
      try { await stat(lockPath); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (submitting || running) return;
      updating = true;
      await onUpdateReady(server);
    } catch { updating = false; /* Keep serving records; retry without killing children. */ }
    finally { checkingUpdate = false; }
  }, 250);
  updateTimer.unref();
  const instanceFor = id => { const item = config.instances.find(i => i.id === id); assert(item, '实例未登记', 404); return item; };
  const pathFor = (kind, id) => { assert(uuid.test(id), '任务 ID 不正确'); return join(stateDir, kind, `${id}.json`); };
  const profileFor = async instance => {
    try { return normalizeServiceProfile(instance.service, await readJson(join(stateDir, 'profiles', `${instance.id}.json`))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return instance.profile; }
  };
  async function checkTarget(instance, profile) {
    assert(await realpath(profile.cwd) === await realpath(instance.profile.cwd), '项目目录与主机登记不符；请由主机管理员更新实例档案');
    assert((await stat(join(profile.cwd, 'scripts/manage.sh'))).isFile(), '项目管理脚本不存在');
  }
  const publicPlan = plan => ({
    id: plan.id, instanceId: plan.instanceId, service: plan.service, action: plan.action,
    createdAt: plan.createdAt, expiresAt: plan.expiresAt, revision: plan.source.revision,
    dirty: plan.source.dirty, command: plan.spec.command, impact: plan.spec.impact,
    requiresAcknowledgement: Boolean(plan.spec.impact), catalogVersion: SERVICE_CATALOG_VERSION
  });
  async function makePlan(body) {
    const instance = instanceFor(body.instanceId);
    const profile = normalizeServiceProfile(instance.service, body.profile ?? await profileFor(instance));
    await checkTarget(instance, profile);
    const spec = buildServiceCommand(instance.service, body.action, profile);
    const source = await inspectSource(profile.cwd);
    assert(!profile.expectedRevision || source.revision === profile.expectedRevision, '当前检出代码与指定 commit 不一致；先在主机准备该版本');
    assert(!spec.mutating || !source.dirty, '项目存在未提交改动，请先提交并确定发布版本；仍可查看状态或复制命令');
    if (spec.service === 'launcher' && spec.action === 'deploy') assert((await stat(profile.tmpDir)).isDirectory(), '临时目录不存在');
    const id = randomUUID();
    const plan = {
      id, instanceId: instance.id, service: instance.service, action: body.action, spec, source, runtimeVersion,
      profileRevision: hash(await profileFor(instance)), configFingerprint: await configFingerprint(profile.cwd, instance.service),
      createdAt: now(), expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    };
    await atomicJson(pathFor('plans', id), plan);
    return publicPlan(plan);
  }
  async function listOperations() {
    const files = (await readdir(join(stateDir, 'operations'))).filter(file => file.endsWith('.json'));
    const operations = await Promise.all(files.map(file => readJson(join(stateDir, 'operations', file))));
    return operations.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
  }
  async function executePlan(body) {
    const operationPath = pathFor('operations', body.planId);
    // Plan ID is the idempotency key, including requests repeated after an API restart.
    try { return await readJson(operationPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(!updateRequested, '执行器正在等待更新切换，请在当前任务结束后刷新重试', 409);
    assert(!submitting, '正在提交任务，请稍后重试', 409);
    submitting = true;
    try {
      const plan = await readJson(pathFor('plans', body.planId));
      assert(plan.runtimeVersion === runtimeVersion, '执行器版本已变化，请重新预检', 409);
      assert(Date.parse(plan.expiresAt) > Date.now(), '计划已过期，请重新预检', 409);
      assert(!plan.spec.impact || body.acknowledged === true, '请确认计划显示的影响范围');
      const instance = instanceFor(plan.instanceId);
      await checkTarget(instance, plan.spec.profile);
      assert(hash(await profileFor(instance)) === plan.profileRevision, '保存的配置已变化，请重新预检', 409);
      assert(hash(await inspectSource(plan.spec.cwd)) === hash(plan.source), '检出版本或工作区已变化，请重新预检', 409);
      assert(await configFingerprint(plan.spec.cwd, plan.service) === plan.configFingerprint, '运行配置或凭据已变化，请重新预检', 409);
      const holdsLock = plan.spec.mutating || ['predeploy', 'test'].includes(plan.action);
      if (holdsLock) {
        try { await mkdir(lockPath, { mode: 0o700 }); }
        catch (error) { if (error.code === 'EEXIST') throw Object.assign(new Error('主机已有执行任务或待核对任务，请先查看任务记录'), { status: 409 }); throw error; }
      }
      const operation = {
        id: plan.id, instanceId: plan.instanceId, service: plan.service, action: plan.action,
        revision: plan.source.revision, command: plan.spec.command, actor: 'internal-ops',
        status: 'queued', createdAt: now(), updatedAt: now(), message: '等待执行', exitCode: null, holdsLock
      };
      try {
        if (holdsLock) await atomicJson(join(lockPath, 'owner.json'), { id: plan.id });
        await atomicJson(operationPath, operation);
      } catch (error) { if (holdsLock) await rm(lockPath, { recursive: true, force: true }); throw error; }
      running++;
      void run(plan, operation).catch(async () => {
        operation.status = 'needs_reconciliation'; operation.message = '任务记录异常，需要核对主机实际状态'; operation.updatedAt = now();
        await atomicJson(operationPath, operation).catch(() => {});
      }).finally(() => { running--; });
      return operation;
    } finally { submitting = false; }
  }
  async function run(plan, operation) {
    const path = pathFor('operations', operation.id);
    const logPath = join(stateDir, 'operations', `${operation.id}.log`);
    const secrets = await outputSecrets(plan.spec.cwd, plan.service, token);
    let tail = '';
    let privateKeyBlock = false;
    let dirty = false, writing = null, logError = null;
    const flush = async () => {
      if (writing) return;
      if (!dirty) return;
      dirty = false;
      const snapshot = tail;
      writing = (async () => {
        const temporary = `${logPath}.tmp`;
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, logPath);
      })();
      try { await writing; } catch (error) { logError = error; } finally { writing = null; }
    };
    const append = line => {
      if (/-----BEGIN .*PRIVATE KEY-----/.test(line)) privateKeyBlock = true;
      if (privateKeyBlock) {
        if (/-----END .*PRIVATE KEY-----/.test(line)) privateKeyBlock = false;
        line = '[PRIVATE KEY REDACTED]\n';
      }
      tail = (tail + redactOutput(line, secrets)).slice(-128 * 1024);
      dirty = true;
    };
    operation.status = 'running'; operation.message = '正在运行'; operation.updatedAt = now();
    await atomicJson(path, operation);
    const logTimer = setInterval(() => { void flush(); }, 300);
    const executor = runCommand || ((spec, onLine) => new Promise(resolveResult => {
      const child = spawn(spec.program, spec.args, { cwd: spec.cwd, env: commandEnvironment(plan), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      let timedOut = false;
      let killTimer;
      const timer = setTimeout(() => {
        timedOut = true;
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* May have exited. */ }
        killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }, 15000);
      }, spec.timeout * 1000);
      for (const stream of [child.stdout, child.stderr]) {
        let pending = '';
        stream.setEncoding('utf8');
        stream.on('data', chunk => {
          pending += chunk;
          let index;
          while ((index = pending.indexOf('\n')) !== -1) { onLine(pending.slice(0, index + 1)); pending = pending.slice(index + 1); }
          if (pending.length > 256 * 1024) { pending = ''; onLine('[过长日志行已省略]\n'); }
        });
        stream.on('end', () => { if (pending) onLine(pending); });
      }
      child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); onLine(`启动失败：${error.code}\n`); resolveResult({ code: 1 }); });
      child.on('close', (code, signal) => { clearTimeout(timer); clearTimeout(killTimer); resolveResult({ code, uncertain: timedOut || Boolean(signal) }); });
    }));
    let result;
    try { result = await executor(plan.spec, append); }
    catch { result = { code: null, uncertain: true }; append('执行器无法确认命令结果。\n'); }
    clearInterval(logTimer);
    if (writing) await writing;
    await flush();
    if (logError) throw logError;
    operation.exitCode = result.code;
    operation.status = result.uncertain ? 'needs_reconciliation' : result.code === 0 ? 'succeeded' : 'failed';
    operation.message = result.uncertain ? '命令超时或中断，请核对实际状态' : result.code === 0 ? '命令已完成；服务健康以输出和验收为准' : '命令失败；不会自动回滚或重复执行';
    operation.updatedAt = now();
    await atomicJson(path, operation);
    if (!result.uncertain && operation.holdsLock) await rm(lockPath, { recursive: true, force: true });
  }
  async function bodyJson(request) {
    let size = 0; const chunks = [];
    for await (const chunk of request) { size += chunk.length; assert(size <= 32 * 1024, '请求过大', 413); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    assert(body && typeof body === 'object' && !Array.isArray(body), '请求必须为对象');
    return body;
  }
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    try {
      const provided = Buffer.from(String(request.headers['x-mx-operations-token'] || ''));
      const expected = Buffer.from(token);
      assert(provided.length === expected.length && timingSafeEqual(provided, expected), '未授权的执行器请求', 401);
      const path = new URL(request.url, 'http://localhost').pathname;
      let result;
      if (request.method === 'GET' && path === '/v1/lifecycle') result = lifecycle();
      else if (request.method === 'POST' && path === '/v1/lifecycle/update') {
        const body = await bodyJson(request);
        assert(onUpdateReady, '当前执行器未启用自动更新');
        assert(/^[a-f0-9]{64}$/.test(body.runtimeVersion), '执行器版本摘要不正确');
        assert(!updateRequested || updateRequested === body.runtimeVersion, '已有另一版本等待切换', 409);
        updateRequested = body.runtimeVersion;
        result = lifecycle();
      } else if (request.method === 'GET' && path === '/v1/instances') {
        result = { catalogVersion: SERVICE_CATALOG_VERSION, host: config.host, lifecycle: lifecycle(), instances: await Promise.all(config.instances.map(async instance => {
          const profile = await profileFor(instance);
          let source = null;
          try { source = await inspectSource(profile.cwd); } catch { /* Missing checkout stays unknown. */ }
          return { id: instance.id, service: instance.service, profile, source };
        })) };
      } else if (request.method === 'POST' && path === '/v1/profiles') {
        const body = await bodyJson(request); const instance = instanceFor(body.instanceId);
        const profile = normalizeServiceProfile(instance.service, body.profile);
        await checkTarget(instance, profile);
        await atomicJson(join(stateDir, 'profiles', `${instance.id}.json`), profile);
        result = { instanceId: instance.id, profile };
      } else if (request.method === 'POST' && path === '/v1/plans') result = await makePlan(await bodyJson(request));
      else if (request.method === 'POST' && path === '/v1/execute') result = await executePlan(await bodyJson(request));
      else if (request.method === 'GET' && path === '/v1/operations') result = { operations: await listOperations() };
      else if (request.method === 'GET' && /^\/v1\/operations\/[^/]+$/.test(path)) {
        const id = path.split('/').at(-1); const operation = await readJson(pathFor('operations', id));
        let log = ''; try { log = await readFile(join(stateDir, 'operations', `${id}.log`), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        result = { operation, log };
      } else if (request.method === 'POST' && path === '/v1/reconcile') {
        const body = await bodyJson(request); const file = pathFor('operations', body.operationId); const operation = await readJson(file);
        assert(operation.status === 'needs_reconciliation', '该任务无需人工核对');
        assert(typeof body.note === 'string' && body.note.trim().length >= 8 && body.note.length <= 1000, '请记录核对方式与实际结果，至少 8 个字符');
        if (operation.holdsLock) {
          const owner = await readJson(join(lockPath, 'owner.json'));
          assert(owner.id === operation.id, '任务与主机锁不匹配');
        }
        operation.status = 'reconciled'; operation.reconciliation = redactOutput(body.note); operation.updatedAt = now();
        operation.message = '已人工核对并解除阻塞，原命令结果不改写为成功';
        await atomicJson(file, operation);
        if (operation.holdsLock) await rm(lockPath, { recursive: true, force: true });
        result = operation;
      } else throw Object.assign(new Error('操作不存在'), { status: 404 });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.statusCode = error.status || (error.code === 'ENOENT' ? 404 : 400);
      response.end(JSON.stringify({ message: redactOutput(error.message, [token]) }));
    }
  });
  server.on('close', () => clearInterval(updateTimer));
  server.requestTimeout = 30000;
  return server;
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = process.argv[2];
  assert(configPath, 'Usage: node service-operations-agent.mjs /path/config.json');
  const config = await readJson(configPath);
  const token = (await readFile(config.tokenFile, 'utf8')).trim();
  let runtimeVersion = 'development';
  try { runtimeVersion = (await readJson(resolve(dirname(fileURLToPath(import.meta.url)), '../../release.json'))).runtimeVersion; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const server = await createOperationsAgent({ config, stateDir: config.stateDir, token, runtimeVersion,
    onUpdateReady: server => {
      console.log('All commands and results settled; restarting into the staged executor release.');
      // Exit nonzero to use Restart=on-failure. Do not call systemctl from a
      // deployment child: KillMode=control-group would kill that very deploy.
      server.close(() => process.exit(75));
      server.closeIdleConnections();
    }
  });
  server.listen(config.port || 19290, config.bind || '127.0.0.1', () => {
    console.log(`MX service operations listening on ${config.bind || '127.0.0.1'}:${config.port || 19290}`);
  });
}
