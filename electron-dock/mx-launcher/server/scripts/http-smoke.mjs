import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const cliBaseUrl = process.argv.slice(2).find((arg) => arg !== '--');
const baseUrl = (cliBaseUrl || process.env.MX_SMOKE_BASE_URL || 'http://127.0.0.1:18090').replace(/\/+$/, '');
const expectK8sApply = process.env.MX_SMOKE_EXPECT_K8S_APPLY === '1';
const remoteReadyOnly = process.env.MX_SMOKE_REMOTE_READY_ONLY === '1';
const state = {};
const mxLauncherRoot = resolve(scriptDir, '../..');
const remoteReadyFixture = remoteReadyOnly ? prepareRemoteReadySshFixture() : null;

const checks = [
  {
    name: 'healthz',
    path: '/healthz',
    assert: (body) => body && body.ok === true && body.service === 'mx-launcher-server'
  },
  {
    name: 'app-center apps',
    path: '/internal/v1/app-center/apps',
    assert: (body) => Array.isArray(body?.apps) && body.apps.some((app) => app.appId === 'h2o')
  },
  {
    name: 'sdk gateway manifest',
    path: '/internal/v1/sdk/gateway/manifest',
    assert: (body) => Array.isArray(body?.gateway?.routes)
      && body.gateway.routes.some((route) => route.routeId === 'sdk.identity.introspect')
      && body.gateway.routes.some((route) => route.routeId === 'sdk.gateway.access.evaluate')
      && body.gateway.routes.some((route) => route.routeId === 'sdk.config.snapshot')
      && body.gateway.routes.some((route) => route.routeId === 'sdk.dns.zone')
      && body.gateway.routes.some((route) => route.routeId === 'sdk.dns.coredns-configmap')
      && body.gateway.authAuthority === 'user-center'
  },
  {
    name: 'anonymous enroll',
    path: '/internal/v1/enrollments/anonymous',
    method: 'POST',
    body: {
      productId: 'h2o',
      platform: 'darwin',
      requestId: 'http-smoke-enroll'
    },
    assert: (body) => {
      state.installId = body?.enrollment?.installId;
      return typeof state.installId === 'string'
        && body?.snapshot?.config?.defaultMode === 'visitor';
    }
  },
  {
    name: 'user center bootstrap',
    path: '/internal/v1/user-center/bootstrap',
    method: 'POST',
    body: { requestId: 'http-smoke-user-center-bootstrap' },
    assert: (body) => Array.isArray(body?.userCenter?.roles)
      && body.userCenter.roles.some((role) => role.roleId === 'mx-service-account')
      && body.userCenter.serviceAccounts.some((account) => account.serviceAccountId === 'svc_sdk_gateway')
  },
  {
    name: 'user center issue service token',
    path: '/internal/v1/user-center/tokens/issue',
    method: 'POST',
    body: {
      subjectKind: 'service-account',
      subjectId: 'svc_sdk_gateway',
      audience: 'mx-sdk',
      requestId: 'http-smoke-service-token'
    },
    assert: (body) => {
      state.serviceToken = body?.issued?.token;
      return typeof state.serviceToken === 'string'
        && body?.issued?.record?.subjectKind === 'service-account'
        && body?.issued?.record?.scopes?.includes('sdk.config.snapshot')
        && body?.issued?.record?.scopes?.includes('sdk.dns.evaluate');
    }
  },
  {
    name: 'sdk identity introspect',
    path: '/internal/v1/sdk/identity/introspect',
    method: 'POST',
    body: () => ({
      token: state.serviceToken,
      audience: 'mx-sdk',
      requestId: 'http-smoke-sdk-introspect'
    }),
    assert: (body) => body?.introspection?.active === true
      && body?.introspection?.principal?.kind === 'service-account'
  },
  {
    name: 'sdk gateway access allow',
    path: '/internal/v1/sdk/gateway/access/evaluate',
    method: 'POST',
    body: () => ({
      token: state.serviceToken,
      audience: 'mx-sdk',
      routeId: 'sdk.dns.evaluate',
      requestId: 'http-smoke-sdk-access'
    }),
    assert: (body) => body?.decision?.allowed === true
      && body?.decision?.matchedScopes?.includes('sdk.dns.evaluate')
  },
  {
    name: 'sdk config snapshot',
    path: '/internal/v1/sdk/config/snapshot',
    method: 'POST',
    body: () => ({
      token: state.serviceToken,
      audience: 'mx-sdk',
      installId: state.installId,
      appId: 'h2o',
      channel: 'shadow',
      requestId: 'http-smoke-config-policy'
    }),
    assert: (body) => body?.snapshot?.signatures?.algorithm === 'sha256-dev-digest'
      && typeof body?.snapshot?.signatures?.digest === 'string'
      && body?.snapshot?.policies?.dns?.policy?.policyId === 'dns_default_internal_split'
      && body?.snapshot?.policies?.launcherNetwork?.overlayPolicy?.cidr === '10.91.0.0/16'
      && body?.snapshot?.policies?.permissionPolicy?.declaredScopes?.includes('network.dns.policy')
  },
  {
    name: 'config center capabilities',
    path: '/internal/v1/config-center/capabilities',
    assert: (body) => body?.authority === 'config-center'
      && body?.capabilities?.includes('site-slot-ssh-profile.manage')
      && body?.capabilities?.includes('site-slot-ssh-profile.bootstrap')
      && body?.capabilities?.includes('runtime-feature-policy.manage')
  },
  {
    name: 'config center runtime feature policy upsert',
    path: '/internal/v1/config-center/runtime-feature-policies',
    method: 'POST',
    body: {
      featureKey: 'site-slot.ssh-readonly-probe.execute',
      scopeKind: 'global',
      enabled: false,
      mode: 'disabled',
      requiresApproval: true,
      reason: 'http-smoke disabled global hardening baseline',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-runtime-feature-policy'
    },
    assert: (body) => {
      state.runtimeFeaturePolicyId = body?.policy?.policyId;
      return typeof state.runtimeFeaturePolicyId === 'string'
        && body?.policy?.featureKey === 'site-slot.ssh-readonly-probe.execute'
        && body?.policy?.scopeKind === 'global'
        && body?.policy?.enabled === false
        && body?.policy?.mode === 'disabled';
    }
  },
  {
    name: 'config center runtime feature policy list',
    path: '/internal/v1/config-center/runtime-feature-policies?featureKey=site-slot.ssh-readonly-probe.execute',
    assert: (body) => Array.isArray(body?.policies)
      && body.policies.some((policy) => policy.policyId === state.runtimeFeaturePolicyId)
  },
  {
    name: 'config center runtime feature policy get',
    path: () => `/internal/v1/config-center/runtime-feature-policies/${encodeURIComponent(state.runtimeFeaturePolicyId)}`,
    assert: (body) => body?.policy?.policyId === state.runtimeFeaturePolicyId
      && body?.policy?.requiresApproval === true
  },
  {
    name: 'config center ssh profile upsert',
    path: '/internal/v1/config-center/site-slot-ssh-profiles',
    method: 'POST',
    body: {
      profileId: 'sshprof_http_smoke_oversea',
      siteId: 'oversea-main',
      kind: 'oversea',
      host: 'oversea.example.com',
      sshUser: 'root',
      sshPort: 22,
      identityFile: '/opt/mx/ssh/oversea-main_ed25519',
      knownHostsFile: '/opt/mx/ssh/known_hosts.oversea-main',
      hostKeyAlias: 'oversea-main',
      strictHostKeyChecking: 'yes',
      connectTimeoutSeconds: 9,
      batchMode: 'yes',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-ssh-profile'
    },
    assert: (body) => {
      state.sshProfileId = body?.profile?.profileId;
      return state.sshProfileId === 'sshprof_http_smoke_oversea'
        && body?.profile?.siteId === 'oversea-main'
        && body?.profile?.status === 'active'
        && body?.profile?.strictHostKeyChecking === 'yes'
        && body?.profile?.connectTimeoutSeconds === 9
        && Array.isArray(body?.profile?.warnings);
    }
  },
  {
    name: 'config center ssh profile bootstrap planned',
    path: '/internal/v1/config-center/site-slot-ssh-profiles/bootstrap',
    method: 'POST',
    body: {
      profileId: 'sshprof_http_smoke_bootstrap_oversea',
      siteId: 'oversea-bootstrap-smoke',
      kind: 'oversea',
      host: 'oversea-bootstrap.example.com',
      sshUser: 'ubuntu',
      sshPort: 22,
      hostKeyAlias: 'oversea-bootstrap-smoke',
      connectTimeoutSeconds: 9,
      scanHostKey: false,
      executeBootstrap: false,
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-ssh-bootstrap'
    },
    assert: (body) => {
      state.sshBootstrapProfileId = body?.profile?.profileId;
      const serialized = JSON.stringify(body);
      return state.sshBootstrapProfileId === 'sshprof_http_smoke_bootstrap_oversea'
        && body?.profile?.siteId === 'oversea-bootstrap-smoke'
        && body?.profile?.identityFile?.includes('oversea-bootstrap-smoke_rsa')
        && body?.profile?.knownHostsFile?.includes('known_hosts.oversea-bootstrap-smoke')
        && body?.bootstrap?.status === 'planned'
        && body?.bootstrap?.execution === 'not-started'
        && body?.bootstrap?.boundary === 'ssh-password-bootstrap'
        && body?.bootstrap?.key?.identityFile?.includes('oversea-bootstrap-smoke_rsa')
        && body?.bootstrap?.knownHosts?.status === 'not-requested'
        && body?.bootstrap?.install?.requested === false
        && body?.bootstrap?.install?.command?.includes('SSHPASS=***')
        && !serialized.includes('super-secret-password');
    }
  },
  {
    name: 'config center ssh profile list',
    path: '/internal/v1/config-center/site-slot-ssh-profiles',
    assert: (body) => Array.isArray(body?.profiles)
      && body.profiles.some((profile) => profile.profileId === state.sshProfileId)
      && body.profiles.some((profile) => profile.profileId === state.sshBootstrapProfileId)
  },
  {
    name: 'config center ssh profile get',
    path: () => `/internal/v1/config-center/site-slot-ssh-profiles/${encodeURIComponent(state.sshProfileId)}`,
    assert: (body) => body?.profile?.profileId === state.sshProfileId
      && body?.profile?.knownHostsFile === '/opt/mx/ssh/known_hosts.oversea-main'
  },
  {
    name: 'config center ssh profile by site',
    path: '/internal/v1/config-center/site-slot-ssh-profiles/site/oversea-main',
    assert: (body) => body?.profile?.profileId === state.sshProfileId
      && body?.profile?.hostKeyAlias === 'oversea-main'
  },
  {
    name: 'config center ssh profile readiness blocked',
    path: () => `/internal/v1/config-center/site-slot-ssh-profiles/${encodeURIComponent(state.sshProfileId)}/readiness-probe`,
    method: 'POST',
    body: {
      confirmReadOnlyProbe: true,
      executeReadOnlyProbe: false,
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-ssh-profile-readiness'
    },
    assert: (body) => body?.readiness?.status === 'blocked'
      && body?.readiness?.execution === 'not-started'
      && body?.readiness?.boundary === 'ssh-profile-readiness-readonly'
      && body?.readiness?.command?.startsWith('ssh ')
      && body?.readiness?.command?.includes('mx-readonly-profile-readiness')
      && body?.readiness?.command?.includes('df -h /')
      && body?.readiness?.sshProfile?.profileId === state.sshProfileId
      && body?.readiness?.sshProfile?.identityFileExists === false
      && body?.readiness?.sshProfile?.knownHostsFileExists === false
      && body?.readiness?.gates?.envGate?.status === 'blocked'
      && body?.readiness?.gates?.configGate?.status === 'blocked'
      && body?.readiness?.gates?.requestGate?.status === 'blocked'
      && body?.readiness?.gateFailures?.some((reason) => reason.includes('SSH identity file does not exist'))
      && body?.readiness?.gateFailures?.some((reason) => reason.includes('SSH known_hosts file does not exist'))
      && !body?.readiness?.executionResult
  },
  {
    name: 'user center issue user token',
    path: '/internal/v1/user-center/tokens/issue',
    method: 'POST',
    body: {
      subjectKind: 'user',
      subjectId: 'usr_demo_user',
      audience: 'mx-sdk',
      requestId: 'http-smoke-user-token'
    },
    assert: (body) => {
      state.userToken = body?.issued?.token;
      return typeof state.userToken === 'string'
        && body?.issued?.record?.subjectKind === 'user';
    }
  },
  {
    name: 'user center issue admin token',
    path: '/internal/v1/user-center/tokens/issue',
    method: 'POST',
    body: {
      subjectKind: 'user',
      subjectId: 'usr_demo_admin',
      audience: 'mx-admin',
      requestId: 'http-smoke-admin-token'
    },
    assert: (body) => {
      state.adminToken = body?.issued?.token;
      return typeof state.adminToken === 'string'
        && body?.issued?.record?.subjectKind === 'user'
        && body?.issued?.record?.scopes?.includes('site-slot.execute')
        && body?.issued?.record?.scopes?.includes('release.manage');
    }
  },
  {
    name: 'user center issue admin audience user token',
    path: '/internal/v1/user-center/tokens/issue',
    method: 'POST',
    body: {
      subjectKind: 'user',
      subjectId: 'usr_demo_user',
      audience: 'mx-admin',
      requestId: 'http-smoke-admin-audience-user-token'
    },
    assert: (body) => {
      state.adminAudienceUserToken = body?.issued?.token;
      return typeof state.adminAudienceUserToken === 'string'
        && body?.issued?.record?.subjectKind === 'user'
        && body?.issued?.record?.audience === 'mx-admin';
    }
  },
  {
    name: 'sdk gateway access deny',
    path: '/internal/v1/sdk/gateway/access/evaluate',
    method: 'POST',
    body: () => ({
      token: state.userToken,
      audience: 'mx-sdk',
      routeId: 'sdk.audit.write',
      requestId: 'http-smoke-sdk-deny'
    }),
    assert: (body) => body?.decision?.allowed === false
      && body?.decision?.missingScopes?.includes('sdk.audit.write')
  },
  {
    name: 'admin actions allow admin',
    path: () => `/internal/v1/admin/actions?token=${encodeURIComponent(state.adminToken)}`,
    assert: (body) => body?.actionPolicy?.principal?.roles?.includes('mx-admin')
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.apply.confirm'
        && action.allowed === true
        && action.gate === 'confirm-apply')
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-run.simulate'
        && action.allowed === true
        && action.gate === 'manual-evidence')
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-run.remote-ssh-gate'
        && action.allowed === true
        && action.gate === 'manual-evidence')
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-run.remote-ssh-execute'
        && action.allowed === true
        && action.gate === 'confirm-remote-execution')
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-run.remote-ssh-readonly-probe'
        && action.allowed === true
        && action.gate === 'confirm-remote-execution'
        && action.confirmFields?.includes('confirmReadOnlyProbe'))
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-run.artifact-push-remote-ssh-plan'
        && action.allowed === true
        && action.gate === 'confirm-remote-execution'
        && action.confirmFields?.includes('confirmPlanOnly'))
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-run.artifact-push-fake-transport'
        && action.allowed === true
        && action.gate === 'confirm-fake-transport')
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'dns.coredns.apply'
        && action.allowed === true
        && action.requiredScopes?.includes('dns.manage'))
  },
  {
    name: 'admin actions deny user',
    path: () => `/internal/v1/admin/actions?token=${encodeURIComponent(state.adminAudienceUserToken)}`,
    assert: (body) => body?.actionPolicy?.principal?.roles?.includes('mx-user')
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.apply.confirm'
        && action.allowed === false
        && action.reason?.includes('site-slot.execute'))
  },
  {
    name: 'release management plan',
    path: '/internal/v1/release-management/plans',
    method: 'POST',
    body: () => ({
      releaseId: 'rel_http_smoke',
      installId: state.installId,
      channel: 'shadow',
      appId: 'h2o',
      e2eResult: 'passed',
      createdBy: 'http-smoke',
      requestId: 'http-smoke-release-management'
    }),
    assert: (body) => {
      state.releaseManagementPlanId = body?.plan?.planId;
      return typeof state.releaseManagementPlanId === 'string'
        && body?.plan?.test?.gate?.verdict === 'passed'
        && body?.plan?.decisions?.readyToPromote === true
        && body?.plan?.components?.launcher?.updateMode === 'mandatory'
        && body?.plan?.components?.app?.canSkip === true
        && body?.plan?.decisions?.nextActions?.includes('open-canary-or-shadow-rollout');
    }
  },
  {
    name: 'release management get',
    path: () => `/internal/v1/release-management/plans/${encodeURIComponent(state.releaseManagementPlanId)}`,
    assert: (body) => body?.plan?.planId === state.releaseManagementPlanId
      && body?.plan?.test?.run?.state === 'passed'
  },
  {
    name: 'site slots capabilities',
    path: '/internal/v1/site-slots/capabilities',
    assert: (body) => body?.capabilities?.supportedKinds?.includes('domestic')
      && body?.capabilities?.supportedKinds?.includes('oversea')
      && body?.capabilities?.supportedActions?.includes('preflight')
      && body?.capabilities?.supportedActions?.includes('apply')
      && body?.capabilities?.runnerModes?.includes('simulate')
      && body?.capabilities?.runnerModes?.includes('remote-ssh')
      && body?.capabilities?.executionBoundary === 'runner-session-v1'
      && body?.capabilities?.workerContract?.version === 'site-slot-worker-v1'
      && body?.capabilities?.rollbackContract?.version === 'site-slot-rollback-v1'
  },
  {
    name: 'oversea slot plan',
    path: '/internal/v1/site-slots/plans',
    method: 'POST',
    body: () => ({
      kind: 'oversea',
      siteId: 'oversea-main',
      sshProfileId: state.sshProfileId,
      hasDocker: true,
      hasOutboundInternet: true,
      requestId: 'http-smoke-oversea-slot'
    }),
    assert: (body) => {
      state.overseaSiteId = body?.plan?.siteId;
      state.overseaHost = body?.plan?.host;
      const packageArtifacts = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'package-slot-artifacts');
      const prepareAccess = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'prepare-access-stack');
      const configureAccess = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'configure-oversea-access');
      const publishSubscription = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'publish-internal-subscription');
      const deployServices = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'deploy-slot-services');
      const deploymentCommands = body?.plan?.deploymentPhases?.flatMap((phase) => phase.commands ?? []) ?? [];
      return body?.plan?.kind === 'oversea'
        && body?.plan?.ssh?.profileId === state.sshProfileId
        && body?.plan?.ssh?.profileSource === 'config-center'
        && body?.plan?.ssh?.profileStatus === 'active'
        && body?.plan?.host === 'oversea.example.com'
        && body?.plan?.ssh?.user === 'root'
        && body?.plan?.network?.qpTunnelCliMode === 'server-on'
        && body?.plan?.services?.dockerStacks?.includes('docker/hysteria2-access-stack')
        && packageArtifacts?.mode === 'admin-action'
        && packageArtifacts?.commands?.some((command) => command.includes('modules=hysteria2-access-stack,site-agent,runner-worker,observability-forwarder'))
        && packageArtifacts?.commands?.some((command) => command.includes('never sync the repository root'))
        && prepareAccess?.mode === 'artifact-push'
        && prepareAccess?.commands?.some((command) => command.includes('rsync -az') && command.includes('mx-oversea-access-stack.tar.gz'))
        && prepareAccess?.commands?.some((command) => command.includes('scp -P') && command.includes('mx-oversea-access-stack.tar.gz'))
        && prepareAccess?.commands?.some((command) => command.includes('/opt/mx/releases/oversea-access-stack/<release-revision>'))
        && configureAccess?.commands?.some((command) => command.includes('HY2_EXPORT_PASSWORD_HASH=<caddy-bcrypt-hash-from-internal-secret>'))
        && configureAccess?.commands?.some((command) => command.includes('HY2_MIHOMO_ROUTING_MODE=cn-direct') && command.includes('HY2_RESERVED_INTERNAL_CIDRS=10.88.0.0/16,10.89.0.0/16,10.90.0.0/16,10.91.0.0/16') && command.includes('HY2_DOMESTIC_GATEWAY_IP=10.88.0.1'))
        && configureAccess?.commands?.some((command) => command.includes('base64 -d') && command.includes('tunnel-state.json'))
        && configureAccess?.commands?.some((command) => command.includes('reconcile-from-json') && command.includes('--mode hysteria2-only'))
        && configureAccess?.commands?.some((command) => command.includes('@qpjoy/tunnel-cli') || command.includes('qp-tunnel-cli register'))
        && publishSubscription?.commands?.some((command) => command.includes('domesticBootstrapSubscription=') && command.includes('/subscriptions/hysteria2/domestic-bootstrap.yaml'))
        && deployServices?.mode === 'artifact-push'
        && deployServices?.commands?.some((command) => command.includes('rsync -az') && command.includes('mx-oversea-services.tar.gz'))
        && deployServices?.commands?.some((command) => command.includes('/opt/mx/incoming/mx-oversea-services.tar.gz'))
        && deployServices?.commands?.some((command) => command.includes('MX_SITE_ROLE=oversea') && command.includes('LOCAL_STACK_PATH=/opt/mx/current/hysteria2-access-stack') && command.includes('MX_ACCESS_RUNTIME=hysteria2-only'))
        && !deploymentCommands.some((command) => command.includes('git pull') || command.includes('git clone') || command.includes('./docker/'));
    }
  },
  {
    name: 'domestic slot plan',
    path: '/internal/v1/site-slots/plans',
    method: 'POST',
    body: () => ({
      kind: 'domestic',
      siteId: 'domestic-main',
      host: 'domestic.example.com',
      sshUser: 'root',
      rootAccess: true,
      hasDocker: true,
      hasOutboundInternet: false,
      overseaSiteId: state.overseaSiteId,
      overseaHost: state.overseaHost,
      internalBaseUrl: baseUrl,
      requestId: 'http-smoke-domestic-slot'
    }),
    assert: (body) => {
      state.domesticSlotPlanId = body?.plan?.planId;
      const packageArtifacts = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'package-slot-artifacts');
      const resolveSubscription = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'resolve-domestic-bootstrap-subscription');
      const bootstrapEgress = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'bootstrap-domestic-egress');
      return typeof state.domesticSlotPlanId === 'string'
        && body?.plan?.kind === 'domestic'
        && body?.plan?.network?.mode === 'oversea-assisted'
        && body?.plan?.network?.qpTunnelCliMode === 'server-on'
        && body?.plan?.services?.hostServices?.includes('wg-quick@mx-domestic')
        && packageArtifacts?.commands?.some((command) => command.includes('qp-tunnel-cli-offline-fallback'))
        && packageArtifacts?.commands?.some((command) => command.includes('refresh-tunnel-cli latest'))
        && resolveSubscription?.mode === 'admin-action'
        && resolveSubscription?.commands?.some((command) => command.includes('domesticBootstrapSubscription'))
        && resolveSubscription?.commands?.some((command) => command.includes('do not ask Domestic to npm install'))
        && bootstrapEgress?.mode === 'artifact-push'
        && bootstrapEgress?.commands?.some((command) => command.includes('npm i -g @qpjoy/tunnel-cli'))
        && bootstrapEgress?.commands?.some((command) => command.includes('mx-domestic-qp-tunnel-cli-fallback.tar.gz'))
        && bootstrapEgress?.commands?.some((command) => command.includes('server-on'))
        && !bootstrapEgress?.commands?.some((command) => command.includes('tun-on'));
    }
  },
  {
    name: 'domestic slot get',
    path: () => `/internal/v1/site-slots/plans/${encodeURIComponent(state.domesticSlotPlanId)}`,
    assert: (body) => body?.plan?.planId === state.domesticSlotPlanId
      && body?.plan?.nextActions?.includes('install-host-wireguard-service')
  },
  {
    name: 'domestic slot preflight execution',
    path: () => `/internal/v1/site-slots/plans/${encodeURIComponent(state.domesticSlotPlanId)}/preflight`,
    method: 'POST',
    body: {
      mode: 'dry-run',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-domestic-slot-preflight'
    },
    assert: (body) => {
      state.domesticSlotPreflightRunId = body?.execution?.runId;
      return typeof state.domesticSlotPreflightRunId === 'string'
        && body?.execution?.status === 'ready'
        && body?.execution?.dryRun === true
        && body?.execution?.remoteExecution?.supported === false
        && body?.execution?.steps?.some((step) => step.sourceId === 'domestic.wireguard');
    }
  },
  {
    name: 'domestic slot apply gate',
    path: () => `/internal/v1/site-slots/plans/${encodeURIComponent(state.domesticSlotPlanId)}/apply`,
    method: 'POST',
    body: {
      mode: 'manual',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-domestic-slot-apply-gate'
    },
    assert: (body) => body?.execution?.status === 'requires-confirmation'
      && body?.execution?.confirmApply === false
      && body?.execution?.nextActions?.includes('rerun-apply-with-confirmApply-true')
  },
  {
    name: 'admin action execute apply',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.adminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.apply.confirm',
      path: `/internal/v1/site-slots/plans/${encodeURIComponent(state.domesticSlotPlanId)}/apply`,
      body: {
        mode: 'manual',
        confirmApply: true,
        requestedBy: 'http-smoke-admin-action',
        requestId: 'http-smoke-admin-action-apply'
      }
    }),
    assert: (body) => {
      state.domesticSlotAdminApplyRunId = body?.execution?.runId;
      return body?.actionResult?.actionId === 'site-slot.apply.confirm'
        && body?.actionResult?.principalId === 'user:usr_demo_admin'
        && typeof state.domesticSlotAdminApplyRunId === 'string'
        && body?.execution?.status === 'ready'
        && body?.execution?.confirmApply === true;
    }
  },
  {
    name: 'domestic slot apply confirmed manifest',
    path: () => `/internal/v1/site-slots/plans/${encodeURIComponent(state.domesticSlotPlanId)}/apply`,
    method: 'POST',
    body: {
      mode: 'manual',
      confirmApply: true,
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-domestic-slot-apply-confirmed'
    },
    assert: (body) => {
      state.domesticSlotApplyRunId = body?.execution?.runId;
      return typeof state.domesticSlotApplyRunId === 'string'
        && body?.execution?.status === 'ready'
        && body?.execution?.confirmApply === true
        && body?.execution?.steps?.some((step) => step.sourceId.startsWith('bootstrap-domestic-egress.'));
    }
  },
  {
    name: 'domestic slot execution get',
    path: () => `/internal/v1/site-slots/executions/${encodeURIComponent(state.domesticSlotApplyRunId)}`,
    assert: (body) => body?.execution?.runId === state.domesticSlotApplyRunId
      && body?.execution?.action === 'apply'
      && body?.execution?.status === 'ready'
  },
  {
    name: 'domestic slot executions list',
    path: () => `/internal/v1/site-slots/executions?planId=${encodeURIComponent(state.domesticSlotPlanId)}`,
    assert: (body) => Array.isArray(body?.executions)
      && body.executions.some((execution) => execution.runId === state.domesticSlotPreflightRunId)
      && body.executions.some((execution) => execution.runId === state.domesticSlotApplyRunId)
  },
  {
    name: 'domestic slot runner simulate',
    path: () => `/internal/v1/site-slots/executions/${encodeURIComponent(state.domesticSlotPreflightRunId)}/runner-sessions`,
    method: 'POST',
    body: {
      mode: 'simulate',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-domestic-slot-runner-simulate'
    },
    assert: (body) => {
      state.domesticSlotRunnerSessionId = body?.session?.sessionId;
      return typeof state.domesticSlotRunnerSessionId === 'string'
        && body?.session?.status === 'completed'
        && body?.session?.dryRun === true
        && body?.session?.stepResults?.every((step) => step.status === 'simulated');
    }
  },
  {
    name: 'domestic slot runner get',
    path: () => `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(state.domesticSlotRunnerSessionId)}`,
    assert: (body) => body?.session?.sessionId === state.domesticSlotRunnerSessionId
      && body?.session?.status === 'completed'
  },
  {
    name: 'domestic slot runner remote gate',
    path: () => `/internal/v1/site-slots/executions/${encodeURIComponent(state.domesticSlotPreflightRunId)}/runner-sessions`,
    method: 'POST',
    body: {
      mode: 'remote-ssh',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-domestic-slot-runner-remote-gate'
    },
    assert: (body) => body?.session?.status === 'blocked'
      && body?.session?.warnings?.some((warning) => warning.includes('SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED'))
      && body?.session?.stepResults?.every((step) => step.status === 'blocked')
  },
  {
    name: 'domestic slot runner sessions list',
    path: () => `/internal/v1/site-slots/runner-sessions?runId=${encodeURIComponent(state.domesticSlotPreflightRunId)}`,
    assert: (body) => Array.isArray(body?.sessions)
      && body.sessions.some((session) => session.sessionId === state.domesticSlotRunnerSessionId)
      && body.sessions.some((session) => session.status === 'blocked' && session.mode === 'remote-ssh')
  },
  {
    name: 'domestic slot worker job',
    path: () => `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(state.domesticSlotRunnerSessionId)}/worker-jobs`,
    method: 'POST',
    body: {
      workerId: 'worker-http-smoke',
      workerKind: 'internal-runner',
      retryLimit: 2,
      rollbackStrategy: 'no-op-simulated-rollback',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-worker-job'
    },
    assert: (body) => {
      state.domesticSlotWorkerJobId = body?.job?.jobId;
      state.domesticSlotWorkerStepId = body?.job?.steps?.[0]?.stepId;
      return typeof state.domesticSlotWorkerJobId === 'string'
        && typeof state.domesticSlotWorkerStepId === 'string'
        && body?.job?.contractVersion === 'site-slot-worker-v1'
        && body?.job?.status === 'ready'
        && body?.job?.retryPolicy?.maxAttempts === 2
        && body?.job?.rollbackPolicy?.strategy === 'no-op-simulated-rollback';
    }
  },
  {
    name: 'domestic slot worker job get',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotWorkerJobId)}`,
    assert: (body) => body?.job?.jobId === state.domesticSlotWorkerJobId
      && body?.job?.worker?.workerId === 'worker-http-smoke'
  },
  {
    name: 'admin worker-run runner simulate',
    path: () => `/internal/v1/site-slots/executions/${encodeURIComponent(state.domesticSlotAdminApplyRunId)}/runner-sessions`,
    method: 'POST',
    body: {
      mode: 'simulate',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-admin-worker-runner'
    },
    assert: (body) => {
      state.domesticSlotAdminWorkerRunnerSessionId = body?.session?.sessionId;
      return typeof state.domesticSlotAdminWorkerRunnerSessionId === 'string'
        && body?.session?.status === 'completed';
    }
  },
  {
    name: 'admin worker-run worker job',
    path: () => `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(state.domesticSlotAdminWorkerRunnerSessionId)}/worker-jobs`,
    method: 'POST',
    body: {
      workerId: 'worker-http-smoke-admin-run',
      workerKind: 'internal-runner',
      rollbackStrategy: 'restore-admin-worker-run',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-admin-worker-job'
    },
    assert: (body) => {
      state.domesticSlotAdminWorkerJobId = body?.job?.jobId;
      state.domesticSlotAdminWorkerStepId = body?.job?.steps?.[0]?.stepId;
      return typeof state.domesticSlotAdminWorkerJobId === 'string'
        && typeof state.domesticSlotAdminWorkerStepId === 'string'
        && body?.job?.status === 'ready';
    }
  },
  {
    name: 'site-slot worker remote ssh gate blocked',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotAdminWorkerJobId)}/remote-ssh-gate`,
    method: 'POST',
    body: {
      confirmRemoteExecution: true,
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-site-slot-worker-remote-ssh-gate'
    },
    assert: (body) => body?.gate?.verdict === 'blocked'
      && body?.gate?.status === 'blocked'
      && body?.gate?.jobId === state.domesticSlotAdminWorkerJobId
      && body?.gate?.execution === 'not-executed'
      && body?.gate?.environmentGates?.SITE_SLOT_WORKER_REMOTE_SSH === 'missing'
      && body?.gate?.gateFailures?.some((failure) => failure.includes('worker job mode must be remote-ssh'))
      && body?.gate?.gateFailures?.some((failure) => failure.includes('SITE_SLOT_WORKER_REMOTE_SSH=1 is required'))
      && body?.gate?.stepGates?.some((step) => step.commandKind === 'artifact-transport'
        && step.transport?.repositoryRootSynced === false
        && step.artifactReferences?.some((artifact) => artifact?.manifest?.sha256Status === 'passed'
          && artifact?.module?.sha256Status === 'passed'
          && typeof artifact?.module?.targetPath === 'string'))
  },
  {
    name: 'site-slot worker remote ssh handoff blocked',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotAdminWorkerJobId)}/run-artifact-push-remote-ssh`,
    method: 'POST',
    body: () => ({
      confirmRemoteExecution: true,
      confirmWorkerHandoff: true,
      internalBaseUrl: baseUrl,
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-site-slot-worker-remote-ssh-handoff'
    }),
    assert: (body) => body?.gate?.verdict === 'blocked'
      && body?.workerHandoff?.status === 'blocked'
      && body?.workerHandoff?.execution === 'not-started'
      && body?.workerHandoff?.boundary === 'internal-worker-handoff-only'
      && body?.workerHandoff?.command?.includes('artifact-push-remote-ssh')
      && body?.workerHandoff?.env?.MX_INTERNAL_BASE_URL === baseUrl
      && body?.workerHandoff?.env?.SITE_SLOT_WORKER_REMOTE_SSH === '1'
      && body?.workerHandoff?.env?.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === '1'
      && body?.workerHandoff?.blockedReasons?.some((reason) => reason.includes('worker job mode must be remote-ssh'))
      && body?.workerHandoff?.blockedReasons?.some((reason) => reason.includes('SITE_SLOT_WORKER_REMOTE_SSH=1 is required'))
  },
  {
    name: 'site-slot worker remote ssh readonly probe blocked',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotAdminWorkerJobId)}/remote-ssh-readonly-probe`,
    method: 'POST',
    body: {
      confirmRemoteExecution: true,
      confirmReadOnlyProbe: true,
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-site-slot-worker-remote-ssh-readonly-probe'
    },
    assert: (body) => body?.gate?.verdict === 'blocked'
      && body?.readOnlyProbe?.status === 'blocked'
      && body?.readOnlyProbe?.execution === 'not-started'
      && body?.readOnlyProbe?.boundary === 'readonly-ssh-probe-handoff-only'
      && body?.readOnlyProbe?.command?.startsWith('ssh ')
      && body?.readOnlyProbe?.command?.includes('df -h /')
      && body?.readOnlyProbe?.env?.SITE_SLOT_READONLY_PROBE === '1'
      && body?.readOnlyProbe?.blockedReasons?.some((reason) => reason.includes('worker job mode must be remote-ssh'))
      && body?.readOnlyProbe?.blockedReasons?.some((reason) => reason.includes('SITE_SLOT_WORKER_REMOTE_SSH=1 is required'))
      && !body.report
  },
  {
    name: 'admin worker-run action hint',
    path: () => `/internal/v1/admin/site-slots/pipelines/${encodeURIComponent(state.domesticSlotPlanId)}?token=${encodeURIComponent(state.adminToken)}`,
    assert: (body) => body?.pipeline?.summary?.actionHints?.some((action) => action.actionId === 'site-slot.worker-run.remote-ssh-gate'
      && action.allowed === true
      && action.path === `/internal/v1/site-slots/worker-jobs/${state.domesticSlotAdminWorkerJobId}/remote-ssh-gate`)
      && body?.pipeline?.summary?.actionHints?.some((action) => action.actionId === 'site-slot.worker-run.remote-ssh-readonly-probe'
        && action.allowed === true
        && action.path === `/internal/v1/site-slots/worker-jobs/${state.domesticSlotAdminWorkerJobId}/remote-ssh-readonly-probe`
        && action.confirmFields?.includes('confirmReadOnlyProbe'))
      && body?.pipeline?.summary?.actionHints?.some((action) => action.actionId === 'site-slot.worker-run.remote-ssh-execute'
        && action.allowed === true
        && action.path === `/internal/v1/site-slots/worker-jobs/${state.domesticSlotAdminWorkerJobId}/run-artifact-push-remote-ssh`
        && action.confirmFields?.includes('confirmWorkerHandoff'))
      && body?.pipeline?.summary?.actionHints?.some((action) => action.actionId === 'site-slot.worker-run.artifact-push-remote-ssh-plan'
        && action.allowed === true
        && action.path === `/internal/v1/site-slots/worker-jobs/${state.domesticSlotAdminWorkerJobId}/run-artifact-push-remote-ssh-plan`
        && action.confirmFields?.includes('confirmPlanOnly'))
      && body?.pipeline?.summary?.actionHints?.some((action) => action.actionId === 'site-slot.worker-run.artifact-push-dry-run'
      && action.allowed === true
      && action.path === `/internal/v1/site-slots/worker-jobs/${state.domesticSlotAdminWorkerJobId}/run-artifact-push-dry-run`)
      && body?.pipeline?.summary?.actionHints?.some((action) => action.actionId === 'site-slot.worker-run.artifact-push-fake-transport'
        && action.allowed === true
        && action.path === `/internal/v1/site-slots/worker-jobs/${state.domesticSlotAdminWorkerJobId}/run-artifact-push-fake-transport`
        && action.confirmFields?.includes('confirmFakeTransport'))
  },
  {
    name: 'admin action execute worker-run remote ssh gate',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.adminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.remote-ssh-gate',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotAdminWorkerJobId)}/remote-ssh-gate`,
      body: {
        confirmRemoteExecution: true,
        requestedBy: 'http-smoke-admin-action',
        requestId: 'http-smoke-admin-worker-run-remote-ssh-gate'
      }
    }),
    assert: (body) => body?.actionResult?.actionId === 'site-slot.worker-run.remote-ssh-gate'
      && body?.gate?.verdict === 'blocked'
      && body?.gate?.status === 'blocked'
      && body?.gate?.jobId === state.domesticSlotAdminWorkerJobId
      && body?.gate?.execution === 'not-executed'
      && body?.gate?.environmentGates?.SITE_SLOT_WORKER_REMOTE_SSH === 'missing'
      && body?.gate?.gateFailures?.some((failure) => failure.includes('worker job mode must be remote-ssh'))
      && body?.gate?.gateFailures?.some((failure) => failure.includes('SITE_SLOT_WORKER_REMOTE_SSH=1 is required'))
      && body?.gate?.stepGates?.some((step) => step.commandKind === 'artifact-transport'
        && step.transport?.repositoryRootSynced === false
        && step.artifactReferences?.some((artifact) => artifact?.manifest?.sha256Status === 'passed'
          && artifact?.module?.sha256Status === 'passed'
          && typeof artifact?.module?.targetPath === 'string'))
  },
  {
    name: 'admin action execute worker-run remote ssh handoff blocked',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.adminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.remote-ssh-execute',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotAdminWorkerJobId)}/run-artifact-push-remote-ssh`,
      body: {
        confirmRemoteExecution: true,
        confirmWorkerHandoff: true,
        internalBaseUrl: baseUrl,
        requestedBy: 'http-smoke-admin-action',
        requestId: 'http-smoke-admin-worker-run-remote-ssh-execute'
      }
    }),
    assert: (body) => body?.actionResult?.actionId === 'site-slot.worker-run.remote-ssh-execute'
      && body?.gate?.verdict === 'blocked'
      && body?.workerHandoff?.status === 'blocked'
      && body?.workerHandoff?.execution === 'not-started'
      && body?.workerHandoff?.boundary === 'internal-worker-handoff-only'
      && body?.workerHandoff?.command?.includes('artifact-push-remote-ssh')
      && body?.workerHandoff?.env?.SITE_SLOT_WORKER_REMOTE_SSH === '1'
      && body?.workerHandoff?.env?.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === '1'
      && body?.workerHandoff?.blockedReasons?.some((reason) => reason.includes('worker job mode must be remote-ssh'))
      && body?.workerHandoff?.blockedReasons?.some((reason) => reason.includes('SITE_SLOT_WORKER_REMOTE_SSH=1 is required'))
  },
  {
    name: 'admin action execute worker-run remote ssh readonly probe blocked',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.adminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.remote-ssh-readonly-probe',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotAdminWorkerJobId)}/remote-ssh-readonly-probe`,
      body: {
        confirmRemoteExecution: true,
        confirmReadOnlyProbe: true,
        requestedBy: 'http-smoke-admin-action',
        requestId: 'http-smoke-admin-worker-run-remote-ssh-readonly-probe'
      }
    }),
    assert: (body) => body?.actionResult?.actionId === 'site-slot.worker-run.remote-ssh-readonly-probe'
      && body?.gate?.verdict === 'blocked'
      && body?.readOnlyProbe?.status === 'blocked'
      && body?.readOnlyProbe?.execution === 'not-started'
      && body?.readOnlyProbe?.boundary === 'readonly-ssh-probe-handoff-only'
      && body?.readOnlyProbe?.command?.startsWith('ssh ')
      && body?.readOnlyProbe?.command?.includes('docker version')
      && body?.readOnlyProbe?.env?.SITE_SLOT_READONLY_PROBE === '1'
      && body?.readOnlyProbe?.blockedReasons?.some((reason) => reason.includes('worker job mode must be remote-ssh'))
      && !body.report
  },
  {
    name: 'admin action execute worker-run artifact push dry-run',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.adminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.artifact-push-dry-run',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotAdminWorkerJobId)}/run-artifact-push-dry-run`,
      body: {
        workerId: 'worker-http-smoke-admin-run',
        message: 'http smoke admin artifact-push dry-run',
        requestedBy: 'http-smoke-admin-action',
        requestId: 'http-smoke-admin-worker-run-dry-run'
      }
    }),
    assert: (body) => {
      state.domesticSlotAdminWorkerRunReportId = body?.report?.reportId;
      const artifactEvidenceStep = body?.report?.stepReports?.find((step) => hasArtifactDryRunEvidence(step) && hasManifestArtifactEvidence(step));
      return body?.actionResult?.actionId === 'site-slot.worker-run.artifact-push-dry-run'
        && typeof state.domesticSlotAdminWorkerRunReportId === 'string'
        && body?.report?.status === 'passed'
        && body?.report?.stepReports?.some((step) => step.stepId === state.domesticSlotAdminWorkerStepId
          && step.exitCode === 0
          && typeof step.stdout === 'string'
          && step.stdout.includes('artifact-push dry-run: remote execution skipped')
          && step.stdout.includes('target='))
        && artifactEvidenceStep?.exitCode === 0
        && parseWorkerEvidence(artifactEvidenceStep.stdout)?.transport?.repositoryRootSynced === false;
    }
  },
  {
    name: 'admin worker-run job passed state',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotAdminWorkerJobId)}`,
    assert: (body) => body?.job?.status === 'passed'
      && body?.job?.currentReportId === state.domesticSlotAdminWorkerRunReportId
  },
  {
    name: 'domestic slot worker report',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotWorkerJobId)}/reports`,
    method: 'POST',
    body: () => ({
      workerId: 'worker-http-smoke',
      status: 'passed',
      message: 'http smoke worker report passed',
      stepReports: [
        {
          stepId: state.domesticSlotWorkerStepId,
          status: 'passed',
          exitCode: 0,
          stdout: 'http-smoke stdout',
          stderr: '',
          attempt: 1
        }
      ],
      requestId: 'http-smoke-worker-report'
    }),
    assert: (body) => {
      state.domesticSlotWorkerReportId = body?.report?.reportId;
      return typeof state.domesticSlotWorkerReportId === 'string'
        && body?.report?.status === 'passed'
        && body?.report?.stepReports?.[0]?.stdout === 'http-smoke stdout'
        && body?.report?.nextActions?.includes('close-change-window');
    }
  },
  {
    name: 'domestic slot worker report get',
    path: () => `/internal/v1/site-slots/worker-reports/${encodeURIComponent(state.domesticSlotWorkerReportId)}`,
    assert: (body) => body?.report?.reportId === state.domesticSlotWorkerReportId
      && body?.report?.jobId === state.domesticSlotWorkerJobId
  },
  {
    name: 'domestic slot worker reports list',
    path: () => `/internal/v1/site-slots/worker-reports?jobId=${encodeURIComponent(state.domesticSlotWorkerJobId)}`,
    assert: (body) => Array.isArray(body?.reports)
      && body.reports.some((report) => report.reportId === state.domesticSlotWorkerReportId)
  },
  {
    name: 'domestic slot worker job passed state',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotWorkerJobId)}`,
    assert: (body) => body?.job?.jobId === state.domesticSlotWorkerJobId
      && body?.job?.status === 'passed'
      && body?.job?.currentReportId === state.domesticSlotWorkerReportId
  },
  {
    name: 'domestic slot runner passed state',
    path: () => `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(state.domesticSlotRunnerSessionId)}`,
    assert: (body) => body?.session?.sessionId === state.domesticSlotRunnerSessionId
      && body?.session?.status === 'passed'
      && body?.session?.currentReportId === state.domesticSlotWorkerReportId
  },
  {
    name: 'domestic slot failed runner simulate',
    path: () => `/internal/v1/site-slots/executions/${encodeURIComponent(state.domesticSlotPreflightRunId)}/runner-sessions`,
    method: 'POST',
    body: {
      mode: 'simulate',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-domestic-slot-runner-failed-simulate'
    },
    assert: (body) => {
      state.domesticSlotFailedRunnerSessionId = body?.session?.sessionId;
      return typeof state.domesticSlotFailedRunnerSessionId === 'string'
        && body?.session?.status === 'completed';
    }
  },
  {
    name: 'domestic slot failed worker job',
    path: () => `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(state.domesticSlotFailedRunnerSessionId)}/worker-jobs`,
    method: 'POST',
    body: {
      workerId: 'worker-http-smoke-failed',
      workerKind: 'internal-runner',
      rollbackStrategy: 'restore-http-smoke-failure',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-worker-failed-job'
    },
    assert: (body) => {
      state.domesticSlotFailedWorkerJobId = body?.job?.jobId;
      state.domesticSlotFailedWorkerStepId = body?.job?.steps?.[0]?.stepId;
      return typeof state.domesticSlotFailedWorkerJobId === 'string'
        && typeof state.domesticSlotFailedWorkerStepId === 'string'
        && body?.job?.status === 'ready';
    }
  },
  {
    name: 'domestic slot failed worker report rollback',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotFailedWorkerJobId)}/reports`,
    method: 'POST',
    body: () => ({
      workerId: 'worker-http-smoke-failed',
      status: 'failed',
      message: 'http smoke worker report failed',
      stepReports: [
        {
          stepId: state.domesticSlotFailedWorkerStepId,
          status: 'failed',
          exitCode: 2,
          stdout: 'failed stdout',
          stderr: 'failed stderr',
          attempt: 1
        }
      ],
      requestId: 'http-smoke-worker-failed-report'
    }),
    assert: (body) => {
      state.domesticSlotFailedWorkerReportId = body?.report?.reportId;
      return typeof state.domesticSlotFailedWorkerReportId === 'string'
        && body?.report?.status === 'failed'
        && body?.report?.rollbackPlan?.status === 'planned'
        && body?.report?.rollbackPlan?.strategy === 'restore-http-smoke-failure';
    }
  },
  {
    name: 'domestic slot failed job state',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticSlotFailedWorkerJobId)}`,
    assert: (body) => body?.job?.status === 'failed'
      && body?.job?.rollbackPlan?.status === 'planned'
      && body?.job?.currentReportId === state.domesticSlotFailedWorkerReportId
  },
  {
    name: 'domestic slot rollback execution',
    path: () => `/internal/v1/site-slots/worker-reports/${encodeURIComponent(state.domesticSlotFailedWorkerReportId)}/rollback-executions`,
    method: 'POST',
    body: {
      mode: 'simulate',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-rollback-execution'
    },
    assert: (body) => {
      state.domesticSlotRollbackExecutionId = body?.rollbackExecution?.rollbackExecutionId;
      state.domesticSlotRollbackStepId = body?.rollbackExecution?.stepResults?.[0]?.stepId;
      return typeof state.domesticSlotRollbackExecutionId === 'string'
        && typeof state.domesticSlotRollbackStepId === 'string'
        && body?.rollbackExecution?.contractVersion === 'site-slot-rollback-v1'
        && body?.rollbackExecution?.status === 'ready'
        && body?.rollbackExecution?.rollbackPlan?.strategy === 'restore-http-smoke-failure'
        && body?.rollbackExecution?.dryRun === true;
    }
  },
  {
    name: 'domestic slot rollback execution get',
    path: () => `/internal/v1/site-slots/rollback-executions/${encodeURIComponent(state.domesticSlotRollbackExecutionId)}`,
    assert: (body) => body?.rollbackExecution?.rollbackExecutionId === state.domesticSlotRollbackExecutionId
      && body?.rollbackExecution?.status === 'ready'
  },
  {
    name: 'domestic slot rollback executions list',
    path: () => `/internal/v1/site-slots/rollback-executions?reportId=${encodeURIComponent(state.domesticSlotFailedWorkerReportId)}`,
    assert: (body) => Array.isArray(body?.rollbackExecutions)
      && body.rollbackExecutions.some((execution) => execution.rollbackExecutionId === state.domesticSlotRollbackExecutionId)
  },
  {
    name: 'domestic slot rollback report',
    path: () => `/internal/v1/site-slots/rollback-executions/${encodeURIComponent(state.domesticSlotRollbackExecutionId)}/reports`,
    method: 'POST',
    body: () => ({
      workerId: 'worker-http-smoke-rollback',
      status: 'passed',
      message: 'http smoke rollback report passed',
      stepReports: [
        {
          stepId: state.domesticSlotRollbackStepId,
          status: 'passed',
          exitCode: 0,
          stdout: 'rollback stdout',
          stderr: '',
          attempt: 1
        }
      ],
      requestId: 'http-smoke-rollback-report'
    }),
    assert: (body) => {
      state.domesticSlotRollbackReportId = body?.rollbackReport?.rollbackReportId;
      return typeof state.domesticSlotRollbackReportId === 'string'
        && body?.rollbackReport?.status === 'passed'
        && body?.rollbackReport?.stepReports?.[0]?.stdout === 'rollback stdout'
        && body?.rollbackReport?.nextActions?.includes('close-rollback-window');
    }
  },
  {
    name: 'domestic slot rollback report get',
    path: () => `/internal/v1/site-slots/rollback-reports/${encodeURIComponent(state.domesticSlotRollbackReportId)}`,
    assert: (body) => body?.rollbackReport?.rollbackReportId === state.domesticSlotRollbackReportId
      && body?.rollbackReport?.rollbackExecutionId === state.domesticSlotRollbackExecutionId
  },
  {
    name: 'domestic slot rollback reports list',
    path: () => `/internal/v1/site-slots/rollback-reports?rollbackExecutionId=${encodeURIComponent(state.domesticSlotRollbackExecutionId)}`,
    assert: (body) => Array.isArray(body?.rollbackReports)
      && body.rollbackReports.some((report) => report.rollbackReportId === state.domesticSlotRollbackReportId)
  },
  {
    name: 'domestic slot rollback passed state',
    path: () => `/internal/v1/site-slots/rollback-executions/${encodeURIComponent(state.domesticSlotRollbackExecutionId)}`,
    assert: (body) => body?.rollbackExecution?.status === 'passed'
      && body?.rollbackExecution?.currentRollbackReportId === state.domesticSlotRollbackReportId
      && body?.rollbackExecution?.stepResults?.[0]?.output === 'rollback stdout'
  },
  {
    name: 'admin dashboard',
    path: '/internal/v1/admin/dashboard',
    assert: (body) => body?.overview?.siteSlotPlans >= 2
      && body?.actionPolicy?.principal?.roles?.includes('mx-admin')
      && body?.actionPolicy?.warnings?.some((warning) => warning.includes('shadow-default-admin'))
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.apply.confirm' && action.allowed === true)
      && body?.overview?.siteSlotRollbackExecutions >= 1
      && Array.isArray(body?.latestReleasePlans)
      && body.latestReleasePlans.some((plan) => plan.planId === state.releaseManagementPlanId)
      && Array.isArray(body?.siteSlotPipelines)
      && body.siteSlotPipelines.some((pipeline) => pipeline.planId === state.domesticSlotPlanId
        && pipeline.health === 'passed'
        && Array.isArray(pipeline.actionHints))
      && (
        body?.nextActions?.includes('review-release-gates')
        || body?.nextActions?.includes('review-site-slot-recovery')
        || body?.nextActions?.includes('review-site-slot-gates')
      )
  },
  {
    name: 'admin site slot pipelines list',
    path: '/internal/v1/admin/site-slots/pipelines',
    assert: (body) => body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-job.create')
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-run.simulate')
      && Array.isArray(body?.pipelines)
      && body.pipelines.some((pipeline) => pipeline.summary?.planId === state.domesticSlotPlanId
        && pipeline.summary?.counts?.rollbackReports >= 1
        && Array.isArray(pipeline.summary?.actionHints)
        && pipeline.timeline?.some((entry) => entry.kind === 'rollback-report' && entry.status === 'passed'))
  },
  {
    name: 'admin site slot pipeline detail',
    path: () => `/internal/v1/admin/site-slots/pipelines/${encodeURIComponent(state.domesticSlotPlanId)}`,
    assert: (body) => {
      const pipeline = body?.pipeline;
      const execution = pipeline?.executions?.find((item) => item.runId === state.domesticSlotPreflightRunId);
      const runner = pipeline?.runnerSessions?.find((item) => item.sessionId === state.domesticSlotFailedRunnerSessionId);
      const adminWorkerReport = pipeline?.workerReports?.find((item) => item.reportId === state.domesticSlotAdminWorkerRunReportId);
      const workerReport = pipeline?.workerReports?.find((item) => item.reportId === state.domesticSlotFailedWorkerReportId);
      const rollbackExecution = pipeline?.rollbackExecutions?.find((item) => item.rollbackExecutionId === state.domesticSlotRollbackExecutionId);
      const rollbackReport = pipeline?.rollbackReports?.find((item) => item.rollbackReportId === state.domesticSlotRollbackReportId);
      return body?.actionPolicy?.principal?.roles?.includes('mx-admin')
        && pipeline?.summary?.planId === state.domesticSlotPlanId
        && pipeline?.summary?.health === 'passed'
        && Array.isArray(pipeline?.summary?.actionHints)
        && execution?.steps?.some((step) => step.stepId && step.command && step.target)
        && runner?.stepResults?.some((step) => step.stepId && step.command && step.status)
        && adminWorkerReport?.stepReports?.some((step) => step.stepId === state.domesticSlotAdminWorkerStepId
          && step.stdout?.includes('artifact-push dry-run: remote execution skipped')
          && step.exitCode === 0)
        && adminWorkerReport?.stepReports?.some((step) => hasArtifactDryRunEvidence(step) && hasManifestArtifactEvidence(step))
        && workerReport?.stepReports?.some((step) => step.stepId === state.domesticSlotFailedWorkerStepId
          && step.stdout === 'failed stdout'
          && step.stderr === 'failed stderr'
          && step.attempt === 1)
        && rollbackExecution?.stepResults?.some((step) => step.stepId === state.domesticSlotRollbackStepId
          && step.command
          && step.target)
        && rollbackReport?.stepReports?.some((step) => step.stepId === state.domesticSlotRollbackStepId
          && step.stdout === 'rollback stdout'
          && step.exitCode === 0)
        && pipeline?.timeline?.some((entry) => entry.parentId === state.domesticSlotRollbackExecutionId);
    }
  },
  {
    name: 'dns policies',
    path: '/internal/v1/dns/policies',
    assert: (body) => Array.isArray(body?.policies)
      && body.policies.some((policy) => policy.policyId === 'dns_default_internal_split')
  },
  {
    name: 'sdk dns zone',
    path: '/internal/v1/sdk/dns/zone',
    method: 'POST',
    body: { appId: 'h2o', requestId: 'http-smoke-dns-zone' },
    assert: (body) => {
      state.dnsZoneSnapshotId = body?.snapshot?.snapshotId;
      return body?.snapshot?.authority === 'internal-coredns'
        && body?.snapshot?.zoneNames?.includes('internal.mx')
        && body?.snapshot?.records?.some((record) => record.name === 'gateway.internal.mx')
        && typeof body?.snapshot?.corefile?.combined === 'string'
        && body.snapshot.corefile.combined.includes('gateway.internal.mx')
        && typeof body?.snapshot?.signatures?.digest === 'string';
    }
  },
  {
    name: 'sdk coredns configmap',
    path: '/internal/v1/sdk/dns/coredns-configmap',
    method: 'POST',
    body: () => ({
      snapshotId: state.dnsZoneSnapshotId,
      mode: 'shadow-apply',
      requestId: 'http-smoke-coredns-sync'
    }),
    assert: (body) => body?.result?.status === 'recorded'
      && body?.result?.applied === false
      && body?.result?.namespace === 'mx-dns'
      && body?.result?.manifest?.metadata?.name === 'coredns'
      && body?.result?.manifest?.yaml?.includes('Corefile')
      && body?.result?.manifest?.yaml?.includes('gateway.internal.mx')
  },
  {
    name: 'internal coredns apply gate',
    path: '/internal/v1/dns/coredns/configmap/apply',
    method: 'POST',
    body: () => ({
      snapshotId: state.dnsZoneSnapshotId,
      requestId: 'http-smoke-coredns-apply-gate'
    }),
    assert: (body) => body?.result?.status === 'blocked'
      && body?.result?.allowed === false
      && body?.result?.applied === false
      && (
        body?.result?.blockedReason?.includes('confirmApply')
        || body?.result?.blockedReason?.includes('COREDNS_K8S_APPLY_ENABLED')
      )
  },
  {
    name: 'sdk dns evaluate',
    path: '/internal/v1/sdk/dns/evaluate',
    method: 'POST',
    body: { domain: 'gateway.internal.mx', requestId: 'http-smoke-dns' },
    assert: (body) => body?.decision?.route === 'internal-dns'
      && body?.decision?.resolver === 'internal-coredns'
      && body?.decision?.reverseProxyRoute?.host === 'gateway.internal.mx'
  },
  {
    name: 'platform kernel smoke',
    path: '/internal/v1/platform-kernel/smoke',
    assert: (body) => body
      && body.ok === true
      && body.gate?.verdict === 'passed'
      && body.h2oUpdate?.canSkip === true
      && body.sdkIntrospection?.active === true
      && body.sdkAccess?.allowed === true
      && body.deniedSdkAccess?.allowed === false
      && body.configPolicySnapshot?.policies?.dns?.policy?.policyId === 'dns_default_internal_split'
      && body.releaseManagementPlan?.decisions?.readyToPromote === true
      && body.releaseManagementPlan?.test?.gate?.verdict === 'passed'
      && body.domesticSlotPlan?.network?.mode === 'oversea-assisted'
      && body.domesticSlotPlan?.network?.qpTunnelCliMode === 'server-on'
      && body.domesticSlotPreflightExecution?.status === 'ready'
      && body.domesticSlotApplyExecution?.status === 'requires-confirmation'
      && body.domesticSlotPreflightRunnerSession?.status === 'passed'
      && body.domesticSlotRemoteRunnerSession?.status === 'blocked'
      && body.domesticSlotWorkerJob?.status === 'passed'
      && body.domesticSlotWorkerReport?.status === 'passed'
      && body.domesticSlotFailedWorkerJob?.status === 'failed'
      && body.domesticSlotFailedWorkerReport?.rollbackPlan?.status === 'planned'
      && body.domesticSlotRollbackExecution?.status === 'passed'
      && body.domesticSlotRollbackReport?.status === 'passed'
      && body.coreDnsSync?.status === 'recorded'
      && body.coreDnsSync?.applied === false
      && body.sdkGateway?.authAuthority === 'user-center'
      && body.dnsDecision?.route === 'internal-dns'
  }
];

const remoteReadyChecks = [
  {
    name: 'healthz',
    path: '/healthz',
    assert: (body) => body && body.ok === true && body.service === 'mx-launcher-server'
  },
  {
    name: 'remote ready user center bootstrap',
    path: '/internal/v1/user-center/bootstrap',
    method: 'POST',
    body: { requestId: 'http-smoke-remote-ready-user-center-bootstrap' },
    assert: (body) => Array.isArray(body?.userCenter?.roles)
      && body.userCenter.roles.some((role) => role.roleId === 'mx-admin')
  },
  {
    name: 'remote ready admin token',
    path: '/internal/v1/user-center/tokens/issue',
    method: 'POST',
    body: {
      subjectKind: 'user',
      subjectId: 'usr_demo_admin',
      audience: 'mx-admin',
      requestId: 'http-smoke-remote-ready-admin-token'
    },
    assert: (body) => {
      state.remoteReadyAdminToken = body?.issued?.token;
      return typeof state.remoteReadyAdminToken === 'string'
        && body?.issued?.record?.scopes?.includes('site-slot.execute');
    }
  },
  {
    name: 'remote ready ssh profile upsert',
    path: '/internal/v1/config-center/site-slot-ssh-profiles',
    method: 'POST',
    body: () => ({
      profileId: 'sshprof_http_smoke_ready_oversea',
      siteId: 'oversea-ready',
      kind: 'oversea',
      host: 'oversea-ready.example.com',
      sshUser: 'root',
      sshPort: 22,
      identityFile: remoteReadyFixture.identityFile,
      knownHostsFile: remoteReadyFixture.knownHostsFile,
      hostKeyAlias: 'oversea-ready',
      strictHostKeyChecking: 'yes',
      connectTimeoutSeconds: 5,
      batchMode: 'yes',
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-ssh-profile'
    }),
    assert: (body) => {
      state.remoteReadySshProfileId = body?.profile?.profileId;
      return state.remoteReadySshProfileId === 'sshprof_http_smoke_ready_oversea'
        && body?.profile?.status === 'active'
        && Array.isArray(body?.profile?.warnings)
        && body.profile.warnings.length === 0;
    }
  },
  {
    name: 'remote ready ssh profile readiness ready',
    path: () => `/internal/v1/config-center/site-slot-ssh-profiles/${encodeURIComponent(state.remoteReadySshProfileId)}/readiness-probe`,
    method: 'POST',
    body: {
      confirmReadOnlyProbe: true,
      executeReadOnlyProbe: false,
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-ssh-profile-readiness'
    },
    assert: (body) => body?.readiness?.status === 'ready'
      && body?.readiness?.verdict === 'passed'
      && body?.readiness?.execution === 'not-started'
      && body?.readiness?.boundary === 'ssh-profile-readiness-readonly'
      && body?.readiness?.command?.startsWith('ssh ')
      && body?.readiness?.command?.includes('mx-readonly-profile-readiness')
      && body?.readiness?.command?.includes('docker version')
      && body?.readiness?.sshProfile?.profileId === state.remoteReadySshProfileId
      && body?.readiness?.sshProfile?.identityFileExists === true
      && body?.readiness?.sshProfile?.knownHostsFileExists === true
      && body?.readiness?.gates?.envGate?.status === 'blocked'
      && body?.readiness?.gates?.configGate?.status === 'blocked'
      && body?.readiness?.gates?.requestGate?.status === 'blocked'
      && Array.isArray(body?.readiness?.gateFailures)
      && body.readiness.gateFailures.length === 0
      && !body?.readiness?.executionResult
  },
  {
    name: 'remote ready oversea slot plan',
    path: '/internal/v1/site-slots/plans',
    method: 'POST',
    body: () => ({
      kind: 'oversea',
      siteId: 'oversea-ready',
      sshProfileId: state.remoteReadySshProfileId,
      hasDocker: true,
      hasOutboundInternet: true,
      requestId: 'http-smoke-remote-ready-oversea-slot'
    }),
    assert: (body) => {
      state.remoteReadyPlanId = body?.plan?.planId;
      return typeof state.remoteReadyPlanId === 'string'
        && body?.plan?.kind === 'oversea'
        && body?.plan?.status === 'ready-for-preflight'
        && body?.plan?.ssh?.profileId === state.remoteReadySshProfileId
        && body?.plan?.ssh?.profileStatus === 'active'
        && body?.plan?.ssh?.profileWarnings?.length === 0
        && body?.plan?.host === 'oversea-ready.example.com';
    }
  },
  {
    name: 'remote ready apply manifest',
    path: () => `/internal/v1/site-slots/plans/${encodeURIComponent(state.remoteReadyPlanId)}/apply`,
    method: 'POST',
    body: {
      mode: 'manual',
      confirmApply: true,
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-apply'
    },
    assert: (body) => {
      state.remoteReadyRunId = body?.execution?.runId;
      return typeof state.remoteReadyRunId === 'string'
        && body?.execution?.status === 'ready'
        && body?.execution?.steps?.some((step) => step.command?.includes('mx-oversea-access-stack.tar.gz'))
        && body?.execution?.steps?.some((step) => step.command?.includes('mx-oversea-services.tar.gz'));
    }
  },
  {
    name: 'remote ready runner queued',
    path: () => `/internal/v1/site-slots/executions/${encodeURIComponent(state.remoteReadyRunId)}/runner-sessions`,
    method: 'POST',
    body: {
      mode: 'remote-ssh',
      confirmRemoteExecution: true,
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-runner'
    },
    assert: (body) => {
      state.remoteReadyRunnerSessionId = body?.session?.sessionId;
      return typeof state.remoteReadyRunnerSessionId === 'string'
        && body?.session?.mode === 'remote-ssh'
        && body?.session?.status === 'queued'
        && body?.session?.dryRun === false
        && body?.session?.gates?.remoteExecutionEnabled === true
        && body?.session?.gates?.remoteExecutionConfirmed === true;
    }
  },
  {
    name: 'remote ready worker job',
    path: () => `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(state.remoteReadyRunnerSessionId)}/worker-jobs`,
    method: 'POST',
    body: {
      workerId: 'worker-http-smoke-remote-ready',
      workerKind: 'oversea-site-agent',
      approvalId: 'approval-http-smoke-remote-ready',
      changeWindowStart: '2026-06-08T00:00:00.000Z',
      changeWindowEnd: '2026-06-09T00:00:00.000Z',
      retryLimit: 1,
      rollbackStrategy: 'restore-previous-access-stack',
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-worker-job'
    },
    assert: (body) => {
      state.remoteReadyWorkerJobId = body?.job?.jobId;
      return typeof state.remoteReadyWorkerJobId === 'string'
        && body?.job?.mode === 'remote-ssh'
        && body?.job?.status === 'ready'
        && body?.job?.approval?.status === 'recorded'
        && body?.job?.changeWindow?.start === '2026-06-08T00:00:00.000Z'
        && body?.job?.changeWindow?.end === '2026-06-09T00:00:00.000Z';
    }
  },
  {
    name: 'remote ready site-slot gate passed',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyWorkerJobId)}/remote-ssh-gate`,
    method: 'POST',
    body: {
      confirmRemoteExecution: true,
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-site-slot-gate'
    },
    assert: (body) => body?.gate?.verdict === 'passed'
      && body?.gate?.status === 'passed'
      && body?.gate?.execution === 'not-executed'
      && body?.gate?.environmentGates?.SITE_SLOT_WORKER_REMOTE_SSH === 'present'
      && body?.gate?.environmentGates?.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === 'present'
      && body?.gate?.sshProfile?.identityFileExists === true
      && body?.gate?.sshProfile?.knownHostsFileExists === true
      && body?.gate?.summary?.repositoryRootSynced === false
      && body?.gate?.gateFailures?.length === 0
      && body?.gate?.stepGates?.some((step) => step.commandKind === 'artifact-transport'
        && step.transport?.repositoryRootSynced === false
        && step.artifactReferences?.some((artifact) => artifact?.manifest?.sha256Status === 'passed'
          && artifact?.module?.sha256Status === 'passed'
          && typeof artifact?.module?.targetPath === 'string'))
  },
  {
    name: 'remote ready site-slot handoff ready',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyWorkerJobId)}/run-artifact-push-remote-ssh`,
    method: 'POST',
    body: () => ({
      confirmRemoteExecution: true,
      confirmWorkerHandoff: true,
      internalBaseUrl: baseUrl,
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-site-slot-handoff'
    }),
    assert: (body) => body?.gate?.verdict === 'passed'
      && body?.workerHandoff?.status === 'ready'
      && body?.workerHandoff?.execution === 'not-started'
      && body?.workerHandoff?.boundary === 'internal-worker-handoff-only'
      && body?.workerHandoff?.command === `bash scripts/manage.sh ops site-slot worker-run '${state.remoteReadyWorkerJobId}' artifact-push-remote-ssh`
      && body?.workerHandoff?.env?.MX_INTERNAL_BASE_URL === baseUrl
      && body?.workerHandoff?.env?.SITE_SLOT_WORKER_REMOTE_SSH === '1'
      && body?.workerHandoff?.env?.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === '1'
      && body?.workerHandoff?.env?.SITE_SLOT_WORKER_MODE === 'artifact-push-remote-ssh'
      && body?.workerHandoff?.env?.SITE_SLOT_SSH_PROFILE_ID === state.remoteReadySshProfileId
      && Array.isArray(body?.workerHandoff?.blockedReasons)
      && body.workerHandoff.blockedReasons.length === 0
      && !body.report
  },
  {
    name: 'remote ready site-slot readonly probe ready',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyWorkerJobId)}/remote-ssh-readonly-probe`,
    method: 'POST',
    body: {
      confirmRemoteExecution: true,
      confirmReadOnlyProbe: true,
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-site-slot-readonly-probe'
    },
    assert: (body) => body?.gate?.verdict === 'passed'
      && body?.readOnlyProbe?.status === 'ready'
      && body?.readOnlyProbe?.execution === 'not-started'
      && body?.readOnlyProbe?.boundary === 'readonly-ssh-probe-handoff-only'
      && body?.readOnlyProbe?.command?.startsWith('ssh ')
      && body?.readOnlyProbe?.command?.includes('mx-readonly-probe')
      && body?.readOnlyProbe?.command?.includes('df -h /')
      && body?.readOnlyProbe?.env?.SITE_SLOT_READONLY_PROBE === '1'
      && body?.readOnlyProbe?.env?.SITE_SLOT_SSH_PROFILE_ID === state.remoteReadySshProfileId
      && body?.readOnlyProbe?.sshProfile?.identityFileExists === true
      && body?.readOnlyProbe?.sshProfile?.knownHostsFileExists === true
      && Array.isArray(body?.readOnlyProbe?.blockedReasons)
      && body.readOnlyProbe.blockedReasons.length === 0
      && !body.report
  },
  {
    name: 'remote ready pipeline action hint',
    path: () => `/internal/v1/admin/site-slots/pipelines/${encodeURIComponent(state.remoteReadyPlanId)}?token=${encodeURIComponent(state.remoteReadyAdminToken)}`,
    assert: (body) => body?.pipeline?.summary?.actionHints?.some((action) => action.actionId === 'site-slot.worker-run.remote-ssh-gate'
      && action.allowed === true
      && action.path === `/internal/v1/site-slots/worker-jobs/${state.remoteReadyWorkerJobId}/remote-ssh-gate`)
      && body?.pipeline?.summary?.actionHints?.some((action) => action.actionId === 'site-slot.worker-run.remote-ssh-readonly-probe'
        && action.allowed === true
        && action.path === `/internal/v1/site-slots/worker-jobs/${state.remoteReadyWorkerJobId}/remote-ssh-readonly-probe`
        && action.confirmFields?.includes('confirmReadOnlyProbe'))
      && body?.pipeline?.summary?.actionHints?.some((action) => action.actionId === 'site-slot.worker-run.artifact-push-remote-ssh-plan'
        && action.allowed === true
        && action.path === `/internal/v1/site-slots/worker-jobs/${state.remoteReadyWorkerJobId}/run-artifact-push-remote-ssh-plan`
        && action.confirmFields?.includes('confirmPlanOnly'))
      && body?.pipeline?.summary?.actionHints?.some((action) => action.actionId === 'site-slot.worker-run.remote-ssh-execute'
        && action.allowed === true
        && action.path === `/internal/v1/site-slots/worker-jobs/${state.remoteReadyWorkerJobId}/run-artifact-push-remote-ssh`
        && action.confirmFields?.includes('confirmWorkerHandoff'))
  },
  {
    name: 'remote ready gate passed',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.remoteReadyAdminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.remote-ssh-gate',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyWorkerJobId)}/remote-ssh-gate`,
      body: {
        confirmRemoteExecution: true,
        requestedBy: 'http-smoke-remote-ready',
        requestId: 'http-smoke-remote-ready-gate'
      }
    }),
    assert: (body) => body?.actionResult?.actionId === 'site-slot.worker-run.remote-ssh-gate'
      && body?.gate?.verdict === 'passed'
      && body?.gate?.status === 'passed'
      && body?.gate?.execution === 'not-executed'
      && body?.gate?.environmentGates?.SITE_SLOT_WORKER_REMOTE_SSH === 'present'
      && body?.gate?.environmentGates?.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === 'present'
      && body?.gate?.sshProfile?.identityFileExists === true
      && body?.gate?.sshProfile?.knownHostsFileExists === true
      && body?.gate?.summary?.repositoryRootSynced === false
      && body?.gate?.gateFailures?.length === 0
      && body?.gate?.stepGates?.some((step) => step.commandKind === 'artifact-transport'
        && step.transport?.repositoryRootSynced === false
        && step.artifactReferences?.some((artifact) => artifact?.manifest?.sha256Status === 'passed'
          && artifact?.module?.sha256Status === 'passed'
          && typeof artifact?.module?.targetPath === 'string'))
  },
  {
    name: 'remote ready handoff ready',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.remoteReadyAdminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.remote-ssh-execute',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyWorkerJobId)}/run-artifact-push-remote-ssh`,
      body: {
        confirmRemoteExecution: true,
        confirmWorkerHandoff: true,
        internalBaseUrl: baseUrl,
        requestedBy: 'http-smoke-remote-ready',
        requestId: 'http-smoke-remote-ready-handoff'
      }
    }),
    assert: (body) => body?.actionResult?.actionId === 'site-slot.worker-run.remote-ssh-execute'
      && body?.gate?.verdict === 'passed'
      && body?.workerHandoff?.status === 'ready'
      && body?.workerHandoff?.execution === 'not-started'
      && body?.workerHandoff?.boundary === 'internal-worker-handoff-only'
      && body?.workerHandoff?.command === `bash scripts/manage.sh ops site-slot worker-run '${state.remoteReadyWorkerJobId}' artifact-push-remote-ssh`
      && body?.workerHandoff?.cwd?.endsWith('/electron-dock/mx-launcher')
      && body?.workerHandoff?.env?.MX_INTERNAL_BASE_URL === baseUrl
      && body?.workerHandoff?.env?.SITE_SLOT_WORKER_REMOTE_SSH === '1'
      && body?.workerHandoff?.env?.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === '1'
      && body?.workerHandoff?.env?.SITE_SLOT_WORKER_MODE === 'artifact-push-remote-ssh'
      && body?.workerHandoff?.env?.SITE_SLOT_SSH_PROFILE_ID === state.remoteReadySshProfileId
      && Array.isArray(body?.workerHandoff?.blockedReasons)
      && body.workerHandoff.blockedReasons.length === 0
      && !body.report
  },
  {
    name: 'remote ready readonly probe ready',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.remoteReadyAdminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.remote-ssh-readonly-probe',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyWorkerJobId)}/remote-ssh-readonly-probe`,
      body: {
        confirmRemoteExecution: true,
        confirmReadOnlyProbe: true,
        requestedBy: 'http-smoke-remote-ready',
        requestId: 'http-smoke-remote-ready-readonly-probe'
      }
    }),
    assert: (body) => body?.actionResult?.actionId === 'site-slot.worker-run.remote-ssh-readonly-probe'
      && body?.gate?.verdict === 'passed'
      && body?.readOnlyProbe?.status === 'ready'
      && body?.readOnlyProbe?.execution === 'not-started'
      && body?.readOnlyProbe?.boundary === 'readonly-ssh-probe-handoff-only'
      && body?.readOnlyProbe?.command?.startsWith('ssh ')
      && body?.readOnlyProbe?.command?.includes('docker version')
      && body?.readOnlyProbe?.env?.SITE_SLOT_READONLY_PROBE === '1'
      && body?.readOnlyProbe?.env?.SITE_SLOT_SSH_PROFILE_ID === state.remoteReadySshProfileId
      && Array.isArray(body?.readOnlyProbe?.blockedReasons)
      && body.readOnlyProbe.blockedReasons.length === 0
      && !body.report
  },
  {
    name: 'remote ready handoff does not record report',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyWorkerJobId)}`,
    assert: (body) => body?.job?.status === 'ready'
      && body?.job?.currentReportId === null
      && body?.job?.currentReportId !== state.remoteReadyWorkerJobId
  },
  {
    name: 'remote ready plan runner queued',
    path: () => `/internal/v1/site-slots/executions/${encodeURIComponent(state.remoteReadyRunId)}/runner-sessions`,
    method: 'POST',
    body: {
      mode: 'remote-ssh',
      confirmRemoteExecution: true,
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-plan-runner'
    },
    assert: (body) => {
      state.remoteReadyPlanRunnerSessionId = body?.session?.sessionId;
      return typeof state.remoteReadyPlanRunnerSessionId === 'string'
        && body?.session?.mode === 'remote-ssh'
        && body?.session?.status === 'queued'
        && body?.session?.gates?.remoteExecutionEnabled === true
        && body?.session?.gates?.remoteExecutionConfirmed === true;
    }
  },
  {
    name: 'remote ready plan worker job',
    path: () => `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(state.remoteReadyPlanRunnerSessionId)}/worker-jobs`,
    method: 'POST',
    body: {
      workerId: 'worker-http-smoke-remote-plan',
      workerKind: 'oversea-site-agent',
      approvalId: 'approval-http-smoke-remote-plan',
      changeWindowStart: '2026-06-08T00:00:00.000Z',
      changeWindowEnd: '2026-06-09T00:00:00.000Z',
      retryLimit: 1,
      rollbackStrategy: 'restore-previous-access-stack',
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-plan-worker-job'
    },
    assert: (body) => {
      state.remoteReadyPlanWorkerJobId = body?.job?.jobId;
      return typeof state.remoteReadyPlanWorkerJobId === 'string'
        && body?.job?.mode === 'remote-ssh'
        && body?.job?.status === 'ready'
        && body?.job?.approval?.status === 'recorded'
        && body?.job?.changeWindow?.start === '2026-06-08T00:00:00.000Z'
        && body?.job?.changeWindow?.end === '2026-06-09T00:00:00.000Z';
    }
  },
  {
    name: 'remote ready plan worker report',
    run: async () => {
      const result = await execFileAsync('bash', [
        'scripts/manage.sh',
        'ops',
        'site-slot',
        'worker-run',
        state.remoteReadyPlanWorkerJobId,
        'artifact-push-remote-ssh-plan'
      ], {
        cwd: mxLauncherRoot,
        env: {
          ...process.env,
          MX_INTERNAL_BASE_URL: baseUrl,
          SITE_SLOT_CONFIRM_REMOTE_EXECUTION: '1',
          SITE_SLOT_WORKER_MODE: 'artifact-push-remote-ssh-plan',
          SITE_SLOT_SSH_PROFILE_ID: state.remoteReadySshProfileId,
          SITE_SLOT_WORKER_ID: 'worker-http-smoke-remote-plan',
          SITE_SLOT_WORKER_MESSAGE: 'http smoke remote ssh plan worker report',
          SITE_SLOT_WORKER_REQUEST_ID: 'http-smoke-remote-ready-plan-worker-run'
        },
        maxBuffer: 4 * 1024 * 1024
      });
      return parseCliJson(result.stdout);
    },
    assert: (body) => {
      state.remoteReadyPlanWorkerReportId = body?.reportId;
      const plannedStep = body?.stepReports?.find((step) => {
        const evidence = parseWorkerEvidence(step?.stdout);
        return evidence?.mode === 'artifact-push-remote-ssh-plan'
          && evidence?.execution === 'planned'
          && evidence?.boundary === 'remote-ssh-plan-only'
          && evidence?.planOnly?.commandExecuted === false
          && evidence?.planOnly?.remoteMutation === false
          && evidence?.transport?.repositoryRootSynced === false
          && evidence?.sshProfile?.identityFileExists === true
          && evidence?.sshProfile?.knownHostsFileExists === true
          && typeof evidence?.effectiveCommand === 'string'
          && (evidence.effectiveCommand.includes('StrictHostKeyChecking') || evidence.effectiveCommand.includes('BatchMode'))
          && evidence?.artifactReferences?.some((artifact) => artifact?.manifest?.sha256Status === 'passed'
            && artifact?.module?.sha256Status === 'passed'
            && typeof artifact?.module?.targetPath === 'string');
      });
      return body?.mode === 'artifact-push-remote-ssh-plan'
        && typeof state.remoteReadyPlanWorkerReportId === 'string'
        && body?.status === 'passed'
        && body?.workerId === 'worker-http-smoke-remote-plan'
        && body?.message === 'http smoke remote ssh plan worker report'
        && Array.isArray(body?.stepReports)
        && body.stepReports.every((step) => step.status === 'passed')
        && plannedStep?.exitCode === 0;
    }
  },
  {
    name: 'remote ready plan worker report get',
    path: () => `/internal/v1/site-slots/worker-reports/${encodeURIComponent(state.remoteReadyPlanWorkerReportId)}`,
    assert: (body) => body?.report?.reportId === state.remoteReadyPlanWorkerReportId
      && body?.report?.jobId === state.remoteReadyPlanWorkerJobId
      && body?.report?.status === 'passed'
      && body?.report?.stepReports?.some((step) => {
        const evidence = parseWorkerEvidence(step?.stdout);
        return evidence?.mode === 'artifact-push-remote-ssh-plan'
          && evidence?.execution === 'planned'
          && evidence?.planOnly?.commandExecuted === false
          && evidence?.planOnly?.remoteMutation === false;
      })
  },
  {
    name: 'remote ready plan worker job passed',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyPlanWorkerJobId)}`,
    assert: (body) => body?.job?.status === 'passed'
      && body?.job?.currentReportId === state.remoteReadyPlanWorkerReportId
  },
  {
    name: 'remote ready fake worker report',
    run: async () => {
      const result = await execFileAsync('bash', [
        'scripts/manage.sh',
        'ops',
        'site-slot',
        'worker-run',
        state.remoteReadyWorkerJobId,
        'artifact-push-fake-transport'
      ], {
        cwd: mxLauncherRoot,
        env: {
          ...process.env,
          MX_INTERNAL_BASE_URL: baseUrl,
          SITE_SLOT_WORKER_REMOTE_SSH: '1',
          SITE_SLOT_CONFIRM_REMOTE_EXECUTION: '1',
          SITE_SLOT_WORKER_FAKE_TRANSPORT: '1',
          SITE_SLOT_WORKER_MODE: 'artifact-push-fake-transport',
          SITE_SLOT_SSH_PROFILE_ID: state.remoteReadySshProfileId,
          SITE_SLOT_WORKER_ID: 'worker-http-smoke-remote-ready-fake',
          SITE_SLOT_WORKER_MESSAGE: 'http smoke fake transport worker report',
          SITE_SLOT_WORKER_REQUEST_ID: 'http-smoke-remote-ready-fake-worker-run'
        },
        maxBuffer: 4 * 1024 * 1024
      });
      return parseCliJson(result.stdout);
    },
    assert: (body) => {
      state.remoteReadyWorkerReportId = body?.reportId;
      const fakeExecutedStep = body?.stepReports?.find((step) => {
        const evidence = parseWorkerEvidence(step?.stdout);
        return evidence?.mode === 'artifact-push-fake-transport'
          && evidence?.execution === 'fake-executed'
          && evidence?.boundary === 'fake-transport-no-remote-mutation'
          && evidence?.fakeTransport?.commandExecuted === false
          && evidence?.fakeTransport?.remoteMutation === false
          && evidence?.transport?.repositoryRootSynced === false
          && evidence?.sshProfile?.identityFileExists === true
          && evidence?.sshProfile?.knownHostsFileExists === true
          && evidence?.artifactReferences?.some((artifact) => artifact?.manifest?.sha256Status === 'passed'
            && artifact?.module?.sha256Status === 'passed'
            && typeof artifact?.module?.targetPath === 'string');
      });
      return body?.mode === 'artifact-push-fake-transport'
        && typeof state.remoteReadyWorkerReportId === 'string'
        && body?.status === 'passed'
        && body?.workerId === 'worker-http-smoke-remote-ready-fake'
        && body?.message === 'http smoke fake transport worker report'
        && Array.isArray(body?.stepReports)
        && body.stepReports.every((step) => step.status === 'passed')
        && fakeExecutedStep?.exitCode === 0;
    }
  },
  {
    name: 'remote ready fake worker report get',
    path: () => `/internal/v1/site-slots/worker-reports/${encodeURIComponent(state.remoteReadyWorkerReportId)}`,
    assert: (body) => body?.report?.reportId === state.remoteReadyWorkerReportId
      && body?.report?.jobId === state.remoteReadyWorkerJobId
      && body?.report?.status === 'passed'
      && body?.report?.stepReports?.some((step) => {
        const evidence = parseWorkerEvidence(step?.stdout);
        return evidence?.mode === 'artifact-push-fake-transport'
          && evidence?.execution === 'fake-executed'
          && evidence?.fakeTransport?.remoteMutation === false;
      })
  },
  {
    name: 'remote ready fake worker job passed',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyWorkerJobId)}`,
    assert: (body) => body?.job?.status === 'passed'
      && body?.job?.currentReportId === state.remoteReadyWorkerReportId
  },
  {
    name: 'remote ready admin plan runner queued',
    path: () => `/internal/v1/site-slots/executions/${encodeURIComponent(state.remoteReadyRunId)}/runner-sessions`,
    method: 'POST',
    body: {
      mode: 'remote-ssh',
      confirmRemoteExecution: true,
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-admin-plan-runner'
    },
    assert: (body) => {
      state.remoteReadyAdminPlanRunnerSessionId = body?.session?.sessionId;
      return typeof state.remoteReadyAdminPlanRunnerSessionId === 'string'
        && body?.session?.mode === 'remote-ssh'
        && body?.session?.status === 'queued'
        && body?.session?.gates?.remoteExecutionEnabled === true;
    }
  },
  {
    name: 'remote ready admin plan worker job',
    path: () => `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(state.remoteReadyAdminPlanRunnerSessionId)}/worker-jobs`,
    method: 'POST',
    body: {
      workerId: 'worker-http-smoke-admin-plan',
      workerKind: 'oversea-site-agent',
      approvalId: 'approval-http-smoke-admin-plan',
      changeWindowStart: '2026-06-08T00:00:00.000Z',
      changeWindowEnd: '2026-06-09T00:00:00.000Z',
      retryLimit: 1,
      rollbackStrategy: 'restore-previous-access-stack',
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-admin-plan-worker-job'
    },
    assert: (body) => {
      state.remoteReadyAdminPlanWorkerJobId = body?.job?.jobId;
      return typeof state.remoteReadyAdminPlanWorkerJobId === 'string'
        && body?.job?.mode === 'remote-ssh'
        && body?.job?.status === 'ready'
        && body?.job?.approval?.status === 'recorded';
    }
  },
  {
    name: 'remote ready admin plan action hint',
    path: () => `/internal/v1/admin/site-slots/pipelines/${encodeURIComponent(state.remoteReadyPlanId)}?token=${encodeURIComponent(state.remoteReadyAdminToken)}`,
    assert: (body) => body?.pipeline?.summary?.actionHints?.some((action) => action.actionId === 'site-slot.worker-run.artifact-push-remote-ssh-plan'
      && action.allowed === true
      && action.path === `/internal/v1/site-slots/worker-jobs/${state.remoteReadyAdminPlanWorkerJobId}/run-artifact-push-remote-ssh-plan`
      && action.confirmFields?.includes('confirmRemoteExecution')
      && action.confirmFields?.includes('confirmPlanOnly'))
  },
  {
    name: 'remote ready admin plan worker report',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.remoteReadyAdminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.artifact-push-remote-ssh-plan',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyAdminPlanWorkerJobId)}/run-artifact-push-remote-ssh-plan`,
      body: {
        confirmRemoteExecution: true,
        confirmPlanOnly: true,
        workerId: 'worker-http-smoke-admin-plan',
        message: 'http smoke admin remote ssh plan worker report',
        requestedBy: 'http-smoke-remote-ready',
        requestId: 'http-smoke-remote-ready-admin-plan-worker-run'
      }
    }),
    assert: (body) => {
      state.remoteReadyAdminPlanWorkerReportId = body?.report?.reportId;
      const plannedStep = body?.report?.stepReports?.find((step) => {
        const evidence = parseWorkerEvidence(step?.stdout);
        return evidence?.mode === 'artifact-push-remote-ssh-plan'
          && evidence?.execution === 'planned'
          && evidence?.boundary === 'remote-ssh-plan-only'
          && evidence?.planOnly?.commandExecuted === false
          && evidence?.planOnly?.remoteMutation === false
          && evidence?.transport?.repositoryRootSynced === false
          && evidence?.sshProfile?.identityFileExists === true
          && evidence?.sshProfile?.knownHostsFileExists === true
          && typeof evidence?.effectiveCommand === 'string'
          && (evidence.effectiveCommand.includes('StrictHostKeyChecking') || evidence.effectiveCommand.includes('BatchMode'))
          && evidence?.artifactReferences?.some((artifact) => artifact?.manifest?.sha256Status === 'passed'
            && artifact?.module?.sha256Status === 'passed'
            && typeof artifact?.module?.targetPath === 'string');
      });
      return body?.actionResult?.actionId === 'site-slot.worker-run.artifact-push-remote-ssh-plan'
        && body?.gate?.verdict === 'passed'
        && body?.remoteSshPlan?.status === 'passed'
        && body?.remoteSshPlan?.execution === 'recorded'
        && body?.remoteSshPlan?.reportId === state.remoteReadyAdminPlanWorkerReportId
        && typeof state.remoteReadyAdminPlanWorkerReportId === 'string'
        && body?.report?.status === 'passed'
        && body?.report?.workerId === 'worker-http-smoke-admin-plan'
        && body?.report?.message === 'http smoke admin remote ssh plan worker report'
        && plannedStep?.exitCode === 0;
    }
  },
  {
    name: 'remote ready admin plan worker report get',
    path: () => `/internal/v1/site-slots/worker-reports/${encodeURIComponent(state.remoteReadyAdminPlanWorkerReportId)}`,
    assert: (body) => body?.report?.reportId === state.remoteReadyAdminPlanWorkerReportId
      && body?.report?.jobId === state.remoteReadyAdminPlanWorkerJobId
      && body?.report?.status === 'passed'
      && body?.report?.stepReports?.some((step) => {
        const evidence = parseWorkerEvidence(step?.stdout);
        return evidence?.mode === 'artifact-push-remote-ssh-plan'
          && evidence?.execution === 'planned'
          && evidence?.planOnly?.remoteMutation === false;
      })
  },
  {
    name: 'remote ready admin plan worker job passed',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyAdminPlanWorkerJobId)}`,
    assert: (body) => body?.job?.status === 'passed'
      && body?.job?.currentReportId === state.remoteReadyAdminPlanWorkerReportId
  },
  {
    name: 'remote ready admin fake runner queued',
    path: () => `/internal/v1/site-slots/executions/${encodeURIComponent(state.remoteReadyRunId)}/runner-sessions`,
    method: 'POST',
    body: {
      mode: 'remote-ssh',
      confirmRemoteExecution: true,
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-admin-fake-runner'
    },
    assert: (body) => {
      state.remoteReadyAdminFakeRunnerSessionId = body?.session?.sessionId;
      return typeof state.remoteReadyAdminFakeRunnerSessionId === 'string'
        && body?.session?.mode === 'remote-ssh'
        && body?.session?.status === 'queued'
        && body?.session?.gates?.remoteExecutionEnabled === true;
    }
  },
  {
    name: 'remote ready admin fake worker job',
    path: () => `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(state.remoteReadyAdminFakeRunnerSessionId)}/worker-jobs`,
    method: 'POST',
    body: {
      workerId: 'worker-http-smoke-admin-fake',
      workerKind: 'oversea-site-agent',
      approvalId: 'approval-http-smoke-admin-fake',
      changeWindowStart: '2026-06-08T00:00:00.000Z',
      changeWindowEnd: '2026-06-09T00:00:00.000Z',
      retryLimit: 1,
      rollbackStrategy: 'restore-previous-access-stack',
      requestedBy: 'http-smoke-remote-ready',
      requestId: 'http-smoke-remote-ready-admin-fake-worker-job'
    },
    assert: (body) => {
      state.remoteReadyAdminFakeWorkerJobId = body?.job?.jobId;
      return typeof state.remoteReadyAdminFakeWorkerJobId === 'string'
        && body?.job?.mode === 'remote-ssh'
        && body?.job?.status === 'ready'
        && body?.job?.approval?.status === 'recorded';
    }
  },
  {
    name: 'remote ready admin fake action hint',
    path: () => `/internal/v1/admin/site-slots/pipelines/${encodeURIComponent(state.remoteReadyPlanId)}?token=${encodeURIComponent(state.remoteReadyAdminToken)}`,
    assert: (body) => body?.pipeline?.summary?.actionHints?.some((action) => action.actionId === 'site-slot.worker-run.artifact-push-fake-transport'
      && action.allowed === true
      && action.path === `/internal/v1/site-slots/worker-jobs/${state.remoteReadyAdminFakeWorkerJobId}/run-artifact-push-fake-transport`
      && action.confirmFields?.includes('confirmFakeTransport'))
  },
  {
    name: 'remote ready admin fake worker report',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.remoteReadyAdminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.artifact-push-fake-transport',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyAdminFakeWorkerJobId)}/run-artifact-push-fake-transport`,
      body: {
        confirmRemoteExecution: true,
        confirmFakeTransport: true,
        workerId: 'worker-http-smoke-admin-fake',
        message: 'http smoke admin fake transport worker report',
        requestedBy: 'http-smoke-remote-ready',
        requestId: 'http-smoke-remote-ready-admin-fake-worker-run'
      }
    }),
    assert: (body) => {
      state.remoteReadyAdminFakeWorkerReportId = body?.report?.reportId;
      const fakeExecutedStep = body?.report?.stepReports?.find((step) => {
        const evidence = parseWorkerEvidence(step?.stdout);
        return evidence?.mode === 'artifact-push-fake-transport'
          && evidence?.execution === 'fake-executed'
          && evidence?.boundary === 'fake-transport-no-remote-mutation'
          && evidence?.fakeTransport?.commandExecuted === false
          && evidence?.fakeTransport?.remoteMutation === false
          && evidence?.transport?.repositoryRootSynced === false
          && evidence?.sshProfile?.identityFileExists === true
          && evidence?.sshProfile?.knownHostsFileExists === true
          && evidence?.artifactReferences?.some((artifact) => artifact?.manifest?.sha256Status === 'passed'
            && artifact?.module?.sha256Status === 'passed'
            && typeof artifact?.module?.targetPath === 'string');
      });
      return body?.actionResult?.actionId === 'site-slot.worker-run.artifact-push-fake-transport'
        && body?.gate?.verdict === 'passed'
        && body?.fakeTransport?.status === 'passed'
        && body?.fakeTransport?.execution === 'recorded'
        && body?.fakeTransport?.reportId === state.remoteReadyAdminFakeWorkerReportId
        && typeof state.remoteReadyAdminFakeWorkerReportId === 'string'
        && body?.report?.status === 'passed'
        && body?.report?.workerId === 'worker-http-smoke-admin-fake'
        && body?.report?.message === 'http smoke admin fake transport worker report'
        && fakeExecutedStep?.exitCode === 0;
    }
  },
  {
    name: 'remote ready admin fake worker report get',
    path: () => `/internal/v1/site-slots/worker-reports/${encodeURIComponent(state.remoteReadyAdminFakeWorkerReportId)}`,
    assert: (body) => body?.report?.reportId === state.remoteReadyAdminFakeWorkerReportId
      && body?.report?.jobId === state.remoteReadyAdminFakeWorkerJobId
      && body?.report?.status === 'passed'
      && body?.report?.stepReports?.some((step) => {
        const evidence = parseWorkerEvidence(step?.stdout);
        return evidence?.mode === 'artifact-push-fake-transport'
          && evidence?.execution === 'fake-executed'
          && evidence?.fakeTransport?.remoteMutation === false;
      })
  },
  {
    name: 'remote ready admin fake worker job passed',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.remoteReadyAdminFakeWorkerJobId)}`,
    assert: (body) => body?.job?.status === 'passed'
      && body?.job?.currentReportId === state.remoteReadyAdminFakeWorkerReportId
  }
];

if (remoteReadyOnly) {
  checks.length = 0;
  checks.push(...remoteReadyChecks);
}

if (expectK8sApply && !remoteReadyOnly) {
  const insertAt = checks.findIndex((check) => check.name === 'sdk dns evaluate');
  checks.splice(insertAt, 0, {
    name: 'internal coredns k8s apply',
    path: '/internal/v1/dns/coredns/configmap/apply',
    method: 'POST',
    body: () => ({
      snapshotId: state.dnsZoneSnapshotId,
      confirmApply: true,
      serverDryRun: false,
      actor: 'http-smoke',
      requestId: 'http-smoke-coredns-k8s-apply'
    }),
    assert: (body) => body?.result?.status === 'applied'
      && body?.result?.allowed === true
      && body?.result?.applied === true
      && body?.result?.serverDryRun === false
      && body?.result?.namespace === 'mx-dns'
      && body?.result?.configMapName === 'coredns'
      && typeof body?.result?.resourceVersion === 'string'
  });
}

function parseWorkerEvidence(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim().startsWith('{')) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function parseCliJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`CLI returned non-JSON stdout: ${stdout}`);
  }
}

function prepareRemoteReadySshFixture() {
  const fixtureDir = process.env.MX_SMOKE_REMOTE_READY_FIXTURE_DIR || join(tmpdir(), 'mx-remote-ready-ssh');
  mkdirSync(fixtureDir, { recursive: true });
  const identityFile = join(fixtureDir, 'oversea-ready_ed25519');
  const knownHostsFile = join(fixtureDir, 'known_hosts.oversea-ready');
  writeFileSync(identityFile, [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'http-smoke-remote-ready-fixture',
    '-----END OPENSSH PRIVATE KEY-----',
    ''
  ].join('\n'));
  chmodSync(identityFile, 0o600);
  writeFileSync(knownHostsFile, 'oversea-ready.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHttpSmokeRemoteReadyFixture\n');
  return { identityFile, knownHostsFile };
}

function hasArtifactDryRunEvidence(step) {
  const evidence = parseWorkerEvidence(step?.stdout);
  return evidence?.mode === 'artifact-push-dry-run'
    && evidence?.execution === 'not-executed'
    && evidence?.boundary === 'manifest-and-command-evidence-only'
    && Array.isArray(evidence?.summaryLines)
    && evidence.summaryLines.includes('artifact-push dry-run: remote execution skipped')
    && Array.isArray(evidence?.artifactReferences);
}

function hasManifestArtifactEvidence(step) {
  const evidence = parseWorkerEvidence(step?.stdout);
  return evidence?.artifactReferences?.some((artifact) => artifact?.exists === true
    && artifact?.manifest?.sha256Status === 'passed'
    && artifact?.module?.sha256Status === 'passed'
    && typeof artifact?.module?.targetPath === 'string'
    && artifact.module.targetPath.startsWith('/opt/mx/'));
}

for (const check of checks) {
  if (typeof check.run === 'function') {
    const body = await check.run();
    if (!check.assert(body)) {
      throw new Error(`${check.name} returned unexpected payload: ${JSON.stringify(body)}`);
    }
    console.log(`OK ${check.name}`);
    continue;
  }
  const checkPath = typeof check.path === 'function' ? check.path() : check.path;
  const url = `${baseUrl}${checkPath}`;
  const requestBody = typeof check.body === 'function' ? check.body() : check.body;
  const response = await fetch(url, {
    method: check.method ?? 'GET',
    headers: requestBody ? { 'content-type': 'application/json' } : undefined,
    body: requestBody ? JSON.stringify(requestBody) : undefined
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${check.name} failed: HTTP ${response.status} ${text}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${check.name} returned non-JSON response: ${text}`);
  }
  if (!check.assert(body)) {
    throw new Error(`${check.name} returned unexpected payload: ${text}`);
  }
  console.log(`OK ${check.name}`);
}

console.log(JSON.stringify({ ok: true, baseUrl, mode: remoteReadyOnly ? 'remote-ready-only' : 'default' }, null, 2));
