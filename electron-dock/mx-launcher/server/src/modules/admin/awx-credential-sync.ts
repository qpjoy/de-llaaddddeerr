import { existsSync, readFileSync } from 'node:fs';

import { asRecord } from '../../lib/http.js';
import type {
  AwxProviderConfig,
  RuntimeFeaturePolicy,
  SiteSlotPlan,
  SiteSlotSshProfile,
  SiteSlotWorkerJob
} from '../../types.js';
import { buildAwxProviderObjectNames } from '../config-center/awx-provider-sync-plan.js';
import { AWX_CREDENTIAL_SYNC_FEATURE_KEY, awxRuntimeGateReasons } from './awx-runtime-gates.js';

type AwxCredentialSyncInput = {
  token?: string | null;
  confirmAwxCredentialSync?: boolean | null;
  timeoutSeconds?: number | null;
  runtimePolicy?: RuntimeFeaturePolicy | null;
  requestId?: string | null;
};

type AwxRecord = Record<string, unknown>;

type AwxCredentialOperation = {
  objectType: 'organization' | 'credential-type' | 'credential';
  name: string;
  status: 'found' | 'created' | 'patched' | 'blocked' | 'failed';
  method: 'GET' | 'POST' | 'PATCH';
  path: string;
  id: number | null;
  httpStatus: number | null;
  message: string;
};

