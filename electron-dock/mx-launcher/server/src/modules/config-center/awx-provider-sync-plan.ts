import type {
  AwxProviderConfig,
  AwxProviderSyncPlan,
  AwxProviderSyncPlanInput,
  SiteSlotKind
} from '../../types.js';

export type AwxProviderObjectNameInput = {
  kind: SiteSlotKind;
  environment?: string | null;
  siteId?: string | null;
  sshProfileId?: string | null;
};

export function buildAwxProviderObjectNames(
  provider: AwxProviderConfig | null,
  input: AwxProviderObjectNameInput
): {
  organization: string;
  project: string;
  inventory: string;
  inventoryHost: string | null;
  credential: string;
  jobTemplate: string;
  requiredPlaybook: string;
} {
  const environment = input.environment || provider?.environment || 'local';
  const siteId = input.siteId?.trim() || null;
  return {
    organization: provider?.organization ?? 'MX Internal',
    project: provider?.project ?? 'mx-launcher-site-slots',
    inventory: `${provider?.inventoryPrefix ?? 'mx'}-${environment}-${input.kind}`,
    inventoryHost: siteId,
    credential: input.sshProfileId?.trim()
      || `${provider?.credentialPrefix ?? 'mx'}-${input.kind}-${siteId ?? 'site'}-machine`,
    jobTemplate: `${provider?.jobTemplatePrefix ?? 'mx-site-slot'}-${input.kind}-worker-v1`,
    requiredPlaybook: 'mx-site-slot-worker-v1.yml'
  };
}

