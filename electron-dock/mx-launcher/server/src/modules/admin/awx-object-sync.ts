import { asRecord } from '../../lib/http.js';
import type {
  AwxProviderConfig,
  RuntimeFeaturePolicy,
  SiteSlotPlan,
  SiteSlotSshProfile,
  SiteSlotWorkerJob
} from '../../types.js';
import { buildAwxProviderSyncPlan } from '../config-center/awx-provider-sync-plan.js';
import { AWX_OBJECT_SYNC_FEATURE_KEY, awxRuntimeGateReasons } from './awx-runtime-gates.js';

type AwxObjectSyncInput = {
  token?: string | null;
  confirmAwxSync?: boolean | null;
  timeoutSeconds?: number | null;
  runtimePolicy?: RuntimeFeaturePolicy | null;
  requestId?: string | null;
};

type AwxRecord = Record<string, unknown>;

type AwxOperation = {
  objectType: string;
  name: string;
  status: 'found' | 'created' | 'patched' | 'blocked' | 'failed';
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  id: number | null;
  httpStatus: number | null;
  message: string;
};

export async function runAwxObjectSync(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  provider: AwxProviderConfig | null,
  input: AwxObjectSyncInput
): Promise<{ awxObjectSync: Record<string, unknown> }> {
  const syncPlan = buildAwxProviderSyncPlan(provider, {
    kind: job.kind,
    siteId: job.siteId,
    host: plan?.host ?? sshProfile?.host ?? null,
    sshUser: plan?.ssh.user ?? sshProfile?.sshUser ?? null,
    sshPort: plan?.ssh.port ?? sshProfile?.sshPort ?? null,
    sshProfileId: sshProfile?.profileId ?? plan?.ssh.profileId ?? null,
    planId: job.planId,
    jobId: job.jobId,
    sessionId: job.sessionId,
    runId: job.runId,
    requestId: input.requestId
  });
  const token = input.token?.trim() || process.env.AWX_API_TOKEN?.trim() || null;
  const timeoutSeconds = input.timeoutSeconds && input.timeoutSeconds > 0
    ? Math.min(Math.floor(input.timeoutSeconds), 300)
    : provider?.requestTimeoutSeconds ?? 120;
  const base = {
    objectSyncId: `awx_objsync_${job.jobId}`,
    mode: 'awx-object-sync',
    boundary: 'awx-api-object-sync',
    providerId: provider?.providerId ?? null,
    baseUrl: provider?.baseUrl ?? null,
    syncPlanId: syncPlan.syncPlanId,
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    targetKind: syncPlan.targetKind,
    inventory: syncPlan.inventory,
    inventoryHost: syncPlan.inventoryHost,
    credential: syncPlan.credential,
    jobTemplate: syncPlan.jobTemplate,
    warnings: syncPlan.warnings,
    timeoutSeconds
  };
  const blockedReasons = uniqueStrings([
    ...(syncPlan.status === 'ready' ? [] : syncPlan.blockedReasons),
    ...awxRuntimeGateReasons('AWX_API_OBJECT_SYNC_ENABLED', AWX_OBJECT_SYNC_FEATURE_KEY, input.runtimePolicy),
    ...(input.confirmAwxSync === true ? [] : ['confirmAwxSync=true is required']),
    ...(provider ? [] : ['active AWX provider is required']),
    ...(provider?.status === 'active' ? [] : [`AWX provider is ${provider?.status ?? 'missing'}`]),
    ...(provider?.baseUrl ? [] : ['AWX provider baseUrl is required']),
    ...(token ? [] : ['AWX API bearer token is required'])
  ]);
  if (blockedReasons.length > 0 || !provider?.baseUrl || !token) {
    return {
      awxObjectSync: {
        ...base,
        status: 'blocked',
        execution: 'blocked',
        operations: [],
        blockedReasons,
        nextActions: ['review-awx-sync-plan', 'enable-awx-object-sync', 'set-awx-api-token', 'confirm-awx-sync']
      }
    };
  }

  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`
  };
  const operations: AwxOperation[] = [];
  try {
    const credential = await findAwxRecord(provider.baseUrl, '/api/v2/credentials/', syncPlan.credential, headers, timeoutSeconds);
    operations.push({
      objectType: 'credential',
      name: syncPlan.credential,
      status: credential.record ? 'found' : 'blocked',
      method: 'GET',
      path: '/api/v2/credentials/',
      id: numberValue(credential.record?.id),
      httpStatus: credential.httpStatus,
      message: credential.record
        ? 'ready'
        : 'AWX Machine credential not found; sync SSH Profile credential before object sync'
    });
    if (!credential.record) {
      return {
        awxObjectSync: {
          ...base,
          status: 'blocked',
          execution: 'not-started',
          operations,
          blockedReasons: [`AWX Machine credential not found: ${syncPlan.credential}`],
          nextActions: ['sync-awx-machine-credential-from-ssh-profile', 'rerun-awx-object-sync']
        }
      };
    }

    const organization = await ensureAwxRecord(provider.baseUrl, {
      objectType: 'organization',
      listPath: '/api/v2/organizations/',
      name: syncPlan.organization,
      createPayload: {
        name: syncPlan.organization,
        description: 'MX Launcher Internal managed organization'
      },
      patchPayload: {
        description: 'MX Launcher Internal managed organization'
      },
      headers,
      timeoutSeconds
    });
    operations.push(organization.operation);

    const organizationId = numberValue(organization.record.id);
    const project = await ensureAwxRecord(provider.baseUrl, {
      objectType: 'project',
      listPath: '/api/v2/projects/',
      name: syncPlan.project,
      createPayload: {
        name: syncPlan.project,
        organization: organizationId,
        scm_type: '',
        local_path: '_mx_launcher_awx_project'
      },
      patchPayload: {
        organization: organizationId,
        scm_type: '',
        local_path: '_mx_launcher_awx_project'
      },
      headers,
      timeoutSeconds
    });
    operations.push(project.operation);

    const inventory = await ensureAwxRecord(provider.baseUrl, {
      objectType: 'inventory',
      listPath: '/api/v2/inventories/',
      name: syncPlan.inventory,
      createPayload: {
        name: syncPlan.inventory,
        organization: organizationId,
        variables: jsonVariables({
          mx_site_id: syncPlan.siteId,
          mx_site_kind: syncPlan.targetKind,
          mx_provider_id: provider.providerId
        })
      },
      patchPayload: {
        organization: organizationId,
        variables: jsonVariables({
          mx_site_id: syncPlan.siteId,
          mx_site_kind: syncPlan.targetKind,
          mx_provider_id: provider.providerId
        })
      },
      headers,
      timeoutSeconds
    });
    operations.push(inventory.operation);

    const inventoryId = numberValue(inventory.record.id);
    const host = await ensureAwxRecord(provider.baseUrl, {
      objectType: 'host',
      listPath: `/api/v2/inventories/${encodeURIComponent(String(inventoryId))}/hosts/`,
      createPath: '/api/v2/hosts/',
      name: syncPlan.inventoryHost ?? job.siteId,
      createPayload: {
        name: syncPlan.inventoryHost ?? job.siteId,
        inventory: inventoryId,
        enabled: true,
        variables: jsonVariables({
          mx_site_id: syncPlan.siteId,
          mx_site_kind: syncPlan.targetKind,
          mx_provider_id: provider.providerId,
          ansible_host: syncPlan.host,
          ansible_user: syncPlan.sshUser,
          ansible_port: syncPlan.sshPort,
          mx_ssh_profile_id: syncPlan.sshProfileId
        })
      },
      patchPayload: {
        inventory: inventoryId,
        enabled: true,
        variables: jsonVariables({
          mx_site_id: syncPlan.siteId,
          mx_site_kind: syncPlan.targetKind,
          mx_provider_id: provider.providerId,
          ansible_host: syncPlan.host,
          ansible_user: syncPlan.sshUser,
          ansible_port: syncPlan.sshPort,
          mx_ssh_profile_id: syncPlan.sshProfileId
        })
      },
      headers,
      timeoutSeconds
    });
    operations.push(host.operation);

    const projectId = numberValue(project.record.id);
    const credentialId = numberValue(credential.record.id);
    const jobTemplate = await ensureAwxRecord(provider.baseUrl, {
      objectType: 'job-template',
      listPath: '/api/v2/job_templates/',
      name: syncPlan.jobTemplate,
      createPayload: {
        name: syncPlan.jobTemplate,
        job_type: 'run',
        project: projectId,
        inventory: inventoryId,
        playbook: syncPlan.requiredPlaybook,
        credentials: [credentialId],
        diff_mode: true,
        ask_limit_on_launch: true,
        ask_variables_on_launch: true
      },
      patchPayload: {
        project: projectId,
        inventory: inventoryId,
        playbook: syncPlan.requiredPlaybook,
        credentials: [credentialId],
        diff_mode: true,
        ask_limit_on_launch: true,
        ask_variables_on_launch: true
      },
      headers,
      timeoutSeconds
    });
    operations.push(jobTemplate.operation);

    const failed = operations.filter((operation) => operation.status === 'failed');
    return {
      awxObjectSync: {
        ...base,
        status: failed.length > 0 ? 'failed' : 'passed',
        execution: failed.length > 0 ? 'failed' : 'completed',
        operations,
        blockedReasons: [],
        nextActions: failed.length > 0
          ? ['inspect-awx-object-sync-failure', 'rerun-awx-object-sync']
          : ['run-awx-provider-check', 'launch-awx-job-after-check']
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AWX object sync failed';
    return {
      awxObjectSync: {
        ...base,
        status: 'failed',
        execution: 'failed',
        operations,
        error: message,
        blockedReasons: [],
        nextActions: ['inspect-awx-api-connectivity', 'rerun-awx-object-sync']
      }
    };
  }
}

async function ensureAwxRecord(
  baseUrl: string,
  options: {
    objectType: string;
    listPath: string;
    createPath?: string;
    name: string;
    createPayload: Record<string, unknown>;
    patchPayload: Record<string, unknown>;
    headers: Record<string, string>;
    timeoutSeconds: number;
  }
): Promise<{ record: AwxRecord; operation: AwxOperation }> {
  const found = await findAwxRecord(baseUrl, options.listPath, options.name, options.headers, options.timeoutSeconds);
  if (!found.record) {
    const created = await awxRequest(baseUrl, options.createPath ?? options.listPath, {
      method: 'POST',
      headers: options.headers,
      timeoutSeconds: options.timeoutSeconds,
      body: options.createPayload
    });
    return {
      record: created.json,
      operation: {
        objectType: options.objectType,
        name: options.name,
        status: 'created',
        method: 'POST',
        path: options.createPath ?? options.listPath,
        id: numberValue(created.json.id),
        httpStatus: created.httpStatus,
        message: 'created'
      }
    };
  }
  const id = numberValue(found.record.id);
  const patchPath = recordPath(options.createPath ?? options.listPath, id);
  const patched = await awxRequest(baseUrl, patchPath, {
    method: 'PATCH',
    headers: options.headers,
    timeoutSeconds: options.timeoutSeconds,
    body: options.patchPayload
  });
  return {
    record: patched.json,
    operation: {
      objectType: options.objectType,
      name: options.name,
      status: 'patched',
      method: 'PATCH',
      path: patchPath,
      id,
      httpStatus: patched.httpStatus,
      message: found.httpStatus === null ? 'patched' : 'found and patched'
    }
  };
}

async function findAwxRecord(
  baseUrl: string,
  listPath: string,
  name: string,
  headers: Record<string, string>,
  timeoutSeconds: number
): Promise<{ record: AwxRecord | null; httpStatus: number | null }> {
  const separator = listPath.includes('?') ? '&' : '?';
  const path = `${listPath}${separator}name=${encodeURIComponent(name)}`;
  const response = await awxRequest(baseUrl, path, { method: 'GET', headers, timeoutSeconds });
  const results = Array.isArray(response.json.results) ? response.json.results.map((item) => asRecord(item)) : [];
  return {
    record: results.find((item) => stringValue(item.name) === name) ?? results[0] ?? null,
    httpStatus: response.httpStatus
  };
}

async function awxRequest(
  baseUrl: string,
  path: string,
  options: {
    method: 'GET' | 'POST' | 'PATCH';
    headers: Record<string, string>;
    timeoutSeconds: number;
    body?: unknown;
  }
): Promise<{ json: AwxRecord; httpStatus: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutSeconds * 1000);
  try {
    const response = await fetch(new URL(path, normalizedAwxBaseUrl(baseUrl)), {
      method: options.method,
      headers: options.headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    const json = parseJsonObject(text);
    if (!response.ok) {
      throw new Error(`AWX ${options.method} ${path} returned HTTP ${response.status}: ${stringValue(json.detail) ?? text.slice(0, 400)}`);
    }
    return { json, httpStatus: response.status };
  } finally {
    clearTimeout(timeout);
  }
}

function recordPath(listPath: string, id: number | null): string {
  if (!id) return listPath;
  const base = listPath.split('?')[0].replace(/\/+$/, '');
  return `${base}/${encodeURIComponent(String(id))}/`;
}

function jsonVariables(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

function parseJsonObject(text: string): AwxRecord {
  try {
    const value = text ? JSON.parse(text) : {};
    return value && typeof value === 'object' && !Array.isArray(value) ? value as AwxRecord : {};
  } catch {
    return {};
  }
}

function normalizedAwxBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
      ? Math.floor(Number(value))
      : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}