export async function runAwxCredentialSync(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  provider: AwxProviderConfig | null,
  input: AwxCredentialSyncInput
): Promise<{ awxCredentialSync: Record<string, unknown> }> {
  const names = buildAwxProviderObjectNames(provider, {
    kind: job.kind,
    environment: provider?.environment ?? job.environment,
    siteId: job.siteId,
    sshProfileId: sshProfile?.profileId ?? plan?.ssh.profileId ?? null
  });
  const token = input.token?.trim() || process.env.AWX_API_TOKEN?.trim() || null;
  const identityFile = sshProfile?.identityFile ?? null;
  const identityFileExists = identityFile ? existsSync(identityFile) : false;
  const sshUser = plan?.ssh.user ?? sshProfile?.sshUser ?? null;
  const timeoutSeconds = input.timeoutSeconds && input.timeoutSeconds > 0
    ? Math.min(Math.floor(input.timeoutSeconds), 300)
    : provider?.requestTimeoutSeconds ?? 120;
  const base = {
    credentialSyncId: `awx_credsync_${job.jobId}`,
    mode: 'awx-credential-sync',
    boundary: 'awx-api-credential-sync',
    providerId: provider?.providerId ?? null,
    baseUrl: provider?.baseUrl ?? null,
    requestId: input.requestId ?? null,
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    targetKind: job.kind,
    organization: names.organization,
    credential: names.credential,
    sshProfileId: sshProfile?.profileId ?? plan?.ssh.profileId ?? null,
    sshUser,
    identityFile,
    warnings: [
      ...(provider?.warnings ?? []),
      ...(provider?.verifyTls === false ? ['verifyTls=false is recorded; platform TLS trust still applies to AWX API calls'] : [])
    ],
    timeoutSeconds
  };
  const blockedReasons = uniqueStrings([
    ...awxRuntimeGateReasons('AWX_API_CREDENTIAL_SYNC_ENABLED', AWX_CREDENTIAL_SYNC_FEATURE_KEY, input.runtimePolicy),
    ...(input.confirmAwxCredentialSync === true ? [] : ['confirmAwxCredentialSync=true is required']),
    ...(provider ? [] : ['active AWX provider is required']),
    ...(provider?.status === 'active' ? [] : [`AWX provider is ${provider?.status ?? 'missing'}`]),
    ...(provider?.baseUrl ? [] : ['AWX provider baseUrl is required']),
    ...(token ? [] : ['AWX API bearer token is required']),
    ...(sshProfile ? [] : ['managed SSH profile is required']),
    ...(sshProfile?.status === 'active' ? [] : [`SSH profile is ${sshProfile?.status ?? 'missing'}`]),
    ...(sshUser ? [] : ['sshUser is required for AWX Machine credential']),
    ...(identityFile ? [] : ['SSH profile identityFile is required']),
    ...(identityFile && identityFileExists ? [] : identityFile ? [`identityFile not found: ${identityFile}`] : [])
  ]);
  if (blockedReasons.length > 0 || !provider?.baseUrl || !token) {
    return {
      awxCredentialSync: {
        ...base,
        status: 'blocked',
        execution: 'blocked',
        operations: [],
        blockedReasons,
        nextActions: ['bind-site-slot-ssh-profile', 'enable-awx-credential-sync', 'set-awx-api-token', 'confirm-awx-credential-sync']
      }
    };
  }

  let sshKeyData = '';
  try {
    sshKeyData = readFileSync(identityFile as string, 'utf8');
  } catch (error) {
    return {
      awxCredentialSync: {
        ...base,
        status: 'failed',
        execution: 'failed',
        operations: [],
        error: error instanceof Error ? error.message : 'failed to read identityFile',
        blockedReasons: [],
        nextActions: ['fix-ssh-profile-identity-file', 'rerun-awx-credential-sync']
      }
    };
  }

  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`
  };
  const operations: AwxCredentialOperation[] = [];
  try {
    const organization = await ensureAwxRecord(provider.baseUrl, {
      objectType: 'organization',
      listPath: '/api/v2/organizations/',
      name: names.organization,
      createPayload: {
        name: names.organization,
        description: 'MX Launcher Internal managed organization'
      },
      patchPayload: {
        description: 'MX Launcher Internal managed organization'
      },
      headers,
      timeoutSeconds
    });
    operations.push(organization.operation);

    const credentialType = await findAwxRecord(provider.baseUrl, '/api/v2/credential_types/', 'Machine', headers, timeoutSeconds);
    operations.push({
      objectType: 'credential-type',
      name: 'Machine',
      status: credentialType.record ? 'found' : 'blocked',
      method: 'GET',
      path: '/api/v2/credential_types/',
      id: numberValue(credentialType.record?.id),
      httpStatus: credentialType.httpStatus,
      message: credentialType.record ? 'ready' : 'AWX Machine credential type not found'
    });
    if (!credentialType.record) {
      return {
        awxCredentialSync: {
          ...base,
          status: 'blocked',
          execution: 'not-started',
          operations,
          blockedReasons: ['AWX Machine credential type not found'],
          nextActions: ['inspect-awx-credential-types', 'rerun-awx-credential-sync']
        }
      };
    }

    const organizationId = numberValue(organization.record.id);
    const credentialTypeId = numberValue(credentialType.record.id);
    const credential = await ensureAwxRecord(provider.baseUrl, {
      objectType: 'credential',
      listPath: '/api/v2/credentials/',
      name: names.credential,
      createPayload: credentialPayload(names.credential, organizationId, credentialTypeId, sshUser as string, sshKeyData),
      patchPayload: credentialPayload(names.credential, organizationId, credentialTypeId, sshUser as string, sshKeyData),
      headers,
      timeoutSeconds
    });
    operations.push(credential.operation);

    const failed = operations.filter((operation) => operation.status === 'failed');
    return {
      awxCredentialSync: {
        ...base,
        status: failed.length > 0 ? 'failed' : 'passed',
        execution: failed.length > 0 ? 'failed' : 'completed',
        operations,
        blockedReasons: [],
        nextActions: failed.length > 0
          ? ['inspect-awx-credential-sync-failure', 'rerun-awx-credential-sync']
          : ['run-awx-object-sync', 'run-awx-provider-check']
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AWX credential sync failed';
    return {
      awxCredentialSync: {
        ...base,
        status: 'failed',
        execution: 'failed',
        operations,
        error: message,
        blockedReasons: [],
        nextActions: ['inspect-awx-api-connectivity', 'rerun-awx-credential-sync']
      }
    };
  }
}

function credentialPayload(
  name: string,
  organizationId: number | null,
  credentialTypeId: number | null,
  sshUser: string,
  sshKeyData: string
): Record<string, unknown> {
  return {
    name,
    organization: organizationId,
    credential_type: credentialTypeId,
    inputs: {
      username: sshUser,
      ssh_key_data: sshKeyData
    }
  };
}

async function ensureAwxRecord(
  baseUrl: string,
  options: {
    objectType: AwxCredentialOperation['objectType'];
    listPath: string;
    name: string;
    createPayload: Record<string, unknown>;
    patchPayload: Record<string, unknown>;
    headers: Record<string, string>;
    timeoutSeconds: number;
  }
): Promise<{ record: AwxRecord; operation: AwxCredentialOperation }> {
  const found = await findAwxRecord(baseUrl, options.listPath, options.name, options.headers, options.timeoutSeconds);
  if (!found.record) {
    const created = await awxRequest(baseUrl, options.listPath, {
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
        path: options.listPath,
        id: numberValue(created.json.id),
        httpStatus: created.httpStatus,
        message: 'created'
      }
    };
  }
  const id = numberValue(found.record.id);
  const patchPath = recordPath(options.listPath, id);
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
      message: 'found and patched'
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
