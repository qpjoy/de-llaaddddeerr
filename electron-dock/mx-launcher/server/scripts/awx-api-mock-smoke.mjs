import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const internalBaseUrl = normalizeBaseUrl(process.env.MX_INTERNAL_BASE_URL || 'http://127.0.0.1:18133');
const internalOpsToken = process.env.MX_INTERNAL_OPS_TOKEN?.trim();
if (!internalOpsToken) throw new Error('MX_INTERNAL_OPS_TOKEN is required for Admin site-slot smoke actions');
const awxToken = process.env.SITE_SLOT_AWX_TOKEN || process.env.AWX_TOKEN || 'mx-awx-mock-token';
const suffix = process.env.MX_AWX_SMOKE_SUFFIX || Date.now().toString(36);

const mock = createAwxMock();
const server = createServer((request, response) => {
  mock.handle(request, response).catch((error) => {
    json(response, 500, { detail: error instanceof Error ? error.message : 'mock AWX error' });
  });
});

await listen(server, Number(process.env.MX_AWX_MOCK_PORT || '0'));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('mock AWX did not expose a TCP address');
const awxBaseUrl = `http://127.0.0.1:${address.port}`;

try {
  await waitForInternalReady();
  const result = await runSmoke(awxBaseUrl);
  console.log(JSON.stringify(result, null, 2));
} finally {
  await close(server);
}

