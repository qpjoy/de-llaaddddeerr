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
const shadowHomePublicKey = 'WvN2n3i6LXoJt1qX0lA2uP7cYy4rZs8mQb9dEfGhIjK=';
const smokeHomePeerLeaseIp = '10.90.100.20';
const smokeDomesticSiteId = 'domestic-smoke';
const smokeDomesticHost = process.env.MX_SMOKE_DOMESTIC_HOST || 'domestic-smoke.localdomain';
const smokeOverseaSiteId = process.env.MX_SMOKE_OVERSEA_SITE_ID || 'oversea-smoke';
const smokeOverseaHost = process.env.MX_SMOKE_OVERSEA_HOST || 'oversea-smoke.example.com';
const smokeOverseaSshProfileId = process.env.MX_SMOKE_OVERSEA_PROFILE_ID || `sshprof_http_smoke_${safeSmokeId(smokeOverseaSiteId)}`;
const smokeOverseaAccountPrefix = safeAccessAccountPrefix(smokeOverseaSiteId);
const mxLauncherRoot = resolve(scriptDir, '../..');
const remoteReadyFixture = remoteReadyOnly ? prepareRemoteReadySshFixture() : null;

const checks = [
  {
    name: 'healthz',
    path: '/healthz',
    assert: (body) => body && body.ok === true && body.service === 'mx-launcher-server'
  },
  {
    name: 'api docs openapi export',
    path: '/docs/api/openapi.json',
    assert: (body) => body?.openapi === '3.1.0'
      && body?.info?.title === 'MX Launcher Integration API'
      && body?.paths?.['/internal/v1/sdk/users']?.get?.['x-route-id'] === 'sdk.users.list'
      && body?.paths?.['/internal/v1/sdk/permissions/requests']?.post?.['x-route-id'] === 'sdk.permissions.request'
      && body?.paths?.['/internal/v1/user-center/users/{userId}/oversea/ensure-subscription']?.post,
  },
  {
    name: 'large evidence body accepted',
    path: '/internal/v1/observability/logs',
    method: 'POST',
    body: () => ({
      entries: [{
        timestamp: new Date().toISOString(),
        level: 'info',
        source: 'http-smoke-body-limit',
        message: 'x'.repeat(160000)
      }]
    }),
    assert: (body) => body?.accepted === 1
  },
  {
    name: 'app-center apps',
    path: '/internal/v1/app-center/apps',
    assert: (body) => {
      const h2o = Array.isArray(body?.apps) ? body.apps.find((app) => app?.appId === 'h2o') : null;
      return h2o?.fullName === 'Home To Oversea'
        && h2o?.launcherMode === 'embed'
        && h2o?.standaloneChannelProductId === 'mx-h2i'
        && h2o?.runtimeContractVersion === '0.1'
        && h2o?.manifest?.launcherMode === 'embed'
        && h2o?.manifest?.network?.scope === 'broker-session'
        && h2o?.manifest?.embed?.standaloneChannelProductId === 'mx-h2i'
        && h2o?.manifest?.runtimeContractVersion === '0.1'
        && Array.isArray(h2o?.manifest?.requiredCapabilities)
        && h2o.manifest.requiredCapabilities.includes('network.proxy');
    }
  },
  {
    name: 'app-center h2o installation report',
    path: '/internal/v1/app-center/apps/h2o/installations',
    method: 'POST',
    body: {
      installId: 'http-smoke-install',
      deviceId: 'http-smoke-device',
      userId: 'usr_demo_admin',
      sourceAppId: 'mx-h2i',
      packageName: '@qpjoy/electron-launcher-app-h2o',
      installedVersion: '0.1.0',
      latestVersion: '0.1.0',
      status: 'running',
      runtimeState: 'running',
      installSource: 'workspace',
      installPath: 'workspace:demos/mx-app-h2o',
      manifest: {
        appId: 'h2o',
        productId: 'h2o',
        packageName: '@qpjoy/electron-launcher-app-h2o',
        launcherMode: 'embed',
        runtimeContractVersion: '0.1',
        requiredCapabilities: ['user.session', 'network.proxy', 'app-center-runtime'],
        network: { scope: 'broker-session' },
        embed: { standaloneChannelProductId: 'mx-h2i', launchWithoutBroker: 'blocked' }
      },
      metadata: { event: 'http-smoke' },
      requestedBy: 'http-smoke'
    },
    assert: (body) => {
      state.h2oInstallationId = body?.installation?.installationId;
      return typeof state.h2oInstallationId === 'string'
        && body?.installation?.appId === 'h2o'
        && body?.installation?.installId === 'http-smoke-install'
        && body?.installation?.deviceId === 'http-smoke-device'
        && body?.installation?.sourceAppId === 'mx-h2i'
        && body?.installation?.installedVersion === '0.1.0'
        && body?.installation?.latestVersion === '0.1.0'
        && body?.installation?.status === 'running'
        && body?.installation?.manifest?.embed?.standaloneChannelProductId === 'mx-h2i';
    }
  },
  {
    name: 'app-center h2o installation query',
    path: '/internal/v1/app-center/installations?appId=h2o&installId=http-smoke-install&deviceId=http-smoke-device',
    assert: (body) => Array.isArray(body?.installations)
      && body.installations.some((installation) => installation?.installationId === state.h2oInstallationId
        && installation?.packageName === '@qpjoy/electron-launcher-app-h2o'
        && installation?.runtimeState === 'running')
  },
  {
    name: 'app-center apps include h2o installed state',
    path: '/internal/v1/app-center/apps?installId=http-smoke-install&deviceId=http-smoke-device',
    assert: (body) => {
      const h2o = Array.isArray(body?.apps) ? body.apps.find((app) => app?.appId === 'h2o') : null;
      return h2o?.installed === true
        && h2o?.installedVersion === '0.1.0'
        && h2o?.latestVersion === '0.1.0'
        && h2o?.status === 'running'
        && h2o?.runtimeState === 'running'
        && h2o?.installation?.installationId === state.h2oInstallationId;
    }
  },
  {
    name: 'sdk gateway manifest',
    path: '/internal/v1/sdk/gateway/manifest',
    assert: (body) => Array.isArray(body?.gateway?.routes)
      && body.gateway.routes.some((route) => route.routeId === 'sdk.identity.introspect')
      && body.gateway.routes.some((route) => route.routeId === 'sdk.gateway.access.evaluate')
      && body.gateway.routes.some((route) => route.routeId === 'sdk.users.list')
      && body.gateway.routes.some((route) => route.routeId === 'sdk.permissions.request')
      && body.gateway.routes.some((route) => route.routeId === 'sdk.config.snapshot')
      && body.gateway.routes.some((route) => route.routeId === 'sdk.dns.zone')
      && body.gateway.routes.some((route) => route.routeId === 'sdk.dns.coredns-configmap')
      && body.gateway.authAuthority === 'user-center'
      && body.gateway.sdk?.documentationUrl === '/docs/api/'
      && body.gateway.sdk?.openApiUrl === '/docs/api/openapi.json'
      && body.gateway.sdk?.markdownUrl === '/docs/api/mx-launcher-api.md'
  },
  {
    name: 'anonymous enroll',
    path: '/internal/v1/enrollments/anonymous',
    method: 'POST',
    body: {
      productId: 'launcher',
      platform: 'darwin',
      publicKey: shadowHomePublicKey,
      requestId: 'http-smoke-enroll'
    },
    assert: (body) => {
      state.installId = body?.enrollment?.installId;
      state.homeOverlayIp = body?.enrollment?.overlayIp;
      const topology = body?.snapshot?.config?.launcherNetwork;
      return typeof state.installId === 'string'
        && typeof state.homeOverlayIp === 'string'
        && isRelayLeaseIp(state.homeOverlayIp, '10.89.100')
        && body?.snapshot?.config?.defaultMode === 'visitor'
        && body?.enrollment?.publicKey === shadowHomePublicKey
        && topology?.model === 'internal-authority-domestic-relay-oversea-access-v1'
        && topology?.bootstrap?.hdiWithoutRelay === 'bootstrap-proxy-only'
        && topology?.bootstrap?.steadyStateAccess === 'domestic-wg-relay-primary'
        && topology?.bootstrap?.order?.includes('internal-joins-domestic-relay-as-service-peer')
        && topology?.authority?.users === 'internal-user-center'
        && topology?.homePath?.bootstrap === 'home-to-domestic-public-enroll-proxy'
        && topology?.homePath?.subscriptionFetch === 'home-through-domestic-h2i-to-internal-mihomo'
        && topology?.homePath?.overseaTraffic === 'home-direct-to-oversea-hysteria2'
        && topology?.homeLease?.cidr === '10.89.0.0/16'
        && topology?.domestic?.publicIpRequired === true
        && topology?.domestic?.publicServices?.includes('wg-relay')
        && topology?.domestic?.gatewayIp === '10.88.0.1'
        && topology?.domestic?.storesAuthority === false
        && topology?.domestic?.overlayCidrs?.includes(topology.homeLease.cidr)
        && topology?.internal?.publicIngress === false
        && topology?.internal?.requiresEnrollLease === true
        && topology?.internal?.relayPeer?.fixedIp === '10.88.88.88'
        && topology?.internal?.relayPeer?.initiatedBy === 'internal-outbound-to-domestic-public-wg'
        && topology?.subscriptions?.mihomo?.authority === 'internal-config-center'
        && topology?.subscriptions?.mihomo?.reachableVia?.includes('h2i-proxy')
        && topology?.relayPlan?.domesticRelay?.configArtifact === 'mx-domestic-wg-relay.conf'
        && topology?.relayPlan?.domesticRelay?.envArtifact === 'mx-domestic-relay.env'
        && topology?.relayPlan?.domesticRelay?.listenPort === 51280
        && topology?.relayPlan?.internalServicePeer?.fixedIp === '10.88.88.88'
        && topology?.relayPlan?.internalServicePeer?.configArtifact === 'mx-internal-service-peer.conf'
        && topology?.relayPlan?.internalServicePeer?.privateKeyPlacement === 'internal-only'
        && topology?.relayPlan?.homePeer?.leaseIp === state.homeOverlayIp
        && topology?.relayPlan?.homePeer?.publicKey === shadowHomePublicKey
        && topology?.relayPlan?.homePeer?.publicKeyStatus === 'ready-to-append'
        && topology?.relayPlan?.homePeer?.allowedIps?.includes(`${state.homeOverlayIp}/32`)
        && topology?.relayPlan?.routes?.internalCidrs?.includes('10.89.0.0/16')
        && topology?.relayPlan?.routes?.subscriptionReachability === 'domestic-wg-relay+h2i-proxy'
        && topology?.relayPlan?.gates?.domesticConfigMustNotContainInternalPrivateKey === true
        && topology?.relayPlan?.gates?.homePublicKeyRequiredForRealPeer === true
        && topology?.gates?.internalPublicIpRequired === false
        && topology?.gates?.internalMustJoinDomesticRelayBeforeHomeCanReachInternal === true
        && topology?.gates?.wgRelayBecomesPrimaryAfterEnroll === true
        && topology?.oversea?.subscriptionAuthority === 'internal-mihomo'
        && topology?.oversea?.healthEvidenceOutlet?.baseUrl === 'http://oversea.example.com:3434'
        && topology?.oversea?.healthEvidenceOutlet?.healthPath === '/healthz'
        && topology?.oversea?.healthEvidenceOutlet?.evidencePath === '/clients.csv'
        && topology?.oversea?.healthEvidenceOutlet?.purpose === 'health-and-evidence';
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
        && body?.issued?.record?.scopes?.includes('sdk.user.read')
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
    name: 'sdk gateway user route access allow',
    path: '/internal/v1/sdk/gateway/access/evaluate',
    method: 'POST',
    body: () => ({
      token: state.serviceToken,
      audience: 'mx-sdk',
      routeId: 'sdk.users.list',
      requestId: 'http-smoke-sdk-users-access'
    }),
    assert: (body) => body?.decision?.allowed === true
      && body?.decision?.matchedScopes?.includes('sdk.user.read')
  },
  {
    name: 'sdk user roles',
    path: '/internal/v1/sdk/roles',
    assert: (body) => Array.isArray(body?.roles)
      && body.roles.some((role) => role.roleId === 'mx-service-account')
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
      && body?.snapshot?.policies?.launcherNetwork?.overlayPolicy?.cidr === '10.89.0.0/16'
      && body?.snapshot?.policies?.launcherNetwork?.topology?.model === 'internal-authority-domestic-relay-oversea-access-v1'
      && body?.snapshot?.policies?.launcherNetwork?.topology?.domestic?.gatewayIp === '10.88.0.1'
      && body?.snapshot?.policies?.launcherNetwork?.topology?.domestic?.storesAuthority === false
      && body?.snapshot?.policies?.launcherNetwork?.topology?.internal?.publicIngress === false
      && body?.snapshot?.policies?.launcherNetwork?.topology?.internal?.relayPeer?.fixedIp === '10.88.88.88'
      && body?.snapshot?.policies?.launcherNetwork?.topology?.bootstrap?.steadyStateAccess === 'domestic-wg-relay-primary'
      && body?.snapshot?.policies?.launcherNetwork?.topology?.internal?.mihomoSubscriptionBaseUrl?.includes('/internal/v1/site-slots/oversea-main/subscriptions/hysteria2')
      && body?.snapshot?.policies?.launcherNetwork?.topology?.subscriptions?.mihomo?.fallback === 'domestic-snapshot-cache'
      && body?.snapshot?.policies?.launcherNetwork?.topology?.relayPlan?.homePeer?.publicKey === shadowHomePublicKey
      && body?.snapshot?.policies?.launcherNetwork?.topology?.relayPlan?.homePeer?.publicKeyStatus === 'ready-to-append'
      && body?.snapshot?.policies?.launcherNetwork?.topology?.relayPlan?.internalServicePeer?.privateKeyPlacement === 'internal-only'
      && body?.snapshot?.policies?.launcherNetwork?.topology?.relayPlan?.domesticRelay?.interfaceName === 'mx-domestic'
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
      profileId: smokeOverseaSshProfileId,
      siteId: smokeOverseaSiteId,
      kind: 'oversea',
      host: smokeOverseaHost,
      sshUser: 'root',
      sshPort: 22,
      identityFile: `/opt/mx/ssh/${smokeOverseaSiteId}_ed25519`,
      knownHostsFile: `/opt/mx/ssh/known_hosts.${smokeOverseaSiteId}`,
      hostKeyAlias: smokeOverseaSiteId,
      strictHostKeyChecking: 'yes',
      connectTimeoutSeconds: 9,
      batchMode: 'yes',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-ssh-profile'
    },
    assert: (body) => {
      state.sshProfileId = body?.profile?.profileId;
      return state.sshProfileId === smokeOverseaSshProfileId
        && body?.profile?.siteId === smokeOverseaSiteId
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
      && body?.profile?.knownHostsFile === `/opt/mx/ssh/known_hosts.${smokeOverseaSiteId}`
  },
  {
    name: 'config center ssh profile by site',
    path: () => `/internal/v1/config-center/site-slot-ssh-profiles/site/${encodeURIComponent(smokeOverseaSiteId)}`,
    assert: (body) => body?.profile?.profileId === state.sshProfileId
      && body?.profile?.hostKeyAlias === smokeOverseaSiteId
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
    assert: (body) => {
      const readiness = body?.readiness;
      const sshProfile = readiness?.sshProfile;
      const gateFailures = Array.isArray(readiness?.gateFailures) ? readiness.gateFailures : [];
      const missingFilesBlocked = readiness?.status === 'blocked'
        && sshProfile?.identityFileExists === false
        && sshProfile?.knownHostsFileExists === false
        && gateFailures.some((reason) => reason.includes('SSH identity file does not exist'))
        && gateFailures.some((reason) => reason.includes('SSH known_hosts file does not exist'));
      const filesReadyPlanOnly = readiness?.status === 'ready'
        && sshProfile?.identityFileExists === true
        && sshProfile?.knownHostsFileExists === true
        && gateFailures.length === 0;
      return (missingFilesBlocked || filesReadyPlanOnly)
        && readiness?.execution === 'not-started'
        && readiness?.boundary === 'ssh-profile-readiness-readonly'
        && readiness?.command?.startsWith('ssh ')
        && readiness?.command?.includes('mx-readonly-profile-readiness')
        && readiness?.command?.includes('df -h /')
        && sshProfile?.profileId === state.sshProfileId
        && (readiness?.gates?.envGate?.status === 'blocked' || readiness?.gates?.envGate?.status === 'passed')
        && readiness?.gates?.configGate?.status === 'blocked'
        && readiness?.gates?.requestGate?.status === 'blocked'
        && !readiness?.executionResult;
    }
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
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-run.domestic-relay-peer-plan'
        && action.allowed === true
        && action.gate === 'manual-evidence'
        && action.confirmFields?.includes('confirmRelayPeerPlan'))
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-run.domestic-relay-readonly-probe'
        && action.allowed === true
        && action.gate === 'confirm-remote-execution'
        && action.confirmFields?.includes('confirmRelayReadOnlyProbe'))
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-run.domestic-relay-peer-append'
        && action.allowed === true
        && action.gate === 'confirm-remote-execution'
        && action.risk === 'high'
        && action.confirmFields?.includes('confirmRelayPeerAppend')
        && action.confirmFields?.includes('confirmRelayReadOnlyProbeReviewed')
        && action.confirmFields?.includes('confirmRelayPeerPlanReviewed'))
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-run.domestic-relay-peer-append-ssh'
        && action.allowed === true
        && action.gate === 'confirm-remote-execution'
        && action.risk === 'high'
        && action.confirmFields?.includes('confirmRemoteExecution')
        && action.confirmFields?.includes('confirmRelayPeerAppendSsh')
        && action.confirmFields?.includes('confirmRelayPeerAppend')
        && action.confirmFields?.includes('confirmRelayReadOnlyProbeReviewed')
        && action.confirmFields?.includes('confirmRelayPeerPlanReviewed'))
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.domestic-relay-peer-append-ssh.prepare'
        && action.allowed === true
        && action.gate === 'confirm-remote-execution'
        && action.risk === 'high'
        && action.confirmFields?.includes('confirmRemoteExecution')
        && action.confirmFields?.includes('confirmRelayPeerAppendSshPrepare')
        && action.confirmFields?.includes('approvalId')
        && action.confirmFields?.includes('changeWindowStart')
        && action.confirmFields?.includes('changeWindowEnd'))
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.worker-run.artifact-push-fake-transport'
        && action.allowed === true
        && action.gate === 'confirm-fake-transport')
      && !body?.actionPolicy?.actions?.some((action) => typeof action.actionId === 'string' && action.actionId.includes('awx'))
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
      productId: 'launcher',
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
      siteId: smokeOverseaSiteId,
      sshProfileId: state.sshProfileId,
      hasDocker: true,
      hasOutboundInternet: true,
      requestId: 'http-smoke-oversea-slot'
    }),
    assert: (body) => {
      state.overseaSiteId = body?.plan?.siteId;
      state.overseaHost = body?.plan?.host;
      state.overseaServerPorts = String(body?.plan?.runtime?.oversea?.serverPorts || '51288');
      state.overseaFirstServerPort = Number(body?.plan?.runtime?.oversea?.firstServerPort || state.overseaServerPorts.split(',')[0] || 51288);
      state.overseaExportBaseUrl = body?.plan?.runtime?.oversea?.exportBaseUrl || `http://${state.overseaHost}:3434`;
      state.overseaCallbackMode = body?.plan?.runtime?.oversea?.callbackMode || 'remote-callback';
      const packageArtifacts = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'package-slot-artifacts');
      const prepareAccess = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'prepare-access-stack');
      const configureAccess = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'configure-oversea-access');
      const publishSubscription = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'publish-internal-subscription');
      const deployServices = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'deploy-slot-services');
      const syncInternalConfig = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'sync-internal-config');
      const deploymentCommands = body?.plan?.deploymentPhases?.flatMap((phase) => phase.commands ?? []) ?? [];
      return body?.plan?.kind === 'oversea'
        && body?.plan?.ssh?.profileId === state.sshProfileId
        && body?.plan?.ssh?.profileSource === 'config-center'
        && body?.plan?.ssh?.profileStatus === 'active'
        && body?.plan?.host === smokeOverseaHost
        && body?.plan?.ssh?.user === 'root'
        && body?.plan?.network?.qpTunnelCliMode === 'server-on'
        && body?.plan?.services?.dockerStacks?.includes('docker/hysteria2-access-stack')
        && packageArtifacts?.mode === 'admin-action'
        && packageArtifacts?.commands?.some((command) => command.includes('modules=hysteria2-access-stack,site-agent,runner-worker,observability-forwarder'))
        && packageArtifacts?.commands?.some((command) => command.includes('never sync the repository root'))
        && prepareAccess?.mode === 'artifact-push'
        && prepareAccess?.commands?.some((command) => command.includes('rsync -az') && command.includes('mx-oversea-access-stack.tar.gz'))
        && prepareAccess?.commands?.some((command) => command.includes('scp -P') && command.includes('mx-oversea-access-stack.tar.gz'))
        && prepareAccess?.commands?.some((command) => command.includes('/opt/mx/releases/oversea-access-stack/__release_revision__'))
        && configureAccess?.commands?.some((command) => command.includes(`HY2_EXPORT_BASE_URL=${state.overseaExportBaseUrl}`) && command.includes('HY2_EXPORT_USER=download') && command.includes('HY2_EXPORT_PASSWORD_HASH='))
        && configureAccess?.commands?.some((command) => command.includes('HY2_MIHOMO_ROUTING_MODE=cn-direct') && command.includes('HY2_RESERVED_INTERNAL_CIDRS=10.88.0.0/16,10.89.0.0/16,10.90.0.0/16') && command.includes('HY2_DOMESTIC_GATEWAY_IP=10.88.0.1'))
        && configureAccess?.commands?.some((command) => command.includes('base64 -d') && command.includes('tunnel-state.json'))
        && configureAccess?.commands?.some((command) => command.includes('reconcile-from-json') && command.includes('--mode hysteria2-only'))
        && configureAccess?.commands?.some((command) => command.includes('./manage.sh sync-internal-defaults'))
        && configureAccess?.commands?.some((command) => command.includes('./manage.sh docker-status'))
        && configureAccess?.commands?.some((command) => command.includes('@qpjoy/tunnel-cli') || command.includes('qp-tunnel-cli register') || command.includes('registration skipped'))
        && publishSubscription?.commands?.some((command) => command.includes('domesticBootstrapSubscription=') && command.includes(`/subscriptions/hysteria2/${smokeOverseaAccountPrefix}-domestic.yaml`))
        && publishSubscription?.commands?.some((command) => command.includes('internalBootstrapSubscription=') && command.includes(`/subscriptions/hysteria2/${smokeOverseaAccountPrefix}-internal.yaml`))
        && deployServices?.mode === 'artifact-push'
        && deployServices?.commands?.some((command) => command.includes('rsync -az') && command.includes('mx-oversea-services.tar.gz'))
        && deployServices?.commands?.some((command) => command.includes('/opt/mx/incoming/mx-oversea-services.tar.gz'))
        && deployServices?.commands?.some((command) => command.includes('MX_SITE_ROLE=oversea') && command.includes('LOCAL_STACK_PATH=/opt/mx/current/hysteria2-access-stack') && command.includes('MX_ACCESS_RUNTIME=hysteria2-only'))
        && deployServices?.commands?.some((command) => command.includes('slot services placeholder; no Docker services selected'))
        && syncInternalConfig?.commands?.some((command) => command.includes('overseaConfigDelivery=internal-pushed') && command.includes('remoteCurl=skipped'))
        && !syncInternalConfig?.commands?.some((command) => command.includes('ssh ') && command.includes('/healthz'))
        && !deploymentCommands.some((command) => command.includes('git pull') || command.includes('git clone') || command.includes('./docker/'));
    }
  },
  {
    name: 'oversea access accounts issue defaults',
    path: () => `/internal/v1/site-slots/${encodeURIComponent(smokeOverseaSiteId)}/access-accounts`,
    method: 'POST',
    body: () => ({
      issueDefaults: true,
      publicHost: state.overseaHost,
      serverPorts: state.overseaServerPorts || '51288',
      tlsFingerprint: 'D6:55:9C:55:7C:BF:F7:F1:D1:EE:0C:65:18:8E:90:A1:50:66:1F:70:F8:71:1D:16:50:E9:D2:B2:48:DD:00:58',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-oversea-access-accounts'
    }),
    assert: (body) => {
      state.overseaDomesticAccount = `${smokeOverseaAccountPrefix}-domestic`;
      return body?.site?.siteId === smokeOverseaSiteId
        && body?.site?.mode === 'internal-managed'
        && body?.site?.serverPorts === (state.overseaServerPorts || '51288')
        && body?.site?.tlsFingerprint === 'D6:55:9C:55:7C:BF:F7:F1:D1:EE:0C:65:18:8E:90:A1:50:66:1F:70:F8:71:1D:16:50:E9:D2:B2:48:DD:00:58'
        && body?.site?.reachability?.domesticWgRelayRequired === true
        && Array.isArray(body?.accounts)
        && body.accounts.length >= 11
        && body.accounts.some((account) => account.username === `${smokeOverseaAccountPrefix}-internal` && account.role === 'internal')
        && body.accounts.some((account) => account.username === state.overseaDomesticAccount && account.role === 'domestic')
        && body.accounts.some((account) => account.username === `${smokeOverseaAccountPrefix}-internal09` && account.role === 'internal-reserved')
        && body.accounts.every((account) => account.service === 'hysteria2' && typeof account.authToken === 'string');
    }
  },
  {
    name: 'oversea mihomo site get',
    path: () => `/internal/v1/launcher-network/mihomo/sites/${encodeURIComponent(smokeOverseaSiteId)}`,
    assert: (body) => body?.site?.siteId === smokeOverseaSiteId
      && (body?.site?.subscriptionBaseUrl?.endsWith(`/internal/v1/site-slots/${smokeOverseaSiteId}/subscriptions/hysteria2`)
        || body?.site?.subscriptionBaseUrl === `internal-pushed://${smokeOverseaSiteId}/subscriptions/hysteria2`)
      && body?.site?.reachability?.internalUrlOnly === true
      && body?.site?.reachability?.h2iRequired === true
  },
  {
    name: 'oversea mihomo reachability ordering',
    path: () => `/internal/v1/launcher-network/mihomo/sites/${encodeURIComponent(smokeOverseaSiteId)}/reachability`,
    assert: (body) => body?.reachability?.siteId === smokeOverseaSiteId
      && body?.reachability?.verdict === 'h-endpoint-blocked'
      && body?.reachability?.currentBoundary === 'internal-only'
      && body?.reachability?.gates?.domesticWgRelayRequired === true
      && body?.reachability?.gates?.h2iRequired === true
      && body?.reachability?.gates?.internalDnsRequired === true
      && body?.reachability?.gates?.overseaRuntime === 'hysteria2-only'
      && body?.reachability?.gates?.domesticGatewayIp === '10.88.0.1'
      && body?.reachability?.gates?.reservedInternalCidrs?.includes('10.90.0.0/16')
      && body?.reachability?.accountSummary?.domestic === 1
      && body?.reachability?.accountSummary?.internalReserved === 9
      && body?.reachability?.stages?.some((stage) => stage.stageId === 'internal-subscription-authority' && stage.status === 'ready')
      && body?.reachability?.stages?.some((stage) => stage.stageId === 'domestic-wg-relay' && stage.status === 'blocked')
      && body?.reachability?.stages?.some((stage) => stage.stageId === 'h2i-internal-dns' && stage.status === 'blocked')
      && body?.reachability?.executionOrder?.some((step) => step.includes('Domestic WG/H2I'))
  },
  {
    name: 'oversea domestic mihomo subscription yaml',
    run: async () => {
      const response = await fetch(`${baseUrl}/internal/v1/site-slots/${encodeURIComponent(smokeOverseaSiteId)}/subscriptions/hysteria2/${encodeURIComponent(state.overseaDomesticAccount)}.yaml`);
      const text = await response.text();
      if (!response.ok) throw new Error(`subscription yaml failed: HTTP ${response.status} ${text}`);
      return { text, contentType: response.headers.get('content-type') };
    },
    assert: (body) => body.contentType?.includes('text/yaml')
      && body.text.includes('type: hysteria2')
      && body.text.includes('mode: rule')
      && body.text.includes('log-level: info')
      && body.text.includes('geodata-mode: true')
      && body.text.includes(`port: ${state.overseaFirstServerPort || 51288}`)
      && !body.text.includes('port: 52120')
      && body.text.includes('down: "30 Mbps"')
      && body.text.includes('up: "30 Mbps"')
      && body.text.includes('fingerprint: "D6:55:9C:55:7C:BF:F7:F1:D1:EE:0C:65:18:8E:90:A1:50:66:1F:70:F8:71:1D:16:50:E9:D2:B2:48:DD:00:58"')
      && body.text.includes('alpn:')
      && body.text.includes('- h3')
      && body.text.includes('DOMAIN-SUFFIX,local,DIRECT')
      && body.text.includes('IP-CIDR,192.168.0.0/16,DIRECT,no-resolve')
      && body.text.includes('GEOSITE,CN,DIRECT')
      && body.text.includes('GEOIP,CN,DIRECT')
      && body.text.includes('10.88.0.0/16')
      && body.text.includes(`${smokeOverseaSiteId}-hysteria2`)
      && body.text.includes('Reachability: this Internal subscription URL requires Domestic WG relay/H2I')
  },
  {
    name: 'domestic slot plan',
    path: '/internal/v1/site-slots/plans',
    method: 'POST',
    body: () => ({
      kind: 'domestic',
      siteId: smokeDomesticSiteId,
      host: smokeDomesticHost,
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
      const prepareRelayAuthority = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'prepare-domestic-relay-authority');
      const resolveSubscription = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'resolve-domestic-bootstrap-subscription');
      const bootstrapEgress = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'bootstrap-domestic-egress');
      const installDockerRuntime = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'install-domestic-docker-runtime');
      const verifyDomesticEgress = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'verify-domestic-egress');
      const activatePeerCenter = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'activate-domestic-peer-center');
      const syncInternalConfig = body?.plan?.deploymentPhases?.find((phase) => phase.phaseId === 'sync-internal-config');
      return typeof state.domesticSlotPlanId === 'string'
        && body?.plan?.kind === 'domestic'
        && body?.plan?.network?.mode === 'oversea-assisted'
        && body?.plan?.network?.qpTunnelCliMode === 'egress-on'
        && body?.plan?.services?.hostServices?.includes('wg-quick@mx-domestic')
        && packageArtifacts?.commands?.some((command) => command.includes('qp-tunnel-cli-offline-fallback'))
        && packageArtifacts?.commands?.some((command) => command.includes('refresh-tunnel-cli latest'))
        && packageArtifacts?.commands?.some((command) => command.includes('--from-tarball'))
        && prepareRelayAuthority?.mode === 'admin-action'
        && prepareRelayAuthority?.commands?.some((command) => command.includes('Domestic WG gateway=10.88.0.1') && command.includes('Internal service peer=10.88.88.88'))
        && prepareRelayAuthority?.commands?.some((command) => command.includes('mx-domestic-wg-relay.conf') && command.includes('10.90.0.0/16'))
        && prepareRelayAuthority?.commands?.some((command) => command.includes('mx-internal-service-peer.conf') && command.includes('never copy the Internal private key to Domestic'))
        && prepareRelayAuthority?.commands?.some((command) => command.includes('Internal has no public ingress'))
        && prepareRelayAuthority?.commands?.some((command) => command.includes('Domestic WG relay primary'))
        && resolveSubscription?.mode === 'admin-action'
        && resolveSubscription?.commands?.some((command) => command.includes('domesticBootstrapSubscription') && command.includes(`/internal/v1/site-slots/${smokeOverseaSiteId}/subscriptions/hysteria2/${state.overseaDomesticAccount}.yaml`))
        && resolveSubscription?.commands?.some((command) => command.includes('mx-domestic-bootstrap-subscription.yaml') && command.includes('Domestic cannot fetch Internal URLs until mx-domestic reaches 10.88.88.88'))
        && resolveSubscription?.commands?.some((command) => command.includes('install node/npm') && command.includes('npm install'))
        && bootstrapEgress?.mode === 'artifact-push'
        && bootstrapEgress?.commands?.some((command) => command.includes('QP_TUNNEL_CLI=/opt/mx/current/qp-tunnel-cli/bin/qp-tunnel-cli'))
        && bootstrapEgress?.commands?.some((command) => command.includes('attempt pre-egress npm install @qpjoy/tunnel-cli@latest'))
        && bootstrapEgress?.commands?.some((command) => command.includes('mx-domestic-qp-tunnel-cli-fallback.tar.gz'))
        && bootstrapEgress?.commands?.some((command) => command.includes('mx-domestic-bootstrap-subscription.yaml') && command.includes('domestic-bootstrap-subscription.yaml'))
        && bootstrapEgress?.commands?.some((command) => command.includes('MIHOMO_TUN_ROUTE_EXCLUDE_ADDRESS') && command.includes('using Internal-pushed fallback'))
        && bootstrapEgress?.commands?.some((command) => command.includes('@qpjoy/tunnel-cli@latest') && command.includes('npm refresh skipped after egress-on'))
        && bootstrapEgress?.commands?.some((command) => command.includes('node/npm absent'))
        && bootstrapEgress?.commands?.some((command) => command.includes('BOOTSTRAP_SUBSCRIPTION_FILE=/opt/mx/current/qp-tunnel-cli/domestic-bootstrap-subscription.yaml'))
        && bootstrapEgress?.commands?.some((command) => command.includes('--file $BOOTSTRAP_SUBSCRIPTION_FILE'))
        && bootstrapEgress?.commands?.some((command) => command.includes('local bootstrap subscription file is required before WG relay/Internal URL is reachable'))
        && !bootstrapEgress?.commands?.some((command) => command.includes('--url '))
        && bootstrapEgress?.commands?.some((command) => command.includes('egress-on'))
        && bootstrapEgress?.commands?.some((command) => command.includes('QP_TUNNEL_MODE=${QP_TUNNEL_MODE:-egress-on}'))
        && bootstrapEgress?.commands?.some((command) => command.includes('/usr/local/bin/mihomo-client'))
        && bootstrapEgress?.commands?.some((command) => command.includes('systemctl enable mihomo-client'))
        && !bootstrapEgress?.commands?.some((command) => command.includes('elif command -v npm'))
        && !bootstrapEgress?.commands?.some((command) => command.includes('<internal-issued-oversea-hysteria2-subscription>'))
        && installDockerRuntime?.commands?.some((command) => command.includes('docker') && command.includes('apt-get'))
        && verifyDomesticEgress?.mode === 'remote-ssh'
        && verifyDomesticEgress?.commands?.some((command) => command.includes('www.gstatic.com/generate_204') && command.includes('--http1.1'))
        && verifyDomesticEgress?.commands?.some((command) => command.includes('auth.docker.io/token') && command.includes('registry-1.docker.io/v2/'))
        && verifyDomesticEgress?.commands?.some((command) => command.includes('registry-1.docker.io/v2/') && command.includes('127.0.0.1:7788'))
        && verifyDomesticEgress?.commands?.some((command) => command.includes('generic HTTPS is not reachable') && command.includes('Docker registry is not reachable'))
        && verifyDomesticEgress?.commands?.some((command) => command.includes('mihomo-client service is not active') && command.includes('journalctl -u mihomo-client'))
        && activatePeerCenter?.commands?.some((command) => command.includes('mx-domestic-wg-relay.conf') && command.includes('/etc/wireguard/mx-domestic.conf'))
        && activatePeerCenter?.commands?.some((command) => command.includes('mx-domestic-relay.env') && command.includes('/opt/mx/current/domestic/mx-domestic-relay.env'))
        && activatePeerCenter?.commands?.some((command) => command.includes('preserving V1') && command.includes('cleanup-v1-wireguard --apply'))
        && !activatePeerCenter?.commands?.some((command) => command.includes('disable --now wg-quick@hdo-home') || command.includes('wg-quick down hdo-home') || command.includes('ip link delete hdo-home'))
        && activatePeerCenter?.commands?.some((command) => command.includes('internal service peer private key must not be copied to Domestic'))
        && syncInternalConfig?.commands?.some((command) => command.includes('10.88.88.88:18090/healthz'))
        && !syncInternalConfig?.commands?.some((command) => command.includes('127.0.0.1:18090/healthz'))
        && !activatePeerCenter?.commands?.some((command) => command.includes('rsync') && command.includes('mx-internal-service-peer.conf'));
    }
  },
  {
    name: 'domestic slot get',
    path: () => `/internal/v1/site-slots/plans/${encodeURIComponent(state.domesticSlotPlanId)}`,
    assert: (body) => body?.plan?.planId === state.domesticSlotPlanId
      && body?.plan?.nextActions?.includes('install-docker-runtime')
      && body?.plan?.nextActions?.includes('activate-domestic-peer-center')
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
    name: 'admin action execute domestic wg materialize',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.adminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.domestic-wg.materialize',
      path: `/internal/v1/config-center/domestic-wg-secrets/${smokeDomesticSiteId}/materialize-ready`,
      body: {
        siteId: smokeDomesticSiteId,
        planId: state.domesticSlotPlanId,
        publicEndpoint: `${smokeDomesticHost}:51280`,
        listenPort: 51280,
        domesticGatewayIp: '10.88.0.1',
        domesticGatewayCidr: '10.88.0.0/16',
        productRelayCidrs: ['10.89.0.0/16', '10.90.0.0/16'],
        userRelayCidr: '10.89.0.0/16',
        internalServiceIp: '10.88.88.88',
        internalServiceCidr: '10.88.0.0/16',
        guestRelayCidr: '10.90.0.0/16',
        rotateRelayKey: false,
        rotateInternalServiceKey: false,
        confirmRotate: false,
        requestedBy: 'http-smoke-admin-action',
        requestId: 'http-smoke-domestic-wg-materialize'
      }
    }),
    assert: (body) => body?.actionResult?.actionId === 'site-slot.domestic-wg.materialize'
      && body?.domesticWgMaterialize?.status === 'passed'
      && body?.domesticWgMaterialize?.publicEndpoint === `${smokeDomesticHost}:51280`
      && body?.secret?.listenPort === 51280
      && body?.secret?.readiness?.secretMaterial === 'injected'
      && body?.secret?.readiness?.publicEndpointStatus === 'ready'
      && body?.domesticWgMaterialize?.artifact?.moduleId === 'wireguard-config'
      && body?.domesticWgMaterialize?.artifact?.status === 'ready'
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
      && body?.session?.gates?.remoteExecutionConfirmed === false
      && body?.session?.warnings?.some((warning) => (
        warning.includes('SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED')
        || warning.includes('remote-ssh requires confirmRemoteExecution=true')
      ))
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
      && body?.gate?.gateFailures?.some((failure) => failure.includes('worker job mode must be remote-ssh'))
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
      && !body.report
  },
  {
    name: 'admin worker-run action hint',
    path: () => `/internal/v1/admin/site-slots/pipelines/${encodeURIComponent(state.domesticSlotPlanId)}?token=${encodeURIComponent(state.adminToken)}`,
    assert: (body) => {
      const hintedJobId = selectWorkerActionHintJobId(body);
      const hintedJob = body?.pipeline?.workerJobs?.find((job) => job.jobId === hintedJobId);
      if (hintedJobId && hintedJob) {
        state.domesticSlotAdminWorkerJobId = hintedJobId;
        state.domesticSlotAdminWorkerStepId = hintedJob.steps?.[0]?.stepId;
      }
      const jobId = state.domesticSlotAdminWorkerJobId;
      const hints = Array.isArray(body?.pipeline?.summary?.actionHints) ? body.pipeline.summary.actionHints : [];
      const hasRelayPeerHintForOrdinaryJob = [
        'site-slot.worker-run.domestic-relay-readonly-probe',
        'site-slot.worker-run.domestic-relay-peer-plan',
        'site-slot.worker-run.domestic-relay-peer-append',
        'site-slot.worker-run.domestic-relay-peer-append-ssh'
      ].some((actionId) => hints.some((action) => action?.actionId === actionId
        && action?.allowed === true
        && typeof action?.path === 'string'
        && action.path.startsWith(`/internal/v1/site-slots/worker-jobs/${jobId}/`)));
      return typeof jobId === 'string'
        && workerActionHintMatches(body, 'site-slot.worker-run.remote-ssh-gate', jobId, '/remote-ssh-gate')
        && workerActionHintMatches(body, 'site-slot.worker-run.remote-ssh-readonly-probe', jobId, '/remote-ssh-readonly-probe', ['confirmReadOnlyProbe'])
        && workerActionHintMatches(body, 'site-slot.worker-run.remote-ssh-execute', jobId, '/run-artifact-push-remote-ssh', ['confirmWorkerHandoff'])
        && workerActionHintMatches(body, 'site-slot.worker-run.artifact-push-remote-ssh-plan', jobId, '/run-artifact-push-remote-ssh-plan', ['confirmPlanOnly'])
        && workerActionHintMatches(body, 'site-slot.worker-run.artifact-push-dry-run', jobId, '/run-artifact-push-dry-run')
        && !hasRelayPeerHintForOrdinaryJob
        && optionalWorkerActionHintMatches(body, 'site-slot.worker-run.artifact-push-fake-transport', jobId, '/run-artifact-push-fake-transport', ['confirmFakeTransport'])
        && !hints.some((action) => typeof action?.actionId === 'string' && action.actionId.includes('awx'));
    }
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
      && body?.gate?.gateFailures?.some((failure) => failure.includes('worker job mode must be remote-ssh'))
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
    name: 'domestic relay peer plan runner simulate',
    path: () => `/internal/v1/site-slots/executions/${encodeURIComponent(state.domesticSlotAdminApplyRunId)}/runner-sessions`,
    method: 'POST',
    body: {
      mode: 'simulate',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-domestic-relay-peer-runner'
    },
    assert: (body) => {
      state.domesticRelayPeerRunnerSessionId = body?.session?.sessionId;
      return typeof state.domesticRelayPeerRunnerSessionId === 'string'
        && body?.session?.status === 'completed';
    }
  },
  {
    name: 'domestic relay peer plan worker job',
    path: () => `/internal/v1/site-slots/runner-sessions/${encodeURIComponent(state.domesticRelayPeerRunnerSessionId)}/worker-jobs`,
    method: 'POST',
    body: {
      workerId: 'worker-http-smoke-relay-peer',
      workerKind: 'internal-runner',
      rollbackStrategy: 'restore-domestic-wg-peer-before-append',
      requestedBy: 'http-smoke',
      requestId: 'http-smoke-domestic-relay-peer-worker-job'
    },
    assert: (body) => {
      state.domesticRelayPeerWorkerJobId = body?.job?.jobId;
      return typeof state.domesticRelayPeerWorkerJobId === 'string'
        && body?.job?.kind === 'domestic'
        && body?.job?.status === 'ready';
    }
  },
  {
    name: 'domestic relay actions hint',
    path: () => `/internal/v1/admin/site-slots/pipelines/${encodeURIComponent(state.domesticSlotPlanId)}?token=${encodeURIComponent(state.adminToken)}`,
    assert: (body) => !body?.pipeline?.summary?.actionHints?.some((action) => [
        'site-slot.domestic-relay-peer-append-ssh.prepare',
        'site-slot.domestic-relay-peer-append-awx.prepare',
        'site-slot.worker-run.domestic-relay-peer-plan',
        'site-slot.worker-run.domestic-relay-peer-append',
        'site-slot.worker-run.domestic-relay-peer-append-ssh'
      ].includes(action?.actionId))
      && !body?.pipeline?.summary?.actionHints?.some((action) => typeof action?.actionId === 'string' && action.actionId.includes('awx'))
  },
  {
    name: 'domestic relay readonly probe handoff',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.adminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.domestic-relay-readonly-probe',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticRelayPeerWorkerJobId)}/domestic-relay-readonly-probe`,
      body: {
        confirmRelayReadOnlyProbe: true,
        requestedBy: 'http-smoke-admin-action',
        requestId: 'http-smoke-domestic-relay-readonly-probe'
      }
    }),
    assert: (body) => body?.actionResult?.actionId === 'site-slot.worker-run.domestic-relay-readonly-probe'
      && body?.relayReadOnlyProbe?.status === 'ready'
      && body?.relayReadOnlyProbe?.execution === 'not-started'
      && body?.relayReadOnlyProbe?.boundary === 'readonly-ssh-handoff-only'
      && body?.relayReadOnlyProbe?.readOnlyProbe?.remoteMutation === false
      && body?.relayReadOnlyProbe?.readOnlyProbe?.commandExecuted === false
      && body?.relayReadOnlyProbe?.domesticRelay?.interfaceName === 'mx-domestic'
      && body?.relayReadOnlyProbe?.domesticRelay?.gatewayIp === '10.88.0.1'
      && body?.relayReadOnlyProbe?.command?.startsWith('ssh ')
      && body?.relayReadOnlyProbe?.command?.includes('wg show mx-domestic')
      && body?.relayReadOnlyProbe?.command?.includes('wg show mx-domestic latest-handshakes')
      && body?.relayReadOnlyProbe?.command?.includes('Internal service peer has no latest handshake')
      && body?.relayReadOnlyProbe?.command?.includes('ip route get "$internal_ip"')
      && body?.relayReadOnlyProbe?.command?.includes('http://${internal_ip}:18090/healthz')
      && body?.relayReadOnlyProbe?.command?.includes('systemctl status wg-quick@mx-domestic')
      && body?.relayReadOnlyProbe?.command?.includes('mx-internal-service-peer.conf')
      && !body?.relayReadOnlyProbe?.command?.includes('wg set')
      && body?.relayReadOnlyProbe?.h2iGate?.internalServiceIp === '10.88.88.88'
      && body?.relayReadOnlyProbe?.h2iGate?.internalServicePublicKey === 'configured'
      && body?.relayReadOnlyProbe?.h2iGate?.requiresLatestHandshake === true
      && body?.relayReadOnlyProbe?.h2iGate?.requiresInternalHealthz === true
      && body?.relayReadOnlyProbe?.readOnlyProbe?.checks?.includes('wg show mx-domestic latest-handshakes')
      && body?.relayReadOnlyProbe?.readOnlyProbe?.checks?.includes('curl/wget http://10.88.88.88:18090/healthz')
      && body?.relayReadOnlyProbe?.gates?.remoteMutationAllowed === false
      && body?.relayReadOnlyProbe?.gates?.internalPrivateKeyMustNotExistOnDomestic === true
      && !body.report
  },
  {
    name: 'domestic relay peer append handoff',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.adminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.domestic-relay-peer-append',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticRelayPeerWorkerJobId)}/domestic-relay-peer-append`,
      body: {
        confirmRelayPeerAppend: true,
        confirmRelayReadOnlyProbeReviewed: true,
        confirmRelayPeerPlanReviewed: true,
        peerRole: 'guest',
        leaseIp: smokeHomePeerLeaseIp,
        publicKey: shadowHomePublicKey,
        requestedBy: 'http-smoke-admin-action',
        requestId: 'http-smoke-domestic-relay-peer-append'
      }
    }),
    assert: (body) => body?.actionResult?.actionId === 'site-slot.worker-run.domestic-relay-peer-append'
      && body?.relayPeerAppend?.status === 'ready'
      && body?.relayPeerAppend?.execution === 'not-started'
      && body?.relayPeerAppend?.boundary === 'gated-ssh-handoff-only'
      && body?.relayPeerAppend?.mode === 'domestic-relay-peer-append'
      && body?.relayPeerAppend?.handoff?.commandExecuted === false
      && body?.relayPeerAppend?.handoff?.remoteMutation === true
      && body?.relayPeerAppend?.handoff?.mutation === 'wg-set-peer-allowed-ips'
      && body?.relayPeerAppend?.homePeer?.leaseIp === smokeHomePeerLeaseIp
      && body?.relayPeerAppend?.homePeer?.publicKey === shadowHomePublicKey
      && body?.relayPeerAppend?.homePeer?.allowedIps?.includes(`${smokeHomePeerLeaseIp}/32`)
      && body?.relayPeerAppend?.domesticRelay?.interfaceName === 'mx-domestic'
      && body?.relayPeerAppend?.domesticRelay?.gatewayIp === '10.88.0.1'
      && body?.relayPeerAppend?.command?.startsWith('ssh ')
      && body?.relayPeerAppend?.command?.includes('mx-domestic-relay-peer-append')
      && body?.relayPeerAppend?.command?.includes('wg set mx-domestic peer')
      && body?.relayPeerAppend?.command?.includes('allowed-ips')
      && body?.relayPeerAppend?.command?.includes(`${smokeHomePeerLeaseIp}/32`)
      && body?.relayPeerAppend?.command?.includes('wg-quick save mx-domestic')
      && body?.relayPeerAppend?.command?.includes('wg show mx-domestic')
      && body?.relayPeerAppend?.command?.includes('mx-internal-service-peer.conf')
      && body?.relayPeerAppend?.gates?.confirmRelayPeerAppend === true
      && body?.relayPeerAppend?.gates?.confirmRelayReadOnlyProbeReviewed === true
      && body?.relayPeerAppend?.gates?.confirmRelayPeerPlanReviewed === true
      && body?.relayPeerAppend?.gates?.internalPrivateKeyMustNotExistOnDomestic === true
      && body?.relayPeerAppend?.env?.SITE_SLOT_DOMESTIC_RELAY_APPEND === '1'
      && !body.report
  },
  {
    name: 'domestic relay peer append ssh blocked',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.adminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.domestic-relay-peer-append-ssh',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticRelayPeerWorkerJobId)}/run-domestic-relay-peer-append-ssh`,
      body: {
        confirmRemoteExecution: true,
        confirmRelayPeerAppendSsh: true,
        confirmRelayPeerAppend: true,
        confirmRelayReadOnlyProbeReviewed: true,
        confirmRelayPeerPlanReviewed: true,
        peerRole: 'guest',
        leaseIp: smokeHomePeerLeaseIp,
        publicKey: shadowHomePublicKey,
        workerId: 'worker-http-smoke-relay-peer-ssh',
        message: 'http smoke Domestic relay peer append SSH',
        requestedBy: 'http-smoke-admin-action',
        requestId: 'http-smoke-domestic-relay-peer-append-ssh'
      }
    }),
    assert: (body) => body?.actionResult?.actionId === 'site-slot.worker-run.domestic-relay-peer-append-ssh'
      && body?.gate?.verdict === 'blocked'
      && body?.relayPeerAppend?.status === 'ready'
      && body?.relayPeerAppendSsh?.status === 'blocked'
      && body?.relayPeerAppendSsh?.execution === 'not-started'
      && body?.relayPeerAppendSsh?.boundary === 'gated-ssh-worker'
      && body?.relayPeerAppendSsh?.mode === 'domestic-relay-peer-append-ssh'
      && body?.relayPeerAppendSsh?.command?.includes('wg set mx-domestic peer')
      && body?.relayPeerAppendSsh?.command?.includes(`${smokeHomePeerLeaseIp}/32`)
      && body?.relayPeerAppendSsh?.handoff?.commandExecuted === false
      && body?.relayPeerAppendSsh?.handoff?.remoteMutation === true
      && body?.relayPeerAppendSsh?.gates?.confirmRemoteExecution === true
      && body?.relayPeerAppendSsh?.gates?.confirmRelayPeerAppendSsh === true
      && body?.relayPeerAppendSsh?.blockedReasons?.some((reason) => reason.includes('worker job mode must be remote-ssh'))
      && body?.relayPeerAppendSsh?.blockedReasons?.some((reason) => reason.includes('managed SSH profile is required'))
      && !body.report
  },
  {
    name: 'domestic relay peer append ssh prepare',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.adminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.domestic-relay-peer-append-ssh.prepare',
      path: `/internal/v1/site-slots/executions/${encodeURIComponent(state.domesticSlotAdminApplyRunId)}/prepare-domestic-relay-peer-append-ssh`,
      body: {
        confirmRemoteExecution: true,
        confirmRelayPeerAppendSshPrepare: true,
        approvalId: 'approval-http-smoke-domestic-relay-peer-append',
        changeWindowStart: '2026-06-11T00:00:00.000Z',
        changeWindowEnd: '2026-06-12T00:00:00.000Z',
        workerId: 'worker-http-smoke-domestic-relay-append',
        workerKind: 'domestic-runner',
        retryLimit: 1,
        rollbackStrategy: 'restore-domestic-wg-peer-before-append',
        requestedBy: 'http-smoke-admin-action',
        requestId: 'http-smoke-domestic-relay-peer-append-ssh-prepare'
      }
    }),
    assert: (body) => {
      const prepare = body?.relayPeerAppendSshPrepare;
      state.domesticRelayPeerAppendSshPrepareSessionId = body?.session?.sessionId;
      state.domesticRelayPeerAppendSshPrepareJobId = body?.job?.jobId;
      const blockedByReadinessGate = prepare?.status === 'blocked'
        && body?.session == null
        && body?.job == null
        && prepare?.blockedReasons?.some((reason) => reason.includes('Internal-managed SSH Profile'));
      const blockedByRunnerGate = prepare?.status === 'blocked'
        && body?.session?.mode === 'remote-ssh'
        && body?.session?.status === 'blocked'
        && prepare?.runner?.remoteExecutionConfirmed === true
        && prepare?.blockedReasons?.some((reason) => reason.includes('SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED'))
        && !body.job;
      const preparedJob = prepare?.status === 'ready'
        && body?.session?.mode === 'remote-ssh'
        && body?.session?.status === 'queued'
        && body?.job?.mode === 'remote-ssh'
        && body?.job?.status === 'ready'
        && body?.job?.approval?.status === 'recorded'
        && body?.job?.changeWindow?.start === '2026-06-11T00:00:00.000Z'
        && body?.job?.changeWindow?.end === '2026-06-12T00:00:00.000Z';
      return body?.actionResult?.actionId === 'site-slot.domestic-relay-peer-append-ssh.prepare'
        && prepare?.mode === 'domestic-relay-peer-append-ssh-prepare'
        && prepare?.boundary === 'remote-ssh-runner-job-preparation'
        && prepare?.execution === 'not-started'
        && prepare?.gates?.confirmRemoteExecution === true
        && prepare?.gates?.confirmRelayPeerAppendSshPrepare === true
        && prepare?.gates?.domesticOnly === true
        && prepare?.gates?.applyConfirmed === true
        && (blockedByReadinessGate || blockedByRunnerGate || preparedJob);
    }
  },
  {
    name: 'domestic relay peer plan worker report',
    path: () => `/internal/v1/admin/actions/execute?token=${encodeURIComponent(state.adminToken)}`,
    method: 'POST',
    body: () => ({
      actionId: 'site-slot.worker-run.domestic-relay-peer-plan',
      path: `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticRelayPeerWorkerJobId)}/run-domestic-relay-peer-plan`,
      body: {
        confirmRelayPeerPlan: true,
        peerRole: 'guest',
        leaseIp: smokeHomePeerLeaseIp,
        publicKey: shadowHomePublicKey,
        workerId: 'worker-http-smoke-relay-peer',
        message: 'http smoke Domestic relay peer plan',
        requestedBy: 'http-smoke-admin-action',
        requestId: 'http-smoke-domestic-relay-peer-plan'
      }
    }),
    assert: (body) => {
      state.domesticRelayPeerReportId = body?.report?.reportId;
      const relayPlanStep = body?.report?.stepReports?.find((step) => {
        const evidence = parseWorkerEvidence(step?.stdout);
        return evidence?.mode === 'domestic-relay-peer-plan'
          && evidence?.execution === 'planned'
          && evidence?.boundary === 'admin-domestic-relay-peer-plan-only'
          && evidence?.planOnly?.commandExecuted === false
          && evidence?.planOnly?.remoteMutation === false
          && evidence?.homePeer?.leaseIp === smokeHomePeerLeaseIp
          && evidence?.homePeer?.publicKey === shadowHomePublicKey
          && evidence?.homePeer?.allowedIps?.includes(`${smokeHomePeerLeaseIp}/32`)
          && evidence?.domesticRelay?.interfaceName === 'mx-domestic'
          && evidence?.domesticRelay?.gatewayIp === '10.88.0.1'
          && evidence?.internalServicePeer?.fixedIp === '10.88.88.88'
          && evidence?.internalServicePeer?.privateKeyPlacement === 'internal-only'
          && evidence?.internalServicePeer?.privateKeyCopiedToDomestic === false
          && evidence?.plannedCommands?.some((command) => command.includes(`allowed-ips ${smokeHomePeerLeaseIp}/32`))
          && evidence?.gates?.remoteMutationAllowed === false;
      });
      return body?.actionResult?.actionId === 'site-slot.worker-run.domestic-relay-peer-plan'
        && body?.relayPeerPlan?.status === 'passed'
        && body?.relayPeerPlan?.execution === 'recorded'
        && body?.relayPeerPlan?.reportId === state.domesticRelayPeerReportId
        && typeof state.domesticRelayPeerReportId === 'string'
        && body?.report?.status === 'passed'
        && body?.report?.workerId === 'worker-http-smoke-relay-peer'
        && body?.report?.message === 'http smoke Domestic relay peer plan'
        && relayPlanStep?.exitCode === 0;
    }
  },
  {
    name: 'domestic relay peer plan report get',
    path: () => `/internal/v1/site-slots/worker-reports/${encodeURIComponent(state.domesticRelayPeerReportId)}`,
    assert: (body) => body?.report?.reportId === state.domesticRelayPeerReportId
      && body?.report?.jobId === state.domesticRelayPeerWorkerJobId
      && body?.report?.status === 'passed'
      && body?.report?.stepReports?.some((step) => {
        const evidence = parseWorkerEvidence(step?.stdout);
        return evidence?.mode === 'domestic-relay-peer-plan'
          && evidence?.execution === 'planned'
          && evidence?.internalServicePeer?.privateKeyCopiedToDomestic === false;
      })
  },
  {
    name: 'domestic relay peer plan worker job passed',
    path: () => `/internal/v1/site-slots/worker-jobs/${encodeURIComponent(state.domesticRelayPeerWorkerJobId)}`,
    assert: (body) => body?.job?.status === 'passed'
      && body?.job?.currentReportId === state.domesticRelayPeerReportId
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
    path: '/internal/v1/admin/dashboard?limit=50',
    assert: (body) => body?.overview?.siteSlotPlans >= 2
      && body?.actionPolicy?.principal?.roles?.includes('mx-admin')
      && body?.actionPolicy?.warnings?.some((warning) => warning.includes('shadow-default-admin'))
      && body?.actionPolicy?.actions?.some((action) => action.actionId === 'site-slot.apply.confirm' && action.allowed === true)
      && body?.overview?.siteSlotRollbackExecutions >= 1
      && Array.isArray(body?.latestReleasePlans)
      && body.latestReleasePlans.some((plan) => plan.planId === state.releaseManagementPlanId)
      && Array.isArray(body?.siteSlotPipelines)
      && body.siteSlotPipelines.some((pipeline) => pipeline.siteId === smokeDomesticSiteId
        && Array.isArray(pipeline.actionHints))
      && (
        body?.nextActions?.includes('review-release-gates')
        || body?.nextActions?.includes('review-site-slot-recovery')
        || body?.nextActions?.includes('review-site-slot-gates')
        || body?.nextActions?.includes('watch-running-site-slot-workers')
      )
  },
  {
    name: 'admin site slot pipelines list',
    path: '/internal/v1/admin/site-slots/pipelines?limit=50',
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
        && !pipeline.summary.actionHints.some((action) => action?.actionId === 'site-slot.internal-service-peer.handoff')
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
      && body.domesticSlotPlan?.network?.qpTunnelCliMode === 'egress-on'
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
  },
  {
    name: 'domestic blocked plan with stale wg secret',
    path: '/internal/v1/site-slots/plans',
    method: 'POST',
    body: () => ({
      kind: 'domestic',
      siteId: smokeDomesticSiteId,
      host: smokeDomesticHost,
      sshUser: 'deploy',
      rootAccess: false,
      hasDocker: false,
      hasOutboundInternet: false,
      requestId: 'http-smoke-domestic-blocked-plan-no-internal-handoff'
    }),
    assert: (body) => {
      state.domesticBlockedPlanId = body?.plan?.planId;
      return typeof state.domesticBlockedPlanId === 'string'
        && body?.plan?.kind === 'domestic'
        && body?.plan?.status === 'blocked';
    }
  },
  {
    name: 'domestic blocked plan does not suggest internal service peer',
    path: () => `/internal/v1/admin/site-slots/pipelines/${encodeURIComponent(state.domesticBlockedPlanId)}?token=${encodeURIComponent(state.adminToken)}`,
    assert: (body) => {
      const hints = Array.isArray(body?.pipeline?.summary?.actionHints) ? body.pipeline.summary.actionHints : [];
      return body?.pipeline?.summary?.planId === state.domesticBlockedPlanId
        && !hints.some((action) => action?.actionId === 'site-slot.internal-service-peer.handoff')
        && hints.some((action) => action?.actionId === 'site-slot.preflight.create'
          && action?.allowed === false
          && String(action?.reason || '').includes('plan status is blocked'));
    }
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
      && (body?.readiness?.gates?.envGate?.status === 'blocked' || body?.readiness?.gates?.envGate?.status === 'passed')
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

function findWorkerActionHint(body, actionId, pathSuffix) {
  const hints = Array.isArray(body?.pipeline?.summary?.actionHints) ? body.pipeline.summary.actionHints : [];
  return hints.find((action) => action?.actionId === actionId
    && action?.allowed === true
    && typeof action?.path === 'string'
    && action.path.endsWith(pathSuffix)) ?? null;
}

function selectWorkerActionHintJobId(body) {
  const hints = Array.isArray(body?.pipeline?.summary?.actionHints) ? body.pipeline.summary.actionHints : [];
  const jobIds = Array.from(new Set(hints
    .map((action) => actionHintWorkerJobId(action))
    .filter((jobId) => typeof jobId === 'string' && jobId.length > 0)));
  return jobIds.find((jobId) => workerActionHintMatches(body, 'site-slot.worker-run.remote-ssh-gate', jobId, '/remote-ssh-gate')
    && workerActionHintMatches(body, 'site-slot.worker-run.remote-ssh-readonly-probe', jobId, '/remote-ssh-readonly-probe', ['confirmReadOnlyProbe'])
    && workerActionHintMatches(body, 'site-slot.worker-run.remote-ssh-execute', jobId, '/run-artifact-push-remote-ssh', ['confirmWorkerHandoff'])
    && workerActionHintMatches(body, 'site-slot.worker-run.artifact-push-remote-ssh-plan', jobId, '/run-artifact-push-remote-ssh-plan', ['confirmPlanOnly'])
    && workerActionHintMatches(body, 'site-slot.worker-run.artifact-push-dry-run', jobId, '/run-artifact-push-dry-run')) ?? null;
}

function workerActionHintMatches(body, actionId, jobId, pathSuffix, requiredConfirmFields = []) {
  const hints = Array.isArray(body?.pipeline?.summary?.actionHints) ? body.pipeline.summary.actionHints : [];
  const action = hints.find((item) => item?.actionId === actionId
    && item?.allowed === true
    && item?.path === `/internal/v1/site-slots/worker-jobs/${jobId}${pathSuffix}`) ?? null;
  return Boolean(action)
    && requiredConfirmFields.every((field) => Array.isArray(action.confirmFields) && action.confirmFields.includes(field));
}

function optionalWorkerActionHintMatches(body, actionId, jobId, pathSuffix, requiredConfirmFields = []) {
  const hints = Array.isArray(body?.pipeline?.summary?.actionHints) ? body.pipeline.summary.actionHints : [];
  const hasAction = hints.some((item) => item?.actionId === actionId);
  return !hasAction || workerActionHintMatches(body, actionId, jobId, pathSuffix, requiredConfirmFields);
}

function actionHintWorkerJobId(action) {
  if (!action?.path) return null;
  const match = action.path.match(/\/internal\/v1\/site-slots\/worker-jobs\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : null;
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

function safeSmokeId(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'oversea_smoke';
}

function safeAccessAccountPrefix(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'account';
}

function isRelayLeaseIp(value, prefix) {
  const parts = String(value || '').split('.');
  const prefixParts = String(prefix || '').split('.');
  return parts.length === 4
    && prefixParts.every((part, index) => parts[index] === part)
    && parts.slice(2).every((part) => /^\d+$/.test(part))
    && Number(parts[2]) >= 0
    && Number(parts[2]) <= 255
    && Number(parts[3]) >= 1
    && Number(parts[3]) <= 254;
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