export function buildAwxProviderSyncPlan(
  provider: AwxProviderConfig | null,
  input: AwxProviderSyncPlanInput
): AwxProviderSyncPlan {
  const generatedAt = new Date().toISOString();
  const targetKind = awxSyncKind(input.kind, provider?.defaultKind ?? null);
  const siteId = stringValue(input.siteId);
  const host = stringValue(input.host);
  const sshUser = stringValue(input.sshUser);
  const sshProfileId = stringValue(input.sshProfileId);
  const sshPort = positiveInteger(input.sshPort);
  const names = buildAwxProviderObjectNames(provider, {
    kind: targetKind,
    environment: provider?.environment ?? null,
    siteId,
    sshProfileId
  });
  const blockedReasons = [
    ...(provider ? [] : ['active AWX provider is required']),
    ...(provider?.status === 'active' ? [] : [`AWX provider is ${provider?.status ?? 'missing'}`]),
    ...(provider?.baseUrl ? [] : ['AWX provider baseUrl is required before object sync can run']),
    ...(siteId ? [] : ['siteId is required for AWX inventory host']),
    ...(host ? [] : ['host is required for AWX inventory host ansible_host']),
    ...(sshUser ? [] : ['sshUser is required for AWX machine execution']),
    ...(sshPort ? [] : ['sshPort is required for AWX machine execution']),
    ...(sshProfileId ? [] : ['sshProfileId is required so AWX credential can reference Internal secret material'])
  ];
  const status = blockedReasons.length > 0 ? 'blocked' : 'ready';
  const baseFields = {
    mx_site_id: siteId,
    mx_site_kind: targetKind,
    mx_provider_id: provider?.providerId ?? null
  };
  const objects = [
    awxObject('organization', names.organization, '/api/v2/organizations/', 'POST', true, status, {
      name: names.organization,
      description: 'MX Launcher Internal managed organization'
    }),
    awxObject('project', names.project, '/api/v2/projects/', 'POST', true, status, {
      name: names.project,
      organization: names.organization,
      scm_type: 'manual',
      local_path: '_mx_launcher_awx_project'
    }),
    awxObject('inventory', names.inventory, '/api/v2/inventories/', 'POST', true, status, {
      name: names.inventory,
      organization: names.organization,
      variables: baseFields
    }),
    awxObject('host', names.inventoryHost ?? `${targetKind}-slot`, '/api/v2/hosts/', 'POST', true, status, {
      name: names.inventoryHost,
      inventory: names.inventory,
      enabled: true,
      variables: {
        ...baseFields,
        ansible_host: host,
        ansible_user: sshUser,
        ansible_port: sshPort,
        mx_ssh_profile_id: sshProfileId
      }
    }),
    awxObject('credential', names.credential, '/api/v2/credentials/', 'POST', true, status, {
      name: names.credential,
      organization: names.organization,
      credential_type: 'Machine',
      secret_source: 'internal-config-center',
      sshProfileId,
      material: 'private-key-reference-only'
    }),
    awxObject('job-template', names.jobTemplate, '/api/v2/job_templates/', 'POST', true, status, {
      name: names.jobTemplate,
      organization: names.organization,
      project: names.project,
      inventory: names.inventory,
      credentials: [names.credential],
      playbook: names.requiredPlaybook,
      diff_mode: true,
      ask_limit_on_launch: true,
      ask_variables_on_launch: true
    })
  ];
  return {
    syncPlanId: `awx_syncplan_${stringValue(input.jobId) ?? siteId ?? provider?.providerId ?? 'draft'}`,
    generatedAt,
    mode: 'awx-object-sync-plan',
    status,
    execution: 'not-started',
    boundary: 'awx-object-sync-plan-only',
    providerId: provider?.providerId ?? null,
    baseUrl: provider?.baseUrl ?? null,
    organization: names.organization,
    project: names.project,
    targetKind,
    siteId,
    host,
    sshUser,
    sshPort,
    sshProfileId,
    inventory: names.inventory,
    inventoryHost: names.inventoryHost,
    credential: names.credential,
    jobTemplate: names.jobTemplate,
    requiredPlaybook: names.requiredPlaybook,
    objects,
    extraVarsContract: [
      'mx_plan_id',
      'mx_job_id',
      'mx_session_id',
      'mx_run_id',
      'mx_site_id',
      'mx_site_kind',
      'mx_environment',
      'mx_inventory',
      'mx_host',
      'mx_ssh_user',
      'mx_ssh_port',
      'mx_ssh_profile_id',
      'mx_worker_steps'
    ],
    blockedReasons,
    warnings: [
      ...(provider?.warnings ?? []),
      ...(provider?.verifyTls === false ? ['verifyTls=false is recorded; platform TLS trust still applies to AWX API calls'] : []),
      ...(provider && provider.defaultKind !== targetKind && provider.defaultKind !== 'all'
        ? [`provider defaultKind=${provider.defaultKind} is being reused for ${targetKind}`]
        : [])
    ],
    nextActions: status === 'ready'
      ? ['sync-awx-credential-with-token', 'sync-awx-objects-with-token', 'run-awx-provider-check', 'launch-awx-job-after-check']
      : ['fix-awx-provider-config', 'bind-site-slot-ssh-profile', 'rerun-awx-sync-plan']
  };
}

function awxObject(
  objectType: AwxProviderSyncPlan['objects'][number]['objectType'],
  name: string,
  endpoint: string,
  method: AwxProviderSyncPlan['objects'][number]['method'],
  required: boolean,
  planStatus: AwxProviderSyncPlan['status'],
  fields: Record<string, unknown>
): AwxProviderSyncPlan['objects'][number] {
  return {
    objectType,
    name,
    endpoint,
    method,
    required,
    status: planStatus === 'ready' ? 'planned' : 'blocked',
    fields,
    notes: ['plan-only: no AWX API mutation is executed by this action']
  };
}

function awxSyncKind(inputKind: AwxProviderSyncPlanInput['kind'], defaultKind: AwxProviderConfig['defaultKind'] | null): SiteSlotKind {
  if (inputKind === 'domestic' || inputKind === 'oversea') return inputKind;
  return defaultKind === 'domestic' ? 'domestic' : 'oversea';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)) && Number(value) > 0) return Math.floor(Number(value));
  return null;
}