async function runSmoke(awxBaseUrl) {
  const siteId = `oversea-awx-api-smoke-${suffix}`;
  const profileId = `sshprof_oversea_awx_api_smoke_${suffix}`;
  const providerId = `awxprov_api_smoke_${suffix}`;
  const keyDir = await mkdtemp(join(tmpdir(), 'mx-awx-api-smoke-'));
  const identityFile = join(keyDir, 'id_ed25519');
  await writeFile(identityFile, [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'bW9jay1hd3gtc21va2UtcHJpdmF0ZS1rZXk=',
    '-----END OPENSSH PRIVATE KEY-----',
    ''
  ].join('\n'), 'utf8');

  const providerPayload = await fetchJson('/internal/v1/config-center/awx-providers', {
    method: 'POST',
    body: {
      providerId,
      name: 'Mock AWX API Smoke',
      status: 'active',
      defaultKind: 'oversea',
      baseUrl: awxBaseUrl,
      organization: 'MX Internal',
      project: 'mx-launcher-site-slots',
      inventoryPrefix: 'mx',
      credentialPrefix: 'mx',
      jobTemplatePrefix: 'mx-site-slot',
      requestTimeoutSeconds: 5,
      requestedBy: 'awx-api-mock-smoke',
      requestId: `awx-api-mock-provider-${suffix}`
    }
  });
  assert(providerPayload.provider?.providerId === providerId, 'AWX provider upsert failed');

  const profilePayload = await fetchJson('/internal/v1/config-center/site-slot-ssh-profiles', {
    method: 'POST',
    body: {
      profileId,
      siteId,
      kind: 'oversea',
      host: '203.0.113.46',
      sshUser: 'root',
      sshPort: 22,
      identityFile,
      knownHostsFile: join(keyDir, 'known_hosts'),
      sshConfigFile: join(keyDir, 'ssh_config'),
      hostKeyAlias: siteId,
      strictHostKeyChecking: 'yes',
      connectTimeoutSeconds: 10,
      batchMode: 'yes',
      status: 'active',
      requestedBy: 'awx-api-mock-smoke',
      requestId: `awx-api-mock-profile-${suffix}`
    }
  });
  assert(profilePayload.profile?.profileId === profileId, 'SSH profile upsert failed');

  const planPayload = await fetchJson('/internal/v1/site-slots/plans', {
    method: 'POST',
    body: {
      kind: 'oversea',
      siteId,
      sshProfileId: profileId,
      host: '203.0.113.46',
      sshUser: 'root',
      sshPort: 22,
      rootAccess: true,
      hasDocker: true,
      hasOutboundInternet: true,
      internalBaseUrl,
      createdBy: 'awx-api-mock-smoke',
      requestId: `awx-api-mock-plan-${suffix}`
    }
  });
  const plan = planPayload.plan;
  assert(plan?.planId, 'site-slot plan id missing');

  const preflight = await executeAction(
    'site-slot.preflight.create',
    `/internal/v1/site-slots/plans/${encodeURIComponent(plan.planId)}/preflight`,
    {
      mode: 'manual',
      requestedBy: 'awx-api-mock-smoke',
      requestId: `awx-api-mock-preflight-${suffix}`
    }
  );
  assert(preflight.execution?.status === 'ready', 'preflight should be ready');

  const apply = await executeAction(
    'site-slot.apply.confirm',
    `/internal/v1/site-slots/plans/${encodeURIComponent(plan.planId)}/apply`,
    {
      mode: 'manual',
      confirmApply: true,
      requestedBy: 'awx-api-mock-smoke',
      requestId: `awx-api-mock-apply-${suffix}`
    }
  );
  assert(apply.execution?.status === 'ready', 'apply should be ready');

  const runner = await executeAction(
    'site-slot.runner.awx-shadow',
    `/internal/v1/site-slots/executions/${encodeURIComponent(apply.execution.runId)}/runner-sessions`,
    {
      mode: 'awx-shadow',
      requestedBy: 'awx-api-mock-smoke',
      requestId: `awx-api-mock-runner-${suffix}`
    }
  );
  assert(runner.session?.mode === 'awx-shadow', 'runner mode mismatch');

  const worker = await executeAction(
    'site-slot.worker-job.create',
    `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(runner.session.sessionId)}/worker-jobs`,
    {
      workerId: `worker-awx-api-smoke-${suffix}`,
      workerKind: 'awx-runner',
      approvalId: `approval-awx-api-smoke-${suffix}`,
      retryLimit: 1,
      rollbackStrategy: 'restore-previous-access-stack',
      requestedBy: 'awx-api-mock-smoke',
      requestId: `awx-api-mock-worker-${suffix}`
    }
  );
  assert(worker.job?.status === 'ready', 'worker job should be ready');

  const syncPlan = await executeAction(
    'site-slot.worker-run.awx-sync-plan',
    `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(worker.job.jobId)}/awx-sync-plan`,
    {
      awxProviderId: providerId,
      requestedBy: 'awx-api-mock-smoke',
      requestId: `awx-api-mock-sync-plan-${suffix}`
    }
  );
  assert(syncPlan.awxSyncPlan?.status === 'ready', `sync plan should be ready: ${syncPlan.awxSyncPlan?.blockedReasons?.join('; ')}`);

  const credentialSync = await executeAction(
    'site-slot.worker-run.awx-credential-sync',
    `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(worker.job.jobId)}/run-awx-credential-sync`,
    {
      awxProviderId: providerId,
      awxToken,
      confirmAwxCredentialSync: true,
      timeoutSeconds: 5,
      requestedBy: 'awx-api-mock-smoke',
      requestId: `awx-api-mock-credential-sync-${suffix}`
    }
  );
  assertNotBlocked(credentialSync.awxCredentialSync, 'AWX credential sync');
  assert(credentialSync.awxCredentialSync?.status === 'passed', `credential sync should pass: ${JSON.stringify(credentialSync.awxCredentialSync)}`);
  assert(mock.findByName('credentials', profileId)?.inputs?.ssh_key_data, 'mock AWX credential should receive ssh_key_data');

  const objectSync = await executeAction(
    'site-slot.worker-run.awx-object-sync',
    `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(worker.job.jobId)}/run-awx-object-sync`,
    {
      awxProviderId: providerId,
      awxToken,
      confirmAwxSync: true,
      timeoutSeconds: 5,
      requestedBy: 'awx-api-mock-smoke',
      requestId: `awx-api-mock-object-sync-${suffix}`
    }
  );
  assertNotBlocked(objectSync.awxObjectSync, 'AWX object sync');
  assert(objectSync.awxObjectSync?.status === 'passed', `object sync should pass: ${JSON.stringify(objectSync.awxObjectSync)}`);
  assert(mock.findByName('job_templates', objectSync.awxObjectSync.jobTemplate), 'mock AWX job template should exist');
  assert(mock.findByName('hosts', siteId), 'mock AWX host should exist');

  const launch = await executeAction(
    'site-slot.worker-run.awx-launch',
    `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(worker.job.jobId)}/run-awx-launch`,
    {
      awxProviderId: providerId,
      awxToken,
      confirmAwxLaunch: true,
      waitForCompletion: true,
      timeoutSeconds: 5,
      pollIntervalMs: 500,
      workerId: `worker-awx-api-smoke-${suffix}`,
      message: 'AWX API mock smoke',
      requestedBy: 'awx-api-mock-smoke',
      requestId: `awx-api-mock-launch-${suffix}`
    }
  );
  assertNotBlocked(launch.awxLaunch, 'AWX launch');
  assert(launch.awxLaunch?.status === 'passed', `launch should pass: ${JSON.stringify(launch.awxLaunch)}`);
  assert(launch.report?.status === 'passed', 'worker report should pass after AWX launch');
  assert(Array.isArray(launch.report?.stepReports) && launch.report.stepReports.length > 0, 'worker report steps missing');

  return {
    ok: true,
    internalBaseUrl,
    awxBaseUrl,
    providerId,
    siteId,
    profileId,
    planId: plan.planId,
    jobId: worker.job.jobId,
    credentialSync: summarizeSync(credentialSync.awxCredentialSync),
    objectSync: summarizeSync(objectSync.awxObjectSync),
    launch: {
      status: launch.awxLaunch.status,
      awxJobId: launch.awxLaunch.awxJobId,
      reportId: launch.report.reportId,
      stepReports: launch.report.stepReports.length
    },
    mockAwx: mock.summary()
  };
}

