import type {
  AwxProviderConfig,
  RuntimeFeaturePolicy,
  SiteSlotPlan,
  SiteSlotSshProfile,
  SiteSlotWorkerJob,
  SiteSlotWorkerReportInput,
  SiteSlotWorkerReportStatus
} from '../../types.js';
import { buildAwxProviderObjectNames } from '../config-center/awx-provider-sync-plan.js';
import { AWX_LAUNCH_FEATURE_KEY, awxRuntimeGateReasons } from './awx-runtime-gates.js';

type AwxApiLaunchInput = {
  token?: string | null;
  confirmAwxLaunch?: boolean | null;
  waitForCompletion?: boolean | null;
  timeoutSeconds?: number | null;
  pollIntervalMs?: number | null;
  runtimePolicy?: RuntimeFeaturePolicy | null;
  requestId?: string | null;
};

type AwxListResponse = {
  count?: unknown;
  results?: unknown;
};

type AwxRecord = Record<string, unknown>;

export async function runAwxApiLaunch(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  provider: AwxProviderConfig | null,
  input: AwxApiLaunchInput
): Promise<{
  awxLaunch: Record<string, unknown>;
  reportResult: {
    status: NonNullable<SiteSlotWorkerReportInput['status']>;
    stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']>;
  } | null;
}> {
  const names = buildAwxProviderObjectNames(provider, {
    kind: job.kind,
    environment: job.environment,
    siteId: job.siteId,
    sshProfileId: sshProfile?.profileId ?? plan?.ssh.profileId ?? null
  });
  const template = names.jobTemplate;
  const inventory = names.inventory;
  const credential = names.credential;
  const token = input.token?.trim() || process.env.AWX_API_TOKEN?.trim() || null;
  const waitForCompletion = input.waitForCompletion === true;
  const requestedTimeoutSeconds = input.timeoutSeconds ?? provider?.requestTimeoutSeconds;
  const timeoutSeconds = requestedTimeoutSeconds && requestedTimeoutSeconds > 0
    ? Math.min(Math.floor(requestedTimeoutSeconds), 900)
    : 180;
  const pollIntervalMs = input.pollIntervalMs && input.pollIntervalMs > 0
    ? Math.max(500, Math.min(Math.floor(input.pollIntervalMs), 10000))
    : 2000;
  const base = baseLaunch(job, provider, template, inventory, credential, waitForCompletion, timeoutSeconds);
  const blockedReasons = awxLaunchBlockedReasons(provider, token, input.confirmAwxLaunch === true, input.runtimePolicy);
  if (blockedReasons.length > 0 || !provider?.baseUrl || !token) {
    return {
      awxLaunch: {
        ...base,
        status: 'blocked',
        execution: 'blocked',
        blockedReasons,
        nextActions: ['configure-awx-provider', 'set-awx-api-token', 'confirm-awx-launch']
      },
      reportResult: null
    };
  }

  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${token}`
  };

  try {
    const templateRecord = await findAwxJobTemplate(provider.baseUrl, template, headers, timeoutSeconds);
    if (!templateRecord) {
      return {
        awxLaunch: {
          ...base,
          status: 'blocked',
          execution: 'not-started',
          blockedReasons: [`AWX job template not found: ${template}`],
          nextActions: ['sync-awx-job-template', 'rerun-awx-provider-check']
        },
        reportResult: null
      };
    }
    const launchPath = stringValue(asRecord(templateRecord.related)?.launch)
      ?? `/api/v2/job_templates/${encodeURIComponent(String(templateRecord.id))}/launch/`;
    const launchRequest = awxLaunchRequest(job, plan, sshProfile, inventory);
    const launchResponse = await awxRequest(provider.baseUrl, launchPath, {
      method: 'POST',
      headers,
      timeoutSeconds,
      body: launchRequest
    });
    const awxJobId = numberValue(launchResponse.id) ?? numberValue(launchResponse.job);
    if (!awxJobId) {
      const evidence = {
        ...base,
        status: 'failed',
        execution: 'submitted',
        launchResponse: redactAwxObject(launchResponse),
        error: 'AWX launch response did not include a job id'
      };
      return {
        awxLaunch: {
          ...evidence,
          blockedReasons: [],
          nextActions: ['inspect-awx-launch-response']
        },
        reportResult: failureReport(job, evidence, 'AWX launch response did not include a job id')
      };
    }

    const jobPath = `/api/v2/jobs/${awxJobId}/`;
    const jobSummary = waitForCompletion
      ? await waitForAwxJob(provider.baseUrl, jobPath, headers, timeoutSeconds, pollIntervalMs)
      : await awxRequest(provider.baseUrl, jobPath, { method: 'GET', headers, timeoutSeconds });
    const events = terminalAwxStatus(jobSummary.status) || waitForCompletion
      ? await fetchAwxJobEvents(provider.baseUrl, awxJobId, headers, timeoutSeconds)
      : [];
    const status = awxLaunchStatus(jobSummary.status, waitForCompletion);
    const awxLaunch = {
      ...base,
      status,
      execution: terminalAwxStatus(jobSummary.status) ? 'captured' : 'submitted',
      awxJobId,
      awxJobStatus: stringValue(jobSummary.status) ?? 'unknown',
      jobTemplateId: numberValue(templateRecord.id),
      launchPath,
      launchRequest,
      launchResponse: redactAwxObject(launchResponse),
      jobSummary: redactAwxObject(jobSummary),
      events: {
        count: events.length,
        captured: events.length > 0
      },
      blockedReasons: [],
      nextActions: terminalAwxStatus(jobSummary.status)
        ? ['review-awx-worker-report', 'sync-observability-evidence']
        : ['wait-for-awx-job-completion', 'sync-awx-events-to-worker-report']
    };
    return {
      awxLaunch,
      reportResult: terminalAwxStatus(jobSummary.status)
        ? awxEventReport(job, awxLaunch, events, jobSummary.status)
        : null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AWX launch failed';
    const evidence = {
      ...base,
      status: 'failed',
      execution: 'failed',
      error: message,
      blockedReasons: [],
      nextActions: ['inspect-awx-api-connectivity', 'rerun-awx-provider-check']
    };
    return {
      awxLaunch: evidence,
      reportResult: failureReport(job, evidence, message)
    };
  }
}

function baseLaunch(
  job: SiteSlotWorkerJob,
  provider: AwxProviderConfig | null,
  template: string,
  inventory: string,
  credential: string,
  waitForCompletion: boolean,
  timeoutSeconds: number
) {
  return {
    awxLaunchId: `awx_launch_${job.jobId}`,
    provider: 'awx-api',
    providerId: provider?.providerId ?? null,
    baseUrl: provider?.baseUrl ?? null,
    organization: provider?.organization ?? 'MX Internal',
    project: provider?.project ?? 'mx-launcher-site-slots',
    jobTemplate: template,
    inventory,
    credential,
    jobId: job.jobId,
    planId: job.planId,
    siteId: job.siteId,
    kind: job.kind,
    boundary: 'awx-api-real-launch',
    waitForCompletion,
    timeoutSeconds,
    warnings: [
      ...(provider?.warnings ?? []),
      ...(provider?.verifyTls === false ? ['verifyTls=false is recorded; platform TLS trust still applies to fetch'] : [])
    ],
    notes: [
      'This action calls the AWX API and may cause AWX to execute Ansible against the selected slot host.',
      'Internal still owns the worker job, evidence, audit, and rollback policy.'
    ]
  };
}

function awxLaunchBlockedReasons(
  provider: AwxProviderConfig | null,
  token: string | null,
  confirmed: boolean,
  runtimePolicy: RuntimeFeaturePolicy | null | undefined
): string[] {
  return [
    ...awxRuntimeGateReasons('AWX_API_LAUNCH_ENABLED', AWX_LAUNCH_FEATURE_KEY, runtimePolicy),
    ...(confirmed ? [] : ['confirmAwxLaunch=true is required']),
    ...(provider ? [] : ['active AWX provider is required']),
    ...(provider?.status === 'active' ? [] : [`AWX provider is ${provider?.status ?? 'missing'}`]),
    ...(provider?.baseUrl ? [] : ['AWX provider baseUrl is required']),
    ...(token ? [] : ['AWX API bearer token is required'])
  ];
}

async function findAwxJobTemplate(
  baseUrl: string,
  template: string,
  headers: Record<string, string>,
  timeoutSeconds: number
): Promise<AwxRecord | null> {
  const response = await awxRequest(baseUrl, `/api/v2/job_templates/?name=${encodeURIComponent(template)}`, {
    method: 'GET',
    headers,
    timeoutSeconds
  }) as AwxListResponse;
  const results = Array.isArray(response.results) ? response.results : [];
  return results.find((item) => stringValue(asRecord(item).name) === template) as AwxRecord | undefined
    ?? results[0] as AwxRecord | undefined
    ?? null;
}

function awxLaunchRequest(
  job: SiteSlotWorkerJob,
  plan: SiteSlotPlan | null,
  sshProfile: SiteSlotSshProfile | null,
  inventory: string
) {
  return {
    limit: job.siteId,
    diff_mode: true,
    job_tags: '',
    skip_tags: '',
    extra_vars: {
      mx_plan_id: job.planId,
      mx_job_id: job.jobId,
      mx_session_id: job.sessionId,
      mx_run_id: job.runId,
      mx_site_id: job.siteId,
      mx_site_kind: job.kind,
      mx_environment: job.environment,
      mx_inventory: inventory,
      mx_host: plan?.host ?? sshProfile?.host ?? null,
      mx_ssh_user: plan?.ssh.user ?? sshProfile?.sshUser ?? null,
      mx_ssh_port: plan?.ssh.port ?? sshProfile?.sshPort ?? null,
      mx_ssh_profile_id: sshProfile?.profileId ?? plan?.ssh.profileId ?? null,
      mx_worker_steps: job.steps.map((step) => ({
        step_id: step.stepId,
        source_id: step.sourceId,
        order: step.order,
        target: step.target,
        requires_root: step.requiresRoot,
        timeout_seconds: step.timeoutSeconds,
        command: step.command
      }))
    }
  };
}

async function waitForAwxJob(
  baseUrl: string,
  path: string,
  headers: Record<string, string>,
  timeoutSeconds: number,
  pollIntervalMs: number
): Promise<AwxRecord> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let latest: AwxRecord = {};
  while (Date.now() <= deadline) {
    latest = await awxRequest(baseUrl, path, { method: 'GET', headers, timeoutSeconds }) as AwxRecord;
    if (terminalAwxStatus(latest.status)) return latest;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return latest;
}

async function fetchAwxJobEvents(
  baseUrl: string,
  awxJobId: number,
  headers: Record<string, string>,
  timeoutSeconds: number
): Promise<AwxRecord[]> {
  const response = await awxRequest(baseUrl, `/api/v2/jobs/${encodeURIComponent(String(awxJobId))}/job_events/?order_by=counter&page_size=200`, {
    method: 'GET',
    headers,
    timeoutSeconds
  }) as AwxListResponse;
  return Array.isArray(response.results) ? response.results.map((item) => asRecord(item)) : [];
}

async function awxRequest(
  baseUrl: string,
  path: string,
  options: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    timeoutSeconds: number;
    body?: unknown;
  }
): Promise<AwxRecord> {
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
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function awxEventReport(
  job: SiteSlotWorkerJob,
  awxLaunch: Record<string, unknown>,
  events: AwxRecord[],
  awxStatus: unknown
): {
  status: NonNullable<SiteSlotWorkerReportInput['status']>;
  stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']>;
} {
  const status = awxStatus === 'successful' ? 'passed' : 'failed';
  const stepReports = job.steps.map((step, index) => {
    const event = eventForStep(events, step.sourceId, index);
    const failed = event ? awxEventFailed(event) : false;
    const stepStatus: SiteSlotWorkerReportStatus = status === 'passed'
      ? 'passed'
      : failed || index === 0 && !events.length
        ? 'failed'
        : 'blocked';
    return {
      stepId: step.stepId,
      status: stepStatus,
      exitCode: stepStatus === 'passed' ? 0 : stepStatus === 'failed' ? 1 : null,
      stdout: JSON.stringify({
        mode: 'awx-api',
        execution: 'captured',
        boundary: 'awx-api-real-launch',
        awx: {
          launch: awxLaunch,
          event: event ? redactAwxObject(event) : null
        },
        command: step.command
      }, null, 2),
      stderr: stepStatus === 'failed' ? awxEventMessage(event) : null,
      startedAt: stringValue(event?.created) ?? stringValue(event?.start_line) ?? new Date().toISOString(),
      finishedAt: stringValue(event?.modified) ?? new Date().toISOString(),
      attempt: 1
    };
  });
  return { status, stepReports };
}

function failureReport(
  job: SiteSlotWorkerJob,
  evidence: Record<string, unknown>,
  message: string
): {
  status: NonNullable<SiteSlotWorkerReportInput['status']>;
  stepReports: NonNullable<SiteSlotWorkerReportInput['stepReports']>;
} {
  return {
    status: 'failed',
    stepReports: job.steps.map((step, index) => ({
      stepId: step.stepId,
      status: index === 0 ? 'failed' : 'blocked',
      exitCode: index === 0 ? 1 : null,
      stdout: JSON.stringify({
        mode: 'awx-api',
        execution: 'failed',
        boundary: 'awx-api-real-launch',
        awx: evidence,
        command: step.command
      }, null, 2),
      stderr: index === 0 ? message : 'blocked: previous AWX launch step failed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      attempt: 1
    }))
  };
}

function eventForStep(events: AwxRecord[], sourceId: string, index: number): AwxRecord | null {
  return events.find((event) => stringValue(asRecord(event.event_data).task) === sourceId)
    ?? events.find((event) => stringValue(event.task) === sourceId)
    ?? events[index]
    ?? null;
}

function awxEventFailed(event: AwxRecord): boolean {
  const type = stringValue(event.event)?.toLowerCase() ?? '';
  return type.includes('failed') || type.includes('unreachable');
}

function awxEventMessage(event: AwxRecord | null): string {
  if (!event) return 'AWX job failed before events were captured';
  return stringValue(event.stdout)
    ?? stringValue(asRecord(event.event_data).res)
    ?? stringValue(event.event)
    ?? 'AWX task failed';
}

function awxLaunchStatus(status: unknown, waitForCompletion: boolean): 'running' | 'passed' | 'failed' {
  if (status === 'successful') return 'passed';
  if (terminalAwxStatus(status)) return 'failed';
  return waitForCompletion ? 'running' : 'running';
}

function terminalAwxStatus(status: unknown): boolean {
  return status === 'successful'
    || status === 'failed'
    || status === 'error'
    || status === 'canceled';
}

function redactAwxObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactAwxObject(item));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token|password|secret|credential/i.test(key)) {
      result[key] = '[redacted]';
    } else {
      result[key] = redactAwxObject(raw);
    }
  }
  return result;
}

function parseJsonObject(text: string): AwxRecord {
  try {
    const value = text ? JSON.parse(text) : {};
    return asRecord(value);
  } catch {
    return {};
  }
}

function normalizedAwxBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function asRecord(value: unknown): AwxRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AwxRecord : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