async function waitForInternalReady() {
  const deadline = Date.now() + 30_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await fetchJson('/healthz');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError || new Error(`Internal API did not become ready: ${internalBaseUrl}`);
}

async function executeAction(actionId, path, body) {
  const payload = await fetchJson('/internal/v1/admin/actions/execute', {
    method: 'POST',
    body: { actionId, path, body }
  });
  assert(payload.actionResult?.actionId === actionId, `${actionId} action result mismatch`);
  return payload;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(`${internalBaseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      'x-mx-ops-token': internalOpsToken,
      ...(options.body ? { 'content-type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}: ${payload?.message || text}`);
  }
  return payload;
}

function assertNotBlocked(value, label) {
  assert(value?.status !== 'blocked', `${label} blocked: ${value?.blockedReasons?.join('; ')}`);
}

function summarizeSync(value) {
  return {
    status: value.status,
    execution: value.execution,
    operations: Array.isArray(value.operations)
      ? value.operations.map((operation) => `${operation.objectType}:${operation.status}`)
      : []
  };
}

function createAwxMock() {
  const store = {
    organizations: [],
    projects: [],
    inventories: [],
    credentials: [],
    hosts: [],
    job_templates: []
  };
  let nextId = 1000;
  let nextJobId = 9001;
  const jobs = [];
  const launchedAt = new Date().toISOString();

  function createRecord(collection, payload) {
    const record = {
      id: nextId++,
      ...payload
    };
    if (collection === 'job_templates') {
      record.related = { launch: `/api/v2/job_templates/${record.id}/launch/` };
    }
    store[collection].push(record);
    return record;
  }

  function patchRecord(collection, id, payload) {
    const record = store[collection].find((item) => item.id === id);
    if (!record) return null;
    Object.assign(record, payload);
    if (collection === 'job_templates') {
      record.related = { launch: `/api/v2/job_templates/${record.id}/launch/` };
    }
    return record;
  }

  async function handle(request, response) {
    const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
    if (request.method === 'GET' && url.pathname === '/api/v2/ping/') {
      json(response, 200, { version: 'mock-awx-api', active_node: 'mx-awx-api-smoke' });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v2/credential_types/') {
      const name = url.searchParams.get('name');
      const machine = { id: 1, name: 'Machine', kind: 'ssh' };
      json(response, 200, {
        count: name === 'Machine' || !name ? 1 : 0,
        results: name === 'Machine' || !name ? [machine] : []
      });
      return;
    }

    const inventoryHostsMatch = url.pathname.match(/^\/api\/v2\/inventories\/(\d+)\/hosts\/$/);
    if (request.method === 'GET' && inventoryHostsMatch) {
      const inventoryId = Number(inventoryHostsMatch[1]);
      const name = url.searchParams.get('name');
      const results = store.hosts.filter((record) => record.inventory === inventoryId && (!name || record.name === name));
      json(response, 200, { count: results.length, results });
      return;
    }

    const collection = collectionForPath(url.pathname);
    if (collection && request.method === 'GET') {
      const name = url.searchParams.get('name');
      const results = store[collection].filter((record) => !name || record.name === name);
      json(response, 200, { count: results.length, results });
      return;
    }
    if (collection && request.method === 'POST') {
      const body = await readJson(request);
      json(response, 201, createRecord(collection, body));
      return;
    }

    const patchMatch = url.pathname.match(/^\/api\/v2\/([^/]+)\/(\d+)\/$/);
    if (patchMatch && request.method === 'PATCH') {
      const patchCollection = collectionForSlug(patchMatch[1]);
      const id = Number(patchMatch[2]);
      if (patchCollection) {
        const record = patchRecord(patchCollection, id, await readJson(request));
        json(response, record ? 200 : 404, record ?? { detail: `record not found: ${patchCollection}/${id}` });
        return;
      }
    }

    const launchMatch = url.pathname.match(/^\/api\/v2\/job_templates\/(\d+)\/launch\/$/);
    if (launchMatch && request.method === 'POST') {
      const templateId = Number(launchMatch[1]);
      const template = store.job_templates.find((record) => record.id === templateId);
      if (!template) {
        json(response, 404, { detail: `job template not found: ${templateId}` });
        return;
      }
      const launchBody = await readJson(request);
      const job = {
        id: nextJobId++,
        status: 'successful',
        job_template: templateId,
        templateName: template.name,
        launchBody,
        started: launchedAt,
        finished: new Date().toISOString(),
        elapsed: 1.1
      };
      jobs.push(job);
      json(response, 201, {
        id: job.id,
        job: job.id,
        url: `/api/v2/jobs/${job.id}/`,
        ignored_fields: {}
      });
      return;
    }

    const jobMatch = url.pathname.match(/^\/api\/v2\/jobs\/(\d+)\/$/);
    if (jobMatch && request.method === 'GET') {
      const job = jobs.find((record) => record.id === Number(jobMatch[1]));
      json(response, job ? 200 : 404, job ?? { detail: `job not found: ${jobMatch[1]}` });
      return;
    }

    const jobEventsMatch = url.pathname.match(/^\/api\/v2\/jobs\/(\d+)\/job_events\/$/);
    if (jobEventsMatch && request.method === 'GET') {
      const job = jobs.find((record) => record.id === Number(jobEventsMatch[1]));
      if (!job) {
        json(response, 404, { detail: `job not found: ${jobEventsMatch[1]}` });
        return;
      }
      json(response, 200, {
        count: 3,
        results: [
          eventRecord(1, 'ensure-mx-directories', 'TASK [ensure-mx-directories]', launchedAt),
          eventRecord(2, 'render-oversea-env', 'ok: rendered oversea env', launchedAt),
          eventRecord(3, 'configure-oversea-access', 'ok: configured oversea access stack', launchedAt)
        ]
      });
      return;
    }

    json(response, 404, { detail: `not found: ${request.method} ${url.pathname}` });
  }

  return {
    handle,
    findByName(collection, name) {
      return store[collection]?.find((record) => record.name === name) ?? null;
    },
    summary() {
      return {
        organizations: store.organizations.length,
        projects: store.projects.length,
        inventories: store.inventories.length,
        credentials: store.credentials.length,
        hosts: store.hosts.length,
        jobTemplates: store.job_templates.length,
        jobs: jobs.length
      };
    }
  };
}

function collectionForPath(pathname) {
  if (pathname === '/api/v2/organizations/') return 'organizations';
  if (pathname === '/api/v2/projects/') return 'projects';
  if (pathname === '/api/v2/inventories/') return 'inventories';
  if (pathname === '/api/v2/credentials/') return 'credentials';
  if (pathname === '/api/v2/hosts/') return 'hosts';
  if (pathname === '/api/v2/job_templates/') return 'job_templates';
  return null;
}

function collectionForSlug(slug) {
  if (slug === 'organizations') return 'organizations';
  if (slug === 'projects') return 'projects';
  if (slug === 'inventories') return 'inventories';
  if (slug === 'credentials') return 'credentials';
  if (slug === 'hosts') return 'hosts';
  if (slug === 'job_templates') return 'job_templates';
  return null;
}

function eventRecord(id, task, stdout, at) {
  return {
    id,
    event: 'runner_on_ok',
    event_data: { task, res: { changed: true } },
    stdout,
    created: at,
    modified: new Date().toISOString()
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function json(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
