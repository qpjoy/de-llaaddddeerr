import * as THREE from './node_modules/three/build/three.module.js';

const SSH_READONLY_PROBE_FEATURE_KEY = 'site-slot.ssh-readonly-probe.execute';
const LOCAL_SERVER_BASE_URL = 'http://127.0.0.1:18090';
const MX_H2I_PRODUCT_ID = 'mx-h2i';
const APP_CENTER_PRODUCT_ID = 'appcenter';
const LAUNCHER_FOUNDATION_PRODUCT_ID = 'launcher';
const MX_INTERNAL_DNS_IP = '10.88.88.88';
const MX_DOMESTIC_RELAY_IP = '10.88.0.1';
const MX_LOCAL_EDGE_DNS = '127.0.0.1:2053';
const MX_DEFAULT_APP_DNS_ZONE = 'mxinfo-inc.cn';
const INTERNAL_PEER_STATUS_AUTO_REFRESH_MS = 30000;

function isLocalStaticAdminBaseUrl(value) {
  try {
    const url = new URL(value);
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
      && url.port === '18110';
  } catch {
    return false;
  }
}

function normalizeServerBaseValue(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return isLocalStaticAdminBaseUrl(raw) ? LOCAL_SERVER_BASE_URL : raw;
}

function defaultServerBaseUrl() {
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    const host = window.location.hostname;
    const port = window.location.port;
    const isLocalStaticAdmin = (host === '127.0.0.1' || host === 'localhost' || host === '::1')
      && port === '18110'
      && !window.location.pathname.startsWith('/admin');
    if (isLocalStaticAdmin) return LOCAL_SERVER_BASE_URL;
    return window.location.origin;
  }
  return LOCAL_SERVER_BASE_URL;
}

const api = window.mxLauncher || {
  getConfig: async () => ({
    serverBaseUrl: defaultServerBaseUrl(),
    productConfigs: { hdi: { defaultMode: 'visitor' } }
  }),
  saveConfig: async (input) => input,
  getProducts: async () => [{
    id: 'hdi',
    status: 'not-installed'
  }],
  getStatus: async () => ({
    connectionState: 'idle',
    service: { installed: false }
  }),
  launchProduct: async () => ({
    ok: false,
    error: 'MX privileged service is not installed yet.'
  }),
  openAdmin: async (serverBaseUrl) => {
    window.open(`${serverBaseUrl || defaultServerBaseUrl()}/admin/`, '_blank');
    return true;
  }
};

const defaultRelayEnrollmentDeviceId = `desktop-admin-${Date.now().toString(36)}`;
let internalPeerAutoRefreshTimer = null;

const state = {
  activeView: 'app-center',
  activeAppNode: MX_H2I_PRODUCT_ID,
  appNavCollapsed: false,
  appCenterApps: [],
  appCenterAppsError: null,
  appOnboardingTemplates: [],
  appOnboardingTemplatesError: null,
  launcherServiceVipSmokes: [],
  launcherServiceVipSmokesError: null,
  launcherServiceVipCidrSyncBusy: null,
  launcherServiceVipCidrSyncFeedback: null,
  launcherServiceVipSetupHint: null,
  appCatalogFilter: '',
  appCatalogModeFilter: 'all',
  appCatalogEditor: null,
  appCatalogBusy: false,
  appCatalogFeedback: null,
  sidebarCollapsed: false,
  inspectorCollapsed: false,
  adminNavCollapsed: {
    operations: false,
    internal: true,
    evidence: true
  },
  hoverAdminMenu: null,
  adminMenu: 'operations',
  adminSection: 'dashboard',
  adminSubsection: 'overview',
  deploymentKind: 'oversea',
  selectedSiteId: null,
  dashboard: null,
  selectedPlanId: null,
  currentActions: [],
  selectedAction: null,
  selectedActionBody: null,
  internalPeer: {
    busy: false,
    materializeBusy: false,
    statusBusy: false,
    applyBusy: false,
    hostRunnerEnsureBusy: false,
    syncBusy: false,
    directModeBusy: false,
    directEnabledOverride: null,
    feedback: null,
    result: null,
    runtimeStatus: null,
    applyResult: null,
    keySyncResult: null,
    lastStatusAttemptAt: 0
  },
  awxActionDraft: {
    providerId: '',
    token: '',
    timeoutSeconds: '',
    waitForCompletion: true
  },
  preferredActionFocus: null,
  domesticPeerDraft: {
    productId: MX_H2I_PRODUCT_ID,
    productSecondOctet: '89',
    leaseId: '',
    peerRole: 'guest',
    leaseIp: '',
    publicKey: ''
  },
  actionBusy: false,
  actionFeedback: null,
  setupRun: {
    active: false,
    status: 'idle',
    message: '',
    steps: []
  },
  currentPipeline: null,
  overseaOverview: null,
  overseaOverviewError: null,
  overseaEnsureBusy: false,
  overseaEnsureFeedback: null,
  overseaTerminalBusy: false,
  overseaTerminalCommand: '',
  overseaTerminalResult: null,
  siteDraft: null,
  mihomoReachability: null,
  mihomoReachabilitySiteId: null,
  mihomoReachabilityError: null,
  selectedTimelineEntryId: null,
  pendingEvidenceFocus: null,
  sshProfiles: [],
  selectedSshProfileId: null,
  sshProfileBusy: false,
  sshHostKeyBusy: false,
  sshBootstrapBusy: false,
  sshPlanBusy: false,
  sshShadowBusy: false,
  sshReadinessBusy: false,
  sshPolicyBusy: false,
  sshProfileBootstrap: null,
  sshProfileShadowSetup: null,
  sshProfileReadiness: null,
  sshRuntimePolicy: null,
  sshProfileFeedback: null,
  userCenter: {
    users: [],
    roles: [],
    overseaEntitlements: [],
    filter: {
      search: '',
      roleId: 'all',
      status: 'all'
    },
    openDropdown: null,
    drawer: null,
    defaultOverseaOnCreate: true,
    importBusy: false,
    importFeedback: null,
    selectedOverseaUserId: null,
    overseaFeedback: null,
    overseaBusy: false,
    overseaSyncBusy: false,
    feedback: null,
    busy: false
  },
  dnsCenter: {
    policies: [],
    policy: null,
    policyError: null,
    routes: [],
    routesError: null,
    filter: {
      search: '',
      status: 'all'
    },
    drawer: null,
    feedback: null,
    busy: false,
    zoneBusy: false,
    corednsBusy: false,
    corednsApplyBusy: false,
    gatewayBusy: false,
    gatewayApplyBusy: false,
    gatewayConfigBusy: false,
    gatewayRuntimeConfig: null,
    gatewayRuntimeError: null,
    gatewayBackend: 'k8s',
    evalBusy: false,
    zoneSnapshot: null,
    corednsResult: null,
    gatewayResult: null,
    evaluateDomain: 'gateway.internal.mx',
    evaluateResult: null
  },
  relayEnrollment: {
    result: null,
    feedback: null,
    busy: false,
    draft: {
      productId: MX_H2I_PRODUCT_ID,
      productSecondOctet: '89',
      mode: 'standalone',
      identityKind: 'anonymous',
      siteId: 'domestic-main',
      installId: defaultRelayEnrollmentDeviceId,
      deviceId: defaultRelayEnrollmentDeviceId,
      userId: '',
      deviceLabel: 'Desktop Admin',
      publicKey: ''
    }
  },
  domesticRuntime: {
    configs: [],
    selectedSiteId: 'domestic-main',
    feedback: null,
    busy: false,
    applyBusy: false,
    applyResult: null,
    error: null
  },
  awxProviders: [],
  selectedAwxProviderId: null,
  launcherProducts: [],
  launcherProductsError: null,
  launcherLeases: [],
  launcherLeasesError: null,
  awxRuntimePolicies: [],
  awxRuntimePolicyBusy: false,
  awxRuntimePolicyFeedback: null,
  awxProviderBusy: false,
  awxProviderCheckBusy: false,
  awxProviderCheck: null,
  awxProviderFeedback: null,
  topology: null
};

let setupMonitorToken = 0;

const overseaTerminalTemplates = {
  inspect: [
    'set -eu',
    '. /etc/os-release 2>/dev/null || true',
    'echo "mx-oversea-inspect"',
    'echo "os=${ID:-unknown} version=${VERSION_ID:-unknown}"',
    'uname -a',
    'id',
    'pwd',
    'df -h /',
    'if command -v docker >/dev/null 2>&1; then docker version --format "{{.Server.Version}}" 2>/dev/null || docker version; else echo "docker: missing"; fi',
    'if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then docker compose version; else echo "docker compose: missing"; fi'
  ].join('; '),
  installDocker: [
    'set -eu',
    'printf "mx-docker-bootstrap\\n"',
    '. /etc/os-release 2>/dev/null || true',
    'echo "os=${ID:-unknown} version=${VERSION_ID:-unknown}"',
    'if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then echo "docker: present"; else if command -v apt-get >/dev/null 2>&1; then export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y ca-certificates curl gnupg lsb-release; curl -fsSL https://get.docker.com | sh; elif command -v dnf >/dev/null 2>&1; then dnf install -y ca-certificates curl; curl -fsSL https://get.docker.com | sh; elif command -v yum >/dev/null 2>&1; then yum install -y ca-certificates curl; curl -fsSL https://get.docker.com | sh; elif command -v apk >/dev/null 2>&1; then apk add --no-cache docker docker-cli-compose; elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install docker docker-compose || curl -fsSL https://get.docker.com | sh; else curl -fsSL https://get.docker.com | sh; fi; fi',
    'if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker || true; elif command -v service >/dev/null 2>&1; then service docker start || true; elif command -v rc-update >/dev/null 2>&1; then rc-update add docker default || true; service docker start || true; fi',
    'docker version',
    'docker compose version || docker-compose version'
  ].join('; '),
  stackStatus: [
    'set -u',
    'echo "mx-oversea-docker-hysteria2-status"',
    'cd /opt/mx/current/hysteria2-access-stack 2>/dev/null || cd /opt/mx/releases/oversea-access-stack 2>/dev/null || { echo "access stack missing; run Install / Sync before Stack Status"; exit 0; }',
    'if grep -q "docker-status" ./manage.sh; then ./manage.sh docker-status --soft || true; else echo "legacy access stack artifact; run Install / Sync before Stack Status"; ./manage.sh status || true; fi'
  ].join('; ')
};

const adminMenuMeta = {
  operations: {
    heading: 'I-HDO',
    kicker: 'Operations',
    title: 'H/D/I/O',
    defaultSection: 'dashboard',
    defaultSubsection: 'overview'
  },
  internal: {
    heading: 'Internal 基础系统',
    kicker: 'Internal',
    title: 'Truth / control plane',
    defaultSection: 'foundations',
    defaultSubsection: 'overview'
  },
  evidence: {
    heading: 'Evidence History',
    kicker: 'Evidence',
    title: 'Trace / log / gate',
    defaultSection: 'evidence',
    defaultSubsection: 'overview'
  }
};

const internalSubsectionMeta = {
  overview: {
    title: 'Internal 基础系统',
    subtitle: 'User Center、RBAC、Config、DNS、Release、E2E Gate、Observability、Admin、Runner、SDK Gateway 都在 Internal 控制面内规划。'
  },
  'user-center': {
    title: 'User Center',
    subtitle: '用户、服务账号、设备身份和初始 Internal01-09 账号都归 Internal 管理。'
  },
  rbac: {
    title: 'RBAC',
    subtitle: '角色、权限、审批确认和 Action Gate 边界在这里收敛，避免 Domestic / Oversea 持有权限真相。'
  },
  'config-center': {
    title: 'Config Center',
    subtitle: 'SSH Profile、runtime policy、订阅 authority、snapshot 和站点配置都从 Internal 下发。'
  },
  'awx-provider': {
    title: 'AWX Provider',
    subtitle: 'AWX 是可选外部执行 Provider；Oversea 默认走 Internal Remote SSH，AWX 配置只在需要对接现有 AWX 时启用。'
  },
  dns: {
    title: 'DNS',
    subtitle: 'Internal CoreDNS authority 管理 split DNS；Domestic 只保留可选 edge cache。'
  },
  mihomo: {
    title: 'Mihomo Authority',
    subtitle: 'Internal 生成 Oversea hysteria2 / mihomo 订阅，Launcher Network 只消费配置快照。'
  },
  release: {
    title: 'Release Center',
    subtitle: '统一 artifact、版本、release notes、灰度、回滚和 Launcher / AppCenter 更新策略。'
  },
  'e2e-gate': {
    title: 'E2E Gate',
    subtitle: 'synthetic probe、runner output、截图和配置快照进入发布门禁。'
  },
  observability: {
    title: 'Observability',
    subtitle: 'H / D / I / O 链路的 trace、log、metric、evidence 都汇总到 Internal。'
  },
  'admin-runner': {
    title: 'Admin / Runner',
    subtitle: '三维拓扑、Action Gates、审批、worker job、rollback 和日志证据共用同一动作模型。'
  },
  'sdk-gateway': {
    title: 'SDK Gateway',
    subtitle: 'Launcher、AppCenter 应用和其他系统通过稳定 SDK 契约进入 Internal 能力。'
  }
};

const evidenceSubsectionMeta = {
  overview: {
    title: 'Evidence History',
    subtitle: '全部 plan、runner、worker、report、rollback 和 gate evidence 汇总在这里。'
  },
  executions: {
    title: 'Execution Evidence',
    subtitle: 'preflight、apply、rollback execution 的状态、确认和门禁结果。'
  },
  'runner-sessions': {
    title: 'Runner Sessions',
    subtitle: 'remote SSH / AWX runner session、命令上下文和边界声明。'
  },
  'worker-jobs': {
    title: 'Worker Jobs',
    subtitle: 'worker job handoff、queue、Action Gate 和后续动作提示。'
  },
  'worker-reports': {
    title: 'Worker Reports',
    subtitle: 'artifact push dry run、stdout / stderr、step reports 和报告状态。'
  },
  rollback: {
    title: 'Rollback Evidence',
    subtitle: '回滚执行、回滚报告和失败恢复链路证据。'
  },
  'audit-log': {
    title: 'Audit / Logs',
    subtitle: '审计、日志和操作历史先归档在 Evidence History，后续拆成独立查询。'
  },
  'release-gate': {
    title: 'Release Gate Evidence',
    subtitle: 'Release Center、E2E Gate、synthetic probe 和发布门禁证据。'
  }
};

const sidebar = document.getElementById('sidebar');
const sidebarCollapse = document.getElementById('sidebar-collapse');
const stateChip = document.getElementById('connection-state');
const appNavToggle = document.getElementById('app-nav-toggle');
const appNavTree = document.getElementById('app-nav-tree');
const appCenterHeading = document.getElementById('app-center-heading');
const appCenterSubtitle = document.getElementById('app-center-subtitle');
const appProductsPanel = document.getElementById('app-products-panel');
const appSelectedDetail = document.getElementById('app-selected-detail');
const h2oLaunch = document.getElementById('h2o-launch');
const h2oAdmin = document.getElementById('h2o-admin');
const h2oStatus = document.getElementById('h2o-status');
const h2oNetwork = document.getElementById('h2o-network');
const launcherFoundationOverview = document.getElementById('launcher-foundation-overview');
const serverInput = document.getElementById('server-input');
const platformStatus = document.getElementById('platform-status');
const appRefresh = document.getElementById('app-refresh');
const adminRefresh = document.getElementById('admin-refresh');
const adminHeading = document.getElementById('admin-heading');
const adminGenerated = document.getElementById('admin-generated');
const pipelineList = document.getElementById('pipeline-list');
const pipelineCount = document.getElementById('pipeline-count');
const pipelineTimeline = document.getElementById('pipeline-timeline');
const pipelineSummary = document.getElementById('pipeline-summary');
const pipelineStepper = document.getElementById('pipeline-stepper');
const pipelineActions = document.getElementById('pipeline-actions');
const pipelineHealth = document.getElementById('pipeline-health');
const adminModuleTabs = Array.from(document.querySelectorAll('.admin-module-tab'));
const adminSections = Array.from(document.querySelectorAll('.admin-section'));
const adminSubnav = document.getElementById('admin-subnav');
const adminSubnavKicker = document.getElementById('admin-subnav-kicker');
const adminSubnavTitle = document.getElementById('admin-subnav-title');
const adminSubnavItems = document.getElementById('admin-subnav-items');
const deploymentTitle = document.getElementById('deployment-title');
const deploymentSubtitle = document.getElementById('deployment-subtitle');
const deploymentSiteCount = document.getElementById('deployment-site-count');
const setupGuide = document.getElementById('setup-guide');
const dashboardGuidance = document.getElementById('dashboard-guidance');
const siteWorkbench = document.getElementById('site-workbench');
const foundationHeading = document.getElementById('foundation-heading');
const foundationSubtitle = document.getElementById('foundation-subtitle');
const foundationGrid = document.getElementById('foundation-grid');
const evidenceHeading = document.getElementById('evidence-heading');
const evidenceSubtitle = document.getElementById('evidence-subtitle');
const evidenceHistory = document.getElementById('evidence-history');
const adminConsole = document.getElementById('admin-console');
const adminInspector = document.getElementById('admin-inspector');
const inspectorToggle = document.getElementById('inspector-toggle');
const inspectorKind = document.getElementById('inspector-kind');
const inspectorTitle = document.getElementById('inspector-title');
const inspectorMeta = document.getElementById('inspector-meta');
const inspectorStatus = document.getElementById('inspector-status');
const inspectorFacts = document.getElementById('inspector-facts');
const inspectorNext = document.getElementById('inspector-next');
const inspectorEvidence = document.getElementById('inspector-evidence');
const consoleInternalState = document.getElementById('console-internal-state');
const consoleStoreDriver = document.getElementById('console-store-driver');
const consoleExecutionProvider = document.getElementById('console-execution-provider');
const consoleGateState = document.getElementById('console-gate-state');
const consoleEvidenceCount = document.getElementById('console-evidence-count');
const consoleOsScope = document.getElementById('console-os-scope');
const consolePrincipal = document.getElementById('console-principal');
const consolePrincipalScope = document.getElementById('console-principal-scope');
const metricSiteSlots = document.getElementById('metric-site-slots');
const metricRollbacks = document.getElementById('metric-rollbacks');
const metricReleases = document.getElementById('metric-releases');
const metricTests = document.getElementById('metric-tests');
const sshProfileCount = document.getElementById('ssh-profile-count');
const sshProfilePanel = document.querySelector('.ssh-profile-panel');
const sshProfileForm = document.getElementById('ssh-profile-form');
const sshProfileId = document.getElementById('ssh-profile-id');
const sshProfileSiteId = document.getElementById('ssh-profile-site-id');
const sshProfileKind = document.getElementById('ssh-profile-kind');
const sshProfileHost = document.getElementById('ssh-profile-host');
const sshProfileUser = document.getElementById('ssh-profile-user');
const sshProfilePassword = document.getElementById('ssh-profile-password');
const sshProfileRotateKey = document.getElementById('ssh-profile-rotate-key');
const sshProfilePort = document.getElementById('ssh-profile-port');
const sshProfileHy2Ports = document.getElementById('ssh-profile-hy2-ports');
const sshProfileHealthPort = document.getElementById('ssh-profile-health-port');
const sshProfileWorkerInternalUrl = document.getElementById('ssh-profile-worker-internal-url');
const sshProfileOverseaCallbackUrl = document.getElementById('ssh-profile-oversea-callback-url');
const sshProfileStrict = document.getElementById('ssh-profile-strict');
const sshProfileBatchMode = document.getElementById('ssh-profile-batch-mode');
const sshProfileTimeout = document.getElementById('ssh-profile-timeout');
const sshProfileIdentity = document.getElementById('ssh-profile-identity');
const sshProfileKnownHosts = document.getElementById('ssh-profile-known-hosts');
const sshProfileConfigFile = document.getElementById('ssh-profile-config-file');
const sshProfileHostKeyAlias = document.getElementById('ssh-profile-host-key-alias');
const sshProfileSave = document.getElementById('ssh-profile-save');
const sshProfileRefreshHostKey = document.getElementById('ssh-profile-refresh-host-key');
const sshProfileBootstrap = document.getElementById('ssh-profile-bootstrap');
const sshProfileCreatePlan = document.getElementById('ssh-profile-create-plan');
const sshProfileShadowSetup = document.getElementById('ssh-profile-shadow-setup');
const sshProfileFeedback = document.getElementById('ssh-profile-feedback');
const sshProfileBootstrapResult = document.getElementById('ssh-profile-bootstrap-result');
const sshProfileShadowResult = document.getElementById('ssh-profile-shadow-result');
const sshProfileList = document.getElementById('ssh-profile-list');
const sshReadinessStatus = document.getElementById('ssh-readiness-status');
const sshProfileReadinessRun = document.getElementById('ssh-profile-readiness-run');
const sshProfileReadinessExecute = document.getElementById('ssh-profile-readiness-execute');
const sshProfilePolicyEnable = document.getElementById('ssh-profile-policy-enable');
const sshProfileReadiness = document.getElementById('ssh-profile-readiness');
const awxProviderCount = document.getElementById('awx-provider-count');
const awxProviderPanel = document.querySelector('.awx-provider-panel');
const awxProviderForm = document.getElementById('awx-provider-form');
const awxProviderId = document.getElementById('awx-provider-id');
const awxProviderName = document.getElementById('awx-provider-name');
const awxProviderStatus = document.getElementById('awx-provider-status');
const awxProviderKind = document.getElementById('awx-provider-kind');
const awxProviderBaseUrl = document.getElementById('awx-provider-base-url');
const awxProviderOrganization = document.getElementById('awx-provider-organization');
const awxProviderProject = document.getElementById('awx-provider-project');
const awxProviderInventoryPrefix = document.getElementById('awx-provider-inventory-prefix');
const awxProviderCredentialPrefix = document.getElementById('awx-provider-credential-prefix');
const awxProviderTemplatePrefix = document.getElementById('awx-provider-template-prefix');
const awxProviderVerifyTls = document.getElementById('awx-provider-verify-tls');
const awxProviderTimeout = document.getElementById('awx-provider-timeout');
const awxProviderToken = document.getElementById('awx-provider-token');
const awxProviderSave = document.getElementById('awx-provider-save');
const awxProviderCheckRun = document.getElementById('awx-provider-check-run');
const awxProviderFeedback = document.getElementById('awx-provider-feedback');
const awxProviderCheck = document.getElementById('awx-provider-check');
const awxRuntimeGates = document.getElementById('awx-runtime-gates');
const awxProviderList = document.getElementById('awx-provider-list');
const topologyCanvas = document.getElementById('topology-canvas');
const appEditorBackdrop = document.getElementById('app-editor-backdrop');
const appEditorDrawer = document.getElementById('app-editor-drawer');
const userEditorBackdrop = document.getElementById('user-editor-backdrop');
const userEditorDrawer = document.getElementById('user-editor-drawer');
const evidenceBackdrop = document.getElementById('evidence-backdrop');
const evidenceDrawer = document.getElementById('evidence-drawer');
const evidenceClose = document.getElementById('evidence-close');
const evidenceKind = document.getElementById('evidence-kind');
const evidenceTitle = document.getElementById('evidence-title');
const evidenceMeta = document.getElementById('evidence-meta');
const evidenceSummary = document.getElementById('evidence-summary');
const evidenceSteps = document.getElementById('evidence-steps');
const evidenceJson = document.getElementById('evidence-json');

let tabs = Array.from(document.querySelectorAll('.nav-tab'));
const views = Array.from(document.querySelectorAll('.view'));
const navGroups = Array.from(document.querySelectorAll('.nav-group'));
const boundNavTabs = new WeakSet();

function handlePrimaryNavTabClick(tab) {
  state.hoverAdminMenu = null;
  if (tab.dataset.view === 'admin') {
    const menuName = adminMenuFromElement(tab);
    const sameActiveMenu = state.activeView === 'admin' && state.adminMenu === menuName;
    if (!state.sidebarCollapsed && sameActiveMenu) {
      state.adminNavCollapsed[menuName] = !adminNavIsCollapsed(menuName);
      renderAdminShell();
      return;
    }
    state.adminNavCollapsed[menuName] = false;
    setActiveView(tab.dataset.view, adminNavFromElement(tab), { appNode: tab.dataset.appNode });
    return;
  }
  setActiveView(tab.dataset.view, adminNavFromElement(tab), { appNode: tab.dataset.appNode });
}

function bindPrimaryNavTab(tab) {
  if (!tab || boundNavTabs.has(tab)) return;
  boundNavTabs.add(tab);
  tab.addEventListener('click', () => {
    handlePrimaryNavTabClick(tab);
  });
  tab.addEventListener('mouseenter', () => {
    previewCollapsedAdminSubnav(tab);
  });
  tab.addEventListener('focus', () => {
    previewCollapsedAdminSubnav(tab);
  });
}

function refreshNavTabs() {
  tabs = Array.from(document.querySelectorAll('.nav-tab'));
  for (const tab of tabs) bindPrimaryNavTab(tab);
}

refreshNavTabs();
void boot();

if (h2oLaunch) {
  h2oLaunch.addEventListener('click', () => {
    void launchHdiProduct();
  });
}

if (h2oAdmin) {
  h2oAdmin.addEventListener('click', () => {
    void api.openAdmin(serverInput.value);
  });
}

if (appNavToggle) {
  appNavToggle.addEventListener('click', () => {
    state.appNavCollapsed = !state.appNavCollapsed;
    renderAppNav();
  });
}

serverInput.addEventListener('change', () => {
  void persistConfig();
});

appRefresh.addEventListener('click', () => {
  void refreshProducts();
});

adminRefresh.addEventListener('click', () => {
  void refreshAdmin();
});

sidebarCollapse.addEventListener('click', () => {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  state.hoverAdminMenu = null;
  if (!state.sidebarCollapsed && state.activeView === 'admin') {
    state.adminNavCollapsed[state.adminMenu] = false;
  }
  sidebar.classList.toggle('is-collapsed', state.sidebarCollapsed);
  sidebar.classList.toggle('is-subnav-open', state.sidebarCollapsed && state.activeView === 'admin');
  sidebarCollapse.setAttribute('aria-expanded', state.sidebarCollapsed ? 'false' : 'true');
  sidebarCollapse.textContent = state.sidebarCollapsed ? '展开 →' : '收起 ←';
  renderAppNav();
  renderAdminSubnav();
  requestAnimationFrame(() => resizeTopology());
});

if (inspectorToggle) {
  inspectorToggle.addEventListener('click', () => {
    state.inspectorCollapsed = !state.inspectorCollapsed;
    renderInspectorChrome();
    requestAnimationFrame(() => resizeTopology());
  });
}

sidebar.addEventListener('mouseleave', () => {
  if (!state.sidebarCollapsed) return;
  state.hoverAdminMenu = null;
  sidebar.classList.toggle('is-subnav-open', state.activeView === 'admin');
  renderAdminSubnav();
});

for (const tab of adminModuleTabs) {
  tab.addEventListener('click', (event) => {
    event.stopPropagation();
    handleAdminModuleNavigation(tab);
  });
}

if (adminSubnavItems) {
  adminSubnavItems.addEventListener('click', (event) => {
    const tab = event.target.closest?.('.admin-module-tab');
    if (!tab) return;
    handleAdminModuleNavigation(tab);
  });
}

document.addEventListener('click', (event) => {
  const tab = event.target.closest?.('.admin-module-tab');
  if (!tab) return;
  event.stopPropagation();
  handleAdminModuleNavigation(tab);
}, true);

function handleAdminModuleNavigation(tab) {
  applyAdminNavigation(adminNavFromElement(tab), { stopSetupMessage: 'Stopped because the operator changed sections.' });
  state.adminNavCollapsed[state.adminMenu] = false;
  state.hoverAdminMenu = null;
  renderAdminShell();
  if (state.dashboard && state.adminSection === 'deployment') {
    const active = activePipelineForCurrentDeployment(state.dashboard.siteSlotPipelines || []);
    state.selectedPlanId = active?.planId || null;
    state.selectedSiteId = active?.siteId || state.selectedSiteId;
    renderAdminDashboard(state.dashboard);
    if (state.selectedPlanId) void refreshPipelineDetail(state.selectedPlanId);
  } else if (state.dashboard) {
    renderAdminDashboard(state.dashboard);
  }
}

sshProfileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveSshProfile();
});

sshProfileCreatePlan.addEventListener('click', () => {
  void createPlanFromSshProfile();
});

sshProfileShadowSetup.addEventListener('click', () => {
  void runOverseaShadowSetupFromSshProfile();
});

sshProfileBootstrap.addEventListener('click', () => {
  void bootstrapSshProfile();
});

sshProfileRefreshHostKey.addEventListener('click', () => {
  void refreshSshHostKey();
});

sshProfileReadinessRun.addEventListener('click', () => {
  void checkSshProfileReadiness(false);
});

sshProfileReadinessExecute.addEventListener('click', () => {
  void checkSshProfileReadiness(true);
});

sshProfilePolicyEnable.addEventListener('click', () => {
  void allowSshProfileReadonlyPolicy();
});

awxProviderForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveAwxProvider();
});

awxProviderCheckRun.addEventListener('click', () => {
  void checkAwxProviderFromForm();
});

for (const control of [
  sshProfileSiteId,
  sshProfileKind,
  sshProfileHost,
  sshProfileUser,
  sshProfilePassword,
  sshProfileRotateKey,
  sshProfilePort,
  sshProfileHy2Ports,
  sshProfileHealthPort,
  sshProfileWorkerInternalUrl,
  sshProfileOverseaCallbackUrl,
  sshProfileStrict,
  sshProfileBatchMode,
  sshProfileTimeout,
  sshProfileIdentity,
  sshProfileKnownHosts,
  sshProfileConfigFile,
  sshProfileHostKeyAlias
]) {
  control.addEventListener('input', () => {
    renderSshProfileSaveState();
  });
  control.addEventListener('change', () => {
    renderSshProfileSaveState();
  });
}

evidenceClose.addEventListener('click', () => {
  closeEvidenceDrawer();
});

evidenceBackdrop.addEventListener('click', () => {
  closeEvidenceDrawer();
});

if (appEditorBackdrop) {
  appEditorBackdrop.addEventListener('click', () => {
    if (state.dnsCenter.drawer) {
      closeDnsRouteEditorDrawer();
      return;
    }
    closeAppCatalogEditor();
  });
}

if (userEditorBackdrop) {
  userEditorBackdrop.addEventListener('click', () => closeUserEditorDrawer());
}

document.addEventListener('click', (event) => {
  if (!state.userCenter.openDropdown) return;
  if (event.target?.closest?.('[data-user-dropdown-root]')) return;
  closeUserCenterDropdown();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.userCenter.openDropdown) {
    event.preventDefault();
    closeUserCenterDropdown();
    return;
  }
  if (event.key === 'Escape' && userEditorDrawer && !userEditorDrawer.hidden) {
    closeUserEditorDrawer();
    return;
  }
  if (event.key === 'Escape' && appEditorDrawer && !appEditorDrawer.hidden) {
    if (state.dnsCenter.drawer) {
      closeDnsRouteEditorDrawer();
    } else {
      closeAppCatalogEditor();
    }
    return;
  }
  if (event.key === 'Escape' && !evidenceDrawer.hidden) {
    closeEvidenceDrawer();
  }
});

async function boot() {
  serverInput.value = normalizeServerBaseValue(serverInput.value || defaultServerBaseUrl());
  const config = await api.getConfig();
  serverInput.value = normalizeServerBaseValue(config.serverBaseUrl || serverInput.value || defaultServerBaseUrl());
  initTopologyScene();
  await refreshProducts();
  const status = await api.getStatus();
  renderStatus(status);
}

function adminNavFromElement(element) {
  return {
    menu: element.dataset.adminMenu,
    section: element.dataset.adminSection,
    subsection: element.dataset.adminSubsection,
    deploymentKind: element.dataset.deploymentKind
  };
}

function adminMenuFromElement(element) {
  return element?.dataset?.adminMenu || 'operations';
}

function adminNavIsCollapsed(menuName) {
  return state.adminNavCollapsed?.[menuName] === true;
}

function previewCollapsedAdminSubnav(tab) {
  if (!state.sidebarCollapsed || tab.dataset.view !== 'admin') return;
  state.hoverAdminMenu = adminMenuFromElement(tab);
  sidebar.classList.add('is-subnav-open');
  renderAdminSubnav();
}

function setActiveView(view, nav = {}, options = {}) {
  if (view !== 'admin' && state.setupRun.active) {
    clearSetupRun('Stopped because the operator left I-HDO.', 'stopped');
  }
  if (view === 'admin') {
    applyAdminNavigation(nav);
    state.adminNavCollapsed[state.adminMenu] = false;
  }
  state.activeView = view === 'admin' ? 'admin' : 'app-center';
  if (state.activeView === 'app-center') {
    state.activeAppNode = options.appNode || state.activeAppNode || 'appcenter';
  }
  if (state.activeView !== 'admin') {
    state.hoverAdminMenu = null;
    sidebar.classList.remove('is-subnav-open');
  } else {
    sidebar.classList.toggle('is-subnav-open', state.sidebarCollapsed);
  }
  for (const tab of tabs) {
    const active = state.activeView === 'app-center'
      ? tab.dataset.view === 'app-center' && (tab.dataset.appNode || APP_CENTER_PRODUCT_ID) === state.activeAppNode
      : tab.dataset.view === 'admin' && adminMenuFromElement(tab) === state.adminMenu;
    tab.classList.toggle('is-active', active);
  }
  for (const item of views) {
    item.classList.toggle('is-active', item.id === `view-${state.activeView}`);
  }
  renderAppNav();
  if (state.activeView === 'app-center') {
    renderAppCenterShell();
  }
  renderAdminShell();
  if (state.activeView === 'admin' && !state.dashboard) {
    void refreshAdmin();
  }
  if (state.activeView === 'admin' && state.dashboard) {
    renderAdminDashboard(state.dashboard);
  }
  if (state.activeView === 'admin') {
    requestAnimationFrame(() => resizeTopology());
  }
}

function applyAdminNavigation(nav = {}, options = {}) {
  const menu = adminMenuMeta[nav.menu] ? nav.menu : state.adminMenu;
  const meta = adminMenuMeta[menu] || adminMenuMeta.operations;
  const previousSection = state.adminSection;
  const previousKind = state.deploymentKind;
  state.adminMenu = menu;
  state.adminSection = nav.section || meta.defaultSection;
  state.adminSubsection = nav.subsection || meta.defaultSubsection;
  if (nav.deploymentKind) {
    state.deploymentKind = ['domestic', 'oversea', 'internal'].includes(nav.deploymentKind) ? nav.deploymentKind : 'oversea';
  }
  const changedDeployment = previousKind !== state.deploymentKind;
  const changedSection = previousSection !== state.adminSection;
  if ((changedDeployment || changedSection) && state.setupRun.active) {
    clearSetupRun(options.stopSetupMessage || 'Stopped because the operator changed sections.', 'stopped');
  }
  if (changedDeployment) {
    state.selectedSiteId = null;
    state.selectedPlanId = null;
    state.selectedSshProfileId = null;
    state.selectedAction = null;
    state.actionFeedback = null;
    state.sshProfileBootstrap = null;
    state.sshProfileShadowSetup = null;
    state.sshProfileReadiness = null;
    state.sshRuntimePolicy = null;
    closeEvidenceDrawer();
  }
}

async function refreshProducts() {
  const products = await api.getProducts();
  const hdi = products.find((product) => product.id === 'hdi');
  if (h2oStatus) h2oStatus.textContent = hdi && hdi.status === 'installed' ? 'Installed' : 'Not installed';
  await refreshAppCenterNetwork();
}

async function refreshAppCenterNetwork() {
  const [appPayload, productPayload, leasePayload, dnsRoutesPayload, templatesPayload, serviceVipSmokePayload] = await Promise.all([
    loadAppCenterApps(),
    loadLauncherProductNetworks(),
    loadLauncherNetworkLeases(),
    loadDnsReverseProxyRoutes(),
    loadAppOnboardingTemplates(),
    loadLauncherServiceVipSmokes()
  ]);
  state.appCenterApps = asArray(appPayload.apps);
  state.appCenterAppsError = appPayload.error || null;
  state.appOnboardingTemplates = asArray(templatesPayload.templates);
  state.appOnboardingTemplatesError = templatesPayload.error || null;
  state.launcherServiceVipSmokes = asArray(serviceVipSmokePayload.smokes);
  state.launcherServiceVipSmokesError = serviceVipSmokePayload.error || null;
  state.launcherProducts = asArray(productPayload.products);
  state.launcherProductsError = productPayload.error || null;
  state.launcherLeases = asArray(leasePayload.leases);
  state.launcherLeasesError = leasePayload.error || null;
  state.dnsCenter.routes = asArray(dnsRoutesPayload.routes);
  state.dnsCenter.routesError = dnsRoutesPayload.error || null;
  renderLauncherFoundationOverview();
  renderAppCenterShell();
}

async function persistConfig() {
  const current = await api.getConfig();
  await api.saveConfig({
    serverBaseUrl: serverInput.value,
    productConfigs: current.productConfigs || {}
  });
}

async function launchHdiProduct() {
  await persistConfig();
  stateChip.textContent = 'Starting';
  stateChip.dataset.state = 'connecting';
  const result = await api.launchProduct({
    productId: 'hdi',
    serverBaseUrl: serverInput.value
  });
  if (!result.ok) {
    stateChip.textContent = 'Missing service';
    stateChip.dataset.state = 'error';
    platformStatus.textContent = result.error || 'Service required';
  }
}

async function refreshAdmin() {
  await persistConfig();
  renderAdminLoading();
  try {
    const [
      dashboard,
      profilePayload,
      overseaPayload,
      userCenterPayload,
      appCenterAppsPayload,
      appOnboardingTemplatesPayload,
      launcherProductsPayload,
      launcherLeasesPayload,
      domesticRuntimePayload,
      dnsPolicyPayload,
      dnsRoutesPayload,
      gatewayRuntimePayload
    ] = await Promise.all([
      fetchJson('/internal/v1/admin/dashboard'),
      loadSshProfiles(),
      loadOverseaOverview(),
      loadUserCenterOverview(),
      loadAppCenterApps(),
      loadAppOnboardingTemplates(),
      loadLauncherProductNetworks(),
      loadLauncherNetworkLeases(),
      loadDomesticRuntimeConfigs(),
      loadDnsPolicyCenter(),
      loadDnsReverseProxyRoutes(),
      loadGatewayRuntimeConfig()
    ]);
    state.dashboard = dashboard;
    state.sshProfiles = asArray(profilePayload.profiles);
    state.userCenter.users = asArray(userCenterPayload.users);
    state.userCenter.roles = asArray(userCenterPayload.roles);
    state.userCenter.overseaEntitlements = asArray(userCenterPayload.overseaEntitlements);
    if (userCenterPayload.error) {
      state.userCenter.feedback = { kind: 'error', message: userCenterPayload.error };
    }
    state.awxProviders = asArray(dashboard.awxProviders);
    state.appCenterApps = asArray(appCenterAppsPayload.apps);
    state.appCenterAppsError = appCenterAppsPayload.error || null;
    state.appOnboardingTemplates = asArray(appOnboardingTemplatesPayload.templates);
    state.appOnboardingTemplatesError = appOnboardingTemplatesPayload.error || null;
    state.launcherServiceVipSmokes = asArray(dashboard.launcherServiceVipSmokes);
    state.launcherServiceVipSmokesError = null;
    state.launcherProducts = asArray(launcherProductsPayload.products);
    state.launcherProductsError = launcherProductsPayload.error || null;
    state.launcherLeases = asArray(launcherLeasesPayload.leases);
    state.launcherLeasesError = launcherLeasesPayload.error || null;
    state.domesticRuntime.configs = asArray(domesticRuntimePayload.configs);
    state.domesticRuntime.error = domesticRuntimePayload.error || null;
    state.dnsCenter.policy = dnsPolicyPayload.policy || null;
    state.dnsCenter.policies = asArray(dnsPolicyPayload.policies);
    state.dnsCenter.policyError = dnsPolicyPayload.error || null;
    state.dnsCenter.routes = asArray(dnsRoutesPayload.routes);
    state.dnsCenter.routesError = dnsRoutesPayload.error || null;
    applyGatewayRuntimeConfig(gatewayRuntimePayload.config);
    state.dnsCenter.gatewayRuntimeError = gatewayRuntimePayload.error || null;
    renderAppCenterShell();
    state.awxRuntimePolicies = asArray(dashboard.runtimeFeaturePolicies);
    state.overseaOverview = overseaPayload.overview;
    state.overseaOverviewError = overseaPayload.error;
    const pipelines = dashboard.siteSlotPipelines || [];
    const overviewSelectedSiteId = selectedSiteFromOverseaOverview();
    if (state.deploymentKind === 'oversea' && overviewSelectedSiteId) {
      state.selectedSiteId = overviewSelectedSiteId;
      const siteActive = activePipelineForSite(pipelines, 'oversea', overviewSelectedSiteId);
      state.selectedPlanId = siteActive?.planId || null;
    } else {
      const active = selectedOrActivePipelineForCurrentDeployment(pipelines);
      state.selectedPlanId = active?.planId || null;
      state.selectedSiteId = active?.siteId || state.selectedSiteId;
    }
    primeSshProfileForm(pipelines);
    primeAwxProviderForm(state.awxProviders);
    renderAdminDashboard(dashboard);
    if (state.adminSection === 'deployment' && state.selectedPlanId) {
      await refreshPipelineDetail(state.selectedPlanId);
    } else {
      renderEmptyPipeline();
    }
    setConnection('connected', 'Connected', `${dashboard.overview.siteId} / ${dashboard.overview.storeDriver}`);
  } catch (error) {
    if (state.setupRun.active) {
      clearSetupRun(`Admin API unavailable: ${error.message}`, 'failed');
    }
    state.dashboard = null;
    state.overseaOverview = null;
    state.appCenterApps = [];
    state.appCenterAppsError = error.message;
    state.launcherProducts = [];
    state.launcherProductsError = error.message;
    state.launcherLeases = [];
    state.launcherLeasesError = error.message;
    state.domesticRuntime.configs = [];
    state.domesticRuntime.error = error.message;
    state.dnsCenter.policy = null;
    state.dnsCenter.policies = [];
    state.dnsCenter.policyError = error.message;
    state.dnsCenter.routes = [];
    state.dnsCenter.routesError = error.message;
    renderAppCenterShell();
    state.overseaOverviewError = error.message;
    renderAdminError(error);
    setConnection('error', 'Offline', 'Admin API unavailable');
  }
}

async function loadOverseaOverview() {
  try {
    const overview = await fetchJson('/internal/v1/admin/oversea');
    return { overview, error: null };
  } catch (error) {
    return { overview: null, error: error.message };
  }
}

async function loadLauncherProductNetworks() {
  try {
    const payload = await fetchJson('/internal/v1/launcher-network/products');
    return { products: asArray(payload.products), error: null };
  } catch (error) {
    return { products: [], error: error.message };
  }
}

async function loadLauncherNetworkLeases() {
  try {
    const payload = await fetchJson('/internal/v1/launcher-network/leases');
    return { leases: asArray(payload.leases), error: null };
  } catch (error) {
    return { leases: [], error: error.message };
  }
}

async function loadDomesticRuntimeConfigs() {
  try {
    const payload = await fetchJson('/internal/v1/config-center/domestic-runtime-configs');
    return { configs: asArray(payload.configs), error: null };
  } catch (error) {
    return { configs: [], error: error.message };
  }
}

async function loadDnsPolicyCenter() {
  try {
    const [effectivePayload, policiesPayload] = await Promise.all([
      fetchJson('/internal/v1/dns/policies/effective'),
      fetchJson('/internal/v1/dns/policies')
    ]);
    return {
      policy: effectivePayload.policy || null,
      policies: asArray(policiesPayload.policies),
      error: null
    };
  } catch (error) {
    return { policy: null, policies: [], error: error.message };
  }
}

async function loadDnsReverseProxyRoutes() {
  try {
    const payload = await fetchJson('/internal/v1/dns/reverse-proxy/routes');
    return { routes: asArray(payload.routes), error: null };
  } catch (error) {
    return { routes: [], error: error.message };
  }
}

async function loadGatewayRuntimeConfig() {
  try {
    const payload = await fetchJson('/internal/v1/config-center/gateway-runtime-config');
    return { config: payload.config || null, error: null };
  } catch (error) {
    return { config: null, error: error.message };
  }
}

function applyGatewayRuntimeConfig(config) {
  state.dnsCenter.gatewayRuntimeConfig = config || null;
  const backend = config?.backend || config?.gatewayApplyBackend;
  if (backend === 'host-nginx' || backend === 'k8s') {
    state.dnsCenter.gatewayBackend = backend;
  }
}

async function loadAppCenterApps() {
  try {
    const payload = await fetchJson('/internal/v1/app-center/apps');
    return { apps: asArray(payload.apps), error: null };
  } catch (error) {
    return { apps: [], error: error.message };
  }
}

async function loadAppOnboardingTemplates() {
  try {
    const payload = await fetchJson('/internal/v1/app-center/onboarding/defaults');
    return { templates: asArray(payload.templates), error: null };
  } catch (error) {
    return { templates: [], error: error.message };
  }
}

async function loadLauncherServiceVipSmokes() {
  try {
    const dashboard = await fetchJson('/internal/v1/admin/dashboard?limit=1');
    return { smokes: asArray(dashboard.launcherServiceVipSmokes), error: null };
  } catch (error) {
    return { smokes: [], error: error.message };
  }
}

async function loadAppOnboardingDefaults(input) {
  try {
    const payload = await fetchJson('/internal/v1/app-center/onboarding/defaults', {
      method: 'POST',
      body: input || {}
    });
    return { defaults: payload.defaults || null, error: null };
  } catch (error) {
    return { defaults: null, error: error.message };
  }
}

function selectedSiteFromOverseaOverview() {
  if (state.deploymentKind !== 'oversea') return null;
  if (state.siteDraft?.kind === 'oversea' && state.selectedSiteId === state.siteDraft.siteId) {
    return state.selectedSiteId;
  }
  const sites = asArray(state.overseaOverview?.sites);
  if (!sites.length) return null;
  if (state.selectedSiteId && sites.some((site) => site.siteId === state.selectedSiteId)) {
    return state.selectedSiteId;
  }
  return sites[0].siteId || null;
}

async function refreshPipelineDetail(planId) {
  const previousPlanId = state.selectedPlanId;
  state.selectedPlanId = planId;
  if (previousPlanId && previousPlanId !== planId) {
    state.selectedAction = null;
    state.actionFeedback = null;
    closeEvidenceDrawer();
  }
  renderPipelineSelection();
  try {
    const payload = await fetchJson(`/internal/v1/admin/site-slots/pipelines/${encodeURIComponent(planId)}`);
    const pipeline = payload.pipeline;
    state.selectedSiteId = pipeline?.summary?.siteId || state.selectedSiteId;
    if (state.deploymentKind !== 'internal') {
      state.deploymentKind = pipeline?.summary?.kind === 'domestic' ? 'domestic' : pipeline?.summary?.kind === 'oversea' ? 'oversea' : state.deploymentKind;
    }
    state.mihomoReachability = null;
    state.mihomoReachabilitySiteId = pipeline?.summary?.kind === 'oversea' ? pipeline.summary.siteId : null;
    state.mihomoReachabilityError = null;
    renderPipelineDetail(pipeline);
    consumePendingEvidenceFocus(pipeline);
    void refreshMihomoReachabilityForPipeline(pipeline);
    return pipeline;
  } catch (error) {
    pipelineSummary.textContent = error.message;
    pipelineStepper.innerHTML = '';
    pipelineActions.innerHTML = '';
    pipelineTimeline.innerHTML = '';
    return null;
  }
}

async function refreshMihomoReachabilityForPipeline(pipeline) {
  const summary = pipeline?.summary || null;
  if (!summary || summary.kind !== 'oversea' || !summary.siteId) return;
  try {
    const payload = await fetchJson(`/internal/v1/launcher-network/mihomo/sites/${encodeURIComponent(summary.siteId)}/reachability`);
    if (state.selectedPlanId !== summary.planId || state.currentPipeline?.summary?.siteId !== summary.siteId) return;
    state.mihomoReachability = payload.reachability || null;
    state.mihomoReachabilitySiteId = summary.siteId;
    state.mihomoReachabilityError = null;
  } catch (error) {
    if (state.selectedPlanId !== summary.planId || state.currentPipeline?.summary?.siteId !== summary.siteId) return;
    state.mihomoReachability = null;
    state.mihomoReachabilitySiteId = summary.siteId;
    state.mihomoReachabilityError = error.message;
  }
  renderCurrentPipelineSummary();
}

async function loadSshProfiles() {
  try {
    const payload = await fetchJson('/internal/v1/config-center/site-slot-ssh-profiles');
    if (
      state.sshProfileFeedback?.kind === 'error'
      && state.sshProfileFeedback.message.startsWith('SSH profiles unavailable:')
    ) {
      state.sshProfileFeedback = null;
    }
    return payload;
  } catch (error) {
    if (!state.sshProfileFeedback) {
      state.sshProfileFeedback = {
        kind: 'error',
        message: `SSH profiles unavailable: ${error.message}`
      };
    }
    return { profiles: [] };
  }
}

async function loadUserCenterOverview() {
  try {
    const [usersPayload, rolesPayload, entitlementPayload] = await Promise.all([
      fetchJson('/internal/v1/user-center/users'),
      fetchJson('/internal/v1/user-center/roles'),
      fetchJson('/internal/v1/user-center/oversea-entitlements')
    ]);
    return {
      users: asArray(usersPayload.users),
      roles: asArray(rolesPayload.roles),
      overseaEntitlements: asArray(entitlementPayload.entitlements),
      error: null
    };
  } catch (error) {
    return { users: [], roles: [], overseaEntitlements: [], error: error.message };
  }
}

async function saveAwxProvider() {
  if (state.awxProviderBusy) return;
  const tokenForAction = blankToNull(awxProviderToken.value);
  state.awxProviderBusy = true;
  state.awxProviderFeedback = { kind: 'info', message: 'Saving AWX provider' };
  state.awxProviderCheck = null;
  renderAwxProviderFeedback();
  renderAwxProviderSaveState();
  renderAwxProviderCheck();
  try {
    const payload = await fetchJson('/internal/v1/config-center/awx-providers', {
      method: 'POST',
      body: awxProviderFormPayload()
    });
    const saved = payload.provider;
    if (tokenForAction) state.awxActionDraft.token = tokenForAction;
    state.selectedAwxProviderId = saved?.providerId || null;
    state.awxProviderFeedback = {
      kind: 'success',
      message: saved ? `Saved ${saved.name} / ${saved.defaultKind}` : 'Saved AWX provider'
    };
    const dashboard = await fetchJson('/internal/v1/admin/dashboard');
    state.dashboard = dashboard;
    state.awxProviders = asArray(dashboard.awxProviders);
    renderAdminDashboard(dashboard);
    if (saved) fillAwxProviderForm(saved);
  } catch (error) {
    state.awxProviderFeedback = { kind: 'error', message: error.message };
    renderAwxProviderFeedback();
  } finally {
    state.awxProviderBusy = false;
    renderAwxProviderSaveState();
  }
}

async function checkAwxProviderFromForm() {
  if (state.awxProviderCheckBusy) return;
  const providerId = blankToNull(awxProviderId.value) || state.selectedAwxProviderId;
  if (!providerId) {
    state.awxProviderFeedback = { kind: 'error', message: 'Save or select an AWX provider first' };
    renderAwxProviderFeedback();
    return;
  }
  state.awxProviderCheckBusy = true;
  state.awxProviderFeedback = { kind: 'info', message: 'Checking AWX provider' };
  renderAwxProviderFeedback();
  renderAwxProviderSaveState();
  try {
    const payload = await fetchJson(`/internal/v1/config-center/awx-providers/${encodeURIComponent(providerId)}/check`, {
      method: 'POST',
      body: awxProviderCheckPayload()
    });
    state.awxActionDraft.token = blankToNull(awxProviderToken.value) || state.awxActionDraft.token;
    state.awxProviderCheck = payload.check || null;
    const status = state.awxProviderCheck?.status || 'unknown';
    state.awxProviderFeedback = {
      kind: status === 'failed' ? 'error' : status === 'passed' ? 'success' : 'info',
      message: `AWX provider check ${status}`
    };
  } catch (error) {
    state.awxProviderCheck = null;
    state.awxProviderFeedback = { kind: 'error', message: error.message };
  } finally {
    awxProviderToken.value = '';
    state.awxProviderCheckBusy = false;
    renderAwxProviderFeedback();
    renderAwxProviderSaveState();
    renderAwxProviderCheck();
  }
}

async function saveSshProfile() {
  if (state.sshProfileBusy) return;
  state.sshProfileBusy = true;
  state.sshProfileFeedback = { kind: 'info', message: 'Saving profile' };
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  try {
    const payload = await fetchJson('/internal/v1/config-center/site-slot-ssh-profiles', {
      method: 'POST',
      body: sshProfileFormPayload()
    });
    const saved = payload.profile;
    state.selectedSshProfileId = saved?.profileId || null;
    state.sshProfileBootstrap = null;
    state.sshProfileShadowSetup = null;
    state.sshProfileReadiness = null;
    state.sshRuntimePolicy = null;
    state.sshProfileFeedback = {
      kind: 'success',
      message: saved ? `Saved ${saved.siteId} / ${saved.sshUser}@${saved.host || '-'}` : 'Saved profile'
    };
    if (saved) {
      state.siteDraft = null;
      state.selectedSiteId = saved.siteId || state.selectedSiteId;
      fillSshProfileForm(saved);
    }
    await refreshAdmin();
  } catch (error) {
    state.sshProfileFeedback = { kind: 'error', message: error.message };
    renderSshProfileFeedback();
  } finally {
    state.sshProfileBusy = false;
    renderSshProfileSaveState();
    renderSshProfileBootstrap();
    renderSshProfileShadowSetup();
    renderSshProfileReadiness();
  }
}

async function bootstrapSshProfile() {
  if (state.sshBootstrapBusy) return;
  const password = blankToNull(sshProfilePassword.value);
  if (!blankToNull(sshProfileSiteId.value) || !blankToNull(sshProfileHost.value)) {
    state.sshProfileFeedback = {
      kind: 'error',
      message: 'Site and host are required before bootstrapping SSH'
    };
    renderSshProfileFeedback();
    return;
  }
  if (!password) {
    state.sshProfileFeedback = {
      kind: 'error',
      message: 'Enter the one-time server password to install the Internal-managed key'
    };
    renderSshProfileFeedback();
    return;
  }
  state.sshBootstrapBusy = true;
  state.sshProfileFeedback = { kind: 'info', message: 'Bootstrapping Internal-managed SSH key' };
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  try {
    const payload = await fetchJson('/internal/v1/config-center/site-slot-ssh-profiles/bootstrap', {
      method: 'POST',
      body: sshProfileBootstrapPayload(password)
    });
    const saved = payload.profile;
    const bootstrap = payload.bootstrap || null;
    sshProfilePassword.value = '';
    sshProfileRotateKey.checked = false;
    state.selectedSshProfileId = saved?.profileId || null;
    state.sshProfileBootstrap = bootstrap;
    state.sshProfileShadowSetup = null;
    state.sshProfileReadiness = null;
    state.sshRuntimePolicy = null;
    state.sshProfileFeedback = bootstrapFeedback(bootstrap, saved);
    const profilePayload = await loadSshProfiles();
    state.sshProfiles = asArray(profilePayload.profiles);
    renderSshProfiles(state.sshProfiles);
    if (saved) fillSshProfileForm(saved);
  } catch (error) {
    sshProfilePassword.value = '';
    sshProfileRotateKey.checked = false;
    state.sshProfileBootstrap = null;
    state.sshProfileShadowSetup = null;
    state.sshProfileFeedback = { kind: 'error', message: error.message };
    renderSshProfileFeedback();
  } finally {
    state.sshBootstrapBusy = false;
    renderSshProfileSaveState();
    renderSshProfileBootstrap();
    renderSshProfileShadowSetup();
    renderSshProfileReadiness();
  }
}

async function refreshSshHostKey() {
  if (state.sshHostKeyBusy) return;
  if (!blankToNull(sshProfileSiteId.value) || !blankToNull(sshProfileHost.value)) {
    state.sshProfileFeedback = {
      kind: 'error',
      message: 'Site and host are required before refreshing host key'
    };
    renderSshProfileFeedback();
    return;
  }
  state.sshHostKeyBusy = true;
  state.sshProfileFeedback = { kind: 'info', message: 'Refreshing SSH host key pin' };
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  try {
    const payload = await fetchJson('/internal/v1/config-center/site-slot-ssh-profiles/bootstrap', {
      method: 'POST',
      body: sshProfileHostKeyRefreshPayload()
    });
    const saved = payload.profile;
    const bootstrap = payload.bootstrap || null;
    state.selectedSshProfileId = saved?.profileId || null;
    state.sshProfileBootstrap = bootstrap;
    state.sshProfileShadowSetup = null;
    state.sshProfileReadiness = null;
    state.sshRuntimePolicy = null;
    state.sshProfileFeedback = hostKeyRefreshFeedback(bootstrap, saved);
    const profilePayload = await loadSshProfiles();
    state.sshProfiles = asArray(profilePayload.profiles);
    renderSshProfiles(state.sshProfiles);
    if (saved) fillSshProfileForm(saved);
  } catch (error) {
    state.sshProfileBootstrap = null;
    state.sshProfileShadowSetup = null;
    state.sshProfileFeedback = { kind: 'error', message: error.message };
    renderSshProfileFeedback();
  } finally {
    state.sshHostKeyBusy = false;
    renderSshProfileSaveState();
    renderSshProfileBootstrap();
    renderSshProfileShadowSetup();
    renderSshProfileReadiness();
  }
}

async function createPlanFromSshProfile() {
  if (state.sshPlanBusy || !sshProfileId.value.trim()) {
    state.sshProfileFeedback = {
      kind: 'error',
      message: 'Save or select a profile before creating a plan'
    };
    renderSshProfileFeedback();
    return;
  }
  const planBody = sshProfilePlanPayload();
  const hostFailure = domesticPlanHostValidationFailure(planBody.kind, planBody.host);
  if (hostFailure) {
    state.sshProfileFeedback = { kind: 'error', message: hostFailure };
    renderSshProfileFeedback();
    return;
  }
  state.sshPlanBusy = true;
  state.sshProfileFeedback = { kind: 'info', message: 'Creating site slot plan' };
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  try {
    const payload = await fetchJson('/internal/v1/site-slots/plans', {
      method: 'POST',
      body: planBody
    });
    const plan = payload.plan;
    state.selectedPlanId = plan?.planId || state.selectedPlanId;
    state.pendingEvidenceFocus = plan?.planId
      ? { planId: plan.planId, kind: 'plan', id: plan.planId }
      : null;
    const planMode = plan?.network?.mode ? ` / ${plan.network.mode}` : '';
    const bootstrap = plan?.network?.overseaSiteId ? ` via ${plan.network.overseaSiteId}` : '';
    state.sshProfileFeedback = {
      kind: 'success',
      message: plan ? `Created plan ${plan.siteId} / ${plan.status}${planMode}${bootstrap}` : 'Created plan'
    };
    await refreshAdmin();
  } catch (error) {
    state.sshProfileFeedback = { kind: 'error', message: error.message };
    renderSshProfileFeedback();
  } finally {
    state.sshPlanBusy = false;
    renderSshProfileSaveState();
  }
}

async function runOverseaShadowSetupFromSshProfile() {
  if (state.sshShadowBusy) return;
  const siteId = blankToNull(sshProfileSiteId.value);
  if (!siteId || !blankToNull(sshProfileHost.value)) {
    state.sshProfileFeedback = {
      kind: 'error',
      message: 'Site and host are required before Oversea shadow setup'
    };
    renderSshProfileFeedback();
    return;
  }
  if (sshProfileKind.value !== 'oversea') {
    state.sshProfileFeedback = {
      kind: 'error',
      message: 'Shadow Setup is currently scoped to Oversea slots'
    };
    renderSshProfileFeedback();
    return;
  }
  state.sshShadowBusy = true;
  state.sshProfileShadowSetup = null;
  state.sshProfileFeedback = { kind: 'info', message: 'Running Oversea shadow setup' };
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  renderSshProfileShadowSetup();
  try {
    const payload = await fetchJson(`/internal/v1/admin/oversea/${encodeURIComponent(siteId)}/shadow-setup`, {
      method: 'POST',
      body: sshProfileShadowSetupPayload()
    });
    const setup = payload.shadowSetup || null;
    const profile = payload.profile || null;
    if (profile) {
      state.selectedSshProfileId = profile.profileId || null;
      fillSshProfileForm(profile);
    }
    state.selectedSiteId = setup?.siteId || siteId;
    state.selectedPlanId = setup?.planId || state.selectedPlanId;
    state.sshProfileShadowSetup = setup;
    state.overseaOverview = payload.oversea || state.overseaOverview;
    state.overseaOverviewError = null;
    state.pendingEvidenceFocus = setup?.reportId && setup?.planId
      ? { planId: setup.planId, kind: 'worker-report', id: setup.reportId }
      : setup?.planId
        ? { planId: setup.planId, kind: 'plan', id: setup.planId }
        : null;
    state.sshProfileFeedback = {
      kind: setup?.status === 'passed' ? 'success' : setup?.status === 'failed' || setup?.status === 'blocked' ? 'error' : 'info',
      message: setup ? `Shadow setup ${setup.status} / ${setup.reportId || setup.jobId}` : 'Shadow setup completed'
    };
    awxProviderToken.value = '';
    const [dashboard, profilePayload] = await Promise.all([
      fetchJson('/internal/v1/admin/dashboard'),
      loadSshProfiles()
    ]);
    state.dashboard = dashboard;
    state.sshProfiles = asArray(profilePayload.profiles);
    state.awxProviders = asArray(dashboard.awxProviders);
    renderAdminDashboard(dashboard);
    renderSshProfiles(state.sshProfiles);
    if (state.selectedPlanId) await refreshPipelineDetail(state.selectedPlanId);
  } catch (error) {
    state.sshProfileFeedback = { kind: 'error', message: error.message };
    renderSshProfileFeedback();
  } finally {
    state.sshShadowBusy = false;
    renderSshProfileSaveState();
    renderSshProfileShadowSetup();
  }
}

async function ensureSelectedOversea() {
  if (state.overseaEnsureBusy) return;
  const overviewSite = selectedOverseaSite();
  const siteId = overviewSite?.siteId || state.selectedSiteId || blankToNull(sshProfileSiteId.value);
  if (!siteId) {
    state.overseaEnsureFeedback = { kind: 'error', message: 'Select or create an Oversea site first' };
    renderDeploymentWorkbench(state.dashboard?.siteSlotPipelines || []);
    return;
  }
  state.overseaEnsureBusy = true;
  state.overseaEnsureFeedback = { kind: 'info', message: overviewSite?.status === 'installed' ? 'Syncing Oversea remote state' : 'Installing and syncing Oversea' };
  state.overseaTerminalResult = {
    status: 'running',
    command: `Install / Sync ${siteId}`,
    stdout: [
      `site: ${siteId}`,
      'starting Internal-controlled Oversea install/sync',
      'waiting for remote worker output...'
    ].join('\n'),
    stderr: ''
  };
  renderDeploymentWorkbench(state.dashboard?.siteSlotPipelines || []);
  try {
    const runtimePayload = overseaRuntimePayloadForSite(siteId);
    const payload = await fetchJson(`/internal/v1/admin/oversea/${encodeURIComponent(siteId)}/ensure`, {
      method: 'POST',
      body: {
        executeRemote: true,
        confirmInstall: true,
        force: true,
        ...runtimePayload,
        requestedBy: 'desktop-admin',
        requestId: `desktop-oversea-ensure-${Date.now()}`
      }
    });
    state.overseaOverview = payload.oversea || state.overseaOverview;
    state.overseaOverviewError = null;
    state.overseaEnsureFeedback = ensureFeedbackFromPayload(payload.ensure);
    state.overseaTerminalResult = terminalResultFromEnsure(payload.ensure, siteId);
    const dashboard = await fetchJson('/internal/v1/admin/dashboard');
    state.dashboard = dashboard;
    const active = activePipelineForCurrentDeployment(dashboard.siteSlotPipelines || []);
    state.selectedPlanId = active?.planId || state.selectedPlanId;
    renderAdminDashboard(dashboard);
    if (state.selectedPlanId) await refreshPipelineDetail(state.selectedPlanId);
  } catch (error) {
    state.overseaEnsureFeedback = { kind: 'error', message: error.message };
    state.overseaTerminalResult = {
      status: 'failed',
      command: `Install / Sync ${siteId}`,
      stdout: '',
      stderr: error.message
    };
    renderDeploymentWorkbench(state.dashboard?.siteSlotPipelines || []);
  } finally {
    state.overseaEnsureBusy = false;
    renderDeploymentWorkbench(state.dashboard?.siteSlotPipelines || []);
  }
}

function terminalResultFromEnsure(ensure, siteId) {
  if (!ensure) {
    return {
      status: 'failed',
      command: `Install / Sync ${siteId}`,
      stdout: '',
      stderr: 'Install / Sync response missing'
    };
  }
  const workerRun = ensure.workerRun || null;
  const workerSummary = summarizeWorkerRunStdout(workerRun?.stdout);
  const workerDiagnosis = workerDiagnosisFromStdout(workerRun?.stdout);
  const steps = asArray(ensure.steps)
    .map((step) => `${step.stepId || 'step'}: ${step.status || 'unknown'}${step.objectId ? ` / ${step.objectId}` : ''}`)
    .join('\n');
  const blocked = asArray(ensure.blockedReasons).filter(Boolean).join('\n');
  const status = ensure.status === 'installed' || ensure.status === 'passed' ? 'passed' : ensure.status || workerRun?.status || 'unknown';
  return {
    status,
    exitCode: workerRun?.exitCode ?? null,
    command: `Install / Sync ${siteId}`,
    stdout: [
      `ensure: ${ensure.status || 'unknown'}`,
      ensure.reportId ? `report: ${ensure.reportId}` : '',
      steps ? `steps:\n${steps}` : '',
      workerSummary ? `worker summary:\n${workerSummary}` : '',
      workerRun?.stdout && !workerSummary ? `worker stdout:\n${workerRun.stdout}` : ''
    ].filter(Boolean).join('\n\n'),
    stderr: [
      blocked ? `blocked / failure:\n${blocked}` : '',
      workerDiagnosis ? `diagnosis: ${workerDiagnosis.category} / ${workerDiagnosis.summary}` : '',
      !workerDiagnosis && workerRun?.diagnosis ? `diagnosis: ${workerRun.diagnosis.category} / ${workerRun.diagnosis.summary}` : '',
      workerRun?.stderr ? `worker stderr:\n${workerRun.stderr}` : ''
    ].filter(Boolean).join('\n\n'),
    diagnosis: workerDiagnosis || workerRun?.diagnosis || null
  };
}

function summarizeWorkerRunStdout(stdout) {
  const parsed = parseLooseJson(stdout);
  if (!parsed || typeof parsed !== 'object') return null;
  const stepReports = asArray(parsed.stepReports);
  const failed = stepReports.find((step) => step.status === 'failed');
  const blockedCount = stepReports.filter((step) => step.status === 'blocked').length;
  const passedCount = stepReports.filter((step) => step.status === 'passed').length;
  const failureEvidence = parseLooseJson(failed?.stdout);
  const diagnosis = failureEvidence?.executionResult?.diagnosis || null;
  return [
    parsed.reportId ? `report: ${parsed.reportId}` : '',
    `status: ${parsed.status || 'unknown'}`,
    `steps: ${passedCount} passed / ${failed ? 1 : 0} failed / ${blockedCount} not executed`,
    failed ? `failed: ${failed.sourceId || failed.stepId} / ${failed.stderr || 'remote step failed'}` : '',
    diagnosis ? `diagnosis: ${diagnosis.category || 'unknown'} / ${diagnosis.summary || '-'}` : ''
  ].filter(Boolean).join('\n');
}

function workerDiagnosisFromStdout(stdout) {
  const parsed = parseLooseJson(stdout);
  if (!parsed || typeof parsed !== 'object') return null;
  const failed = asArray(parsed.stepReports).find((step) => step.status === 'failed');
  const evidence = parseLooseJson(failed?.stdout);
  return evidence?.executionResult?.diagnosis || null;
}

function parseLooseJson(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function runSelectedOverseaTerminal() {
  if (state.overseaTerminalBusy) return;
  const site = selectedOverseaSite();
  const command = (state.overseaTerminalCommand || overseaTerminalTemplates.inspect).trim();
  if (!site || !command) {
    state.overseaTerminalResult = {
      status: 'blocked',
      command,
      stdout: '',
      stderr: 'Select an Oversea node and enter a command first'
    };
    renderDeploymentWorkbench(state.dashboard?.siteSlotPipelines || []);
    return;
  }
  state.overseaTerminalBusy = true;
  state.overseaTerminalResult = {
    status: 'running',
    command,
    stdout: '',
    stderr: 'waiting for remote output...'
  };
  renderDeploymentWorkbench(state.dashboard?.siteSlotPipelines || []);
  try {
    const payload = await fetchJson(`/internal/v1/admin/oversea/${encodeURIComponent(site.siteId)}/terminal`, {
      method: 'POST',
      body: {
        command,
        timeoutSeconds: 300,
        confirmRemoteExecution: true,
        confirmManualCommand: true,
        requestedBy: 'desktop-admin',
        requestId: `desktop-oversea-terminal-${Date.now()}`
      }
    });
    state.overseaOverview = payload.oversea || state.overseaOverview;
    state.overseaOverviewError = null;
    state.overseaTerminalResult = payload.terminal || {
      status: 'failed',
      command,
      stdout: '',
      stderr: 'Terminal response missing'
    };
  } catch (error) {
    state.overseaTerminalResult = {
      status: 'failed',
      command,
      stdout: '',
      stderr: error.message
    };
  } finally {
    state.overseaTerminalBusy = false;
    renderDeploymentWorkbench(state.dashboard?.siteSlotPipelines || []);
  }
}

function ensureFeedbackFromPayload(ensure) {
  if (!ensure) return { kind: 'success', message: 'Oversea state refreshed' };
  const status = ensure.status || 'unknown';
  const report = ensure.reportId ? ` / ${ensure.reportId}` : '';
  const kind = status === 'installed' || status === 'passed' || status === 'ready-to-install' ? 'success' : status === 'blocked' || status === 'failed' ? 'error' : 'info';
  const blockers = asArray(ensure.blockedReasons).filter(Boolean).slice(0, 2).join(' / ');
  return {
    kind,
    message: blockers ? `${status}${report}: ${blockers}` : `${status}${report}`
  };
}

async function checkSshProfileReadiness(executeReadOnlyProbe = false) {
  const profileId = selectedSshProfileId();
  if (state.sshReadinessBusy || !profileId) {
    state.sshProfileFeedback = {
      kind: 'error',
      message: 'Save or select a profile before checking readiness'
    };
    renderSshProfileFeedback();
    return;
  }
  state.sshReadinessBusy = true;
  state.sshProfileFeedback = { kind: 'info', message: executeReadOnlyProbe ? 'Running read-only SSH probe' : 'Checking SSH profile readiness' };
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  try {
    const payload = await fetchJson(`/internal/v1/config-center/site-slot-ssh-profiles/${encodeURIComponent(profileId)}/readiness-probe`, {
      method: 'POST',
      body: {
        confirmReadOnlyProbe: true,
        executeReadOnlyProbe,
        requestedBy: 'desktop-admin',
        requestId: `${executeReadOnlyProbe ? 'desktop-ssh-readonly-execute' : 'desktop-ssh-readiness'}-${Date.now()}`
      }
    });
    const readiness = payload.readiness || null;
    state.sshProfileReadiness = readiness;
    state.sshRuntimePolicy = readiness?.gates?.configGate?.policy || null;
    state.sshProfileFeedback = {
      kind: readiness && (readiness.status === 'ready' || readiness.status === 'passed') ? 'success' : 'error',
      message: readiness ? `${executeReadOnlyProbe ? 'Readonly probe' : 'Readiness'} ${readiness.status}` : 'Readiness unavailable'
    };
  } catch (error) {
    state.sshProfileReadiness = null;
    state.sshRuntimePolicy = null;
    state.sshProfileFeedback = { kind: 'error', message: error.message };
  } finally {
    state.sshReadinessBusy = false;
    renderSshProfileFeedback();
    renderSshProfileSaveState();
    renderSshProfileReadiness();
  }
}

async function allowSshProfileReadonlyPolicy() {
  const profileId = selectedSshProfileId();
  if (state.sshPolicyBusy || !profileId) {
    state.sshProfileFeedback = {
      kind: 'error',
      message: 'Save or select a profile before allowing readonly probe'
    };
    renderSshProfileFeedback();
    return;
  }
  state.sshPolicyBusy = true;
  state.sshProfileFeedback = { kind: 'info', message: 'Saving runtime feature policy' };
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  try {
    const payload = await fetchJson('/internal/v1/config-center/runtime-feature-policies', {
      method: 'POST',
      body: {
        featureKey: SSH_READONLY_PROBE_FEATURE_KEY,
        scopeKind: 'profile',
        scopeId: profileId,
        enabled: true,
        mode: 'readonly-execute',
        requiresApproval: true,
        reason: 'desktop-admin ssh profile readiness',
        requestedBy: 'desktop-admin',
        requestId: `desktop-runtime-feature-${Date.now()}`
      }
    });
    state.sshRuntimePolicy = payload.policy || null;
    state.sshProfileFeedback = {
      kind: 'success',
      message: state.sshRuntimePolicy ? `Policy ${state.sshRuntimePolicy.scopeKind} / ${state.sshRuntimePolicy.mode}` : 'Policy saved'
    };
    await checkSshProfileReadiness();
  } catch (error) {
    state.sshProfileFeedback = { kind: 'error', message: error.message };
  } finally {
    state.sshPolicyBusy = false;
    renderSshProfileFeedback();
    renderSshProfileSaveState();
  }
}

function sshProfileFormPayload() {
  const kind = sshProfileKind.value === 'domestic' ? 'domestic' : 'oversea';
  const runtimePayload = kind === 'oversea' ? overseaRuntimeFormPayload() : {};
  return {
    profileId: blankToNull(sshProfileId.value),
    siteId: blankToNull(sshProfileSiteId.value),
    kind,
    host: blankToNull(sshProfileHost.value),
    sshUser: blankToNull(sshProfileUser.value) || 'root',
    sshPort: positiveNumberOrNull(sshProfilePort.value) || 22,
    identityFile: blankToNull(sshProfileIdentity.value),
    knownHostsFile: blankToNull(sshProfileKnownHosts.value),
    sshConfigFile: blankToNull(sshProfileConfigFile.value),
    hostKeyAlias: blankToNull(sshProfileHostKeyAlias.value),
    strictHostKeyChecking: sshProfileStrict.value,
    connectTimeoutSeconds: positiveNumberOrNull(sshProfileTimeout.value) || 30,
    batchMode: sshProfileBatchMode.value,
    status: 'active',
    ...runtimePayload,
    requestedBy: 'desktop-admin',
    requestId: `desktop-ssh-profile-${Date.now()}`
  };
}

function sshProfilePlanPayload() {
  const profileId = blankToNull(sshProfileId.value);
  const savedProfile = profileId
    ? asArray(state.sshProfiles).find((profile) => profile.profileId === profileId) || null
    : null;
  const kind = (savedProfile?.kind || sshProfileKind.value) === 'domestic' ? 'domestic' : 'oversea';
  const domesticBootstrap = kind === 'domestic' ? domesticBootstrapOverseaSite() : null;
  const formHost = blankToNull(sshProfileHost.value);
  const savedHost = blankToNull(savedProfile?.host);
  const host = kind === 'domestic' && domesticPlanHostValidationFailure(kind, formHost)
    ? savedHost || formHost
    : formHost || savedHost;
  const sshUser = blankToNull(sshProfileUser.value) || savedProfile?.sshUser || 'root';
  const sshPort = positiveNumberOrNull(sshProfilePort.value) || savedProfile?.sshPort || 22;
  const overseaRuntime = kind === 'oversea' ? overseaRuntimeFormPayload() : {};
  return {
    siteId: blankToNull(sshProfileSiteId.value) || savedProfile?.siteId || null,
    kind,
    sshProfileId: profileId,
    host,
    sshUser,
    sshPort,
    rootAccess: sshUser === 'root',
    hasDocker: true,
    hasOutboundInternet: kind === 'oversea',
    overseaSiteId: domesticBootstrap?.siteId || null,
    overseaHost: domesticBootstrap?.host || null,
    ...overseaRuntime,
    createdBy: 'desktop-admin',
    requestId: `desktop-site-slot-plan-${Date.now()}`
  };
}

function overseaRuntimeFormPayload() {
  return {
    serverPorts: blankToNull(sshProfileHy2Ports?.value) || '51288',
    exportPort: positiveNumberOrNull(sshProfileHealthPort?.value) || 3434,
    workerInternalBaseUrl: workerInternalBaseUrl(),
    overseaCallbackBaseUrl: overseaCallbackBaseUrlFromForm()
  };
}

function overseaRuntimePayloadForSite(siteId) {
  if (sshProfileKind.value === 'oversea' && blankToNull(sshProfileSiteId.value) === siteId) {
    return overseaRuntimeFormPayload();
  }
  const runtime = overseaRuntimeForSiteId(siteId);
  return {
    serverPorts: runtime.serverPorts,
    exportPort: runtime.exportPort,
    workerInternalBaseUrl: normalizeWorkerBaseValue(runtime.workerInternalBaseUrl) || defaultWorkerInternalBaseUrl(),
    overseaCallbackBaseUrl: runtime.overseaCallbackBaseUrl || null
  };
}

function domesticPlanHostValidationFailure(kind, host) {
  if (kind !== 'domestic') return null;
  const normalized = normalizedPlanHost(host);
  if (!normalized) return 'Domestic plan needs the real public host or IP from SSH Access';
  if (isPlaceholderDomesticPlanHost(normalized)) {
    return `Domestic host "${host}" is a placeholder; enter the real public IP or DNS name`;
  }
  return null;
}

function normalizedPlanHost(host) {
  const value = String(host || '').trim();
  if (!value) return null;
  const withoutScheme = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const authority = withoutScheme.split('/')[0] || withoutScheme;
  const withoutUserInfo = authority.includes('@') ? authority.split('@').pop() || authority : authority;
  if (withoutUserInfo.startsWith('[')) return withoutUserInfo.slice(1, withoutUserInfo.indexOf(']')).toLowerCase();
  return withoutUserInfo.replace(/:\d+$/, '').toLowerCase();
}

function isPlaceholderDomesticPlanHost(host) {
  return (host.startsWith('<') && host.endsWith('>'))
    || host === 'host'
    || host === 'localhost'
    || host === '0.0.0.0'
    || host === '::1'
    || host.startsWith('127.')
    || host.endsWith('.localhost')
    || host.endsWith('.invalid')
    || host.endsWith('.test')
    || host.endsWith('.example.com')
    || host.endsWith('.example.net')
    || host.endsWith('.example.org');
}

function domesticEndpointBlockedReason(endpoint) {
  const value = String(endpoint || '').trim();
  if (!value) return 'Domestic public endpoint is missing';
  const host = normalizedPlanHost(value);
  if (!host) return `Domestic public endpoint is invalid: ${value}`;
  if (isPlaceholderDomesticPlanHost(host)) {
    return `Domestic public endpoint is a placeholder: ${value}`;
  }
  return null;
}

function domesticBootstrapOverseaSite() {
  const sites = asArray(state.overseaOverview?.sites);
  const usableStatuses = ['installed', 'passed', 'running', 'ready'];
  return sites.find((site) => usableStatuses.includes(site.status))
    || sites.find((site) => site.sshProfile?.profileId && site.host)
    || null;
}

function sshProfileShadowSetupPayload() {
  const provider = activeAwxProviderForKind('oversea');
  return {
    sshProfileId: blankToNull(sshProfileId.value),
    host: blankToNull(sshProfileHost.value),
    sshUser: blankToNull(sshProfileUser.value) || 'root',
    sshPort: positiveNumberOrNull(sshProfilePort.value) || 22,
    identityFile: blankToNull(sshProfileIdentity.value),
    knownHostsFile: blankToNull(sshProfileKnownHosts.value),
    sshConfigFile: blankToNull(sshProfileConfigFile.value),
    hostKeyAlias: blankToNull(sshProfileHostKeyAlias.value) || blankToNull(sshProfileSiteId.value),
    strictHostKeyChecking: sshProfileStrict.value,
    connectTimeoutSeconds: positiveNumberOrNull(sshProfileTimeout.value) || 30,
    batchMode: sshProfileBatchMode.value,
    awxProviderId: blankToNull(awxProviderId.value) || state.selectedAwxProviderId || provider?.providerId || null,
    awxToken: blankToNull(awxProviderToken.value),
    awxRequestTimeoutSeconds: positiveNumberOrNull(awxProviderTimeout.value) || 30,
    ...overseaRuntimeFormPayload(),
    requestedBy: 'desktop-admin',
    requestId: `desktop-oversea-shadow-setup-${Date.now()}`
  };
}

function sshProfileBootstrapPayload(password) {
  const kind = sshProfileKind.value === 'domestic' ? 'domestic' : 'oversea';
  const runtimePayload = kind === 'oversea' ? overseaRuntimeFormPayload() : {};
  return {
    profileId: blankToNull(sshProfileId.value),
    siteId: blankToNull(sshProfileSiteId.value),
    kind,
    host: blankToNull(sshProfileHost.value),
    sshUser: blankToNull(sshProfileUser.value) || 'root',
    sshPort: positiveNumberOrNull(sshProfilePort.value) || 22,
    password,
    hostKeyAlias: blankToNull(sshProfileHostKeyAlias.value),
    connectTimeoutSeconds: positiveNumberOrNull(sshProfileTimeout.value) || 30,
    ...runtimePayload,
    rotateKey: sshProfileRotateKey.checked,
    scanHostKey: true,
    executeBootstrap: true,
    confirmBootstrap: true,
    requestedBy: 'desktop-admin',
    requestId: `desktop-ssh-bootstrap-${Date.now()}`
  };
}

function sshProfileHostKeyRefreshPayload() {
  const kind = sshProfileKind.value === 'domestic' ? 'domestic' : 'oversea';
  const runtimePayload = kind === 'oversea' ? overseaRuntimeFormPayload() : {};
  return {
    profileId: blankToNull(sshProfileId.value),
    siteId: blankToNull(sshProfileSiteId.value),
    kind,
    host: blankToNull(sshProfileHost.value),
    sshUser: blankToNull(sshProfileUser.value) || 'root',
    sshPort: positiveNumberOrNull(sshProfilePort.value) || 22,
    hostKeyAlias: blankToNull(sshProfileHostKeyAlias.value) || blankToNull(sshProfileSiteId.value),
    connectTimeoutSeconds: positiveNumberOrNull(sshProfileTimeout.value) || 30,
    ...runtimePayload,
    rotateKey: false,
    scanHostKey: true,
    executeBootstrap: false,
    confirmBootstrap: false,
    requestedBy: 'desktop-admin',
    requestId: `desktop-ssh-host-key-refresh-${Date.now()}`
  };
}

function bootstrapFeedback(bootstrap, profile) {
  if (!bootstrap) return { kind: 'error', message: 'Bootstrap returned no result' };
  const target = profile ? `${profile.siteId} / ${profile.sshUser}@${profile.host || '-'}` : bootstrap.siteId || 'profile';
  if (bootstrap.status === 'passed') {
    return { kind: 'success', message: `Installed Internal-managed SSH key for ${target}` };
  }
  if (bootstrap.status === 'failed') {
    return { kind: 'error', message: `Bootstrap failed for ${target}` };
  }
  if (bootstrap.status === 'blocked') {
    return { kind: 'info', message: `Profile and key prepared for ${target}; bootstrap gate is blocked` };
  }
  return { kind: 'info', message: `Profile and key prepared for ${target}` };
}

function hostKeyRefreshFeedback(bootstrap, profile) {
  if (!bootstrap) return { kind: 'error', message: 'Host key refresh returned no result' };
  const target = profile ? `${profile.siteId} / ${profile.host || '-'}` : bootstrap.siteId || 'profile';
  const knownHosts = bootstrap.knownHosts || {};
  if (knownHosts.status === 'passed') {
    return {
      kind: 'success',
      message: `Pinned SSH host key for ${target}; rerun Inspect`
    };
  }
  return {
    kind: 'error',
    message: `Could not scan SSH host key for ${target}`
  };
}

function awxProviderFormPayload() {
  return {
    providerId: blankToNull(awxProviderId.value),
    name: blankToNull(awxProviderName.value),
    status: awxProviderStatus.value === 'paused' ? 'paused' : 'active',
    defaultKind: awxProviderKind.value === 'domestic' || awxProviderKind.value === 'all' ? awxProviderKind.value : 'oversea',
    baseUrl: blankToNull(awxProviderBaseUrl.value),
    organization: blankToNull(awxProviderOrganization.value) || 'MX Internal',
    project: blankToNull(awxProviderProject.value) || 'mx-launcher-site-slots',
    inventoryPrefix: blankToNull(awxProviderInventoryPrefix.value) || 'mx',
    credentialPrefix: blankToNull(awxProviderCredentialPrefix.value) || 'mx',
    jobTemplatePrefix: blankToNull(awxProviderTemplatePrefix.value) || 'mx-site-slot',
    verifyTls: awxProviderVerifyTls.checked,
    requestTimeoutSeconds: positiveNumberOrNull(awxProviderTimeout.value) || 30,
    requestedBy: 'desktop-admin',
    requestId: `desktop-awx-provider-${Date.now()}`
  };
}

function awxProviderCheckPayload() {
  return {
    kind: awxProviderKind.value === 'domestic' ? 'domestic' : 'oversea',
    token: blankToNull(awxProviderToken.value),
    requestTimeoutSeconds: positiveNumberOrNull(awxProviderTimeout.value) || 30,
    requestedBy: 'desktop-admin',
    requestId: `desktop-awx-provider-check-${Date.now()}`
  };
}

function renderAwxProviders(providers) {
  const items = asArray(providers);
  awxProviderCount.textContent = String(items.length);
  renderAwxProviderFeedback();
  renderAwxProviderSaveState();
  renderAwxProviderCheck();
  if (!items.length) {
    awxProviderList.innerHTML = '<div class="empty-state">No AWX providers</div>';
    return;
  }
  awxProviderList.innerHTML = items.map((provider) => `
    <button
      class="awx-provider-item ${provider.providerId === state.selectedAwxProviderId ? 'is-selected' : ''}"
      type="button"
      data-provider-id="${escapeHtml(provider.providerId)}"
    >
      <span class="ssh-profile-head">
        <strong>${escapeHtml(provider.name || provider.providerId)}</strong>
        <span class="profile-status" data-status="${escapeHtml(provider.status)}">${escapeHtml(provider.status)}</span>
      </span>
      <span class="ssh-profile-target">
        <span>${escapeHtml(provider.defaultKind)} / ${escapeHtml(provider.organization || '-')}</span>
        <span>${escapeHtml(provider.baseUrl || 'config-only')}</span>
      </span>
      <dl class="awx-provider-meta">
        <div>
          <dt>Inventory</dt>
          <dd>${escapeHtml(`${provider.inventoryPrefix || 'mx'}-${provider.environment || 'env'}-${provider.defaultKind || 'kind'}`)}</dd>
        </div>
        <div>
          <dt>Template</dt>
          <dd>${escapeHtml(`${provider.jobTemplatePrefix || 'mx-site-slot'}-${provider.defaultKind || 'kind'}-worker-v1`)}</dd>
        </div>
        <div>
          <dt>Project</dt>
          <dd>${escapeHtml(provider.project || '-')}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>${formatTime(provider.updatedAt)}</dd>
        </div>
      </dl>
      ${provider.warnings && provider.warnings.length ? `<span class="awx-provider-warning">${escapeHtml(provider.warnings[0])}</span>` : ''}
    </button>
  `).join('');
  for (const item of awxProviderList.querySelectorAll('.awx-provider-item')) {
    item.addEventListener('click', () => {
      const provider = items.find((candidate) => candidate.providerId === item.dataset.providerId);
      if (!provider) return;
      state.selectedAwxProviderId = provider.providerId;
      state.awxProviderFeedback = null;
      state.awxProviderCheck = null;
      fillAwxProviderForm(provider);
      renderAwxProviders(state.awxProviders);
      renderInspector();
    });
  }
}

function fillAwxProviderForm(provider) {
  awxProviderId.value = provider.providerId || '';
  awxProviderName.value = provider.name || '';
  awxProviderStatus.value = provider.status === 'paused' ? 'paused' : 'active';
  awxProviderKind.value = provider.defaultKind === 'domestic' || provider.defaultKind === 'all' ? provider.defaultKind : 'oversea';
  awxProviderBaseUrl.value = provider.baseUrl || '';
  awxProviderOrganization.value = provider.organization || 'MX Internal';
  awxProviderProject.value = provider.project || 'mx-launcher-site-slots';
  awxProviderInventoryPrefix.value = provider.inventoryPrefix || 'mx';
  awxProviderCredentialPrefix.value = provider.credentialPrefix || 'mx';
  awxProviderTemplatePrefix.value = provider.jobTemplatePrefix || 'mx-site-slot';
  awxProviderVerifyTls.checked = provider.verifyTls !== false;
  awxProviderTimeout.value = String(provider.requestTimeoutSeconds || 30);
  awxProviderToken.value = '';
}

function primeAwxProviderForm(providers) {
  if (awxProviderId.value.trim() || awxProviderName.value.trim() || awxProviderBaseUrl.value.trim()) return;
  const items = asArray(providers);
  const provider = items.find((item) => item.status === 'active' && item.defaultKind === 'oversea')
    || items.find((item) => item.status === 'active')
    || items[0];
  if (provider) {
    state.selectedAwxProviderId = provider.providerId || null;
    fillAwxProviderForm(provider);
    return;
  }
  awxProviderId.value = '';
  awxProviderName.value = 'Oversea AWX Shadow';
  awxProviderStatus.value = 'active';
  awxProviderKind.value = 'oversea';
  awxProviderBaseUrl.value = '';
  awxProviderOrganization.value = 'MX Internal';
  awxProviderProject.value = 'mx-launcher-site-slots';
  awxProviderInventoryPrefix.value = 'mx';
  awxProviderCredentialPrefix.value = 'mx';
  awxProviderTemplatePrefix.value = 'mx-site-slot';
  awxProviderVerifyTls.checked = true;
  awxProviderTimeout.value = '30';
}

function renderAwxProviderFeedback() {
  const feedback = state.awxProviderFeedback;
  awxProviderFeedback.textContent = feedback?.message || '';
  if (feedback?.kind) {
    awxProviderFeedback.dataset.kind = feedback.kind === 'success' ? 'success' : feedback.kind === 'error' ? 'error' : 'info';
  } else {
    awxProviderFeedback.removeAttribute('data-kind');
  }
}

function renderAwxProviderSaveState() {
  awxProviderSave.disabled = state.awxProviderBusy || state.awxProviderCheckBusy;
  awxProviderSave.textContent = state.awxProviderBusy ? 'Saving' : 'Save Provider';
  awxProviderCheckRun.disabled = state.awxProviderBusy || state.awxProviderCheckBusy || !blankToNull(awxProviderId.value);
  awxProviderCheckRun.textContent = state.awxProviderCheckBusy ? 'Checking' : 'Check Provider';
}

function renderAwxProviderCheck() {
  const check = state.awxProviderCheck;
  if (!check) {
    awxProviderCheck.innerHTML = '';
    return;
  }
  const endpoints = asArray(check.endpoints);
  const failures = asArray(check.failures);
  const warnings = asArray(check.warnings);
  awxProviderCheck.innerHTML = `
    <section class="awx-check-card" data-status="${escapeHtml(normalizeStageStatus(check.status))}">
      <div class="ssh-bootstrap-head">
        <span>
          <strong>AWX Readonly Check</strong>
          <small>${escapeHtml(check.baseUrl || 'config-only')} / ${escapeHtml(check.targetKind || '-')}</small>
        </span>
        <span class="profile-status" data-status="${escapeHtml(check.status || 'planned')}">${escapeHtml(check.status || 'planned')}</span>
      </div>
      <dl class="awx-check-summary">
        <div>
          <dt>Organization</dt>
          <dd>${escapeHtml(check.organization || '-')}</dd>
        </div>
        <div>
          <dt>Project</dt>
          <dd>${escapeHtml(check.project || '-')}</dd>
        </div>
        <div>
          <dt>Inventory</dt>
          <dd>${escapeHtml(check.inventory || '-')}</dd>
        </div>
        <div>
          <dt>Job Template</dt>
          <dd>${escapeHtml(check.jobTemplate || '-')}</dd>
        </div>
      </dl>
      <div class="awx-endpoint-grid">
        ${endpoints.length ? endpoints.map((endpoint) => `
          <article data-status="${escapeHtml(normalizeStageStatus(endpoint.status))}">
            <span>${escapeHtml(endpoint.name)}</span>
            <strong>${escapeHtml(endpoint.status)}</strong>
            <small>HTTP ${escapeHtml(endpoint.httpStatus ?? '-')} / count ${escapeHtml(endpoint.count ?? '-')} / ${escapeHtml(endpoint.durationMs ?? 0)}ms</small>
            <small>${escapeHtml(endpoint.message || '-')}</small>
          </article>
        `).join('') : '<div class="empty-state">No AWX endpoint calls</div>'}
      </div>
      ${failures.length ? `<ul class="ssh-readiness-failures">${failures.map((failure) => `<li>${escapeHtml(failure)}</li>`).join('')}</ul>` : ''}
      ${warnings.length ? `<p class="awx-provider-warning">${escapeHtml(warnings[0])}</p>` : ''}
    </section>
  `;
}

function renderAwxRuntimeGates() {
  if (!awxRuntimeGates) return;
  const allEnabled = awxRuntimeGateDescriptors.every((descriptor) => runtimePolicyAllowsAwx(descriptor.featureKey));
  const feedback = state.awxRuntimePolicyFeedback;
  awxRuntimeGates.innerHTML = `
    <section class="awx-runtime-card">
      <div class="ssh-bootstrap-head">
        <span>
          <strong>AWX Runtime Gates</strong>
          <small>Config Center remote-execute policies</small>
        </span>
        <button class="secondary-button" type="button" data-awx-runtime-enable-all ${state.awxRuntimePolicyBusy || allEnabled ? 'disabled' : ''}>
          ${state.awxRuntimePolicyBusy ? 'Saving' : allEnabled ? 'Enabled' : 'Enable All'}
        </button>
      </div>
      <div class="awx-runtime-grid">
        ${awxRuntimeGateDescriptors.map((descriptor) => renderAwxRuntimeGate(descriptor)).join('')}
      </div>
      ${feedback ? `<div class="profile-feedback" data-kind="${escapeHtml(feedback.kind)}">${escapeHtml(feedback.message)}</div>` : ''}
    </section>
  `;
  const enableAll = awxRuntimeGates.querySelector('[data-awx-runtime-enable-all]');
  if (enableAll) {
    enableAll.addEventListener('click', () => {
      void saveAwxRuntimeGates(awxRuntimeGateDescriptors.map((descriptor) => descriptor.featureKey), true);
    });
  }
  for (const button of awxRuntimeGates.querySelectorAll('[data-awx-runtime-feature]')) {
    button.addEventListener('click', () => {
      const featureKey = button.dataset.awxRuntimeFeature;
      if (!featureKey) return;
      const enabled = button.dataset.nextEnabled === 'true';
      void saveAwxRuntimeGates([featureKey], enabled);
    });
  }
}

function renderAwxRuntimeGate(descriptor) {
  const policy = awxRuntimePolicyFor(descriptor.featureKey);
  const enabled = runtimePolicyAllowsAwx(descriptor.featureKey);
  const status = enabled ? 'passed' : policy ? 'blocked' : 'planned';
  const nextEnabled = !enabled;
  return `
    <article class="awx-runtime-gate" data-status="${escapeHtml(status)}">
      <span>${escapeHtml(descriptor.label)}</span>
      <strong>${escapeHtml(enabled ? 'remote-execute' : policy?.mode || 'disabled')}</strong>
      <small>${escapeHtml(policy?.policyId || descriptor.envKey)}</small>
      <button
        class="secondary-button"
        type="button"
        data-awx-runtime-feature="${escapeHtml(descriptor.featureKey)}"
        data-next-enabled="${nextEnabled ? 'true' : 'false'}"
        ${state.awxRuntimePolicyBusy ? 'disabled' : ''}
      >${enabled ? 'Disable' : 'Enable'}</button>
    </article>
  `;
}

function awxRuntimePolicyFor(featureKey) {
  return asArray(state.awxRuntimePolicies)
    .find((policy) => policy.featureKey === featureKey && policy.scopeKind === 'global')
    || asArray(state.awxRuntimePolicies).find((policy) => policy.featureKey === featureKey)
    || null;
}

function runtimePolicyAllowsAwx(featureKey) {
  const policy = awxRuntimePolicyFor(featureKey);
  if (!policy || !policy.enabled || policy.mode !== 'remote-execute') return false;
  return !policy.expiresAt || Date.parse(policy.expiresAt) > Date.now();
}

async function saveAwxRuntimeGates(featureKeys, enabled) {
  if (state.awxRuntimePolicyBusy) return;
  state.awxRuntimePolicyBusy = true;
  state.awxRuntimePolicyFeedback = {
    kind: 'info',
    message: enabled ? 'Enabling AWX runtime gates' : 'Disabling AWX runtime gate'
  };
  renderAwxRuntimeGates();
  try {
    await Promise.all(featureKeys.map((featureKey) => fetchJson('/internal/v1/config-center/runtime-feature-policies', {
      method: 'POST',
      body: {
        featureKey,
        scopeKind: 'global',
        scopeId: null,
        enabled,
        mode: enabled ? 'remote-execute' : 'disabled',
        requiresApproval: true,
        reason: 'desktop-admin awx runtime gate',
        requestedBy: 'desktop-admin',
        requestId: `desktop-awx-runtime-${Date.now()}`
      }
    })));
    state.awxRuntimePolicyFeedback = {
      kind: 'success',
      message: enabled ? 'AWX runtime gates enabled' : 'AWX runtime gate disabled'
    };
    const dashboard = await fetchJson('/internal/v1/admin/dashboard');
    state.dashboard = dashboard;
    renderAdminDashboard(dashboard);
  } catch (error) {
    state.awxRuntimePolicyFeedback = { kind: 'error', message: error.message };
    renderAwxRuntimeGates();
  } finally {
    state.awxRuntimePolicyBusy = false;
    renderAwxRuntimeGates();
  }
}

async function refreshUserCenterPanels() {
  const payload = await loadUserCenterOverview();
  state.userCenter.users = asArray(payload.users);
  state.userCenter.roles = asArray(payload.roles);
  state.userCenter.overseaEntitlements = asArray(payload.overseaEntitlements);
  if (payload.error) state.userCenter.feedback = { kind: 'error', message: payload.error };
  renderFoundationGrid(state.dashboard?.overview || {});
  renderUserEditorDrawer();
}

function renderUserCenterSurfaces() {
  renderFoundationGrid(state.dashboard?.overview || {});
  renderUserEditorDrawer();
}

function rerenderUserCenterDropdownContext() {
  if (state.adminMenu === 'internal' && state.adminSection === 'foundations' && state.adminSubsection === 'user-center') {
    renderUserCenterSurfaces();
  } else if (state.userCenter.drawer) {
    renderUserEditorDrawer();
  }
}

function syncUserDropdownDom() {
  for (const dropdown of document.querySelectorAll('[data-user-dropdown-root]')) {
    const open = dropdown.dataset.userDropdownRoot === state.userCenter.openDropdown;
    dropdown.classList.toggle('is-open', open);
    dropdown.querySelector('[data-user-dropdown-toggle]')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
}

function closeUserCenterDropdown() {
  if (!state.userCenter.openDropdown) return;
  state.userCenter.openDropdown = null;
  syncUserDropdownDom();
}

function toggleUserCenterDropdown(dropdownId) {
  if (!dropdownId) return;
  state.userCenter.openDropdown = state.userCenter.openDropdown === dropdownId ? null : dropdownId;
  rerenderUserCenterDropdownContext();
}

function applyUserCenterDropdownValue(field, value) {
  if (!field) return;
  if (field.startsWith('filter:')) {
    const filterField = field.slice('filter:'.length);
    if (filterField) userCenterFilters()[filterField] = value || 'all';
    return;
  }
  if (field === 'drawer:roleId' && state.userCenter.drawer) {
    state.userCenter.drawer.draft = {
      ...(state.userCenter.drawer.draft || {}),
      roleId: value || defaultUserRoleId()
    };
    state.userCenter.feedback = null;
  }
}

function bindUserDropdownControls(root) {
  if (!root) return;
  for (const trigger of root.querySelectorAll('[data-user-dropdown-toggle]')) {
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleUserCenterDropdown(trigger.dataset.userDropdownToggle);
    });
  }
  for (const option of root.querySelectorAll('[data-user-dropdown-option]')) {
    option.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      applyUserCenterDropdownValue(option.dataset.userDropdownField, option.dataset.userDropdownValue);
      state.userCenter.openDropdown = null;
      rerenderUserCenterDropdownContext();
    });
  }
}

async function bootstrapUserCenterFromAdmin() {
  if (state.userCenter.busy) return;
  state.userCenter.busy = true;
  state.userCenter.feedback = { kind: 'info', message: 'Bootstrapping User Center' };
  renderUserCenterSurfaces();
  try {
    const payload = await fetchJson('/internal/v1/user-center/bootstrap', { method: 'POST', body: {} });
    state.userCenter.feedback = {
      kind: 'success',
      message: `Bootstrapped ${asArray(payload.userCenter?.users).length} users`
    };
    await refreshUserCenterPanels();
  } catch (error) {
    state.userCenter.feedback = { kind: 'error', message: error.message };
    renderUserCenterSurfaces();
  } finally {
    state.userCenter.busy = false;
    renderUserCenterSurfaces();
  }
}

async function importUserCenterJsonFile(file) {
  if (!file || state.userCenter.importBusy) return;
  state.userCenter.importBusy = true;
  state.userCenter.importFeedback = { kind: 'info', message: `Importing ${file.name || 'users.json'}` };
  renderUserCenterSurfaces();
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : asArray(parsed?.users);
    if (!rows.length) throw new Error('JSON must be an array or contain users[]');
    const siteIds = state.userCenter.defaultOverseaOnCreate ? overseaAuthoritySites() : [];
    const payload = await fetchJson('/internal/v1/user-center/users/import', {
      method: 'POST',
      body: {
        users: rows,
        defaultRoleIds: [defaultUserRoleId()].filter(Boolean),
        defaultOrgIds: ['org_default'],
        defaultHomeAppId: MX_H2I_PRODUCT_ID,
        defaultRegisteredByAppId: MX_H2I_PRODUCT_ID,
        defaultAllowedAppIds: [MX_H2I_PRODUCT_ID, APP_CENTER_PRODUCT_ID, 'h2o'],
        defaultOverseaSiteIds: siteIds,
        provisionOversea: siteIds.length > 0,
        requestedBy: 'desktop-admin-import',
        requestId: `desktop-user-import-${Date.now()}`
      }
    });
    const result = payload.import || {};
    state.userCenter.importFeedback = {
      kind: result.failed ? 'warning' : 'success',
      message: `Imported ${result.imported || 0}, updated ${result.updated || 0}${result.failed ? `, failed ${result.failed}` : ''}`
    };
    await refreshUserCenterPanels();
  } catch (error) {
    state.userCenter.importFeedback = { kind: 'error', message: error.message };
    renderUserCenterSurfaces();
  } finally {
    state.userCenter.importBusy = false;
    renderUserCenterSurfaces();
  }
}

async function createUserFromAdmin() {
  if (state.userCenter.busy) return;
  const account = blankToNull(foundationGrid.querySelector('[data-user-field="account"]')?.value);
  const email = blankToNull(foundationGrid.querySelector('[data-user-field="email"]')?.value);
  const displayName = blankToNull(foundationGrid.querySelector('[data-user-field="displayName"]')?.value);
  const roleId = blankToNull(foundationGrid.querySelector('[data-user-field="roleId"]')?.value);
  if (!(account || email) || !displayName) {
    state.userCenter.feedback = { kind: 'error', message: 'Account or email and display name are required' };
    renderUserCenterSurfaces();
    return;
  }
  state.userCenter.busy = true;
  state.userCenter.feedback = { kind: 'info', message: 'Creating user' };
  renderUserCenterSurfaces();
  try {
    const payload = await fetchJson('/internal/v1/user-center/users', {
      method: 'POST',
      body: {
        account,
        email,
        displayName,
        roleIds: roleId ? [roleId] : [],
        orgIds: ['org_default'],
        requestId: `desktop-user-${Date.now()}`
      }
    });
    state.userCenter.feedback = {
      kind: 'success',
      message: `Created ${payload.user?.displayName || payload.user?.userId || account || email}`
    };
    await refreshUserCenterPanels();
  } catch (error) {
    state.userCenter.feedback = { kind: 'error', message: error.message };
    renderUserCenterSurfaces();
  } finally {
    state.userCenter.busy = false;
    renderUserCenterSurfaces();
  }
}

function userCenterFilters() {
  if (!state.userCenter.filter) {
    state.userCenter.filter = { search: '', roleId: 'all', status: 'all' };
  }
  return state.userCenter.filter;
}

function userCenterControlRoot() {
  return userEditorDrawer && !userEditorDrawer.hidden ? userEditorDrawer : foundationGrid;
}

function userCenterUserById(userId) {
  return asArray(state.userCenter.users).find((user) => user.userId === userId) || null;
}

function defaultUserRoleId() {
  const roles = asArray(state.userCenter.roles);
  return roles.find((role) => role.roleId === 'mx-user')?.roleId || roles[0]?.roleId || '';
}

function createUserEditorDraft(mode = 'create', userId = '') {
  const user = mode === 'edit' ? userCenterUserById(userId) : null;
  const profile = user?.profile || {};
  const appAccess = user?.appAccess || {};
  return {
    userId: user?.userId || '',
    account: user?.account || '',
    email: user?.email || '',
    displayName: user?.displayName || '',
    password: '',
    roleId: asArray(user?.roleIds)[0] || defaultUserRoleId(),
    title: profile.title || '',
    department: profile.department || '',
    location: profile.location || '',
    address: profile.address || '',
    attributesJson: formatJson(profile.attributes || {}),
    homeAppId: appAccess.homeAppId || (mode === 'create' ? MX_H2I_PRODUCT_ID : ''),
    registeredByAppId: appAccess.registeredByAppId || (mode === 'create' ? MX_H2I_PRODUCT_ID : ''),
    allowedAppIds: textFromStringList(appAccess.allowedAppIds || (mode === 'create' ? [MX_H2I_PRODUCT_ID, APP_CENTER_PRODUCT_ID, 'h2o'] : [])),
    deniedAppIds: textFromStringList(appAccess.deniedAppIds),
    provisionOversea: mode === 'create' ? state.userCenter.defaultOverseaOnCreate : false
  };
}

function openUserEditorDrawer(mode = 'edit', userId = '') {
  const normalizedMode = mode === 'create' ? 'create' : 'edit';
  const user = normalizedMode === 'edit' ? userCenterUserById(userId) : null;
  if (normalizedMode === 'edit' && !user) return;
  state.userCenter.drawer = {
    mode: normalizedMode,
    userId: user?.userId || '',
    draft: createUserEditorDraft(normalizedMode, user?.userId || '')
  };
  state.userCenter.openDropdown = null;
  state.userCenter.feedback = null;
  state.userCenter.overseaFeedback = null;
  state.userCenter.selectedOverseaUserId = user?.userId || null;
  renderUserEditorDrawer();
  requestAnimationFrame(() => {
    const firstField = userEditorDrawer?.querySelector('[data-user-editor-field="account"]:not([readonly]), [data-user-editor-field="displayName"]');
    firstField?.focus?.();
  });
}

function closeUserEditorDrawer() {
  state.userCenter.drawer = null;
  state.userCenter.openDropdown = null;
  state.userCenter.busy = false;
  if (userEditorBackdrop) userEditorBackdrop.hidden = true;
  if (userEditorDrawer) {
    userEditorDrawer.hidden = true;
    userEditorDrawer.innerHTML = '';
  }
}

function userEditorValue(root, field) {
  const element = root.querySelector(`[data-user-editor-field="${field}"]`);
  if (!element) return null;
  if (element.type === 'checkbox') return element.checked;
  return blankToNull(element.value);
}

function userEditorDraftFromForm(root) {
  const current = state.userCenter.drawer?.draft || {};
  const editing = state.userCenter.drawer?.mode === 'edit';
  return {
    ...current,
    userId: editing ? current.userId : userEditorValue(root, 'userId') || current.userId || '',
    account: userEditorValue(root, 'account') || '',
    email: userEditorValue(root, 'email') || '',
    displayName: userEditorValue(root, 'displayName') || '',
    password: userEditorValue(root, 'password') || '',
    roleId: userEditorValue(root, 'roleId') || defaultUserRoleId(),
    title: userEditorValue(root, 'title') || '',
    department: userEditorValue(root, 'department') || '',
    location: userEditorValue(root, 'location') || '',
    address: userEditorValue(root, 'address') || '',
    attributesJson: userEditorValue(root, 'attributesJson') || '{}',
    homeAppId: userEditorValue(root, 'homeAppId') || '',
    registeredByAppId: userEditorValue(root, 'registeredByAppId') || '',
    allowedAppIds: userEditorValue(root, 'allowedAppIds') || '',
    deniedAppIds: userEditorValue(root, 'deniedAppIds') || '',
    provisionOversea: Boolean(userEditorValue(root, 'provisionOversea'))
  };
}

function parseUserAttributesJson(value) {
  const raw = String(value || '').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Attributes JSON must be an object');
  }
  return parsed;
}

async function saveUserCenterUserFromEditor(root) {
  if (state.userCenter.busy) return;
  const draft = userEditorDraftFromForm(root);
  if (!draft.account || !draft.displayName) {
    state.userCenter.feedback = { kind: 'error', message: 'Account and display name are required' };
    if (state.userCenter.drawer) state.userCenter.drawer.draft = draft;
    renderUserEditorDrawer();
    return;
  }
  let attributes = {};
  try {
    attributes = parseUserAttributesJson(draft.attributesJson);
  } catch (error) {
    state.userCenter.feedback = { kind: 'error', message: error.message };
    if (state.userCenter.drawer) state.userCenter.drawer.draft = draft;
    renderUserEditorDrawer();
    return;
  }
  state.userCenter.busy = true;
  state.userCenter.feedback = {
    kind: 'info',
    message: state.userCenter.drawer?.mode === 'edit' ? 'Saving user' : 'Creating user'
  };
  if (state.userCenter.drawer) state.userCenter.drawer.draft = draft;
  renderUserEditorDrawer();
  try {
    const createMode = state.userCenter.drawer?.mode !== 'edit';
    const defaultOverseaSiteIds = createMode && draft.provisionOversea ? overseaAuthoritySites() : [];
    const payload = await fetchJson('/internal/v1/user-center/users', {
      method: 'POST',
      body: {
        userId: state.userCenter.drawer?.mode === 'edit' ? draft.userId : blankToNull(draft.userId),
        account: draft.account,
        email: blankToNull(draft.email),
        displayName: draft.displayName,
        password: blankToNull(draft.password),
        roleIds: draft.roleId ? [draft.roleId] : [],
        orgIds: ['org_default'],
        profile: {
          title: blankToNull(draft.title),
          department: blankToNull(draft.department),
          location: blankToNull(draft.location),
          address: blankToNull(draft.address),
          attributes
        },
        homeAppId: blankToNull(draft.homeAppId),
        registeredByAppId: blankToNull(draft.registeredByAppId),
        allowedAppIds: stringListFromText(draft.allowedAppIds),
        deniedAppIds: stringListFromText(draft.deniedAppIds),
        defaultOverseaSiteIds,
        provisionOversea: defaultOverseaSiteIds.length > 0,
        requestedBy: 'desktop-admin',
        requestId: `desktop-user-${Date.now()}`
      }
    });
    const saved = payload.user || {};
    const savedUserId = saved.userId || draft.userId;
    state.userCenter.drawer = {
      mode: 'edit',
      userId: savedUserId,
      draft: {
        userId: savedUserId,
        account: saved.account || draft.account,
        email: saved.email || draft.email,
        displayName: saved.displayName || draft.displayName,
        password: '',
        roleId: asArray(saved.roleIds)[0] || draft.roleId,
        title: saved.profile?.title || draft.title,
        department: saved.profile?.department || draft.department,
        location: saved.profile?.location || draft.location,
        address: saved.profile?.address || draft.address,
        attributesJson: formatJson(saved.profile?.attributes || attributes),
        homeAppId: saved.appAccess?.homeAppId || draft.homeAppId,
        registeredByAppId: saved.appAccess?.registeredByAppId || draft.registeredByAppId,
        allowedAppIds: textFromStringList(saved.appAccess?.allowedAppIds || stringListFromText(draft.allowedAppIds)),
        deniedAppIds: textFromStringList(saved.appAccess?.deniedAppIds || stringListFromText(draft.deniedAppIds)),
        provisionOversea: false
      }
    };
    state.userCenter.selectedOverseaUserId = savedUserId || null;
    state.userCenter.feedback = {
      kind: 'success',
      message: `Saved ${saved.displayName || draft.displayName || savedUserId}`
    };
    await refreshUserCenterPanels();
  } catch (error) {
    state.userCenter.feedback = { kind: 'error', message: error.message };
    renderUserEditorDrawer();
  } finally {
    state.userCenter.busy = false;
    renderUserCenterSurfaces();
  }
}

async function assignUserOverseaFromAdmin() {
  if (state.userCenter.overseaBusy) return;
  const root = userCenterControlRoot();
  const userId = state.userCenter.drawer?.userId || blankToNull(root.querySelector('[data-oversea-user]')?.value);
  const siteIds = [...root.querySelectorAll('[data-oversea-site]:checked')]
    .map((item) => item.value)
    .filter(Boolean);
  if (!userId) {
    state.userCenter.overseaFeedback = { kind: 'error', message: 'Select a user first' };
    renderUserCenterSurfaces();
    return;
  }
  state.userCenter.selectedOverseaUserId = userId;
  state.userCenter.overseaBusy = true;
  state.userCenter.overseaFeedback = {
    kind: 'info',
    message: siteIds.length ? 'Issuing user Oversea entitlement' : 'Disabling user Oversea access'
  };
  renderUserCenterSurfaces();
  try {
    const payload = await fetchJson(`/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea`, {
      method: 'POST',
      body: {
        siteIds,
        requestedBy: 'desktop-admin',
        requestId: `desktop-user-oversea-${Date.now()}`
      }
    });
    const assignedCount = asArray(payload.entitlement?.siteIds).length;
    let syncPayload = null;
    if (assignedCount) {
      state.userCenter.overseaFeedback = {
        kind: 'info',
        message: `Assigned ${assignedCount} site(s); syncing this user to remote`
      };
      renderUserCenterSurfaces();
      try {
        syncPayload = await runUserOverseaRuntimeSync(userId, siteIds, `desktop-user-oversea-sync-after-assign-${Date.now()}`);
      } catch (syncError) {
        syncPayload = { sync: { reports: [{ status: 'failed', stderr: syncError.message }] } };
      }
    }
    const syncReports = asArray(syncPayload?.sync?.reports);
    const syncPassed = syncReports.filter((report) => report.status === 'passed').length;
    const syncBlocked = syncReports.filter((report) => report.status === 'blocked').length;
    const syncFailed = syncReports.filter((report) => report.status === 'failed').length;
    state.userCenter.overseaFeedback = {
      kind: syncFailed ? 'error' : syncBlocked ? 'warning' : 'success',
      message: assignedCount
        ? `Assigned ${assignedCount} site(s); remote sync ${syncPassed} passed${syncBlocked ? ` / ${syncBlocked} blocked` : ''}${syncFailed ? ` / ${syncFailed} failed` : ''}`
        : 'Disabled Oversea access'
    };
    await refreshUserCenterPanels();
  } catch (error) {
    state.userCenter.overseaFeedback = { kind: 'error', message: error.message };
    renderUserCenterSurfaces();
  } finally {
    state.userCenter.overseaBusy = false;
    renderUserCenterSurfaces();
  }
}

async function runUserOverseaRuntimeSync(userId, siteIds, requestId) {
  return fetchJson(`/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea/sync-runtime`, {
    method: 'POST',
    body: {
      siteIds,
      confirmRemoteExecution: true,
      requestedBy: 'desktop-admin',
      requestId
    }
  });
}

async function syncUserOverseaRuntimeFromAdmin(input = {}) {
  if (state.userCenter.overseaSyncBusy || state.userCenter.overseaBusy) return;
  const root = userCenterControlRoot();
  const userId = input.userId || state.userCenter.drawer?.userId || blankToNull(root.querySelector('[data-oversea-user]')?.value);
  let siteIds = asArray(input.siteIds);
  if (!siteIds.length) siteIds = [...root.querySelectorAll('[data-oversea-site]:checked')]
    .map((item) => item.value)
    .filter(Boolean);
  if (!userId) {
    state.userCenter.overseaFeedback = { kind: 'error', message: 'Select a user first' };
    renderUserCenterSurfaces();
    return;
  }
  const entitlement = entitlementForUser(userId);
  if (!siteIds.length) siteIds = asArray(entitlement?.siteIds);
  if (!siteIds.length) {
    state.userCenter.overseaFeedback = { kind: 'error', message: 'Assign at least one Oversea site before syncing' };
    renderUserCenterSurfaces();
    return;
  }
  state.userCenter.selectedOverseaUserId = userId;
  state.userCenter.overseaSyncBusy = true;
  state.userCenter.overseaFeedback = { kind: 'info', message: 'Syncing this user to selected remote site(s)' };
  renderUserCenterSurfaces();
  try {
    const payload = await runUserOverseaRuntimeSync(userId, siteIds, `desktop-user-oversea-sync-${Date.now()}`);
    const reports = asArray(payload.sync?.reports);
    const passed = reports.filter((report) => report.status === 'passed').length;
    const blocked = reports.filter((report) => report.status === 'blocked').length;
    const failed = reports.filter((report) => report.status === 'failed').length;
    state.userCenter.overseaFeedback = {
      kind: failed ? 'error' : blocked ? 'warning' : 'success',
      message: `Remote sync ${passed} passed${blocked ? ` / ${blocked} blocked` : ''}${failed ? ` / ${failed} failed` : ''}`
    };
    await refreshUserCenterPanels();
  } catch (error) {
    state.userCenter.overseaFeedback = { kind: 'error', message: error.message };
    renderUserCenterSurfaces();
  } finally {
    state.userCenter.overseaSyncBusy = false;
    renderUserCenterSurfaces();
  }
}

async function enrollHomeRelayFromAdmin(root = foundationGrid) {
  if (state.relayEnrollment.busy) return;
  const draft = relayEnrollmentDraftFromForm(root);
  if (!draft.publicKey) {
    state.relayEnrollment.feedback = { kind: 'error', message: 'Home WireGuard public key is required' };
    renderFoundationGrid(state.dashboard?.overview || {});
    renderAppCenterProductNetwork();
    return;
  }
  state.relayEnrollment.busy = true;
  state.relayEnrollment.feedback = { kind: 'info', message: 'Creating product relay lease' };
  renderFoundationGrid(state.dashboard?.overview || {});
  renderAppCenterProductNetwork();
  try {
    const product = await ensureRelayProductNetwork(draft);
    const productSecondOctet = productSecondOctetFromProduct(product)
      || normalizeProductSecondOctet(draft.productSecondOctet, defaultProductSecondOctet(draft.productId, draft.mode));
    state.relayEnrollment.draft = {
      ...draft,
      productSecondOctet
    };
    const payload = await fetchJson('/internal/v1/launcher-network/enrollments', {
      method: 'POST',
      body: {
        productId: draft.productId,
        mode: draft.mode,
        identityKind: draft.identityKind,
        siteId: draft.siteId,
        installId: draft.installId,
        deviceId: draft.deviceId,
        userId: draft.identityKind === 'user' ? draft.userId : null,
        deviceLabel: draft.deviceLabel,
        platform: 'desktop-admin',
        publicKey: draft.publicKey,
        requestedBy: 'desktop-admin',
        requestId: `desktop-relay-enroll-${Date.now()}`
      }
    });
    const lease = payload.lease || null;
    state.relayEnrollment.result = lease;
    state.relayEnrollment.feedback = {
      kind: 'success',
      message: lease ? `Product lease ${lease.leaseIp}` : 'Product relay lease created'
    };
    if (lease?.leaseId) {
      upsertLocalLauncherLease(lease);
      if (launcherLeaseIsRuntimeClient(lease)) {
        state.domesticPeerDraft = {
          productId: lease.productId || draft.productId,
          productSecondOctet: productSecondOctetFromIp(lease.leaseIp) || productSecondOctet,
          leaseId: lease.leaseId,
          peerRole: launcherLeaseRole(lease),
          leaseIp: lease.leaseIp || '',
          publicKey: lease.publicKey || draft.publicKey
        };
      }
    }
  } catch (error) {
    state.relayEnrollment.feedback = { kind: 'error', message: error.message };
  } finally {
    state.relayEnrollment.busy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
    renderAppCenterProductNetwork();
  }
}

function renderSshProfiles(profiles) {
  const kindFilter = sshProfileListKindFilter();
  const items = kindFilter
    ? asArray(profiles).filter((profile) => profile.kind === kindFilter)
    : asArray(profiles);
  sshProfileCount.textContent = String(items.length);
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  renderSshProfileBootstrap();
  renderSshProfileShadowSetup();
  renderSshProfileReadiness();
  if (!items.length) {
    sshProfileList.innerHTML = `<div class="empty-state">No ${kindFilter ? deploymentKindLabel(kindFilter) : 'SSH'} profiles</div>`;
    return;
  }
  sshProfileList.innerHTML = items.map((profile) => `
    <button
      class="ssh-profile-item ${profile.profileId === state.selectedSshProfileId ? 'is-selected' : ''}"
      type="button"
      data-profile-id="${escapeHtml(profile.profileId)}"
    >
      <span class="ssh-profile-head">
        <strong>${escapeHtml(profile.siteId)}</strong>
        <span class="profile-status" data-status="${escapeHtml(profile.status)}">${escapeHtml(profile.status)}</span>
      </span>
      <span class="ssh-profile-target">
        <span>${escapeHtml(profile.kind)} / ${escapeHtml(profile.sshUser)}@${escapeHtml(profile.host || '-')}</span>
        <span>:${escapeHtml(profile.sshPort)}</span>
      </span>
      <dl class="ssh-profile-meta">
        <div>
          <dt>Identity</dt>
          <dd>${escapeHtml(profile.identityFile || '-')}</dd>
        </div>
        <div>
          <dt>Known Hosts</dt>
          <dd>${escapeHtml(profile.knownHostsFile || '-')}</dd>
        </div>
        <div>
          <dt>SSH Config</dt>
          <dd>${escapeHtml(profile.sshConfigFile || '-')}</dd>
        </div>
        <div>
          <dt>Strict</dt>
          <dd>${escapeHtml(profile.strictHostKeyChecking)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>${formatTime(profile.updatedAt)}</dd>
        </div>
      </dl>
      ${profile.warnings && profile.warnings.length ? `<span class="ssh-profile-warning">${escapeHtml(profile.warnings[0])}</span>` : ''}
    </button>
  `).join('');
  for (const item of sshProfileList.querySelectorAll('.ssh-profile-item')) {
    item.addEventListener('click', () => {
      const profile = items.find((candidate) => candidate.profileId === item.dataset.profileId);
      if (!profile) return;
      state.selectedSshProfileId = profile.profileId;
      state.sshProfileFeedback = null;
      state.sshProfileBootstrap = null;
      state.sshProfileShadowSetup = null;
      state.sshProfileReadiness = null;
      state.sshRuntimePolicy = null;
      fillSshProfileForm(profile);
      renderSshProfiles(state.sshProfiles);
      renderSshProfileReadiness();
    });
  }
}

function sshProfileListKindFilter() {
  if (state.adminSection !== 'deployment') return null;
  return state.deploymentKind === 'domestic' || state.deploymentKind === 'oversea'
    ? state.deploymentKind
    : null;
}

function fillSshProfileForm(profile) {
  const runtime = overseaRuntimeForSiteId(profile.siteId);
  const workerBaseUrl = normalizeWorkerBaseValue(profile.workerInternalBaseUrl)
    || normalizeWorkerBaseValue(runtime.workerInternalBaseUrl)
    || defaultWorkerInternalBaseUrl();
  sshProfileId.value = profile.profileId || '';
  sshProfileSiteId.value = profile.siteId || '';
  sshProfileKind.value = profile.kind === 'domestic' ? 'domestic' : 'oversea';
  sshProfileHost.value = profile.host || '';
  sshProfileUser.value = profile.sshUser || 'root';
  sshProfilePassword.value = '';
  sshProfileRotateKey.checked = false;
  sshProfilePort.value = String(profile.sshPort || 22);
  sshProfileHy2Ports.value = profile.kind === 'oversea' ? (profile.serverPorts || runtime.serverPorts) : '';
  sshProfileHealthPort.value = profile.kind === 'oversea' ? String(positiveNumberOrNull(profile.exportPort) || runtime.exportPort) : '';
  sshProfileWorkerInternalUrl.value = profile.kind === 'oversea' ? workerBaseUrl : '';
  sshProfileOverseaCallbackUrl.value = profile.kind === 'oversea' ? (profile.overseaCallbackBaseUrl || runtime.overseaCallbackBaseUrl || '') : '';
  sshProfileStrict.value = profile.strictHostKeyChecking || 'yes';
  sshProfileBatchMode.value = profile.batchMode || 'yes';
  sshProfileTimeout.value = String(profile.connectTimeoutSeconds || 30);
  sshProfileIdentity.value = profile.identityFile || '';
  sshProfileKnownHosts.value = profile.knownHostsFile || '';
  sshProfileConfigFile.value = profile.sshConfigFile || '';
  sshProfileHostKeyAlias.value = profile.hostKeyAlias || profile.siteId || '';
}

function primeSshProfileForm(pipelines) {
  if (sshProfileSiteId.value.trim()) return;
  const kind = state.deploymentKind === 'domestic' ? 'domestic' : 'oversea';
  const pipeline = asArray(pipelines).find((item) => item.kind === kind) || null;
  fillNewSshProfileForm(kind, pipeline?.siteId || defaultSiteIdForKind(kind));
}

function defaultSiteIdForKind(kind) {
  return kind === 'domestic' ? 'domestic-main' : 'oversea-main';
}

function formSiteKindMismatch(kind, siteId) {
  if (!siteId) return false;
  if (kind === 'domestic') return /^oversea([._-]|$)/i.test(siteId);
  return /^domestic([._-]|$)/i.test(siteId);
}

function syncSshProfileFormForDeploymentKind(kind) {
  const normalizedKind = kind === 'domestic' ? 'domestic' : 'oversea';
  const formProfile = asArray(state.sshProfiles).find((profile) => profile.profileId && profile.profileId === sshProfileId.value.trim());
  const currentSiteId = blankToNull(sshProfileSiteId.value);
  const currentKind = sshProfileKind.value === 'domestic' ? 'domestic' : 'oversea';
  const needsReset = currentKind !== normalizedKind
    || (formProfile && formProfile.kind !== normalizedKind)
    || formSiteKindMismatch(normalizedKind, currentSiteId);
  if (!needsReset) return;

  const selectedProfile = asArray(state.sshProfiles).find((profile) => (
    profile.kind === normalizedKind
    && (
      profile.profileId === state.selectedSshProfileId
      || profile.siteId === state.selectedSiteId
    )
  ));
  const fallbackProfile = selectedProfile
    || asArray(state.sshProfiles).find((profile) => profile.kind === normalizedKind && profile.siteId === defaultSiteIdForKind(normalizedKind))
    || asArray(state.sshProfiles).find((profile) => profile.kind === normalizedKind);

  state.selectedSshProfileId = fallbackProfile?.profileId || null;
  state.sshProfileBootstrap = null;
  state.sshProfileShadowSetup = null;
  state.sshProfileReadiness = null;
  state.sshRuntimePolicy = null;
  if (fallbackProfile) {
    fillSshProfileForm(fallbackProfile);
  } else {
    fillNewSshProfileForm(normalizedKind, defaultSiteIdForKind(normalizedKind));
  }
}

function renderSshProfileFeedback() {
  const feedback = state.sshProfileFeedback;
  sshProfileFeedback.textContent = feedback?.message || '';
  if (feedback?.kind) {
    sshProfileFeedback.dataset.kind = feedback.kind === 'success' ? 'success' : feedback.kind === 'error' ? 'error' : 'info';
  } else {
    sshProfileFeedback.removeAttribute('data-kind');
  }
}

function renderSshProfileSaveState() {
  sshProfileSave.disabled = state.sshProfileBusy;
  sshProfileSave.textContent = state.sshProfileBusy ? 'Saving' : 'Save Profile';
  sshProfileRefreshHostKey.disabled = state.sshProfileBusy || state.sshHostKeyBusy || !blankToNull(sshProfileSiteId.value) || !blankToNull(sshProfileHost.value);
  sshProfileRefreshHostKey.textContent = state.sshHostKeyBusy ? 'Refreshing' : 'Refresh Host Key';
  sshProfileBootstrap.disabled = state.sshProfileBusy || state.sshBootstrapBusy || !blankToNull(sshProfileSiteId.value) || !blankToNull(sshProfileHost.value);
  sshProfileBootstrap.textContent = state.sshBootstrapBusy ? 'Bootstrapping' : 'Bootstrap Key';
  sshProfileCreatePlan.disabled = state.sshProfileBusy || state.sshPlanBusy || !sshProfileId.value.trim();
  sshProfileCreatePlan.textContent = state.sshPlanBusy ? 'Creating' : 'Create Plan';
  sshProfileShadowSetup.disabled = state.sshProfileBusy || state.sshShadowBusy || sshProfileKind.value !== 'oversea' || !blankToNull(sshProfileSiteId.value) || !blankToNull(sshProfileHost.value);
  sshProfileShadowSetup.textContent = state.sshShadowBusy ? 'Setting up' : 'Shadow Setup';
  sshProfileReadinessRun.disabled = state.sshProfileBusy || state.sshReadinessBusy || !selectedSshProfileId();
  sshProfileReadinessRun.textContent = state.sshReadinessBusy ? 'Checking' : 'Check Readiness';
  sshProfileReadinessExecute.disabled = state.sshProfileBusy || state.sshReadinessBusy || !selectedSshProfileId();
  sshProfileReadinessExecute.textContent = state.sshReadinessBusy ? 'Running' : 'Run Readonly Probe';
  sshProfilePolicyEnable.disabled = state.sshProfileBusy || state.sshPolicyBusy || !selectedSshProfileId();
  sshProfilePolicyEnable.textContent = state.sshPolicyBusy ? 'Saving' : 'Allow Readonly';
}

function renderSshProfileBootstrap() {
  const bootstrap = state.sshProfileBootstrap;
  if (!bootstrap) {
    sshProfileBootstrapResult.innerHTML = '';
    return;
  }
  const gates = bootstrap.gates || {};
  const warnings = asArray(bootstrap.warnings);
  const nextActions = asArray(bootstrap.nextActions);
  sshProfileBootstrapResult.innerHTML = `
    <section class="ssh-bootstrap-card" data-status="${escapeHtml(normalizeStageStatus(bootstrap.status))}">
      <div class="ssh-bootstrap-head">
        <span>
          <strong>SSH Key Bootstrap</strong>
          <small>${escapeHtml(bootstrap.sshUser || '-')}@${escapeHtml(bootstrap.host || '-')}:${escapeHtml(bootstrap.sshPort || '-')}</small>
        </span>
        <span class="profile-status" data-status="${escapeHtml(bootstrap.status || 'planned')}">${escapeHtml(bootstrap.status || 'planned')}</span>
      </div>
      <dl class="ssh-readiness-meta">
        <div>
          <dt>Identity</dt>
          <dd>${escapeHtml(bootstrap.key?.identityFile || '-')}</dd>
        </div>
        <div>
          <dt>Known Hosts</dt>
          <dd>${escapeHtml(`${bootstrap.knownHosts?.status || '-'} / ${bootstrap.knownHosts?.lineCount ?? 0} lines`)}</dd>
        </div>
        <div>
          <dt>SSH Config</dt>
          <dd>${escapeHtml(bootstrap.key?.sshConfigFile || '-')}</dd>
        </div>
        <div>
          <dt>Env Gate</dt>
          <dd>${escapeHtml(`${gates.envGate?.status || '-'} / ${gates.envGate?.variable || '-'}`)}</dd>
        </div>
        <div>
          <dt>Request</dt>
          <dd>${escapeHtml(gates.requestGate?.status || '-')}</dd>
        </div>
        <div>
          <dt>Install</dt>
          <dd>${escapeHtml(bootstrap.install?.status || '-')}</dd>
        </div>
        <div>
          <dt>Next</dt>
          <dd>${escapeHtml(nextActions.join(' / ') || '-')}</dd>
        </div>
      </dl>
      <pre class="ssh-readiness-command">${escapeHtml(bootstrap.install?.command || '-')}</pre>
      <pre class="ssh-readiness-command">${escapeHtml(bootstrap.install?.verifyCommand || '-')}</pre>
      ${warnings.length ? `
        <ul class="ssh-readiness-failures">
          ${warnings.slice(0, 5).map((warning) => `<li>${escapeHtml(warning)}</li>`).join('')}
        </ul>
      ` : ''}
    </section>
  `;
}

function renderSshProfileShadowSetup() {
  const setup = state.sshProfileShadowSetup;
  if (!setup) {
    sshProfileShadowResult.innerHTML = '';
    return;
  }
  const steps = asArray(setup.steps);
  const blockedReasons = asArray(setup.blockedReasons);
  const warnings = asArray(setup.warnings);
  sshProfileShadowResult.innerHTML = `
    <section class="ssh-bootstrap-card ssh-shadow-card" data-status="${escapeHtml(normalizeStageStatus(setup.status))}">
      <div class="ssh-bootstrap-head">
        <span>
          <strong>Oversea Shadow Setup</strong>
          <small>${escapeHtml(setup.boundary || 'internal-shadow-no-remote-mutation')}</small>
        </span>
        <span class="profile-status" data-status="${escapeHtml(setup.status || 'planned')}">${escapeHtml(setup.status || 'planned')}</span>
      </div>
      <dl class="ssh-readiness-meta">
        <div>
          <dt>Profile</dt>
          <dd>${escapeHtml(setup.profileId || '-')}</dd>
        </div>
        <div>
          <dt>Plan</dt>
          <dd>${escapeHtml(setup.planId || '-')}</dd>
        </div>
        <div>
          <dt>Runner</dt>
          <dd>${escapeHtml(setup.runnerSessionId || '-')}</dd>
        </div>
        <div>
          <dt>Job</dt>
          <dd>${escapeHtml(setup.jobId || '-')}</dd>
        </div>
        <div>
          <dt>Report</dt>
          <dd>${escapeHtml(setup.reportId || '-')}</dd>
        </div>
        <div>
          <dt>AWX</dt>
          <dd>${escapeHtml(`${setup.providerId || 'env/default'} / ${setup.awxCheckStatus || 'not-checked'}`)}</dd>
        </div>
      </dl>
      <div class="shadow-step-grid">
        ${steps.map((step) => `
          <article data-status="${escapeHtml(normalizeStageStatus(step.status))}">
            <span>${escapeHtml(step.stepId || 'step')}</span>
            <strong>${escapeHtml(step.status || 'unknown')}</strong>
            <small>${escapeHtml(step.objectId || '-')}</small>
          </article>
        `).join('')}
      </div>
      ${blockedReasons.length ? `<ul class="ssh-readiness-failures">${blockedReasons.map((reason) => `<li>${escapeHtml(reason)}</li>`).join('')}</ul>` : ''}
      ${warnings.length ? `<p class="awx-provider-warning">${escapeHtml(warnings[0])}</p>` : ''}
    </section>
  `;
}

function renderSshProfileReadiness() {
  const readiness = state.sshProfileReadiness;
  const selectedProfileId = selectedSshProfileId();
  const status = readiness?.status || (selectedProfileId ? 'idle' : 'none');
  sshReadinessStatus.textContent = status;
  sshReadinessStatus.dataset.health = normalizeStageStatus(status);
  if (!selectedProfileId) {
    sshProfileReadiness.innerHTML = '<div class="empty-state">No SSH profile selected</div>';
    return;
  }
  if (!readiness) {
    sshProfileReadiness.innerHTML = '<div class="empty-state">No readiness check</div>';
    return;
  }
  const gates = sshReadinessGateCards(readiness);
  const failures = [
    ...asArray(readiness.gateFailures),
    ...asArray(readiness.executionFailures)
  ];
  sshProfileReadiness.innerHTML = `
    <section class="workflow-stepper readiness-stepper" aria-label="SSH readiness gates">
      ${gates.map((gate, index) => `
        <div class="workflow-step" data-status="${escapeHtml(normalizeStageStatus(gate.status))}">
          <span class="workflow-step-index">${index + 1}</span>
          <strong>${escapeHtml(gate.label)}</strong>
          <small>${escapeHtml(gate.detail)}</small>
        </div>
      `).join('')}
    </section>
    <dl class="ssh-readiness-meta">
      <div>
        <dt>Mode</dt>
        <dd>${escapeHtml(readiness.mode || '-')}</dd>
      </div>
      <div>
        <dt>Boundary</dt>
        <dd>${escapeHtml(readiness.boundary || '-')}</dd>
      </div>
      <div>
        <dt>Execution</dt>
        <dd>${escapeHtml(readiness.execution || '-')}</dd>
      </div>
      <div>
        <dt>Policy</dt>
        <dd>${escapeHtml(formatRuntimePolicy(readiness.gates?.configGate?.policy || state.sshRuntimePolicy))}</dd>
      </div>
    </dl>
    <pre class="ssh-readiness-command">${escapeHtml(readiness.command || '-')}</pre>
    ${readiness.executionResult ? `
      <div class="ssh-readiness-output">
        <pre>${escapeHtml(readiness.executionResult.stdout || '')}</pre>
        <pre>${escapeHtml(readiness.executionResult.stderr || '')}</pre>
      </div>
    ` : ''}
    ${failures.length ? `
      <ul class="ssh-readiness-failures">
        ${failures.slice(0, 5).map((failure) => `<li>${escapeHtml(failure)}</li>`).join('')}
      </ul>
    ` : ''}
  `;
}

function sshReadinessGateCards(readiness) {
  const gates = readiness.gates || {};
  const envGate = gates.envGate || {};
  const configGate = gates.configGate || {};
  const requestGate = gates.requestGate || {};
  const profileStatus = asArray(readiness.gateFailures).length > 0 ? 'blocked' : readiness.status;
  return [
    {
      label: 'Profile',
      status: profileStatus,
      detail: `${readiness.sshProfile?.sshUser || '-'}@${readiness.sshProfile?.host || '-'}:${readiness.sshProfile?.sshPort || '-'}`
    },
    {
      label: 'Env',
      status: envGate.status || 'planned',
      detail: envGate.value || 'missing'
    },
    {
      label: 'Config',
      status: configGate.status || 'planned',
      detail: formatRuntimePolicy(configGate.policy || state.sshRuntimePolicy)
    },
    {
      label: 'Request',
      status: requestGate.status || 'planned',
      detail: requestGate.executeReadOnlyProbe ? 'execute' : 'plan-only'
    }
  ];
}

function formatRuntimePolicy(policy) {
  if (!policy) return 'missing';
  return `${policy.scopeKind || 'scope'} / ${policy.mode || 'mode'}`;
}

function selectedSshProfileId() {
  return sshProfileId.value.trim() || state.selectedSshProfileId || '';
}

function activeAwxProviderForKind(kind) {
  const items = asArray(state.awxProviders);
  return items.find((provider) => provider.status === 'active' && provider.defaultKind === kind)
    || items.find((provider) => provider.status === 'active' && provider.defaultKind === 'all')
    || items.find((provider) => provider.status === 'active')
    || items[0]
    || null;
}

const awxApiActionIds = new Set([
  'site-slot.worker-run.awx-sync-plan',
  'site-slot.worker-run.awx-credential-sync',
  'site-slot.worker-run.awx-object-sync',
  'site-slot.worker-run.awx-launch'
]);

const awxApiTokenActionIds = new Set([
  'site-slot.worker-run.awx-credential-sync',
  'site-slot.worker-run.awx-object-sync',
  'site-slot.worker-run.awx-launch'
]);

const awxRuntimeGateDescriptors = [
  {
    featureKey: 'site-slot.awx.credential-sync',
    label: 'Credential Sync',
    envKey: 'AWX_API_CREDENTIAL_SYNC_ENABLED'
  },
  {
    featureKey: 'site-slot.awx.object-sync',
    label: 'Object Sync',
    envKey: 'AWX_API_OBJECT_SYNC_ENABLED'
  },
  {
    featureKey: 'site-slot.awx.launch',
    label: 'AWX Launch',
    envKey: 'AWX_API_LAUNCH_ENABLED'
  }
];

function isAwxApiAction(action) {
  return awxApiActionIds.has(action?.actionId);
}

function awxActionNeedsToken(action) {
  return awxApiTokenActionIds.has(action?.actionId);
}

function awxActionKind() {
  const kind = state.currentPipeline?.summary?.kind || state.currentPipeline?.plan?.kind || awxProviderKind.value;
  return kind === 'domestic' ? 'domestic' : 'oversea';
}

function awxProviderById(providerId) {
  if (!providerId) return null;
  return asArray(state.awxProviders).find((provider) => provider.providerId === providerId) || null;
}

function selectedAwxProviderForAction(action) {
  if (!isAwxApiAction(action)) return null;
  const kind = awxActionKind();
  const selected = awxProviderById(state.awxActionDraft.providerId)
    || awxProviderById(state.selectedAwxProviderId);
  if (selected && (selected.defaultKind === kind || selected.defaultKind === 'all')) return selected;
  return activeAwxProviderForKind(kind);
}

function awxActionDefaultProviderId(action) {
  return selectedAwxProviderForAction(action)?.providerId || blankToNull(awxProviderId.value) || '';
}

function awxActionDefaultTimeout(action, body = {}) {
  const bodyTimeout = positiveNumberOrNull(body.timeoutSeconds);
  if (bodyTimeout) return bodyTimeout;
  const providerTimeout = positiveNumberOrNull(selectedAwxProviderForAction(action)?.requestTimeoutSeconds);
  if (providerTimeout) return providerTimeout;
  return action?.actionId === 'site-slot.worker-run.awx-launch' ? 180 : 120;
}

function prepareAwxActionDraft(action, body = {}) {
  if (!isAwxApiAction(action)) return;
  state.awxActionDraft = {
    providerId: String(body.awxProviderId || body.providerId || awxActionDefaultProviderId(action) || ''),
    token: state.awxActionDraft.token || blankToNull(awxProviderToken.value) || '',
    timeoutSeconds: String(awxActionDefaultTimeout(action, body)),
    waitForCompletion: body.waitForCompletion !== false
  };
}

function awxActionBodyDefaults(action, body) {
  if (!isAwxApiAction(action) || !body || typeof body !== 'object') return body;
  const next = { ...body };
  const providerId = next.awxProviderId || next.providerId || awxActionDefaultProviderId(action);
  if (providerId) next.awxProviderId = providerId;
  if (!positiveNumberOrNull(next.timeoutSeconds)) {
    next.timeoutSeconds = awxActionDefaultTimeout(action, next);
  }
  if (action.actionId === 'site-slot.worker-run.awx-launch' && next.waitForCompletion === undefined) {
    next.waitForCompletion = true;
  }
  return next;
}

function awxActionBodyForExecution(action, body) {
  if (!isAwxApiAction(action)) return body;
  const next = awxActionBodyDefaults(action, body);
  const providerId = blankToNull(state.awxActionDraft.providerId) || awxActionDefaultProviderId(action);
  const timeoutSeconds = positiveNumberOrNull(state.awxActionDraft.timeoutSeconds);
  const token = state.awxActionDraft.token || blankToNull(awxProviderToken.value);
  if (providerId) next.awxProviderId = providerId;
  if (timeoutSeconds) next.timeoutSeconds = timeoutSeconds;
  if (awxActionNeedsToken(action) && token) next.awxToken = token;
  if (action.actionId === 'site-slot.worker-run.awx-launch') {
    next.waitForCompletion = state.awxActionDraft.waitForCompletion !== false;
  }
  return next;
}

async function fetchJson(path, options = {}) {
  const base = normalizedServerBase();
  const body = options.body ? JSON.stringify(options.body) : undefined;
  const url = `${base}${path}`;
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body
    });
  } catch (error) {
    throw new Error(`Admin API network error: ${url} (${error.message})`);
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('Admin API returned invalid JSON');
  }
  if (!response.ok) {
    throw new Error(payload && payload.message ? payload.message : `HTTP ${response.status}`);
  }
  return payload;
}

function normalizedServerBase() {
  const raw = normalizeServerBaseValue(serverInput.value);
  return raw || defaultServerBaseUrl();
}

function isK8sInternalServiceBaseUrl(value) {
  const raw = normalizeServerBaseValue(value);
  if (!raw) return false;
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host.endsWith('.svc.cluster.local') || host.endsWith('.svc') || host.includes('.svc.');
  } catch {
    return false;
  }
}

function normalizeWorkerBaseValue(value) {
  const raw = normalizeServerBaseValue(value);
  if (!raw || isK8sInternalServiceBaseUrl(raw)) return '';
  return raw;
}

function defaultWorkerInternalBaseUrl() {
  // Admin-triggered workers are spawned beside the Internal API process.
  // Use loopback by default so the worker does not depend on WG, LAN, or K8s DNS.
  return LOCAL_SERVER_BASE_URL;
}

function workerInternalBaseUrl() {
  const raw = normalizeWorkerBaseValue(sshProfileWorkerInternalUrl?.value);
  return raw || defaultWorkerInternalBaseUrl();
}

function overseaCallbackBaseUrlFromForm() {
  const raw = normalizeServerBaseValue(sshProfileOverseaCallbackUrl?.value);
  return raw || null;
}

function renderStatus(status) {
  if (status.connectionState === 'error') {
    setConnection('error', 'Missing service', 'Service required');
    return;
  }
  setConnection('idle', 'Ready', status.service && status.service.installed ? 'Service installed' : 'Waiting for service');
}

function setConnection(stateName, label, description) {
  stateChip.textContent = label;
  stateChip.dataset.state = stateName;
  platformStatus.textContent = description;
}

function renderPrimaryNav() {
  for (const group of navGroups) {
    group.classList.remove('is-active');
  }
  for (const tab of tabs) {
    const active = state.activeView === 'app-center'
      ? tab.dataset.view === 'app-center' && (tab.dataset.appNode || APP_CENTER_PRODUCT_ID) === state.activeAppNode
      : tab.dataset.view === 'admin' && adminMenuFromElement(tab) === state.adminMenu;
    tab.classList.toggle('is-active', active);
    const group = tab.closest('.nav-group');
    if (active && group) group.classList.add('is-active');
    if (tab.dataset.view === 'admin') {
      const menuName = adminMenuFromElement(tab);
      const collapsed = adminNavIsCollapsed(menuName);
      tab.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      tab.closest('.nav-group')?.classList.toggle('is-group-collapsed', collapsed);
      const disclosure = tab.querySelector('.nav-disclosure');
      if (disclosure) disclosure.textContent = collapsed ? '⌄' : '⌃';
    }
  }
}

function renderAdminShell() {
  renderInspectorChrome();
  renderPrimaryNav();
  renderAdminSubnav();
  const menu = adminMenuMeta[state.adminMenu] || adminMenuMeta.operations;
  if (adminHeading) adminHeading.textContent = menu.heading;
  renderAdminSectionHeadings();
  for (const section of adminSections) {
    const active = section.id === `admin-section-${state.adminSection}`;
    section.classList.toggle('is-active', active);
    section.hidden = !active;
  }
  if (state.adminSection === 'deployment') {
    const label = deploymentKindLabel(state.deploymentKind);
    deploymentTitle.textContent = `${label} Deployment`;
    deploymentSubtitle.textContent = deploymentKindSubtitle(state.deploymentKind);
    if (state.deploymentKind === 'domestic' || state.deploymentKind === 'oversea') {
      syncSshProfileFormForDeploymentKind(state.deploymentKind);
    }
  }
}

function deploymentKindLabel(kind) {
  if (kind === 'internal') return 'Internal';
  return kind === 'domestic' ? 'Domestic' : 'Oversea';
}

function deploymentKindSubtitle(kind) {
  if (kind === 'internal') return 'Internal runtime host 安装 service peer，作为 10.88.88.88 接入 Domestic WG relay。';
  return kind === 'domestic'
    ? 'Domestic 负责 WG relay、H2I proxy、Internal DNS 可达性和缓存/观测转发。'
    : 'Oversea 负责 Docker hysteria2、site-agent、runner-worker；mihomo authority 留在 Internal。';
}

function renderInspectorChrome() {
  if (!adminConsole || !adminInspector || !inspectorToggle) return;
  adminConsole.classList.toggle('is-inspector-collapsed', state.inspectorCollapsed);
  adminInspector.classList.toggle('is-collapsed', state.inspectorCollapsed);
  inspectorToggle.setAttribute('aria-expanded', state.inspectorCollapsed ? 'false' : 'true');
  inspectorToggle.setAttribute('aria-label', state.inspectorCollapsed ? 'Expand inspector' : 'Collapse inspector');
  inspectorToggle.setAttribute('title', state.inspectorCollapsed ? 'Expand inspector' : 'Collapse inspector');
  inspectorToggle.textContent = state.inspectorCollapsed ? '←' : '→';
}

function renderAdminSubnav() {
  if (!adminSubnav) return;
  const displayMenuName = state.hoverAdminMenu || state.adminMenu;
  const flyout = state.sidebarCollapsed;
  const visible = state.activeView === 'admin' || Boolean(state.hoverAdminMenu);
  const collapsed = !flyout && adminNavIsCollapsed(displayMenuName);
  const menu = adminMenuMeta[displayMenuName] || adminMenuMeta.operations;
  const anchor = tabs.find((tab) => tab.dataset.view === 'admin' && (tab.dataset.adminMenu || 'operations') === displayMenuName);
  if (anchor && adminSubnav.previousElementSibling !== anchor) {
    anchor.insertAdjacentElement('afterend', adminSubnav);
  }
  if (anchor) {
    adminSubnav.style.setProperty('--admin-subnav-top', `${anchor.offsetTop}px`);
  }
  adminSubnav.hidden = !visible || collapsed;
  adminSubnav.dataset.menu = displayMenuName;
  adminSubnav.dataset.flyout = flyout ? 'true' : 'false';
  adminSubnav.setAttribute('aria-label', `${menu.heading} modules`);
  adminSubnav.classList.toggle('is-collapsed', collapsed);
  if (adminSubnavKicker) adminSubnavKicker.textContent = menu.kicker;
  if (adminSubnavTitle) adminSubnavTitle.textContent = menu.title;
  for (const tab of adminModuleTabs) {
    const menuName = tab.dataset.adminMenu || 'operations';
    const section = tab.dataset.adminSection || 'deployment';
    const kind = tab.dataset.deploymentKind || '';
    const subsection = tab.dataset.adminSubsection || 'overview';
    tab.hidden = menuName !== displayMenuName;
    tab.classList.toggle(
      'is-active',
      displayMenuName === state.adminMenu
        && menuName === state.adminMenu
        && section === state.adminSection
        && (section !== 'deployment' || kind === state.deploymentKind)
        && subsection === state.adminSubsection
    );
  }
  if (adminSubnavItems) adminSubnavItems.hidden = false;
}

function renderAdminSectionHeadings() {
  const foundationMeta = internalSubsectionMeta[state.adminSubsection] || internalSubsectionMeta.overview;
  if (foundationHeading) foundationHeading.textContent = foundationMeta.title;
  if (foundationSubtitle) foundationSubtitle.textContent = foundationMeta.subtitle;
  const evidenceMeta = evidenceSubsectionMeta[state.adminSubsection] || evidenceSubsectionMeta.overview;
  if (evidenceHeading) evidenceHeading.textContent = evidenceMeta.title;
  if (evidenceSubtitle) evidenceSubtitle.textContent = evidenceMeta.subtitle;
}

function activePipelineForCurrentDeployment(pipelines) {
  const kind = deploymentPipelineKind();
  const sites = deploymentSites(pipelines, kind);
  const selectedSite = state.selectedSiteId
    ? sites.find((site) => site.siteId === state.selectedSiteId) || null
    : null;
  const preferredSite = preferredDeploymentSite(sites, kind);
  if (shouldPromotePreferredDeploymentSite(selectedSite, preferredSite, kind)) {
    return preferredSite?.activePipeline || null;
  }
  return selectedSite?.activePipeline || preferredSite?.activePipeline || null;
}

function activePipelineForSite(pipelines, kind, siteId) {
  if (!siteId) return null;
  const pipelineKind = deploymentPipelineKind(kind);
  return deploymentSites(pipelines, pipelineKind)
    .find((site) => site.siteId === siteId)?.activePipeline || null;
}

function selectedOrActivePipelineForCurrentDeployment(pipelines) {
  const kind = deploymentPipelineKind();
  const selected = state.selectedPlanId
    ? asArray(pipelines).find((pipeline) => pipeline.kind === kind && pipeline.planId === state.selectedPlanId)
    : null;
  const preferredSite = preferredDeploymentSite(deploymentSites(pipelines, kind), kind);
  if (
    selected
    && !(kind === 'domestic' && isSmokeDeploymentSite(selected.siteId) && preferredSite && !isSmokeDeploymentSite(preferredSite.siteId))
  ) {
    return selected;
  }
  return activePipelineForCurrentDeployment(pipelines);
}

function deploymentPipelineKind(kind = state.deploymentKind) {
  return kind === 'internal' ? 'domestic' : kind;
}

function isSmokeDeploymentSite(siteId) {
  return String(siteId || '').toLowerCase().includes('smoke');
}

function deploymentSiteSortPriority(site, kind) {
  if (kind !== 'domestic') return 0;
  const siteId = String(site?.siteId || '');
  if (siteId === 'domestic-main') return 0;
  return isSmokeDeploymentSite(siteId) ? 2 : 1;
}

function preferredDeploymentSite(sites, kind) {
  const items = asArray(sites);
  if (kind !== 'domestic') return items[0] || null;
  return items.find((site) => site.siteId === 'domestic-main')
    || items.find((site) => !isSmokeDeploymentSite(site.siteId))
    || items[0]
    || null;
}

function shouldPromotePreferredDeploymentSite(selectedSite, preferredSite, kind) {
  if (!preferredSite) return false;
  if (!selectedSite) return true;
  if (kind !== 'domestic') return false;
  return isSmokeDeploymentSite(selectedSite.siteId) && !isSmokeDeploymentSite(preferredSite.siteId);
}

function deploymentSites(pipelines, kind) {
  const bySite = new Map();
  for (const pipeline of asArray(pipelines).filter((item) => item.kind === kind)) {
    const site = bySite.get(pipeline.siteId) || {
      siteId: pipeline.siteId,
      kind,
      pipelines: [],
      activePipeline: null,
      latestPipeline: null
    };
    site.pipelines.push(pipeline);
    site.latestPipeline = latestPipeline([site.latestPipeline, pipeline].filter(Boolean));
    site.activePipeline = chooseOperationalPipeline(site.pipelines);
    bySite.set(site.siteId, site);
  }
  return [...bySite.values()].sort((left, right) => {
    const leftPriority = deploymentSiteSortPriority(left, kind);
    const rightPriority = deploymentSiteSortPriority(right, kind);
    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    if (left.siteId === state.selectedSiteId) return -1;
    if (right.siteId === state.selectedSiteId) return 1;
    return String(right.latestPipeline?.latestUpdatedAt || '').localeCompare(String(left.latestPipeline?.latestUpdatedAt || ''));
  });
}

function chooseOperationalPipeline(pipelines) {
  const items = asArray(pipelines);
  const actionable = items.filter((pipeline) => {
    const actions = asArray(pipeline.actionHints);
    return actions.some((action) => action.allowed) && !isFailedOrRollbackPipeline(pipeline);
  });
  const openDeployment = items.filter((pipeline) => {
    return !isRollbackPipeline(pipeline) && !['passed', 'failed', 'rollback'].includes(pipeline.health);
  });
  const passedDeployment = items.filter((pipeline) => pipeline.health === 'passed' && !isRollbackPipeline(pipeline));
  const nonRollback = items.filter((pipeline) => !isRollbackPipeline(pipeline));
  const preferred = actionable.length
    ? actionable
    : openDeployment.length
      ? openDeployment
      : passedDeployment.length
        ? passedDeployment
        : nonRollback.length
          ? nonRollback
          : items;
  return preferred
    .slice()
    .sort((left, right) => pipelineOperationalScore(right) - pipelineOperationalScore(left)
      || String(right.latestUpdatedAt || '').localeCompare(String(left.latestUpdatedAt || '')))[0] || null;
}

function isRollbackPipeline(pipeline) {
  const stage = String(pipeline?.currentStage || '');
  return pipeline?.health === 'rollback' || stage.startsWith('rollback-');
}

function isFailedOrRollbackPipeline(pipeline) {
  return pipeline?.health === 'failed' || isRollbackPipeline(pipeline);
}

function pipelineFailureSummaryObject(pipelineOrSummary) {
  const summary = pipelineOrSummary?.summary || pipelineOrSummary || {};
  const failure = summary.failureSummary || null;
  return failure && typeof failure === 'object' ? failure : null;
}

function renderPipelineFailureSummary(pipelineOrSummary, options = {}) {
  const failure = pipelineFailureSummaryObject(pipelineOrSummary);
  if (!failure) return '';
  const label = failure.stepId || failure.phase || 'failed step';
  const status = failure.status || 'failed';
  const classes = ['pipeline-failure-summary'];
  if (options.compact) classes.push('is-compact');
  return `
    <div class="${classes.join(' ')}" data-status="${escapeHtml(status)}">
      <strong>${escapeHtml(label)} ${escapeHtml(status)}</strong>
      <span>${escapeHtml(failure.message || 'worker step failed')}</span>
    </div>
  `;
}

function latestPipeline(pipelines) {
  return asArray(pipelines)
    .slice()
    .sort((left, right) => String(left?.latestUpdatedAt || '').localeCompare(String(right?.latestUpdatedAt || '')))
    .pop() || null;
}

function pipelineOperationalScore(pipeline) {
  const stageScore = {
    'worker-report': 70,
    'worker-job': 90,
    'runner-session': 80,
    execution: 60,
    plan: 40,
    'rollback-report': 10,
    'rollback-execution': 20
  }[pipeline.currentStage] || 0;
  return stageScore + Math.min(pipelineObjectCount(pipeline), 10);
}

function pipelineObjectCount(pipeline) {
  const counts = pipeline?.counts || {};
  return Number(counts.executions || 0)
    + Number(counts.runnerSessions || 0)
    + Number(counts.workerJobs || 0)
    + Number(counts.workerReports || 0)
    + Number(counts.rollbackExecutions || 0)
    + Number(counts.rollbackReports || 0);
}

function renderDeploymentWorkbench(pipelines) {
  if (state.deploymentKind === 'internal') {
    renderInternalPeerWorkbench(pipelines);
    return;
  }
  if (state.deploymentKind === 'oversea') {
    renderOverseaWorkbench(pipelines);
    return;
  }
  const sites = deploymentSites(pipelines, state.deploymentKind);
  deploymentSiteCount.textContent = `${sites.length} sites`;
  const selectedSite = state.selectedSiteId
    ? sites.find((item) => item.siteId === state.selectedSiteId) || null
    : null;
  const preferredSite = preferredDeploymentSite(sites, state.deploymentKind);
  if (shouldPromotePreferredDeploymentSite(selectedSite, preferredSite, state.deploymentKind)) {
    state.selectedSiteId = preferredSite.siteId;
    state.selectedPlanId = null;
  } else if (!state.selectedSiteId && preferredSite) {
    state.selectedSiteId = preferredSite.siteId;
  }
  const site = sites.find((item) => item.siteId === state.selectedSiteId) || preferredSite || sites[0] || null;
  if (!site?.activePipeline) {
    siteWorkbench.innerHTML = `<div class="empty-state">No ${escapeHtml(state.deploymentKind)} site yet</div>`;
    renderInspector();
    return;
  }
  syncSshProfileFormToSelectedSite(site.siteId, site.kind);
  const pipeline = hydratePipelineForWorkbench(site.activePipeline);
  siteWorkbench.innerHTML = `
    <section class="site-hero">
      <div>
        <span class="site-kind">${escapeHtml(site.kind)}</span>
        <h4>${escapeHtml(site.siteId)}</h4>
        <p>${escapeHtml(siteDescription(site.kind))}</p>
      </div>
      <span class="health-chip" data-health="${escapeHtml(pipeline.health)}">${escapeHtml(pipeline.health)}</span>
    </section>
    <div class="site-facts">
      <span><strong>${escapeHtml(pipeline.currentStage)}</strong><small>stage</small></span>
      <span><strong>${escapeHtml(pipeline.latestStatus)}</strong><small>status</small></span>
      <span><strong>${pipelineObjectCount(pipeline)}</strong><small>active objects</small></span>
      <span><strong>${site.pipelines.length}</strong><small>history runs</small></span>
    </div>
    ${renderPipelineFailureSummary(pipeline)}
    ${renderDomesticRelayPanel(site, pipeline)}
    ${renderDomesticRuntimeConfigPanel()}
  `;
  bindDomesticWorkbenchActions(site);
  bindDomesticRuntimeControls(siteWorkbench);
  renderInspector();
}

function renderInternalPeerWorkbench(pipelines) {
  const sites = deploymentSites(pipelines, 'domestic');
  deploymentSiteCount.textContent = `${sites.length} domestic relay${sites.length === 1 ? '' : 's'}`;
  const selectedSite = sites.find((item) => item.siteId === state.selectedSiteId) || null;
  const preferredSite = preferredDeploymentSite(sites, 'domestic');
  const passedRealSite = sites.find((item) => item.activePipeline?.health === 'passed' && !isSmokeDeploymentSite(item.siteId))
    || null;
  const passedSite = passedRealSite
    || sites.find((item) => item.activePipeline?.health === 'passed')
    || null;
  const selectedRealSite = selectedSite && !isSmokeDeploymentSite(selectedSite.siteId) ? selectedSite : null;
  const site = passedRealSite
    || selectedRealSite
    || preferredSite
    || (selectedSite?.activePipeline?.health === 'passed' ? selectedSite : null)
    || passedSite
    || selectedSite
    || sites[0]
    || null;
  if (site && state.selectedSiteId !== site.siteId) {
    state.selectedSiteId = site.siteId;
    state.selectedPlanId = null;
  }
  if (!site?.activePipeline) {
    siteWorkbench.innerHTML = '<div class="empty-state">No Domestic relay is ready for Internal service peer handoff</div>';
    renderInspector();
    return;
  }
  const pipeline = hydratePipelineForWorkbench(site.activePipeline);
  if (!state.selectedPlanId) state.selectedPlanId = pipeline.planId;
  scheduleInternalPeerRuntimeStatusRefresh(site, pipeline);
  const detailedPipeline = state.currentPipeline?.summary?.planId === pipeline?.planId ? state.currentPipeline : null;
  const plan = detailedPipeline?.plan || pipeline?.plan || {};
  const materializeAction = domesticWgMaterializeActionFromSummary(pipeline);
  const feedback = state.internalPeer.feedback;
  const result = state.internalPeer.result;
  const endpoint = result?.relay?.publicEndpoint || domesticEndpointFromPlan(plan, pipeline);
  const endpointBlockedReason = endpoint ? domesticEndpointBlockedReason(endpoint) : null;
  const profile = inspectorSshProfile('domestic', site.siteId);
  const canCreatePlan = Boolean(profile?.profileId);
  const runtimeStatus = state.internalPeer.runtimeStatus;
  const applyResult = state.internalPeer.applyResult;
  const keySyncResult = state.internalPeer.keySyncResult;
  const directSettings = internalPeerDirectSettings(pipeline);
  const directUi = internalPeerDirectUiState(directSettings, runtimeStatus);
  const directStatus = directUi.status;
  const directLabel = directUi.label;
  const wgServiceLabel = runtimeStatus?.ownership?.owner === 'host-systemd'
    ? 'host systemd wg-quick / mx-internal-svc'
    : '@qpjoy/electron-core-wireguard / mx-internal-svc';
  const handoffDisabled = state.internalPeer.busy || Boolean(materializeAction) || Boolean(endpointBlockedReason);
  const materializeDisabled = state.internalPeer.materializeBusy || !materializeAction?.allowed || Boolean(endpointBlockedReason);
  const keySyncDisabled = state.internalPeer.syncBusy || Boolean(endpointBlockedReason);
  const hostRunnerOffline = internalPeerHostRunnerOffline(runtimeStatus);
  const installUnavailable = internalPeerInstallUnavailable(runtimeStatus);
  const installDisabled = state.internalPeer.applyBusy || installUnavailable;
  const canEnsureK8sHostRunner = hostRunnerOffline && internalPeerCanEnsureK8sHostRunner(runtimeStatus);
  const hostRunnerEnsureDisabled = state.internalPeer.hostRunnerEnsureBusy || !canEnsureK8sHostRunner;
  const hostRunnerCommand = internalPeerHostRunnerCommand(runtimeStatus);
  const hostRunnerSetupDetail = internalPeerHostRunnerSetupDetail(runtimeStatus);
  const runtimeBlocked = hostRunnerOffline || runtimeStatus?.status === 'blocked' || installUnavailable;
  const panelStatus = materializeAction
    ? 'blocked'
    : endpointBlockedReason
      ? 'blocked'
      : result?.status === 'blocked' && !runtimeStatus
        ? 'blocked'
        : runtimeBlocked
          ? 'blocked'
          : runtimeStatus?.status === 'passed'
            ? 'passed'
            : runtimeStatus?.status === 'ready'
              ? 'ready'
              : result?.status || (pipeline.health === 'passed' ? 'ready' : pipeline.health);
  const handoffHeading = materializeAction
    ? 'Domestic WG materialize required'
    : endpointBlockedReason
      ? 'Domestic endpoint required'
      : result?.status === 'ready'
        ? 'handoff ready'
        : result?.status === 'blocked' && !runtimeStatus
          ? 'handoff blocked'
          : runtimeBlocked
            ? 'runtime host blocked'
            : runtimeStatus?.status === 'passed'
              ? 'Internal service peer ready'
              : 'Generate Internal peer handoff';
  const materializeFeedback = materializeAction && !feedback
    ? { kind: materializeAction.allowed ? 'warning' : 'error', message: materializeAction.allowed ? 'Materialize Domestic WG before generating handoff' : materializeAction.reason || 'Domestic WG materialize is locked', detail: null }
    : endpointBlockedReason && !feedback
      ? { kind: 'warning', message: endpointBlockedReason, detail: canCreatePlan ? `Create a new Domestic 2.0 plan from SSH Profile ${profile.profileId}, then Generate Handoff.` : 'Open SSH Access and save the real Domestic public host first.' }
    : hostRunnerOffline && !feedback
      ? { kind: 'warning', message: 'Handoff is ready; install or start the native Internal host runner, then Install / Restart assigns 10.88.88.88.', detail: hostRunnerSetupDetail }
    : null;
  const handoffDescription = materializeAction
    ? '当前 Domestic WG secret/artifact 与选中的 plan 不一致，先重新 materialize，再生成 Internal handoff。'
    : endpointBlockedReason
      ? '当前 Domestic endpoint 仍是模板或本机地址。先用真实公网 IP/DNS 创建新的 Domestic 2.0 plan，或重新 Materialize Domestic WG。'
      : 'Generate Handoff only creates the Internal WG artifact. Ensure the host runner on the Internal host, then Install / Restart enables qp-tunnel-cli egress-on, installs WG, and assigns 10.88.88.88.';
  const displayedFeedback = feedback || materializeFeedback;
  const resultDetail = result || keySyncResult ? formatJson({
    handoff: result ? {
      status: result.status,
      execution: result.execution,
      command: result.command,
      env: result.env,
      config: result.config,
      relay: result.relay,
      blockedReasons: result.blockedReasons || [],
      checks: result.checks || [],
      nextActions: result.nextActions || []
    } : null,
    domesticKeySync: keySyncResult ? {
      status: keySyncResult.status,
      execution: keySyncResult.execution,
      internal: keySyncResult.internal,
      domestic: keySyncResult.domestic,
      warnings: keySyncResult.warnings || [],
      blockedReasons: keySyncResult.blockedReasons || [],
      nextActions: keySyncResult.nextActions || [],
      materialize: keySyncResult.materialize ? {
        status: keySyncResult.materialize.status,
        execution: keySyncResult.materialize.execution,
        endpointChanged: keySyncResult.materialize.endpointChanged,
        clientRefresh: keySyncResult.materialize.clientRefresh,
        blockedReasons: keySyncResult.materialize.blockedReasons || []
      } : null
    } : null
  }) : '';
  const runtimeDetail = runtimeStatus || applyResult ? formatJson({
    runtimeStatus,
    applyResult
  }) : '';
  siteWorkbench.innerHTML = `
    <section class="site-hero">
      <div>
        <span class="site-kind">Internal service peer</span>
        <h4>mx-internal-service-peer</h4>
        <p>${escapeHtml(site.siteId)} supplies the relay endpoint; Internal runtime host receives 10.88.88.88 after Install / Restart.</p>
      </div>
      <span class="health-chip" data-health="${escapeHtml(panelStatus)}">${escapeHtml(panelStatus)}</span>
    </section>
    <div class="site-facts">
      <span><strong>10.88.88.88</strong><small>Internal service IP</small></span>
      <span><strong>10.88.0.1</strong><small>Domestic relay IP</small></span>
      <span><strong>${escapeHtml(endpoint || 'host:51280')}</strong><small>WG endpoint</small></span>
      <span><strong>${escapeHtml(directSettings.endpoint || `${directSettings.listenPort}/listener`)}</strong><small>H2I direct</small></span>
    </div>
    <section class="internal-peer-panel" data-status="${escapeHtml(panelStatus)}">
      <div class="domestic-relay-head">
        <div>
          <span class="site-kind">Runtime host handoff</span>
          <strong>${escapeHtml(handoffHeading)}</strong>
          <p>${escapeHtml(handoffDescription)}</p>
        </div>
        <div class="domestic-relay-actions">
          ${materializeAction ? `<button class="primary-button" type="button" data-internal-peer-materialize ${materializeDisabled ? 'disabled' : ''} title="${escapeHtml(endpointBlockedReason || materializeAction.reason || 'Materialize Domestic WG')}">${state.internalPeer.materializeBusy ? 'Materializing' : 'Materialize Domestic WG'}</button>` : ''}
          ${endpointBlockedReason ? `<button class="primary-button" type="button" data-internal-peer-create-plan ${canCreatePlan && !state.sshPlanBusy ? '' : 'disabled'}>${state.sshPlanBusy ? 'Creating' : 'New 2.0 Plan'}</button>` : ''}
          <button class="primary-button" type="button" data-internal-peer-handoff ${handoffDisabled ? 'disabled' : ''} title="${escapeHtml(materializeAction ? 'Materialize Domestic WG first' : endpointBlockedReason || 'Generate Internal peer handoff')}">${state.internalPeer.busy ? 'Generating' : 'Generate Handoff'}</button>
          <button class="secondary-button" type="button" data-internal-peer-sync-domestic-key ${keySyncDisabled ? 'disabled' : ''} title="${escapeHtml(endpointBlockedReason || 'Sync Domestic mx-domestic Internal peer key with the current Internal runtime key')}">${state.internalPeer.syncBusy ? 'Syncing' : 'Sync Domestic WG Key'}</button>
          ${hostRunnerOffline
            ? canEnsureK8sHostRunner
              ? `<button class="primary-button" type="button" data-internal-peer-host-runner-ensure ${hostRunnerEnsureDisabled ? 'disabled' : ''} title="Create or update the k8s host-runner fallback DaemonSet">${state.internalPeer.hostRunnerEnsureBusy ? 'Ensuring' : 'Ensure K8s Fallback'}</button>`
              : `<button class="secondary-button" type="button" data-internal-peer-native-runner-guide title="Show native host runner setup command">Native Runner Setup</button>`
            : `<button class="primary-button" type="button" data-internal-peer-apply ${installDisabled ? 'disabled' : ''} title="${escapeHtml(installUnavailable ? 'Runtime install is not ready' : 'Install or restart Internal service peer')}">${state.internalPeer.applyBusy ? 'Installing' : 'Install / Restart'}</button>`}
          <button class="secondary-button" type="button" data-internal-peer-status ${state.internalPeer.statusBusy ? 'disabled' : ''}>${state.internalPeer.statusBusy ? 'Checking' : 'Refresh Status'}</button>
          <button class="secondary-button" type="button" data-internal-open-domestic>Open Domestic</button>
        </div>
      </div>
      <div class="internal-peer-direct-control" data-status="${escapeHtml(directStatus)}">
        <label class="admin-switch" title="Enable Internal as an H2I direct WireGuard listener">
          <input type="checkbox" data-internal-peer-direct-enabled ${directSettings.enabled ? 'checked' : ''} ${state.internalPeer.directModeBusy ? 'disabled' : ''} />
          <span class="admin-switch-track"></span>
        </label>
        <div>
          <strong>H2I direct listener</strong>
          <p>${escapeHtml(directUi.detail)}</p>
        </div>
        <span class="health-chip" data-health="${escapeHtml(directStatus === 'disabled' ? 'ready' : directStatus)}">${escapeHtml(directLabel)}</span>
      </div>
      <div class="domestic-relay-grid">
        <span><small>WG service</small><strong>${escapeHtml(wgServiceLabel)}</strong></span>
        <span data-status="${escapeHtml(directStatus === 'disabled' ? 'ready' : directStatus)}"><small>direct listener</small><strong>${escapeHtml(directUi.gridValue)}</strong></span>
        <span><small>native runner command</small><strong>${escapeHtml(hostRunnerCommand)}</strong></span>
        <span><small>apply artifact</small><strong>artifacts/site-slots/domestic/mx-internal-service-peer-apply.sh</strong></span>
        <span><small>config artifact</small><strong>artifacts/site-slots/domestic/mx-internal-service-peer.conf</strong></span>
        <span><small>runtime route</small><strong>10.88.0.1/32 + 10.88/16 via mx-internal-svc</strong></span>
        <span><small>verification</small><strong>wg active + handshake + Domestic healthz</strong></span>
      </div>
      ${displayedFeedback ? `<div class="action-feedback" data-kind="${escapeHtml(displayedFeedback.kind)}"><strong>${escapeHtml(displayedFeedback.message)}</strong>${displayedFeedback.detail ? `<pre>${escapeHtml(displayedFeedback.detail)}</pre>` : ''}</div>` : ''}
      ${renderInternalPeerRuntimeStatus(runtimeStatus, applyResult)}
      ${resultDetail ? `<pre class="internal-peer-result">${escapeHtml(resultDetail)}</pre>` : ''}
      ${runtimeDetail ? `<pre class="internal-peer-result">${escapeHtml(runtimeDetail)}</pre>` : ''}
    </section>
  `;
  bindInternalPeerWorkbenchActions(site, pipeline);
  renderInspector();
}

function internalPeerDirectSettings(pipeline = null) {
  const summary = pipeline?.domesticWireGuard || {};
  const override = state.internalPeer.directEnabledOverride;
  const backendEnabled = typeof summary.internalDirectEnabled === 'boolean' ? summary.internalDirectEnabled : null;
  const enabled = typeof override === 'boolean'
    ? override
    : typeof backendEnabled === 'boolean'
      ? backendEnabled
      : true;
  const listenPort = Number(summary.internalDirectListenPort || 51280) || 51280;
  return {
    enabled,
    backendEnabled,
    endpoint: typeof summary.internalDirectEndpoint === 'string' ? summary.internalDirectEndpoint : '',
    listenPort,
    internalServiceIp: typeof summary.internalServiceIp === 'string' ? summary.internalServiceIp : '10.88.88.88'
  };
}

function internalPeerDirectUiState(directSettings, runtimeStatus = null) {
  if (!directSettings.enabled) {
    return {
      status: 'disabled',
      label: 'relay fallback',
      detail: 'disabled / Domestic relay fallback',
      gridValue: 'disabled'
    };
  }
  const runtime = runtimeStatus?.directListener || null;
  const configuredPort = runtime?.expectedPort || directSettings.listenPort;
  const livePort = runtime?.livePort || null;
  const endpointText = directSettings.endpoint
    ? `endpoint ${directSettings.endpoint}`
    : 'endpoint not published';
  if (runtime?.status === 'blocked') {
    return {
      status: 'blocked',
      label: 'restart required',
      detail: `enabled / ${runtime.summary || `configured ${configuredPort}, live port mismatch`}`,
      gridValue: runtime.summary || `configured ${configuredPort} / live ${livePort || 'unknown'}`
    };
  }
  if (runtime?.status === 'passed') {
    return {
      status: directSettings.endpoint ? 'passed' : 'ready',
      label: directSettings.endpoint ? 'direct ready' : 'relay path ready',
      detail: `enabled / listening ${livePort || configuredPort}, ${endpointText}`,
      gridValue: `ListenPort ${livePort || configuredPort}`
    };
  }
  return {
    status: 'ready',
    label: directSettings.endpoint ? 'direct endpoint ready' : 'relay endpoint pending',
    detail: `enabled / configured ${configuredPort}, ${endpointText}`,
    gridValue: `configured ${configuredPort}`
  };
}

function internalPeerDirectMaterializeOverrides(pipeline = null) {
  const direct = internalPeerDirectSettings(pipeline);
  return {
    internalDirectEnabled: direct.enabled,
    internalDirectListenPort: direct.listenPort,
    ...(direct.endpoint ? { internalDirectEndpoint: direct.endpoint } : {})
  };
}

function bindInternalPeerWorkbenchActions(site, pipeline) {
  const materializeAction = domesticWgMaterializeActionFromSummary(pipeline);
  const directToggle = siteWorkbench.querySelector('[data-internal-peer-direct-enabled]');
  if (directToggle) {
    directToggle.addEventListener('change', (event) => {
      void saveInternalPeerDirectMode(site, pipeline, event.currentTarget.checked === true);
    });
  }
  const materializeButton = siteWorkbench.querySelector('[data-internal-peer-materialize]');
  if (materializeButton) {
    materializeButton.addEventListener('click', () => {
      if (!materializeAction) return;
      void materializeDomesticWgForInternalPeer(site, pipeline, materializeAction);
    });
  }
  const handoffButton = siteWorkbench.querySelector('[data-internal-peer-handoff]');
  if (handoffButton) {
    handoffButton.addEventListener('click', () => {
      if (materializeAction) return;
      void generateInternalPeerHandoff(site, pipeline);
    });
  }
  const syncDomesticKeyButton = siteWorkbench.querySelector('[data-internal-peer-sync-domestic-key]');
  if (syncDomesticKeyButton) {
    syncDomesticKeyButton.addEventListener('click', () => {
      void syncInternalPeerDomesticKey(site, pipeline);
    });
  }
  const createPlanButton = siteWorkbench.querySelector('[data-internal-peer-create-plan]');
  if (createPlanButton) {
    createPlanButton.addEventListener('click', () => {
      syncSshProfileFormToSelectedSite(site.siteId, 'domestic');
      void createPlanFromSshProfile();
    });
  }
  const statusButton = siteWorkbench.querySelector('[data-internal-peer-status]');
  if (statusButton) {
    statusButton.addEventListener('click', () => {
      void refreshInternalPeerRuntimeStatus(site, pipeline);
    });
  }
  const hostRunnerEnsureButton = siteWorkbench.querySelector('[data-internal-peer-host-runner-ensure]');
  if (hostRunnerEnsureButton) {
    hostRunnerEnsureButton.addEventListener('click', () => {
      void ensureInternalPeerHostRunner(site, pipeline);
    });
  }
  const nativeRunnerGuideButton = siteWorkbench.querySelector('[data-internal-peer-native-runner-guide]');
  if (nativeRunnerGuideButton) {
    nativeRunnerGuideButton.addEventListener('click', () => {
      showInternalPeerNativeRunnerGuide();
    });
  }
  const applyButton = siteWorkbench.querySelector('[data-internal-peer-apply]');
  if (applyButton) {
    applyButton.addEventListener('click', () => {
      void installInternalPeerService(site, pipeline);
    });
  }
  const domesticButton = siteWorkbench.querySelector('[data-internal-open-domestic]');
  if (domesticButton) {
    domesticButton.addEventListener('click', () => {
      state.deploymentKind = 'domestic';
      state.adminSubsection = 'domestic';
      state.selectedSiteId = site.siteId;
      state.selectedPlanId = pipeline.planId;
      state.internalPeer.feedback = null;
      renderAdminShell();
      renderAdminDashboard(state.dashboard);
      void refreshPipelineDetail(pipeline.planId);
    });
  }
}

async function syncInternalPeerDomesticKey(site, pipeline) {
  if (state.internalPeer.syncBusy) return;
  state.internalPeer.syncBusy = true;
  state.internalPeer.feedback = { kind: 'info', message: 'Syncing Domestic WG Internal peer key', detail: null };
  state.internalPeer.keySyncResult = null;
  renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
  try {
    const payload = await fetchJson('/internal/v1/admin/actions/execute', {
      method: 'POST',
      body: {
        actionId: 'site-slot.internal-service-peer.sync-domestic-key',
        path: `/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(site.siteId)}/internal-service-peer-sync-domestic-key`,
        body: {
          siteId: site.siteId,
          planId: pipeline.planId,
          confirmDomesticPeerKeySync: true,
          confirmAdoptDomesticRuntimeRelayPublicKey: true,
          requestedBy: 'desktop-admin',
          requestId: `desktop-internal-service-peer-domestic-key-sync-${Date.now()}`
        }
      }
    });
    const syncResult = payload.internalServicePeerDomesticKeySync || null;
    state.internalPeer.keySyncResult = syncResult;
    state.internalPeer.runtimeStatus = payload.internalServicePeerRuntimeStatus || syncResult?.afterStatus || state.internalPeer.runtimeStatus;
    const warnings = Array.isArray(syncResult?.warnings) && syncResult.warnings.length
      ? syncResult.warnings.join('\n')
      : null;
    state.internalPeer.feedback = {
      kind: syncResult?.status === 'passed' ? 'success' : syncResult?.status === 'blocked' || syncResult?.status === 'ready' ? 'warning' : 'error',
      message: syncResult ? `Domestic WG key sync ${syncResult.status}` : 'Domestic WG key sync finished',
      detail: warnings || summarizeActionDetail(payload)
    };
    await refreshAdmin();
    if (pipeline.planId) {
      await refreshPipelineDetail(pipeline.planId);
    }
  } catch (error) {
    state.internalPeer.feedback = { kind: 'error', message: error.message, detail: null };
  } finally {
    state.internalPeer.syncBusy = false;
    renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
    renderInspector();
  }
}

async function saveInternalPeerDirectMode(site, pipeline, enabled) {
  if (state.internalPeer.directModeBusy) return;
  state.internalPeer.directModeBusy = true;
  state.internalPeer.directEnabledOverride = enabled;
  const direct = internalPeerDirectSettings(pipeline);
  state.internalPeer.feedback = {
    kind: 'info',
    message: `${enabled ? 'Enabling' : 'Disabling'} H2I direct listener`,
    detail: null
  };
  renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
  try {
    const payload = await fetchJson('/internal/v1/config-center/domestic-wg-secrets', {
      method: 'POST',
      body: {
        siteId: site.siteId,
        internalDirectEnabled: enabled,
        internalDirectListenPort: direct.listenPort || 51280,
        requestedBy: 'desktop-admin',
        requestId: `desktop-internal-direct-${enabled ? 'enable' : 'disable'}-${Date.now()}`
      }
    });
    state.internalPeer.feedback = {
      kind: 'success',
      message: `H2I direct listener ${payload.secret?.internalDirectEnabled ? 'enabled' : 'disabled'}`,
      detail: payload.secret?.internalDirectEnabled
        ? [
            `Configured ListenPort ${payload.secret?.internalDirectListenPort || direct.listenPort || 51280}.`,
            'Click Install / Restart to restart mx-internal-svc with the generated WireGuard config.',
            payload.secret?.internalDirectEndpoint
              ? `Endpoint: ${payload.secret.internalDirectEndpoint}`
              : 'Endpoint is not published yet; configure Internal direct endpoint before H clients can bypass Domestic relay.'
          ].join(' ')
        : 'Domestic relay fallback will be used after Install / Restart applies the generated WireGuard config.'
    };
    state.internalPeer.directEnabledOverride = null;
    await refreshAdmin();
    if (pipeline?.planId) await refreshPipelineDetail(pipeline.planId);
  } catch (error) {
    state.internalPeer.feedback = { kind: 'error', message: error.message, detail: null };
  } finally {
    state.internalPeer.directModeBusy = false;
    renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
    renderInspector();
  }
}

async function materializeDomesticWgForInternalPeer(site, pipeline, action) {
  if (state.internalPeer.materializeBusy) return;
  state.internalPeer.materializeBusy = true;
  state.internalPeer.feedback = { kind: 'info', message: 'Materializing Domestic WG for selected plan', detail: null };
  state.internalPeer.result = null;
  renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
  try {
    const payload = await fetchJson('/internal/v1/admin/actions/execute', {
      method: 'POST',
      body: {
        actionId: action.actionId,
        path: action.path,
        body: materializeActionBodyTemplate(action, internalPeerDirectMaterializeOverrides(pipeline))
      }
    });
    const materialize = payload.domesticWgMaterialize || null;
    state.internalPeer.feedback = {
      kind: materialize?.status === 'passed' ? 'success' : materialize?.status === 'blocked' ? 'warning' : 'error',
      message: materialize ? `Domestic WG materialize ${materialize.status}` : 'Domestic WG materialize finished',
      detail: summarizeActionDetail(payload)
    };
    await refreshAdmin();
    if (pipeline.planId) {
      await refreshPipelineDetail(pipeline.planId);
    }
  } catch (error) {
    state.internalPeer.feedback = { kind: 'error', message: error.message, detail: null };
  } finally {
    state.internalPeer.materializeBusy = false;
    renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
    renderInspector();
  }
}

async function generateInternalPeerHandoff(site, pipeline) {
  if (state.internalPeer.busy) return;
  const materializeAction = domesticWgMaterializeActionFromSummary(pipeline);
  if (materializeAction) {
    state.internalPeer.feedback = {
      kind: 'warning',
      message: 'Materialize Domestic WG before generating handoff',
      detail: materializeAction.reason || null
    };
    renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
    renderInspector();
    return;
  }
  const detailedPipeline = state.currentPipeline?.summary?.planId === pipeline?.planId ? state.currentPipeline : null;
  const plan = detailedPipeline?.plan || pipeline?.plan || {};
  const endpoint = domesticEndpointFromPlan(plan, pipeline);
  const endpointBlockedReason = endpoint ? domesticEndpointBlockedReason(endpoint) : null;
  if (endpointBlockedReason) {
    const profile = inspectorSshProfile('domestic', site.siteId);
    state.internalPeer.feedback = {
      kind: 'warning',
      message: endpointBlockedReason,
      detail: profile?.profileId
        ? `Click New 2.0 Plan to use SSH Profile ${profile.profileId}, then Generate Handoff.`
        : 'Open SSH Access and save the real Domestic public host first.'
    };
    renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
    renderInspector();
    return;
  }
  state.internalPeer.busy = true;
  state.internalPeer.feedback = { kind: 'info', message: 'Generating Internal service peer handoff', detail: null };
  state.internalPeer.result = null;
  renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
  try {
    const payload = await fetchJson('/internal/v1/admin/actions/execute', {
      method: 'POST',
      body: {
        actionId: 'site-slot.internal-service-peer.handoff',
        path: `/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(site.siteId)}/internal-service-peer-handoff`,
        body: {
          siteId: site.siteId,
          planId: pipeline.planId,
          confirmInternalServicePeerHandoff: true,
          requestedBy: 'desktop-admin',
          requestId: `desktop-internal-service-peer-handoff-${Date.now()}`
        }
      }
    });
    const handoff = payload.internalServicePeerHandoff || null;
    state.internalPeer.result = handoff;
    state.internalPeer.feedback = {
      kind: handoff?.status === 'blocked' ? 'warning' : 'success',
      message: handoff ? `Internal service peer handoff ${handoff.status}` : 'Internal service peer handoff generated',
      detail: summarizeActionDetail(payload)
    };
    if (handoff?.status === 'ready') {
      const statusPayload = await requestInternalPeerRuntimeStatus(site, pipeline);
      state.internalPeer.runtimeStatus = statusPayload.internalServicePeerRuntimeStatus || null;
      if (internalPeerHostRunnerOffline(state.internalPeer.runtimeStatus)) {
        state.internalPeer.feedback = {
          kind: 'warning',
          message: 'Internal handoff is ready; install or start the native host runner, then Install / Restart will enable egress-on and enroll the host WG peer.',
          detail: internalPeerHostRunnerSetupDetail(state.internalPeer.runtimeStatus)
        };
      }
    }
  } catch (error) {
    state.internalPeer.feedback = { kind: 'error', message: error.message, detail: null };
  } finally {
    state.internalPeer.busy = false;
    renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
    renderInspector();
  }
}

function renderInternalPeerRuntimeStatus(runtimeStatus, applyResult) {
  const status = runtimeStatus?.status || 'ready';
  const install = runtimeStatus?.install || {};
  const tools = runtimeStatus?.tools || {};
  const wireGuardCore = runtimeStatus?.wireGuardCore || {};
  const coreAvailable = wireGuardCore.available === true;
  const coreRuntime = wireGuardCore.runtime || {};
  const link = runtimeStatus?.link || {};
  const iface = runtimeStatus?.interface || {};
  const handshake = iface.handshake || {};
  const runtimeTarget = runtimeStatus?.runtimeTarget || {};
  const hostRunner = runtimeTarget.hostRunner || {};
  const hostRunnerOffline = runtimeTarget.mode === 'host-runner-unreachable' || Boolean(hostRunner.error);
  const internalEgress = runtimeStatus?.internalEgress || {};
  const configReadiness = runtimeStatus?.configReadiness || {};
  const directListener = runtimeStatus?.directListener || {};
  const proxy = runtimeStatus?.proxy || {};
  const splitDns = proxy.splitDns || {};
  const applyStatus = applyResult?.status || 'not-run';
  const qpTunnelCliValue = tools.qpTunnelCli?.path
    ? `${tools.qpTunnelCli.path}${tools.qpTunnelCli.version ? ` / ${tools.qpTunnelCli.version}` : ''}`
    : 'required runtime source missing';
  const internalEgressValue = internalEgress.serviceName
    ? `${internalEgress.serviceName} / ${internalEgress.summary || internalEgress.status || 'not checked'}`
    : internalEgress.summary || internalEgress.status || 'not checked';
  const tunnel = wireGuardCore.tunnel || {};
  const daemon = wireGuardCore.daemon || {};
  const serviceValue = hostRunnerOffline
    ? 'not checked'
    : daemon.running
      ? `launchd running${tunnel.realInterfaceName ? ` / ${tunnel.realInterfaceName}` : ''}`
      : tunnel.active
        ? `tunnel active${tunnel.realInterfaceName ? ` / ${tunnel.realInterfaceName}` : ''}`
        : iface.wgShow?.status || 'not checked';
  const serviceStatus = hostRunnerOffline
    ? 'ready'
    : daemon.running || tunnel.active
      ? 'passed'
      : iface.wgShow?.status === 'not-checked'
        ? 'ready'
        : iface.wgShow?.status || wireGuardCore.status || 'ready';
  const rows = [
    { label: 'target', value: runtimeTarget.mode || 'not checked', status: runtimeTarget.mode === 'host-runner' ? 'passed' : hostRunnerOffline || runtimeTarget.mode === 'api-pod' ? 'blocked' : 'ready' },
    { label: 'host runner', value: hostRunner.error || hostRunner.url || hostRunner.startCommand || 'not configured', status: hostRunner.error ? 'blocked' : hostRunner.configured ? 'passed' : 'ready' },
    { label: 'config key', value: hostRunnerOffline ? 'not checked' : configReadiness.summary || configReadiness.privateKey || 'not checked', status: hostRunnerOffline ? 'ready' : configReadiness.status || 'ready' },
    { label: 'wg runtime', value: hostRunnerOffline ? 'not checked' : wireGuardCore.method ? `${wireGuardCore.method} / ${wireGuardCore.source || 'core'}` : 'not checked', status: hostRunnerOffline ? 'ready' : wireGuardCore.status || (coreAvailable ? 'passed' : 'ready') },
    { label: 'core wg', value: hostRunnerOffline ? 'not checked' : coreRuntime.wg?.command || coreRuntime.wg?.error || 'missing', status: hostRunnerOffline ? 'ready' : coreRuntime.wg?.available ? 'passed' : coreAvailable ? 'ready' : 'blocked' },
    { label: 'core wg-quick', value: hostRunnerOffline ? 'not checked' : coreRuntime.wgQuick?.command || coreRuntime.wgQuick?.error || 'missing', status: hostRunnerOffline ? 'ready' : coreRuntime.wgQuick?.available ? 'passed' : coreRuntime.method === 'darwin-userspace' ? 'ready' : 'blocked' },
    { label: 'core wireguard-go', value: hostRunnerOffline ? 'not checked' : coreRuntime.wireGuardGo?.command || coreRuntime.wireGuardGo?.error || (coreRuntime.platform === 'darwin' ? 'missing' : 'not required'), status: hostRunnerOffline ? 'ready' : coreRuntime.platform === 'darwin' ? coreRuntime.wireGuardGo?.available ? 'passed' : 'blocked' : 'ready' },
    { label: 'qp-tunnel-cli', value: hostRunnerOffline ? 'not checked' : qpTunnelCliValue, status: hostRunnerOffline ? 'ready' : tools.qpTunnelCli?.available ? 'passed' : 'blocked' },
    { label: 'internal egress-on', value: hostRunnerOffline ? 'not checked' : internalEgressValue, status: hostRunnerOffline ? 'ready' : internalEgress.status || 'ready' },
    { label: 'service', value: serviceValue, status: serviceStatus },
    { label: 'direct listener', value: hostRunnerOffline ? 'not checked' : directListener.summary || (directListener.expectedPort ? `configured ${directListener.expectedPort}` : 'not configured'), status: hostRunnerOffline ? 'ready' : directListener.status || 'ready' },
    { label: 'handshake', value: hostRunnerOffline ? 'not checked' : handshake.newest?.at || handshake.status || 'not checked', status: hostRunnerOffline ? 'ready' : handshake.status || 'ready' },
    { label: 'proxy bypass', value: hostRunnerOffline ? 'not checked' : Array.isArray(proxy.missingBypass) && proxy.missingBypass.length ? `missing ${proxy.missingBypass.join(',')}` : proxy.clashTunCompatibility || 'not checked', status: hostRunnerOffline ? 'ready' : proxy.status || 'ready' },
    { label: 'split DNS', value: splitDns.authority || 'Internal DNS planned', status: splitDns.status || 'ready' },
    { label: 'Domestic 10.88.0.1', value: hostRunnerOffline ? 'not checked' : link.domesticGatewayPing?.status || link.routeToDomestic?.status || 'not checked', status: hostRunnerOffline ? 'ready' : link.domesticGatewayPing?.status || link.routeToDomestic?.status || 'ready' },
    { label: 'Internal healthz', value: hostRunnerOffline ? 'not checked' : link.internalHealthz?.status || 'not checked', status: hostRunnerOffline ? 'ready' : link.internalHealthz?.status || 'ready' },
    { label: 'install', value: install.available ? `${install.method || 'runtime'} ready` : (install.blockedReasons || []).join('; ') || 'not ready', status: install.available ? 'passed' : 'blocked' },
    { label: 'last apply', value: applyStatus, status: applyStatus === 'passed' ? 'passed' : applyStatus === 'blocked' || applyStatus === 'failed' ? 'blocked' : 'ready' }
  ];
  return `
    <section class="internal-peer-status" data-status="${escapeHtml(status)}">
      <div class="domestic-relay-head">
        <div>
          <span class="site-kind">Execution target</span>
          <strong>${escapeHtml(runtimeStatus?.host?.hostname || 'not checked')}</strong>
          <p>${escapeHtml(runtimeStatus ? `${runtimeTarget.mode || 'runtime'} / ${runtimeStatus.host?.platform || 'host'} / ${runtimeStatus.interfaceName || 'mx-internal-svc'} / checked ${runtimeStatus.checkedAt || '-'}` : 'Refresh to inspect host runner, WireGuard tools, interface, and Domestic path.')}</p>
        </div>
        <span class="health-chip" data-health="${escapeHtml(status)}">${escapeHtml(status)}</span>
      </div>
      <div class="domestic-relay-grid">
        ${rows.map((item) => `
          <span data-status="${escapeHtml(normalizeRuntimeCellStatus(item.status))}">
            <small>${escapeHtml(item.label)}</small>
            <strong title="${escapeHtml(item.value)}">${escapeHtml(item.value)}</strong>
          </span>
        `).join('')}
      </div>
    </section>
  `;
}

function normalizeRuntimeCellStatus(status) {
  if (status === 'passed' || status === 'ready') return status;
  if (status === 'blocked' || status === 'failed' || status === 'missing' || status === 'timeout') return 'blocked';
  return 'ready';
}

function internalPeerHostRunnerOffline(runtimeStatus = null) {
  const runtimeTarget = runtimeStatus?.runtimeTarget || {};
  return runtimeTarget.mode === 'host-runner-unreachable' || Boolean(runtimeTarget.hostRunner?.error);
}

function internalPeerInstallUnavailable(runtimeStatus = null) {
  if (!runtimeStatus?.install) return false;
  return runtimeStatus.install.available === false;
}

function internalPeerHostRunnerCommand(runtimeStatus = null) {
  return runtimeStatus?.runtimeTarget?.hostRunner?.installCommand
    || runtimeStatus?.install?.hostRunnerCommand
    || runtimeStatus?.runtimeTarget?.hostRunner?.startCommand
    || 'bash scripts/manage.sh ops site-slot native-host-runner install 19190';
}

function internalPeerHostRunnerStartCommand(runtimeStatus = null) {
  return runtimeStatus?.runtimeTarget?.hostRunner?.startCommand
    || runtimeStatus?.runtimeTarget?.hostRunner?.legacyForegroundCommand
    || 'bash scripts/manage.sh ops site-slot native-host-runner start 19190';
}

function internalPeerHostRunnerStatusCommand(runtimeStatus = null) {
  return runtimeStatus?.runtimeTarget?.hostRunner?.statusCommand
    || 'bash scripts/manage.sh ops site-slot native-host-runner status 19190';
}

function internalPeerCanEnsureK8sHostRunner(runtimeStatus = null) {
  const hostRunner = runtimeStatus?.runtimeTarget?.hostRunner || {};
  return hostRunner.k8sEnsureAvailable === true
    || (hostRunner.k8sEnsureEnabled === true && hostRunner.k8sFallbackEnabled === true);
}

function internalPeerHostRunnerSetupDetail(runtimeStatus = null) {
  return [
    `Install daemon: ${internalPeerHostRunnerCommand(runtimeStatus)}`,
    `Foreground run: ${internalPeerHostRunnerStartCommand(runtimeStatus)}`,
    `Check status: ${internalPeerHostRunnerStatusCommand(runtimeStatus)}`,
    'Then click Refresh Status, Sync Domestic WG Key if the Internal public key changed, and Install / Restart.'
  ].join('\n');
}

function showInternalPeerNativeRunnerGuide() {
  state.internalPeer.feedback = {
    kind: 'warning',
    message: 'Native Internal host runner is required on the real macOS/Ubuntu host.',
    detail: internalPeerHostRunnerSetupDetail(state.internalPeer.runtimeStatus)
  };
  renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
  renderInspector();
}

async function requestInternalPeerRuntimeStatus(site, pipeline) {
  return fetchJson('/internal/v1/admin/actions/execute', {
    method: 'POST',
    body: {
      actionId: 'site-slot.internal-service-peer.status',
      path: `/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(site.siteId)}/internal-service-peer-status`,
      body: {
        siteId: site.siteId,
        planId: pipeline.planId,
        requestedBy: 'desktop-admin',
        requestId: `desktop-internal-service-peer-status-${Date.now()}`
      }
    }
  });
}

function preferredInternalPeerStatusTarget(pipelines) {
  const sites = deploymentSites(pipelines, 'domestic');
  const selectedSite = sites.find((item) => item.siteId === state.selectedSiteId) || null;
  const preferredSite = preferredDeploymentSite(sites, 'domestic');
  const passedRealSite = sites.find((item) => item.activePipeline?.health === 'passed' && !isSmokeDeploymentSite(item.siteId))
    || null;
  const selectedRealSite = selectedSite && !isSmokeDeploymentSite(selectedSite.siteId) ? selectedSite : null;
  const site = passedRealSite
    || selectedRealSite
    || preferredSite
    || selectedSite
    || sites[0]
    || null;
  if (!site?.activePipeline) return null;
  return {
    site,
    pipeline: hydratePipelineForWorkbench(site.activePipeline)
  };
}

function internalPeerRuntimeStatusAgeMs(runtimeStatus = state.internalPeer.runtimeStatus) {
  const checkedAt = Date.parse(runtimeStatus?.checkedAt || '');
  if (!Number.isFinite(checkedAt)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Date.now() - checkedAt);
}

function internalPeerRuntimeStatusMatches(runtimeStatus, site, pipeline) {
  if (!runtimeStatus || !site?.siteId || !pipeline?.planId) return false;
  if (runtimeStatus.siteId && runtimeStatus.siteId !== site.siteId) return false;
  if (runtimeStatus.planId && runtimeStatus.planId !== pipeline.planId) return false;
  return true;
}

function shouldAutoRefreshInternalPeerRuntimeStatus(site, pipeline) {
  if (!site?.siteId || !pipeline?.planId) return false;
  if (
    state.internalPeer.busy
    || state.internalPeer.materializeBusy
    || state.internalPeer.statusBusy
    || state.internalPeer.applyBusy
    || state.internalPeer.hostRunnerEnsureBusy
    || state.internalPeer.syncBusy
  ) {
    return false;
  }
  if (Date.now() - Number(state.internalPeer.lastStatusAttemptAt || 0) < INTERNAL_PEER_STATUS_AUTO_REFRESH_MS) {
    return false;
  }
  const runtimeStatus = state.internalPeer.runtimeStatus;
  if (!internalPeerRuntimeStatusMatches(runtimeStatus, site, pipeline)) return true;
  return internalPeerRuntimeStatusAgeMs(runtimeStatus) > INTERNAL_PEER_STATUS_AUTO_REFRESH_MS;
}

function scheduleInternalPeerRuntimeStatusRefresh(site, pipeline) {
  if (!shouldAutoRefreshInternalPeerRuntimeStatus(site, pipeline)) return;
  if (internalPeerAutoRefreshTimer) return;
  internalPeerAutoRefreshTimer = setTimeout(() => {
    internalPeerAutoRefreshTimer = null;
    void refreshInternalPeerRuntimeStatus(site, pipeline, { silent: true });
  }, 250);
}

function scheduleInternalPeerRuntimeStatusRefreshFromDashboard(pipelines) {
  const target = preferredInternalPeerStatusTarget(pipelines);
  if (!target) return;
  scheduleInternalPeerRuntimeStatusRefresh(target.site, target.pipeline);
}

function internalPeerRuntimeHealth({ requireFresh = true } = {}) {
  const runtimeStatus = state.internalPeer.runtimeStatus;
  if (!runtimeStatus) return null;
  if (requireFresh && internalPeerRuntimeStatusAgeMs(runtimeStatus) > INTERNAL_PEER_STATUS_AUTO_REFRESH_MS * 4) return null;
  if (runtimeStatus.status === 'passed') return 'passed';
  if (runtimeStatus.status === 'ready') return 'ready';
  if (runtimeStatus.status === 'blocked' || runtimeStatus.status === 'failed') return 'blocked';
  return null;
}

async function refreshInternalPeerRuntimeStatus(site, pipeline, options = {}) {
  if (state.internalPeer.statusBusy) return;
  const silent = options.silent === true;
  state.internalPeer.statusBusy = true;
  state.internalPeer.lastStatusAttemptAt = Date.now();
  if (!silent) {
    state.internalPeer.feedback = { kind: 'info', message: 'Checking Internal service peer status', detail: null };
    if (state.internalPeer.result?.status === 'blocked') {
      state.internalPeer.result = null;
    }
    renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
  }
  try {
    const payload = await requestInternalPeerRuntimeStatus(site, pipeline);
    const runtimeStatus = payload.internalServicePeerRuntimeStatus || null;
    state.internalPeer.runtimeStatus = runtimeStatus;
    if (!silent || runtimeStatus?.status === 'blocked' || internalPeerHostRunnerOffline(runtimeStatus)) {
      state.internalPeer.feedback = {
        kind: runtimeStatus?.status === 'blocked' ? 'warning' : 'success',
        message: internalPeerHostRunnerOffline(runtimeStatus)
          ? 'Native host runner is not reachable; install/start it on the real Internal host, then Install / Restart enables egress-on, installs WG, and assigns 10.88.88.88.'
          : runtimeStatus
            ? `Internal service peer status ${runtimeStatus.status}`
            : 'Internal service peer status checked',
        detail: internalPeerHostRunnerOffline(runtimeStatus)
          ? internalPeerHostRunnerSetupDetail(runtimeStatus)
          : summarizeActionDetail(payload)
      };
    } else if (state.internalPeer.feedback?.kind === 'error' || state.internalPeer.feedback?.kind === 'warning') {
      state.internalPeer.feedback = null;
    }
  } catch (error) {
    if (!silent) {
      state.internalPeer.feedback = { kind: 'error', message: error.message, detail: null };
    }
  } finally {
    state.internalPeer.statusBusy = false;
    renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
    updateTopologyFromPipelines(state.dashboard?.siteSlotPipelines || []);
    renderInspector();
  }
}

async function ensureInternalPeerHostRunner(site, pipeline) {
  if (state.internalPeer.hostRunnerEnsureBusy) return;
  state.internalPeer.hostRunnerEnsureBusy = true;
  state.internalPeer.feedback = { kind: 'info', message: 'Ensuring Internal host runner through k8s fallback', detail: null };
  renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
  try {
    const payload = await fetchJson('/internal/v1/admin/actions/execute', {
      method: 'POST',
      body: {
        actionId: 'site-slot.internal-service-peer.host-runner.ensure',
        path: `/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(site.siteId)}/internal-service-peer-host-runner`,
        body: {
          siteId: site.siteId,
          planId: pipeline.planId,
          confirmInternalHostRunnerEnsure: true,
          requestedBy: 'desktop-admin',
          requestId: `desktop-internal-host-runner-ensure-${Date.now()}`
        }
      }
    });
    const ensureResult = payload.internalServicePeerHostRunnerEnsure || null;
    state.internalPeer.runtimeStatus = payload.internalServicePeerRuntimeStatus || ensureResult?.afterStatus || state.internalPeer.runtimeStatus;
    state.internalPeer.feedback = {
      kind: ensureResult?.status === 'passed' ? 'success' : ensureResult?.status === 'ready' || ensureResult?.status === 'blocked' ? 'warning' : 'error',
      message: ensureResult ? `Internal host runner ${ensureResult.status}` : 'Internal host runner ensure finished',
      detail: summarizeActionDetail(payload)
    };
  } catch (error) {
    state.internalPeer.feedback = { kind: 'error', message: error.message, detail: null };
  } finally {
    state.internalPeer.hostRunnerEnsureBusy = false;
    renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
    renderInspector();
  }
}

async function installInternalPeerService(site, pipeline) {
  if (state.internalPeer.applyBusy) return;
  if (internalPeerHostRunnerOffline(state.internalPeer.runtimeStatus)) {
    state.internalPeer.feedback = {
      kind: 'warning',
      message: 'Install or start the native host runner on the Internal host before enabling egress-on and installing WG.',
      detail: internalPeerHostRunnerSetupDetail(state.internalPeer.runtimeStatus)
    };
    renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
    renderInspector();
    return;
  }
  if (internalPeerInstallUnavailable(state.internalPeer.runtimeStatus)) {
    state.internalPeer.feedback = {
      kind: 'warning',
      message: 'Internal runtime install is not ready.',
      detail: (state.internalPeer.runtimeStatus?.install?.blockedReasons || []).join('\n') || 'Refresh Status after the host runner is reachable.'
    };
    renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
    renderInspector();
    return;
  }
  state.internalPeer.applyBusy = true;
  state.internalPeer.feedback = { kind: 'info', message: 'Installing WG service peer and assigning 10.88.88.88 on the Internal host', detail: null };
  renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
  try {
    const payload = await fetchJson('/internal/v1/admin/actions/execute', {
      method: 'POST',
      body: {
        actionId: 'site-slot.internal-service-peer.apply',
        path: `/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(site.siteId)}/internal-service-peer-apply`,
        body: {
          siteId: site.siteId,
          planId: pipeline.planId,
          confirmInternalServicePeerApply: true,
          requestedBy: 'desktop-admin',
          requestId: `desktop-internal-service-peer-apply-${Date.now()}`
        }
      }
    });
    const applyResult = payload.internalServicePeerApply || null;
    state.internalPeer.applyResult = applyResult;
    state.internalPeer.runtimeStatus = payload.internalServicePeerRuntimeStatus || applyResult?.afterStatus || null;
    state.internalPeer.feedback = {
      kind: applyResult?.status === 'passed' ? 'success' : ['blocked', 'ready'].includes(applyResult?.status) ? 'warning' : 'error',
      message: applyResult ? `Internal service peer install ${applyResult.status}` : 'Internal service peer install finished',
      detail: summarizeActionDetail(payload)
    };
  } catch (error) {
    state.internalPeer.feedback = { kind: 'error', message: error.message, detail: null };
  } finally {
    state.internalPeer.applyBusy = false;
    renderInternalPeerWorkbench(state.dashboard?.siteSlotPipelines || []);
    renderInspector();
  }
}

function hydratePipelineForWorkbench(pipeline) {
  if (!pipeline || state.currentPipeline?.summary?.planId !== pipeline.planId) return pipeline;
  return {
    ...pipeline,
    ...state.currentPipeline.summary,
    plan: state.currentPipeline.plan
  };
}

function renderDomesticRelayPanel(site, pipeline) {
  if (site.kind !== 'domestic') return '';
  const detailedPipeline = state.currentPipeline?.summary?.planId === pipeline?.planId ? state.currentPipeline : null;
  const plan = detailedPipeline?.plan || pipeline?.plan || {};
  const summary = pipeline || {};
  const nextAction = preferredNextAction(asArray(summary.actionHints));
  const endpoint = domesticEndpointFromPlan(plan, summary);
  const legacy = domesticLegacyCleanupState(plan, summary);
  const productRanges = domesticProductRelayCidrsForSite(site.siteId).join(', ') || '10.90.0.0/16 + registry';
  const profile = inspectorSshProfile('domestic', site.siteId);
  const canCreatePlan = Boolean(profile?.profileId || selectedSshProfileId());
  const status = isFailedOrRollbackPipeline(pipeline) ? 'blocked' : nextAction ? 'ready' : 'planned';
  const statusText = isFailedOrRollbackPipeline(pipeline)
    ? 'history selected'
    : nextAction?.label || 'no pending gate';
  return `
    <section class="domestic-relay-panel" data-status="${escapeHtml(status)}">
      <div class="domestic-relay-head">
        <div>
          <span class="site-kind">Domestic WG Relay 2.0</span>
          <strong>${escapeHtml(statusText)}</strong>
          <p>Internal 统一生成 secret 和 artifact；Domestic 只作为可替换 relay/cache/agent。</p>
        </div>
        <div class="domestic-relay-actions">
          <button class="primary-button" type="button" data-domestic-create-plan ${canCreatePlan ? '' : 'disabled'}>New 2.0 Plan</button>
          <button class="secondary-button" type="button" data-domestic-open-ssh>SSH Access</button>
        </div>
      </div>
      <div class="domestic-relay-grid">
        <span><small>WG endpoint</small><strong>${escapeHtml(endpoint || 'host:51280')}</strong></span>
        <span><small>relay gateway</small><strong>10.88.0.1</strong></span>
        <span><small>Internal service</small><strong>10.88.88.88</strong></span>
        <span><small>standalone users</small><strong>10.89.0.0/16</strong></span>
        <span><small>product ranges</small><strong>${escapeHtml(productRanges)}</strong></span>
        <span data-status="${escapeHtml(legacy.status)}"><small>legacy 1.0</small><strong>${escapeHtml(legacy.label)}</strong></span>
      </div>
    </section>
  `;
}

function launcherServiceVipSetupHintForSummary(summary) {
  const hint = state.launcherServiceVipSetupHint;
  if (!hint || summary?.kind !== 'domestic') return null;
  const siteId = summary.siteId || 'domestic-main';
  return hint.domesticSiteId === siteId ? hint : null;
}

function domesticProductRelayCidrsForSite(siteId) {
  const cidrs = asArray(state.launcherServiceVipSmokes)
    .filter((smoke) => (smoke.domesticSiteId || 'domestic-main') === siteId)
    .flatMap((smoke) => {
      const check = asArray(smoke.checks).find((item) => item.checkId === 'domestic-product-cidrs');
      return String(check?.actual || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    });
  return [...new Set(cidrs)];
}

function bindDomesticWorkbenchActions(site) {
  if (site.kind !== 'domestic') return;
  const createPlanButton = siteWorkbench.querySelector('[data-domestic-create-plan]');
  if (createPlanButton) {
    createPlanButton.addEventListener('click', () => {
      syncSshProfileFormToSelectedSite(site.siteId, site.kind);
      void createPlanFromSshProfile();
    });
  }
  const openSshButton = siteWorkbench.querySelector('[data-domestic-open-ssh]');
  if (openSshButton) {
    openSshButton.addEventListener('click', () => {
      syncSshProfileFormToSelectedSite(site.siteId, site.kind);
      focusSshProfileForSite(site);
    });
  }
}

function domesticEndpointFromPlan(plan, summary = null) {
  const materializeEndpoint = actionPublicEndpoint(domesticWgMaterializeActionFromSummary(summary));
  if (materializeEndpoint) return materializeEndpoint;
  const host = plan?.host || summary?.host || '';
  const port = plan?.wireGuard?.listenPort || plan?.relay?.listenPort || 51280;
  return host ? `${host}:${port}` : '';
}

function domesticWgMaterializeActionFromSummary(summary = null) {
  return asArray(summary?.actionHints).find((action) => action.actionId === 'site-slot.domestic-wg.materialize') || null;
}

function actionPublicEndpoint(action = null) {
  const endpoint = action?.bodyTemplate?.publicEndpoint;
  return typeof endpoint === 'string' && endpoint.trim() ? endpoint.trim() : '';
}

function domesticLegacyCleanupState(plan, summary = null) {
  const nextActions = asArray(plan?.nextActions?.length ? plan.nextActions : summary?.nextActions);
  if (!asArray(plan?.deploymentPhases).length && nextActions.includes('activate-domestic-peer-center')) {
    return { status: 'ready', label: 'preserve V1 at activate' };
  }
  return { status: 'ready', label: 'manual cleanup only' };
}

function renderOverseaWorkbench(pipelines) {
  const overview = state.overseaOverview;
  const overviewSites = asArray(overview?.sites);
  const sites = overseaSitesWithDraft(overviewSites);
  deploymentSiteCount.textContent = overview ? `${sites.length || overview.counts?.overseaSites || 0} nodes` : '0 nodes';
  if (state.overseaOverviewError) {
    siteWorkbench.innerHTML = `<div class="empty-state">Oversea overview unavailable: ${escapeHtml(state.overseaOverviewError)}</div>`;
    renderInspector();
    return;
  }
  if (!overview) {
    siteWorkbench.innerHTML = '<div class="empty-state">Loading Oversea overview</div>';
    renderInspector({ mode: 'loading' });
    return;
  }
  if (!state.selectedSiteId && sites[0]) state.selectedSiteId = sites[0].siteId;
  const selected = selectedOverseaSite() || sites[0] || null;
  if (selected) {
    state.selectedSiteId = selected.siteId;
    syncSshProfileFormToSelectedSite(selected.siteId, 'oversea');
  }
  const counts = overview.counts || {};
  const mihomo = overview.mihomo || {};
  const feedback = state.overseaEnsureFeedback
    ? `<div class="profile-feedback oversea-feedback" data-kind="${escapeHtml(state.overseaEnsureFeedback.kind)}">${escapeHtml(state.overseaEnsureFeedback.message)}</div>`
    : '';
  siteWorkbench.innerHTML = `
    <section class="oversea-summary-grid">
      <article>
        <span>Oversea Nodes</span>
        <strong>${escapeHtml(sites.length || counts.overseaSites || 0)}</strong>
        <small>${escapeHtml(counts.installed || 0)} installed / ${escapeHtml(counts.readyToInstall || 0)} ready</small>
      </article>
      <article>
        <span>Internal mihomo</span>
        <strong>${escapeHtml(mihomo.status || 'not-configured')}</strong>
        <small>${escapeHtml(mihomo.routingPolicy || 'cn-direct')} / ${escapeHtml(mihomo.subscriptions || 0)} hysteria2 subscriptions</small>
      </article>
      <article>
        <span>H Delivery</span>
        <strong>Domestic gated</strong>
        <small>${escapeHtml(mihomo.domesticGatewayIp || '10.88.0.1')} / DNS + H2I required</small>
      </article>
    </section>
    ${feedback}
    <section class="oversea-console">
      <div class="oversea-node-list">
        <div class="oversea-list-toolbar">
          <span>
            <strong>Site Registry</strong>
            <small>${state.siteDraft?.kind === 'oversea' ? 'draft pending save' : 'active profiles + evidence'}</small>
          </span>
          <button class="secondary-button" type="button" data-oversea-new>New Oversea</button>
        </div>
        ${sites.length ? sites.map((site) => `
          <button class="oversea-node-card ${site.siteId === state.selectedSiteId ? 'is-selected' : ''}" type="button" data-oversea-site="${escapeHtml(site.siteId)}">
            <span>
              <strong>${escapeHtml(site.siteId)}</strong>
              <small>${escapeHtml(site.host || 'host pending')}</small>
            </span>
            <span class="health-chip" data-health="${escapeHtml(normalizeStageStatus(site.status))}">${escapeHtml(site.status || 'planned')}</span>
          </button>
        `).join('') : '<div class="empty-state">No Oversea nodes yet. Click New Oversea to start.</div>'}
      </div>
      <section class="oversea-detail">
        ${selected ? renderOverseaSiteDetail(selected) : '<div class="empty-state">Select an Oversea node</div>'}
      </section>
    </section>
  `;
  renderInspector();
  const newButton = siteWorkbench.querySelector('[data-oversea-new]');
  if (newButton) {
    newButton.addEventListener('click', () => {
      startNewSiteProfile('oversea');
    });
  }
  for (const button of siteWorkbench.querySelectorAll('[data-oversea-site]')) {
    button.addEventListener('click', () => {
      state.selectedSiteId = button.dataset.overseaSite || null;
      state.overseaEnsureFeedback = null;
      state.overseaTerminalCommand = '';
      state.overseaTerminalResult = null;
      renderDeploymentWorkbench(pipelines);
      renderInspector();
      const active = activePipelineForSite(pipelines, 'oversea', state.selectedSiteId);
      if (active?.planId) {
        void refreshPipelineDetail(active.planId);
      } else {
        state.selectedPlanId = null;
        state.currentPipeline = null;
        renderEmptyPipeline();
      }
    });
  }
  const ensureButton = siteWorkbench.querySelector('[data-oversea-ensure]');
  if (ensureButton) {
    ensureButton.addEventListener('click', () => {
      void ensureSelectedOversea();
    });
  }
  const refreshButton = siteWorkbench.querySelector('[data-oversea-refresh]');
  if (refreshButton) {
    refreshButton.addEventListener('click', () => {
      void refreshAdmin();
    });
  }
  const editProfileButton = siteWorkbench.querySelector('[data-oversea-edit-profile]');
  if (editProfileButton) {
    editProfileButton.addEventListener('click', () => {
      const site = selectedOverseaSite();
      if (site) focusSshProfileForSite(site);
    });
  }
  const reuseHostSshButton = siteWorkbench.querySelector('[data-oversea-reuse-host-ssh]');
  if (reuseHostSshButton) {
    reuseHostSshButton.addEventListener('click', () => {
      const site = selectedOverseaSite();
      if (site) copyHostSshCredentialToSite(site);
    });
  }
  const terminalInput = siteWorkbench.querySelector('[data-oversea-terminal-input]');
  if (terminalInput) {
    terminalInput.addEventListener('input', () => {
      state.overseaTerminalCommand = terminalInput.value;
    });
  }
  for (const button of siteWorkbench.querySelectorAll('[data-oversea-terminal-template]')) {
    button.addEventListener('click', () => {
      const template = overseaTerminalTemplates[button.dataset.overseaTerminalTemplate] || overseaTerminalTemplates.inspect;
      state.overseaTerminalCommand = template;
      state.overseaTerminalResult = null;
      renderDeploymentWorkbench(pipelines);
      renderInspector();
    });
  }
  const terminalRunButton = siteWorkbench.querySelector('[data-oversea-terminal-run]');
  if (terminalRunButton) {
    terminalRunButton.addEventListener('click', () => {
      void runSelectedOverseaTerminal();
    });
  }
}

function renderOverseaSiteDetail(site) {
  const status = site.status || 'planned';
  const installed = status === 'installed';
  const installDisabled = state.overseaEnsureBusy || status === 'blocked' || status === 'draft' || status === 'needs-ssh-profile' || !site.sshProfile?.profileId;
  const installLabel = state.overseaEnsureBusy
    ? 'Running'
    : status === 'blocked'
      ? 'Blocked'
      : status === 'draft' || !site.sshProfile?.profileId
        ? 'Save Profile First'
        : installed
          ? 'Sync Remote'
          : 'Install / Sync';
  const services = asArray(site.services);
  const subscriptions = asArray(site.subscriptions);
  const failure = site.runtime?.failure || null;
  const hostPeer = sameHostPeerProfile(site);
  return `
    <div class="oversea-detail-head">
      <div>
        <span class="site-kind">Oversea</span>
        <h4>${escapeHtml(site.siteId)}</h4>
        <p>${escapeHtml(site.host || 'Host not configured')}</p>
      </div>
      <div class="oversea-actions">
        ${hostPeer ? '<button class="secondary-button" type="button" data-oversea-reuse-host-ssh>Reuse Host SSH</button>' : ''}
        <button class="secondary-button" type="button" data-oversea-edit-profile>Edit Profile</button>
        <button class="secondary-button" type="button" disabled title="Site Registry archive will preserve evidence">Archive</button>
        <button class="primary-button" type="button" data-oversea-ensure ${installDisabled ? 'disabled' : ''}>
          ${escapeHtml(installLabel)}
        </button>
        <button class="secondary-button" type="button" data-oversea-refresh>Refresh</button>
      </div>
    </div>
    <div class="oversea-service-grid">
      ${services.map((service) => `
        <article data-status="${escapeHtml(normalizeStageStatus(service.status))}">
          <span>${escapeHtml(service.name)}</span>
          <strong>${escapeHtml(service.status || 'unknown')}</strong>
          <small>${escapeHtml(service.detail || '-')}</small>
        </article>
      `).join('')}
    </div>
    <dl class="oversea-runtime-meta">
      <div><dt>SSH profile</dt><dd>${escapeHtml(site.sshProfile?.profileId || 'not linked')}</dd></div>
      <div><dt>HY2 UDP</dt><dd>${escapeHtml(site.runtime?.serverPorts || site.sshProfile?.serverPorts || site.mihomoSite?.serverPorts || '51288')}</dd></div>
      <div><dt>Health TCP</dt><dd>${escapeHtml(site.runtime?.exportPort || site.sshProfile?.exportPort || '3434')}</dd></div>
      <div><dt>Callback</dt><dd>${escapeHtml(site.runtime?.callbackMode || (site.runtime?.overseaCallbackBaseUrl || site.sshProfile?.overseaCallbackBaseUrl ? 'remote-callback' : 'push-only'))}</dd></div>
      <div><dt>Worker URL</dt><dd>${escapeHtml(workerInternalBaseUrlForSite(site))}</dd></div>
      <div><dt>Identity</dt><dd>${escapeHtml(site.sshProfile?.identityFile || '-')}</dd></div>
      <div><dt>SSH Config</dt><dd>${escapeHtml(site.sshProfile?.sshConfigFile || '-')}</dd></div>
      <div><dt>Worker report</dt><dd>${escapeHtml(site.runtime?.workerReportStatus || '-')} ${escapeHtml(site.runtime?.workerReportId || '')}</dd></div>
      <div><dt>Evidence</dt><dd>${escapeHtml(asArray(site.runtime?.evidenceMode).join(' / ') || '-')}</dd></div>
    </dl>
    ${renderSameHostNote(site, hostPeer)}
    ${failure ? `
      <div class="oversea-failure-summary">
        <strong>${escapeHtml(failure.phase || failure.stepId || 'failed step')}</strong>
        <span>${escapeHtml(failure.message || 'worker step failed')}</span>
      </div>
    ` : ''}
    ${renderOverseaTerminal(site)}
    <section class="subscription-panel">
      <div class="section-title compact-title">
        <h4>Internal mihomo -> hysteria2 subscriptions</h4>
        <span>${subscriptions.length}</span>
      </div>
      ${subscriptions.length ? `
        <div class="subscription-table">
          ${subscriptions.map((subscription) => `
            <div class="subscription-row">
              <strong>${escapeHtml(subscription.username)}</strong>
              <span>${escapeHtml(subscription.role)}</span>
              <code>${escapeHtml(subscription.subscriptionUrl || subscription.subscriptionPath || '-')}</code>
              <span>${escapeHtml(subscription.deliveryStatus || subscription.status || '-')}</span>
            </div>
          `).join('')}
        </div>
      ` : '<div class="empty-state">No subscriptions issued yet. Install / Sync will issue Internal and Domestic bootstrap accounts plus Internal01-09.</div>'}
    </section>
    <div class="oversea-boundary-note">
      ${escapeHtml(site.reachability?.verdict || 'internal-output-pending')} / ${escapeHtml(site.reachability?.currentBoundary || 'internal-only')} / H endpoints still need Domestic WG + H2I DNS before fetching Internal mihomo.
    </div>
  `;
}

function renderSameHostNote(site, hostPeer) {
  if (!hostPeer) return '';
  return `
    <div class="same-host-note">
      <strong>Same physical host as ${escapeHtml(hostPeer.siteId)}</strong>
      <span>Software probes hit ${escapeHtml(site.host || hostPeer.host || '-')}; Internal mihomo still publishes site-scoped hysteria2 subscriptions and evidence for ${escapeHtml(site.siteId)}.</span>
    </div>
  `;
}

function renderOverseaTerminal(site) {
  const command = state.overseaTerminalCommand || overseaTerminalTemplates.inspect;
  const terminal = state.overseaTerminalResult;
  const status = terminal?.status || 'idle';
  const terminalHint = terminalActionHint(terminal);
  const output = terminal ? [
    `status: ${terminal.status || 'unknown'}${terminal.exitCode !== undefined && terminal.exitCode !== null ? ` / exit ${terminal.exitCode}` : ''}`,
    `site: ${site.siteId}`,
    terminal.diagnosis ? `diagnosis: ${terminal.diagnosis.category || 'unknown'} / ${terminal.diagnosis.summary || '-'}` : '',
    terminal.diagnosis?.tcpProbe ? `tcp: ${terminal.diagnosis.tcpProbe.status || 'unknown'} / ${terminal.diagnosis.tcpProbe.host || '-'}:${terminal.diagnosis.tcpProbe.port || '-'} / ${terminal.diagnosis.tcpProbe.durationMs ?? '-'}ms${terminal.diagnosis.tcpProbe.message ? ` / ${terminal.diagnosis.tcpProbe.message}` : ''}` : '',
    '',
    '$ ' + (terminal.command || command),
    '',
    terminal.stdout ? `stdout:\n${terminal.stdout}` : 'stdout:',
    '',
    terminal.stderr ? `stderr:\n${terminal.stderr}` : 'stderr:'
  ].join('\n') : 'No terminal run yet.';
  return `
    <section class="oversea-terminal" data-status="${escapeHtml(normalizeStageStatus(status))}">
      <div class="section-title compact-title">
        <h4>Remote Terminal</h4>
        <span>${escapeHtml(status)}</span>
      </div>
      <div class="terminal-toolbar">
        <button class="secondary-button" type="button" data-oversea-terminal-template="inspect">Inspect</button>
        <button class="secondary-button" type="button" data-oversea-terminal-template="installDocker">Install Docker</button>
        <button class="secondary-button" type="button" data-oversea-terminal-template="stackStatus">Stack Status</button>
      </div>
      <textarea class="terminal-input" data-oversea-terminal-input spellcheck="false">${escapeHtml(command)}</textarea>
      <div class="terminal-actions">
        <button class="primary-button" type="button" data-oversea-terminal-run ${state.overseaTerminalBusy ? 'disabled' : ''}>
          ${state.overseaTerminalBusy ? 'Running' : 'Run Command'}
        </button>
      </div>
      ${terminalHint ? `<div class="terminal-action-hint">${escapeHtml(terminalHint)}</div>` : ''}
      <pre class="terminal-screen">${escapeHtml(output)}</pre>
    </section>
  `;
}

function terminalActionHint(terminal) {
  const category = terminal?.diagnosis?.category;
  if (category === 'host-key') {
    return 'Host key is not pinned for this site alias. Open SSH Access, click Refresh Host Key, then rerun Inspect.';
  }
  if (category === 'auth') {
    return 'SSH reached the host but authentication failed. Open SSH Access, bootstrap the Internal-managed key with the one-time root password, or set an identity file that is already authorized on this host.';
  }
  return '';
}

function selectedOverseaSite() {
  const sites = overseaSitesWithDraft(asArray(state.overseaOverview?.sites));
  return sites.find((site) => site.siteId === state.selectedSiteId) || sites[0] || null;
}

function overseaRuntimeForSiteId(siteId) {
  const site = overseaSitesWithDraft(asArray(state.overseaOverview?.sites))
    .find((item) => item.siteId === siteId);
  const overseaCallbackBaseUrl = site?.runtime?.overseaCallbackBaseUrl || site?.sshProfile?.overseaCallbackBaseUrl || '';
  return {
    serverPorts: site?.runtime?.serverPorts || site?.sshProfile?.serverPorts || site?.mihomoSite?.serverPorts || '51288',
    exportPort: positiveNumberOrNull(site?.runtime?.exportPort) || positiveNumberOrNull(site?.sshProfile?.exportPort) || 3434,
    workerInternalBaseUrl: workerInternalBaseUrlForSite(site),
    overseaCallbackBaseUrl,
    callbackMode: site?.runtime?.callbackMode || (overseaCallbackBaseUrl ? 'remote-callback' : 'push-only')
  };
}

function workerInternalBaseUrlForSite(site) {
  return normalizeWorkerBaseValue(site?.runtime?.workerInternalBaseUrl)
    || normalizeWorkerBaseValue(site?.sshProfile?.workerInternalBaseUrl)
    || defaultWorkerInternalBaseUrl();
}

function overseaSitesWithDraft(sites) {
  const items = asArray(sites);
  const draft = state.siteDraft?.kind === 'oversea' ? state.siteDraft : null;
  if (!draft || items.some((site) => site.siteId === draft.siteId)) return items;
  return [draft, ...items];
}

function startNewSiteProfile(kind = 'oversea') {
  const siteKind = kind === 'domestic' ? 'domestic' : 'oversea';
  const siteId = nextDraftSiteId(siteKind);
  state.siteDraft = {
    siteId,
    kind: siteKind,
    host: '',
    status: 'draft',
    services: [],
    subscriptions: [],
    runtime: null,
    sshProfile: null,
    reachability: {
      verdict: 'profile-draft',
      currentBoundary: 'config-center'
    }
  };
  state.selectedSiteId = siteId;
  state.selectedSshProfileId = null;
  state.sshProfileBootstrap = null;
  state.sshProfileShadowSetup = null;
  state.sshProfileReadiness = null;
  state.sshRuntimePolicy = null;
  state.sshProfileFeedback = {
    kind: 'info',
    message: `Draft ${siteId}: enter host, save profile, then run Shadow Setup or Create Plan.`
  };
  fillNewSshProfileForm(siteKind, siteId);
  renderSshProfiles(state.sshProfiles);
  renderDeploymentWorkbench(state.dashboard?.siteSlotPipelines || []);
  renderInspector();
  focusSshProfilePanel();
}

function fillNewSshProfileForm(kind, siteId) {
  sshProfileId.value = '';
  sshProfileSiteId.value = siteId;
  sshProfileKind.value = kind;
  sshProfileHost.value = '';
  sshProfileUser.value = 'root';
  sshProfilePassword.value = '';
  sshProfileRotateKey.checked = false;
  sshProfilePort.value = '22';
  sshProfileHy2Ports.value = kind === 'oversea' ? '51288' : '';
  sshProfileHealthPort.value = kind === 'oversea' ? '3434' : '';
  sshProfileWorkerInternalUrl.value = kind === 'oversea' ? defaultWorkerInternalBaseUrl() : '';
  sshProfileOverseaCallbackUrl.value = '';
  sshProfileStrict.value = 'yes';
  sshProfileBatchMode.value = 'yes';
  sshProfileTimeout.value = '30';
  sshProfileIdentity.value = '';
  sshProfileKnownHosts.value = '';
  sshProfileConfigFile.value = '';
  sshProfileHostKeyAlias.value = siteId;
  renderSshProfileSaveState();
}

function nextDraftSiteId(kind) {
  const prefix = kind === 'domestic' ? 'domestic' : 'oversea';
  const existing = new Set([
    ...asArray(state.overseaOverview?.sites).map((site) => site.siteId),
    ...asArray(state.sshProfiles).filter((profile) => profile.kind === kind).map((profile) => profile.siteId)
  ].filter(Boolean));
  const first = `${prefix}-new`;
  if (!existing.has(first)) return first;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${prefix}-new-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${prefix}-new-${Date.now()}`;
}

function focusSshProfilePanel() {
  if (sshProfilePanel) sshProfilePanel.open = true;
  sshProfilePanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function focusSshProfileForSite(site) {
  if (!site?.siteId) return;
  syncSshProfileFormToSelectedSite(site.siteId, site.kind || state.deploymentKind);
  focusSshProfilePanel();
}

function sameHostPeerProfile(site) {
  if (!site?.host) return null;
  return asArray(state.sshProfiles)
    .filter((profile) => profile.kind === (site.kind || 'oversea')
      && profile.siteId !== site.siteId
      && profile.host === site.host
      && profile.status === 'active'
      && profile.identityFile)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0] || null;
}

function copyHostSshCredentialToSite(site) {
  const peer = sameHostPeerProfile(site);
  if (!peer) return;
  const existing = inspectorSshProfile(site.kind || 'oversea', site.siteId);
  if (existing) {
    fillSshProfileForm(existing);
  } else {
    fillNewSshProfileForm(site.kind || 'oversea', site.siteId);
    sshProfileHost.value = site.host || peer.host || '';
    sshProfileUser.value = site.sshProfile?.sshUser || peer.sshUser || 'root';
    sshProfilePort.value = String(site.sshProfile?.sshPort || peer.sshPort || 22);
  }
  sshProfileIdentity.value = peer.identityFile || '';
  sshProfileKnownHosts.value = peer.knownHostsFile || '';
  sshProfileConfigFile.value = peer.sshConfigFile || '';
  sshProfileStrict.value = peer.strictHostKeyChecking || 'yes';
  sshProfileBatchMode.value = peer.batchMode || 'yes';
  sshProfileTimeout.value = String(peer.connectTimeoutSeconds || 30);
  state.sshProfileFeedback = {
    kind: 'info',
    message: `Copied SSH credential paths from ${peer.siteId}; save ${site.siteId} profile to continue.`
  };
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  focusSshProfilePanel();
}

function syncSshProfileFormToSelectedSite(siteId, kind) {
  const profile = asArray(state.sshProfiles)
    .filter((item) => item.kind === kind && item.siteId === siteId)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0] || null;
  if (profile && (selectedSshProfileId() !== profile.profileId || !sshProfileFormMatchesProfile(profile))) {
    state.selectedSshProfileId = profile.profileId;
    fillSshProfileForm(profile);
    state.sshProfileReadiness = null;
    state.sshRuntimePolicy = null;
    renderSshProfileSaveState();
    renderSshProfileReadiness();
  } else if (!profile && blankToNull(sshProfileSiteId.value) !== siteId) {
    sshProfileKind.value = kind;
    sshProfileSiteId.value = siteId;
    sshProfileHostKeyAlias.value = siteId;
    renderSshProfileSaveState();
  }
}

function sshProfileFormMatchesProfile(profile) {
  return blankToNull(sshProfileId.value) === profile.profileId
    && blankToNull(sshProfileSiteId.value) === profile.siteId
    && sshProfileKind.value === profile.kind
    && blankToNull(sshProfileHost.value) === profile.host
    && (blankToNull(sshProfileUser.value) || 'root') === (profile.sshUser || 'root')
    && (positiveNumberOrNull(sshProfilePort.value) || 22) === (profile.sshPort || 22);
}

function siteDescription(kind) {
  return kind === 'domestic'
    ? 'WG relay / H2I / Internal DNS path, normally a single active Domestic slot.'
    : 'hysteria2 access stack on a remote Ubuntu host, managed by Internal.';
}

function renderFoundationGrid(overview) {
  const cards = internalFoundationCards(overview || {});
  const activeId = internalSubsectionMeta[state.adminSubsection] ? state.adminSubsection : 'overview';
  const active = cards.find((card) => card.id === activeId)
    || cards.find((card) => card.id === 'overview')
    || cards[0];
  if (awxProviderPanel) {
    awxProviderPanel.hidden = activeId !== 'awx-provider';
    if (activeId === 'awx-provider') awxProviderPanel.open = true;
  }
  if (activeId !== 'user-center' && state.userCenter.drawer) {
    closeUserEditorDrawer();
  }
  if (activeId !== 'dns' && state.dnsCenter.drawer) {
    closeDnsRouteEditorDrawer();
  }
  const scopeCard = `
    <article class="foundation-scope-card">
      <div>
        <span class="site-kind">Internal</span>
        <strong>${escapeHtml(active.title)}</strong>
        <p>${escapeHtml(active.description)}</p>
      </div>
      <span>${escapeHtml(String(active.value))}</span>
    </article>
  `;
  let body = '';
  if (activeId === 'overview') {
    body = renderInternalOverview(cards, overview || {});
  } else if (activeId === 'user-center') {
    body = renderUserCenterPanel();
  } else if (activeId === 'rbac') {
    body = renderRbacPanel() + renderPermissionRegistryPanel() + renderExternalSystemContractPanel();
  } else if (activeId === 'config-center') {
    body = renderConfigCenterPanel(overview || {});
  } else if (activeId === 'dns') {
    body = renderDnsCenterPanel();
  } else if (activeId === 'awx-provider') {
    body = renderOptionalAwxProviderPanel();
  } else {
    body = renderInternalModulePanel(activeId, overview || {});
  }
  foundationGrid.innerHTML = scopeCard + body;
  for (const card of foundationGrid.querySelectorAll('[data-internal-module]')) {
    card.addEventListener('click', () => {
      state.adminMenu = 'internal';
      state.adminSection = 'foundations';
      state.adminSubsection = internalSubsectionMeta[card.dataset.internalModule] ? card.dataset.internalModule : 'overview';
      renderAdminShell();
      renderFoundationGrid(state.dashboard?.overview || overview || {});
      renderInspector();
    });
  }
  const bootstrapUsers = foundationGrid.querySelector('[data-user-bootstrap]');
  if (bootstrapUsers) bootstrapUsers.addEventListener('click', () => void bootstrapUserCenterFromAdmin());
  const newUser = foundationGrid.querySelector('[data-user-new]');
  if (newUser) newUser.addEventListener('click', () => openUserEditorDrawer('create'));
  const userDefaultOversea = foundationGrid.querySelector('[data-user-default-oversea]');
  if (userDefaultOversea) {
    userDefaultOversea.addEventListener('change', () => {
      state.userCenter.defaultOverseaOnCreate = userDefaultOversea.checked;
      renderUserCenterSurfaces();
    });
  }
  const userImportFile = foundationGrid.querySelector('[data-user-import-file]');
  if (userImportFile) {
    userImportFile.addEventListener('change', () => {
      const file = userImportFile.files?.[0];
      userImportFile.value = '';
      void importUserCenterJsonFile(file);
    });
  }
  const userSearch = foundationGrid.querySelector('[data-user-filter="search"]');
  if (userSearch) {
    userSearch.addEventListener('input', () => {
      const cursor = userSearch.selectionStart;
      userCenterFilters().search = userSearch.value;
      renderFoundationGrid(state.dashboard?.overview || overview || {});
      requestAnimationFrame(() => {
        const nextSearch = foundationGrid.querySelector('[data-user-filter="search"]');
        nextSearch?.focus?.();
        if (typeof cursor === 'number') nextSearch?.setSelectionRange?.(cursor, cursor);
      });
    });
  }
  bindUserDropdownControls(foundationGrid);
  for (const row of foundationGrid.querySelectorAll('[data-user-select]')) {
    row.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      openUserEditorDrawer('edit', row.dataset.userSelect);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openUserEditorDrawer('edit', row.dataset.userSelect);
    });
  }
  for (const button of foundationGrid.querySelectorAll('[data-user-open]')) {
    button.addEventListener('click', () => openUserEditorDrawer('edit', button.dataset.userOpen));
  }
  for (const button of foundationGrid.querySelectorAll('[data-user-sync]')) {
    button.addEventListener('click', () => {
      const entitlement = entitlementForUser(button.dataset.userSync);
      void syncUserOverseaRuntimeFromAdmin({
        userId: button.dataset.userSync,
        siteIds: asArray(entitlement?.siteIds)
      });
    });
  }
  renderUserEditorDrawer();
  bindDnsCenterControls(foundationGrid);
  renderDnsRouteEditorDrawer();
  bindDomesticRuntimeControls(foundationGrid);
  bindRelayEnrollmentControls(foundationGrid);
}

function internalFoundationCards(overview) {
  return [
    {
      id: 'overview',
      title: 'Control Plane',
      value: overview.siteSlotPlans || 0,
      description: 'Internal 是 User、RBAC、Config、DNS、Release、Runner 和 Evidence 的唯一真相。'
    },
    {
      id: 'user-center',
      title: 'User Center',
      value: overview.userCenterUsers || 0,
      description: '用户、服务账号、设备身份、初始 Internal01-09 预留。'
    },
    {
      id: 'rbac',
      title: 'RBAC',
      value: overview.permissionGrants || 0,
      description: 'Admin action scopes、角色授权、审批确认和门禁边界。'
    },
    {
      id: 'config-center',
      title: 'Config Center',
      value: overview.configPolicySnapshots || 0,
      description: 'SSH Profile、runtime policy、订阅 authority、配置快照。'
    },
    {
      id: 'dns',
      title: 'DNS',
      value: overview.dnsZoneSnapshots || 0,
      description: '业务域名 routes、Internal CoreDNS snapshot、PAC/DNS edge 协同。'
    },
    {
      id: 'mihomo',
      title: 'Mihomo Authority',
      value: overview.siteSlotPlans || 0,
      description: 'Oversea hysteria2 / mihomo 订阅源由 Internal 生成。'
    },
    {
      id: 'release',
      title: 'Release Center',
      value: overview.releaseManagementPlans || 0,
      description: 'artifact、版本、release notes、灰度、回滚。'
    },
    {
      id: 'e2e-gate',
      title: 'E2E Gate',
      value: overview.testRuns || 0,
      description: 'E2E、synthetic probe、runner output、截图和配置快照。'
    },
    {
      id: 'observability',
      title: 'Observability',
      value: consoleEvidenceTotal(state.dashboard?.siteSlotPipelines || []),
      description: 'H / D / I / O 链路 trace、log、metric、evidence。'
    },
    {
      id: 'admin-runner',
      title: 'Admin / Runner',
      value: overview.siteSlotPlans || 0,
      description: '三维拓扑、Action Gates、worker job、rollback 和日志证据。'
    },
    {
      id: 'sdk-gateway',
      title: 'SDK Gateway',
      value: overview.sdkGatewayRoutes || 0,
      description: 'Launcher、AppCenter 应用和其他系统的统一 SDK 契约。'
    },
    {
      id: 'awx-provider',
      title: 'AWX Provider',
      value: overview.awxProviderConfigs || 0,
      description: '可选外部执行 provider；Oversea 默认不依赖 AWX。'
    }
  ];
}

function renderInternalOverview(cards, overview) {
  const groups = [
    {
      title: 'Identity & Access',
      summary: '用户、设备、服务账号、权限目录和 Action Gate 的入口。',
      ids: ['user-center', 'rbac']
    },
    {
      title: 'Runtime Authority',
      summary: '配置、DNS、mihomo 订阅和 Launcher Network 消费的快照。',
      ids: ['config-center', 'dns', 'mihomo']
    },
    {
      title: 'Release & Evidence',
      summary: '发版、灰度、回滚、E2E、观测证据和发布门禁。',
      ids: ['release', 'e2e-gate', 'observability']
    },
    {
      title: 'Execution & Integration',
      summary: 'Admin/Runner、SDK Gateway，以及可选 AWX provider。',
      ids: ['admin-runner', 'sdk-gateway', 'awx-provider']
    }
  ];
  const byId = new Map(cards.map((card) => [card.id, card]));
  return `
    <section class="foundation-panel foundation-wide">
      <div class="foundation-panel-head">
        <div>
          <h4>Internal capability map</h4>
          <p>左侧二级导航是运营入口；这里按控制面职责把子系统串成一张完整地图。</p>
        </div>
        <span>${escapeHtml(String(cards.length - 1))} modules</span>
      </div>
      <div class="foundation-module-groups">
        ${groups.map((group) => `
          <article class="foundation-module-group">
            <div class="foundation-module-group-head">
              <strong>${escapeHtml(group.title)}</strong>
              <span>${escapeHtml(group.summary)}</span>
            </div>
            <div class="foundation-module-buttons">
              ${group.ids.map((id) => {
                const card = byId.get(id);
                if (!card) return '';
                return `
                  <button class="foundation-card compact ${state.adminSubsection === id ? 'is-selected' : ''}" type="button" data-internal-module="${escapeHtml(id)}">
                    <strong>${escapeHtml(card.title)}</strong>
                    <span>${escapeHtml(String(card.value))}</span>
                    <p>${escapeHtml(card.description)}</p>
                  </button>
                `;
              }).join('')}
            </div>
          </article>
        `).join('')}
      </div>
    </section>
    <section class="foundation-panel">
      <div class="foundation-panel-head">
        <div>
          <h4>Source of truth</h4>
          <p>Internal 统一保存结构化事实，Domestic / Oversea 只接收经过门禁的 artifact 和配置。</p>
        </div>
      </div>
      <div class="foundation-kpi-grid">
        ${renderFoundationKpi('Users', overview.userCenterUsers || 0, 'User Center subjects')}
        ${renderFoundationKpi('Scopes', overview.permissionGrants || 0, 'RBAC grants')}
        ${renderFoundationKpi('Configs', overview.configPolicySnapshots || 0, 'snapshot versions')}
        ${renderFoundationKpi('Evidence', consoleEvidenceTotal(state.dashboard?.siteSlotPipelines || []), 'linked records')}
      </div>
    </section>
    <section class="foundation-panel">
      <div class="foundation-panel-head">
        <div>
          <h4>Operating model</h4>
          <p>每个接入系统都按同一模型暴露用户、权限、配置、测试、发布和证据。</p>
        </div>
      </div>
      ${renderFoundationRows([
        ['Register', '系统提交 manifest / SDK 契约 / 权限目录', 'Config Center'],
        ['Authorize', 'User Center subject + RBAC scope + Action Gate', 'RBAC'],
        ['Release', 'artifact、灰度策略、E2E gate 和回滚点', 'Release Center'],
        ['Observe', 'trace、log、metric、截图、配置快照', 'Observability']
      ])}
    </section>
  `;
}

function renderFoundationKpi(label, value, hint) {
  return `
    <article class="foundation-kpi">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value))}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `;
}

function formatLeaseRange(start, end) {
  if (!start && !end) return '-';
  if (!end || start === end) return start || end || '-';
  return `${start || '-'}-${end}`;
}

function renderFoundationRows(rows) {
  return `
    <div class="foundation-table">
      ${rows.map((row) => `
        <article class="foundation-table-row">
          <strong>${escapeHtml(row[0])}</strong>
          <span>${escapeHtml(row[1])}</span>
          <small>${escapeHtml(row[2])}</small>
        </article>
      `).join('')}
    </div>
  `;
}

function roleById(roleId) {
  return asArray(state.userCenter.roles).find((role) => role.roleId === roleId) || null;
}

function roleLabel(roleId) {
  const role = roleById(roleId);
  return role?.displayName || roleId;
}

function scopesForRoleIds(roleIds) {
  return [...new Set(asArray(roleIds).flatMap((roleId) => asArray(roleById(roleId)?.scopes)))];
}

function userKind(user) {
  const roles = asArray(user.roleIds);
  if (roles.some((role) => role.includes('admin'))) return 'Admin';
  if (roles.some((role) => role.includes('service'))) return 'Service';
  return 'Human';
}

function userEnabledServices(user) {
  const roleIds = asArray(user.roleIds);
  if (roleIds.some((role) => role.includes('admin'))) {
    return ['Launcher', 'AppCenter', 'H2O', 'Oversea', 'Release'];
  }
  if (roleIds.some((role) => role.includes('service'))) {
    return ['SDK Gateway', 'Config API', 'Evidence API'];
  }
  return ['Launcher', 'AppCenter', 'H2O', 'Oversea'];
}

function userInternalUsage(user) {
  const scopes = scopesForRoleIds(user.roleIds);
  if (scopes.some((scope) => scope.includes('admin') || scope.includes('site-slot'))) return 'Admin / Runner / Release';
  if (scopes.some((scope) => scope.includes('sdk') || scope.includes('config'))) return 'SDK Gateway / Config';
  return 'Launcher Network / AppCenter';
}

function userOverseaAccess(user) {
  const entitlement = entitlementForUser(user.userId);
  if (entitlement?.status === 'active') {
    const pending = asArray(entitlement.accounts).filter((account) => (
      account.runtimeSync?.requiredAction === 'run-user-oversea-remote-sync'
      || account.runtimeSync?.requiredAction === 'run-oversea-install-sync'
    )).length;
    return pending ? `${pending} pending sync` : `${asArray(entitlement.siteIds).length} assigned`;
  }
  const sites = overseaAuthoritySites();
  const roleIds = asArray(user.roleIds);
  if (!sites.length) return 'no site registered';
  if (roleIds.some((role) => role.includes('admin') || role.includes('user'))) {
    return `${sites.length} site group${sites.length > 1 ? 's' : ''} eligible`;
  }
  return 'policy gated';
}

function entitlementForUser(userId) {
  return asArray(state.userCenter.overseaEntitlements)
    .find((entitlement) => entitlement.userId === userId) || null;
}

function userOverseaSubscriptionUrl(userId) {
  if (!userId) return '';
  return `${normalizedServerBase()}/internal/v1/user-center/users/${encodeURIComponent(userId)}/oversea/subscription.yaml`;
}

function renderChipList(items, tone = 'neutral') {
  const list = asArray(items).filter(Boolean);
  if (!list.length) return '<span class="foundation-chip" data-tone="muted">-</span>';
  return `
    <span class="foundation-chip-row">
      ${list.map((item) => `<span class="foundation-chip" data-tone="${escapeHtml(tone)}">${escapeHtml(item)}</span>`).join('')}
    </span>
  `;
}

function filteredUserCenterUsers() {
  const filter = userCenterFilters();
  const query = String(filter.search || '').trim().toLowerCase();
  return asArray(state.userCenter.users).filter((user) => {
    const profile = user.profile || {};
    const haystack = [
      user.displayName,
      user.account,
      user.email,
      user.userId,
      user.status,
      userKind(user),
      profile.title,
      profile.department,
      profile.location,
      profile.address,
      user.credential?.hasPassword ? 'password local-password' : '',
      ...asArray(user.roleIds).map(roleLabel)
    ].filter(Boolean).join(' ').toLowerCase();
    const matchesQuery = !query || haystack.includes(query);
    const matchesRole = !filter.roleId || filter.roleId === 'all' || asArray(user.roleIds).includes(filter.roleId);
    const matchesStatus = !filter.status || filter.status === 'all' || user.status === filter.status;
    return matchesQuery && matchesRole && matchesStatus;
  });
}

function userRoleDropdownOptions(includeAll = false) {
  const roles = asArray(state.userCenter.roles);
  return [
    ...(includeAll ? [{ value: 'all', label: 'All roles' }] : []),
    ...roles.map((role) => ({
      value: role.roleId,
      label: role.displayName || role.roleId
    }))
  ];
}

function userStatusDropdownOptions() {
  return [
    { value: 'all', label: 'All status' },
    { value: 'active', label: 'active' },
    { value: 'disabled', label: 'disabled' }
  ];
}

function userDropdownLabel(options, selectedValue, fallback = '-') {
  const selected = options.find((option) => option.value === selectedValue);
  return selected?.label || fallback;
}

function renderUserDropdown({ id, field, value, options, label, disabled = false }) {
  const normalizedOptions = asArray(options).filter((option) => option && option.value);
  const selectedValue = value || normalizedOptions[0]?.value || '';
  const selectedLabel = label || userDropdownLabel(normalizedOptions, selectedValue, 'Select');
  const open = state.userCenter.openDropdown === id;
  return `
    <div class="qp-dropdown user-dropdown ${open ? 'is-open' : ''}" data-user-dropdown-root="${escapeHtml(id)}">
      <button
        class="qp-dropdown__trigger user-dropdown__trigger"
        type="button"
        aria-haspopup="listbox"
        aria-expanded="${open ? 'true' : 'false'}"
        data-user-dropdown-toggle="${escapeHtml(id)}"
        data-user-dropdown-field="${escapeHtml(field)}"
        ${disabled ? 'disabled' : ''}
      >
        <span class="qp-dropdown__value user-dropdown__value">${escapeHtml(selectedLabel)}</span>
        <span class="qp-dropdown__chevron user-dropdown__chevron" aria-hidden="true">⌄</span>
      </button>
      <div class="qp-dropdown__menu user-dropdown__menu" role="listbox" aria-label="${escapeHtml(selectedLabel)}">
        ${normalizedOptions.length ? normalizedOptions.map((option) => {
          const selected = option.value === selectedValue;
          return `
            <button
              class="qp-dropdown__option user-dropdown__option ${selected ? 'is-selected' : ''}"
              type="button"
              role="option"
              aria-selected="${selected ? 'true' : 'false'}"
              data-user-dropdown-option="${escapeHtml(id)}"
              data-user-dropdown-field="${escapeHtml(field)}"
              data-user-dropdown-value="${escapeHtml(option.value)}"
            >${escapeHtml(option.label || option.value)}</button>
          `;
        }).join('') : `
          <button class="qp-dropdown__option user-dropdown__option" type="button" role="option" aria-disabled="true" disabled>No options</button>
        `}
      </div>
    </div>
  `;
}

function renderUserStatusBadge(status) {
  const normalized = status === 'disabled' ? 'disabled' : 'active';
  return `<mark data-kind="${escapeHtml(normalized)}">${escapeHtml(normalized)}</mark>`;
}

function renderUserCenterPanel() {
  const users = asArray(state.userCenter.users);
  const filteredUsers = filteredUserCenterUsers();
  const filter = userCenterFilters();
  const feedback = state.userCenter.feedback;
  const roleOptions = userRoleDropdownOptions(true);
  const statusOptions = userStatusDropdownOptions();
  return `
    <section class="foundation-panel foundation-wide user-workbench">
      <div class="app-catalog-toolbar user-catalog-toolbar">
        <div>
          <span class="site-kind">User Center</span>
          <strong>User registry</strong>
          <small>用户、服务账号、设备身份和 User scoped service access.</small>
        </div>
        <div class="app-catalog-controls user-catalog-controls">
          <input data-user-filter="search" value="${escapeHtml(filter.search || '')}" autocomplete="off" placeholder="Search user..." />
          ${renderUserDropdown({
            id: 'user-filter-role',
            field: 'filter:roleId',
            value: filter.roleId || 'all',
            options: roleOptions,
            label: userDropdownLabel(roleOptions, filter.roleId || 'all', 'All roles')
          })}
          ${renderUserDropdown({
            id: 'user-filter-status',
            field: 'filter:status',
            value: filter.status || 'all',
            options: statusOptions,
            label: userDropdownLabel(statusOptions, filter.status || 'all', 'All status')
          })}
          <label class="foundation-checkbox-option user-default-oversea">
            <input type="checkbox" data-user-default-oversea ${state.userCenter.defaultOverseaOnCreate ? 'checked' : ''} ${overseaAuthoritySites().length ? '' : 'disabled'} />
            <span>Default Oversea</span>
          </label>
          <label class="secondary-button user-import-button ${state.userCenter.importBusy ? 'is-disabled' : ''}">
            ${state.userCenter.importBusy ? 'Importing' : 'Import JSON'}
            <input type="file" accept="application/json,.json" data-user-import-file ${state.userCenter.importBusy ? 'disabled' : ''} />
          </label>
          <button class="secondary-button" type="button" data-user-bootstrap ${state.userCenter.busy ? 'disabled' : ''} title="Initialize User Center seed records">Bootstrap</button>
          <button class="primary-button" type="button" data-user-new ${state.userCenter.busy ? 'disabled' : ''}>New User</button>
        </div>
      </div>
      <div class="user-workbench-meta">
        <span>${escapeHtml(String(filteredUsers.length))} shown</span>
        <span>${escapeHtml(String(users.length))} total</span>
        ${feedback ? `<span class="profile-feedback" data-kind="${escapeHtml(feedback.kind)}">${escapeHtml(feedback.message)}</span>` : ''}
        ${state.userCenter.importFeedback ? `<span class="profile-feedback" data-kind="${escapeHtml(state.userCenter.importFeedback.kind)}">${escapeHtml(state.userCenter.importFeedback.message)}</span>` : ''}
      </div>
      <div class="app-table user-admin-table">
        <article class="app-table-row is-header">
          <strong>User</strong>
          <span>Role</span>
          <span>Services</span>
          <span>Internal usage</span>
          <span>Oversea</span>
          <span>Status</span>
          <b>Actions</b>
        </article>
        ${filteredUsers.map((user) => {
          const entitlement = entitlementForUser(user.userId);
          const syncDisabled = state.userCenter.overseaBusy
            || state.userCenter.overseaSyncBusy
            || !asArray(entitlement?.accounts).length;
          const identityLine = [user.account, user.email].filter(Boolean).join(' / ') || user.userId;
          const credentialLine = user.credential?.hasPassword
            ? `local password / ${user.credential.passwordUpdatedAt || 'set'}`
            : 'no local password';
          return `
          <article class="app-table-row ${user.userId === state.userCenter.drawer?.userId ? 'is-selected' : ''}" data-user-select="${escapeHtml(user.userId)}" tabindex="0">
            <span>
              <strong>${escapeHtml(user.displayName || user.userId)}</strong>
              <small>${escapeHtml(identityLine)}</small>
            </span>
            <span>
              <strong>${escapeHtml(asArray(user.roleIds).map(roleLabel).join(' / ') || '-')}</strong>
              <small>${escapeHtml(userKind(user))}</small>
            </span>
            <span>${renderChipList(userEnabledServices(user).slice(0, 3), 'success')}</span>
            <span>
              <strong>${escapeHtml(userInternalUsage(user))}</strong>
              <small>${escapeHtml(credentialLine)}</small>
            </span>
            <span>
              <strong>${escapeHtml(userOverseaAccess(user))}</strong>
              <small>${escapeHtml(asArray(entitlement?.siteIds).join(' / ') || 'not assigned')}</small>
            </span>
            <span>${renderUserStatusBadge(user.status)}</span>
            <span class="app-table-actions">
              <button class="secondary-button" type="button" data-user-open="${escapeHtml(user.userId)}">Open</button>
              <button class="secondary-button" type="button" data-user-sync="${escapeHtml(user.userId)}" ${syncDisabled ? 'disabled' : ''}>Sync</button>
            </span>
          </article>
        `; }).join('') || '<div class="empty-state">No users match the current filters.</div>'}
      </div>
    </section>
  `;
}

function renderUserServiceSummary(user, draft) {
  const effectiveUser = user || { roleIds: draft?.roleId ? [draft.roleId] : [] };
  return `
    <div class="user-drawer-summary">
      <article>
        <span>Kind</span>
        <strong>${escapeHtml(userKind(effectiveUser))}</strong>
      </article>
      <article>
        <span>Internal usage</span>
        <strong>${escapeHtml(userInternalUsage(effectiveUser))}</strong>
      </article>
      <article>
        <span>Services</span>
        <strong>${escapeHtml(userEnabledServices(effectiveUser).join(' / '))}</strong>
      </article>
    </div>
  `;
}

function renderUserOverseaEditor(user) {
  const userId = user?.userId || '';
  const sites = overseaAuthoritySites();
  const entitlement = entitlementForUser(userId);
  const selectedSiteIds = new Set(asArray(entitlement?.siteIds));
  const accounts = asArray(entitlement?.accounts);
  const subscriptionUrl = entitlement?.status === 'active' ? userOverseaSubscriptionUrl(userId) : '';
  const feedback = state.userCenter.overseaFeedback;
  return `
    <section class="app-drawer-section">
      <div class="app-section-title">
        <span>04</span>
        <strong>Oversea access</strong>
      </div>
      <div class="foundation-checkbox-grid user-drawer-sites">
        ${sites.map((siteId) => `
          <label class="foundation-checkbox-option">
            <input type="checkbox" data-oversea-site value="${escapeHtml(siteId)}" ${selectedSiteIds.has(siteId) ? 'checked' : ''} />
            <span>${escapeHtml(siteId)}</span>
          </label>
        `).join('') || '<span class="oversea-boundary-note">No Oversea site is ready yet.</span>'}
      </div>
      <div class="foundation-operation-actions">
        <button class="primary-button" type="button" data-oversea-assign ${state.userCenter.overseaBusy || !userId || !sites.length ? 'disabled' : ''}>
          ${state.userCenter.overseaBusy ? 'Saving Access' : selectedSiteIds.size ? 'Update Access' : 'Disable Access'}
        </button>
        <button class="secondary-button" type="button" data-oversea-sync-user ${state.userCenter.overseaBusy || state.userCenter.overseaSyncBusy || !userId || !accounts.length ? 'disabled' : ''}>
          ${state.userCenter.overseaSyncBusy ? 'Syncing' : 'Sync Runtime'}
        </button>
        ${feedback ? `<span class="profile-feedback" data-kind="${escapeHtml(feedback.kind)}">${escapeHtml(feedback.message)}</span>` : ''}
      </div>
      <div class="foundation-subscription-url">
        <span>Subscription URL</span>
        <code>${escapeHtml(subscriptionUrl || 'Assign one or more Oversea sites to generate a user subscription URL')}</code>
      </div>
      <div class="user-runtime-list">
        ${accounts.map((account) => `
          <article>
            <strong>${escapeHtml(account.siteId)}</strong>
            <span>${escapeHtml(account.username || account.accountId)}</span>
            <small>${escapeHtml(account.runtimeSync?.status || 'unknown')}</small>
          </article>
        `).join('') || '<div class="empty-state">No runtime account selected.</div>'}
      </div>
    </section>
  `;
}

function renderUserEditorDrawer() {
  if (!userEditorBackdrop || !userEditorDrawer) return;
  const drawer = state.userCenter.drawer;
  if (!drawer) {
    userEditorBackdrop.hidden = true;
    userEditorDrawer.hidden = true;
    userEditorDrawer.innerHTML = '';
    return;
  }
  const editing = drawer.mode === 'edit';
  const user = editing ? userCenterUserById(drawer.userId) : null;
  const draft = drawer.draft || createUserEditorDraft(drawer.mode, drawer.userId);
  const roleOptions = userRoleDropdownOptions(false);
  const draftRoleId = draft.roleId || defaultUserRoleId() || roleOptions[0]?.value || '';
  if (!draft.roleId && draftRoleId) draft.roleId = draftRoleId;
  const title = editing ? `Edit ${user?.displayName || draft.displayName || draft.userId}` : 'New User';
  const feedback = state.userCenter.feedback;
  userEditorBackdrop.hidden = false;
  userEditorDrawer.hidden = false;
  userEditorDrawer.innerHTML = `
    <form class="app-editor-form" data-user-editor>
      <header class="app-drawer-header">
        <div>
          <span class="site-kind">User Center</span>
          <h2 id="user-editor-title">${escapeHtml(title)}</h2>
          <p>${escapeHtml(editing ? `${user?.account || draft.account || user?.email || draft.email || '-'} / ${user?.status || 'active'}` : 'Create a User Center subject, local login, profile and optional Oversea access.')}</p>
        </div>
        <button class="icon-button app-drawer-close" type="button" data-user-editor-close aria-label="Close user editor">×</button>
      </header>

      <div class="app-drawer-scroll">
        <section class="app-drawer-section">
          <div class="app-section-title">
            <span>01</span>
            <strong>Basic identity</strong>
          </div>
          <div class="app-editor-grid">
            <label class="app-form-field">
              <span>User ID</span>
              <input data-user-editor-field="userId" value="${escapeHtml(draft.userId || '')}" ${editing ? 'readonly' : ''} placeholder="auto from account" autocomplete="off" />
            </label>
            <label class="app-form-field">
              <span>Account</span>
              <input data-user-editor-field="account" value="${escapeHtml(draft.account || '')}" placeholder="bmyq" autocomplete="username" />
            </label>
            <label class="app-form-field">
              <span>Email</span>
              <input data-user-editor-field="email" value="${escapeHtml(draft.email || '')}" placeholder="optional@example.com" autocomplete="email" />
            </label>
            <label class="app-form-field">
              <span>Display Name</span>
              <input data-user-editor-field="displayName" value="${escapeHtml(draft.displayName || '')}" placeholder="MX User" autocomplete="off" />
            </label>
            <label class="app-form-field">
              <span>Password</span>
              <input type="password" data-user-editor-field="password" value="${escapeHtml(draft.password || '')}" placeholder="${editing ? 'leave blank to keep current' : 'optional local password'}" autocomplete="new-password" />
            </label>
            <label class="app-form-field">
              <span>Role</span>
              <input type="hidden" data-user-editor-field="roleId" value="${escapeHtml(draftRoleId)}" />
              ${renderUserDropdown({
                id: 'user-editor-role',
                field: 'drawer:roleId',
                value: draftRoleId,
                options: roleOptions,
                label: userDropdownLabel(roleOptions, draftRoleId, 'Bootstrap roles first'),
                disabled: !roleOptions.length
              })}
            </label>
          </div>
        </section>

        <section class="app-drawer-section">
          <div class="app-section-title">
            <span>02</span>
            <strong>Profile and attributes</strong>
          </div>
          <div class="app-editor-grid">
            <label class="app-form-field">
              <span>Title</span>
              <input data-user-editor-field="title" value="${escapeHtml(draft.title || '')}" placeholder="operator / admin / visitor" autocomplete="off" />
            </label>
            <label class="app-form-field">
              <span>Department</span>
              <input data-user-editor-field="department" value="${escapeHtml(draft.department || '')}" placeholder="Internal / Domestic / Partner" autocomplete="off" />
            </label>
            <label class="app-form-field">
              <span>Location</span>
              <input data-user-editor-field="location" value="${escapeHtml(draft.location || '')}" placeholder="Shanghai / remote" autocomplete="off" />
            </label>
            <label class="app-form-field app-form-wide">
              <span>Address</span>
              <input data-user-editor-field="address" value="${escapeHtml(draft.address || '')}" placeholder="optional office or delivery address" autocomplete="off" />
            </label>
            <label class="app-form-field">
              <span>Home App</span>
              <input data-user-editor-field="homeAppId" value="${escapeHtml(draft.homeAppId || '')}" placeholder="mx-h2i / luopan" autocomplete="off" />
            </label>
            <label class="app-form-field">
              <span>Registered By</span>
              <input data-user-editor-field="registeredByAppId" value="${escapeHtml(draft.registeredByAppId || '')}" placeholder="mx-h2i / luopan" autocomplete="off" />
            </label>
            <label class="app-form-field app-form-wide">
              <span>Allowed Apps</span>
              <input data-user-editor-field="allowedAppIds" value="${escapeHtml(draft.allowedAppIds || '')}" placeholder="mx-h2i, appcenter, h2o, luopan" autocomplete="off" />
            </label>
            <label class="app-form-field app-form-wide">
              <span>Denied Apps</span>
              <input data-user-editor-field="deniedAppIds" value="${escapeHtml(draft.deniedAppIds || '')}" placeholder="optional explicit deny list" autocomplete="off" />
            </label>
            <label class="app-form-field app-form-wide">
              <span>Attributes JSON</span>
              <textarea data-user-editor-field="attributesJson" rows="5" spellcheck="false" placeholder="{ }">${escapeHtml(draft.attributesJson || '{}')}</textarea>
            </label>
          </div>
        </section>

        <section class="app-drawer-section">
          <div class="app-section-title">
            <span>03</span>
            <strong>Service access</strong>
          </div>
          ${renderUserServiceSummary(user, draft)}
          <div class="user-scope-list">
            ${renderChipList(scopesForRoleIds(draft.roleId ? [draft.roleId] : user?.roleIds).slice(0, 10), 'info')}
          </div>
        </section>

        ${editing && user ? renderUserOverseaEditor(user) : `
          <section class="app-drawer-section">
            <div class="app-section-title">
              <span>04</span>
              <strong>Oversea access</strong>
            </div>
            ${overseaAuthoritySites().length ? `
              <label class="foundation-checkbox-option user-create-oversea">
                <input type="checkbox" data-user-editor-field="provisionOversea" ${draft.provisionOversea ? 'checked' : ''} />
                <span>Provision default Oversea access on save</span>
              </label>
              <div class="user-scope-list">
                ${renderChipList(overseaAuthoritySites(), 'info')}
              </div>
            ` : '<div class="empty-state">Save the user before assigning Oversea access.</div>'}
          </section>
        `}

        ${feedback ? `<div class="feedback ${escapeHtml(feedback.kind || 'info')}">${escapeHtml(feedback.message || '')}</div>` : ''}
      </div>

      <footer class="app-drawer-actions">
        <button class="secondary-button" type="button" data-user-editor-cancel>Cancel</button>
        <button class="primary-button" type="submit" ${state.userCenter.busy ? 'disabled' : ''}>${state.userCenter.busy ? 'Saving...' : 'Save User'}</button>
      </footer>
    </form>
  `;
  bindUserEditorDrawerControls();
}

function bindUserEditorDrawerControls() {
  if (!userEditorDrawer || userEditorDrawer.hidden) return;
  const form = userEditorDrawer.querySelector('[data-user-editor]');
  if (!form) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveUserCenterUserFromEditor(form);
  });
  for (const close of userEditorDrawer.querySelectorAll('[data-user-editor-close], [data-user-editor-cancel]')) {
    close.addEventListener('click', () => closeUserEditorDrawer());
  }
  bindUserDropdownControls(userEditorDrawer);
  for (const control of userEditorDrawer.querySelectorAll('[data-user-editor-field]')) {
    control.addEventListener('input', () => {
      state.userCenter.drawer.draft = userEditorDraftFromForm(form);
      state.userCenter.feedback = null;
    });
    control.addEventListener('change', () => {
      state.userCenter.drawer.draft = userEditorDraftFromForm(form);
      state.userCenter.feedback = null;
      if (control.dataset.userEditorField === 'roleId') renderUserEditorDrawer();
    });
  }
  const assignOversea = userEditorDrawer.querySelector('[data-oversea-assign]');
  if (assignOversea) assignOversea.addEventListener('click', () => void assignUserOverseaFromAdmin());
  const syncOverseaUser = userEditorDrawer.querySelector('[data-oversea-sync-user]');
  if (syncOverseaUser) syncOverseaUser.addEventListener('click', () => void syncUserOverseaRuntimeFromAdmin());
}

function overseaAuthoritySites() {
  const siteIds = new Set();
  for (const site of asArray(state.overseaOverview?.sites)) {
    if (site.siteId) siteIds.add(site.siteId);
  }
  for (const pipeline of asArray(state.dashboard?.siteSlotPipelines)) {
    if (pipeline.kind === 'oversea' && pipeline.siteId) siteIds.add(pipeline.siteId);
  }
  return [...siteIds].sort();
}

function cleanLauncherProductId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeLauncherProductId(value) {
  const normalized = cleanLauncherProductId(value);
  return normalized || MX_H2I_PRODUCT_ID;
}

function normalizeStandaloneProductId(value) {
  const productId = normalizeLauncherProductId(value);
  if (productId === LAUNCHER_FOUNDATION_PRODUCT_ID) return MX_H2I_PRODUCT_ID;
  const product = launcherProductById(productId);
  return product && product.mode !== 'standalone' ? MX_H2I_PRODUCT_ID : productId;
}

function launcherProductDisplayName(productId, product = null) {
  if (productId === MX_H2I_PRODUCT_ID) return 'MX-H2I';
  if (productId === APP_CENTER_PRODUCT_ID) return 'AppCenter';
  if (productId === LAUNCHER_FOUNDATION_PRODUCT_ID) return 'Launcher Foundation';
  if (product?.displayName) return product.displayName;
  if (productId === 'h2o') return 'H2O';
  return productId
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || productId;
}

function productSecondOctetFromIp(value) {
  const address = String(value || '').split('/')[0];
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return null;
  if (parts[0] !== 10 || parts[1] < 1 || parts[1] > 254 || parts[1] === 88) return null;
  return String(parts[1]);
}

function productSecondOctetFromProduct(product) {
  return productSecondOctetFromIp(product?.anonymousLeaseStart)
    || productSecondOctetFromIp(product?.userLeaseStart)
    || productSecondOctetFromIp(product?.anonymousCidr)
    || productSecondOctetFromIp(product?.userCidr);
}

function normalizeProductSecondOctet(value, fallback = '89') {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (Number.isInteger(number) && number >= 1 && number <= 254 && number !== 88) return String(number);
  return fallback;
}

function defaultProductSecondOctet(productId, mode = 'standalone') {
  const product = launcherProductById(productId);
  const existing = productSecondOctetFromProduct(product);
  if (existing) return existing;
  if (productId === MX_H2I_PRODUCT_ID || productId === LAUNCHER_FOUNDATION_PRODUCT_ID) return '89';
  if (productId === APP_CENTER_PRODUCT_ID) return '92';
  if (productId === 'h2o') return '90';
  return nextAvailableProductSecondOctet(productId, mode);
}

function launcherAppDnsHostPart(appId) {
  return cleanLauncherProductId(appId) || 'app';
}

function launcherAppDefaultDnsHost(appId) {
  return `${launcherAppDnsHostPart(appId)}.${MX_DEFAULT_APP_DNS_ZONE}`;
}

function launcherAppDnsRouteId(host) {
  return `rp_${String(host || launcherAppDefaultDnsHost('app')).trim().toLowerCase()}`;
}

function launcherAppDefaultUpstreamUrl(templateId = 'standalone-service') {
  if (templateId === 'mx-h2i') return 'http://127.0.0.1:8080';
  if (templateId === 'luopan') return 'http://127.0.0.1:8080';
  return 'http://127.0.0.1:8080';
}

function launcherAppExistingDnsRoute(appId, host = '') {
  const normalizedHost = String(host || launcherAppDefaultDnsHost(appId)).trim().toLowerCase();
  const routeId = launcherAppDnsRouteId(normalizedHost);
  return asArray(state.dnsCenter.routes).find((route) => {
    const routeHost = String(route?.host || '').trim().toLowerCase();
    const routeKey = String(route?.routeId || '').trim().toLowerCase();
    return routeHost === normalizedHost || routeKey === routeId;
  }) || null;
}

function fallbackLauncherAppTemplateDefinitions() {
  return [
    {
      templateId: 'standalone-service',
      label: 'Standalone business app',
      detail: '创建独立 Launcher channel、ProductNetwork、DNS route 和 gateway upstream。',
      launcherMode: 'standalone',
      category: 'custom',
      dnsRouteEnabled: true
    },
    {
      templateId: 'luopan',
      label: 'Luopan',
      detail: '罗盘AI情报系统；默认独立 10.* 网段，并生成 luopan 域名入口。',
      appId: 'luopan',
      displayName: 'Luopan',
      category: 'custom',
      description: '罗盘AI情报系统',
      launcherMode: 'standalone',
      dnsRouteEnabled: true
    },
    {
      templateId: 'embed-runtime',
      label: 'Embed runtime app',
      detail: '复用 MX-H2I standalone channel，不新增本机网络 owner。',
      launcherMode: 'embed',
      category: 'platform',
      dnsRouteEnabled: true
    },
    {
      templateId: 'custom',
      label: 'Custom / imported manifest',
      detail: '保留当前字段；适合后续由 SDK manifest 或 k8s admin 回填。',
      dnsRouteEnabled: false
    }
  ];
}

function launcherAppTemplateDefinitions() {
  const remoteTemplates = asArray(state.appOnboardingTemplates)
    .filter((template) => template?.templateId && template?.label);
  return remoteTemplates.length ? remoteTemplates : fallbackLauncherAppTemplateDefinitions();
}

function launcherAppTemplateById(templateId) {
  return launcherAppTemplateDefinitions().find((template) => template.templateId === templateId)
    || launcherAppTemplateDefinitions()[0];
}

function inferLauncherAppTemplate(app) {
  if (!app) return 'standalone-service';
  if (app.appId === 'luopan') return 'luopan';
  const mode = launcherModeForApp(app);
  if (mode === 'embed') return 'embed-runtime';
  if (mode === 'standalone') return 'standalone-service';
  return 'custom';
}

function applyLauncherAppTemplateToDraft(draft, templateId, options = {}) {
  const template = launcherAppTemplateById(templateId);
  const forceIdentity = options.forceIdentity === true && !draft.builtin && !draft.systemOwned;
  const appId = forceIdentity && template.appId ? template.appId : cleanLauncherProductId(draft.appId);
  const launcherMode = template.launcherMode || draft.launcherMode || 'standalone';
  const nextDraft = {
    ...draft,
    onboardingTemplate: template.templateId,
    appId,
    displayName: forceIdentity && template.displayName ? template.displayName : draft.displayName,
    category: template.category || draft.category || 'custom',
    description: forceIdentity && template.description ? template.description : draft.description,
    launcherMode,
    standaloneChannelProductId: launcherMode === 'standalone'
      ? appId || draft.appId || MX_H2I_PRODUCT_ID
      : normalizeStandaloneProductId(draft.standaloneChannelProductId || MX_H2I_PRODUCT_ID),
    dnsRouteEnabled: typeof template.dnsRouteEnabled === 'boolean' ? template.dnsRouteEnabled : draft.dnsRouteEnabled !== false
  };
  nextDraft.productSecondOctet = launcherMode === 'standalone'
    ? normalizeProductSecondOctet(draft.productSecondOctet, defaultProductSecondOctet(appId || draft.appId, launcherMode))
    : normalizeProductSecondOctet(draft.productSecondOctet, defaultProductSecondOctet(appId || draft.appId, launcherMode));
  if (!nextDraft.dnsHost || options.refreshDns === true || forceIdentity) {
    nextDraft.dnsHost = launcherAppDefaultDnsHost(appId || draft.appId);
  }
  if (!nextDraft.dnsTarget) nextDraft.dnsTarget = MX_INTERNAL_DNS_IP;
  if (!nextDraft.dnsTargetUrl || options.refreshDns === true || forceIdentity) {
    nextDraft.dnsTargetUrl = launcherAppDefaultUpstreamUrl(template.templateId);
  }
  nextDraft.dnsRouteId = launcherAppDnsRouteId(nextDraft.dnsHost);
  nextDraft.dnsRouteTlsMode = nextDraft.dnsRouteTlsMode || 'internal';
  nextDraft.dnsRouteAuthRequired = nextDraft.dnsRouteAuthRequired !== false;
  return nextDraft;
}

function applyServerAppOnboardingDefaultsToDraft(draft, defaults, options = {}) {
  if (!defaults?.app) return draft;
  const app = defaults.app || {};
  const productNetwork = defaults.productNetwork || {};
  const dnsRoute = defaults.dnsRoute || {};
  const forceIdentity = options.forceIdentity === true && !draft.builtin && !draft.systemOwned;
  const appId = cleanLauncherProductId(forceIdentity || !draft.appId ? app.appId : draft.appId);
  const launcherMode = app.launcherMode === 'embed' ? 'embed' : 'standalone';
  return {
    ...draft,
    onboardingTemplate: defaults.template?.templateId || draft.onboardingTemplate || 'standalone-service',
    appId,
    displayName: forceIdentity || !draft.displayName ? app.displayName || draft.displayName : draft.displayName,
    category: app.category || draft.category || 'custom',
    description: forceIdentity || !draft.description ? app.description || draft.description : draft.description,
    launcherMode,
    standaloneChannelProductId: launcherMode === 'standalone'
      ? appId || app.appId || draft.appId || MX_H2I_PRODUCT_ID
      : normalizeStandaloneProductId(app.standaloneChannelProductId || draft.standaloneChannelProductId || MX_H2I_PRODUCT_ID),
    productSecondOctet: normalizeProductSecondOctet(productSecondOctetFromIp(productNetwork.userCidr), draft.productSecondOctet),
    channels: uniqueStringList(app.channels).length ? uniqueStringList(app.channels) : draft.channels,
    permissions: uniqueStringList(app.permissions).length ? uniqueStringList(app.permissions) : draft.permissions,
    requiredCapabilities: uniqueStringList(app.requiredCapabilities).length ? uniqueStringList(app.requiredCapabilities) : draft.requiredCapabilities,
    accessDefaultDecision: app.accessPolicy?.defaultDecision || draft.accessDefaultDecision,
    accessAllowAdmin: typeof app.accessPolicy?.allowAdmin === 'boolean' ? app.accessPolicy.allowAdmin : draft.accessAllowAdmin,
    accessRequirePermissionGrant: typeof app.accessPolicy?.requirePermissionGrant === 'boolean' ? app.accessPolicy.requirePermissionGrant : draft.accessRequirePermissionGrant,
    accessAllowRoles: textFromStringList(app.accessPolicy?.allowRoles || stringListFromText(draft.accessAllowRoles)),
    accessAllowUserIds: textFromStringList(app.accessPolicy?.allowUserIds || stringListFromText(draft.accessAllowUserIds)),
    accessAllowOrgIds: textFromStringList(app.accessPolicy?.allowOrgIds || stringListFromText(draft.accessAllowOrgIds)),
    accessAllowRegisteredByAppIds: textFromStringList(app.accessPolicy?.allowRegisteredByAppIds || stringListFromText(draft.accessAllowRegisteredByAppIds)),
    accessAllowHomeAppIds: textFromStringList(app.accessPolicy?.allowHomeAppIds || stringListFromText(draft.accessAllowHomeAppIds)),
    updatePolicy: app.updatePolicy || draft.updatePolicy,
    dnsRouteEnabled: defaults.template?.dnsRouteEnabled !== false,
    dnsRouteId: dnsRoute.routeId || draft.dnsRouteId,
    dnsHost: dnsRoute.host || draft.dnsHost,
    dnsTarget: dnsRoute.dnsTarget || draft.dnsTarget || MX_INTERNAL_DNS_IP,
    dnsTargetUrl: dnsRoute.targetUrl || draft.dnsTargetUrl,
    dnsRouteTlsMode: dnsRoute.tlsMode || draft.dnsRouteTlsMode || 'internal',
    dnsRouteAuthRequired: dnsRoute.authRequired !== false,
    serverOnboardingDefaults: defaults
  };
}

async function hydrateAppCatalogEditorDefaultsFromServer(options = {}) {
  const editor = state.appCatalogEditor;
  if (!editor?.draft) return;
  const requestKey = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  editor.defaultsRequestKey = requestKey;
  const draft = editor.draft;
  const payload = await loadAppOnboardingDefaults({
    templateId: draft.onboardingTemplate,
    appId: draft.appId,
    displayName: draft.displayName,
    category: draft.category,
    description: draft.description,
    launcherMode: draft.launcherMode,
    standaloneChannelProductId: draft.standaloneChannelProductId,
    dnsHost: draft.dnsHost,
    targetUrl: draft.dnsTargetUrl,
    requestedBy: 'desktop-admin'
  });
  if (!state.appCatalogEditor || state.appCatalogEditor.defaultsRequestKey !== requestKey) return;
  if (payload.defaults) {
    state.appCatalogEditor.draft = applyServerAppOnboardingDefaultsToDraft(state.appCatalogEditor.draft, payload.defaults, options);
    state.appOnboardingTemplatesError = null;
    renderAppEditorDrawer();
  } else if (payload.error) {
    state.appOnboardingTemplatesError = payload.error;
  }
}

function relayProductNetworkShape(secondOctet) {
  const octet = normalizeProductSecondOctet(secondOctet);
  return {
    userCidr: `10.${octet}.0.0/16`,
    anonymousCidr: `10.${octet}.0.0/16`,
    userLeaseStart: `10.${octet}.0.1`,
    userLeaseEnd: `10.${octet}.99.254`,
    anonymousLeaseStart: `10.${octet}.100.1`,
    anonymousLeaseEnd: `10.${octet}.254.254`
  };
}

function launcherProductNetworkForDefault(productId) {
  if ([MX_H2I_PRODUCT_ID, APP_CENTER_PRODUCT_ID, 'h2o'].includes(productId)) {
    return launcherProductNetwork(productId);
  }
  return launcherProductById(productId);
}

function knownProductNetworkSecondOctets(excludingProductId = null) {
  const excluding = cleanLauncherProductId(excludingProductId);
  const byProduct = new Map();
  for (const productId of [MX_H2I_PRODUCT_ID, APP_CENTER_PRODUCT_ID, 'h2o']) {
    const product = launcherProductNetworkForDefault(productId);
    if (product?.productId) byProduct.set(product.productId, product);
  }
  for (const product of asArray(state.launcherProducts)) {
    if (product?.productId) byProduct.set(product.productId, product);
  }
  return [...byProduct.values()]
    .filter((product) => !excluding || product.productId !== excluding)
    .map((product) => ({
      product,
      secondOctet: productSecondOctetFromProduct(product)
    }))
    .filter((item) => item.secondOctet);
}

function nextAvailableProductSecondOctet(excludingProductId = null, mode = 'standalone') {
  const used = new Set(knownProductNetworkSecondOctets(excludingProductId).map((item) => Number(item.secondOctet)));
  const fallback = mode === 'standalone' ? 90 : 92;
  const maxUsed = [...used].reduce((max, value) => Number.isInteger(value) ? Math.max(max, value) : max, 88);
  for (let candidate = Math.max(fallback, maxUsed + 1); candidate <= 254; candidate += 1) {
    if (candidate !== 88 && !used.has(candidate)) return String(candidate);
  }
  for (let candidate = fallback; candidate <= 254; candidate += 1) {
    if (candidate !== 88 && !used.has(candidate)) return String(candidate);
  }
  return String(fallback);
}

function productNetworkSecondOctetConflict(secondOctet, excludingProductId = null) {
  const normalized = normalizeProductSecondOctet(secondOctet, '');
  if (!normalized) return null;
  return knownProductNetworkSecondOctets(excludingProductId)
    .find((item) => item.secondOctet === normalized)?.product || null;
}

function productIndexForSecondOctet(secondOctet, productId) {
  if (productId === MX_H2I_PRODUCT_ID) return 0;
  const octet = Number(normalizeProductSecondOctet(secondOctet, '90'));
  return Math.max(0, Math.min(164, octet - 90));
}

function serviceVipForProductSecondOctet(secondOctet, productId) {
  if (productId === MX_H2I_PRODUCT_ID) return '10.88.100.1';
  const index = productIndexForSecondOctet(secondOctet, productId);
  return `10.88.100.${Math.max(2, Math.min(254, 2 + index))}`;
}

function relayEnrollmentDraftForRender(siteId, overrides = {}) {
  const previous = state.relayEnrollment.draft || {};
  const productId = normalizeStandaloneProductId(overrides.productId || previous.productId || MX_H2I_PRODUCT_ID);
  const product = launcherProductById(productId);
  const mode = (overrides.mode || product?.mode || previous.mode || (productId === MX_H2I_PRODUCT_ID ? 'standalone' : 'embed')) === 'standalone'
    ? 'standalone'
    : 'embed';
  const productSecondOctet = normalizeProductSecondOctet(
    overrides.productSecondOctet || (previous.productId === productId ? previous.productSecondOctet : null),
    productSecondOctetFromProduct(product) || defaultProductSecondOctet(productId, mode)
  );
  const draft = {
    productId,
    productSecondOctet,
    mode,
    identityKind: (overrides.identityKind || previous.identityKind) === 'user' ? 'user' : 'anonymous',
    siteId: previous.siteId || siteId || 'domestic-main',
    installId: previous.installId || defaultRelayEnrollmentDeviceId,
    deviceId: previous.deviceId || defaultRelayEnrollmentDeviceId,
    userId: previous.userId || '',
    deviceLabel: previous.deviceLabel || 'Desktop Admin',
    publicKey: previous.publicKey || state.domesticPeerDraft.publicKey || ''
  };
  state.relayEnrollment.draft = draft;
  return draft;
}

function relayEnrollmentDraftFromForm(root = foundationGrid) {
  const current = state.relayEnrollment.draft || {};
  const scope = root || foundationGrid || document;
  const productId = normalizeStandaloneProductId(blankToNull(scope.querySelector('[data-relay-field="productId"]')?.value) || current.productId || MX_H2I_PRODUCT_ID);
  const product = asArray(state.launcherProducts).find((item) => item?.productId === productId) || null;
  const rawMode = blankToNull(scope.querySelector('[data-relay-field="mode"]')?.value) || product?.mode || current.mode || 'standalone';
  const rawIdentityKind = blankToNull(scope.querySelector('[data-relay-field="identityKind"]')?.value) || current.identityKind || 'anonymous';
  const mode = rawMode === 'standalone' ? 'standalone' : 'embed';
  const productSecondOctet = normalizeProductSecondOctet(
    blankToNull(scope.querySelector('[data-relay-field="productSecondOctet"]')?.value) || current.productSecondOctet,
    productSecondOctetFromProduct(product) || defaultProductSecondOctet(productId, mode)
  );
  const draft = {
    productId,
    productSecondOctet,
    mode,
    identityKind: rawIdentityKind === 'user' ? 'user' : 'anonymous',
    siteId: blankToNull(scope.querySelector('[data-relay-field="siteId"]')?.value) || current.siteId || selectedDomesticSiteId() || 'domestic-main',
    installId: blankToNull(scope.querySelector('[data-relay-field="installId"]')?.value) || current.installId || defaultRelayEnrollmentDeviceId,
    deviceId: blankToNull(scope.querySelector('[data-relay-field="deviceId"]')?.value) || current.deviceId || defaultRelayEnrollmentDeviceId,
    userId: blankToNull(scope.querySelector('[data-relay-field="userId"]')?.value) || current.userId || '',
    deviceLabel: blankToNull(scope.querySelector('[data-relay-field="deviceLabel"]')?.value) || current.deviceLabel || 'Desktop Admin',
    publicKey: blankToNull(scope.querySelector('[data-relay-field="publicKey"]')?.value) || current.publicKey || ''
  };
  state.relayEnrollment.draft = draft;
  return draft;
}

function renderRelayProductOptions(selectedProductId) {
  const selectedStandaloneProductId = normalizeStandaloneProductId(selectedProductId);
  const hasMxH2iProduct = asArray(state.launcherProducts).some((product) => product?.productId === MX_H2I_PRODUCT_ID);
  const products = asArray(state.launcherProducts)
    .filter((product) => product?.mode === 'standalone')
    .filter((product) => !(hasMxH2iProduct && product?.productId === LAUNCHER_FOUNDATION_PRODUCT_ID));
  const optionProducts = products.length
    ? products
    : [
        { productId: MX_H2I_PRODUCT_ID, displayName: 'MX-H2I', mode: 'standalone', serviceVip: '10.88.100.1' }
      ];
  const selectedExists = optionProducts.some((product) => product.productId === selectedStandaloneProductId);
  const options = [
    ...(!selectedExists && selectedStandaloneProductId ? [{ productId: selectedStandaloneProductId, displayName: selectedStandaloneProductId, mode: 'standalone', serviceVip: null }] : []),
    ...optionProducts
  ];
  return options.map((product) => {
    const label = `${launcherProductDisplayName(product.productId, product)} / ${product.serviceVip || 'new standalone'}`;
    return `<option value="${escapeHtml(product.productId)}" ${product.productId === selectedStandaloneProductId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

function desiredRelayProductNetwork(draft) {
  const productId = normalizeStandaloneProductId(draft.productId);
  const mode = draft.mode === 'standalone' ? 'standalone' : 'embed';
  const secondOctet = normalizeProductSecondOctet(draft.productSecondOctet, defaultProductSecondOctet(productId, mode));
  const ranges = relayProductNetworkShape(secondOctet);
  const productIndex = productId === MX_H2I_PRODUCT_ID ? 0 : Math.max(0, Math.min(99, Number(secondOctet) - 90));
  const serviceHost = productId === MX_H2I_PRODUCT_ID ? 1 : Math.max(2, Math.min(254, 2 + productIndex));
  return {
    productId,
    displayName: launcherProductDisplayName(productId, launcherProductById(productId)),
    mode,
    standaloneChannelProductId: productId,
    productIndex,
    serviceVip: `10.88.100.${serviceHost}`,
    ...ranges,
    defaultDomesticSiteId: draft.siteId || 'domestic-main',
    updatePolicy: productId === MX_H2I_PRODUCT_ID || mode === 'embed' ? 'launcher-managed' : 'app-managed',
    requestedBy: 'desktop-admin',
    requestId: `desktop-product-network-${Date.now()}`
  };
}

function relayProductNeedsUpsert(product, desired) {
  if (!product) return true;
  return [
    'mode',
    'standaloneChannelProductId',
    'userCidr',
    'anonymousCidr',
    'userLeaseStart',
    'userLeaseEnd',
    'anonymousLeaseStart',
    'anonymousLeaseEnd',
    'defaultDomesticSiteId'
  ].some((field) => String(product[field] || '') !== String(desired[field] || ''));
}

function upsertLocalLauncherProduct(product) {
  if (!product?.productId) return;
  const existing = asArray(state.launcherProducts).filter((item) => item?.productId !== product.productId);
  state.launcherProducts = [product, ...existing]
    .sort((left, right) => String(left.mode || '').localeCompare(String(right.mode || ''))
      || Number(left.productIndex || 0) - Number(right.productIndex || 0)
      || String(left.productId || '').localeCompare(String(right.productId || '')));
  state.launcherProductsError = null;
}

async function ensureRelayProductNetwork(draft) {
  const desired = desiredRelayProductNetwork(draft);
  const current = launcherProductById(desired.productId);
  if (!relayProductNeedsUpsert(current, desired)) return current;
  const payload = await fetchJson(`/internal/v1/launcher-network/products/${encodeURIComponent(desired.productId)}`, {
    method: 'POST',
    body: desired
  });
  if (payload.product) upsertLocalLauncherProduct(payload.product);
  return payload.product || desired;
}

function upsertLocalLauncherLease(lease) {
  if (!lease?.leaseId) return;
  const existing = asArray(state.launcherLeases).filter((item) => item?.leaseId !== lease.leaseId);
  state.launcherLeases = [lease, ...existing];
  state.launcherLeasesError = null;
}

function bindRelayEnrollmentControls(root) {
  if (!root) return;
  for (const input of root.querySelectorAll('[data-relay-field]')) {
    input.addEventListener('input', () => relayEnrollmentDraftFromForm(root));
    input.addEventListener('change', () => relayEnrollmentDraftFromForm(root));
  }
  const enrollRelay = root.querySelector('[data-relay-enroll]');
  if (enrollRelay) enrollRelay.addEventListener('click', () => void enrollHomeRelayFromAdmin(root));
}

function launcherProductById(productId) {
  const normalized = String(productId || '').trim().toLowerCase();
  return asArray(state.launcherProducts).find((product) => product?.productId === normalized) || null;
}

function fallbackLauncherProduct(productId) {
  if (productId === MX_H2I_PRODUCT_ID || productId === LAUNCHER_FOUNDATION_PRODUCT_ID) {
    return {
      productId,
      displayName: productId === LAUNCHER_FOUNDATION_PRODUCT_ID ? 'Launcher Foundation' : 'MX-H2I',
      mode: 'standalone',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      serviceVip: '10.88.100.1',
      internalControlIp: '10.88.88.88',
      userLeaseStart: '10.89.0.1',
      userLeaseEnd: '10.89.99.254',
      anonymousLeaseStart: '10.89.100.1',
      anonymousLeaseEnd: '10.89.254.254',
      defaultDomesticSiteId: 'domestic-main',
      updatePolicy: 'launcher-managed'
    };
  }
  if (productId === APP_CENTER_PRODUCT_ID) {
    return {
      productId,
      displayName: 'AppCenter',
      mode: 'embed',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      serviceVip: '10.88.100.9',
      internalControlIp: '10.88.88.88',
      userLeaseStart: '10.92.0.1',
      userLeaseEnd: '10.92.99.254',
      anonymousLeaseStart: '10.92.100.1',
      anonymousLeaseEnd: '10.92.254.254',
      defaultDomesticSiteId: 'domestic-main',
      updatePolicy: 'launcher-managed'
    };
  }
  if (productId === 'h2o') {
    return {
      productId: 'h2o',
      displayName: 'H2O',
      mode: 'embed',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      serviceVip: '10.88.100.10',
      internalControlIp: '10.88.88.88',
      userLeaseStart: '10.90.0.1',
      userLeaseEnd: '10.90.99.254',
      anonymousLeaseStart: '10.90.100.1',
      anonymousLeaseEnd: '10.90.254.254',
      defaultDomesticSiteId: 'domestic-main',
      updatePolicy: 'launcher-managed'
    };
  }
  return {
    productId,
    displayName: launcherProductDisplayName(productId, { displayName: productId }),
    mode: 'embed',
    standaloneChannelProductId: MX_H2I_PRODUCT_ID,
    serviceVip: '',
    internalControlIp: '10.88.88.88',
    userLeaseStart: '',
    userLeaseEnd: '',
    anonymousLeaseStart: '',
    anonymousLeaseEnd: '',
    defaultDomesticSiteId: 'domestic-main',
    updatePolicy: 'launcher-managed'
  };
}

function launcherProductNetwork(productId) {
  return launcherProductById(productId) || fallbackLauncherProduct(productId);
}

function standaloneChannelProductIdForProduct(product) {
  if (!product) return MX_H2I_PRODUCT_ID;
  if (product.mode === 'standalone') return normalizeStandaloneProductId(product.productId);
  return normalizeStandaloneProductId(product.standaloneChannelProductId || MX_H2I_PRODUCT_ID);
}

function standaloneChannelProductForProduct(product) {
  return launcherProductNetwork(standaloneChannelProductIdForProduct(product));
}

function launcherLeasesForProduct(productId) {
  const normalized = String(productId || '').trim().toLowerCase();
  return asArray(state.launcherLeases)
    .filter((lease) => lease?.productId === normalized)
    .slice()
    .sort((left, right) => String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')));
}

function fallbackAppCenterApps() {
  return [
    {
      appId: MX_H2I_PRODUCT_ID,
      displayName: 'MX-H2I',
      builtin: true,
      systemOwned: true,
      enabled: true,
      version: '0.1.0',
      category: 'vpn',
      description: 'VPN product that owns the Launcher standalone channel and peer leases.',
      launcherMode: 'standalone',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productNetworkId: MX_H2I_PRODUCT_ID,
      channels: ['shadow', 'beta', 'stable'],
      requiredCapabilities: ['launcher-network', 'launcher-standalone', 'wireguard-peer']
    },
    {
      appId: APP_CENTER_PRODUCT_ID,
      displayName: 'AppCenter',
      builtin: true,
      systemOwned: true,
      enabled: true,
      version: '0.1.0',
      category: 'platform',
      description: 'Application catalog and runtime access surface embedded through MX-H2I.',
      launcherMode: 'embed',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productNetworkId: APP_CENTER_PRODUCT_ID,
      channels: ['shadow', 'beta', 'stable'],
      requiredCapabilities: ['app-center-runtime', 'launcher-embed-sdk']
    },
    {
      appId: 'h2o',
      displayName: 'H2O',
      builtin: true,
      systemOwned: true,
      enabled: true,
      version: '0.1.0',
      category: 'network',
      description: 'Network, split DNS, PAC, and Internal service access through MX-H2I.',
      launcherMode: 'embed',
      standaloneChannelProductId: MX_H2I_PRODUCT_ID,
      productNetworkId: 'h2o',
      channels: ['shadow', 'beta', 'stable'],
      requiredCapabilities: ['launcher-network', 'launcher-embed-sdk', 'app-center-runtime']
    }
  ];
}

function orderedAppCenterApps() {
  const byId = new Map(fallbackAppCenterApps().map((app) => [app.appId, app]));
  for (const app of asArray(state.appCenterApps)) {
    if (app?.appId) byId.set(app.appId, { ...byId.get(app.appId), ...app });
  }
  const apps = [...byId.values()];
  const order = new Map([[MX_H2I_PRODUCT_ID, 0], [APP_CENTER_PRODUCT_ID, 1], ['h2o', 2]]);
  return apps
    .slice()
    .sort((left, right) => (order.get(left.appId) ?? 50) - (order.get(right.appId) ?? 50)
      || String(left.displayName || left.appId || '').localeCompare(String(right.displayName || right.appId || '')));
}

function appCenterAppById(appId) {
  const normalized = normalizeLauncherProductId(appId);
  return orderedAppCenterApps().find((app) => app?.appId === normalized) || null;
}

function activeAppCenterApp() {
  return appCenterAppById(state.activeAppNode) || appCenterAppById(MX_H2I_PRODUCT_ID) || fallbackAppCenterApps()[0];
}

function launcherModeForApp(app) {
  if (app?.launcherMode === 'standalone') return 'standalone';
  if (app?.launcherMode === 'embed') return 'embed';
  const product = launcherProductNetwork(app?.productNetworkId || app?.appId || MX_H2I_PRODUCT_ID);
  return product.mode === 'standalone' ? 'standalone' : 'embed';
}

function productNetworkIdForApp(app) {
  return normalizeLauncherProductId(app?.productNetworkId || app?.appId || MX_H2I_PRODUCT_ID);
}

function standaloneChannelIdForApp(app) {
  if (launcherModeForApp(app) === 'standalone') return productNetworkIdForApp(app);
  return normalizeStandaloneProductId(app?.standaloneChannelProductId || MX_H2I_PRODUCT_ID);
}

function appStatusLabel(app) {
  if (app?.enabled === false) return 'Disabled';
  return app?.builtin || app?.systemOwned ? 'System' : 'Custom';
}

function appNavShortLabel(app) {
  const name = String(app?.displayName || app?.appId || '').trim();
  if (!name) return 'APP';
  if (app.appId === MX_H2I_PRODUCT_ID) return 'H2I';
  if (app.appId === APP_CENTER_PRODUCT_ID) return 'App';
  if (app.appId === 'h2o') return 'H2O';
  return name.replace(/^mx[-_\s]*/i, '').slice(0, 3).toUpperCase();
}

function appNavSubtitle(app) {
  const mode = launcherModeForApp(app);
  if (mode === 'standalone') {
    return app.appId === MX_H2I_PRODUCT_ID ? 'VPN / standalone launcher' : 'standalone launcher';
  }
  const channelId = standaloneChannelIdForApp(app);
  return `embed via ${launcherProductDisplayName(channelId, launcherProductNetwork(channelId))}`;
}

function groupedAppNavItems() {
  const apps = orderedAppCenterApps();
  const groups = [];
  const groupsById = new Map();
  for (const app of apps) {
    if (launcherModeForApp(app) !== 'standalone') continue;
    const productId = productNetworkIdForApp(app);
    const group = { app, embeds: [] };
    groups.push(group);
    groupsById.set(productId, group);
  }
  for (const app of apps) {
    if (launcherModeForApp(app) === 'standalone') continue;
    const channelId = standaloneChannelIdForApp(app);
    const group = groupsById.get(channelId) || groupsById.get(MX_H2I_PRODUCT_ID);
    if (group) group.embeds.push(app);
  }
  return groups.length ? groups : [{ app: fallbackAppCenterApps()[0], embeds: apps.filter((app) => launcherModeForApp(app) !== 'standalone') }];
}

function renderAppNavButton(app, level) {
  const appId = normalizeLauncherProductId(app?.appId || MX_H2I_PRODUCT_ID);
  const active = state.activeView === 'app-center' && state.activeAppNode === appId;
  return `
    <button
      class="nav-tab app-nav-item app-nav-level-${escapeHtml(String(level))} ${active ? 'is-active' : ''}"
      type="button"
      data-view="app-center"
      data-app-node="${escapeHtml(appId)}"
      data-short="${escapeHtml(appNavShortLabel(app))}"
    >
      <strong>${escapeHtml(app?.displayName || launcherProductDisplayName(appId, null))}</strong>
      <span>${escapeHtml(appNavSubtitle(app))}</span>
    </button>
  `;
}

function renderAppNav() {
  if (!appNavToggle || !appNavTree) return;
  const appGroup = appNavToggle.closest('.nav-group');
  appNavToggle.setAttribute('aria-expanded', state.appNavCollapsed ? 'false' : 'true');
  const icon = appNavToggle.querySelector('b');
  if (icon) icon.textContent = state.appNavCollapsed ? '⌄' : '⌃';
  appNavTree.hidden = state.appNavCollapsed && !state.sidebarCollapsed;
  appNavTree.innerHTML = groupedAppNavItems().map((group) => `
    <div class="app-nav-channel">
      ${renderAppNavButton(group.app, 2)}
      ${group.embeds.length ? `
        <div class="app-nav-embeds" aria-label="${escapeHtml(group.app.displayName || group.app.appId)} embed apps">
          ${group.embeds.map((app) => renderAppNavButton(app, 3)).join('')}
        </div>
      ` : ''}
    </div>
  `).join('');
  refreshNavTabs();
  if (appGroup) {
    appGroup.classList.toggle('is-active', state.activeView === 'app-center');
    appGroup.classList.toggle('is-group-collapsed', state.appNavCollapsed && !state.sidebarCollapsed);
  }
  renderPrimaryNav();
}

function renderAppCenterShell() {
  const app = activeAppCenterApp();
  const mode = launcherModeForApp(app);
  const channelId = standaloneChannelIdForApp(app);
  if (appCenterHeading) appCenterHeading.textContent = app.displayName || launcherProductDisplayName(app.appId, null);
  if (appCenterSubtitle) {
    appCenterSubtitle.textContent = mode === 'standalone'
      ? 'VPN product / launcher standalone channel.'
      : `${launcherProductDisplayName(app.appId, null)} embeds launcher and uses ${launcherProductDisplayName(channelId, launcherProductNetwork(channelId))}.`;
  }
  renderLauncherFoundationOverview();
  renderAppCatalogPanel();
  renderSelectedAppDetail();
  renderAppNav();
}

function filteredAppCenterApps() {
  const query = String(state.appCatalogFilter || '').trim().toLowerCase();
  const mode = state.appCatalogModeFilter || 'all';
  return orderedAppCenterApps()
    .filter((app) => {
      const appMode = launcherModeForApp(app);
      if (mode !== 'all' && appMode !== mode) return false;
      if (!query) return true;
      return [
        app.appId,
        app.displayName,
        app.category,
        app.description,
        appMode,
        standaloneChannelIdForApp(app)
      ].some((value) => String(value || '').toLowerCase().includes(query));
    });
}

function renderAppCatalogPanel() {
  if (!appProductsPanel) return;
  const apps = filteredAppCenterApps();
  const selectedId = activeAppCenterApp()?.appId || MX_H2I_PRODUCT_ID;
  const error = state.appCenterAppsError || '';
  appProductsPanel.innerHTML = `
    <section class="app-catalog-card">
      <div class="app-catalog-toolbar">
        <div>
          <span class="site-kind">Applications</span>
          <strong>Launcher app registry</strong>
        </div>
        <div class="app-catalog-controls">
          <input data-app-filter="search" value="${escapeHtml(state.appCatalogFilter || '')}" placeholder="Search app..." />
          <select data-app-filter="mode">
            <option value="all" ${state.appCatalogModeFilter === 'all' ? 'selected' : ''}>All modes</option>
            <option value="standalone" ${state.appCatalogModeFilter === 'standalone' ? 'selected' : ''}>Standalone</option>
            <option value="embed" ${state.appCatalogModeFilter === 'embed' ? 'selected' : ''}>Embed</option>
          </select>
          <button class="primary-button" type="button" data-app-new>New App</button>
        </div>
      </div>
      ${error ? `<div class="feedback error">${escapeHtml(error)}</div>` : ''}
      ${state.appCatalogFeedback ? `<div class="feedback ${escapeHtml(state.appCatalogFeedback.kind || 'info')}">${escapeHtml(state.appCatalogFeedback.message || '')}</div>` : ''}
      <div class="app-table" role="table" aria-label="Launcher applications">
        <div class="app-table-row is-header" role="row">
          <span>App</span>
          <span>Launcher Mode</span>
          <span>Channel</span>
          <span>Network</span>
          <span>Version</span>
          <span>Status</span>
          <span>Actions</span>
        </div>
        ${apps.map((app) => renderAppCatalogRow(app, selectedId)).join('') || '<div class="empty-state">No apps match the current filters.</div>'}
      </div>
    </section>
  `;
  bindAppCatalogControls();
  renderAppEditorDrawer();
}

function renderAppCatalogRow(app, selectedId) {
  const mode = launcherModeForApp(app);
  const channelId = standaloneChannelIdForApp(app);
  const productId = productNetworkIdForApp(app);
  const product = launcherProductNetwork(productId);
  const isSystem = app?.builtin || app?.systemOwned;
  const accessLabel = app?.accessPolicy?.defaultDecision || 'private';
  return `
    <article class="app-table-row ${app.appId === selectedId ? 'is-selected' : ''}" role="row" tabindex="0" data-app-select="${escapeHtml(app.appId)}">
      <span>
        <strong>${escapeHtml(app.displayName || app.appId)}</strong>
        <small>${escapeHtml(app.category || app.appId)}</small>
      </span>
      <span><b>${escapeHtml(mode)}</b><small>${mode === 'standalone' ? 'owns launcher channel' : 'uses launcher context'}</small></span>
      <span>${escapeHtml(mode === 'standalone' ? 'self' : launcherProductDisplayName(channelId, launcherProductNetwork(channelId)))}</span>
      <span>${escapeHtml(product.serviceVip || '-')}</span>
      <span>${escapeHtml(app.version || '-')}</span>
      <span><mark data-kind="${escapeHtml(app.enabled === false ? 'muted' : isSystem ? 'system' : 'custom')}">${escapeHtml(appStatusLabel(app))}</mark><small>${escapeHtml(accessLabel)}</small></span>
      <span class="app-table-actions">
        <button class="secondary-button" type="button" data-app-edit="${escapeHtml(app.appId)}">Edit</button>
        <button class="secondary-button" type="button" data-app-delete="${escapeHtml(app.appId)}" ${isSystem ? 'disabled title="System app"' : ''}>${isSystem ? 'System' : 'Delete'}</button>
      </span>
    </article>
  `;
}

function appCatalogEditorDraft() {
  if (!state.appCatalogEditor) return null;
  if (!state.appCatalogEditor.draft) {
    state.appCatalogEditor.draft = createAppCatalogEditorDraft(state.appCatalogEditor.mode, state.appCatalogEditor.appId);
  }
  return state.appCatalogEditor.draft;
}

function createAppCatalogEditorDraft(mode = 'create', appId = '') {
  const editing = mode === 'edit';
  const app = editing ? appCenterAppById(appId) : null;
  const normalizedAppId = editing ? cleanLauncherProductId(app?.appId || appId) : '';
  const appMode = editing && app ? launcherModeForApp(app) : 'standalone';
  const productId = editing && app ? productNetworkIdForApp(app) : normalizedAppId;
  const product = launcherProductNetworkForDefault(productId);
  const productSecondOctet = productSecondOctetFromProduct(product)
    || nextAvailableProductSecondOctet(normalizedAppId || null, appMode);
  const existingDnsRoute = editing ? launcherAppExistingDnsRoute(normalizedAppId) : null;
  const onboardingTemplate = editing ? inferLauncherAppTemplate(app) : 'standalone-service';
  const accessPolicy = app?.accessPolicy || {};
  const draft = {
    appId: normalizedAppId,
    displayName: app?.displayName || '',
    category: app?.category || 'custom',
    version: app?.version || '0.1.0',
    description: app?.description || '',
    onboardingTemplate,
    launcherMode: appMode,
    standaloneChannelProductId: appMode === 'standalone'
      ? normalizedAppId || MX_H2I_PRODUCT_ID
      : standaloneChannelIdForApp(app || { standaloneChannelProductId: MX_H2I_PRODUCT_ID }),
    productSecondOctet,
    enabled: app?.enabled === false ? false : true,
    builtin: app?.builtin === true,
    systemOwned: app?.systemOwned === true,
    channels: asArray(app?.channels).length ? app.channels : ['shadow', 'beta', 'stable'],
    permissions: asArray(app?.permissions),
    requiredCapabilities: asArray(app?.requiredCapabilities),
    accessDefaultDecision: accessPolicy.defaultDecision || (app?.appId === MX_H2I_PRODUCT_ID || app?.appId === APP_CENTER_PRODUCT_ID ? 'public' : 'private'),
    accessAllowAdmin: accessPolicy.allowAdmin === false ? false : true,
    accessRequirePermissionGrant: accessPolicy.requirePermissionGrant === true || app?.appId === 'h2o',
    accessAllowRoles: textFromStringList(accessPolicy.allowRoles),
    accessAllowUserIds: textFromStringList(accessPolicy.allowUserIds),
    accessAllowOrgIds: textFromStringList(accessPolicy.allowOrgIds),
    accessAllowRegisteredByAppIds: textFromStringList(accessPolicy.allowRegisteredByAppIds || (app?.appId === 'h2o' ? [MX_H2I_PRODUCT_ID] : [])),
    accessAllowHomeAppIds: textFromStringList(accessPolicy.allowHomeAppIds || (app?.appId === 'h2o' ? [MX_H2I_PRODUCT_ID] : [])),
    updatePolicy: app?.updatePolicy || (appMode === 'standalone' ? 'app-managed' : 'launcher-managed'),
    dnsRouteEnabled: editing ? !!existingDnsRoute : true,
    dnsRouteId: existingDnsRoute?.routeId || launcherAppDnsRouteId(launcherAppDefaultDnsHost(normalizedAppId)),
    dnsHost: existingDnsRoute?.host || launcherAppDefaultDnsHost(normalizedAppId),
    dnsTarget: existingDnsRoute?.dnsTarget || MX_INTERNAL_DNS_IP,
    dnsTargetUrl: existingDnsRoute?.targetUrl || launcherAppDefaultUpstreamUrl(onboardingTemplate),
    dnsRouteTlsMode: existingDnsRoute?.tlsMode || 'internal',
    dnsRouteAuthRequired: existingDnsRoute?.authRequired === false ? false : true
  };
  return applyLauncherAppTemplateToDraft(draft, onboardingTemplate, { refreshDns: !existingDnsRoute && !editing });
}

function launcherAppDefaultDescription(draft) {
  const name = draft.displayName || draft.appId || 'Launcher app';
  if (draft.launcherMode === 'standalone') {
    return `${name} owns a Launcher standalone channel and can receive Internal network leases.`;
  }
  const channel = launcherProductDisplayName(normalizeStandaloneProductId(draft.standaloneChannelProductId || MX_H2I_PRODUCT_ID), null);
  return `${name} runs through the ${channel} Launcher channel without owning another local tunnel.`;
}

function uniqueStringList(values) {
  return Array.from(new Set(asArray(values).map((value) => String(value || '').trim()).filter(Boolean)));
}

function stringListFromText(value) {
  return Array.from(new Set(String(value || '').split(/[,;\n]/).map((item) => item.trim()).filter(Boolean)));
}

function textFromStringList(values) {
  return uniqueStringList(values).join(', ');
}

function launcherAppKnownCapability(value) {
  return [
    'launcher-network',
    'launcher-standalone',
    'launcher-embed-sdk',
    'wireguard-peer',
    'app-center-runtime'
  ].includes(value);
}

function launcherAppCategoryWantsRuntime(category) {
  return ['platform', 'network'].includes(String(category || '').trim().toLowerCase());
}

function launcherAppEffectiveCapabilities(draft) {
  const appId = cleanLauncherProductId(draft.appId);
  const mode = draft.launcherMode === 'standalone' ? 'standalone' : 'embed';
  const existing = uniqueStringList(draft.requiredCapabilities);
  const generated = appId === APP_CENTER_PRODUCT_ID
    ? ['app-center-runtime', 'launcher-embed-sdk']
    : mode === 'standalone'
      ? ['launcher-network', 'launcher-standalone']
      : ['launcher-network', 'launcher-embed-sdk'];
  if (mode === 'standalone' && (draft.category === 'vpn' || existing.includes('wireguard-peer'))) {
    generated.push('wireguard-peer');
  }
  if (appId !== APP_CENTER_PRODUCT_ID && (launcherAppCategoryWantsRuntime(draft.category) || existing.includes('app-center-runtime'))) {
    generated.push('app-center-runtime');
  }
  return uniqueStringList([
    ...generated,
    ...existing.filter((capability) => !launcherAppKnownCapability(capability))
  ]);
}

function launcherAppKnownPermission(value) {
  return [
    'auth.read',
    'network.tun.request',
    'network.wg.peer',
    'network.dns.policy',
    'observability.write',
    'appcenter.read',
    'permission.request'
  ].includes(value);
}

function launcherAppEffectivePermissions(draft) {
  const mode = draft.launcherMode === 'standalone' ? 'standalone' : 'embed';
  const existing = uniqueStringList(draft.permissions);
  const generated = ['auth.read'];
  if (mode === 'standalone') {
    generated.push('network.tun.request', 'network.dns.policy', 'observability.write');
    if (draft.category === 'vpn' || existing.includes('network.wg.peer')) generated.push('network.wg.peer');
  } else {
    generated.push('appcenter.read', 'permission.request', 'observability.write');
    if (draft.category === 'network' || existing.includes('network.dns.policy')) generated.push('network.dns.policy');
  }
  return uniqueStringList([
    ...generated,
    ...existing.filter((permission) => !launcherAppKnownPermission(permission))
  ]);
}

function launcherAppEffectiveUpdatePolicy(draft) {
  const existing = String(draft.updatePolicy || '').trim();
  if (['platform-critical', 'platform-ui', 'app-managed', 'mandatory-app', 'config-snapshot'].includes(existing)) return existing;
  if (draft.appId === MX_H2I_PRODUCT_ID) return 'mandatory-app';
  if (draft.launcherMode !== 'standalone') return 'platform-ui';
  return 'app-managed';
}

function launcherProductEffectiveUpdatePolicy(draft) {
  if (draft.appId === MX_H2I_PRODUCT_ID || draft.launcherMode !== 'standalone') return 'launcher-managed';
  return 'app-managed';
}

function launcherAppCapabilityHint(capability) {
  const hints = {
    'launcher-network': '允许 SDK/客户端向 Launcher Network 申请 lease。',
    'launcher-standalone': '该应用拥有 standalone channel，可成为 TUN/WG/DNS owner。',
    'launcher-embed-sdk': '该应用复用已有 standalone channel，不新增本机网络 owner。',
    'wireguard-peer': 'VPN 类应用可创建 WireGuard peer 和相关诊断。',
    'app-center-runtime': '可被 AppCenter/runtime 容器加载并走统一权限、发版链路。'
  };
  return hints[capability] || '保留已有自定义能力，不由本页自动解释。';
}

function launcherAppPermissionHint(permission) {
  const hints = {
    'auth.read': '读取登录态和基础身份。',
    'network.tun.request': '向本机网络层申请 TUN/WG 上下文。',
    'network.wg.peer': '创建或更新 WireGuard peer。',
    'network.dns.policy': '使用 split DNS / PAC / resolver 策略。',
    'observability.write': '写入运行诊断和审计证据。',
    'appcenter.read': '读取 AppCenter 应用和发布信息。',
    'permission.request': '通过 SDK Gateway 发起权限请求。'
  };
  return hints[permission] || '保留已有自定义权限。';
}

function openAppCatalogEditor(mode = 'create', appId = '') {
  state.appCatalogEditor = {
    mode,
    appId: cleanLauncherProductId(appId),
    draft: createAppCatalogEditorDraft(mode, appId)
  };
  state.appCatalogFeedback = null;
  renderAppCenterShell();
  requestAnimationFrame(() => {
    const firstField = appEditorDrawer?.querySelector('[data-app-field="appId"]:not([readonly]), [data-app-field="displayName"]');
    firstField?.focus?.();
  });
  void hydrateAppCatalogEditorDefaultsFromServer({ forceIdentity: mode !== 'edit' });
}

function closeAppCatalogEditor() {
  state.appCatalogEditor = null;
  state.appCatalogBusy = false;
  if (appEditorBackdrop) appEditorBackdrop.hidden = true;
  if (appEditorDrawer) {
    appEditorDrawer.hidden = true;
    appEditorDrawer.innerHTML = '';
  }
}

function renderAppEditorDrawer() {
  if (!appEditorBackdrop || !appEditorDrawer) return;
  const draft = appCatalogEditorDraft();
  if (!draft) {
    appEditorBackdrop.hidden = true;
    appEditorDrawer.hidden = true;
    appEditorDrawer.innerHTML = '';
    return;
  }
  const creating = state.appCatalogEditor?.mode !== 'edit';
  const mode = draft.launcherMode === 'standalone' ? 'standalone' : 'embed';
  const appId = cleanLauncherProductId(draft.appId);
  const title = creating ? 'New Launcher App' : `Edit ${draft.displayName || draft.appId}`;
  const draftForPlan = { ...draft, appId, launcherMode: mode };
  const descriptionValue = draft.description || launcherAppDefaultDescription(draftForPlan);
  const capabilities = launcherAppEffectiveCapabilities(draftForPlan);
  const permissions = launcherAppEffectivePermissions(draftForPlan);
  const systemCopy = draft.builtin || draft.systemOwned
    ? '系统预置应用不能删除；这里负责查看或校准它的网络、权限和发布策略。'
    : '选择应用身份和 Launcher 模式后，系统会自动生成网络注册、SDK 接入门槛、权限和发布默认值。';
  const conflict = mode === 'standalone'
    ? productNetworkSecondOctetConflict(draft.productSecondOctet, appId || null)
    : null;
  appEditorBackdrop.hidden = false;
  appEditorDrawer.hidden = false;
  appEditorDrawer.innerHTML = `
    <form class="app-editor-form" data-app-editor>
      <header class="app-drawer-header">
        <div>
          <span class="site-kind">Launcher App</span>
          <h2 id="app-editor-title">${escapeHtml(title)}</h2>
          <p>${escapeHtml(systemCopy)}</p>
        </div>
        <button class="icon-button app-drawer-close" type="button" data-app-editor-close aria-label="Close app editor">×</button>
      </header>

      <div class="app-drawer-scroll">
        ${renderAppEditorDecisionPath(draftForPlan, conflict)}

        <section class="app-drawer-section">
          <div class="app-section-title">
            <span>00</span>
            <strong>Onboarding template</strong>
          </div>
          <p class="app-section-copy">模板只负责填默认值；保存时仍会落到 AppCenter、ProductNetwork 和 DNS Routes 三个正式注册表。</p>
          ${state.appOnboardingTemplatesError ? `<div class="feedback error">${escapeHtml(state.appOnboardingTemplatesError)}</div>` : ''}
          ${renderAppOnboardingTemplateSection(draftForPlan)}
        </section>

        <section class="app-drawer-section">
          <div class="app-section-title">
            <span>01</span>
            <strong>Basic identity</strong>
          </div>
          <p class="app-section-copy">App ID 是客户端 SDK、AppCenter 注册表和 ProductNetwork 的共同主键。新建时先填名称也可以，系统会尝试联动生成 ID。</p>
          <div class="app-editor-grid">
            <label class="app-form-field">
              <span>App ID</span>
              <input data-app-field="appId" value="${escapeHtml(draft.appId || '')}" ${creating ? '' : 'readonly'} placeholder="my-app" autocomplete="off" />
            </label>
            <label class="app-form-field">
              <span>Name</span>
              <input data-app-field="displayName" value="${escapeHtml(draft.displayName || '')}" placeholder="My App" autocomplete="off" />
            </label>
            <label class="app-form-field">
              <span>Category</span>
              <select data-app-field="category">
                ${renderAppCategoryOptions(draft.category || 'custom')}
              </select>
            </label>
            <label class="app-form-field">
              <span>Version</span>
              <input data-app-field="version" value="${escapeHtml(draft.version || '0.1.0')}" placeholder="0.1.0" autocomplete="off" />
            </label>
            <label class="app-form-field app-form-wide">
              <span>Description</span>
              <textarea data-app-field="description" rows="3" placeholder="Generated from launcher mode.">${escapeHtml(descriptionValue)}</textarea>
            </label>
          </div>
        </section>

        <section class="app-drawer-section">
          <div class="app-section-title">
            <span>02</span>
            <strong>Launcher mode</strong>
          </div>
          <p class="app-section-copy">Standalone 会创建独立 ProductNetwork，可分配客户端 IP；Embed 只绑定已有 standalone channel，不新增本机 TUN/WG/DNS owner。</p>
          <div class="app-mode-selector" role="radiogroup" aria-label="Launcher mode">
            ${renderAppModeChoice('standalone', mode, 'standalone', 'Owns a Launcher network channel and can receive leases.')}
            ${renderAppModeChoice('embed', mode, 'embed', 'Uses a selected standalone channel without another TUN/WG/DNS owner.')}
          </div>
          ${mode === 'standalone' ? renderAppStandaloneNetworkSection(draft, conflict) : renderAppEmbedNetworkSection(draft)}
        </section>

        <section class="app-drawer-section">
          <div class="app-section-title">
            <span>03</span>
            <strong>DNS and gateway</strong>
          </div>
          <p class="app-section-copy">DNS target 写入 CoreDNS A 记录；Upstream URL 写入 Internal gateway 反代策略。端口只在 upstream 保留。</p>
          ${renderAppDnsRouteSection(draftForPlan)}
        </section>

        <section class="app-drawer-section">
          <div class="app-section-title">
            <span>04</span>
            <strong>Entitlement plan</strong>
          </div>
          <p class="app-section-copy">生产环境客户端必须命中这里的 AppCenter 注册和 ProductNetwork 绑定。SDK test mode 只在服务端显式开启时放行，不写入正式能力。</p>
          ${renderAppEntitlementPlan(draftForPlan, capabilities, permissions)}
        </section>

        <section class="app-drawer-section">
          <div class="app-section-title">
            <span>05</span>
            <strong>Access policy</strong>
          </div>
          ${renderAppAccessPolicySection(draftForPlan)}
        </section>

        <section class="app-drawer-section">
          <div class="app-section-title">
            <span>06</span>
            <strong>Runtime defaults</strong>
          </div>
          <label class="app-check-row">
            <input data-app-field="enabled" type="checkbox" ${draft.enabled === false ? '' : 'checked'} />
            <span aria-hidden="true"></span>
            <strong>Enabled for Launcher clients</strong>
          </label>
          ${renderAppRuntimeDefaults(draftForPlan)}
          <details class="app-advanced-defaults">
            <summary>Advanced defaults</summary>
            <div class="app-network-facts">
              <span><strong>release</strong><small>shadow / beta / stable</small></span>
              <span><strong>policy</strong><small>${mode === 'standalone' ? 'app-managed network' : 'launcher embed context'}</small></span>
              <span><strong>domestic</strong><small>domestic-main</small></span>
              <span><strong>identity</strong><small>anonymous + login leases</small></span>
            </div>
          </details>
        </section>

        ${state.appCatalogFeedback ? `<div class="feedback ${escapeHtml(state.appCatalogFeedback.kind || 'info')}">${escapeHtml(state.appCatalogFeedback.message || '')}</div>` : ''}
      </div>

      <footer class="app-drawer-actions">
        <button class="secondary-button" type="button" data-app-editor-cancel>Cancel</button>
        <button class="primary-button" type="submit" ${state.appCatalogBusy || (mode === 'standalone' && !!conflict) ? 'disabled' : ''}>${state.appCatalogBusy ? 'Saving...' : 'Save App'}</button>
      </footer>
    </form>
  `;
  bindAppEditorDrawerControls();
}

function renderAppEditorDecisionPath(draft, conflict) {
  const mode = draft.launcherMode === 'standalone' ? 'standalone' : 'embed';
  const appId = cleanLauncherProductId(draft.appId);
  const productId = appId || 'auto-after-save';
  const channelId = mode === 'standalone'
    ? productId
    : normalizeStandaloneProductId(draft.standaloneChannelProductId || MX_H2I_PRODUCT_ID);
  const steps = [
    ['注册 AppCenter', productId, '保存应用身份、版本、类别和可见状态。'],
    ['选择网络模式', mode, mode === 'standalone' ? '创建独立 ProductNetwork 和客户端 IP 池。' : `复用 ${launcherProductDisplayName(channelId, launcherProductNetwork(channelId))} 通道。`],
    ['写入接入门槛', conflict ? 'blocked' : 'ready', conflict ? `10.${draft.productSecondOctet}.* 已被占用，保存前需要换段。` : 'SDK enroll 会校验 appId、productId、mode 和能力。'],
    ['客户端结果', mode === 'standalone' ? 'own lease' : 'shared lease', mode === 'standalone' ? '该应用可以独立发放 Internal 网络 lease。' : '该应用随所选 channel 的网络上下文运行。']
  ];
  return `
    <section class="app-decision-path" aria-label="Launcher app onboarding path">
      ${steps.map(([label, value, detail], index) => `
        <article data-state="${escapeHtml(value === 'blocked' ? 'blocked' : 'ready')}">
          <span>${escapeHtml(String(index + 1).padStart(2, '0'))}</span>
          <strong>${escapeHtml(label)}</strong>
          <b>${escapeHtml(value)}</b>
          <small>${escapeHtml(detail)}</small>
        </article>
      `).join('')}
    </section>
  `;
}

function renderAppOnboardingTemplateSection(draft) {
  const template = launcherAppTemplateById(draft.onboardingTemplate || 'standalone-service');
  return `
    <div class="app-template-panel">
      <label class="app-form-field">
        <span>Application type</span>
        <select data-app-field="onboardingTemplate">
          ${launcherAppTemplateDefinitions().map((item) => `
            <option value="${escapeHtml(item.templateId)}" ${item.templateId === template.templateId ? 'selected' : ''}>${escapeHtml(item.label)}</option>
          `).join('')}
        </select>
      </label>
      <div class="app-template-preview">
        <strong>${escapeHtml(template.label)}</strong>
        <span>${escapeHtml(template.detail)}</span>
        <small>${escapeHtml(template.templateId === 'custom' ? '后续可由 SDK manifest 或 k8s admin 回填字段。' : '可以继续编辑名称、域名和 upstream；能力和权限由系统推导。')}</small>
      </div>
    </div>
  `;
}

function renderAppAccessPolicySection(draft) {
  const decision = ['public', 'authenticated', 'private'].includes(draft.accessDefaultDecision)
    ? draft.accessDefaultDecision
    : 'private';
  return `
    <p class="app-section-copy">Public 应用所有用户可见；Authenticated 需要登录；Private 只允许命中角色、用户、注册来源、Home App 或已有授权的用户。</p>
    <div class="app-editor-grid">
      <label class="app-form-field">
        <span>Default Decision</span>
        <select data-app-field="accessDefaultDecision">
          <option value="public" ${decision === 'public' ? 'selected' : ''}>Public</option>
          <option value="authenticated" ${decision === 'authenticated' ? 'selected' : ''}>Authenticated</option>
          <option value="private" ${decision === 'private' ? 'selected' : ''}>Private</option>
        </select>
      </label>
      <label class="app-check-row">
        <input data-app-field="accessAllowAdmin" type="checkbox" ${draft.accessAllowAdmin === false ? '' : 'checked'} />
        <span aria-hidden="true"></span>
        <strong>Admin can access</strong>
      </label>
      <label class="app-check-row">
        <input data-app-field="accessRequirePermissionGrant" type="checkbox" ${draft.accessRequirePermissionGrant ? 'checked' : ''} />
        <span aria-hidden="true"></span>
        <strong>Accept permission grants</strong>
      </label>
      <label class="app-form-field">
        <span>Allow Roles</span>
        <input data-app-field="accessAllowRoles" value="${escapeHtml(draft.accessAllowRoles || '')}" placeholder="mx-user, mx-admin" autocomplete="off" />
      </label>
      <label class="app-form-field">
        <span>Allow Users</span>
        <input data-app-field="accessAllowUserIds" value="${escapeHtml(draft.accessAllowUserIds || '')}" placeholder="usr_test, usr_operator" autocomplete="off" />
      </label>
      <label class="app-form-field">
        <span>Allow Orgs</span>
        <input data-app-field="accessAllowOrgIds" value="${escapeHtml(draft.accessAllowOrgIds || '')}" placeholder="org_default" autocomplete="off" />
      </label>
      <label class="app-form-field">
        <span>Registered By Apps</span>
        <input data-app-field="accessAllowRegisteredByAppIds" value="${escapeHtml(draft.accessAllowRegisteredByAppIds || '')}" placeholder="mx-h2i, luopan" autocomplete="off" />
      </label>
      <label class="app-form-field">
        <span>Home Apps</span>
        <input data-app-field="accessAllowHomeAppIds" value="${escapeHtml(draft.accessAllowHomeAppIds || '')}" placeholder="mx-h2i, luopan" autocomplete="off" />
      </label>
    </div>
  `;
}

function renderAppEntitlementPlan(draft, capabilities, permissions) {
  return `
    <div class="app-entitlement-plan">
      <article>
        <div>
          <strong>Required capabilities</strong>
          <small>客户端 enroll 的硬门槛，保存时写入 AppCenter app。</small>
        </div>
        <div class="app-generated-chips">
          ${capabilities.map((capability) => `
            <span title="${escapeHtml(launcherAppCapabilityHint(capability))}">${escapeHtml(capability)}</span>
          `).join('')}
        </div>
      </article>
      <article>
        <div>
          <strong>Permission defaults</strong>
          <small>权限中心的初始功能范围，后续由 manifest/RBAC 细化。</small>
        </div>
        <div class="app-generated-chips">
          ${permissions.map((permission) => `
            <span title="${escapeHtml(launcherAppPermissionHint(permission))}">${escapeHtml(permission)}</span>
          `).join('')}
        </div>
      </article>
      <article>
        <div>
          <strong>SDK gate</strong>
          <small>正式包不会因为安装了 npm package 自动入网。</small>
        </div>
        <div class="app-network-facts">
          <span><strong>${escapeHtml(draft.appId || 'app-id')}</strong><small>appId requested by SDK</small></span>
          <span><strong>${escapeHtml(productNetworkIdForDraft(draft))}</strong><small>ProductNetwork binding</small></span>
        </div>
      </article>
    </div>
  `;
}

function renderAppDnsRouteSection(draft) {
  const enabled = draft.dnsRouteEnabled !== false;
  const host = draft.dnsHost || launcherAppDefaultDnsHost(draft.appId);
  const routeId = draft.dnsRouteId || launcherAppDnsRouteId(host);
  const existingRoute = launcherAppExistingDnsRoute(draft.appId, host);
  return `
    <div class="app-dns-plan ${enabled ? '' : 'is-disabled'}">
      <label class="app-check-row">
        <input data-app-field="dnsRouteEnabled" type="checkbox" ${enabled ? 'checked' : ''} />
        <span aria-hidden="true"></span>
        <strong>Create or update DNS Route</strong>
      </label>
      <div class="app-editor-grid">
        <label class="app-form-field">
          <span>Domain</span>
          <input data-app-field="dnsHost" value="${escapeHtml(host)}" placeholder="${escapeHtml(launcherAppDefaultDnsHost(draft.appId))}" autocomplete="off" ${enabled ? '' : 'disabled'} />
        </label>
        <label class="app-form-field">
          <span>Upstream URL</span>
          <input data-app-field="dnsTargetUrl" value="${escapeHtml(draft.dnsTargetUrl || launcherAppDefaultUpstreamUrl(draft.onboardingTemplate))}" placeholder="http://127.0.0.1:8080" autocomplete="off" ${enabled ? '' : 'disabled'} />
        </label>
      </div>
      <div class="app-network-facts">
        <span><strong>${escapeHtml(routeId)}</strong><small>${existingRoute ? 'existing route will be updated' : 'route id'}</small></span>
        <span><strong>${escapeHtml(draft.dnsTarget || MX_INTERNAL_DNS_IP)}</strong><small>CoreDNS A record target</small></span>
        <span><strong>${escapeHtml(draft.dnsRouteTlsMode || 'internal')}</strong><small>gateway TLS mode</small></span>
        <span><strong>${draft.dnsRouteAuthRequired === false ? 'public' : 'auth required'}</strong><small>gateway auth</small></span>
      </div>
    </div>
  `;
}

function productNetworkIdForDraft(draft) {
  return cleanLauncherProductId(draft.appId) || 'created-on-save';
}

function renderAppRuntimeDefaults(draft) {
  const mode = draft.launcherMode === 'standalone' ? 'standalone' : 'embed';
  const updatePolicy = launcherAppEffectiveUpdatePolicy(draft);
  const channels = uniqueStringList(draft.channels).length ? uniqueStringList(draft.channels) : ['shadow', 'beta', 'stable'];
  const channelId = mode === 'standalone'
    ? productNetworkIdForDraft(draft)
    : normalizeStandaloneProductId(draft.standaloneChannelProductId || MX_H2I_PRODUCT_ID);
  return `
    <div class="app-runtime-defaults">
      <span><strong>${escapeHtml(channels.join(' / '))}</strong><small>release lanes</small></span>
      <span><strong>${escapeHtml(updatePolicy)}</strong><small>update policy</small></span>
      <span><strong>${escapeHtml(channelId)}</strong><small>${mode === 'standalone' ? 'self channel' : 'selected channel'}</small></span>
      <span><strong>domestic-main</strong><small>default relay site</small></span>
    </div>
  `;
}

function renderAppCategoryOptions(selectedCategory) {
  const selected = String(selectedCategory || 'custom').trim() || 'custom';
  const categories = ['vpn', 'platform', 'network', 'custom'];
  if (!categories.includes(selected)) categories.push(selected);
  return categories.map((category) => (
    `<option value="${escapeHtml(category)}" ${category === selected ? 'selected' : ''}>${escapeHtml(category)}</option>`
  )).join('');
}

function renderAppModeChoice(value, selected, title, detail) {
  const active = value === selected;
  return `
    <label class="app-mode-choice ${active ? 'is-selected' : ''}">
      <input data-app-field="launcherMode" type="radio" name="launcherMode" value="${escapeHtml(value)}" ${active ? 'checked' : ''} />
      <span aria-hidden="true"></span>
      <strong>${escapeHtml(title)}</strong>
      <small>${escapeHtml(detail)}</small>
    </label>
  `;
}

function renderAppStandaloneNetworkSection(draft, conflict) {
  const appId = cleanLauncherProductId(draft.appId);
  const secondOctet = normalizeProductSecondOctet(draft.productSecondOctet, nextAvailableProductSecondOctet(appId || null, 'standalone'));
  const suggestedOctet = nextAvailableProductSecondOctet(appId || null, 'standalone');
  const ranges = relayProductNetworkShape(secondOctet);
  const serviceVip = serviceVipForProductSecondOctet(secondOctet, appId);
  const knownUsage = knownProductNetworkSecondOctets(appId || null)
    .slice(0, 5)
    .map((item) => `10.${item.secondOctet}.* ${launcherProductDisplayName(item.product.productId, item.product)}`)
    .join(' / ');
  return `
    <div class="app-network-panel ${conflict ? 'has-error' : ''}">
      <label class="app-form-field">
        <span>Standalone IP segment</span>
        <div class="app-network-octet">
          <b>10.</b>
          <input data-app-field="productSecondOctet" inputmode="numeric" min="1" max="254" type="number" value="${escapeHtml(secondOctet)}" />
          <b>.0.0/16</b>
        </div>
      </label>
      <div class="app-network-suggestion">
        <span>
          <strong>10.${escapeHtml(suggestedOctet)}.0.0/16</strong>
          <small>registry suggested next segment</small>
        </span>
        <button class="secondary-button" type="button" data-app-use-suggested-octet="${escapeHtml(suggestedOctet)}" ${suggestedOctet === secondOctet ? 'disabled' : ''}>Use suggested</button>
      </div>
      <p>${conflict ? `10.${escapeHtml(secondOctet)}.* is already used by ${escapeHtml(conflict.displayName || conflict.productId)}.` : 'Only standalone launcher mode owns an IP segment. Embed apps inherit their selected channel.'}</p>
      ${knownUsage ? `<p class="app-network-known">Known segments: ${escapeHtml(knownUsage)}</p>` : ''}
      <div class="app-network-facts">
        <span><strong>${escapeHtml(ranges.userLeaseStart)} - ${escapeHtml(ranges.userLeaseEnd)}</strong><small>login users</small></span>
        <span><strong>${escapeHtml(ranges.anonymousLeaseStart)} - ${escapeHtml(ranges.anonymousLeaseEnd)}</strong><small>anonymous users</small></span>
        <span><strong>${escapeHtml(serviceVip)}</strong><small>service VIP</small></span>
        <span><strong>10.88.88.88</strong><small>Internal control plane</small></span>
      </div>
    </div>
  `;
}

function renderAppEmbedNetworkSection(draft) {
  const channelId = normalizeStandaloneProductId(draft.standaloneChannelProductId || MX_H2I_PRODUCT_ID);
  const channel = launcherProductNetwork(channelId);
  return `
    <div class="app-network-panel">
      <label class="app-form-field">
        <span>Standalone Channel</span>
        <select data-app-field="standaloneChannelProductId">
          ${renderRelayProductOptions(channelId)}
        </select>
      </label>
      <p>Embed mode is lightweight: no extra local tunnel owner, no separate WG service, and no editable product IP segment.</p>
      <div class="app-network-facts">
        <span><strong>${escapeHtml(launcherProductDisplayName(channelId, channel))}</strong><small>channel owner</small></span>
        <span><strong>${escapeHtml(channel.serviceVip || '10.88.100.1')}</strong><small>channel service VIP</small></span>
        <span><strong>${escapeHtml(channel.userLeaseStart || '10.89.0.1')} - ${escapeHtml(channel.userLeaseEnd || '10.89.99.254')}</strong><small>login users</small></span>
        <span><strong>${escapeHtml(channel.anonymousLeaseStart || '10.89.100.1')} - ${escapeHtml(channel.anonymousLeaseEnd || '10.89.254.254')}</strong><small>anonymous users</small></span>
      </div>
    </div>
  `;
}

function appEditorDraftFromForm(root) {
  const current = appCatalogEditorDraft() || {};
  const editing = state.appCatalogEditor?.mode === 'edit';
  const appId = editing
    ? cleanLauncherProductId(current.appId)
    : cleanLauncherProductId(appEditorValue(root, 'appId') || appEditorValue(root, 'displayName'));
  const launcherMode = appEditorValue(root, 'launcherMode') === 'standalone' ? 'standalone' : 'embed';
  const fallbackSecondOctet = current.productSecondOctet || nextAvailableProductSecondOctet(appId || null, launcherMode);
  const previousDefaultDnsHost = launcherAppDefaultDnsHost(current.appId);
  const rawDnsHost = appEditorValue(root, 'dnsHost') || current.dnsHost || launcherAppDefaultDnsHost(appId);
  const dnsHost = (!current.dnsHost || rawDnsHost === previousDefaultDnsHost)
    ? launcherAppDefaultDnsHost(appId)
    : rawDnsHost;
  const baseDraft = {
    ...current,
    appId,
    displayName: appEditorValue(root, 'displayName') || current.displayName || '',
    category: appEditorValue(root, 'category') || current.category || 'custom',
    version: appEditorValue(root, 'version') || current.version || '0.1.0',
    description: appEditorValue(root, 'description') || current.description || '',
    onboardingTemplate: appEditorValue(root, 'onboardingTemplate') || current.onboardingTemplate || 'standalone-service',
    launcherMode,
    standaloneChannelProductId: launcherMode === 'standalone'
      ? appId || current.appId || MX_H2I_PRODUCT_ID
      : normalizeStandaloneProductId(appEditorValue(root, 'standaloneChannelProductId') || current.standaloneChannelProductId || MX_H2I_PRODUCT_ID),
    productSecondOctet: normalizeProductSecondOctet(appEditorValue(root, 'productSecondOctet') || fallbackSecondOctet, fallbackSecondOctet),
    enabled: appEditorValue(root, 'enabled') !== false,
    channels: uniqueStringList(current.channels).length ? uniqueStringList(current.channels) : ['shadow', 'beta', 'stable'],
    accessDefaultDecision: appEditorValue(root, 'accessDefaultDecision') || current.accessDefaultDecision || 'private',
    accessAllowAdmin: appEditorValue(root, 'accessAllowAdmin') !== false,
    accessRequirePermissionGrant: appEditorValue(root, 'accessRequirePermissionGrant') === true,
    accessAllowRoles: appEditorValue(root, 'accessAllowRoles') || current.accessAllowRoles || '',
    accessAllowUserIds: appEditorValue(root, 'accessAllowUserIds') || current.accessAllowUserIds || '',
    accessAllowOrgIds: appEditorValue(root, 'accessAllowOrgIds') || current.accessAllowOrgIds || '',
    accessAllowRegisteredByAppIds: appEditorValue(root, 'accessAllowRegisteredByAppIds') || current.accessAllowRegisteredByAppIds || '',
    accessAllowHomeAppIds: appEditorValue(root, 'accessAllowHomeAppIds') || current.accessAllowHomeAppIds || '',
    dnsRouteEnabled: appEditorValue(root, 'dnsRouteEnabled') !== false,
    dnsHost,
    dnsRouteId: launcherAppDnsRouteId(dnsHost),
    dnsTarget: current.dnsTarget || MX_INTERNAL_DNS_IP,
    dnsTargetUrl: appEditorValue(root, 'dnsTargetUrl') || current.dnsTargetUrl || launcherAppDefaultUpstreamUrl(current.onboardingTemplate),
    dnsRouteTlsMode: current.dnsRouteTlsMode || 'internal',
    dnsRouteAuthRequired: current.dnsRouteAuthRequired !== false
  };
  if (!baseDraft.description) baseDraft.description = launcherAppDefaultDescription(baseDraft);
  return {
    ...baseDraft,
    requiredCapabilities: launcherAppEffectiveCapabilities(baseDraft),
    permissions: launcherAppEffectivePermissions(baseDraft),
    updatePolicy: launcherAppEffectiveUpdatePolicy(baseDraft)
  };
}

function bindAppEditorDrawerControls() {
  if (!appEditorDrawer || appEditorDrawer.hidden) return;
  const form = appEditorDrawer.querySelector('[data-app-editor]');
  if (!form) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveAppCenterAppFromEditor(form);
  });
  for (const close of appEditorDrawer.querySelectorAll('[data-app-editor-close], [data-app-editor-cancel]')) {
    close.addEventListener('click', () => closeAppCatalogEditor());
  }
  for (const suggested of appEditorDrawer.querySelectorAll('[data-app-use-suggested-octet]')) {
    suggested.addEventListener('click', () => {
      const input = form.querySelector('[data-app-field="productSecondOctet"]');
      if (input) input.value = suggested.dataset.appUseSuggestedOctet || input.value;
      state.appCatalogEditor.draft = appEditorDraftFromForm(form);
      state.appCatalogFeedback = null;
      renderAppEditorDrawer();
    });
  }
  for (const control of appEditorDrawer.querySelectorAll('[data-app-field="launcherMode"], [data-app-field="standaloneChannelProductId"], [data-app-field="productSecondOctet"], [data-app-field="category"], [data-app-field="dnsRouteEnabled"], [data-app-field="onboardingTemplate"], [data-app-field="appId"], [data-app-field="displayName"], [data-app-field="dnsHost"], [data-app-field="dnsTargetUrl"], [data-app-field="accessDefaultDecision"], [data-app-field="accessAllowAdmin"], [data-app-field="accessRequirePermissionGrant"]')) {
    control.addEventListener('change', () => {
      const nextDraft = appEditorDraftFromForm(form);
      state.appCatalogEditor.draft = control.dataset.appField === 'onboardingTemplate'
        ? applyLauncherAppTemplateToDraft(nextDraft, control.value, { forceIdentity: state.appCatalogEditor?.mode !== 'edit', refreshDns: true })
        : nextDraft;
      state.appCatalogFeedback = null;
      renderAppEditorDrawer();
      if (control.dataset.appField === 'onboardingTemplate') {
        void hydrateAppCatalogEditorDefaultsFromServer({ forceIdentity: state.appCatalogEditor?.mode !== 'edit' });
      }
    });
  }
  for (const control of appEditorDrawer.querySelectorAll('[data-app-field]')) {
    control.addEventListener('input', () => {
      if (state.appCatalogEditor?.mode !== 'edit' && control.dataset.appField === 'displayName') {
        const appIdInput = form.querySelector('[data-app-field="appId"]');
        if (appIdInput && !String(appIdInput.value || '').trim()) {
          const generatedAppId = cleanLauncherProductId(control.value);
          if (generatedAppId) appIdInput.value = generatedAppId;
        }
      }
      state.appCatalogEditor.draft = appEditorDraftFromForm(form);
      state.appCatalogFeedback = null;
      if (control.dataset.appField === 'productSecondOctet') {
        renderAppEditorDrawer();
      }
    });
  }
}

function bindAppCatalogControls() {
  if (!appProductsPanel) return;
  const search = appProductsPanel.querySelector('[data-app-filter="search"]');
  if (search) {
    search.addEventListener('input', () => {
      state.appCatalogFilter = search.value;
      renderAppCatalogPanel();
    });
  }
  const mode = appProductsPanel.querySelector('[data-app-filter="mode"]');
  if (mode) {
    mode.addEventListener('change', () => {
      state.appCatalogModeFilter = mode.value || 'all';
      renderAppCatalogPanel();
    });
  }
  const create = appProductsPanel.querySelector('[data-app-new]');
  if (create) {
    create.addEventListener('click', () => {
      openAppCatalogEditor('create');
    });
  }
  for (const row of appProductsPanel.querySelectorAll('[data-app-select]')) {
    row.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      selectAppNode(row.dataset.appSelect);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      selectAppNode(row.dataset.appSelect);
    });
  }
  for (const button of appProductsPanel.querySelectorAll('[data-app-edit]')) {
    button.addEventListener('click', () => {
      openAppCatalogEditor('edit', button.dataset.appEdit);
    });
  }
  for (const button of appProductsPanel.querySelectorAll('[data-app-delete]')) {
    button.addEventListener('click', () => void deleteAppCenterAppFromCatalog(button.dataset.appDelete));
  }
}

function selectAppNode(appId) {
  const normalized = normalizeLauncherProductId(appId);
  state.activeAppNode = normalized;
  state.appCatalogFeedback = null;
  for (const tab of tabs) {
    const active = tab.dataset.view === 'app-center' && (tab.dataset.appNode || APP_CENTER_PRODUCT_ID) === normalized;
    tab.classList.toggle('is-active', active);
  }
  renderAppCenterShell();
}

function appEditorValue(root, field) {
  const elements = Array.from(root.querySelectorAll(`[data-app-field="${field}"]`));
  const element = elements.find((item) => item.type === 'radio' ? item.checked : true);
  if (!element) return null;
  if (element.type === 'checkbox') return element.checked;
  if (element.type === 'radio') return element.checked ? element.value : null;
  return blankToNull(element.value);
}

function launcherAppDnsRoutePayload(draft, appId) {
  const host = String(draft.dnsHost || launcherAppDefaultDnsHost(appId)).trim().toLowerCase();
  const routeId = draft.dnsRouteId || launcherAppDnsRouteId(host);
  return {
    routeId,
    host,
    dnsTarget: draft.dnsTarget || MX_INTERNAL_DNS_IP,
    targetUrl: blankToNull(draft.dnsTargetUrl) || launcherAppDefaultUpstreamUrl(draft.onboardingTemplate),
    enabled: true,
    tlsMode: draft.dnsRouteTlsMode || 'internal',
    authRequired: draft.dnsRouteAuthRequired !== false,
    requestedBy: 'desktop-admin'
  };
}

async function syncLauncherAppDnsRoute(draft, appId) {
  if (draft.dnsRouteEnabled === false) return null;
  const body = launcherAppDnsRoutePayload(draft, appId);
  const payload = await fetchJson(`/internal/v1/dns/reverse-proxy/routes/${encodeURIComponent(body.routeId)}`, {
    method: 'POST',
    body
  });
  await refreshDnsRoutesFromAdmin();
  return payload.route || body;
}

async function saveAppCenterAppFromEditor(root) {
  const draft = appEditorDraftFromForm(root);
  const appId = cleanLauncherProductId(draft.appId);
  if (!appId) {
    state.appCatalogFeedback = { kind: 'error', message: 'App ID is required.' };
    if (state.appCatalogEditor) state.appCatalogEditor.draft = draft;
    renderAppEditorDrawer();
    return;
  }
  const launcherMode = draft.launcherMode === 'standalone' ? 'standalone' : 'embed';
  const secondOctet = normalizeProductSecondOctet(draft.productSecondOctet, nextAvailableProductSecondOctet(appId, launcherMode));
  const conflict = launcherMode === 'standalone' ? productNetworkSecondOctetConflict(secondOctet, appId) : null;
  if (conflict) {
    state.appCatalogFeedback = {
      kind: 'error',
      message: `10.${secondOctet}.* is already used by ${conflict.displayName || conflict.productId}.`
    };
    if (state.appCatalogEditor) state.appCatalogEditor.draft = { ...draft, productSecondOctet: secondOctet };
    renderAppEditorDrawer();
    return;
  }
  const body = {
    appId,
    displayName: draft.displayName || appId,
    category: draft.category || 'custom',
    version: draft.version || '0.1.0',
    description: draft.description || launcherAppDefaultDescription({ ...draft, appId, launcherMode }),
    launcherMode,
    standaloneChannelProductId: launcherMode === 'standalone'
      ? appId
      : normalizeStandaloneProductId(draft.standaloneChannelProductId || MX_H2I_PRODUCT_ID),
    productNetworkId: appId,
    channels: uniqueStringList(draft.channels).length ? uniqueStringList(draft.channels) : ['shadow', 'beta', 'stable'],
    permissions: launcherAppEffectivePermissions({ ...draft, appId, launcherMode }),
    requiredCapabilities: launcherAppEffectiveCapabilities({ ...draft, appId, launcherMode }),
    accessPolicy: {
      defaultDecision: ['public', 'authenticated', 'private'].includes(draft.accessDefaultDecision) ? draft.accessDefaultDecision : 'private',
      allowAdmin: draft.accessAllowAdmin !== false,
      allowRoles: stringListFromText(draft.accessAllowRoles),
      allowUserIds: stringListFromText(draft.accessAllowUserIds),
      allowOrgIds: stringListFromText(draft.accessAllowOrgIds),
      allowRegisteredByAppIds: stringListFromText(draft.accessAllowRegisteredByAppIds),
      allowHomeAppIds: stringListFromText(draft.accessAllowHomeAppIds),
      requirePermissionGrant: draft.accessRequirePermissionGrant === true
    },
    updatePolicy: launcherAppEffectiveUpdatePolicy({ ...draft, appId, launcherMode }),
    enabled: draft.enabled !== false,
    requestedBy: 'desktop-admin'
  };
  state.appCatalogBusy = true;
  state.appCatalogFeedback = null;
  if (state.appCatalogEditor) state.appCatalogEditor.draft = { ...draft, appId, productSecondOctet: secondOctet };
  renderAppEditorDrawer();
  try {
    let savedDnsRoute = null;
    if (launcherMode === 'standalone') {
      const ranges = relayProductNetworkShape(secondOctet);
      const networkPayload = {
        productId: appId,
        displayName: body.displayName,
        mode: 'standalone',
        standaloneChannelProductId: appId,
        productIndex: productIndexForSecondOctet(secondOctet, appId),
        serviceVip: serviceVipForProductSecondOctet(secondOctet, appId),
        ...ranges,
        defaultDomesticSiteId: selectedDomesticSiteId() || 'domestic-main',
        updatePolicy: launcherProductEffectiveUpdatePolicy({ ...draft, appId, launcherMode }),
        enabled: body.enabled,
        requestedBy: 'desktop-admin',
        requestId: `desktop-app-network-${Date.now()}`
      };
      const networkResponse = await fetchJson(`/internal/v1/launcher-network/products/${encodeURIComponent(appId)}`, {
        method: 'POST',
        body: networkPayload
      });
      if (networkResponse.product) upsertLocalLauncherProduct(networkResponse.product);
    }
    const payload = await fetchJson(`/internal/v1/app-center/apps/${encodeURIComponent(appId)}`, {
      method: 'POST',
      body
    });
    savedDnsRoute = await syncLauncherAppDnsRoute({ ...draft, appId, launcherMode }, appId);
    const app = payload.app || body;
    state.appCenterApps = [
      app,
      ...orderedAppCenterApps().filter((item) => item.appId !== app.appId)
    ];
    state.activeAppNode = app.appId;
    state.appCatalogEditor = null;
    state.appCatalogFeedback = {
      kind: 'success',
      message: savedDnsRoute
        ? `${app.displayName || app.appId} saved with DNS route ${savedDnsRoute.host}.`
        : `${app.displayName || app.appId} saved.`
    };
  } catch (error) {
    state.appCatalogFeedback = { kind: 'error', message: error.message };
  } finally {
    state.appCatalogBusy = false;
    renderAppCenterShell();
  }
}

async function deleteAppCenterAppFromCatalog(appId) {
  const app = appCenterAppById(appId);
  if (!app || app.builtin || app.systemOwned) return;
  state.appCatalogBusy = true;
  state.appCatalogFeedback = null;
  renderAppCatalogPanel();
  try {
    await fetchJson(`/internal/v1/app-center/apps/${encodeURIComponent(app.appId)}`, { method: 'DELETE' });
    state.appCenterApps = orderedAppCenterApps().filter((item) => item.appId !== app.appId);
    if (state.activeAppNode === app.appId) state.activeAppNode = MX_H2I_PRODUCT_ID;
    state.appCatalogFeedback = { kind: 'success', message: `${app.displayName || app.appId} deleted.` };
  } catch (error) {
    state.appCatalogFeedback = { kind: 'error', message: error.message };
  } finally {
    state.appCatalogBusy = false;
    renderAppCenterShell();
  }
}

function renderLauncherFoundationCard() {
  const mxH2i = launcherProductNetwork(MX_H2I_PRODUCT_ID);
  const embedApps = orderedAppCenterApps().filter((app) => launcherModeForApp(app) === 'embed');
  const runtimeLeases = launcherLeasesForProduct(MX_H2I_PRODUCT_ID).filter((lease) => launcherLeaseIsRuntimeClient(lease));
  const networkProductCount = asArray(state.launcherProducts)
    .filter((product) => product?.productId !== LAUNCHER_FOUNDATION_PRODUCT_ID)
    .length;
  const productCount = Math.max(networkProductCount, orderedAppCenterApps().length, 3);
  const error = state.appCenterAppsError || state.launcherProductsError || state.launcherLeasesError || '';
  return `
    <section class="setup-guide-card launcher-foundation-card">
      <div>
        <span class="site-kind">Launcher Foundation</span>
        <strong>Launcher is the shared base; apps choose standalone or embed mode</strong>
        <p>MX-H2I is the default VPN app and owns the standalone channel. AppCenter, H2O, and custom embed apps reuse that channel without installing another TUN/WG/DNS owner.</p>
      </div>
      <div class="launcher-foundation-facts">
        <span><strong>standalone</strong><small>${escapeHtml(launcherProductDisplayName(MX_H2I_PRODUCT_ID, mxH2i))} / ${escapeHtml(formatLeaseRange(mxH2i.userLeaseStart, mxH2i.userLeaseEnd))}</small></span>
        <span><strong>embed</strong><small>${escapeHtml(embedApps.map((app) => app.displayName || app.appId).join(' / ') || 'custom apps')} via MX-H2I</small></span>
        <span><strong>${escapeHtml(String(runtimeLeases.length))}</strong><small>runtime client leases</small></span>
        <span><strong>${escapeHtml(String(productCount))}</strong><small>registered products</small></span>
      </div>
      ${error ? `<p class="profile-feedback" data-kind="error">${escapeHtml(error)}</p>` : ''}
    </section>
  `;
}

function renderLauncherFoundationOverview() {
  if (!launcherFoundationOverview) return;
  launcherFoundationOverview.innerHTML = renderLauncherFoundationCard();
}

function renderAppCenterProductNetwork() {
  renderSelectedAppDetail();
}

function renderSelectedAppDetail() {
  if (!appSelectedDetail) return;
  const app = activeAppCenterApp();
  const mode = launcherModeForApp(app);
  const productId = productNetworkIdForApp(app);
  const product = launcherProductNetwork(productId);
  const channelProductId = standaloneChannelIdForApp(app);
  const channelProduct = launcherProductNetwork(channelProductId);
  const leases = launcherLeasesForProduct(channelProductId).filter((lease) => launcherLeaseIsRuntimeClient(lease));
  const mxH2iSmokeLeases = launcherLeasesForProduct(MX_H2I_PRODUCT_ID);
  const latestLease = leases[0] || null;
  const error = state.appCenterAppsError || state.launcherProductsError || state.launcherLeasesError || '';
  const channels = asArray(app.channels).length ? asArray(app.channels) : ['shadow', 'beta', 'stable'];
  const capabilities = Array.from(new Set([
    ...asArray(app.requiredCapabilities),
    mode === 'standalone' ? 'launcher-standalone' : 'launcher-embed-sdk',
    'rbac-scope',
    'gray-release'
  ])).slice(0, 8);
  const channelLabel = mode === 'standalone'
    ? 'self'
    : launcherProductDisplayName(channelProductId, channelProduct);
  const appName = app.displayName || launcherProductDisplayName(app.appId, null);
  appSelectedDetail.innerHTML = `
    <section class="app-workbench" aria-labelledby="selected-app-title">
      <header class="app-workbench-hero">
        <div>
          <span class="site-kind">Launcher App</span>
          <h3 id="selected-app-title">${escapeHtml(appName)}</h3>
          <p>${escapeHtml(app.description || 'Launcher powered application.')}</p>
        </div>
        <span class="product-state">${escapeHtml(appStatusLabel(app))}</span>
        <div class="action-row">
          <button class="primary-button" type="button" data-selected-app-launch>Launch</button>
          <button class="secondary-button" type="button" data-selected-app-edit>Edit App</button>
          <button class="secondary-button" type="button" data-selected-app-users>Users / RBAC</button>
          <button class="secondary-button" type="button" data-selected-app-admin>Open Admin</button>
        </div>
      </header>

      ${error ? `<div class="feedback error">${escapeHtml(error)}</div>` : ''}

      <section class="product-network-panel app-workbench-network" aria-label="Selected application network">
        <div class="product-network-head">
          <div>
            <strong>Launcher Channel</strong>
            <span>${escapeHtml(mode === 'standalone' ? 'standalone owner' : `embed via ${channelLabel}`)}</span>
          </div>
          <span class="product-network-badge">${escapeHtml(latestLease?.leaseIp || product.serviceVip || channelProduct.serviceVip || '10.88.100.1')}</span>
        </div>
        <div class="product-network-facts">
          <span><strong>${escapeHtml(mode)}</strong><small>launcher mode</small></span>
          <span><strong>${escapeHtml(channelLabel)}</strong><small>standalone channel</small></span>
          <span><strong>${escapeHtml(product.serviceVip || '-')}</strong><small>service VIP</small></span>
          <span><strong>${escapeHtml(product.internalControlIp || '10.88.88.88')}</strong><small>Internal</small></span>
          <span><strong>${escapeHtml(formatLeaseRange(channelProduct.userLeaseStart, channelProduct.userLeaseEnd))}</strong><small>login users</small></span>
          <span><strong>${escapeHtml(formatLeaseRange(channelProduct.anonymousLeaseStart, channelProduct.anonymousLeaseEnd))}</strong><small>anonymous users</small></span>
        </div>
      </section>

      ${renderSelectedAppServiceVipSmoke(app)}

      <div class="app-workbench-panels">
        <section class="app-workbench-panel">
          <div class="app-workbench-panel-head">
            <span>01</span>
            <strong>Config Management</strong>
          </div>
          <div class="app-workbench-facts">
            <span><strong>${escapeHtml(app.appId || '-')}</strong><small>app id</small></span>
            <span><strong>${escapeHtml(app.category || 'custom')}</strong><small>category</small></span>
            <span><strong>${escapeHtml(app.version || '0.1.0')}</strong><small>version</small></span>
            <span><strong>${escapeHtml(app.enabled === false ? 'disabled' : 'enabled')}</strong><small>client visibility</small></span>
          </div>
        </section>

        <section class="app-workbench-panel">
          <div class="app-workbench-panel-head">
            <span>02</span>
            <strong>Gray Release</strong>
          </div>
          <div class="app-release-lanes">
            ${channels.map((channel, index) => `
              <article>
                <strong>${escapeHtml(channel)}</strong>
                <span>${escapeHtml(index === 0 ? 'canary' : index === channels.length - 1 ? 'stable' : 'progressive')}</span>
                <small>${escapeHtml(app.version || '0.1.0')}</small>
              </article>
            `).join('')}
          </div>
        </section>

        <section class="app-workbench-panel">
          <div class="app-workbench-panel-head">
            <span>03</span>
            <strong>Features</strong>
          </div>
          <div class="app-feature-chips">
            ${capabilities.map((capability) => `<span>${escapeHtml(capability)}</span>`).join('')}
          </div>
        </section>

        <section class="app-workbench-panel">
          <div class="app-workbench-panel-head">
            <span>04</span>
            <strong>Permissions</strong>
          </div>
          <div class="app-permission-rows">
            <article><strong>${escapeHtml(app.appId || 'app')}:use</strong><span>runtime access</span><small>0 users</small></article>
            <article><strong>${escapeHtml(app.appId || 'app')}:admin</strong><span>admin access</span><small>0 users</small></article>
            <article><strong>${escapeHtml(app.appId || 'app')}:release</strong><span>release access</span><small>0 users</small></article>
          </div>
        </section>
      </div>

      <section class="app-workbench-panel app-service-registry">
        <div class="app-workbench-panel-head">
          <span>05</span>
          <strong>Service Registry</strong>
        </div>
        <div class="app-workbench-facts">
          <span><strong>${escapeHtml(`${app.appId || 'app'}.launcher`)}</strong><small>sdk namespace</small></span>
          <span><strong>${escapeHtml(channelProduct.defaultDomesticSiteId || 'domestic-main')}</strong><small>domestic relay</small></span>
          <span><strong>${escapeHtml(product.updatePolicy || 'launcher-managed')}</strong><small>update policy</small></span>
          <span><strong>${escapeHtml(String(leases.length))}</strong><small>runtime leases</small></span>
        </div>
      </section>

      <section class="product-network-panel app-workbench-leases" aria-label="Launcher leases">
        <div class="product-network-head">
          <div>
            <strong>Runtime Leases</strong>
            <span>${escapeHtml(channelLabel)} channel clients</span>
          </div>
        </div>
        <div class="product-lease-list">
          ${leases.slice(0, 4).map((lease) => `
            <article>
              <strong>${escapeHtml(lease.leaseIp || '-')}</strong>
              <span>${escapeHtml(`${lease.identityKind || 'identity'} / ${lease.launcherMode || 'mode'} / ${lease.deviceLabel || lease.deviceId || '-'}`)}</span>
              <small>${escapeHtml(lease.leaseId || '-')}</small>
            </article>
          `).join('') || '<div class="empty-state">No Launcher client lease yet.</div>'}
        </div>
        <div class="product-network-actions">
          <button class="secondary-button" type="button" data-selected-app-domestic>Domestic Setup</button>
        </div>
      </section>

      ${app.appId === MX_H2I_PRODUCT_ID ? `
        <details class="product-network-advanced" ${mxH2iSmokeLeases.length ? '' : 'open'}>
          <summary>Advanced lease smoke</summary>
          ${renderRelayEnrollmentPanel({
            productId: MX_H2I_PRODUCT_ID,
            lockProduct: true,
            title: 'MX-H2I Relay Smoke',
            actionLabel: 'Create MX-H2I Lease',
            compact: true
          })}
        </details>
      ` : ''}
    </section>
  `;
  bindRelayEnrollmentControls(appSelectedDetail);
  const launchButton = appSelectedDetail.querySelector('[data-selected-app-launch]');
  if (launchButton) launchButton.addEventListener('click', () => void launchHdiProduct());
  const editButton = appSelectedDetail.querySelector('[data-selected-app-edit]');
  if (editButton) editButton.addEventListener('click', () => openAppCatalogEditor('edit', app.appId));
  const usersButton = appSelectedDetail.querySelector('[data-selected-app-users]');
  if (usersButton) {
    usersButton.addEventListener('click', () => {
      setActiveView('admin', {
        menu: 'internal',
        section: 'foundations',
        subsection: 'user-center'
      });
    });
  }
  const adminButton = appSelectedDetail.querySelector('[data-selected-app-admin]');
  if (adminButton) adminButton.addEventListener('click', () => void api.openAdmin(serverInput.value));
  const domesticButton = appSelectedDetail.querySelector('[data-selected-app-domestic]');
  if (domesticButton) {
    domesticButton.addEventListener('click', () => {
      setActiveView('admin', {
        menu: 'operations',
        section: 'deployment',
        subsection: 'domestic',
        deploymentKind: 'domestic'
      });
    });
  }
  const cidrSyncButton = appSelectedDetail.querySelector('[data-service-vip-sync-domestic-cidrs]');
  if (cidrSyncButton) {
    cidrSyncButton.addEventListener('click', () => {
      void syncLauncherServiceVipDomesticCidrs(
        cidrSyncButton.dataset.serviceVipSyncDomesticCidrs,
        cidrSyncButton.dataset.serviceVipSyncApp
      );
    });
  }
  const domesticSetupButton = appSelectedDetail.querySelector('[data-service-vip-open-domestic-setup]');
  if (domesticSetupButton) {
    domesticSetupButton.addEventListener('click', () => {
      openDomesticSetupFromServiceVip(app);
    });
  }
}

function openDomesticSetupFromServiceVip(app) {
  const smoke = launcherServiceVipSmokeForApp(app);
  const cidrCheck = asArray(smoke?.checks).find((check) => check.checkId === 'domestic-product-cidrs') || null;
  const domesticSiteId = smoke?.domesticSiteId || 'domestic-main';
  state.launcherServiceVipSetupHint = {
    appId: smoke?.appId || app?.appId || '',
    displayName: smoke?.displayName || app?.displayName || app?.appId || 'Launcher app',
    domesticSiteId,
    serviceVip: smoke?.serviceVip || null,
    dnsHost: smoke?.dnsHost || null,
    expectedProductRelayCidrs: cidrCheck?.expected || null,
    productRelayCidrs: cidrCheck?.actual || null
  };
  state.selectedSiteId = domesticSiteId;
  state.preferredActionFocus = {
    actionIds: [
      'site-slot.domestic-wg.materialize',
      'site-slot.apply.confirm',
      'site-slot.runner.remote-ssh',
      'site-slot.worker-job.create',
      'site-slot.worker-run.remote-ssh-gate',
      'site-slot.worker-run.remote-ssh-execute',
      'site-slot.worker-run.domestic-relay-readonly-probe'
    ]
  };
  setActiveView('admin', {
    menu: 'operations',
    section: 'deployment',
    subsection: 'domestic',
    deploymentKind: 'domestic'
  });
}

async function syncLauncherServiceVipDomesticCidrs(siteId, appId) {
  const domesticSiteId = siteId || 'domestic-main';
  if (state.launcherServiceVipCidrSyncBusy) return;
  state.launcherServiceVipCidrSyncBusy = domesticSiteId;
  state.launcherServiceVipCidrSyncFeedback = {
    appId,
    kind: 'info',
    message: `Syncing Domestic product CIDRs for ${domesticSiteId}.`,
    detail: ''
  };
  renderSelectedAppDetail();
  try {
    const payload = await fetchJson('/internal/v1/admin/launcher-service-vip-smokes/domestic-product-cidrs/sync', {
      method: 'POST',
      body: {
        siteId: domesticSiteId,
        requestedBy: 'desktop-admin',
        requestId: `desktop-launcher-service-vip-cidr-sync-${Date.now()}`
      }
    });
    const result = payload.domesticProductCidrSync || {};
    const added = asArray(result.addedProductRelayCidrs).join(', ') || 'none';
    const finalCidrs = asArray(result.productRelayCidrs).join(', ') || '-';
    const nextActions = asArray(result.nextActions).join(' ');
    const blockedReasons = asArray(result.blockedReasons).join(' ');
    state.launcherServiceVipCidrSyncFeedback = {
      appId,
      kind: result.status === 'blocked' ? 'error' : 'success',
      message: result.status === 'blocked'
        ? 'Domestic CIDR sync blocked.'
        : result.changed
        ? `Domestic CIDRs synced: added ${added}.`
        : `Domestic CIDRs already cover this site.`,
      detail: [blockedReasons, `final ${finalCidrs}`, nextActions].filter(Boolean).join(' / ')
    };
    await refreshAppCenterNetwork();
  } catch (error) {
    state.launcherServiceVipCidrSyncFeedback = {
      appId,
      kind: 'error',
      message: error.message,
      detail: ''
    };
  } finally {
    state.launcherServiceVipCidrSyncBusy = null;
    renderSelectedAppDetail();
  }
}

function launcherServiceVipSmokeForApp(app) {
  const appId = normalizeLauncherProductId(app?.appId || '');
  const productId = productNetworkIdForApp(app || {});
  return asArray(state.launcherServiceVipSmokes)
    .find((smoke) => smoke?.appId === appId || smoke?.productId === productId)
    || null;
}

function renderSelectedAppServiceVipSmoke(app) {
  const smoke = launcherServiceVipSmokeForApp(app);
  if (!smoke) {
    const message = state.launcherServiceVipSmokesError
      ? `Service VIP smoke unavailable: ${state.launcherServiceVipSmokesError}`
      : 'Waiting for dashboard service VIP smoke.';
    return `
      <section class="app-workbench-panel app-service-vip-smoke">
        <div class="app-workbench-panel-head">
          <span>VIP</span>
          <strong>Service VIP materialization</strong>
        </div>
        <div class="empty-state">${escapeHtml(message)}</div>
      </section>
    `;
  }
  const status = smoke.status || 'warning';
  const checks = asArray(smoke.checks);
  const cidrBlocked = checks.some((check) => check.checkId === 'domestic-product-cidrs' && check.status === 'blocked');
  const needsDomesticRuntimeApply = !cidrBlocked && status !== 'passed';
  const syncBusy = state.launcherServiceVipCidrSyncBusy === smoke.domesticSiteId;
  const syncFeedback = state.launcherServiceVipCidrSyncFeedback;
  const feedbackVisible = syncFeedback && (!syncFeedback.appId || syncFeedback.appId === smoke.appId);
  return `
    <section class="app-workbench-panel app-service-vip-smoke">
      <div class="app-workbench-panel-head">
        <span>VIP</span>
        <strong>Service VIP materialization</strong>
        <mark data-kind="${escapeHtml(status === 'passed' ? 'system' : status === 'blocked' ? 'custom' : 'muted')}">${escapeHtml(status)}</mark>
      </div>
      <p class="profile-feedback" data-kind="${escapeHtml(status === 'passed' ? 'success' : status === 'blocked' ? 'error' : 'warning')}">${escapeHtml(smoke.summary || '')}</p>
      ${feedbackVisible ? `
        <p class="profile-feedback" data-kind="${escapeHtml(syncFeedback.kind || 'info')}">
          ${escapeHtml(syncFeedback.message || '')}${syncFeedback.detail ? ` / ${escapeHtml(syncFeedback.detail)}` : ''}
        </p>
      ` : ''}
      <div class="app-workbench-facts">
        <span><strong>${escapeHtml(smoke.serviceVip || '-')}</strong><small>service VIP</small></span>
        <span><strong>${escapeHtml(smoke.dnsHost || '-')}</strong><small>dns host</small></span>
        <span><strong>${escapeHtml(smoke.upstreamUrl || '-')}</strong><small>gateway upstream</small></span>
        <span><strong>${escapeHtml(smoke.latestLeaseIp || '-')}</strong><small>latest lease</small></span>
      </div>
      ${cidrBlocked ? `
        <div class="product-network-actions">
          <button
            class="primary-button"
            type="button"
            data-service-vip-sync-domestic-cidrs="${escapeHtml(smoke.domesticSiteId || 'domestic-main')}"
            data-service-vip-sync-app="${escapeHtml(smoke.appId || '')}"
            ${syncBusy ? 'disabled' : ''}
          >${syncBusy ? 'Syncing CIDRs' : 'Sync Domestic CIDRs'}</button>
          <span>Update Config Center productRelayCidrs from registered standalone ProductNetwork ranges.</span>
        </div>
      ` : ''}
      ${needsDomesticRuntimeApply ? `
        <div class="product-network-actions">
          <button
            class="primary-button"
            type="button"
            data-service-vip-open-domestic-setup
          >Run Domestic Setup</button>
          <span>Apply the updated Domestic relay runtime, then return to this app for client data-plane smoke.</span>
        </div>
      ` : ''}
      <div class="app-permission-rows">
        ${checks.map((check) => `
          <article>
            <strong>${escapeHtml(check.label || check.checkId || '-')}</strong>
            <span>${escapeHtml(check.detail || '-')}</span>
            <small>${escapeHtml([check.expected && `expect ${check.expected}`, check.actual && `actual ${check.actual}`].filter(Boolean).join(' / ') || check.status || '-')}</small>
          </article>
        `).join('')}
      </div>
      <div class="app-feature-chips">
        ${asArray(smoke.nextActions).map((action) => `<span>${escapeHtml(action)}</span>`).join('')}
      </div>
    </section>
  `;
}

function renderRbacPanel() {
  const roles = asArray(state.userCenter.roles);
  const rows = roles.map((role) => [
    role.displayName || role.roleId,
    role.roleId,
    asArray(role.scopes).slice(0, 5).join(' / ') || '-',
    `${asArray(role.scopes).length} scopes`
  ]);
  return `
    <section class="foundation-panel foundation-wide">
      <div class="foundation-panel-head">
        <div>
          <h4>Role and scope catalog</h4>
          <p>权限中心定义 Internal 的功能权限结构：角色只是人可读分组，真正门禁使用 scope、resource、action 和 evidence 绑定。</p>
        </div>
        <span>${escapeHtml(String(roles.length))} roles</span>
      </div>
      ${roles.length ? `
        <div class="foundation-table rbac-role-table">
          <article class="foundation-table-row is-header">
            <strong>Role</strong>
            <span>Role ID</span>
            <span>Representative scopes</span>
            <small>Coverage</small>
          </article>
          ${rows.map((row) => `
            <article class="foundation-table-row">
              <strong>${escapeHtml(row[0])}</strong>
              <span>${escapeHtml(row[1])}</span>
              <span>${escapeHtml(row[2])}</span>
              <small>${escapeHtml(row[3])}</small>
            </article>
          `).join('')}
        </div>
      ` : '<div class="empty-state">No roles loaded. Bootstrap User Center first.</div>'}
    </section>
    <section class="foundation-panel">
      <div class="foundation-panel-head">
        <div>
          <h4>Access standard</h4>
          <p>权限不是后台手工猜出来的，系统要把功能结构以 manifest / E2E / SDK 契约上报。</p>
        </div>
      </div>
      ${renderFoundationRows([
        ['Subject', 'user / service-account / device / anonymous install', 'User Center'],
        ['Resource', 'system.module.object, such as oversea.subscription', 'Permission registry'],
        ['Action', 'read / use / create / approve / rollback / release', 'RBAC scope'],
        ['Gate', 'risk level + confirmation + test evidence', 'Action Gates']
      ])}
    </section>
  `;
}

function renderPermissionRegistryPanel() {
  const rows = [
    ['Launcher Runtime', 'launcher.runtime.v1', 'login, device, AppCenter host, network profile, forced update'],
    ['AppCenter', 'appcenter.app.v1', 'install, skip update, gray channel, release evidence'],
    ['H2O', 'h2o.application.v1', 'consume Launcher Network, app config, e2e result'],
    ['Oversea Access', 'oversea.access.v1', 'issue subscription, rotate password, select site group, revoke user'],
    ['Domestic Relay', 'domestic.relay.v1', 'lease peer, DNS/H2I path, relay evidence'],
    ['External System', 'external.manifest.v1', 'reported modules, scopes, tests, release policy']
  ];
  return `
    <section class="foundation-panel foundation-wide">
      <div class="foundation-panel-head">
        <div>
          <h4>Permission registry</h4>
          <p>接入系统维护完整权限功能结构，Internal 根据这份结构做授权、灰度、发版、门禁和审计。</p>
        </div>
        <span>manifest-driven</span>
      </div>
      <div class="foundation-table permission-registry-table">
        <article class="foundation-table-row is-header">
          <strong>System</strong>
          <span>Manifest</span>
          <small>Functional permissions</small>
        </article>
        ${rows.map((row) => `
          <article class="foundation-table-row">
            <strong>${escapeHtml(row[0])}</strong>
            <span>${escapeHtml(row[1])}</span>
            <small>${escapeHtml(row[2])}</small>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function renderExternalSystemContractPanel() {
  return `
    <section class="foundation-panel foundation-wide">
      <div class="foundation-panel-head">
        <div>
          <h4>External onboarding contract</h4>
          <p>MX-Launcher 对自有系统和外部接入系统提供同一条测试、发版、权限和证据链路。</p>
        </div>
        <span>SDK Gateway</span>
      </div>
      <div class="foundation-contract-grid">
        ${[
          ['1. Declare', '系统提交权限树、API surface、E2E 契约和发布资产定义。'],
          ['2. Test', 'E2E Gate 运行 synthetic probe、截图、runner output、配置快照。'],
          ['3. Authorize', 'RBAC 将 role/scope/resource/action 绑定到用户、服务账号或设备。'],
          ['4. Release', 'Release Center 按权限对象做灰度、回滚、跳过和强制策略。'],
          ['5. Observe', 'Observability 把用户行为、系统日志和证据挂回同一 subject。']
        ].map((item) => `
          <article class="foundation-contract-card">
            <strong>${escapeHtml(item[0])}</strong>
            <span>${escapeHtml(item[1])}</span>
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function renderConfigCenterPanel(overview) {
  const rows = [
    ['SSH Profiles', `${asArray(state.sshProfiles).length} profiles`, 'Remote SSH runner、host key、identity、site binding。'],
    ['Runtime Policies', `${asArray(state.awxRuntimePolicies).length} feature gates`, '远程执行、artifact push、rollback、AWX optional gate。'],
    ['Subscription Defaults', `${overview.siteSlotPlans || 0} site plans`, 'hysteria2 port、DNS、rate limit、mihomo YAML 模板。'],
    ['Config Snapshots', `${overview.configPolicySnapshots || 0} snapshots`, '每次下发、测试和发布都保存可回滚快照。']
  ];
  return `
    <section class="foundation-panel foundation-wide">
      <div class="foundation-panel-head">
        <div>
          <h4>Config Center authority</h4>
          <p>站点配置、SSH Profile、订阅模板和 runtime feature policy 都由 Internal 保存，slot 只接收 materialized artifact。</p>
        </div>
        <span>${escapeHtml(String(overview.configPolicySnapshots || 0))} snapshots</span>
      </div>
      ${renderFoundationRows(rows)}
    </section>
    ${renderDomesticRuntimeConfigPanel()}
    ${renderLauncherProductNetworksPanel()}
    <section class="foundation-panel">
      <div class="foundation-panel-head">
        <div>
          <h4>Remote execution source</h4>
          <p>Oversea 默认使用 Remote SSH runner；AWX 只作为已有企业自动化平台的可选 adapter。</p>
        </div>
      </div>
      ${renderFoundationRows([
        ['Default path', 'Internal -> Remote SSH runner -> worker job -> artifact -> Docker hysteria2', 'active'],
        ['AWX adapter', 'Internal -> AWX inventory/credential/job template', 'optional'],
        ['Evidence', 'plan, preflight, runner session, worker report, remote stdout/stderr', 'required']
      ])}
    </section>
  `;
}

function renderDomesticRuntimeConfigPanel() {
  const config = domesticRuntimeConfigForRender();
  const bootstrap = domesticRuntimeBootstrapParts(config);
  const feedback = state.domesticRuntime.feedback;
  const apply = state.domesticRuntime.applyResult;
  const siteIds = uniqueText([
    ...asArray(state.domesticRuntime.configs).map((item) => item.siteId),
    state.domesticRuntime.selectedSiteId,
    selectedDomesticSiteId(),
    'domestic-main'
  ]);
  const warnings = asArray(config.warnings);
  const isBusy = state.domesticRuntime.busy || state.domesticRuntime.applyBusy;
  const publicUrl = domesticRuntimePublicUrl({
    protocol: bootstrap.protocol,
    host: bootstrap.host,
    port: bootstrap.port
  });
  return `
    <section class="foundation-panel foundation-wide domestic-runtime-panel">
      <div class="foundation-panel-head">
        <div>
          <h4>Domestic Runtime Config</h4>
          <p>Internal 保存配置；Apply 会通过 Domestic SSH Profile 更新远端 .env 并重启 edge stack。</p>
        </div>
        <span>${escapeHtml(config.fingerprints?.configDigest || config.status || 'draft')}</span>
      </div>
      ${state.domesticRuntime.error ? `<div class="feedback error">${escapeHtml(state.domesticRuntime.error)}</div>` : ''}
      <div class="foundation-operation-grid domestic-runtime-grid">
        <label class="form-field">
          <span>Domestic Site</span>
          <select data-domestic-runtime-site data-domestic-runtime-field="siteId">
            ${siteIds.map((siteId) => `<option value="${escapeHtml(siteId)}" ${siteId === config.siteId ? 'selected' : ''}>${escapeHtml(siteId)}</option>`).join('')}
          </select>
        </label>
        <label class="form-field compact-field">
          <span>Status</span>
          <select data-domestic-runtime-field="status">
            <option value="active" ${config.status !== 'paused' ? 'selected' : ''}>active</option>
            <option value="paused" ${config.status === 'paused' ? 'selected' : ''}>paused</option>
          </select>
        </label>
        <label class="form-field compact-field">
          <span>Protocol</span>
          <select data-domestic-runtime-field="bootstrapProtocol">
            <option value="http" ${bootstrap.protocol !== 'https' ? 'selected' : ''}>http</option>
            <option value="https" ${bootstrap.protocol === 'https' ? 'selected' : ''}>https</option>
          </select>
        </label>
        <label class="form-field">
          <span>Bootstrap Host</span>
          <input data-domestic-runtime-field="bootstrapHost" autocomplete="off" value="${escapeHtml(bootstrap.host)}" placeholder="api.mxinfo-inc.cn" />
        </label>
        <label class="form-field compact-field">
          <span>Bootstrap Port</span>
          <input data-domestic-runtime-field="bootstrapPort" inputmode="numeric" type="number" min="1" max="65535" value="${escapeHtml(String(bootstrap.port))}" />
        </label>
        <label class="form-field">
          <span>Edge Bind</span>
          <input data-domestic-runtime-field="edgeBind" autocomplete="off" value="${escapeHtml(config.edge?.bind || '0.0.0.0')}" />
        </label>
        <label class="form-field compact-field">
          <span>Edge Port</span>
          <input data-domestic-runtime-field="edgePort" inputmode="numeric" type="number" min="1" max="65535" value="${escapeHtml(String(config.edge?.port || bootstrap.port || 18090))}" />
        </label>
        <label class="form-field wide-field">
          <span>Internal Base URL</span>
          <input data-domestic-runtime-field="internalBaseUrl" autocomplete="off" value="${escapeHtml(config.upstreams?.internalBaseUrl || 'http://10.88.88.88:18090')}" />
        </label>
        <label class="form-field wide-field">
          <span>Internal API Upstream</span>
          <input data-domestic-runtime-field="internalApiUpstream" autocomplete="off" value="${escapeHtml(config.upstreams?.internalApi || config.upstreams?.internalBaseUrl || 'http://10.88.88.88:18090')}" />
        </label>
        <label class="form-field wide-field">
          <span>H2I Upstream</span>
          <input data-domestic-runtime-field="internalH2iUpstream" autocomplete="off" value="${escapeHtml(config.upstreams?.internalH2i || config.upstreams?.internalBaseUrl || 'http://10.88.88.88:18090')}" />
        </label>
        <label class="form-field">
          <span>DNS Bind</span>
          <input data-domestic-runtime-field="dnsBind" autocomplete="off" value="${escapeHtml(config.dns?.bind || '0.0.0.0')}" />
        </label>
        <label class="form-field compact-field">
          <span>DNS Port</span>
          <input data-domestic-runtime-field="dnsPort" inputmode="numeric" type="number" min="1" max="65535" value="${escapeHtml(String(config.dns?.port || 50053))}" />
        </label>
      </div>
      <div class="foundation-list domestic-runtime-summary">
        <article>
          <strong>${escapeHtml(publicUrl)}</strong>
          <span>H 端启动入口；旧端口客户端重启后会按同域名候选端口重新探测。</span>
          <small>${escapeHtml(config.edge?.bind || '0.0.0.0')}:${escapeHtml(String(config.edge?.port || bootstrap.port || '-'))} -> ${escapeHtml(config.upstreams?.internalApi || '-')}</small>
        </article>
        <article>
          <strong>${escapeHtml(config.dns?.bind || '0.0.0.0')}:${escapeHtml(String(config.dns?.port || 50053))}</strong>
          <span>Domestic DNS cache / split DNS edge</span>
          <small>Internal authority remains the source of truth.</small>
        </article>
      </div>
      ${warnings.length ? `<div class="profile-feedback" data-kind="warning">${warnings.map(escapeHtml).join(' / ')}</div>` : ''}
      <div class="foundation-operation-actions">
        <button class="secondary-button" type="button" data-domestic-runtime-save ${isBusy ? 'disabled' : ''}>${state.domesticRuntime.busy ? 'Saving' : 'Save Config'}</button>
        <button class="primary-button" type="button" data-domestic-runtime-apply ${isBusy ? 'disabled' : ''}>${state.domesticRuntime.applyBusy ? 'Applying' : 'Save & Apply'}</button>
        ${feedback ? `<span class="profile-feedback" data-kind="${escapeHtml(feedback.kind)}">${escapeHtml(feedback.message)}</span>` : ''}
      </div>
      ${apply ? renderDomesticRuntimeApplyResult(apply) : ''}
    </section>
  `;
}

function domesticRuntimeConfigForRender() {
  const selected = state.domesticRuntime.selectedSiteId || selectedDomesticSiteId() || 'domestic-main';
  return asArray(state.domesticRuntime.configs).find((config) => config?.siteId === selected)
    || asArray(state.domesticRuntime.configs)[0]
    || domesticRuntimeDefaultConfig(selected);
}

function domesticRuntimeDefaultConfig(siteId = 'domestic-main') {
  const bootstrapHost = domesticRuntimeDefaultBootstrapHost(siteId);
  return {
    siteId,
    status: 'active',
    edge: {
      bind: '0.0.0.0',
      port: 18090,
      publicBaseUrl: `http://${bootstrapHost}:18090`
    },
    upstreams: {
      internalBaseUrl: 'http://10.88.88.88:18090',
      internalApi: 'http://10.88.88.88:18090',
      internalH2i: 'http://10.88.88.88:18090'
    },
    dns: {
      bind: '10.88.0.1',
      port: 53
    },
    warnings: [],
    fingerprints: null
  };
}

function domesticRuntimeDefaultBootstrapHost(siteId = 'domestic-main') {
  const pipeline = asArray(state.dashboard?.siteSlotPipelines)
    .filter((item) => item.kind === 'domestic' && item.siteId === siteId)
    .sort((left, right) => String(right.latestUpdatedAt || '').localeCompare(String(left.latestUpdatedAt || '')))[0] || null;
  const profile = inspectorSshProfile('domestic', siteId);
  return normalizeBootstrapHost(pipeline?.host || profile?.host) || 'api.mxinfo-inc.cn';
}

function normalizeBootstrapHost(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const normalized = text.includes('://') ? text : `http://${text}`;
  try {
    return new URL(normalized).hostname || '';
  } catch {
    const authority = text.split('/')[0] || text;
    const withoutUserInfo = authority.includes('@') ? authority.split('@').pop() || authority : authority;
    return withoutUserInfo.replace(/:\d+$/, '').trim();
  }
}

function domesticRuntimeBootstrapParts(config) {
  const edge = config?.edge || {};
  const fallbackHost = domesticRuntimeDefaultBootstrapHost(config?.siteId || selectedDomesticSiteId() || 'domestic-main');
  try {
    const parsed = new URL(edge.publicBaseUrl);
    const protocol = parsed.protocol.replace(/:$/, '') === 'https' ? 'https' : 'http';
    const port = Number(parsed.port || (protocol === 'https' ? 443 : 80));
    return {
      protocol,
      host: parsed.hostname || fallbackHost,
      port: Number.isFinite(port) ? port : (edge.port || 18090)
    };
  } catch {
    return {
      protocol: 'http',
      host: fallbackHost,
      port: edge.port || 18090
    };
  }
}

function domesticRuntimePublicUrl(input) {
  const protocol = input.protocol === 'https' ? 'https' : 'http';
  const host = input.host || 'api.mxinfo-inc.cn';
  const port = positiveNumberOrNull(input.port) || (protocol === 'https' ? 443 : 80);
  const isDefault = (protocol === 'https' && port === 443) || (protocol === 'http' && port === 80);
  return `${protocol}://${host}${isDefault ? '' : `:${port}`}`;
}

function renderDomesticRuntimeApplyResult(apply) {
  const status = apply.status || apply.execution || 'unknown';
  const details = [
    ['site', apply.siteId || '-'],
    ['ssh', apply.sshProfileId || '-'],
    ['bootstrap', apply.publicBootstrapUrl || apply.config?.edge?.publicBaseUrl || '-'],
    ['remote', apply.remote?.status || apply.remote || '-']
  ];
  return `
    <div class="action-feedback" data-kind="${escapeHtml(status === 'passed' ? 'success' : status === 'blocked' ? 'warning' : 'error')}">
      <strong>${escapeHtml(status === 'passed' ? 'Domestic runtime applied' : `Domestic runtime ${status}`)}</strong>
      <div class="evidence-step-grid domestic-runtime-result-grid">
        ${details.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(formatSummaryValue(value))}</dd></div>`).join('')}
      </div>
      ${asArray(apply.blockedReasons).length ? `<pre>${escapeHtml(apply.blockedReasons.join('\n'))}</pre>` : ''}
    </div>
  `;
}

function bindDomesticRuntimeControls(root) {
  const siteSelect = root.querySelector('[data-domestic-runtime-site]');
  if (siteSelect) {
    siteSelect.addEventListener('change', () => {
      state.domesticRuntime.selectedSiteId = siteSelect.value || 'domestic-main';
      state.domesticRuntime.feedback = null;
      renderDomesticRuntimeContext(root);
    });
  }
  const save = root.querySelector('[data-domestic-runtime-save]');
  if (save) save.addEventListener('click', () => void saveDomesticRuntimeConfigFromAdmin({ apply: false, root }));
  const apply = root.querySelector('[data-domestic-runtime-apply]');
  if (apply) apply.addEventListener('click', () => void saveDomesticRuntimeConfigFromAdmin({ apply: true, root }));
}

function domesticRuntimeFormPayload(root = foundationGrid) {
  const value = (field) => root.querySelector(`[data-domestic-runtime-field="${field}"]`)?.value?.trim() || '';
  const siteId = value('siteId') || state.domesticRuntime.selectedSiteId || selectedDomesticSiteId() || 'domestic-main';
  const bootstrapHost = value('bootstrapHost') || domesticRuntimeDefaultBootstrapHost(siteId);
  return {
    siteId,
    status: value('status') === 'paused' ? 'paused' : 'active',
    edgeBind: value('edgeBind') || '0.0.0.0',
    edgePort: positiveNumberOrNull(value('edgePort')),
    bootstrapProtocol: value('bootstrapProtocol') === 'https' ? 'https' : 'http',
    bootstrapHost: bootstrapHost || 'api.mxinfo-inc.cn',
    bootstrapPort: positiveNumberOrNull(value('bootstrapPort')),
    internalBaseUrl: value('internalBaseUrl') || 'http://10.88.88.88:18090',
    internalApiUpstream: value('internalApiUpstream') || value('internalBaseUrl') || 'http://10.88.88.88:18090',
    internalH2iUpstream: value('internalH2iUpstream') || value('internalBaseUrl') || 'http://10.88.88.88:18090',
    dnsBind: value('dnsBind') || '0.0.0.0',
    dnsPort: positiveNumberOrNull(value('dnsPort')),
    requestedBy: 'desktop-admin',
    requestId: `desktop-domestic-runtime-${Date.now()}`
  };
}

async function saveDomesticRuntimeConfigFromAdmin(options = {}) {
  const shouldApply = options.apply === true;
  const root = options.root || foundationGrid;
  if (state.domesticRuntime.busy || state.domesticRuntime.applyBusy) return;
  const body = domesticRuntimeFormPayload(root);
  state.domesticRuntime.selectedSiteId = body.siteId;
  state.domesticRuntime.feedback = { kind: 'info', message: shouldApply ? 'Applying Domestic runtime config' : 'Saving Domestic runtime config' };
  state.domesticRuntime.applyResult = null;
  if (shouldApply) {
    state.domesticRuntime.applyBusy = true;
  } else {
    state.domesticRuntime.busy = true;
  }
  renderDomesticRuntimeContext(root);
  try {
    if (shouldApply) {
      const payload = await fetchJson('/internal/v1/admin/actions/execute', {
        method: 'POST',
        body: {
          actionId: 'site-slot.domestic-runtime-config.apply',
          path: `/internal/v1/config-center/domestic-runtime-configs/${encodeURIComponent(body.siteId)}/apply`,
          body: {
            ...body,
            planId: state.currentPipeline?.summary?.kind === 'domestic' ? state.currentPipeline.summary.planId : null,
            saveBeforeApply: true,
            confirmDomesticRuntimeApply: true,
            requestId: `desktop-domestic-runtime-apply-${Date.now()}`
          }
        }
      });
      const apply = payload.apply || null;
      state.domesticRuntime.applyResult = apply;
      if (apply?.config) upsertDomesticRuntimeConfig(apply.config);
      state.domesticRuntime.feedback = {
        kind: apply?.status === 'passed' ? 'success' : apply?.status === 'blocked' ? 'warning' : 'error',
        message: apply?.status === 'passed'
          ? `Applied ${apply.publicBootstrapUrl || apply.config?.edge?.publicBaseUrl || body.siteId}`
          : asArray(apply?.blockedReasons)[0] || `Domestic runtime ${apply?.status || 'apply failed'}`
      };
    } else {
      const payload = await fetchJson('/internal/v1/config-center/domestic-runtime-configs', {
        method: 'POST',
        body
      });
      if (payload.config) upsertDomesticRuntimeConfig(payload.config);
      state.domesticRuntime.feedback = {
        kind: 'success',
        message: `Saved ${payload.config?.edge?.publicBaseUrl || body.siteId}`
      };
    }
  } catch (error) {
    state.domesticRuntime.feedback = { kind: 'error', message: error.message };
  } finally {
    state.domesticRuntime.busy = false;
    state.domesticRuntime.applyBusy = false;
    renderDomesticRuntimeContext(root);
  }
}

function renderDomesticRuntimeContext(root) {
  if (root === siteWorkbench && state.adminSection === 'deployment' && state.deploymentKind === 'domestic') {
    renderDeploymentWorkbench(state.dashboard?.siteSlotPipelines || []);
    return;
  }
  renderFoundationGrid(state.dashboard?.overview || {});
}

function upsertDomesticRuntimeConfig(config) {
  if (!config?.siteId) return;
  const next = asArray(state.domesticRuntime.configs).filter((item) => item?.siteId !== config.siteId);
  next.unshift(config);
  state.domesticRuntime.configs = next;
  state.domesticRuntime.selectedSiteId = config.siteId;
}

function renderLauncherProductNetworksPanel() {
  const rawProducts = asArray(state.launcherProducts);
  const hasMxH2iProduct = rawProducts.some((product) => product?.productId === MX_H2I_PRODUCT_ID);
  const products = rawProducts.filter((product) => !(hasMxH2iProduct && product?.productId === LAUNCHER_FOUNDATION_PRODUCT_ID));
  const error = state.launcherProductsError;
  const mxH2iProduct = products.find((product) => product.productId === MX_H2I_PRODUCT_ID) || null;
  const standalone = mxH2iProduct || products.find((product) => product.mode === 'standalone') || null;
  const embedProducts = products.filter((product) => product.mode === 'embed');
  const firstEmbedChannel = embedProducts[0] ? standaloneChannelProductForProduct(embedProducts[0]) : null;
  const rows = products.map((product) => [
    product.displayName || product.productId,
    product.mode,
    launcherProductDisplayName(standaloneChannelProductIdForProduct(product), standaloneChannelProductForProduct(product)),
    product.serviceVip || '-',
    product.mode === 'standalone'
      ? `${formatLeaseRange(product.userLeaseStart, product.userLeaseEnd)} / ${formatLeaseRange(product.anonymousLeaseStart, product.anonymousLeaseEnd)}`
      : 'uses launcher standalone peer',
    product.updatePolicy || '-'
  ]);
  return `
    <section class="foundation-panel foundation-wide">
      <div class="foundation-panel-head">
        <div>
          <h4>Product Registry</h4>
          <p>Launcher 是功能底座，standalone/embed 是 launcher 运行模式；MX-H2I 是 VPN 产品，使用 launcher standalone；embed 产品复用所选 launcher standalone 通道。</p>
        </div>
        <span>${escapeHtml(String(products.length || 0))} products</span>
      </div>
      ${error ? `<div class="feedback error">${escapeHtml(error)}</div>` : ''}
      <div class="foundation-kpi-grid">
        ${renderFoundationKpi('Launcher Foundation', 'standalone / embed', 'network, auth, release, policy')}
        ${renderFoundationKpi('MX-H2I VPN', formatLeaseRange(standalone?.userLeaseStart, standalone?.userLeaseEnd), standalone ? `${formatLeaseRange(standalone.anonymousLeaseStart, standalone.anonymousLeaseEnd)} anonymous` : 'launcher standalone 10.89')}
        ${renderFoundationKpi('Embed Dependency', firstEmbedChannel ? launcherProductDisplayName(firstEmbedChannel.productId, firstEmbedChannel) : 'MX-H2I', 'embed products reuse channel context')}
        ${renderFoundationKpi('Internal', '10.88.88.88', 'fixed control-plane peer')}
      </div>
      ${rows.length ? `
        <div class="foundation-table product-network-table">
          <article class="foundation-table-row is-header">
            <strong>Product</strong>
            <span>Launcher Mode</span>
            <span>Channel</span>
            <span>Service VIP</span>
            <span>Peer lease rule</span>
            <small>Foundation</small>
          </article>
          ${rows.map((row) => `
            <article class="foundation-table-row">
              <strong>${escapeHtml(row[0])}</strong>
              <span>${escapeHtml(row[1])}</span>
              <span>${escapeHtml(row[2])}</span>
              <span>${escapeHtml(row[3])}</span>
              <span>${escapeHtml(row[4])}</span>
              <small>${escapeHtml(row[5] === 'launcher-managed' ? 'launcher runtime' : row[5])}</small>
            </article>
          `).join('')}
        </div>
      ` : '<div class="empty-state">Product network registry is not loaded.</div>'}
    </section>
  `;
}

function renderOptionalAwxProviderPanel() {
  const providers = asArray(state.awxProviders);
  return `
    <section class="foundation-panel foundation-wide">
      <div class="foundation-panel-head">
        <div>
          <h4>Optional AWX adapter</h4>
          <p>AWX 不再是 Oversea 部署的默认路径。这里保留 provider 配置、对象同步和 token 检查，用于接入已有 AWX 环境。</p>
        </div>
        <span>${escapeHtml(String(providers.length))} providers</span>
      </div>
      ${renderFoundationRows([
        ['Default Oversea flow', 'Remote SSH direct runner', 'recommended'],
        ['AWX flow', 'inventory / credential / job template sync', 'optional'],
        ['K8s presence', 'AWX shadow 可以继续在 k8s 中默认启动', 'demo / compatibility'],
        ['Gate policy', 'AWX credential/object/launch gates stay disabled unless explicitly enabled', 'controlled']
      ])}
    </section>
  `;
}

function internalModuleBlueprint(moduleId, overview) {
  const sites = overseaAuthoritySites();
  const evidenceCount = consoleEvidenceTotal(state.dashboard?.siteSlotPipelines || []);
  const blueprints = {
    dns: {
      badge: overview.dnsZoneSnapshots || 0,
      contracts: [
        ['Authority', 'Internal CoreDNS owns MX split DNS and whitelist matching.', 'Internal'],
        ['Fallback', 'missed domains fall back to system DNS / proxy / Clash policy.', 'Launcher Network'],
        ['H endpoint path', 'Domestic WG + H2I makes Internal DNS reachable before private subscription fetch.', 'Domestic gated']
      ],
      actions: [
        ['Zone snapshot', 'save current authority zones and whitelists before release'],
        ['Probe', 'synthetic query for Internal, Domestic, Oversea and public domains'],
        ['Evidence', 'store query trace and resolved route decision']
      ]
    },
    mihomo: {
      badge: state.overseaOverview?.mihomo?.subscriptions || overview.siteSlotPlans || 0,
      contracts: [
        ['Authority', 'Internal generates mihomo YAML and owns user subscription truth.', 'Internal'],
        ['Sites', sites.length ? sites.join(' / ') : 'no oversea sites loaded', 'site group'],
        ['Oversea role', 'Docker hysteria2 runtime plus health/evidence outlet, not subscription truth.', 'runtime only']
      ],
      actions: [
        ['Issue', 'bind user entitlement to account and site group'],
        ['Rotate', 'rotate password / fingerprint / YAML revision after revoke'],
        ['Deliver', 'H endpoint fetches via Domestic relay when Internal is not public']
      ]
    },
    release: {
      badge: overview.releaseManagementPlans || 0,
      contracts: [
        ['Launcher Runtime', 'platform critical updates can be forced and rolled back.', 'strict'],
        ['AppCenter apps', 'manual, skip, gray and app-scoped rollback.', 'flexible'],
        ['External systems', 'release policy is derived from permission manifest and E2E gate.', 'contract']
      ],
      actions: [
        ['Build artifact', 'version, notes, checksum, target audience'],
        ['Gate', 'E2E + synthetic + observability evidence'],
        ['Roll back', 'restore artifact and config snapshot']
      ]
    },
    'e2e-gate': {
      badge: overview.testRuns || 0,
      contracts: [
        ['Definition', 'E2E cases can become permission feature definitions.', 'test-as-contract'],
        ['Evidence', 'runner output, screenshots, config snapshots and probes are attached.', 'required'],
        ['Release binding', 'gray and rollback gates consume the same result.', 'Release Center']
      ],
      actions: [
        ['Run synthetic probe', 'H/D/I/O path plus user entitlement check'],
        ['Capture', 'stdout/stderr, screenshots, DNS/routing decision'],
        ['Promote', 'mark release or feature scope as passed']
      ]
    },
    observability: {
      badge: evidenceCount,
      contracts: [
        ['Trace', 'H/D/I/O hops share request id and subject id.', 'cross-plane'],
        ['Log', 'runner, worker, release and UI actions are queryable by evidence id.', 'audit'],
        ['Metric', 'health summaries and site runtime state feed topology.', 'topology']
      ],
      actions: [
        ['Correlate', 'subject -> entitlement -> action -> evidence'],
        ['Export', 'health/evidence outlet for topology and ops UI'],
        ['Gate', 'block release or rollback when evidence is missing']
      ]
    },
    'admin-runner': {
      badge: overview.siteSlotPlans || 0,
      contracts: [
        ['Admin', 'topology, Action Gates, approval and rollback share one action model.', 'operator UI'],
        ['Runner', 'Remote SSH worker handoff is default for Oversea/Domestic slots.', 'direct'],
        ['AWX', 'optional adapter; not required for Internal foundations.', 'optional']
      ],
      actions: [
        ['Plan', 'materialize slot plan and remote command set'],
        ['Run', 'preflight, apply, runner session, worker job'],
        ['Explain', 'Evidence Drawer explains steps, commands and stdout/stderr']
      ]
    },
    'sdk-gateway': {
      badge: overview.sdkGatewayRoutes || 0,
      contracts: [
        ['Route manifest', 'stable APIs for Launcher, AppCenter apps and external systems.', 'contract'],
        ['Auth', 'service account token introspection and allowed route list.', 'User Center'],
        ['Policy', 'RBAC scopes bind route, resource and release audience.', 'RBAC']
      ],
      actions: [
        ['Register route', 'declare input, scopes, evidence and tests'],
        ['Issue token', 'service account with minimal scopes'],
        ['Audit usage', 'usage record links to user/service account']
      ]
    }
  };
  return blueprints[moduleId] || {
    badge: '-',
    contracts: [['Planned', 'Module blueprint not loaded yet.', 'pending']],
    actions: [['Define', 'add module manifest, evidence and actions']]
  };
}

function renderInternalModulePanel(moduleId, overview) {
  const meta = internalSubsectionMeta[moduleId] || internalSubsectionMeta.overview;
  const blueprint = internalModuleBlueprint(moduleId, overview);
  return `
    <section class="foundation-panel foundation-wide">
      <div class="foundation-panel-head">
        <div>
          <h4>${escapeHtml(meta.title)} contract</h4>
          <p>${escapeHtml(meta.subtitle)}</p>
        </div>
        <span>${escapeHtml(String(blueprint.badge))}</span>
      </div>
      <div class="foundation-table module-contract-table">
        <article class="foundation-table-row is-header">
          <strong>Boundary</strong>
          <span>Definition</span>
          <small>Owner</small>
        </article>
        ${blueprint.contracts.map((row) => `
          <article class="foundation-table-row">
            <strong>${escapeHtml(row[0])}</strong>
            <span>${escapeHtml(row[1])}</span>
            <small>${escapeHtml(row[2])}</small>
          </article>
        `).join('')}
      </div>
    </section>
    <section class="foundation-panel">
      <div class="foundation-panel-head">
        <div>
          <h4>Expected actions</h4>
          <p>这些动作会逐步落到 Admin action model、Release Gate 和 Evidence History。</p>
        </div>
      </div>
      ${renderFoundationRows(blueprint.actions.map((row) => [row[0], row[1], moduleId]))}
    </section>
  `;
}

function activeDnsPolicy() {
  return state.dnsCenter.policy
    || asArray(state.dnsCenter.policies).find((policy) => policy.enabled !== false)
    || null;
}

function dnsCenterFilters() {
  state.dnsCenter.filter = state.dnsCenter.filter || { search: '', status: 'all' };
  return state.dnsCenter.filter;
}

function dnsRouteById(routeId) {
  return asArray(state.dnsCenter.routes).find((route) => route.routeId === routeId) || null;
}

function filteredDnsRoutes() {
  const filter = dnsCenterFilters();
  const query = String(filter.search || '').trim().toLowerCase();
  const status = filter.status || 'all';
  return asArray(state.dnsCenter.routes)
    .filter((route) => {
      if (status === 'enabled' && route.enabled === false) return false;
      if (status === 'disabled' && route.enabled !== false) return false;
      if (!query) return true;
      return [
        route.routeId,
        route.host,
        route.dnsTarget,
        route.targetUrl,
        route.tlsMode,
        route.authRequired ? 'auth' : 'public'
      ].some((value) => String(value || '').toLowerCase().includes(query));
    });
}

function renderDnsCenterPanel() {
  const policy = activeDnsPolicy();
  const routes = filteredDnsRoutes();
  const filter = dnsCenterFilters();
  const allRoutes = asArray(state.dnsCenter.routes);
  const enabledRoutes = allRoutes.filter((route) => route.enabled !== false);
  const exactDomains = asArray(policy?.whitelist?.exactDomains);
  const suffixes = asArray(policy?.whitelist?.suffixes);
  const fallbackOrder = asArray(policy?.fallbackOrder);
  const feedback = state.dnsCenter.feedback;
  return `
    <section class="foundation-panel foundation-wide dns-command-panel">
      <div class="foundation-panel-head dns-command-head">
        <div>
          <span class="site-kind">DNS Control</span>
          <h4>Internal DNS configuration</h4>
          <p>业务域名在 DNS Routes 配置；DNS target 决定 CoreDNS 解析，upstream URL 决定 gateway 反代到哪个服务和端口。</p>
        </div>
        <div class="dns-head-actions">
          <div class="dns-segmented" role="group" aria-label="Gateway backend">
            ${renderGatewayBackendSegment('k8s', 'Caddy 80')}
            ${renderGatewayBackendSegment('host-nginx', 'Host nginx')}
          </div>
          <button class="secondary-button" type="button" data-dns-refresh ${state.dnsCenter.busy ? 'disabled' : ''}>${state.dnsCenter.busy ? 'Refreshing...' : 'Refresh'}</button>
          <button class="secondary-button" type="button" data-dns-zone-build ${state.dnsCenter.zoneBusy ? 'disabled' : ''}>${state.dnsCenter.zoneBusy ? 'Building...' : 'Build Zone'}</button>
          <button class="secondary-button" type="button" data-dns-coredns-sync ${state.dnsCenter.corednsBusy ? 'disabled' : ''}>${state.dnsCenter.corednsBusy ? 'Rendering...' : 'Dry-run CoreDNS'}</button>
          <button class="secondary-button" type="button" data-dns-coredns-apply ${state.dnsCenter.corednsApplyBusy ? 'disabled' : ''}>${state.dnsCenter.corednsApplyBusy ? 'Applying...' : 'Apply CoreDNS'}</button>
          <button class="secondary-button" type="button" data-dns-gateway-sync ${state.dnsCenter.gatewayBusy ? 'disabled' : ''}>${state.dnsCenter.gatewayBusy ? 'Rendering...' : 'Dry-run Gateway'}</button>
          <button class="secondary-button" type="button" data-dns-gateway-apply ${state.dnsCenter.gatewayApplyBusy ? 'disabled' : ''}>${state.dnsCenter.gatewayApplyBusy ? 'Applying...' : 'Apply Gateway'}</button>
          <button class="primary-button" type="button" data-dns-new>New Route</button>
        </div>
      </div>
      ${state.dnsCenter.policyError ? `<div class="feedback error">${escapeHtml(state.dnsCenter.policyError)}</div>` : ''}
      ${state.dnsCenter.routesError ? `<div class="feedback error">${escapeHtml(state.dnsCenter.routesError)}</div>` : ''}
      ${state.dnsCenter.gatewayRuntimeError ? `<div class="feedback error">${escapeHtml(state.dnsCenter.gatewayRuntimeError)}</div>` : ''}
      ${feedback ? `<div class="feedback ${escapeHtml(feedback.kind || 'info')}">${escapeHtml(feedback.message || '')}</div>` : ''}
      <div class="dns-metric-grid">
        ${renderDnsMetric('Internal DNS', MX_INTERNAL_DNS_IP, 'CoreDNS authority / split DNS')}
        ${renderDnsMetric('Domestic relay', MX_DOMESTIC_RELAY_IP, 'H2I bootstrap fallback path')}
        ${renderDnsMetric('Launcher edge', MX_LOCAL_EDGE_DNS, 'PAC + DNS + proxy first hop')}
        ${renderDnsMetric('Routes enabled', `${enabledRoutes.length}/${allRoutes.length}`, 'business domains')}
      </div>
    </section>

    <section class="foundation-panel foundation-wide dns-route-panel">
      <div class="foundation-panel-head">
        <div>
          <h4>DNS Routes</h4>
          <p>这里把业务域名先解析到 Internal gateway，再按 Host 反代到每条 route 自己的 upstream 服务。</p>
        </div>
        <span>${escapeHtml(String(routes.length))} shown / ${escapeHtml(String(allRoutes.length))} total</span>
      </div>
      <div class="dns-toolbar">
        <input data-dns-filter="search" value="${escapeHtml(filter.search || '')}" placeholder="Search domain or target..." autocomplete="off" />
        <div class="dns-segmented" role="group" aria-label="DNS route status">
          ${renderDnsStatusFilterButton('all', 'All', filter.status)}
          ${renderDnsStatusFilterButton('enabled', 'Enabled', filter.status)}
          ${renderDnsStatusFilterButton('disabled', 'Disabled', filter.status)}
        </div>
      </div>
      <div class="app-table dns-route-table" role="table" aria-label="Internal DNS routes">
        <div class="app-table-row is-header dns-route-row" role="row">
          <span>Domain</span>
          <span>DNS Target</span>
          <span>Upstream</span>
          <span>Gateway</span>
          <span>Status</span>
          <span>Updated</span>
          <span>Actions</span>
        </div>
        ${routes.map(renderDnsRouteRow).join('') || '<div class="empty-state dns-empty">No DNS routes match the current filters.</div>'}
      </div>
    </section>

    <section class="foundation-panel dns-policy-panel">
      <div class="foundation-panel-head">
        <div>
          <h4>Where to configure DNS</h4>
          <p>Internal 是 DNS 真相；launcher standalone 只负责把本机域名流量优先送到 PAC/DNS edge。</p>
        </div>
      </div>
      ${renderFoundationRows([
        ['Business domains', '在 DNS Routes 新增或编辑；DNS target 不带端口，upstream URL 可带每个服务自己的端口。', 'editable'],
        ['Split DNS whitelist', `${exactDomains.length} exact / ${suffixes.length} suffix，由 policy 管理。`, policy?.enabled === false ? 'disabled' : 'effective'],
        ['CoreDNS authority', `${policy?.internal?.serviceDns || 'mx-internal-coredns.mx-dns.svc.cluster.local'} via ${MX_INTERNAL_DNS_IP}`, 'Internal'],
        ['Internal gateway', `${MX_INTERNAL_DNS_IP}:80 routes Host -> upstream URL`, 'standard ingress'],
        ['Fallback order', fallbackOrder.length ? fallbackOrder.join(' -> ') : 'system-dns -> system-proxy -> direct', policy?.proxyHints?.allowSystemProxyFallback === false ? 'locked' : 'Clash compatible']
      ])}
      <div class="dns-chip-group" aria-label="DNS whitelist preview">
        ${renderDnsChipList(exactDomains.concat(suffixes.map((suffix) => `*.${suffix}`)).slice(0, 8), 'No whitelist entries loaded yet.')}
      </div>
    </section>

    <section class="foundation-panel dns-tool-panel">
      <div class="foundation-panel-head">
        <div>
          <h4>Probe & config</h4>
          <p>先 evaluate 域名决策，再 dry-run CoreDNS 和 Internal gateway，确认解析与反代入口分层生效。</p>
        </div>
      </div>
      <form class="dns-evaluate-form" data-dns-evaluate-form>
        <label class="form-field">
          <span>Domain probe</span>
          <input data-dns-evaluate-domain value="${escapeHtml(state.dnsCenter.evaluateDomain || '')}" placeholder="gateway.internal.mx" autocomplete="off" />
        </label>
        <button class="secondary-button" type="submit" ${state.dnsCenter.evalBusy ? 'disabled' : ''}>${state.dnsCenter.evalBusy ? 'Evaluating...' : 'Evaluate'}</button>
      </form>
      ${renderDnsDecisionResult(state.dnsCenter.evaluateResult)}
      ${renderDnsZoneResult(state.dnsCenter.zoneSnapshot, state.dnsCenter.corednsResult, state.dnsCenter.gatewayResult)}
    </section>
  `;
}

function renderGatewayBackendSegment(value, label) {
  const active = (state.dnsCenter.gatewayBackend || 'k8s') === value;
  return `<button class="dns-segment ${active ? 'is-active' : ''}" type="button" data-dns-gateway-backend="${escapeHtml(value)}" aria-pressed="${active ? 'true' : 'false'}" ${state.dnsCenter.gatewayConfigBusy ? 'disabled' : ''}>${escapeHtml(label)}</button>`;
}

function renderDnsMetric(label, value, hint) {
  return `
    <article class="dns-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(String(value || '-'))}</strong>
      <small>${escapeHtml(hint)}</small>
    </article>
  `;
}

function renderDnsStatusFilterButton(value, label, selected) {
  const active = (selected || 'all') === value;
  return `
    <button class="dns-segment ${active ? 'is-active' : ''}" type="button" data-dns-status="${escapeHtml(value)}" aria-pressed="${active ? 'true' : 'false'}">
      ${escapeHtml(label)}
    </button>
  `;
}

function renderDnsChipList(values, emptyLabel) {
  const chips = asArray(values).filter(Boolean);
  if (!chips.length) return `<span class="dns-chip is-muted">${escapeHtml(emptyLabel)}</span>`;
  return chips.map((value) => `<span class="dns-chip">${escapeHtml(value)}</span>`).join('');
}

function renderDnsRouteRow(route) {
  const enabled = route.enabled !== false;
  return `
    <article class="app-table-row dns-route-row ${route.routeId === state.dnsCenter.drawer?.routeId ? 'is-selected' : ''}" role="row" tabindex="0" data-dns-route-select="${escapeHtml(route.routeId)}">
      <span>
        <strong>${escapeHtml(route.host || route.routeId)}</strong>
        <small>${escapeHtml(route.routeId || 'auto route')}</small>
      </span>
      <span>
        <b>${escapeHtml(route.dnsTarget || MX_INTERNAL_DNS_IP)}</b>
        <small>CoreDNS record</small>
      </span>
      <span>
        <b>${escapeHtml(shortUrlLabel(route.targetUrl || '-'))}</b>
        <small>${escapeHtml(route.targetUrl || '-')}</small>
      </span>
      <span>
        <b>${escapeHtml(route.tlsMode || 'internal')}</b>
        <small>${route.authRequired === false ? 'public gateway' : 'auth required'}</small>
      </span>
      <span><mark data-kind="${enabled ? 'system' : 'muted'}">${enabled ? 'enabled' : 'disabled'}</mark></span>
      <span>${escapeHtml(formatTime(route.updatedAt || route.createdAt))}</span>
      <span class="app-table-actions">
        <button class="secondary-button" type="button" data-dns-route-edit="${escapeHtml(route.routeId)}">Edit</button>
        <button class="secondary-button" type="button" data-dns-route-delete="${escapeHtml(route.routeId)}">Delete</button>
      </span>
    </article>
  `;
}

function shortUrlLabel(value) {
  try {
    const url = new URL(value);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return String(value || '-');
  }
}

function renderDnsDecisionResult(decision) {
  if (!decision) {
    return `
      <div class="dns-result is-empty">
        <strong>Decision preview</strong>
        <span>输入域名后会显示 internal-dns 或 fallback、resolver、命中的 reverse proxy route。</span>
      </div>
    `;
  }
  return `
    <div class="dns-result">
      <strong>${escapeHtml(decision.normalizedDomain || decision.domain || 'domain')}</strong>
      <div class="dns-result-grid">
        <span><b>${escapeHtml(decision.route || '-')}</b><small>route</small></span>
        <span><b>${escapeHtml(decision.resolver || '-')}</b><small>resolver</small></span>
        <span><b>${decision.matched ? 'matched' : 'fallback'}</b><small>policy</small></span>
      </div>
      <p>${escapeHtml(decision.reason || 'No reason returned.')}</p>
    </div>
  `;
}

function renderDnsZoneResult(snapshot, corednsResult, gatewayResult) {
  const records = asArray(snapshot?.records);
  const result = corednsResult || null;
  const gateway = gatewayResult || null;
  return `
    <div class="dns-zone-summary">
      <div>
        <span>Zone snapshot</span>
        <strong>${escapeHtml(snapshot?.snapshotId || 'not built')}</strong>
        <small>${records.length ? `${records.length} records / ${asArray(snapshot?.zoneNames).join(', ') || 'zones'}` : 'Build Zone will render records from policy and routes.'}</small>
      </div>
      <div>
        <span>CoreDNS sync</span>
        <strong>${escapeHtml(result?.status || 'not rendered')}</strong>
        <small>${result ? `${result.namespace || 'mx-dns'}/${result.configMapName || 'coredns'} / ${result.mode || 'dry-run'}` : 'Dry-run or apply result appears here.'}</small>
      </div>
      <div>
        <span>Gateway sync</span>
        <strong>${escapeHtml(gateway?.status || 'not rendered')}</strong>
        <small>${gateway ? `${gateway.namespace || 'mx-internal-shadow'}/${gateway.configMapName || 'mx-internal-gateway-caddy'} / ${gateway.routeCount || 0} routes` : 'Dry-run or apply Internal gateway result appears here.'}</small>
      </div>
    </div>
  `;
}

function bindDnsCenterControls(root) {
  if (state.adminSubsection !== 'dns') return;
  const search = root.querySelector('[data-dns-filter="search"]');
  if (search) {
    search.addEventListener('input', () => {
      const cursor = search.selectionStart;
      dnsCenterFilters().search = search.value;
      renderFoundationGrid(state.dashboard?.overview || {});
      requestAnimationFrame(() => {
        const nextSearch = foundationGrid.querySelector('[data-dns-filter="search"]');
        nextSearch?.focus?.();
        if (typeof cursor === 'number') nextSearch?.setSelectionRange?.(cursor, cursor);
      });
    });
  }
  for (const button of root.querySelectorAll('[data-dns-status]')) {
    button.addEventListener('click', () => {
      dnsCenterFilters().status = button.dataset.dnsStatus || 'all';
      renderFoundationGrid(state.dashboard?.overview || {});
    });
  }
  const refresh = root.querySelector('[data-dns-refresh]');
  if (refresh) refresh.addEventListener('click', () => void refreshDnsCenterFromAdmin());
  const create = root.querySelector('[data-dns-new]');
  if (create) create.addEventListener('click', () => openDnsRouteEditorDrawer('create'));
  const build = root.querySelector('[data-dns-zone-build]');
  if (build) build.addEventListener('click', () => void buildDnsZoneSnapshotFromAdmin());
  const sync = root.querySelector('[data-dns-coredns-sync]');
  if (sync) sync.addEventListener('click', () => void syncCoreDnsConfigMapFromAdmin());
  const apply = root.querySelector('[data-dns-coredns-apply]');
  if (apply) apply.addEventListener('click', () => void applyCoreDnsConfigMapFromAdmin());
  const gatewaySync = root.querySelector('[data-dns-gateway-sync]');
  if (gatewaySync) gatewaySync.addEventListener('click', () => void syncGatewayConfigMapFromAdmin());
  const gatewayApply = root.querySelector('[data-dns-gateway-apply]');
  if (gatewayApply) gatewayApply.addEventListener('click', () => void applyGatewayConfigMapFromAdmin());
  for (const button of root.querySelectorAll('[data-dns-gateway-backend]')) {
    button.addEventListener('click', () => {
      const backend = button.dataset.dnsGatewayBackend;
      void saveGatewayRuntimeConfigFromAdmin(backend === 'host-nginx' ? 'host-nginx' : 'k8s');
    });
  }
  const evaluateForm = root.querySelector('[data-dns-evaluate-form]');
  if (evaluateForm) {
    evaluateForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const domain = root.querySelector('[data-dns-evaluate-domain]')?.value || '';
      void evaluateDnsQueryFromAdmin(domain);
    });
  }
  const evaluateDomain = root.querySelector('[data-dns-evaluate-domain]');
  if (evaluateDomain) {
    evaluateDomain.addEventListener('input', () => {
      state.dnsCenter.evaluateDomain = evaluateDomain.value;
    });
  }
  for (const row of root.querySelectorAll('[data-dns-route-select]')) {
    row.addEventListener('click', (event) => {
      if (event.target.closest('button')) return;
      openDnsRouteEditorDrawer('edit', row.dataset.dnsRouteSelect);
    });
    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openDnsRouteEditorDrawer('edit', row.dataset.dnsRouteSelect);
    });
  }
  for (const button of root.querySelectorAll('[data-dns-route-edit]')) {
    button.addEventListener('click', () => openDnsRouteEditorDrawer('edit', button.dataset.dnsRouteEdit));
  }
  for (const button of root.querySelectorAll('[data-dns-route-delete]')) {
    button.addEventListener('click', () => void deleteDnsRouteFromAdmin(button.dataset.dnsRouteDelete));
  }
}

async function refreshDnsCenterFromAdmin() {
  if (state.dnsCenter.busy) return;
  state.dnsCenter.busy = true;
  state.dnsCenter.feedback = { kind: 'info', message: 'Refreshing DNS policy and routes' };
  renderFoundationGrid(state.dashboard?.overview || {});
  const [policyPayload, routesPayload, gatewayRuntimePayload] = await Promise.all([
    loadDnsPolicyCenter(),
    loadDnsReverseProxyRoutes(),
    loadGatewayRuntimeConfig()
  ]);
  state.dnsCenter.policy = policyPayload.policy || null;
  state.dnsCenter.policies = asArray(policyPayload.policies);
  state.dnsCenter.policyError = policyPayload.error || null;
  state.dnsCenter.routes = asArray(routesPayload.routes);
  state.dnsCenter.routesError = routesPayload.error || null;
  applyGatewayRuntimeConfig(gatewayRuntimePayload.config);
  state.dnsCenter.gatewayRuntimeError = gatewayRuntimePayload.error || null;
  state.dnsCenter.busy = false;
  state.dnsCenter.feedback = policyPayload.error || routesPayload.error || gatewayRuntimePayload.error
    ? { kind: 'error', message: policyPayload.error || routesPayload.error || gatewayRuntimePayload.error }
    : { kind: 'success', message: 'DNS policy and routes refreshed' };
  renderFoundationGrid(state.dashboard?.overview || {});
}

async function saveGatewayRuntimeConfigFromAdmin(backend) {
  if (state.dnsCenter.gatewayConfigBusy) return;
  const nextBackend = backend === 'host-nginx' ? 'host-nginx' : 'k8s';
  const previousBackend = state.dnsCenter.gatewayBackend || 'k8s';
  state.dnsCenter.gatewayBackend = nextBackend;
  state.dnsCenter.gatewayConfigBusy = true;
  state.dnsCenter.feedback = {
    kind: 'info',
    message: `Saving gateway backend: ${nextBackend === 'host-nginx' ? 'Host nginx' : 'Caddy 80'}`
  };
  renderFoundationGrid(state.dashboard?.overview || {});
  try {
    const payload = await fetchJson('/internal/v1/config-center/gateway-runtime-config', {
      method: 'POST',
      body: {
        backend: nextBackend,
        requestedBy: 'admin-ui',
        requestId: 'desktop-admin-gateway-runtime-config'
      }
    });
    applyGatewayRuntimeConfig(payload.config);
    state.dnsCenter.gatewayRuntimeError = null;
    state.dnsCenter.feedback = {
      kind: 'success',
      message: `Gateway backend saved: ${(state.dnsCenter.gatewayBackend || 'k8s') === 'host-nginx' ? 'Host nginx' : 'Caddy 80'}`
    };
  } catch (error) {
    state.dnsCenter.gatewayBackend = previousBackend;
    state.dnsCenter.gatewayRuntimeError = error.message;
    state.dnsCenter.feedback = { kind: 'error', message: error.message };
  } finally {
    state.dnsCenter.gatewayConfigBusy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
  }
}

function dnsRouteEditorDraft() {
  if (!state.dnsCenter.drawer) return null;
  if (!state.dnsCenter.drawer.draft) {
    state.dnsCenter.drawer.draft = createDnsRouteEditorDraft(state.dnsCenter.drawer.mode, state.dnsCenter.drawer.routeId);
  }
  return state.dnsCenter.drawer.draft;
}

function createDnsRouteEditorDraft(mode = 'create', routeId = '') {
  const editing = mode === 'edit';
  const route = editing ? dnsRouteById(routeId) : null;
  return {
    routeId: route?.routeId || '',
    host: route?.host || '',
    dnsTarget: route?.dnsTarget || MX_INTERNAL_DNS_IP,
    targetUrl: route?.targetUrl || '',
    enabled: route?.enabled === false ? false : true,
    tlsMode: route?.tlsMode || 'internal',
    authRequired: route?.authRequired === false ? false : true
  };
}

function openDnsRouteEditorDrawer(mode = 'create', routeId = '') {
  state.appCatalogEditor = null;
  state.dnsCenter.drawer = {
    mode,
    routeId,
    draft: createDnsRouteEditorDraft(mode, routeId)
  };
  state.dnsCenter.feedback = null;
  renderFoundationGrid(state.dashboard?.overview || {});
  requestAnimationFrame(() => {
    const firstField = appEditorDrawer?.querySelector('[data-dns-route-field="host"]:not([readonly]), [data-dns-route-field="dnsTarget"], [data-dns-route-field="targetUrl"]');
    firstField?.focus?.();
  });
}

function closeDnsRouteEditorDrawer() {
  state.dnsCenter.drawer = null;
  state.dnsCenter.busy = false;
  if (appEditorBackdrop) appEditorBackdrop.hidden = true;
  if (appEditorDrawer) {
    appEditorDrawer.hidden = true;
    appEditorDrawer.innerHTML = '';
  }
}

function renderDnsRouteEditorDrawer() {
  if (!appEditorBackdrop || !appEditorDrawer) return;
  const draft = dnsRouteEditorDraft();
  if (!draft) {
    if (!state.appCatalogEditor) {
      appEditorBackdrop.hidden = true;
      appEditorDrawer.hidden = true;
      appEditorDrawer.innerHTML = '';
    }
    return;
  }
  const creating = state.dnsCenter.drawer?.mode !== 'edit';
  const title = creating ? 'New DNS Route' : `Edit ${draft.host || draft.routeId}`;
  appEditorBackdrop.hidden = false;
  appEditorDrawer.hidden = false;
  appEditorDrawer.innerHTML = `
    <form class="app-editor-form" data-dns-route-editor>
      <header class="app-drawer-header">
        <div>
          <span class="site-kind">DNS Route</span>
          <h2>${escapeHtml(title)}</h2>
          <p>DNS target feeds CoreDNS; optional upstream URL feeds gateway reverse proxy decisions.</p>
        </div>
        <button class="icon-button app-drawer-close" type="button" data-dns-route-close aria-label="Close DNS route editor">×</button>
      </header>
      <div class="app-drawer-scroll">
        <section class="app-drawer-section">
          <div class="app-section-title">
            <span>01</span>
            <strong>Record identity</strong>
          </div>
          <div class="app-editor-grid">
            <label class="app-form-field">
              <span>Route ID</span>
              <input data-dns-route-field="routeId" value="${escapeHtml(draft.routeId || '')}" ${creating ? '' : 'readonly'} placeholder="auto from host" autocomplete="off" />
            </label>
            <label class="app-form-field">
              <span>Domain</span>
              <input data-dns-route-field="host" value="${escapeHtml(draft.host || '')}" placeholder="night-all.mxinfo-inc.cn" autocomplete="off" />
            </label>
            <label class="app-form-field">
              <span>DNS Target</span>
              <input data-dns-route-field="dnsTarget" value="${escapeHtml(draft.dnsTarget || '')}" placeholder="${MX_INTERNAL_DNS_IP}" autocomplete="off" />
            </label>
            <label class="app-form-field app-form-wide">
              <span>Upstream URL optional</span>
              <input data-dns-route-field="targetUrl" value="${escapeHtml(draft.targetUrl || '')}" placeholder="http://${MX_INTERNAL_DNS_IP}:service-port" autocomplete="off" />
            </label>
          </div>
        </section>
        <section class="app-drawer-section">
          <div class="app-section-title">
            <span>02</span>
            <strong>Gateway policy</strong>
          </div>
          <div class="app-mode-selector dns-tls-selector" role="radiogroup" aria-label="TLS mode">
            ${renderDnsTlsModeChoice('internal', draft.tlsMode, 'internal', 'Internal edge certificate / default gateway mode.')}
            ${renderDnsTlsModeChoice('passthrough', draft.tlsMode, 'passthrough', 'Forward TLS through to the target service.')}
            ${renderDnsTlsModeChoice('edge-terminated', draft.tlsMode, 'edge terminated', 'Terminate at gateway and forward internally.')}
          </div>
          <div class="app-editor-grid">
            <label class="app-check-row">
              <input data-dns-route-field="enabled" type="checkbox" ${draft.enabled === false ? '' : 'checked'} />
              <span aria-hidden="true"></span>
              <strong>Enabled in zone snapshot</strong>
            </label>
            <label class="app-check-row">
              <input data-dns-route-field="authRequired" type="checkbox" ${draft.authRequired === false ? '' : 'checked'} />
              <span aria-hidden="true"></span>
              <strong>Gateway auth required</strong>
            </label>
          </div>
        </section>
        ${state.dnsCenter.feedback ? `<div class="feedback ${escapeHtml(state.dnsCenter.feedback.kind || 'info')}">${escapeHtml(state.dnsCenter.feedback.message || '')}</div>` : ''}
      </div>
      <footer class="app-drawer-actions">
        <button class="secondary-button" type="button" data-dns-route-cancel>Cancel</button>
        <button class="primary-button" type="submit" ${state.dnsCenter.busy ? 'disabled' : ''}>${state.dnsCenter.busy ? 'Saving...' : 'Save Route'}</button>
      </footer>
    </form>
  `;
  bindDnsRouteEditorControls();
}

function renderDnsTlsModeChoice(value, selected, title, detail) {
  const active = value === selected;
  return `
    <label class="app-mode-choice ${active ? 'is-selected' : ''}">
      <input data-dns-route-field="tlsMode" type="radio" name="dnsTlsMode" value="${escapeHtml(value)}" ${active ? 'checked' : ''} />
      <span aria-hidden="true"></span>
      <strong>${escapeHtml(title)}</strong>
      <small>${escapeHtml(detail)}</small>
    </label>
  `;
}

function bindDnsRouteEditorControls() {
  if (!appEditorDrawer || appEditorDrawer.hidden) return;
  const form = appEditorDrawer.querySelector('[data-dns-route-editor]');
  if (!form) return;
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void saveDnsRouteFromEditor(form);
  });
  for (const close of appEditorDrawer.querySelectorAll('[data-dns-route-close], [data-dns-route-cancel]')) {
    close.addEventListener('click', () => closeDnsRouteEditorDrawer());
  }
  for (const control of appEditorDrawer.querySelectorAll('[data-dns-route-field]')) {
    control.addEventListener('input', () => {
      state.dnsCenter.drawer.draft = dnsRouteEditorDraftFromForm(form);
      state.dnsCenter.feedback = null;
    });
    control.addEventListener('change', () => {
      state.dnsCenter.drawer.draft = dnsRouteEditorDraftFromForm(form);
      state.dnsCenter.feedback = null;
      if (control.dataset.dnsRouteField === 'tlsMode') renderDnsRouteEditorDrawer();
    });
  }
}

function dnsRouteEditorDraftFromForm(root) {
  const current = dnsRouteEditorDraft() || {};
  return {
    ...current,
    routeId: dnsRouteEditorValue(root, 'routeId') || current.routeId || '',
    host: dnsRouteEditorValue(root, 'host') || '',
    dnsTarget: dnsRouteEditorValue(root, 'dnsTarget') || MX_INTERNAL_DNS_IP,
    targetUrl: dnsRouteEditorValue(root, 'targetUrl') || '',
    enabled: dnsRouteEditorValue(root, 'enabled') !== false,
    tlsMode: dnsRouteEditorValue(root, 'tlsMode') || 'internal',
    authRequired: dnsRouteEditorValue(root, 'authRequired') !== false
  };
}

function dnsRouteEditorValue(root, field) {
  const element = root.querySelector(`[data-dns-route-field="${field}"]`);
  if (!element) return '';
  if (element.type === 'checkbox') return element.checked;
  if (element.type === 'radio') {
    return root.querySelector(`[data-dns-route-field="${field}"]:checked`)?.value || '';
  }
  return element.value;
}

async function saveDnsRouteFromEditor(root) {
  if (state.dnsCenter.busy) return;
  const draft = dnsRouteEditorDraftFromForm(root);
  state.dnsCenter.busy = true;
  state.dnsCenter.feedback = { kind: 'info', message: 'Saving DNS route' };
  if (state.dnsCenter.drawer) state.dnsCenter.drawer.draft = draft;
  renderDnsRouteEditorDrawer();
  try {
    const editing = state.dnsCenter.drawer?.mode === 'edit';
    const routeId = state.dnsCenter.drawer?.routeId || draft.routeId;
    const payload = await fetchJson(editing && routeId
      ? `/internal/v1/dns/reverse-proxy/routes/${encodeURIComponent(routeId)}`
      : '/internal/v1/dns/reverse-proxy/routes', {
      method: 'POST',
      body: {
        routeId: blankToNull(draft.routeId),
        host: draft.host,
        dnsTarget: draft.dnsTarget,
        targetUrl: blankToNull(draft.targetUrl),
        enabled: draft.enabled,
        tlsMode: draft.tlsMode,
        authRequired: draft.authRequired,
        requestedBy: 'admin-ui'
      }
    });
    await refreshDnsRoutesFromAdmin();
    state.dnsCenter.drawer = {
      mode: 'edit',
      routeId: payload.route?.routeId || routeId,
      draft: createDnsRouteEditorDraft('edit', payload.route?.routeId || routeId)
    };
    state.dnsCenter.feedback = { kind: 'success', message: `Saved ${payload.route?.host || draft.host}` };
  } catch (error) {
    state.dnsCenter.feedback = { kind: 'error', message: error.message };
  } finally {
    state.dnsCenter.busy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
  }
}

async function deleteDnsRouteFromAdmin(routeId) {
  const route = dnsRouteById(routeId);
  if (!route) return;
  if (!window.confirm(`Delete DNS route ${route.host || route.routeId}?`)) return;
  state.dnsCenter.feedback = { kind: 'info', message: `Deleting ${route.host || route.routeId}` };
  renderFoundationGrid(state.dashboard?.overview || {});
  try {
    await fetchJson(`/internal/v1/dns/reverse-proxy/routes/${encodeURIComponent(route.routeId)}`, { method: 'DELETE' });
    if (state.dnsCenter.drawer?.routeId === route.routeId) closeDnsRouteEditorDrawer();
    await refreshDnsRoutesFromAdmin();
    state.dnsCenter.feedback = { kind: 'success', message: `Deleted ${route.host || route.routeId}` };
  } catch (error) {
    state.dnsCenter.feedback = { kind: 'error', message: error.message };
  }
  renderFoundationGrid(state.dashboard?.overview || {});
}

async function refreshDnsRoutesFromAdmin() {
  const payload = await loadDnsReverseProxyRoutes();
  state.dnsCenter.routes = asArray(payload.routes);
  state.dnsCenter.routesError = payload.error || null;
}

async function buildDnsZoneSnapshotFromAdmin() {
  if (state.dnsCenter.zoneBusy) return;
  state.dnsCenter.zoneBusy = true;
  state.dnsCenter.feedback = { kind: 'info', message: 'Building DNS zone snapshot' };
  renderFoundationGrid(state.dashboard?.overview || {});
  try {
    const payload = await fetchJson('/internal/v1/dns/zones/build', {
      method: 'POST',
      body: { appId: 'sdk-gateway', requestId: 'desktop-admin-dns-zone' }
    });
    const snapshot = payload.snapshot || {};
    state.dnsCenter.zoneSnapshot = snapshot;
    state.dnsCenter.feedback = {
      kind: 'success',
      message: `Zone ${snapshot.snapshotId || ''} built with ${asArray(snapshot.records).length} records`
    };
  } catch (error) {
    state.dnsCenter.feedback = { kind: 'error', message: error.message };
  } finally {
    state.dnsCenter.zoneBusy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
  }
}

async function syncCoreDnsConfigMapFromAdmin() {
  if (state.dnsCenter.corednsBusy) return;
  state.dnsCenter.corednsBusy = true;
  state.dnsCenter.feedback = { kind: 'info', message: 'Rendering CoreDNS ConfigMap dry-run' };
  renderFoundationGrid(state.dashboard?.overview || {});
  try {
    const payload = await fetchJson('/internal/v1/dns/coredns/configmap/sync', {
      method: 'POST',
      body: {
        appId: 'sdk-gateway',
        mode: 'dry-run',
        requestId: 'desktop-admin-coredns-sync'
      }
    });
    const result = payload.result || {};
    state.dnsCenter.corednsResult = result;
    state.dnsCenter.feedback = {
      kind: 'success',
      message: `CoreDNS ${result.namespace || 'mx-dns'}/${result.configMapName || 'coredns'} ${result.status || 'rendered'}`
    };
  } catch (error) {
    state.dnsCenter.feedback = { kind: 'error', message: error.message };
  } finally {
    state.dnsCenter.corednsBusy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
  }
}

async function applyCoreDnsConfigMapFromAdmin() {
  if (state.dnsCenter.corednsApplyBusy) return;
  state.dnsCenter.corednsApplyBusy = true;
  state.dnsCenter.feedback = { kind: 'info', message: 'Applying CoreDNS ConfigMap' };
  renderFoundationGrid(state.dashboard?.overview || {});
  try {
    const payload = await fetchJson('/internal/v1/dns/coredns/configmap/apply', {
      method: 'POST',
      body: {
        appId: 'sdk-gateway',
        confirmApply: true,
        serverDryRun: false,
        actor: 'admin-ui',
        requestId: 'desktop-admin-coredns-apply'
      }
    });
    const result = payload.result || {};
    state.dnsCenter.corednsResult = result;
    state.dnsCenter.feedback = {
      kind: result.applied ? 'success' : (result.allowed === false ? 'error' : 'info'),
      message: `CoreDNS ${result.namespace || 'mx-dns'}/${result.configMapName || 'coredns'} ${result.status || 'apply requested'}${result.message ? `: ${result.message}` : ''}`
    };
  } catch (error) {
    state.dnsCenter.feedback = { kind: 'error', message: error.message };
  } finally {
    state.dnsCenter.corednsApplyBusy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
  }
}

async function syncGatewayConfigMapFromAdmin() {
  if (state.dnsCenter.gatewayBusy) return;
  state.dnsCenter.gatewayBusy = true;
  state.dnsCenter.feedback = { kind: 'info', message: 'Rendering Internal gateway ConfigMap dry-run' };
  renderFoundationGrid(state.dashboard?.overview || {});
  try {
    const payload = await fetchJson('/internal/v1/dns/gateway/configmap/sync', {
      method: 'POST',
      body: {
        appId: 'sdk-gateway',
        gatewayApplyBackend: state.dnsCenter.gatewayBackend || 'k8s',
        mode: 'dry-run',
        requestId: 'desktop-admin-gateway-sync'
      }
    });
    const result = payload.result || {};
    state.dnsCenter.gatewayResult = result;
    state.dnsCenter.feedback = {
      kind: 'success',
      message: `Gateway ${result.namespace || 'mx-internal-shadow'}/${result.configMapName || 'mx-internal-gateway-caddy'} ${result.status || 'rendered'} with ${result.routeCount || 0} routes`
    };
  } catch (error) {
    state.dnsCenter.feedback = { kind: 'error', message: error.message };
  } finally {
    state.dnsCenter.gatewayBusy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
  }
}

async function applyGatewayConfigMapFromAdmin() {
  if (state.dnsCenter.gatewayApplyBusy) return;
  state.dnsCenter.gatewayApplyBusy = true;
  const gatewayBackend = state.dnsCenter.gatewayBackend || 'k8s';
  state.dnsCenter.feedback = { kind: 'info', message: `Applying Internal gateway via ${gatewayBackend === 'host-nginx' ? 'host nginx' : 'k8s Caddy'}` };
  renderFoundationGrid(state.dashboard?.overview || {});
  try {
    const payload = await fetchJson('/internal/v1/dns/gateway/configmap/apply', {
      method: 'POST',
      body: {
        appId: 'sdk-gateway',
        gatewayApplyBackend: gatewayBackend,
        confirmApply: true,
        serverDryRun: false,
        actor: 'admin-ui',
        requestId: 'desktop-admin-gateway-apply'
      }
    });
    const result = payload.result || {};
    state.dnsCenter.gatewayResult = result;
    state.dnsCenter.feedback = {
      kind: result.applied ? 'success' : (result.allowed === false ? 'error' : 'info'),
      message: `Gateway ${result.mode || gatewayBackend} ${result.status || 'apply requested'}${result.message ? `: ${result.message}` : ''}`
    };
  } catch (error) {
    state.dnsCenter.feedback = { kind: 'error', message: error.message };
  } finally {
    state.dnsCenter.gatewayApplyBusy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
  }
}

async function evaluateDnsQueryFromAdmin(domain) {
  const value = String(domain || '').trim();
  state.dnsCenter.evaluateDomain = value;
  if (!value) {
    state.dnsCenter.feedback = { kind: 'error', message: 'Enter a domain before evaluating DNS.' };
    renderFoundationGrid(state.dashboard?.overview || {});
    return;
  }
  if (state.dnsCenter.evalBusy) return;
  state.dnsCenter.evalBusy = true;
  state.dnsCenter.feedback = { kind: 'info', message: `Evaluating ${value}` };
  renderFoundationGrid(state.dashboard?.overview || {});
  try {
    const payload = await fetchJson('/internal/v1/dns/evaluate', {
      method: 'POST',
      body: {
        appId: 'sdk-gateway',
        domain: value,
        requestId: 'admin-ui-dns-evaluate'
      }
    });
    state.dnsCenter.evaluateResult = payload.decision || null;
    state.dnsCenter.feedback = { kind: 'success', message: `Evaluated ${value}` };
  } catch (error) {
    state.dnsCenter.feedback = { kind: 'error', message: error.message };
  } finally {
    state.dnsCenter.evalBusy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
  }
}

function renderRelayEnrollmentPanel(options = {}) {
  const result = state.relayEnrollment.result;
  const feedback = state.relayEnrollment.feedback;
  const siteId = state.deploymentKind === 'domestic'
    ? selectedDomesticSiteId()
    : 'domestic-main';
  const product = options.productId ? launcherProductNetwork(options.productId) : null;
  const draft = relayEnrollmentDraftForRender(siteId, {
    productId: product?.productId,
    mode: 'standalone'
  });
  const lease = result?.leaseId ? result : null;
  const leaseIp = state.domesticPeerDraft.leaseIp || lease?.leaseIp || '';
  const productOptions = renderRelayProductOptions(draft.productId);
  const productOptionsId = options.compact ? 'relay-product-options-compact' : 'relay-product-options';
  const title = options.title || 'Product Relay Lease';
  const actionLabel = options.actionLabel || 'Create Product Lease';
  const panelClass = options.compact ? 'foundation-operation-panel relay-lease-panel is-compact' : 'foundation-operation-panel relay-lease-panel';
  const productLabel = product
    ? `${launcherProductDisplayName(product.productId, product)} / 10.${draft.productSecondOctet}`
    : draft.productId;
  const leasePlaceholder = draft.identityKind === 'user'
    ? `10.${draft.productSecondOctet}.0.x`
    : `10.${draft.productSecondOctet}.100.x`;
  return `
    <section class="${panelClass}">
      <div class="section-title compact-title">
        <h4>${escapeHtml(title)}</h4>
        <span>${escapeHtml(leaseIp || leasePlaceholder)}</span>
      </div>
      <div class="foundation-operation-grid relay-operation-grid">
        <label class="form-field">
          <span>App / Product</span>
          ${options.lockProduct
            ? `<input autocomplete="off" value="${escapeHtml(productLabel)}" disabled /><input type="hidden" data-relay-field="productId" value="${escapeHtml(draft.productId)}" />`
            : `<input data-relay-field="productId" list="${escapeHtml(productOptionsId)}" autocomplete="off" value="${escapeHtml(draft.productId)}" placeholder="mx-h2i or luopan" />
              <datalist id="${escapeHtml(productOptionsId)}">${productOptions}</datalist>`}
        </label>
        <label class="form-field compact-field">
          <span>10.* Segment</span>
          <input data-relay-field="productSecondOctet" inputmode="numeric" min="1" max="254" type="number" value="${escapeHtml(draft.productSecondOctet)}" />
        </label>
        <input type="hidden" data-relay-field="mode" value="standalone" />
        <label class="form-field compact-field">
          <span>Identity</span>
          <select data-relay-field="identityKind">
            <option value="anonymous" ${draft.identityKind === 'anonymous' ? 'selected' : ''}>anonymous</option>
            <option value="user" ${draft.identityKind === 'user' ? 'selected' : ''}>user</option>
          </select>
        </label>
        <label class="form-field">
          <span>Domestic Site</span>
          <input data-relay-field="siteId" autocomplete="off" value="${escapeHtml(draft.siteId)}" />
        </label>
        <label class="form-field">
          <span>Install ID</span>
          <input data-relay-field="installId" autocomplete="off" value="${escapeHtml(draft.installId)}" placeholder="optional" />
        </label>
        <label class="form-field">
          <span>Device ID</span>
          <input data-relay-field="deviceId" autocomplete="off" value="${escapeHtml(draft.deviceId)}" placeholder="optional" />
        </label>
        <label class="form-field">
          <span>User ID</span>
          <input data-relay-field="userId" autocomplete="off" value="${escapeHtml(draft.userId)}" placeholder="only for user identity" />
        </label>
        <label class="form-field">
          <span>Device Label</span>
          <input data-relay-field="deviceLabel" autocomplete="off" value="${escapeHtml(draft.deviceLabel)}" placeholder="optional" />
        </label>
        <label class="form-field wide-field">
          <span>Home WG Public Key</span>
          <input data-relay-field="publicKey" autocomplete="off" value="${escapeHtml(draft.publicKey || state.domesticPeerDraft.publicKey)}" placeholder="base64 public key" />
        </label>
      </div>
      <div class="foundation-operation-actions">
        <button class="primary-button" type="button" data-relay-enroll ${state.relayEnrollment.busy ? 'disabled' : ''}>
          ${state.relayEnrollment.busy ? 'Enrolling' : escapeHtml(actionLabel)}
        </button>
        ${feedback ? `<span class="profile-feedback" data-kind="${escapeHtml(feedback.kind)}">${escapeHtml(feedback.message)}</span>` : ''}
      </div>
      <div class="foundation-list">
        <article>
          <strong>${escapeHtml(leaseIp || '-')}</strong>
          <span>${escapeHtml(lease ? `${lease.productId} / ${lease.identityKind} / ${lease.launcherMode}` : `${draft.productId} / ${draft.identityKind} / ${draft.mode}`)}</span>
          <small>${escapeHtml(lease?.leaseId || state.domesticPeerDraft.publicKey || draft.publicKey || '-')}</small>
        </article>
      </div>
    </section>
  `;
}

function selectedDomesticSiteId() {
  const pipeline = asArray(state.dashboard?.siteSlotPipelines)
    .find((item) => item.kind === 'domestic' && item.siteId === state.selectedSiteId)
    || asArray(state.dashboard?.siteSlotPipelines).find((item) => item.kind === 'domestic');
  return pipeline?.siteId || 'domestic-main';
}

function renderEvidenceHistory(pipelines) {
  const allRows = asArray(pipelines)
    .slice()
    .sort((left, right) => String(right.latestUpdatedAt || '').localeCompare(String(left.latestUpdatedAt || '')));
  const meta = evidenceSubsectionMeta[state.adminSubsection] || evidenceSubsectionMeta.overview;
  const scopedRows = evidenceRowsForSubsection(allRows, state.adminSubsection);
  const rows = scopedRows.slice(0, 24);
  const scopeCard = `
    <article class="history-scope-card">
      <div>
        <span class="site-kind">Evidence</span>
        <strong>${escapeHtml(meta.title)}</strong>
        <p>${escapeHtml(meta.subtitle)}</p>
      </div>
      <span>${escapeHtml(String(scopedRows.length))} / ${escapeHtml(String(allRows.length))}</span>
    </article>
  `;
  if (!rows.length) {
    evidenceHistory.innerHTML = `${scopeCard}<div class="empty-state">No history for this subsystem yet</div>`;
    return;
  }
  evidenceHistory.innerHTML = scopeCard + rows.map((pipeline) => `
    <button class="history-row" type="button" data-plan-id="${escapeHtml(pipeline.planId)}" data-kind="${escapeHtml(pipeline.kind)}">
      <strong>${escapeHtml(pipeline.siteId)}</strong>
      <span>${escapeHtml(pipeline.kind)}</span>
      <span>${escapeHtml(pipeline.currentStage)}</span>
      <span>${escapeHtml(pipeline.latestStatus)}</span>
      <span>${formatTime(pipeline.latestUpdatedAt)}</span>
    </button>
  `).join('');
  for (const row of evidenceHistory.querySelectorAll('.history-row')) {
    row.addEventListener('click', () => {
      state.adminMenu = 'operations';
      state.adminSection = 'deployment';
      state.deploymentKind = row.dataset.kind === 'domestic' ? 'domestic' : 'oversea';
      state.adminSubsection = state.deploymentKind;
      void refreshPipelineDetail(row.dataset.planId);
      renderAdminShell();
    });
  }
}

function evidenceRowsForSubsection(rows, subsection) {
  if (subsection === 'executions') {
    return rows.filter((row) => row.currentStage === 'execution' || Number(row.counts?.executions || 0) > 0);
  }
  if (subsection === 'runner-sessions') {
    return rows.filter((row) => row.currentStage === 'runner-session' || Number(row.counts?.runnerSessions || 0) > 0);
  }
  if (subsection === 'worker-jobs') {
    return rows.filter((row) => row.currentStage === 'worker-job' || Number(row.counts?.workerJobs || 0) > 0);
  }
  if (subsection === 'worker-reports') {
    return rows.filter((row) => row.currentStage === 'worker-report' || Number(row.counts?.workerReports || 0) > 0);
  }
  if (subsection === 'rollback') {
    return rows.filter((row) => String(row.currentStage || '').includes('rollback')
      || Number(row.counts?.rollbackExecutions || 0) > 0
      || Number(row.counts?.rollbackReports || 0) > 0);
  }
  if (subsection === 'release-gate') {
    return rows.filter((row) => asArray(row.actionHints).some((action) => String(action.actionId || action.label || '').includes('release'))
      || String(row.currentStage || '').includes('gate')
      || String(row.latestStatus || '').includes('gate'));
  }
  return rows;
}

function renderAdminLoading() {
  state.currentPipeline = null;
  state.sshProfileBootstrap = null;
  state.awxProviders = [];
  state.awxRuntimePolicies = [];
  state.awxProviderCheck = null;
  renderAdminShell();
  closeEvidenceDrawer();
  adminGenerated.textContent = 'Loading';
  renderConsoleStatus({
    internal: 'Loading',
    store: 'connecting to Internal',
    provider: 'Worker V1',
    gate: 'loading gates',
    evidence: '0',
    osScope: 'Ubuntu + CentOS',
    principal: 'Resolving operator',
    principalScope: 'RBAC loading'
  });
  sshProfileCount.textContent = '0';
  sshProfileList.innerHTML = '<div class="empty-state">Loading SSH profiles</div>';
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  renderSshProfileBootstrap();
  renderSshProfileReadiness();
  awxProviderCount.textContent = '0';
  awxProviderList.innerHTML = '<div class="empty-state">Loading AWX providers</div>';
  renderAwxProviderFeedback();
  renderAwxProviderSaveState();
  renderAwxProviderCheck();
  renderAwxRuntimeGates();
  pipelineList.innerHTML = '<div class="empty-state">Loading pipelines</div>';
  pipelineTimeline.innerHTML = '';
  pipelineSummary.textContent = '';
  pipelineStepper.innerHTML = '';
  pipelineActions.innerHTML = '';
  siteWorkbench.innerHTML = '<div class="empty-state">Loading site workspace</div>';
  renderSetupGuidance(null, []);
  renderDashboardGuidance();
  renderInspector({ mode: 'loading' });
}

function renderAdminError(error) {
  state.currentPipeline = null;
  state.sshProfileBootstrap = null;
  state.awxProviders = [];
  state.awxRuntimePolicies = [];
  state.awxProviderCheck = null;
  renderAdminShell();
  closeEvidenceDrawer();
  adminGenerated.textContent = 'Admin API unavailable';
  renderConsoleStatus({
    internal: 'Offline',
    store: error.message,
    provider: 'Unavailable',
    gate: 'blocked',
    evidence: '0',
    osScope: 'Ubuntu + CentOS',
    principal: 'Unknown',
    principalScope: 'Admin API unavailable'
  });
  metricSiteSlots.textContent = '0';
  metricRollbacks.textContent = '0';
  metricReleases.textContent = '0';
  metricTests.textContent = '0';
  sshProfileCount.textContent = '0';
  sshProfileList.innerHTML = '<div class="empty-state">Admin API unavailable</div>';
  sshProfileFeedback.textContent = '';
  sshProfileFeedback.removeAttribute('data-kind');
  renderSshProfileSaveState();
  renderSshProfileBootstrap();
  renderSshProfileReadiness();
  awxProviderCount.textContent = '0';
  awxProviderList.innerHTML = '<div class="empty-state">Admin API unavailable</div>';
  awxProviderFeedback.textContent = '';
  awxProviderFeedback.removeAttribute('data-kind');
  renderAwxProviderSaveState();
  renderAwxProviderCheck();
  renderAwxRuntimeGates();
  pipelineCount.textContent = '0';
  pipelineHealth.textContent = 'Offline';
  pipelineHealth.dataset.health = 'failed';
  pipelineList.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  pipelineSummary.textContent = '';
  pipelineStepper.innerHTML = '';
  pipelineActions.innerHTML = '';
  pipelineTimeline.innerHTML = '';
  siteWorkbench.innerHTML = '';
  foundationGrid.innerHTML = '';
  evidenceHistory.innerHTML = '';
  renderSetupGuidance(null, []);
  renderDashboardGuidance();
  renderInspector({ mode: 'error', message: error.message });
}

function renderAdminDashboard(dashboard) {
  renderAdminShell();
  const overview = dashboard.overview || {};
  const principal = dashboard.actionPolicy?.principal;
  state.launcherServiceVipSmokes = asArray(dashboard.launcherServiceVipSmokes);
  state.launcherServiceVipSmokesError = null;
  state.awxProviders = asArray(dashboard.awxProviders);
  state.awxRuntimePolicies = asArray(dashboard.runtimeFeaturePolicies);
  renderConsoleStatus({
    internal: overview.siteId || 'Internal',
    store: `${overview.storeDriver || 'store'} / ${formatTime(dashboard.generatedAt)}`,
    provider: consoleProviderLabel(dashboard),
    gate: consoleGateLabel(dashboard),
    evidence: String(consoleEvidenceTotal(dashboard.siteSlotPipelines || [])),
    osScope: 'Ubuntu + CentOS/RHEL',
    principal: principal?.displayName || principal?.principalId || 'Shadow operator',
    principalScope: principal?.roles?.length ? principal.roles.join(' / ') : 'RBAC shadow'
  });
  adminGenerated.textContent = principal
    ? `Snapshot ${formatTime(dashboard.generatedAt)} / ${principal.displayName}`
    : `Snapshot ${formatTime(dashboard.generatedAt)}`;
  metricSiteSlots.textContent = String(overview.siteSlotPlans || 0);
  metricRollbacks.textContent = String(overview.siteSlotRollbackExecutions || 0);
  metricReleases.textContent = String(overview.releaseManagementPlans || 0);
  metricTests.textContent = String(overview.testRuns || 0);
  renderSshProfiles(state.sshProfiles);
  renderAwxProviders(state.awxProviders);
  renderAwxRuntimeGates();
  renderDeploymentWorkbench(dashboard.siteSlotPipelines || []);
  renderPipelineList(dashboard.siteSlotPipelines || []);
  renderFoundationGrid(overview);
  renderEvidenceHistory(dashboard.siteSlotPipelines || []);
  renderDashboardGuidance();
  updateTopologyFromPipelines(dashboard.siteSlotPipelines || []);
  renderInspector();
  scheduleInternalPeerRuntimeStatusRefreshFromDashboard(dashboard.siteSlotPipelines || []);
}

function renderConsoleStatus(input) {
  consoleInternalState.textContent = input.internal;
  consoleStoreDriver.textContent = input.store;
  consoleExecutionProvider.textContent = input.provider;
  consoleGateState.textContent = input.gate;
  consoleEvidenceCount.textContent = input.evidence;
  consoleOsScope.textContent = input.osScope;
  consolePrincipal.textContent = input.principal;
  consolePrincipalScope.textContent = input.principalScope;
}

function consoleProviderLabel(dashboard) {
  const providers = asArray(dashboard.awxProviders);
  const activeAwx = providers.find((provider) => provider && provider.status === 'active');
  if (activeAwx) {
    const name = String(activeAwx.name || activeAwx.providerId || 'AWX provider');
    return activeAwx.baseUrl ? `AWX shadow / ${name}` : 'AWX shadow / config-only';
  }
  const actions = asArray(dashboard.actionPolicy?.actions);
  const hasAwxShadow = actions.some((action) => String(action.actionId || '').includes('awx-shadow'));
  const hasRemoteSsh = actions.some((action) => String(action.actionId || '').includes('remote-ssh'));
  if (hasAwxShadow) return 'AWX shadow / SSH fallback';
  return hasRemoteSsh ? 'remote-ssh / AWX-ready' : 'Worker V1 / AWX-ready';
}

function consoleGateLabel(dashboard) {
  const actions = asArray(dashboard.actionPolicy?.actions);
  const allowed = actions.filter((action) => action.allowed).length;
  const gated = actions.filter((action) => action.gate && action.gate !== 'none').length;
  return `${allowed} allowed / ${gated} gated`;
}

function consoleEvidenceTotal(pipelines) {
  return asArray(pipelines).reduce((sum, pipeline) => {
    const counts = pipeline.counts || {};
    return sum
      + Number(counts.workerReports || 0)
      + Number(counts.rollbackReports || 0)
      + Number(counts.executions || 0)
      + Number(counts.runnerSessions || 0);
  }, 0);
}

function renderInspector(options = {}) {
  if (options.mode === 'loading') {
    inspectorKind.textContent = 'Inspector';
    inspectorTitle.textContent = 'Loading Internal';
    inspectorMeta.textContent = 'Waiting for dashboard, pipelines, and provider state.';
    inspectorStatus.textContent = 'ready';
    inspectorStatus.dataset.health = 'ready';
    inspectorFacts.innerHTML = renderInspectorFacts([
      ['Internal', 'loading'],
      ['Provider', 'Worker V1'],
      ['OS Scope', 'Ubuntu + CentOS/RHEL'],
      ['Evidence', 'pending']
    ]);
    inspectorNext.innerHTML = '<div class="empty-state">Loading action gates.</div>';
    inspectorEvidence.innerHTML = '<div class="empty-state">Loading timeline.</div>';
    return;
  }
  if (options.mode === 'error') {
    inspectorKind.textContent = 'Inspector';
    inspectorTitle.textContent = 'Admin API unavailable';
    inspectorMeta.textContent = options.message || 'Cannot load Internal state.';
    inspectorStatus.textContent = 'failed';
    inspectorStatus.dataset.health = 'failed';
    inspectorFacts.innerHTML = renderInspectorFacts([
      ['Internal', 'offline'],
      ['Provider', 'unavailable'],
      ['OS Scope', 'Ubuntu + CentOS/RHEL'],
      ['Evidence', 'not loaded']
    ]);
    inspectorNext.innerHTML = '<div class="empty-state">Reconnect Internal before running gated actions.</div>';
    inspectorEvidence.innerHTML = '<div class="empty-state">No evidence loaded.</div>';
    return;
  }

  const dashboard = state.dashboard;
  if (!dashboard) return renderInspector({ mode: 'loading' });

  const selectedSite = state.deploymentKind === 'oversea' ? selectedOverseaSite() : null;
  const currentSummary = state.currentPipeline?.summary || null;
  const summary = currentSummary && (!state.selectedSiteId || currentSummary.siteId === state.selectedSiteId)
    ? currentSummary
    : activePipelineForCurrentDeployment(dashboard.siteSlotPipelines || []);
  const profile = inspectorSshProfile(summary?.kind || state.deploymentKind, summary?.siteId || selectedSite?.siteId || state.selectedSiteId);
  const kind = state.adminSection === 'deployment' ? (summary?.kind || state.deploymentKind) : state.adminSection;
  const title = state.adminSection === 'deployment'
    ? (selectedSite?.siteId || summary?.siteId || `${kind} slot`)
    : state.adminSection === 'foundations'
      ? (internalSubsectionMeta[state.adminSubsection]?.title || 'Internal foundations')
      : state.adminSection === 'dashboard'
        ? 'I-HDO Dashboard'
        : (evidenceSubsectionMeta[state.adminSubsection]?.title || 'Evidence history');
  const dashboardRuntimeHealth = state.adminSection === 'dashboard' ? internalPeerRuntimeHealth() : null;
  const dashboardRuntimeReady = dashboardRuntimeHealth === 'passed' || dashboardRuntimeHealth === 'ready';
  const dashboardRuntimeStatus = dashboardRuntimeReady ? state.internalPeer.runtimeStatus : null;
  const health = dashboardRuntimeHealth || normalizeStageStatus(summary?.health || selectedSite?.status || 'ready');
  const statusText = dashboardRuntimeHealth || summary?.health || selectedSite?.status || 'ready';
  const stageText = dashboardRuntimeStatus ? 'live-runtime' : summary?.currentStage || '-';
  const latestText = dashboardRuntimeStatus ? dashboardRuntimeStatus.status || dashboardRuntimeHealth : summary?.latestStatus || selectedSite?.status || '-';
  const updatedText = dashboardRuntimeStatus ? dashboardRuntimeStatus.checkedAt : summary?.latestUpdatedAt;

  inspectorKind.textContent = kind;
  inspectorTitle.textContent = title;
  inspectorMeta.textContent = inspectorMetaText(summary, selectedSite);
  inspectorStatus.textContent = statusText;
  inspectorStatus.dataset.health = health;
  inspectorFacts.innerHTML = renderInspectorFacts([
    ['Host', selectedSite?.host || profile?.host || '-'],
    ['SSH Profile', selectedSite?.sshProfile?.profileId || profile?.profileId || '-'],
    ['Provider', consoleProviderLabel(dashboard)],
    ['OS Scope', 'Ubuntu + CentOS/RHEL'],
    ['Stage', stageText],
    ['Latest', latestText],
    ['Updated', formatTime(updatedText)],
    ['Objects', summary ? String(pipelineObjectCount(summary)) : '-']
  ]);
  inspectorNext.innerHTML = dashboardRuntimeStatus
    ? renderInspectorRuntimeNextAction(dashboardRuntimeStatus)
    : renderInspectorNextAction(summary, selectedSite);
  const timeline = summary && currentSummary?.siteId === summary.siteId ? state.currentPipeline?.timeline : [];
  renderInspectorEvidence(timeline || []);
}

function inspectorMetaText(summary, site) {
  if (state.adminSection === 'dashboard') return 'Topology, platform health, and next setup lanes.';
  if (state.adminSection === 'foundations') {
    return internalSubsectionMeta[state.adminSubsection]?.subtitle || 'Internal truth, platform services, and admin mutation boundaries.';
  }
  if (state.adminSection === 'evidence') {
    return evidenceSubsectionMeta[state.adminSubsection]?.subtitle || 'Recent plan, runner, worker, rollback, and report evidence.';
  }
  if (summary) return `${summary.currentStage || 'stage pending'} / ${summary.latestStatus || 'status pending'} / ${formatTime(summary.latestUpdatedAt)}`;
  if (site) return `${site.host || 'host pending'} / ${site.status || 'planned'}`;
  return 'Select a site or pipeline to inspect.';
}

function inspectorSshProfile(kind, siteId) {
  if (!siteId) return null;
  return asArray(state.sshProfiles)
    .filter((profile) => profile.kind === kind && profile.siteId === siteId)
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')))[0] || null;
}

function renderInspectorFacts(rows) {
  return rows.map(([label, value]) => `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd>${escapeHtml(value || '-')}</dd>
    </div>
  `).join('');
}

function renderInspectorNextAction(summary, site = null) {
  const actions = asArray(summary?.actionHints);
  const action = state.selectedAction || preferredNextAction(actions) || null;
  if (!action) {
    if (site) return renderInspectorSiteNextAction(site);
    return '<div class="empty-state">No gated action for the selected object.</div>';
  }
  return `
    <article class="inspector-action" data-allowed="${action.allowed ? 'true' : 'false'}">
      <span class="risk-chip" data-risk="${escapeHtml(action.risk || 'low')}">${escapeHtml(action.risk || 'low')}</span>
      <strong>${escapeHtml(action.label || action.actionId || 'action')}</strong>
      <small>${escapeHtml(action.gate || 'none')} / ${escapeHtml(action.allowed ? 'allowed' : 'locked')}</small>
      ${action.reason ? `<p>${escapeHtml(action.reason)}</p>` : ''}
    </article>
  `;
}

function renderInspectorRuntimeNextAction(runtimeStatus) {
  const health = internalPeerRuntimeHealth({ requireFresh: false }) || 'ready';
  const checkedAt = runtimeStatus?.checkedAt ? `checked ${formatTime(runtimeStatus.checkedAt)}` : 'runtime checked';
  return `
    <article class="inspector-action" data-allowed="true">
      <span class="risk-chip" data-risk="low">low</span>
      <strong>Internal Service Peer Ready</strong>
      <small>${escapeHtml(health)} / ${escapeHtml(checkedAt)}</small>
      <p>host-owned mx-internal-svc is the current runtime truth for the H-D-I path.</p>
    </article>
  `;
}

function renderInspectorSiteNextAction(site) {
  const profile = inspectorSshProfile(site.kind || state.deploymentKind, site.siteId);
  const profileReady = Boolean(profile?.profileId && profile?.identityFile);
  const label = !profile?.profileId
    ? 'Save SSH Profile'
    : profileReady
      ? 'Shadow Setup'
      : 'Complete SSH Access';
  const detail = !profile?.profileId
    ? 'Config Center profile required'
    : profileReady
      ? 'ready to create plan / runner / AWX job'
      : 'identity file or bootstrap key required';
  return `
    <article class="inspector-action" data-allowed="${profileReady ? 'true' : 'false'}">
      <span class="risk-chip" data-risk="${profileReady ? 'medium' : 'low'}">${profileReady ? 'medium' : 'low'}</span>
      <strong>${escapeHtml(label)}</strong>
      <small>${escapeHtml(site.status || 'planned')} / ${escapeHtml(detail)}</small>
    </article>
  `;
}

function renderInspectorEvidence(timeline) {
  const entries = asArray(timeline).slice(-5).reverse();
  if (!entries.length) {
    inspectorEvidence.innerHTML = '<div class="empty-state">No timeline evidence loaded.</div>';
    return;
  }
  inspectorEvidence.innerHTML = entries.map((entry, index) => `
    <button class="inspector-evidence-row" type="button" data-inspector-evidence-index="${index}">
      <span class="timeline-dot"></span>
      <strong>${escapeHtml(entry.title)}</strong>
      <small>${escapeHtml(entry.kind)} / ${escapeHtml(entry.status)} / ${formatTime(entry.at)}</small>
    </button>
  `).join('');
  for (const button of inspectorEvidence.querySelectorAll('[data-inspector-evidence-index]')) {
    button.addEventListener('click', () => {
      const entry = entries[Number(button.dataset.inspectorEvidenceIndex)];
      if (entry) openEvidenceDrawer(entry);
    });
  }
}

function renderPipelineList(pipelines) {
  const sites = deploymentSites(pipelines, deploymentPipelineKind());
  pipelineCount.textContent = String(sites.length);
  if (sites.length === 0) {
    pipelineList.innerHTML = `<div class="empty-state">No ${escapeHtml(deploymentKindLabel(state.deploymentKind))} sites</div>`;
    return;
  }
  pipelineList.innerHTML = sites.map((site) => {
    const pipeline = site.activePipeline;
    const runs = sitePipelinesForDisplay(site);
    return `
    <article class="pipeline-site">
      <button class="pipeline-item ${site.siteId === state.selectedSiteId && pipeline.planId === state.selectedPlanId ? 'is-selected' : ''}" type="button" data-site-id="${escapeHtml(site.siteId)}" data-plan-id="${escapeHtml(pipeline.planId)}">
        <span class="pipeline-top">
          <strong>${escapeHtml(site.siteId)}</strong>
          <span class="health-chip" data-health="${escapeHtml(pipeline.health)}">${escapeHtml(pipeline.health)}</span>
        </span>
        <span class="pipeline-meta">${escapeHtml(site.kind)} / ${escapeHtml(pipeline.currentStage)} / ${escapeHtml(pipeline.latestStatus)}</span>
        ${renderPipelineFailureSummary(pipeline, { compact: true })}
        <span class="pipeline-counts">${pipelineObjectCount(pipeline)} active objects / ${site.pipelines.length} history</span>
        <span class="pipeline-selected-role">${escapeHtml(sitePipelineRoleLabel(site, pipeline))}</span>
      </button>
      <div class="pipeline-run-strip" aria-label="${escapeHtml(site.siteId)} history runs">
        ${runs.map((run) => `
          <button
            class="pipeline-run ${run.planId === state.selectedPlanId ? 'is-selected' : ''}"
            type="button"
            data-site-id="${escapeHtml(site.siteId)}"
            data-plan-id="${escapeHtml(run.planId)}"
            title="${escapeHtml(run.currentStage)} / ${escapeHtml(run.latestStatus)} / ${formatTime(run.latestUpdatedAt)}"
          >
            <span class="health-dot" data-health="${escapeHtml(run.health)}"></span>
            <strong>${escapeHtml(run.currentStage)}</strong>
            <small>${formatTime(run.latestUpdatedAt)}</small>
          </button>
        `).join('')}
      </div>
    </article>
  `;
  }).join('');
  for (const item of pipelineList.querySelectorAll('.pipeline-item, .pipeline-run')) {
    item.addEventListener('click', () => {
      state.selectedSiteId = item.dataset.siteId || null;
      void refreshPipelineDetail(item.dataset.planId);
    });
  }
}

function renderPipelineSelection() {
  for (const item of pipelineList.querySelectorAll('.pipeline-item, .pipeline-run')) {
    item.classList.toggle(
      'is-selected',
      item.dataset.siteId === state.selectedSiteId && item.dataset.planId === state.selectedPlanId
    );
  }
}

function sitePipelinesForDisplay(site) {
  const activeId = site.activePipeline?.planId || '';
  const latestId = site.latestPipeline?.planId || '';
  const runs = asArray(site.pipelines)
    .slice()
    .sort((left, right) => String(right.latestUpdatedAt || '').localeCompare(String(left.latestUpdatedAt || '')));
  const pinned = [site.activePipeline, site.latestPipeline].filter(Boolean);
  return [...pinned, ...runs]
    .filter((pipeline, index, all) => pipeline && all.findIndex((item) => item?.planId === pipeline.planId) === index)
    .slice(0, activeId === latestId ? 4 : 5);
}

function sitePipelineRoleLabel(site, pipeline) {
  if (site.activePipeline?.planId === pipeline.planId && site.latestPipeline?.planId === pipeline.planId) return 'recommended + latest';
  if (site.activePipeline?.planId === pipeline.planId) return 'recommended';
  if (site.latestPipeline?.planId === pipeline.planId) return 'latest';
  return isFailedOrRollbackPipeline(pipeline) ? 'history' : 'run';
}

function renderPipelineDetail(pipeline) {
  state.currentPipeline = pipeline;
  const summary = pipeline.summary;
  const actions = summary.actionHints || [];
  pipelineHealth.textContent = summary.health;
  pipelineHealth.dataset.health = summary.health;
  focusTopologyNode(summary.kind);
  if (state.selectedAction && !actions.some((action) => sameAction(action, state.selectedAction))) {
    state.selectedAction = null;
  }
  renderCurrentPipelineSummary();
  const timeline = pipeline.timeline || [];
  pipelineStepper.innerHTML = renderPipelineStepper(pipeline);
  renderSetupGuidance(pipeline, actions);
  renderPipelineActions(actions);
  pipelineTimeline.innerHTML = timeline.map((entry, index) => `
    <li
      class="timeline-entry ${entry.id === state.selectedTimelineEntryId ? 'is-selected' : ''}"
      data-kind="${escapeHtml(entry.kind)}"
      data-entry-id="${escapeHtml(entry.id)}"
    >
      <button class="timeline-button" type="button" data-timeline-index="${index}">
        <span class="timeline-dot"></span>
        <span class="timeline-content">
          <span class="timeline-head">
            <strong>${escapeHtml(entry.title)}</strong>
            <span>${formatTime(entry.at)}</span>
          </span>
          <span class="timeline-meta">${escapeHtml(entry.kind)} / ${escapeHtml(entry.status)}</span>
          ${entry.nextActions && entry.nextActions.length ? `<span class="timeline-actions">${entry.nextActions.map(escapeHtml).join(' / ')}</span>` : ''}
        </span>
      </button>
    </li>
  `).join('');
  for (const button of pipelineTimeline.querySelectorAll('.timeline-button')) {
    button.addEventListener('click', () => {
      const entry = timeline[Number(button.dataset.timelineIndex)];
      if (entry) openEvidenceDrawer(entry);
    });
  }
  if (!timeline.some((entry) => entry.id === state.selectedTimelineEntryId)) {
    closeEvidenceDrawer();
  }
  if (state.adminSection === 'deployment') {
    renderDeploymentWorkbench(state.dashboard?.siteSlotPipelines || []);
  }
  renderInspector();
}

function renderCurrentPipelineSummary() {
  if (!state.currentPipeline) {
    pipelineSummary.textContent = '';
    return;
  }
  const summary = state.currentPipeline.summary || {};
  pipelineSummary.innerHTML = `
    <span><strong>${escapeHtml(summary.siteId)}</strong></span>
    <span>${escapeHtml(summary.kind)}</span>
    <span>${escapeHtml(summary.currentStage)}</span>
    <span>${escapeHtml(summary.latestStatus)}</span>
    <span>${formatTime(summary.latestUpdatedAt)}</span>
    ${renderPipelineFailureSummary(summary, { compact: true })}
    ${renderMihomoReachabilityStrip(summary)}
  `;
}

function renderMihomoReachabilityStrip(summary) {
  if (summary.kind !== 'oversea') return '';
  if (state.mihomoReachabilityError && state.mihomoReachabilitySiteId === summary.siteId) {
    return `
      <span class="reachability-strip" data-status="blocked">
        <strong>Launcher Network</strong>
        <span>${escapeHtml(state.mihomoReachabilityError)}</span>
      </span>
    `;
  }
  const reachability = state.mihomoReachabilitySiteId === summary.siteId ? state.mihomoReachability : null;
  if (!reachability) {
    return `
      <span class="reachability-strip" data-status="planned">
        <strong>Launcher Network</strong>
        <span>loading reachability</span>
      </span>
    `;
  }
  const domesticRelay = asArray(reachability.stages).find((stage) => stage.stageId === 'domestic-wg-relay');
  const h2iDns = asArray(reachability.stages).find((stage) => stage.stageId === 'h2i-internal-dns');
  const status = reachability.verdict === 'h-endpoint-ready' ? 'passed' : reachability.verdict === 'blocked' ? 'blocked' : 'ready';
  return `
    <span class="reachability-strip" data-status="${escapeHtml(status)}">
      <strong>${escapeHtml(reachability.verdict)}</strong>
      <span>${escapeHtml(reachability.currentBoundary)}</span>
      <span>Domestic WG ${escapeHtml(domesticRelay?.status || 'unknown')}</span>
      <span>H2I DNS ${escapeHtml(h2iDns?.status || 'unknown')}</span>
      <span>${escapeHtml(reachability.gates?.domesticGatewayIp || '10.88.0.1')}</span>
    </span>
  `;
}

function renderPipelineStepper(pipeline) {
  const steps = pipelineStepperSteps(pipeline);
  return `
    <section class="workflow-stepper" aria-label="Site slot workflow">
      ${steps.map((step, index) => `
        <div class="workflow-step" data-status="${escapeHtml(step.status)}">
          <span class="workflow-step-index">${index + 1}</span>
          <strong>${escapeHtml(step.label)}</strong>
          <small>${escapeHtml(step.detail)}</small>
        </div>
      `).join('')}
    </section>
  `;
}

function pipelineStepperSteps(pipeline) {
  const plan = pipeline.plan || {};
  const executions = asArray(pipeline.executions);
  const runnerSessions = asArray(pipeline.runnerSessions);
  const workerJobs = asArray(pipeline.workerJobs);
  const workerReports = asArray(pipeline.workerReports);
  const actionHints = asArray(pipeline.summary?.actionHints);
  const preflight = latestItem(executions.filter((execution) => execution.action === 'preflight'), 'createdAt');
  const apply = latestItem(executions.filter((execution) => execution.action === 'apply'), 'createdAt');
  const runner = latestItem(runnerSessions, 'startedAt');
  const workerJob = latestItem(workerJobs, 'createdAt');
  const workerReport = latestItem(workerReports, 'createdAt');
  const probeAction = actionHints.find((action) => action.actionId === 'site-slot.worker-run.remote-ssh-readonly-probe');
  return [
    {
      label: 'SSH Profile',
      status: plan.ssh?.profileId ? normalizeStageStatus(plan.ssh.profileStatus || 'ready') : 'planned',
      detail: plan.ssh?.profileId || 'not linked'
    },
    {
      label: 'Plan',
      status: normalizeStageStatus(plan.status),
      detail: plan.status || 'planned'
    },
    {
      label: 'Preflight',
      status: preflight ? normalizeStageStatus(preflight.status) : 'planned',
      detail: preflight ? preflight.status : 'not started'
    },
    {
      label: 'Apply',
      status: apply ? normalizeStageStatus(apply.status) : 'planned',
      detail: apply ? apply.confirmApply ? 'confirmed' : apply.status : 'not started'
    },
    {
      label: 'Runner',
      status: runner ? normalizeStageStatus(runner.status) : 'planned',
      detail: runner ? `${runner.mode} / ${runner.status}` : 'not started'
    },
    {
      label: 'Worker Job',
      status: workerJob ? normalizeStageStatus(workerJob.status) : 'planned',
      detail: workerJob ? `${workerJob.worker?.kind || 'worker'} / ${workerJob.status}` : 'not created'
    },
    {
      label: 'Read-only Probe',
      status: workerReport ? 'passed' : probeAction ? probeAction.allowed ? 'ready' : 'blocked' : 'planned',
      detail: workerReport ? 'covered by report' : probeAction ? probeAction.allowed ? 'ready' : probeAction.reason : 'not available'
    },
    {
      label: 'Evidence',
      status: workerReport ? normalizeStageStatus(workerReport.status) : 'planned',
      detail: workerReport ? `${workerReport.status} report` : 'not recorded'
    }
  ];
}

function normalizeStageStatus(status) {
  if (status === 'passed' || status === 'completed' || status === 'active') return 'passed';
  if (status === 'ready' || status === 'ready-for-preflight' || status === 'queued') return 'ready';
  if (status === 'running') return 'running';
  if (status === 'rollback') return 'rollback';
  if (status === 'failed' || status === 'rollback-required') return 'failed';
  if (status === 'blocked' || status === 'requires-confirmation' || status === 'paused') return 'blocked';
  return 'planned';
}

function latestItem(items, key) {
  return asArray(items).slice().sort((left, right) => String(left?.[key] || '').localeCompare(String(right?.[key] || ''))).pop() || null;
}

function consumePendingEvidenceFocus(pipeline) {
  const focus = state.pendingEvidenceFocus;
  if (!focus || !pipeline) return;
  const planId = pipeline.summary?.planId;
  if (focus.planId && focus.planId !== planId) return;
  const entry = asArray(pipeline.timeline).find((item) => item.kind === focus.kind && item.id === focus.id);
  state.pendingEvidenceFocus = null;
  if (entry) openEvidenceDrawer(entry);
}

function renderEmptyPipeline() {
  state.currentPipeline = null;
  closeEvidenceDrawer();
  pipelineHealth.textContent = 'Idle';
  pipelineHealth.dataset.health = 'planned';
  pipelineSummary.textContent = '';
  pipelineStepper.innerHTML = '';
  state.currentActions = [];
  state.selectedAction = null;
  pipelineActions.innerHTML = '';
  pipelineTimeline.innerHTML = '<li class="empty-state">No pipeline selected</li>';
  renderSetupGuidance(null, []);
  renderInspector();
}

function openEvidenceDrawer(entry) {
  const evidence = buildEvidenceView(state.currentPipeline, entry);
  if (!evidence) return;
  state.selectedTimelineEntryId = entry.id;
  renderEvidenceDrawer(evidence);
  evidenceDrawer.hidden = false;
  evidenceBackdrop.hidden = false;
  updateTimelineSelectedState();
}

function closeEvidenceDrawer() {
  state.selectedTimelineEntryId = null;
  evidenceDrawer.hidden = true;
  evidenceBackdrop.hidden = true;
  updateTimelineSelectedState();
}

function updateTimelineSelectedState() {
  let selectedItem = null;
  for (const item of pipelineTimeline.querySelectorAll('.timeline-entry')) {
    const selected = item.dataset.entryId === state.selectedTimelineEntryId;
    item.classList.toggle('is-selected', selected);
    if (selected) selectedItem = item;
  }
  if (selectedItem && !evidenceDrawer.hidden) {
    selectedItem.scrollIntoView({ block: 'nearest' });
  }
}

function buildEvidenceView(pipeline, entry) {
  const object = evidenceObjectForEntry(pipeline, entry);
  if (!object) return null;
  const steps = evidenceStepsFor(pipeline, entry.kind, object);
  return {
    entry,
    object,
    steps,
    awxSummary: awxSummaryForEvidence(object, steps),
    summary: evidenceSummaryFields(object, entry, steps)
  };
}

function evidenceObjectForEntry(pipeline, entry) {
  if (!pipeline || !entry) return null;
  if (entry.kind === 'plan') return pipeline.plan?.planId === entry.id ? pipeline.plan : null;
  if (entry.kind === 'execution') return findById(pipeline.executions, 'runId', entry.id);
  if (entry.kind === 'runner-session') return findById(pipeline.runnerSessions, 'sessionId', entry.id);
  if (entry.kind === 'worker-job') return findById(pipeline.workerJobs, 'jobId', entry.id);
  if (entry.kind === 'worker-report') return findById(pipeline.workerReports, 'reportId', entry.id);
  if (entry.kind === 'rollback-execution') return findById(pipeline.rollbackExecutions, 'rollbackExecutionId', entry.id);
  if (entry.kind === 'rollback-report') return findById(pipeline.rollbackReports, 'rollbackReportId', entry.id);
  return null;
}

function evidenceStepsFor(pipeline, kind, object) {
  if (kind === 'plan') return planSteps(object);
  if (kind === 'execution') return asArray(object.steps).map((step) => normalizeStep(step));
  if (kind === 'runner-session') return asArray(object.stepResults).map((step) => normalizeStep(step));
  if (kind === 'worker-job') return asArray(object.steps).map((step) => normalizeStep(step));
  if (kind === 'worker-report') {
    const job = findById(pipeline.workerJobs, 'jobId', object.jobId);
    return enrichStepReports(object.stepReports, job?.steps);
  }
  if (kind === 'rollback-execution') return asArray(object.stepResults).map((step) => normalizeStep(step));
  if (kind === 'rollback-report') {
    const execution = findById(pipeline.rollbackExecutions, 'rollbackExecutionId', object.rollbackExecutionId);
    return enrichStepReports(object.stepReports, execution?.stepResults, execution?.rollbackPlan?.steps);
  }
  return [];
}

function planSteps(plan) {
  const phases = asArray(plan.deploymentPhases).flatMap((phase) => {
    const commands = asArray(phase.commands);
    return commands.map((command, index) => normalizeStep({
      stepId: `${phase.phaseId}-${index + 1}`,
      order: index + 1,
      title: phase.title,
      target: phase.target,
      status: phase.required ? 'required' : 'optional',
      command,
      requiresRoot: null
    }));
  });
  if (phases.length > 0) return phases;
  return asArray(plan.preflightChecks).map((check, index) => normalizeStep({
    stepId: check.checkId,
    order: index + 1,
    title: check.title,
    target: check.stage,
    status: check.severity,
    command: check.command,
    requiresRoot: check.requiresRoot
  }));
}

function enrichStepReports(reports, ...metadataSources) {
  const metadataByStepId = new Map();
  for (const source of metadataSources) {
    for (const step of asArray(source)) {
      if (!step?.stepId || metadataByStepId.has(step.stepId)) continue;
      metadataByStepId.set(step.stepId, step);
    }
  }
  return asArray(reports).map((report) => normalizeStep(report, metadataByStepId.get(report.stepId)));
}

function normalizeStep(step, metadata = {}) {
  const stdout = firstDefined(step.stdout, step.output, metadata.stdout, metadata.output, null);
  return {
    id: firstDefined(step.stepId, metadata.stepId, '-'),
    sourceId: firstDefined(step.sourceId, metadata.sourceId, null),
    order: firstDefined(step.order, metadata.order, null),
    title: firstDefined(step.title, metadata.title, step.stepId, metadata.stepId, 'step'),
    target: firstDefined(step.target, metadata.target, '-'),
    status: firstDefined(step.status, metadata.status, null),
    requiresRoot: firstDefined(step.requiresRoot, metadata.requiresRoot, metadata.requiresApproval, null),
    command: firstDefined(step.command, metadata.command, null),
    exitCode: firstDefined(step.exitCode, metadata.exitCode, null),
    stdout,
    stderr: firstDefined(step.stderr, step.error, metadata.stderr, metadata.error, null),
    startedAt: firstDefined(step.startedAt, metadata.startedAt, null),
    finishedAt: firstDefined(step.finishedAt, metadata.finishedAt, null),
    attempt: firstDefined(step.attempt, metadata.attempt, null),
    evidence: parseStepEvidence(stdout)
  };
}

function renderEvidenceDrawer(evidence) {
  const { entry, object, steps, summary, awxSummary } = evidence;
  evidenceKind.textContent = entry.kind;
  evidenceTitle.textContent = entry.title;
  evidenceMeta.textContent = `${objectId(object, entry.kind)} / ${entry.status} / ${formatTime(entry.at)}`;
  evidenceSummary.innerHTML = `${renderEvidenceSummary(summary)}${renderAwxSummaryPanel(awxSummary, 'evidence')}`;
  evidenceSteps.innerHTML = renderEvidenceSteps(steps);
  evidenceJson.textContent = formatJson(object);
}

function renderEvidenceSummary(fields) {
  return fields.map(([label, value]) => `
    <div>
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(formatSummaryValue(value))}</strong>
    </div>
  `).join('');
}

function renderAwxSummaryPanel(summary, variant = 'setup') {
  if (!summary) return '';
  const facts = [
    ['Job', summary.awxJobId ? `#${summary.awxJobId}` : '-'],
    ['AWX Status', summary.awxJobStatus || '-'],
    ['Launch', summary.status || '-'],
    ['Events', summary.eventsCaptured ? `${summary.eventsCount || 0} captured` : `${summary.eventsCount || 0}`],
    ['Report', summary.reportId || '-'],
    ['Template', summary.jobTemplateId || '-']
  ];
  return `
    <section class="awx-summary-panel" data-variant="${escapeHtml(variant)}" data-status="${escapeHtml(normalizeStageStatus(summary.status || summary.awxJobStatus))}">
      <div class="awx-summary-head">
        <span>AWX Job</span>
        <strong>${escapeHtml(summary.awxJobId ? `#${summary.awxJobId}` : summary.awxJobStatus || 'pending')}</strong>
      </div>
      <div class="awx-summary-grid">
        ${facts.map(([label, value]) => `
          <div>
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(formatSummaryValue(value))}</strong>
          </div>
        `).join('')}
      </div>
      ${summary.nextActions?.length ? `<p>${summary.nextActions.map(escapeHtml).join(' / ')}</p>` : ''}
    </section>
  `;
}

function renderEvidenceSteps(steps) {
  if (!steps.length) {
    return '<div class="empty-state">No step evidence</div>';
  }
  return `
    <div class="evidence-step-count">${steps.length} steps</div>
    <div class="evidence-step-list">
      ${steps.map(renderEvidenceStep).join('')}
    </div>
  `;
}

function renderEvidenceStep(step) {
  return `
    <article class="evidence-step">
      <div class="evidence-step-head">
        <strong>${escapeHtml(step.order ? `${step.order}. ${step.title}` : step.title)}</strong>
        ${step.status ? `<span class="step-status" data-status="${escapeHtml(step.status)}">${escapeHtml(step.status)}</span>` : ''}
      </div>
      <dl class="evidence-step-grid">
        <div><dt>step</dt><dd>${escapeHtml(step.id)}</dd></div>
        <div><dt>target</dt><dd>${escapeHtml(step.target)}</dd></div>
        <div><dt>requiresRoot</dt><dd>${escapeHtml(formatBoolean(step.requiresRoot))}</dd></div>
        <div><dt>exitCode</dt><dd>${escapeHtml(formatStepValue(step.exitCode))}</dd></div>
        <div><dt>attempt</dt><dd>${escapeHtml(formatStepValue(step.attempt))}</dd></div>
        <div><dt>startedAt</dt><dd>${escapeHtml(formatTime(step.startedAt))}</dd></div>
        <div><dt>finishedAt</dt><dd>${escapeHtml(formatTime(step.finishedAt))}</dd></div>
      </dl>
      <div class="evidence-command">
        <span>command</span>
        <code>${escapeHtml(formatStepValue(step.command))}</code>
      </div>
      ${renderStepEvidenceInsight(step.evidence)}
      <div class="evidence-output-grid">
        <div>
          <span>stdout</span>
          <pre>${escapeHtml(formatStepValue(step.stdout))}</pre>
        </div>
        <div>
          <span>stderr</span>
          <pre>${escapeHtml(formatStepValue(step.stderr))}</pre>
        </div>
      </div>
    </article>
  `;
}

function renderStepEvidenceInsight(evidence) {
  if (!evidence || typeof evidence !== 'object' || !evidence.mode) return '';
  const artifacts = asArray(evidence.artifactReferences);
  const planOnly = evidence.planOnly || {};
  const sshProfile = evidence.sshProfile || {};
  const transport = evidence.transport || {};
  const artifactRows = artifacts.slice(0, 4).map((artifact) => `
    <li>
      <span>${escapeHtml(artifact.ref || artifact.module?.moduleId || 'artifact')}</span>
      <strong>${escapeHtml(artifactEvidenceStatus(artifact))}</strong>
      <small>${escapeHtml(artifact.module?.targetPath || artifact.path || '-')}</small>
    </li>
  `).join('');
  const hiddenArtifactCount = Math.max(0, artifacts.length - 4);
  return `
    <section class="evidence-insight" data-mode="${escapeHtml(evidence.mode)}">
      <div class="evidence-insight-head">
        <strong>${escapeHtml(evidence.mode)}</strong>
        <span>${escapeHtml(evidence.execution || '-')} / ${escapeHtml(evidence.boundary || '-')}</span>
      </div>
      <div class="evidence-insight-grid">
        <div><span>commandExecuted</span><strong>${escapeHtml(formatBoolean(planOnly.commandExecuted))}</strong></div>
        <div><span>remoteMutation</span><strong>${escapeHtml(formatBoolean(planOnly.remoteMutation))}</strong></div>
        <div><span>repositoryRootSynced</span><strong>${escapeHtml(formatBoolean(transport.repositoryRootSynced))}</strong></div>
        <div><span>artifactSha</span><strong>${escapeHtml(artifactCheckSummary(artifacts))}</strong></div>
        <div><span>sshProfile</span><strong>${escapeHtml(sshProfile.profileId || sshProfile.managedProfileId || sshProfile.source || '-')}</strong></div>
        <div><span>identity</span><strong>${escapeHtml(formatBoolean(sshProfile.identityFileExists))}</strong></div>
        <div><span>knownHosts</span><strong>${escapeHtml(formatBoolean(sshProfile.knownHostsFileExists))}</strong></div>
        <div><span>sshConfig</span><strong>${escapeHtml(formatBoolean(sshProfile.sshConfigFileExists))}</strong></div>
        <div><span>strictHostKey</span><strong>${escapeHtml(formatStepValue(sshProfile.strictHostKeyChecking))}</strong></div>
      </div>
      ${evidence.effectiveCommand ? `
        <div class="evidence-effective-command">
          <span>effectiveCommand</span>
          <code>${escapeHtml(evidence.effectiveCommand)}</code>
        </div>
      ` : ''}
      ${artifacts.length ? `
        <ul class="evidence-artifacts">
          ${artifactRows}
          ${hiddenArtifactCount ? `<li><span>more</span><strong>${hiddenArtifactCount}</strong><small>-</small></li>` : ''}
        </ul>
      ` : ''}
    </section>
  `;
}

function evidenceSummaryFields(object, entry, steps = []) {
  return [
    ['id', objectId(object, entry.kind)],
    ['parent', entry.parentId],
    ['status', object.status],
    ['siteId', object.siteId],
    ['environment', object.environment],
    ['mode', object.mode ?? object.action ?? object.contractVersion],
    ['worker', object.workerId ?? object.worker?.workerId],
    ['message', object.message],
    ['createdBy', object.createdBy],
    ['createdAt', object.createdAt],
    ['startedAt', object.startedAt],
    ['finishedAt', object.finishedAt ?? object.updatedAt],
    ...workerReportEvidenceSummary(entry.kind, steps),
    ['warnings', asArray(object.warnings).join(' / ')],
    ['nextActions', asArray(object.nextActions).join(' / ')]
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
}

function workerReportEvidenceSummary(kind, steps) {
  if (kind !== 'worker-report') return [];
  const evidences = asArray(steps).map((step) => step.evidence).filter(Boolean);
  if (!evidences.length) return [];
  const artifacts = evidences.flatMap((evidence) => asArray(evidence.artifactReferences));
  const artifactCounts = artifactCheckCounts(artifacts);
  const commandExecutedValues = evidences
    .map((evidence) => firstDefined(evidence.planOnly?.commandExecuted, evidence.fakeTransport?.commandExecuted))
    .filter((value) => value !== undefined && value !== null);
  const remoteMutationValues = evidences
    .map((evidence) => firstDefined(evidence.planOnly?.remoteMutation, evidence.fakeTransport?.remoteMutation))
    .filter((value) => value !== undefined && value !== null);
  const repositoryRootValues = evidences
    .map((evidence) => evidence.transport?.repositoryRootSynced)
    .filter((value) => value !== undefined && value !== null);
  return [
    ...workerReportFirstFailureSummary(steps),
    ['evidenceMode', uniqueText(evidences.map((evidence) => evidence.mode)).join(' / ')],
    ['execution', uniqueText(evidences.map((evidence) => evidence.execution)).join(' / ')],
    ['boundary', uniqueText(evidences.map((evidence) => evidence.boundary)).join(' / ')],
    ['commandExecuted', summarizeBooleanValues(commandExecutedValues)],
    ['remoteMutation', summarizeBooleanValues(remoteMutationValues)],
    ['repositoryRootSynced', summarizeBooleanValues(repositoryRootValues)],
    ['artifactSha', artifactCounts.total ? `${artifactCounts.passed}/${artifactCounts.total}` : null],
    ['sshProfiles', uniqueText(evidences.map((evidence) => {
      const profile = evidence.sshProfile || {};
      return profile.profileId || profile.managedProfileId || profile.source;
    })).join(' / ')],
    ['effectiveCommands', evidences.filter((evidence) => evidence.effectiveCommand).length]
  ];
}

function workerReportFirstFailureSummary(steps) {
  const failed = asArray(steps).find((step) => step.status === 'failed')
    ?? asArray(steps).find((step) => step.status === 'blocked' && !derivedBlockedStep(step));
  if (!failed) return [];
  const phase = failed.evidence?.phaseId || failed.sourceId || failed.id || 'step';
  const message = compactStepMessage(
    failed.stderr
      || failed.evidence?.executionResult?.stderr
      || failed.evidence?.executionResult?.stdout
      || failed.evidence?.gateFailures?.join?.('; ')
      || 'worker step failed'
  );
  return [
    ['firstFailure', `${failed.id} / ${phase}`],
    ['failureMessage', message]
  ];
}

function derivedBlockedStep(step) {
  const stderr = String(step?.stderr || '').toLowerCase();
  return stderr.includes('stopped after previous step failed');
}

function compactStepMessage(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' / ')
    .slice(0, 360);
}

function awxSummaryForEvidence(object, steps) {
  const fromSteps = asArray(steps)
    .map((step) => awxSummaryFromEvidence(step.evidence))
    .find(Boolean);
  if (fromSteps) {
    return {
      ...fromSteps,
      reportId: fromSteps.reportId || object?.reportId || null
    };
  }
  return awxSummaryFromLaunch(object?.awxLaunch || object?.awx);
}

function latestAwxSummaryFromPipeline(pipeline) {
  const reports = asArray(pipeline?.workerReports).slice().sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
  for (const report of reports) {
    const steps = enrichStepReports(report.stepReports);
    const summary = awxSummaryForEvidence(report, steps);
    if (summary) return summary;
  }
  return null;
}

function awxSummaryFromEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const launch = evidence.awx?.launch || evidence.awx;
  return awxSummaryFromLaunch(launch);
}

function awxSummaryFromPayload(payload) {
  const summary = awxSummaryFromLaunch(payload?.awxLaunch);
  if (!summary) return null;
  return {
    ...summary,
    reportId: summary.reportId || payload?.report?.reportId || null
  };
}

function awxSummaryFromLaunch(launch) {
  if (!launch || typeof launch !== 'object') return null;
  if (!('awxJobId' in launch) && !('awxJobStatus' in launch) && launch.provider !== 'awx-api') return null;
  const events = launch.events || {};
  return {
    status: launch.status || null,
    execution: launch.execution || null,
    boundary: launch.boundary || null,
    awxJobId: launch.awxJobId || null,
    awxJobStatus: launch.awxJobStatus || null,
    jobTemplateId: launch.jobTemplateId || null,
    reportId: launch.reportId || null,
    eventsCount: Number(events.count || 0),
    eventsCaptured: events.captured === true,
    nextActions: asArray(launch.nextActions)
  };
}

function objectId(object, kind) {
  if (kind === 'plan') return object.planId;
  if (kind === 'execution') return object.runId;
  if (kind === 'runner-session') return object.sessionId;
  if (kind === 'worker-job') return object.jobId;
  if (kind === 'worker-report') return object.reportId;
  if (kind === 'rollback-execution') return object.rollbackExecutionId;
  if (kind === 'rollback-report') return object.rollbackReportId;
  return '-';
}

function findById(items, key, value) {
  return asArray(items).find((item) => item?.[key] === value) ?? null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function parseStepEvidence(value) {
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function artifactEvidenceStatus(artifact) {
  const manifest = artifact?.manifest?.sha256Status || '-';
  const module = artifact?.module?.sha256Status || '-';
  return `manifest:${manifest} module:${module}`;
}

function artifactCheckSummary(artifacts) {
  const counts = artifactCheckCounts(artifacts);
  if (!counts.total) return '-';
  return `${counts.passed}/${counts.total}`;
}

function artifactCheckCounts(artifacts) {
  const items = asArray(artifacts);
  return {
    total: items.length,
    passed: items.filter((artifact) => artifact?.manifest?.sha256Status === 'passed'
      && artifact?.module?.sha256Status === 'passed').length
  };
}

function uniqueText(values) {
  return Array.from(new Set(values
    .map((value) => typeof value === 'string' ? value.trim() : '')
    .filter(Boolean)));
}

function summarizeBooleanValues(values) {
  if (!values.length) return null;
  const normalized = values.map((value) => value === true);
  const hasTrue = normalized.some(Boolean);
  const hasFalse = normalized.some((value) => !value);
  if (hasTrue && hasFalse) return 'mixed';
  return hasTrue ? 'yes' : 'no';
}

function formatSummaryValue(value) {
  if (Array.isArray(value)) return value.join(' / ');
  if (typeof value === 'object' && value !== null) return formatJson(value);
  return String(value);
}

function formatBoolean(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return '-';
}

function formatStepValue(value) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

function blankToNull(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function positiveNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function renderPipelineActions(actions) {
  state.currentActions = actions;
  if (!actions.length) {
    pipelineActions.innerHTML = '<div class="empty-state">No gated actions</div>';
    return;
  }
  const selected = state.selectedAction;
  const nextAction = preferredNextAction(actions);
  const feedback = state.actionFeedback && state.actionFeedback.planId === state.selectedPlanId
    ? renderActionFeedback(state.actionFeedback)
    : '';
  pipelineActions.innerHTML = `
    <details class="advanced-actions" ${selected || feedback ? 'open' : ''}>
      <summary>
        <span>Advanced audit actions</span>
        <strong>${actions.filter((action) => action.allowed).length}/${actions.length}</strong>
      </summary>
      ${renderNextGate(nextAction)}
      <div class="action-grid">
        ${actions.map((action, index) => `
          <button
            class="admin-action ${action.allowed ? 'is-allowed' : 'is-locked'} ${selected && sameAction(action, selected) ? 'is-selected' : ''} ${nextAction && sameAction(action, nextAction) ? 'is-recommended' : ''}"
            type="button"
            title="${escapeHtml(action.reason)}"
            data-action-index="${index}"
            data-action-id="${escapeHtml(action.actionId)}"
            ${action.allowed ? '' : 'disabled'}
          >
            <span class="action-main">
              <strong>${escapeHtml(action.label)}</strong>
              <span class="risk-chip" data-risk="${escapeHtml(action.risk)}">${escapeHtml(action.risk)}</span>
            </span>
            <span class="action-path">${escapeHtml(action.method)} ${escapeHtml(action.path)}</span>
            <span class="action-meta">${escapeHtml(action.gate)} / ${escapeHtml(action.reason)}</span>
          </button>
        `).join('')}
      </div>
      ${feedback}
      ${selected ? renderActionConfirm(selected) : ''}
    </details>
  `;
  for (const button of pipelineActions.querySelectorAll('.admin-action')) {
    button.addEventListener('click', () => {
      const action = actions[Number(button.dataset.actionIndex)];
      if (!action || !action.allowed) return;
      selectPipelineAction(action);
      state.actionFeedback = null;
      renderPipelineActions(actions);
      renderInspector();
    });
  }
  const nextButton = pipelineActions.querySelector('[data-action-next]');
  if (nextButton) {
    nextButton.addEventListener('click', () => {
      if (!nextAction?.allowed) return;
      selectPipelineAction(nextAction);
      state.actionFeedback = null;
      renderPipelineActions(actions);
      renderInspector();
    });
  }
  const cancelButton = pipelineActions.querySelector('[data-action-cancel]');
  if (cancelButton) {
    cancelButton.addEventListener('click', () => {
      state.selectedAction = null;
      state.selectedActionBody = null;
      renderPipelineActions(actions);
      renderInspector();
    });
  }
  const executeButton = pipelineActions.querySelector('[data-action-execute]');
  if (executeButton) {
    const refreshExecuteState = () => {
      const checks = Array.from(pipelineActions.querySelectorAll('[data-confirm-field]'));
      const bodyInput = pipelineActions.querySelector('[data-action-body]');
      executeButton.disabled = state.actionBusy
        || checks.some((input) => !input.checked)
        || !isActionBodyExecutable(bodyInput?.value || '');
    };
    const bodyInput = pipelineActions.querySelector('[data-action-body]');
    if (bodyInput) {
      bodyInput.addEventListener('input', () => {
        state.selectedActionBody = bodyInput.value;
        syncDomesticPeerDraftFromBodyText(bodyInput.value);
        syncAwxActionDraftFromBodyText(bodyInput.value);
        refreshExecuteState();
      });
    }
    for (const input of pipelineActions.querySelectorAll('[data-home-peer-field]')) {
      input.addEventListener('input', () => {
        syncHomePeerField(input);
        updateSelectedActionBodyFromHomePeer();
        refreshExecuteState();
      });
      input.addEventListener('change', () => {
        syncHomePeerField(input);
        updateSelectedActionBodyFromHomePeer();
        refreshExecuteState();
      });
    }
    for (const input of pipelineActions.querySelectorAll('[data-awx-action-field]')) {
      input.addEventListener('input', () => {
        syncAwxActionField(input);
        updateSelectedActionBodyFromAwxDraft();
        refreshExecuteState();
      });
      input.addEventListener('change', () => {
        syncAwxActionField(input);
        updateSelectedActionBodyFromAwxDraft();
        refreshExecuteState();
      });
    }
    for (const checkbox of pipelineActions.querySelectorAll('[data-confirm-field]')) {
      checkbox.addEventListener('change', refreshExecuteState);
    }
    executeButton.addEventListener('click', () => {
      void executeSelectedAction();
    });
    refreshExecuteState();
  }
}

function renderActionFeedback(feedback) {
  return `
    <div class="action-feedback" data-kind="${escapeHtml(feedback.kind)}">
      <strong>${escapeHtml(feedback.message)}</strong>
      ${renderAwxSummaryPanel(feedback.awxSummary, 'action')}
      ${feedback.detail ? `<pre>${escapeHtml(feedback.detail)}</pre>` : ''}
    </div>
  `;
}

function renderSetupGuidance(pipeline, actions) {
  if (!setupGuide) return;
  const summary = pipeline?.summary || null;
  const nextAction = preferredNextAction(actions || []);
  if (!summary) {
    renderSelectedSiteSetupGuidance();
    return;
  }
  if (summary.kind === 'domestic' && isFailedOrRollbackPipeline(summary)) {
    renderDomesticHistorySetupGuidance(pipeline);
    return;
  }
  const needsDomesticPlan = setupNeedsDomesticPlan(pipeline);
  const actionText = nextAction ? setupActionGuidanceText(pipeline, nextAction) : '当前没有可执行 gate。可以刷新或查看 Evidence History。';
  const runState = setupRunViewState(nextAction);
  const serviceVipHint = launcherServiceVipSetupHintForSummary(summary);
  const primaryReady = needsDomesticPlan
    ? Boolean(selectedSshProfileId()) && !state.sshPlanBusy
    : Boolean(nextAction?.allowed && !state.actionBusy && !state.setupRun.active);
  const primaryLabel = needsDomesticPlan
    ? (state.sshPlanBusy ? 'Creating' : 'Create Plan')
    : runState.buttonLabel;
  const setupTitle = needsDomesticPlan
    ? `${summary.siteId}: Create Plan`
    : runState.title || setupHeadline(summary, nextAction);
  setupGuide.innerHTML = `
    <section class="setup-guide-card" data-ready="${primaryReady ? 'true' : 'false'}">
      <div>
        <span class="site-kind">Setup Assistant</span>
        <strong>${escapeHtml(setupTitle)}</strong>
        <p>${escapeHtml(runState.message || actionText)}</p>
        ${serviceVipHint ? `
          <p class="profile-feedback" data-kind="warning">
            ${escapeHtml(serviceVipHint.displayName)} waits for Domestic relay apply: service VIP ${escapeHtml(serviceVipHint.serviceVip || '-')} / productRelayCidrs ${escapeHtml(serviceVipHint.productRelayCidrs || serviceVipHint.expectedProductRelayCidrs || '-')}.
          </p>
        ` : ''}
        ${renderSetupActionChain(pipeline, nextAction)}
        ${renderSetupRunProgress()}
        ${renderAwxSummaryPanel(setupAwxSummary(), 'setup')}
      </div>
      <div class="setup-guide-actions">
        <button class="primary-button" type="button" ${needsDomesticPlan ? 'data-setup-create-plan' : 'data-setup-continue'} ${primaryReady ? '' : 'disabled'}>
          ${escapeHtml(primaryLabel)}
        </button>
        ${state.setupRun.active ? '<button class="secondary-button" type="button" data-setup-stop>Stop</button>' : ''}
        <button class="secondary-button" type="button" data-setup-refresh>Refresh</button>
      </div>
    </section>
  `;
  const createPlanButton = setupGuide.querySelector('[data-setup-create-plan]');
  if (createPlanButton) {
    createPlanButton.addEventListener('click', () => {
      void createPlanFromSshProfile();
    });
  }
  const continueButton = setupGuide.querySelector('[data-setup-continue]');
  if (continueButton && nextAction) {
    continueButton.addEventListener('click', () => {
      void startSetupRun();
    });
  }
  const stopButton = setupGuide.querySelector('[data-setup-stop]');
  if (stopButton) {
    stopButton.addEventListener('click', () => {
      stopSetupRun('Stopped by operator.');
    });
  }
  const refreshButton = setupGuide.querySelector('[data-setup-refresh]');
  if (refreshButton) refreshButton.addEventListener('click', () => void refreshAdmin());
}

function renderDomesticHistorySetupGuidance(pipeline) {
  const summary = pipeline?.summary || {};
  const profile = inspectorSshProfile('domestic', summary.siteId);
  const canCreatePlan = Boolean(profile?.profileId || selectedSshProfileId()) && !state.sshPlanBusy;
  const recommended = recommendedPipelineForSite(summary.siteId, 'domestic');
  const canOpenRecommended = recommended?.planId && recommended.planId !== summary.planId && !isFailedOrRollbackPipeline(recommended);
  setupGuide.innerHTML = `
    <section class="setup-guide-card domestic-history-guide" data-ready="${canCreatePlan || canOpenRecommended ? 'true' : 'false'}">
      <div>
        <span class="site-kind">Setup Assistant</span>
        <strong>${escapeHtml(summary.siteId)}: start a clean Domestic WG 2.0 plan</strong>
        <p>当前选中的是 ${escapeHtml(summary.health)} / ${escapeHtml(summary.currentStage)} 历史执行，不是继续部署入口。新的 2.0 plan 会先 Materialize Domestic WG，然后通过 Remote SSH 执行 install/sync；activate 阶段保留 hdo-home/hdo-internal 和 100.* 旧网段，V1 清理由 manage.sh 显式执行。</p>
        <ol class="setup-next-chain" aria-label="Domestic setup chain">
          ${['SSH Profile', 'New 2.0 Plan', 'WG Secret', 'Preflight', 'Apply', 'Remote SSH', 'Install / Sync'].map((step, index) => `
            <li data-current="${index === 1 ? 'true' : 'false'}">${escapeHtml(step)}</li>
          `).join('')}
        </ol>
      </div>
      <div class="setup-guide-actions">
        ${canOpenRecommended ? '<button class="secondary-button" type="button" data-setup-open-recommended>Open Recommended</button>' : ''}
        <button class="primary-button" type="button" data-setup-create-plan ${canCreatePlan ? '' : 'disabled'}>${state.sshPlanBusy ? 'Creating' : 'New 2.0 Plan'}</button>
        <button class="secondary-button" type="button" data-setup-site-open-ssh>SSH Access</button>
        <button class="secondary-button" type="button" data-setup-refresh>Refresh</button>
      </div>
    </section>
  `;
  const openRecommended = setupGuide.querySelector('[data-setup-open-recommended]');
  if (openRecommended && recommended?.planId) {
    openRecommended.addEventListener('click', () => {
      state.selectedSiteId = recommended.siteId || summary.siteId;
      void refreshPipelineDetail(recommended.planId);
    });
  }
  const createPlanButton = setupGuide.querySelector('[data-setup-create-plan]');
  if (createPlanButton) {
    createPlanButton.addEventListener('click', () => {
      syncSshProfileFormToSelectedSite(summary.siteId, 'domestic');
      void createPlanFromSshProfile();
    });
  }
  const openSsh = setupGuide.querySelector('[data-setup-site-open-ssh]');
  if (openSsh) {
    openSsh.addEventListener('click', () => {
      syncSshProfileFormToSelectedSite(summary.siteId, 'domestic');
      focusSshProfileForSite({ siteId: summary.siteId, kind: 'domestic' });
    });
  }
  const refreshButton = setupGuide.querySelector('[data-setup-refresh]');
  if (refreshButton) refreshButton.addEventListener('click', () => void refreshAdmin());
}

function recommendedPipelineForSite(siteId, kind) {
  const sites = deploymentSites(state.dashboard?.siteSlotPipelines || [], kind);
  return sites.find((site) => site.siteId === siteId)?.activePipeline || null;
}

function renderSelectedSiteSetupGuidance() {
  const site = state.deploymentKind === 'oversea' ? selectedOverseaSite() : null;
  if (!site) {
    setupGuide.innerHTML = `
      <section class="setup-guide-card">
        <span class="site-kind">Setup Assistant</span>
        <strong>Select a site to continue</strong>
        <p>选择一个 Oversea 或 Domestic slot 后，这里会显示下一步建议动作。</p>
      </section>
    `;
    return;
  }
  const profile = inspectorSshProfile(site.kind || state.deploymentKind, site.siteId);
  const profileReady = Boolean(profile?.profileId && profile?.identityFile);
  const hostPeer = sameHostPeerProfile(site);
  const title = selectedSiteSetupTitle(site, profile, profileReady);
  const message = selectedSiteSetupMessage(site, profile, profileReady, hostPeer);
  const canShadowSetup = site.kind === 'oversea' && profileReady && !state.sshShadowBusy;
  setupGuide.innerHTML = `
    <section class="setup-guide-card" data-ready="${canShadowSetup ? 'true' : 'false'}">
      <div>
        <span class="site-kind">Setup Assistant</span>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(message)}</p>
      </div>
      <div class="setup-guide-actions">
        ${canShadowSetup ? `
          <button class="primary-button" type="button" data-setup-site-shadow>
            ${state.sshShadowBusy ? 'Setting up' : 'Shadow Setup'}
          </button>
          <button class="secondary-button" type="button" data-setup-site-open-ssh>Edit SSH</button>
        ` : `
          <button class="primary-button" type="button" data-setup-site-open-ssh>Open SSH Access</button>
        `}
        <button class="secondary-button" type="button" data-setup-refresh>Refresh</button>
      </div>
    </section>
  `;
  const openSsh = setupGuide.querySelector('[data-setup-site-open-ssh]');
  if (openSsh) {
    openSsh.addEventListener('click', () => {
      focusSshProfileForSite(site);
    });
  }
  const shadowSetup = setupGuide.querySelector('[data-setup-site-shadow]');
  if (shadowSetup) {
    shadowSetup.addEventListener('click', () => {
      focusSshProfileForSite(site);
      void runOverseaShadowSetupFromSshProfile();
    });
  }
  const refreshButton = setupGuide.querySelector('[data-setup-refresh]');
  if (refreshButton) refreshButton.addEventListener('click', () => void refreshAdmin());
}

function selectedSiteSetupTitle(site, profile, profileReady) {
  if (!profile?.profileId) return `${site.siteId}: Save SSH Profile`;
  if (!profileReady) return `${site.siteId}: Complete SSH Access`;
  return `${site.siteId}: Shadow Setup`;
}

function selectedSiteSetupMessage(site, profile, profileReady, hostPeer) {
  if (!profile?.profileId) {
    return '先保存 SSH Profile，Internal 才能把该 Oversea 作为独立 siteId 管理。';
  }
  if (!profileReady) {
    return hostPeer
      ? `这个 host 已有 ${hostPeer.siteId} 的 SSH 凭据，可复用路径后保存，再继续 Shadow Setup。`
      : '该 profile 缺少 Internal-managed identity file。可以 Bootstrap Key，或填入已有 key/known_hosts 后保存。';
  }
  return 'SSH 凭据已就绪，可以生成 oversea-s1 自己的 plan、runner、AWX worker job 和 evidence。';
}

function setupRunViewState(nextAction) {
  if (state.setupRun.active) {
    return {
      title: 'Setup is running',
      message: state.setupRun.message || '正在执行低风险 gate，并同步最新 pipeline 状态。',
      buttonLabel: 'Running...'
    };
  }
  if (state.setupRun.status === 'waiting-confirm') {
    return {
      title: 'Review required before continuing',
      message: state.setupRun.message || '下一步需要人工确认，已展开审计动作。',
      buttonLabel: nextAction ? recommendedButtonLabel(nextAction) : 'Review'
    };
  }
  if (state.setupRun.status === 'failed') {
    return {
      title: 'Setup stopped on an error',
      message: state.setupRun.message || '请查看下方 action feedback 或 Evidence 后继续。',
      buttonLabel: nextAction ? recommendedButtonLabel(nextAction) : 'Retry'
    };
  }
  if (state.setupRun.status === 'complete') {
    return {
      title: 'Setup step completed',
      message: state.setupRun.message || '当前步骤已完成，Evidence 已同步。',
      buttonLabel: nextAction ? recommendedButtonLabel(nextAction) : 'Done'
    };
  }
  if (state.setupRun.status === 'waiting' || state.setupRun.status === 'blocked') {
    return {
      title: 'Ready for operator review',
      message: state.setupRun.message || '流水线已停在下一道 gate。',
      buttonLabel: nextAction ? recommendedButtonLabel(nextAction) : 'Review'
    };
  }
  return {
    title: '',
    message: '',
    buttonLabel: nextAction ? recommendedButtonLabel(nextAction) : 'No Action'
  };
}

function renderSetupRunProgress() {
  const steps = asArray(state.setupRun.steps).slice(-4);
  if (!steps.length && state.setupRun.status === 'idle') return '';
  const items = steps.map((step) => `
    <li data-status="${escapeHtml(step.status)}">
      <span>${escapeHtml(step.status)}</span>
      <strong>${escapeHtml(step.label)}</strong>
      <small>${escapeHtml(step.message || '')}</small>
    </li>
  `).join('');
  return `
    <ol class="setup-run-progress" data-status="${escapeHtml(state.setupRun.status)}">
      ${items || `<li data-status="${escapeHtml(state.setupRun.status)}"><span>${escapeHtml(state.setupRun.status)}</span><strong>${escapeHtml(state.setupRun.message || 'Waiting')}</strong><small></small></li>`}
    </ol>
  `;
}

function setupAwxSummary() {
  if (state.actionFeedback?.planId === state.selectedPlanId && state.actionFeedback.awxSummary) {
    return state.actionFeedback.awxSummary;
  }
  return latestAwxSummaryFromPipeline(state.currentPipeline);
}

function renderDashboardGuidance() {
  if (!dashboardGuidance) return;
  const dashboard = state.dashboard;
  if (!dashboard) {
    dashboardGuidance.innerHTML = `
      <section class="setup-guide-card">
        <span class="site-kind">Dashboard</span>
        <strong>Waiting for Internal</strong>
        <p>连接 18090 后，Dashboard 会汇总 Oversea、Domestic、Internal 和 Evidence 状态。</p>
      </section>
    `;
    return;
  }
  const oversea = deploymentSites(dashboard.siteSlotPipelines || [], 'oversea')[0]?.activePipeline || null;
  const domestic = deploymentSites(dashboard.siteSlotPipelines || [], 'domestic')[0]?.activePipeline || null;
  const overseaAction = preferredNextAction(asArray(oversea?.actionHints));
  const domesticAction = preferredNextAction(asArray(domestic?.actionHints));
  dashboardGuidance.innerHTML = `
    <section class="setup-guide-card dashboard-guide">
      <div>
        <span class="site-kind">Dashboard</span>
        <strong>Choose a lane, then press Continue Setup</strong>
        <p>Oversea 负责接入栈，Domestic 负责 WG relay。每条 lane 都会提示下一步 gate。</p>
      </div>
      <div class="dashboard-lanes">
        ${renderDashboardLane('oversea', oversea, overseaAction)}
        ${renderDashboardLane('domestic', domestic, domesticAction)}
      </div>
    </section>
    ${renderLauncherFoundationCard()}
  `;
  for (const button of dashboardGuidance.querySelectorAll('[data-dashboard-lane]')) {
    button.addEventListener('click', () => {
      state.adminSection = 'deployment';
      state.deploymentKind = button.dataset.dashboardLane === 'domestic' ? 'domestic' : 'oversea';
      const active = activePipelineForCurrentDeployment(state.dashboard?.siteSlotPipelines || []);
      state.selectedPlanId = active?.planId || null;
      state.selectedSiteId = active?.siteId || state.selectedSiteId;
      renderAdminShell();
      renderAdminDashboard(state.dashboard);
      if (state.selectedPlanId) void refreshPipelineDetail(state.selectedPlanId);
    });
  }
}

function renderDashboardLane(kind, pipeline, action) {
  const label = kind === 'domestic' ? 'Domestic' : 'Oversea';
  return `
    <button class="dashboard-lane" type="button" data-dashboard-lane="${escapeHtml(kind)}">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(pipeline?.siteId || `${kind}-main`)}</span>
      <small>${escapeHtml(action?.label || pipeline?.latestStatus || 'open lane')}</small>
    </button>
  `;
}

async function runRecommendedAction(action) {
  if (!action?.allowed || state.actionBusy) return;
  selectPipelineAction(action);
  state.actionFeedback = null;
  renderSetupGuidance(state.currentPipeline, state.currentActions);
  renderPipelineActions(state.currentActions);
  renderInspector();
  const requiresConfirm = asArray(action.confirmFields).length > 0 || action.risk === 'high';
  if (requiresConfirm) {
    pipelineActions.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  await executeSelectedAction();
}

async function startSetupRun() {
  if (state.setupRun.active || state.actionBusy) return;
  state.setupRun = {
    active: true,
    status: 'running',
    message: 'Starting setup flow...',
    steps: []
  };
  await continueSetupRun();
}

function stopSetupRun(message, status = 'stopped') {
  setupMonitorToken += 1;
  state.setupRun.active = false;
  state.setupRun.status = status;
  state.setupRun.message = message;
  renderSetupGuidance(state.currentPipeline, state.currentActions);
  renderPipelineActions(state.currentActions);
  renderInspector();
}

function clearSetupRun(message = '', status = 'idle') {
  setupMonitorToken += 1;
  state.setupRun = {
    active: false,
    status,
    message,
    steps: []
  };
}

async function monitorPipelineProgress({ planId, reason, maxTicks = 12, intervalMs = 2500 }) {
  if (!planId) return;
  const token = ++setupMonitorToken;
  state.setupRun = {
    active: true,
    status: 'monitoring',
    message: reason || 'Monitoring worker progress...',
    steps: asArray(state.setupRun.steps)
  };
  pushSetupRunStep({ actionId: 'pipeline.monitor', path: planId, label: 'Monitor Pipeline' }, 'running', state.setupRun.message);
  renderSetupGuidance(state.currentPipeline, state.currentActions);
  renderPipelineActions(state.currentActions);
  renderInspector();

  for (let tick = 0; tick < maxTicks; tick += 1) {
    if (token !== setupMonitorToken) return;
    await delay(tick === 0 ? 900 : intervalMs);
    if (token !== setupMonitorToken) return;
    const pipeline = await refreshPipelineDetail(planId);
    if (!pipeline) {
      finishSetupMonitor(token, 'failed', 'Failed to refresh pipeline status.');
      return;
    }
    const observation = setupPipelineObservation(pipeline);
    state.setupRun.message = observation.message;
    replaceLatestSetupRunStep('pipeline.monitor', observation.stepStatus, observation.message);
    renderSetupGuidance(state.currentPipeline, state.currentActions);
    if (observation.done) {
      finishSetupMonitor(token, observation.status, observation.message);
      return;
    }
  }
  finishSetupMonitor(token, 'waiting', 'Still waiting for worker/AWX result. Refresh to continue watching.');
}

function finishSetupMonitor(token, status, message) {
  if (token !== setupMonitorToken) return;
  state.setupRun.active = false;
  state.setupRun.status = status;
  state.setupRun.message = message;
  renderSetupGuidance(state.currentPipeline, state.currentActions);
  renderPipelineActions(state.currentActions);
  renderInspector();
}

function setupPipelineObservation(pipeline) {
  const summary = pipeline?.summary || {};
  const health = normalizeStageStatus(summary.health || summary.latestStatus);
  const running = pipelineHasRunningWork(pipeline);
  const nextAction = preferredNextAction(asArray(summary.actionHints));
  if (health === 'failed') {
    const failure = pipelineFailureSummaryObject(summary);
    return {
      done: true,
      status: 'failed',
      stepStatus: 'failed',
      message: failure
        ? `${summary.siteId || 'slot'} failed at ${failure.stepId || failure.phase || summary.currentStage || 'pipeline'}: ${failure.message || 'worker step failed'}`
        : `${summary.siteId || 'slot'} failed at ${summary.currentStage || 'pipeline'}.`
    };
  }
  if (health === 'blocked') {
    return {
      done: true,
      status: 'waiting-confirm',
      stepStatus: 'waiting',
      message: nextAction ? `${nextAction.label} is waiting for approval or operator input.` : 'Pipeline is blocked by a gate.'
    };
  }
  if (running) {
    return {
      done: false,
      status: 'monitoring',
      stepStatus: 'running',
      message: `${summary.currentStage || 'worker'} is ${summary.latestStatus || 'running'}...`
    };
  }
  if (health === 'passed') {
    return {
      done: true,
      status: 'complete',
      stepStatus: 'passed',
      message: `${summary.siteId || 'slot'} completed with evidence recorded.`
    };
  }
  return {
    done: true,
    status: 'waiting',
    stepStatus: 'waiting',
    message: nextAction ? `Ready for next gate: ${nextAction.label}.` : 'Pipeline is waiting for the next operator action.'
  };
}

function pipelineHasRunningWork(pipeline) {
  const runningStatuses = new Set(['queued', 'running']);
  return asArray(pipeline?.runnerSessions).some((session) => runningStatuses.has(session.status))
    || asArray(pipeline?.workerJobs).some((job) => runningStatuses.has(job.status))
    || asArray(pipeline?.workerReports).some((report) => runningStatuses.has(report.status))
    || runningStatuses.has(pipeline?.summary?.latestStatus);
}

function postActionMonitorReason(action, payload) {
  const awxLaunch = payload?.awxLaunch;
  if (awxLaunch) {
    const awxId = awxLaunch.awxJobId ? ` #${awxLaunch.awxJobId}` : '';
    return `Monitoring AWX job${awxId}: ${awxLaunch.awxJobStatus || awxLaunch.status || 'submitted'}.`;
  }
  const report = payload?.report;
  if (report?.status === 'running') return `Monitoring worker report ${report.reportId || ''}.`;
  const session = payload?.session;
  if (session && ['queued', 'running'].includes(session.status)) return `Monitoring ${session.mode || 'runner'} session.`;
  const job = payload?.job;
  if (job && ['ready', 'running'].includes(job.status)) return `Worker job ${job.jobId || ''} is ready for execution.`;
  if (String(action?.actionId || '').includes('awx')) return 'Monitoring AWX worker progress.';
  return '';
}

async function continueSetupRun() {
  const maxSteps = 8;
  const seen = new Set();
  for (let stepIndex = 0; stepIndex < maxSteps && state.setupRun.active; stepIndex += 1) {
    const action = preferredNextAction(state.currentActions);
    if (!action) {
      stopSetupRun('No remaining action gates for this slot.', 'complete');
      return;
    }
    if (!action.allowed) {
      stopSetupRun(action.reason || 'Next action is locked by policy.', 'blocked');
      return;
    }

    selectPipelineAction(action);
    const manualReason = setupManualStopReason(action);
    if (manualReason) {
      state.setupRun.active = false;
      state.setupRun.status = 'waiting-confirm';
      state.setupRun.message = manualReason;
      pushSetupRunStep(action, 'waiting', manualReason);
      renderSetupGuidance(state.currentPipeline, state.currentActions);
      renderPipelineActions(state.currentActions);
      renderInspector();
      pipelineActions.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const key = setupActionKey(action);
    if (seen.has(key)) {
      stopSetupRun('Pipeline state did not advance after refresh. Review evidence or retry after the worker reports back.', 'waiting');
      return;
    }
    seen.add(key);
    pushSetupRunStep(action, 'running', 'Executing low-risk gate.');
    state.setupRun.message = `${action.label} is running...`;
    renderSetupGuidance(state.currentPipeline, state.currentActions);
    renderPipelineActions(state.currentActions);
    renderInspector();

    const result = await executeSelectedAction({ openEvidence: false, monitor: false });
    if (!result?.ok) {
      pushSetupRunStep(action, 'failed', result?.error?.message || 'Action failed.');
      stopSetupRun(result?.error?.message || 'Action failed.', 'failed');
      return;
    }
    const blockedMessage = setupActionBlockedMessage(result.payload || {});
    if (blockedMessage) {
      pushSetupRunStep(action, 'blocked', blockedMessage);
      stopSetupRun(blockedMessage, 'blocked');
      return;
    }
    pushSetupRunStep(action, 'passed', summarizeActionPayload(action, result.payload || {}));
    state.setupRun.message = 'Refreshing pipeline state...';
    renderSetupGuidance(state.currentPipeline, state.currentActions);
    await delay(650);
  }
  if (state.setupRun.active) {
    stopSetupRun('Paused after several automatic steps. Review the latest gate before continuing.', 'waiting');
  }
}

function setupManualStopReason(action) {
  if (asArray(action.confirmFields).length > 0 || action.risk === 'high') {
    return `${action.label} requires approval before it can change remote state.`;
  }
  const body = formatJson(materializeActionBodyTemplate(action));
  if (!isActionBodyExecutable(body)) {
    return `${action.label} needs operator input before execution.`;
  }
  return '';
}

function setupActionBlockedMessage(payload) {
  if (payload?.workerExecution?.status === 'failed') {
    return payload.workerExecution.stderr
      ? `Remote SSH worker failed: ${String(payload.workerExecution.stderr).slice(0, 600)}`
      : 'Remote SSH worker failed. Review worker report evidence before retrying.';
  }
  const gateFailures = asArray(payload?.gate?.gateFailures);
  if (payload?.gate?.verdict === 'blocked') {
    return gateFailures.length
      ? `Remote SSH Gate blocked: ${gateFailures.join('; ')}`
      : 'Remote SSH Gate blocked. Review gate evidence before continuing.';
  }
  const blockedResult = [
    payload?.readOnlyProbe,
    payload?.workerHandoff,
    payload?.remoteSshPlan,
    payload?.fakeTransport,
    payload?.domesticWgMaterialize,
    payload?.relayReadOnlyProbe,
    payload?.relayPeerPlan,
    payload?.relayPeerAppend,
    payload?.relayPeerAppendSsh,
    payload?.awxCredentialSync,
    payload?.awxObjectSync,
    payload?.awxLaunch
  ].find((item) => item?.status === 'blocked');
  if (!blockedResult) return '';
  const reasons = asArray(blockedResult.blockedReasons);
  return reasons.length
    ? `Action blocked: ${reasons.join('; ')}`
    : 'Action blocked. Review action evidence before continuing.';
}

function pushSetupRunStep(action, status, message) {
  const existing = asArray(state.setupRun.steps);
  state.setupRun.steps = [
    ...existing,
    {
      id: `${setupActionKey(action)}:${Date.now()}`,
      actionId: action.actionId,
      label: action.label || action.actionId,
      status,
      message
    }
  ].slice(-8);
}

function replaceLatestSetupRunStep(actionId, status, message) {
  const steps = asArray(state.setupRun.steps);
  const index = steps.map((step) => step.actionId).lastIndexOf(actionId);
  if (index < 0) {
    state.setupRun.steps = [
      ...steps,
      {
        id: `${actionId}:${Date.now()}`,
        actionId,
        label: actionId,
        status,
        message
      }
    ].slice(-8);
    return;
  }
  state.setupRun.steps = steps.map((step, stepIndex) => stepIndex === index
    ? { ...step, status, message }
    : step);
}

function setupActionKey(action) {
  return `${action?.actionId || 'action'} ${action?.path || ''}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setupHeadline(summary, action) {
  if (!action) return `${summary.siteId} is waiting`;
  return `${summary.siteId}: ${action.label}`;
}

function recommendedButtonLabel(action) {
  const needsReview = asArray(action.confirmFields).length > 0 || action.risk === 'high';
  return needsReview ? 'Review & Continue' : 'Run Setup';
}

function actionGuidanceText(action) {
  const map = {
    'site-slot.preflight.create': '先做 preflight：只创建检查执行，不会改远端主机。',
    'site-slot.apply.confirm': '确认 apply manifest：这是进入部署/runner 前的审批点。',
    'site-slot.runner.awx-shadow': '高级备用：创建 AWX shadow runner session。',
    'site-slot.runner.remote-ssh': '创建 Remote SSH runner session，由 Internal 直接把 slot artifact 和配置下发到远端。',
    'site-slot.runner.simulate': '创建模拟 runner session，用于本机 shadow 验证。',
    'site-slot.worker-job.create': '创建 worker job。Oversea 和 Domestic 默认走 Internal Remote SSH handoff。',
    'site-slot.worker-run.awx-sync-plan': '生成 AWX 对象计划，先预览 inventory、credential、job template 名称。',
    'site-slot.worker-run.awx-credential-sync': '把当前 SSH Profile 写成 AWX Machine Credential，需要确认和 API token。',
    'site-slot.worker-run.awx-object-sync': '在 AWX 中创建/更新 organization、project、inventory、host 和 job template。',
    'site-slot.worker-run.awx-launch': '提交 AWX job，真正执行 Ansible 并把结果回写成 worker report。',
    'site-slot.worker-run.remote-ssh-gate': '先检查 Remote SSH 执行边界和 SSH Profile，不会改远端主机。',
    'site-slot.worker-run.remote-ssh-readonly-probe': '通过 SSH 做只读探测，收集 OS、Docker、磁盘和访问栈状态证据。',
    'site-slot.worker-run.remote-ssh-execute': '通过 Remote SSH 执行 Internal-controlled artifact push：Domestic 按订阅出网、Docker、服务、peer center 顺序部署；Oversea 同步 Docker hysteria2。',
    'site-slot.worker-run.artifact-push-remote-ssh-plan': '生成 Remote SSH artifact push 计划报告，便于审计下发内容。',
    'site-slot.domestic-wg.materialize': 'Internal 生成或复用 Domestic WG secret，并重新 materialize ready artifact。换公网 IP 只更新 endpoint；换整机时显式设置 rotateRelayKey=true 和 confirmRotate=true。',
    'site-slot.domestic-relay-peer-append-awx.prepare': '高级备用：为 Domestic relay peer append 准备 AWX worker job。',
    'site-slot.domestic-relay-peer-append-ssh.prepare': '准备 Domestic Remote SSH worker job；需要先绑定 SSH Profile。',
    'site-slot.worker-run.domestic-relay-readonly-probe': '先只读检查 Domestic WG relay 状态。',
    'site-slot.worker-run.domestic-relay-peer-append': '生成 Home peer append handoff，确认 lease/public key 和安全边界。'
  };
  return map[action.actionId] || `${action.gate || 'gate'} / ${action.reason || 'review next action'}`;
}

function setupActionGuidanceText(pipeline, action) {
  if (!action) return '';
  const summary = pipeline?.summary || {};
  if (summary.kind !== 'domestic') return actionGuidanceText(action);
  const plan = pipeline?.plan || {};
  const profile = inspectorSshProfile('domestic', summary.siteId);
  const planProfileId = plan.ssh?.profileId || '';
  const activeProfileId = profile?.profileId || '';
  const profileMatchesPlan = Boolean(planProfileId && (!activeProfileId || planProfileId === activeProfileId));
  if (plan.network?.mode === 'offline-manual') {
    const bootstrap = domesticBootstrapOverseaSite();
    return bootstrap
      ? `当前 plan 是 offline-manual，缺少 Oversea bootstrap。已发现可用 ${bootstrap.siteId}，请重新 Create Plan 生成 oversea-assisted Domestic plan。`
      : '当前 Domestic 无公网出站且没有可用 Oversea bootstrap slot。先安装/同步一个 Oversea，再回来重新 Create Plan。';
  }
  if (!planProfileId) {
    return '当前 Domestic plan 还没有绑定 SSH Profile。先在 SSH Access 保存 profile 后点击 Create Plan，再从 Preflight / Apply 进入 Remote SSH。';
  }
  if (!profileMatchesPlan) {
    return `当前 plan 绑定的是 ${planProfileId}，表单选中的是 ${activeProfileId || '未选择'}。如要使用新 SSH，请先点击 Create Plan 生成新的 Domestic plan。`;
  }
  if (action.actionId === 'site-slot.runner.remote-ssh') {
    return `当前 plan 已绑定 ${planProfileId}，不需要再次 Create Plan。Review & Continue 会创建 Remote SSH runner，之后继续 Create Worker Job、SSH Gate、Readonly Probe 和 Domestic install/sync。`;
  }
  if (action.actionId === 'site-slot.domestic-relay-peer-append-ssh.prepare') {
    return `当前 plan 已绑定 ${planProfileId}。Review & Continue 会创建 Domestic Remote SSH worker job，之后执行 SSH Gate、Readonly Probe，再进行 WG relay / H2I / DNS 远端同步。`;
  }
  if (action.actionId === 'site-slot.worker-job.create') {
    return '下一步会把 Remote SSH runner 变成 Domestic worker job；随后进入 SSH Gate、Readonly Probe 和远端同步。';
  }
  if (action.actionId === 'site-slot.domestic-wg.materialize') {
    return '下一步在 Internal 生成/复用 WG relay secret，并把 wireguard-config materialize 成 ready artifact；不会修改 Domestic 主机。';
  }
  if (action.actionId === 'site-slot.worker-run.remote-ssh-gate') {
    return '下一步只检查 SSH Profile、远端执行边界和 artifact gate，不会修改 Domestic 主机。通过后再做 Readonly Probe。';
  }
  if (action.actionId === 'site-slot.worker-run.remote-ssh-readonly-probe') {
    return '下一步只读探测 Domestic 主机的 OS、Docker、WG 和服务状态；通过后再执行远端安装/同步。';
  }
  if (action.actionId === 'site-slot.worker-run.remote-ssh-execute') {
    return '下一步会通过 Internal Remote SSH 下发 Domestic artifact，按 Oversea 订阅出网、Docker runtime、Docker services、WG/H2I peer center 的顺序执行远端部署。';
  }
  return actionGuidanceText(action);
}

function setupNeedsDomesticPlan(pipeline) {
  const summary = pipeline?.summary || {};
  if (summary.kind !== 'domestic') return false;
  const plan = pipeline?.plan || {};
  const profile = inspectorSshProfile('domestic', summary.siteId);
  const activeProfileId = profile?.profileId || selectedSshProfileId();
  const planProfileId = plan.ssh?.profileId || '';
  if (!activeProfileId) return false;
  return !planProfileId || planProfileId !== activeProfileId || (plan.network?.mode === 'offline-manual' && Boolean(domesticBootstrapOverseaSite()));
}

function renderSetupActionChain(pipeline, action) {
  const summary = pipeline?.summary || {};
  if (summary.kind !== 'domestic' || !action) return '';
  const plan = pipeline?.plan || {};
  const profile = inspectorSshProfile('domestic', summary.siteId);
  const planProfileId = plan.ssh?.profileId || '';
  const activeProfileId = profile?.profileId || '';
  const needsPlan = !planProfileId
    || (activeProfileId && planProfileId !== activeProfileId)
    || (plan.network?.mode === 'offline-manual' && Boolean(domesticBootstrapOverseaSite()));
  const steps = needsPlan
    ? ['Save SSH', 'Create Plan', 'Preflight', 'Apply', 'WG Secret', 'Remote SSH', 'Install / Sync']
    : ['Plan bound', 'WG Secret', 'Preflight', 'Apply', 'Remote SSH Runner', 'Worker Job', 'SSH Gate', 'Readonly Probe', 'Install / Sync'];
  const current = needsPlan
    ? 'Create Plan'
    : setupChainCurrentStep(action.actionId);
  return `
    <ol class="setup-next-chain" aria-label="Domestic setup chain">
      ${steps.map((step) => `
        <li data-current="${step === current ? 'true' : 'false'}">${escapeHtml(step)}</li>
      `).join('')}
    </ol>
  `;
}

function setupChainCurrentStep(actionId) {
  if (actionId === 'site-slot.domestic-wg.materialize') return 'WG Secret';
  if (actionId === 'site-slot.preflight.create') return 'Preflight';
  if (actionId === 'site-slot.apply.confirm') return 'Apply';
  if (actionId === 'site-slot.runner.remote-ssh') return 'Remote SSH Runner';
  if (actionId === 'site-slot.worker-job.create' || actionId === 'site-slot.domestic-relay-peer-append-ssh.prepare') return 'Worker Job';
  if (actionId === 'site-slot.worker-run.remote-ssh-gate') return 'SSH Gate';
  if (actionId === 'site-slot.worker-run.remote-ssh-readonly-probe') return 'Readonly Probe';
  if (actionId === 'site-slot.worker-run.remote-ssh-execute' || actionId === 'site-slot.worker-run.domestic-relay-peer-append-ssh') return 'Install / Sync';
  return '';
}

function preferredNextAction(actions) {
  const preferred = actionFromFocus(actions, state.preferredActionFocus);
  return preferred || defaultPreferredAction(actions) || actions.find((action) => action.allowed) || actions[0];
}

function defaultPreferredAction(actions) {
  const candidates = asArray(actions).filter((action) => action.allowed);
  const priority = [
    'site-slot.domestic-wg.materialize',
    'site-slot.preflight.create',
    'site-slot.apply.confirm',
    'site-slot.runner.remote-ssh',
    'site-slot.runner.simulate',
    'site-slot.worker-job.create',
    'site-slot.worker-run.remote-ssh-gate',
    'site-slot.worker-run.remote-ssh-readonly-probe',
    'site-slot.worker-run.remote-ssh-execute',
    'site-slot.worker-run.artifact-push-remote-ssh-plan',
    'site-slot.domestic-relay-peer-append-ssh.prepare',
    'site-slot.worker-run.domestic-relay-readonly-probe'
  ];
  for (const actionId of priority) {
    const action = candidates.find((item) => item.actionId === actionId);
    if (action) return action;
  }
  return null;
}

function actionFromFocus(actions, focus) {
  if (!focus) return null;
  const candidates = asArray(actions).filter((action) => action.allowed);
  if (focus.jobId) {
    const pathNeedle = `/worker-jobs/${focus.jobId}/`;
    const byJob = candidates.filter((action) => String(action.path || '').includes(pathNeedle));
    for (const actionId of asArray(focus.actionIds)) {
      const action = byJob.find((item) => item.actionId === actionId);
      if (action) return action;
    }
    return byJob[0] || null;
  }
  if (focus.actionId) return candidates.find((action) => action.actionId === focus.actionId) || null;
  return null;
}

function renderNextGate(action) {
  if (!action) return '';
  return `
    <section class="next-gate" data-allowed="${action.allowed ? 'true' : 'false'}">
      <div>
        <span>Next Gate</span>
        <strong>${escapeHtml(action.label)}</strong>
        <small>${escapeHtml(action.gate)} / ${escapeHtml(action.reason)}</small>
      </div>
      <button class="secondary-button" type="button" data-action-next ${action.allowed ? '' : 'disabled'}>Continue</button>
    </section>
  `;
}

function selectPipelineAction(action) {
  const body = materializeActionBodyTemplate(action);
  state.selectedAction = action;
  state.selectedActionBody = formatJson(body);
  prepareAwxActionDraft(action, body);
}

function renderActionConfirm(action) {
  const body = state.selectedAction && sameAction(state.selectedAction, action) && state.selectedActionBody
    ? state.selectedActionBody
    : formatJson(materializeActionBodyTemplate(action));
  const bodyObject = parseActionBodyObject(body);
  if (bodyObject) {
    syncDomesticPeerDraftFromObject(bodyObject);
    prepareAwxActionDraft(action, bodyObject);
  }
  return `
    <section class="action-confirm" aria-label="Action confirmation">
      <div class="action-confirm-head">
        <div>
          <h4>${escapeHtml(action.label)}</h4>
          <span>${escapeHtml(action.gate)} / ${escapeHtml(action.risk)}</span>
        </div>
        <span class="risk-chip" data-risk="${escapeHtml(action.risk)}">${escapeHtml(action.risk)}</span>
      </div>
      ${action.confirmFields && action.confirmFields.length ? `
        <div class="confirm-fields">
          ${action.confirmFields.map((field) => {
            const checked = bodyObject && bodyObject[field] === true;
            return `
            <label>
              <input type="checkbox" data-confirm-field="${escapeHtml(field)}" ${checked ? 'checked' : ''} />
              <span>${escapeHtml(field)}</span>
            </label>
          `;
          }).join('')}
        </div>
      ` : ''}
      ${renderHomePeerQuickFields(body)}
      ${renderAwxActionQuickFields(body, action)}
      <label class="action-body-editor">
        <span>Action Body</span>
        <textarea class="action-body" data-action-body spellcheck="false">${escapeHtml(body)}</textarea>
        <small>Replace angle-bracket placeholders before executing.</small>
      </label>
      <div class="action-controls">
        <button class="secondary-button" type="button" data-action-cancel>Cancel</button>
        <button class="primary-button" type="button" data-action-execute>${state.actionBusy ? 'Running' : 'Execute'}</button>
      </div>
    </section>
  `;
}

async function executeSelectedAction(options = {}) {
  const action = state.selectedAction;
  if (state.actionBusy) return { ok: false, error: new Error('Another action is already running. Wait for the current gate to finish.') };
  if (!action) return { ok: false, error: new Error('Select an allowed action before executing.') };
  if (!action.allowed) return { ok: false, error: new Error(action.reason || `${action.label} is locked by policy.`) };
  const resumeSetupAfterSuccess = state.setupRun.status === 'waiting-confirm';
  state.actionBusy = true;
  renderPipelineActions(state.currentActions);
  renderInspector();
  try {
    const payload = await fetchJson('/internal/v1/admin/actions/execute', {
      method: 'POST',
      body: {
        actionId: action.actionId,
        path: action.path,
        body: actionBodyForExecution(action)
      }
    });
    syncDomesticPeerDraftFromPayload(payload);
    state.preferredActionFocus = nextActionFocusFromResult(action, payload);
    state.actionFeedback = {
      planId: state.selectedPlanId,
      kind: 'success',
      message: summarizeActionPayload(action, payload),
      detail: summarizeActionDetail(payload),
      awxSummary: awxSummaryFromPayload(payload)
    };
    state.pendingEvidenceFocus = options.openEvidence === false ? null : evidenceFocusFromActionPayload(payload, state.selectedPlanId);
    if (state.pendingEvidenceFocus?.planId) state.selectedPlanId = state.pendingEvidenceFocus.planId;
    state.selectedAction = null;
    state.selectedActionBody = null;
    await refreshAdmin();
    if (resumeSetupAfterSuccess && options.resumeSetup !== false) {
      state.setupRun = {
        active: true,
        status: 'running',
        message: 'Approval recorded. Continuing setup...',
        steps: asArray(state.setupRun.steps)
      };
      window.setTimeout(() => {
        void continueSetupRun();
      }, 0);
      return { ok: true, payload };
    }
    const monitorReason = options.monitor === false ? '' : postActionMonitorReason(action, payload);
    if (monitorReason) {
      void monitorPipelineProgress({
        planId: state.selectedPlanId,
        reason: monitorReason
      });
    }
    return { ok: true, payload };
  } catch (error) {
    state.pendingEvidenceFocus = null;
    state.actionFeedback = {
      planId: state.selectedPlanId,
      kind: 'error',
      message: error.message,
      detail: null
    };
    renderPipelineActions(state.currentActions);
    renderInspector();
    return { ok: false, error };
  } finally {
    state.actionBusy = false;
    renderSetupGuidance(state.currentPipeline, state.currentActions);
    renderPipelineActions(state.currentActions);
    renderInspector();
  }
}

function materializeActionBodyTemplate(action, overrides = {}) {
  const now = new Date();
  const changeWindowStart = now.toISOString();
  const changeWindowEnd = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const requestId = `desktop-${String(action?.actionId || 'admin-action').replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
  const homePeer = runtimeDomesticPeerDraft();
  const body = replaceActionTemplateValue(action?.bodyTemplate || {}, {
    '<change-window-start-iso>': changeWindowStart,
    '<change-window-end-iso>': changeWindowEnd,
    '<internal-base-url>': workerInternalBaseUrl(),
    '<worker-internal-base-url>': workerInternalBaseUrl(),
    '<oversea-callback-base-url>': overseaCallbackBaseUrlFromForm() || '',
    '<product-id>': homePeer.productId || MX_H2I_PRODUCT_ID,
    '<launcher-network-lease-id>': homePeer.leaseId || '<launcher-network-lease-id>',
    '<home-lease-ip>': homePeer.leaseIp || '<home-lease-ip>',
    '<home-wg-public-key>': homePeer.publicKey || '<home-wg-public-key>',
    '<request-id>': requestId
  });
  return awxActionBodyDefaults(action, normalizeActionBodyTemplate(action, { ...body, ...overrides }));
}

function normalizeActionBodyTemplate(action, body) {
  if (action?.actionId !== 'site-slot.domestic-wg.materialize' || !body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  const normalized = { ...body };
  if (normalized.internalDirectEnabled !== true && isAngleBracketPlaceholder(normalized.internalDirectEndpoint)) {
    delete normalized.internalDirectEndpoint;
  }
  return normalized;
}

function replaceActionTemplateValue(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => replaceActionTemplateValue(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceActionTemplateValue(item, replacements)]));
  }
  if (typeof value !== 'string') return value;
  return Object.prototype.hasOwnProperty.call(replacements, value) ? replacements[value] : value;
}

function isAngleBracketPlaceholder(value) {
  return typeof value === 'string' && /<[^>]+>/.test(value);
}

function actionBodyForExecution(action) {
  const text = state.selectedAction && sameAction(state.selectedAction, action) && state.selectedActionBody
    ? state.selectedActionBody
    : formatJson(materializeActionBodyTemplate(action));
  if (!isActionBodyExecutable(text)) {
    if (!text.trim()) throw new Error('Action body is empty.');
    if (hasUnresolvedActionPlaceholder(text)) {
      throw new Error('Action body still contains angle-bracket placeholders. Fill the quick fields before executing.');
    }
    throw new Error('Action body JSON is invalid.');
  }
  const body = JSON.parse(text);
  if (action?.actionId === 'site-slot.worker-run.remote-ssh-execute') {
    body.executeWorkerHandoff = true;
  }
  syncDomesticPeerDraftFromObject(body);
  return awxActionBodyForExecution(action, body);
}

function isActionBodyExecutable(text) {
  if (!text.trim()) return false;
  if (hasUnresolvedActionPlaceholder(text)) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function hasUnresolvedActionPlaceholder(text) {
  return /<[^>\n]+>/.test(text);
}

function launcherLeaseById(leaseId) {
  return asArray(state.launcherLeases).find((lease) => lease?.leaseId === leaseId) || null;
}

function launcherLeaseRole(lease) {
  if (lease?.identityKind === 'user') return 'user';
  if (lease?.identityKind === 'anonymous') return 'guest';
  return inferDomesticPeerRole(lease?.leaseIp) || 'guest';
}

function launcherLeaseLabel(lease) {
  const identity = lease.identityKind === 'user' ? 'user' : 'anonymous';
  const product = launcherProductDisplayName(lease.productId || MX_H2I_PRODUCT_ID, launcherProductById(lease.productId));
  const device = lease.deviceLabel || lease.deviceId || lease.installId || lease.leaseId;
  const mode = lease.launcherMode ? ` / ${lease.launcherMode}` : '';
  return `${product} ${identity} / ${lease.leaseIp}${mode} / ${device}`;
}

function launcherLeaseIsStandalone(lease) {
  if (!lease) return false;
  if (lease.launcherMode === 'standalone') return true;
  if (lease.launcherMode === 'embed') return false;
  const product = launcherProductById(lease.productId);
  return lease.productId === MX_H2I_PRODUCT_ID || product?.mode === 'standalone';
}

function leaseLooksGeneratedBySmoke(lease) {
  const values = [
    lease?.installId,
    lease?.deviceId,
    lease?.deviceLabel,
    lease?.createdBy,
    lease?.updatedBy,
    lease?.leaseKey
  ].map((value) => String(value || '').toLowerCase());
  return values.some((value) => value.startsWith('dev_')
    || value.startsWith('desktop-admin')
    || value.includes('desktop-admin')
    || value.includes('http-smoke')
    || value.includes('smoke'));
}

function launcherLeaseIsRuntimeClient(lease) {
  return launcherLeaseIsStandalone(lease)
    && lease?.leaseId
    && lease?.leaseIp
    && lease?.publicKey
    && lease?.status === 'active'
    && !leaseLooksGeneratedBySmoke(lease);
}

function selectableLauncherLeases() {
  return asArray(state.launcherLeases)
    .filter((lease) => launcherLeaseIsRuntimeClient(lease))
    .sort((left, right) => launcherLeaseLabel(left).localeCompare(launcherLeaseLabel(right)));
}

function knownGeneratedLeaseByIp(leaseIp) {
  if (!leaseIp) return null;
  return asArray(state.launcherLeases).find((lease) => lease?.leaseIp === leaseIp && leaseLooksGeneratedBySmoke(lease)) || null;
}

function cleanHomePeerTextValue(value) {
  const text = String(value || '').trim();
  return text && !hasUnresolvedActionPlaceholder(text) ? text : '';
}

function cleanHomePeerLeaseIp(value) {
  const leaseIp = cleanHomePeerTextValue(value);
  if (!leaseIp || knownGeneratedLeaseByIp(leaseIp)) return '';
  return leaseIp;
}

function peerRoleLabel(role, secondOctet) {
  const octet = normalizeProductSecondOctet(secondOctet);
  return role === 'user'
    ? `account login / 10.${octet}.0.1+`
    : `anonymous / 10.${octet}.100.1+`;
}

function runtimeDomesticPeerDraft() {
  const lease = launcherLeaseById(state.domesticPeerDraft.leaseId);
  if (launcherLeaseIsRuntimeClient(lease)) {
    const productId = normalizeStandaloneProductId(lease.productId || state.domesticPeerDraft.productId || MX_H2I_PRODUCT_ID);
    const product = launcherProductNetwork(productId);
    const productSecondOctet = productSecondOctetFromIp(lease.leaseIp)
      || productSecondOctetFromProduct(product)
      || state.domesticPeerDraft.productSecondOctet
      || defaultProductSecondOctet(productId, product?.mode);
    return {
      lease,
      leaseId: lease.leaseId || '',
      leaseIp: lease.leaseIp || '',
      publicKey: lease.publicKey || '',
      peerRole: launcherLeaseRole(lease),
      productId,
      productSecondOctet
    };
  }
  const leaseIp = cleanHomePeerLeaseIp(state.domesticPeerDraft.leaseIp);
  const productId = normalizeStandaloneProductId(state.domesticPeerDraft.productId || MX_H2I_PRODUCT_ID);
  const product = launcherProductNetwork(productId);
  const peerRole = inferDomesticPeerRole(leaseIp) || state.domesticPeerDraft.peerRole || 'guest';
  const productSecondOctet = productSecondOctetFromIp(leaseIp)
    || state.domesticPeerDraft.productSecondOctet
    || productSecondOctetFromProduct(product)
    || defaultProductSecondOctet(productId, product?.mode);
  return {
    lease: null,
    leaseId: '',
    leaseIp,
    publicKey: leaseIp ? cleanHomePeerTextValue(state.domesticPeerDraft.publicKey) : '',
    peerRole,
    productId,
    productSecondOctet
  };
}

function renderHomePeerQuickFields(bodyText) {
  const body = parseActionBodyObject(bodyText);
  const hasHomePeer = body && ('leaseId' in body || 'leaseIp' in body || 'publicKey' in body || 'peerRole' in body);
  if (!hasHomePeer) return '';
  const bodyLeaseId = typeof body.leaseId === 'string' && !hasUnresolvedActionPlaceholder(body.leaseId)
    ? body.leaseId
    : '';
  const selectedBodyLease = bodyLeaseId ? launcherLeaseById(bodyLeaseId) : null;
  if (launcherLeaseIsRuntimeClient(selectedBodyLease)) applyLauncherLeaseToDomesticPeerDraft(selectedBodyLease);
  const draft = runtimeDomesticPeerDraft();
  const product = launcherProductNetwork(draft.productId);
  const leaseIp = draft.leaseIp;
  const publicKey = draft.publicKey;
  const productSecondOctet = draft.productSecondOctet;
  const leaseIpPlaceholder = draft.peerRole === 'user'
    ? `10.${productSecondOctet}.0.x`
    : `10.${productSecondOctet}.100.x`;
  const leases = selectableLauncherLeases();
  const leaseOptions = leases.map((lease) => `
    <option value="${escapeHtml(lease.leaseId)}" ${lease.leaseId === draft.leaseId ? 'selected' : ''}>
      ${escapeHtml(launcherLeaseLabel(lease))}
    </option>
  `).join('');
  const leaseControl = leases.length > 0
    ? `<select data-home-peer-field="leaseId">
        <option value="" ${draft.leaseId ? '' : 'selected'}>Select standalone client lease</option>
        ${leaseOptions}
      </select>`
    : `<input value="${escapeHtml(state.launcherLeasesError || 'No MX-H2I/Luopan client lease yet')}" readonly />`;
  return `
    <section class="home-peer-fields" aria-label="Home relay peer">
      <label class="home-peer-lease-field">
        <span>Launcher Standalone Peer Lease</span>
        ${leaseControl}
      </label>
      <label class="home-peer-readonly">
        <span>Identity</span>
        <input data-home-peer-field="identityLabel" value="${escapeHtml(peerRoleLabel(draft.peerRole, productSecondOctet))}" readonly />
      </label>
      <label class="home-peer-readonly">
        <span>Lease IP</span>
        <input value="${escapeHtml(leaseIp)}" placeholder="${escapeHtml(leaseIpPlaceholder)}" readonly />
      </label>
      <label class="home-peer-public-key-field home-peer-readonly">
        <span>WG Public Key</span>
        <input value="${escapeHtml(publicKey)}" placeholder="created by MX-H2I/Luopan client" readonly />
      </label>
      <div class="home-peer-route-field">
        <strong>${escapeHtml(launcherProductDisplayName(draft.productId, product))}: Domestic ${escapeHtml(draft.lease?.domesticGatewayIp || '10.88.0.1')}</strong>
        <small>to Internal ${escapeHtml(product?.internalControlIp || '10.88.88.88')}</small>
      </div>
    </section>
  `;
}

function renderAwxActionQuickFields(bodyText, action) {
  if (!isAwxApiAction(action)) return '';
  const body = parseActionBodyObject(bodyText) || {};
  prepareAwxActionDraft(action, body);
  const providerId = state.awxActionDraft.providerId || awxActionDefaultProviderId(action);
  const timeoutSeconds = state.awxActionDraft.timeoutSeconds || String(awxActionDefaultTimeout(action, body));
  const providers = asArray(state.awxProviders);
  const providerOptions = providers.map((provider) => `
    <option value="${escapeHtml(provider.providerId)}" ${provider.providerId === providerId ? 'selected' : ''}>
      ${escapeHtml(provider.name || provider.providerId)} / ${escapeHtml(provider.defaultKind || 'all')}
    </option>
  `).join('');
  const missingSelectedProvider = providerId && !providers.some((provider) => provider.providerId === providerId)
    ? `<option value="${escapeHtml(providerId)}" selected>${escapeHtml(providerId)}</option>`
    : '';
  const emptyProviderOption = !providerId && providers.length === 0
    ? '<option value="">Save provider first</option>'
    : '';
  return `
    <section class="awx-action-fields" aria-label="AWX execution">
      <label>
        <span>AWX Provider</span>
        <select data-awx-action-field="providerId">
          ${emptyProviderOption}
          ${missingSelectedProvider}
          ${providerOptions}
        </select>
      </label>
      ${awxActionNeedsToken(action) ? `
        <label>
          <span>AWX Token</span>
          <input data-awx-action-field="token" value="${escapeHtml(state.awxActionDraft.token)}" placeholder="bearer token" type="password" />
        </label>
      ` : ''}
      <label>
        <span>Timeout</span>
        <input data-awx-action-field="timeoutSeconds" inputmode="numeric" min="1" type="number" value="${escapeHtml(timeoutSeconds)}" />
      </label>
      ${action.actionId === 'site-slot.worker-run.awx-launch' ? `
        <label class="awx-action-toggle">
          <span>Wait</span>
          <input data-awx-action-field="waitForCompletion" type="checkbox" ${state.awxActionDraft.waitForCompletion !== false ? 'checked' : ''} />
        </label>
      ` : ''}
    </section>
  `;
}

function syncHomePeerField(input) {
  const field = input.dataset.homePeerField;
  if (field === 'leaseId') {
    state.domesticPeerDraft.leaseId = input.value.trim();
    const lease = launcherLeaseById(state.domesticPeerDraft.leaseId);
    if (launcherLeaseIsRuntimeClient(lease)) {
      applyLauncherLeaseToDomesticPeerDraft(lease);
    } else {
      state.domesticPeerDraft.leaseId = '';
      state.domesticPeerDraft.leaseIp = '';
      state.domesticPeerDraft.publicKey = '';
      state.domesticPeerDraft.peerRole = 'guest';
    }
  }
}

function applyLauncherLeaseToDomesticPeerDraft(lease) {
  state.domesticPeerDraft.productId = normalizeStandaloneProductId(lease.productId || state.domesticPeerDraft.productId || MX_H2I_PRODUCT_ID);
  state.domesticPeerDraft.productSecondOctet = productSecondOctetFromIp(lease.leaseIp)
    || productSecondOctetFromProduct(launcherProductById(lease.productId))
    || state.domesticPeerDraft.productSecondOctet
    || '89';
  state.domesticPeerDraft.leaseId = lease.leaseId || state.domesticPeerDraft.leaseId;
  state.domesticPeerDraft.leaseIp = lease.leaseIp || state.domesticPeerDraft.leaseIp;
  state.domesticPeerDraft.publicKey = lease.publicKey || state.domesticPeerDraft.publicKey;
  state.domesticPeerDraft.peerRole = launcherLeaseRole(lease);
}

function inferDomesticPeerRole(leaseIp) {
  const parts = String(leaseIp || '').split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return null;
  if (parts[0] !== 10 || parts[1] < 1 || parts[1] > 254 || parts[1] === 88) return null;
  if (parts[2] < 0 || parts[2] > 254 || parts[3] < 1 || parts[3] > 254) return null;
  return parts[2] >= 100 ? 'guest' : 'user';
}

function syncAwxActionField(input) {
  const field = input.dataset.awxActionField;
  if (field === 'providerId') {
    state.awxActionDraft.providerId = input.value.trim();
  } else if (field === 'token') {
    state.awxActionDraft.token = input.value.trim();
  } else if (field === 'timeoutSeconds') {
    state.awxActionDraft.timeoutSeconds = input.value.trim();
  } else if (field === 'waitForCompletion') {
    state.awxActionDraft.waitForCompletion = input.checked;
  }
}

function updateSelectedActionBodyFromHomePeer() {
  const bodyInput = pipelineActions.querySelector('[data-action-body]');
  if (!bodyInput) return;
  const body = parseActionBodyObject(bodyInput.value);
  if (!body) return;
  const homePeer = runtimeDomesticPeerDraft();
  if ('productId' in body) body.productId = homePeer.productId || MX_H2I_PRODUCT_ID;
  if ('leaseId' in body) body.leaseId = homePeer.leaseId || '<launcher-network-lease-id>';
  if ('peerRole' in body) body.peerRole = homePeer.peerRole;
  if ('leaseIp' in body) body.leaseIp = homePeer.leaseIp || '<home-lease-ip>';
  if ('publicKey' in body) body.publicKey = homePeer.publicKey || '<home-wg-public-key>';
  state.selectedActionBody = formatJson(body);
  bodyInput.value = state.selectedActionBody;
  const identityInput = pipelineActions.querySelector('[data-home-peer-field="identityLabel"]');
  if (identityInput) identityInput.value = peerRoleLabel(homePeer.peerRole, homePeer.productSecondOctet);
  const leaseSelect = pipelineActions.querySelector('[data-home-peer-field="leaseId"]');
  if (leaseSelect) leaseSelect.value = homePeer.leaseId;
}

function updateSelectedActionBodyFromAwxDraft() {
  const bodyInput = pipelineActions.querySelector('[data-action-body]');
  if (!bodyInput || !isAwxApiAction(state.selectedAction)) return;
  const body = parseActionBodyObject(bodyInput.value);
  if (!body) return;
  const providerId = blankToNull(state.awxActionDraft.providerId);
  const timeoutSeconds = positiveNumberOrNull(state.awxActionDraft.timeoutSeconds);
  if (providerId) body.awxProviderId = providerId;
  if (timeoutSeconds) body.timeoutSeconds = timeoutSeconds;
  if (state.selectedAction.actionId === 'site-slot.worker-run.awx-launch') {
    body.waitForCompletion = state.awxActionDraft.waitForCompletion !== false;
  }
  state.selectedActionBody = formatJson(body);
  bodyInput.value = state.selectedActionBody;
}

function syncDomesticPeerDraftFromBodyText(text) {
  const body = parseActionBodyObject(text);
  if (body) syncDomesticPeerDraftFromObject(body);
}

function syncAwxActionDraftFromBodyText(text) {
  const body = parseActionBodyObject(text);
  if (body) prepareAwxActionDraft(state.selectedAction, body);
}

function syncDomesticPeerDraftFromPayload(payload) {
  syncDomesticPeerDraftFromObject(payload?.relayPeerPlan?.homePeer);
  syncDomesticPeerDraftFromObject(payload?.relayPeerAppend?.homePeer);
  syncDomesticPeerDraftFromObject(payload?.relayPeerAppendSsh?.homePeer);
  syncDomesticPeerDraftFromObject(payload?.report?.stepReports?.map((step) => parseActionBodyObject(step.stdout)).find((item) => item?.homePeer)?.homePeer);
}

function syncDomesticPeerDraftFromObject(value) {
  if (!value || typeof value !== 'object') return;
  const role = value.peerRole || value.role;
  const productId = typeof value.productId === 'string' && !hasUnresolvedActionPlaceholder(value.productId) ? normalizeStandaloneProductId(value.productId) : null;
  const leaseId = typeof value.leaseId === 'string' && !hasUnresolvedActionPlaceholder(value.leaseId) ? value.leaseId : null;
  const leaseIp = typeof value.leaseIp === 'string' && !hasUnresolvedActionPlaceholder(value.leaseIp) ? value.leaseIp : null;
  const publicKey = typeof value.publicKey === 'string' && !hasUnresolvedActionPlaceholder(value.publicKey) ? value.publicKey : null;
  if (productId) {
    state.domesticPeerDraft.productId = productId;
    state.domesticPeerDraft.productSecondOctet = productSecondOctetFromProduct(launcherProductById(productId))
      || state.domesticPeerDraft.productSecondOctet
      || defaultProductSecondOctet(productId);
  }
  if (leaseId) {
    const lease = launcherLeaseById(leaseId);
    if (launcherLeaseIsRuntimeClient(lease)) {
      state.domesticPeerDraft.leaseId = leaseId;
      applyLauncherLeaseToDomesticPeerDraft(lease);
    }
  }
  if (role === 'user' || role === 'guest') state.domesticPeerDraft.peerRole = role;
  if (leaseIp && !knownGeneratedLeaseByIp(leaseIp)) {
    state.domesticPeerDraft.leaseIp = leaseIp;
    const inferredRole = inferDomesticPeerRole(leaseIp);
    if (inferredRole) state.domesticPeerDraft.peerRole = inferredRole;
    const inferredSecondOctet = productSecondOctetFromIp(leaseIp);
    if (inferredSecondOctet) state.domesticPeerDraft.productSecondOctet = inferredSecondOctet;
  }
  if (publicKey && (!leaseIp || !knownGeneratedLeaseByIp(leaseIp))) state.domesticPeerDraft.publicKey = publicKey;
}

function parseActionBodyObject(text) {
  try {
    const value = typeof text === 'string' ? JSON.parse(text) : text;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function nextActionFocusFromResult(action, payload) {
  if (action?.actionId === 'site-slot.worker-run.remote-ssh-execute'
    && (payload?.report?.reportId || payload?.workerExecution?.status)) {
    return null;
  }
  const preparedAwxJobId = payload?.relayPeerAppendAwxPrepare?.jobId;
  if (preparedAwxJobId) {
    return {
      jobId: preparedAwxJobId,
      actionIds: [
        'site-slot.worker-run.domestic-relay-readonly-probe',
        'site-slot.worker-run.awx-sync-plan',
        'site-slot.worker-run.awx-credential-sync',
        'site-slot.worker-run.awx-object-sync',
        'site-slot.worker-run.awx-launch',
        'site-slot.worker-run.awx-shadow'
      ]
    };
  }
  const preparedJobId = payload?.relayPeerAppendSshPrepare?.jobId;
  if (preparedJobId) {
    return {
      jobId: preparedJobId,
      actionIds: [
        'site-slot.worker-run.remote-ssh-gate',
        'site-slot.worker-run.domestic-relay-readonly-probe'
      ]
    };
  }
  const jobId = jobIdFromActionPath(action?.path);
  if (!jobId) return state.preferredActionFocus;
  if (action?.actionId === 'site-slot.worker-run.remote-ssh-gate' && payload?.gate?.verdict !== 'passed') {
    return { jobId, actionIds: ['site-slot.worker-run.remote-ssh-gate'] };
  }
  if (action?.actionId === 'site-slot.worker-run.remote-ssh-gate' && payload?.gate?.verdict === 'passed') {
    const job = currentPipelineWorkerJob(jobId);
    return {
      jobId,
      actionIds: isDomesticRelayPeerWorkerJob(job)
        ? ['site-slot.worker-run.domestic-relay-readonly-probe']
        : ['site-slot.worker-run.remote-ssh-readonly-probe', 'site-slot.worker-run.remote-ssh-execute', 'site-slot.worker-run.artifact-push-remote-ssh-plan']
    };
  }
  if (action?.actionId === 'site-slot.worker-run.domestic-relay-readonly-probe'
    && payload?.relayReadOnlyProbe?.status !== 'ready') {
    return { jobId, actionIds: ['site-slot.worker-run.domestic-relay-readonly-probe'] };
  }
  if (action?.actionId === 'site-slot.worker-run.awx-sync-plan'
    && payload?.awxSyncPlan?.status !== 'ready') {
    return { jobId, actionIds: ['site-slot.worker-run.awx-sync-plan', 'site-slot.worker-run.awx-shadow'] };
  }
  if (action?.actionId === 'site-slot.worker-run.awx-credential-sync'
    && payload?.awxCredentialSync?.status !== 'passed') {
    return { jobId, actionIds: ['site-slot.worker-run.awx-credential-sync', 'site-slot.worker-run.awx-sync-plan'] };
  }
  if (action?.actionId === 'site-slot.worker-run.awx-object-sync'
    && payload?.awxObjectSync?.status !== 'passed') {
    return { jobId, actionIds: ['site-slot.worker-run.awx-object-sync', 'site-slot.worker-run.awx-credential-sync', 'site-slot.worker-run.awx-sync-plan'] };
  }
  if (action?.actionId === 'site-slot.worker-run.awx-launch'
    && payload?.awxLaunch?.status === 'blocked') {
    return { jobId, actionIds: ['site-slot.worker-run.awx-launch'] };
  }
  const nextByActionId = {
    'site-slot.worker-run.remote-ssh-gate': ['site-slot.worker-run.domestic-relay-readonly-probe', 'site-slot.worker-run.remote-ssh-readonly-probe', 'site-slot.worker-run.remote-ssh-execute'],
    'site-slot.worker-run.remote-ssh-readonly-probe': ['site-slot.worker-run.remote-ssh-execute', 'site-slot.worker-run.artifact-push-remote-ssh-plan'],
    'site-slot.worker-run.domestic-relay-readonly-probe': ['site-slot.worker-run.remote-ssh-gate'],
    'site-slot.worker-run.awx-sync-plan': ['site-slot.worker-run.awx-credential-sync', 'site-slot.worker-run.awx-object-sync', 'site-slot.worker-run.awx-launch', 'site-slot.worker-run.awx-shadow'],
    'site-slot.worker-run.awx-credential-sync': ['site-slot.worker-run.awx-object-sync', 'site-slot.worker-run.awx-launch'],
    'site-slot.worker-run.awx-object-sync': ['site-slot.worker-run.awx-launch', 'site-slot.worker-run.awx-sync-plan']
  };
  const actionIds = nextByActionId[action?.actionId];
  return actionIds ? { jobId, actionIds } : state.preferredActionFocus;
}

function currentPipelineWorkerJob(jobId) {
  return asArray(state.currentPipeline?.workerJobs).find((job) => job.jobId === jobId) || null;
}

function isDomesticRelayPeerWorkerJob(job) {
  return job?.kind === 'domestic' && (
    job.rollbackPolicy?.strategy === 'restore-domestic-wg-peer-before-append'
    || String(job.worker?.workerId || '').includes('domestic-relay')
  );
}

function jobIdFromActionPath(path) {
  const match = String(path || '').match(/\/worker-jobs\/([^/]+)\//);
  return match ? decodeURIComponent(match[1]) : null;
}

function evidenceFocusFromActionPayload(payload, planId) {
  if (payload?.relayPeerAppendAwxPrepare) return null;
  if (payload?.relayPeerAppendSshPrepare) return null;
  const target = actionPayloadTarget(payload);
  if (target) return { planId: target.object.planId || planId || target.id, kind: target.kind, id: target.id };
  return null;
}

function summarizeActionPayload(action, payload) {
  const target = actionPayloadTarget(payload);
  const created = target?.object
    || payload.relayPeerAppendSsh
    || payload.relayPeerAppend
    || payload.relayReadOnlyProbe
    || payload.awxSyncPlan
    || payload.awxCredentialSync
    || payload.awxObjectSync
    || payload.awxLaunch
    || payload.domesticWgMaterialize
    || payload.internalServicePeerHandoff
    || payload.report
    || payload.workerExecution
    || payload.fakeTransport
    || payload.workerHandoff
    || payload.readOnlyProbe
    || payload.gate
    || payload.result;
  const id = target?.id || created?.credentialSyncId || created?.objectSyncId || created?.syncPlanId || created?.awxLaunchId || created?.fakeTransportId || created?.reportId || created?.handoffId || created?.probeId || created?.gateId || created?.snapshotId || created?.syncId || created?.applyId || action.actionId;
  const status = created?.status || created?.verdict || created?.allowed;
  return status ? `${action.label}: ${id} / ${status}` : `${action.label}: ${id}`;
}

function summarizeActionDetail(payload) {
  const awxPrepare = payload?.relayPeerAppendAwxPrepare;
  if (awxPrepare) {
    return JSON.stringify({
      status: awxPrepare.status,
      execution: awxPrepare.execution,
      boundary: awxPrepare.boundary,
      sessionId: awxPrepare.sessionId,
      jobId: awxPrepare.jobId,
      runner: awxPrepare.runner,
      workerJob: awxPrepare.workerJob,
      blockedReasons: awxPrepare.blockedReasons || [],
      nextActions: awxPrepare.nextActions || []
    }, null, 2);
  }
  const prepare = payload?.relayPeerAppendSshPrepare;
  if (prepare) {
    return JSON.stringify({
      status: prepare.status,
      execution: prepare.execution,
      boundary: prepare.boundary,
      sessionId: prepare.sessionId,
      jobId: prepare.jobId,
      runner: prepare.runner,
      workerJob: prepare.workerJob,
      blockedReasons: prepare.blockedReasons || [],
      nextActions: prepare.nextActions || []
    }, null, 2);
  }
  const domesticWgMaterialize = payload?.domesticWgMaterialize;
  if (domesticWgMaterialize) {
    return JSON.stringify({
      status: domesticWgMaterialize.status,
      execution: domesticWgMaterialize.execution,
      boundary: domesticWgMaterialize.boundary,
      publicEndpoint: domesticWgMaterialize.publicEndpoint,
      rotate: domesticWgMaterialize.rotate,
      generated: domesticWgMaterialize.generated,
      endpointChanged: domesticWgMaterialize.endpointChanged,
      previousMaterialDigest: domesticWgMaterialize.previousMaterialDigest,
      materialDigest: domesticWgMaterialize.materialDigest,
      clientRefresh: domesticWgMaterialize.clientRefresh,
      fingerprints: domesticWgMaterialize.fingerprints,
      relay: domesticWgMaterialize.relay,
      artifact: domesticWgMaterialize.artifact,
      blockedReasons: domesticWgMaterialize.blockedReasons || [],
      nextActions: domesticWgMaterialize.nextActions || []
    }, null, 2);
  }
  const internalServicePeerHandoff = payload?.internalServicePeerHandoff;
  if (internalServicePeerHandoff) {
    return JSON.stringify({
      status: internalServicePeerHandoff.status,
      execution: internalServicePeerHandoff.execution,
      boundary: internalServicePeerHandoff.boundary,
      command: internalServicePeerHandoff.command,
      env: internalServicePeerHandoff.env,
      config: internalServicePeerHandoff.config,
      relay: internalServicePeerHandoff.relay,
      gates: internalServicePeerHandoff.gates,
      checks: internalServicePeerHandoff.checks || [],
      blockedReasons: internalServicePeerHandoff.blockedReasons || [],
      nextActions: internalServicePeerHandoff.nextActions || []
    }, null, 2);
  }
  const internalServicePeerHostRunnerEnsure = payload?.internalServicePeerHostRunnerEnsure;
  if (internalServicePeerHostRunnerEnsure) {
    return JSON.stringify({
      status: internalServicePeerHostRunnerEnsure.status,
      execution: internalServicePeerHostRunnerEnsure.execution,
      mode: internalServicePeerHostRunnerEnsure.mode,
      runnerUrl: internalServicePeerHostRunnerEnsure.runnerUrl,
      namespace: internalServicePeerHostRunnerEnsure.namespace,
      name: internalServicePeerHostRunnerEnsure.name,
      image: internalServicePeerHostRunnerEnsure.image,
      objects: internalServicePeerHostRunnerEnsure.objects || [],
      blockedReasons: internalServicePeerHostRunnerEnsure.blockedReasons || [],
      nextActions: internalServicePeerHostRunnerEnsure.nextActions || []
    }, null, 2);
  }
  const internalServicePeerApply = payload?.internalServicePeerApply;
  if (internalServicePeerApply) {
    return JSON.stringify({
      status: internalServicePeerApply.status,
      execution: internalServicePeerApply.execution,
      mode: internalServicePeerApply.mode,
      command: internalServicePeerApply.command,
      exitCode: internalServicePeerApply.exitCode,
      stdout: internalServicePeerApply.stdout,
      stderr: internalServicePeerApply.stderr,
      internalEgressApply: internalServicePeerApply.internalEgressApply ? {
        status: internalServicePeerApply.internalEgressApply.status,
        execution: internalServicePeerApply.internalEgressApply.execution,
        command: internalServicePeerApply.internalEgressApply.command,
        exitCode: internalServicePeerApply.internalEgressApply.exitCode,
        stdout: internalServicePeerApply.internalEgressApply.stdout,
        stderr: internalServicePeerApply.internalEgressApply.stderr,
        steps: internalServicePeerApply.internalEgressApply.steps || []
      } : null,
      wireGuardCoreApply: internalServicePeerApply.wireGuardCoreApply || null,
      blockedReasons: internalServicePeerApply.blockedReasons || []
    }, null, 2);
  }
  const relayPeerAppendSsh = payload?.relayPeerAppendSsh;
  if (relayPeerAppendSsh) {
    return JSON.stringify({
      status: relayPeerAppendSsh.status,
      execution: relayPeerAppendSsh.execution,
      boundary: relayPeerAppendSsh.boundary,
      mode: relayPeerAppendSsh.mode,
      command: relayPeerAppendSsh.command,
      homePeer: relayPeerAppendSsh.homePeer,
      domesticRelay: relayPeerAppendSsh.domesticRelay,
      gates: relayPeerAppendSsh.gates,
      blockedReasons: relayPeerAppendSsh.blockedReasons || [],
      nextActions: relayPeerAppendSsh.nextActions || []
    }, null, 2);
  }
  const relayPeerAppend = payload?.relayPeerAppend;
  if (relayPeerAppend) {
    return JSON.stringify({
      status: relayPeerAppend.status,
      execution: relayPeerAppend.execution,
      boundary: relayPeerAppend.boundary,
      mode: relayPeerAppend.mode,
      command: relayPeerAppend.command,
      homePeer: relayPeerAppend.homePeer,
      domesticRelay: relayPeerAppend.domesticRelay,
      gates: relayPeerAppend.gates,
      blockedReasons: relayPeerAppend.blockedReasons || [],
      nextActions: relayPeerAppend.nextActions || []
    }, null, 2);
  }
  const relayReadOnlyProbe = payload?.relayReadOnlyProbe;
  if (relayReadOnlyProbe) {
    return JSON.stringify({
      status: relayReadOnlyProbe.status,
      execution: relayReadOnlyProbe.execution,
      boundary: relayReadOnlyProbe.boundary,
      command: relayReadOnlyProbe.command,
      gates: relayReadOnlyProbe.gates,
      blockedReasons: relayReadOnlyProbe.blockedReasons || [],
      nextActions: relayReadOnlyProbe.nextActions || []
    }, null, 2);
  }
  const awxSyncPlan = payload?.awxSyncPlan;
  if (awxSyncPlan) {
    return JSON.stringify({
      status: awxSyncPlan.status,
      execution: awxSyncPlan.execution,
      boundary: awxSyncPlan.boundary,
      providerId: awxSyncPlan.providerId,
      inventory: awxSyncPlan.inventory,
      inventoryHost: awxSyncPlan.inventoryHost,
      credential: awxSyncPlan.credential,
      jobTemplate: awxSyncPlan.jobTemplate,
      requiredPlaybook: awxSyncPlan.requiredPlaybook,
      objects: awxSyncPlan.objects,
      blockedReasons: awxSyncPlan.blockedReasons || [],
      warnings: awxSyncPlan.warnings || [],
      nextActions: awxSyncPlan.nextActions || []
    }, null, 2);
  }
  const awxCredentialSync = payload?.awxCredentialSync;
  if (awxCredentialSync) {
    return JSON.stringify({
      status: awxCredentialSync.status,
      execution: awxCredentialSync.execution,
      boundary: awxCredentialSync.boundary,
      providerId: awxCredentialSync.providerId,
      targetKind: awxCredentialSync.targetKind,
      organization: awxCredentialSync.organization,
      credential: awxCredentialSync.credential,
      sshProfileId: awxCredentialSync.sshProfileId,
      sshUser: awxCredentialSync.sshUser,
      identityFile: awxCredentialSync.identityFile,
      operations: awxCredentialSync.operations || [],
      blockedReasons: awxCredentialSync.blockedReasons || [],
      warnings: awxCredentialSync.warnings || [],
      nextActions: awxCredentialSync.nextActions || []
    }, null, 2);
  }
  const awxObjectSync = payload?.awxObjectSync;
  if (awxObjectSync) {
    return JSON.stringify({
      status: awxObjectSync.status,
      execution: awxObjectSync.execution,
      boundary: awxObjectSync.boundary,
      providerId: awxObjectSync.providerId,
      inventory: awxObjectSync.inventory,
      inventoryHost: awxObjectSync.inventoryHost,
      credential: awxObjectSync.credential,
      jobTemplate: awxObjectSync.jobTemplate,
      operations: awxObjectSync.operations || [],
      blockedReasons: awxObjectSync.blockedReasons || [],
      warnings: awxObjectSync.warnings || [],
      nextActions: awxObjectSync.nextActions || []
    }, null, 2);
  }
  const awxLaunch = payload?.awxLaunch;
  if (awxLaunch) {
    return JSON.stringify({
      status: awxLaunch.status,
      execution: awxLaunch.execution,
      boundary: awxLaunch.boundary,
      awxJobId: awxLaunch.awxJobId,
      awxJobStatus: awxLaunch.awxJobStatus,
      blockedReasons: awxLaunch.blockedReasons || [],
      nextActions: awxLaunch.nextActions || []
    }, null, 2);
  }
  const probe = payload?.readOnlyProbe;
  if (probe) {
    return JSON.stringify({
      status: probe.status,
      execution: probe.execution,
      boundary: probe.boundary,
      command: probe.command,
      blockedReasons: probe.blockedReasons || [],
      nextActions: probe.nextActions || []
    }, null, 2);
  }
  const handoff = payload?.workerHandoff;
  if (handoff) {
    return JSON.stringify({
      status: handoff.status,
      execution: handoff.execution,
      command: handoff.command,
      blockedReasons: handoff.blockedReasons || [],
      nextActions: handoff.nextActions || []
    }, null, 2);
  }
  const gate = payload?.gate;
  if (gate?.gateFailures?.length) {
    return JSON.stringify({
      verdict: gate.verdict,
      gateFailures: gate.gateFailures,
      sshProfile: gate.sshProfile
    }, null, 2);
  }
  return null;
}

function actionPayloadTarget(payload) {
  const targets = [
    { object: payload?.report, kind: 'worker-report', key: 'reportId' },
    { object: payload?.rollbackReport, kind: 'rollback-report', key: 'rollbackReportId' },
    { object: payload?.rollbackExecution, kind: 'rollback-execution', key: 'rollbackExecutionId' },
    { object: payload?.job, kind: 'worker-job', key: 'jobId' },
    { object: payload?.session, kind: 'runner-session', key: 'sessionId' },
    { object: payload?.execution, kind: 'execution', key: 'runId' },
    { object: payload?.plan, kind: 'plan', key: 'planId' }
  ];
  for (const target of targets) {
    const id = target.object?.[target.key];
    if (id) return { ...target, id };
  }
  return null;
}

function sameAction(a, b) {
  return a.actionId === b.actionId && a.path === b.path;
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function initTopologyScene() {
  if (!topologyCanvas || state.topology) return;
  try {
    const theme = topologyTheme();
    const renderer = new THREE.WebGLRenderer({
      canvas: topologyCanvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(theme.canvas, 0);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 4.2, 12);
    camera.lookAt(0, 0, 0);

    const root = new THREE.Group();
    scene.add(root);

    const ambient = new THREE.AmbientLight(0xffffff, 1.2);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(2, 4, 4);
    scene.add(key);

    const nodeSpecs = [
      { id: 'h', label: 'H', name: 'H Endpoint', position: [-5.2, -0.9, 0], color: theme.info },
      { id: 'domestic', label: 'D', name: 'Domestic', position: [-2.0, 0.7, 0.4], color: theme.success },
      { id: 'internal', label: 'I', name: 'Internal', position: [1.4, 0.1, -0.2], color: theme.primary },
      { id: 'oversea', label: 'O', name: 'Oversea', position: [4.9, 1.0, 0.2], color: theme.archetype }
    ];

    const nodes = new Map();
    for (const spec of nodeSpecs) {
      const group = new THREE.Group();
      group.position.set(...spec.position);
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.42, 40, 24),
        new THREE.MeshStandardMaterial({
          color: spec.color,
          roughness: 0.28,
          metalness: 0.34,
          emissive: spec.color,
          emissiveIntensity: 0.22
        })
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.74, 40, 24),
        new THREE.MeshBasicMaterial({
          color: spec.color,
          transparent: true,
          opacity: 0.13,
          depthWrite: false
        })
      );
      const label = createTopologyLabel(spec.label, spec.name, theme);
      label.position.set(0, -0.9, 0);
      group.add(halo, sphere, label);
      group.userData = { id: spec.id, baseScale: 1, color: spec.color, sphere, halo };
      root.add(group);
      nodes.set(spec.id, group);
    }

    const links = [
      createTopologyLink(nodes.get('h'), nodes.get('domestic'), theme.info),
      createTopologyLink(nodes.get('domestic'), nodes.get('internal'), theme.primary),
      createTopologyLink(nodes.get('internal'), nodes.get('oversea'), theme.archetype)
    ];
    for (const link of links) root.add(link.group);

    const starField = createStarField(theme);
    root.add(starField);

    state.topology = {
      renderer,
      scene,
      camera,
      root,
      nodes,
      links,
      starField,
      focusNodeId: null,
      health: 'ready',
      lastWidth: 0,
      lastHeight: 0
    };

    window.addEventListener('resize', resizeTopology);
    resizeTopology();
    animateTopology();
  } catch {
    topologyCanvas.hidden = true;
  }
}

function createTopologyLink(fromNode, toNode, color) {
  const from = fromNode.position;
  const to = toNode.position;
  const mid = from.clone().lerp(to, 0.5);
  mid.y += 0.55;
  mid.z -= 0.25;
  const curve = new THREE.CatmullRomCurve3([from.clone(), mid, to.clone()]);
  const points = curve.getPoints(64);
  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points),
    new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.46
    })
  );
  const particles = [];
  for (let index = 0; index < 4; index += 1) {
    const particle = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 16, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    particle.userData.offset = index / 4;
    particles.push(particle);
  }
  const group = new THREE.Group();
  group.add(line, ...particles);
  return { group, line, particles, curve, color };
}

function createTopologyLabel(letter, name, theme = topologyTheme()) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = theme.text;
  context.font = '700 34px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
  context.textAlign = 'center';
  context.fillText(letter, 128, 36);
  context.fillStyle = theme.textSoft;
  context.font = '500 18px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
  context.fillText(name, 128, 68);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false
  }));
  sprite.scale.set(1.9, 0.72, 1);
  return sprite;
}

function createStarField(theme = topologyTheme()) {
  const positions = [];
  for (let index = 0; index < 140; index += 1) {
    positions.push(
      (Math.random() - 0.5) * 13,
      (Math.random() - 0.5) * 5,
      -2 - Math.random() * 4
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: theme.info,
    size: 0.025,
    transparent: true,
    opacity: 0.55
  });
  return new THREE.Points(geometry, material);
}

function animateTopology() {
  const topology = state.topology;
  if (!topology) return;
  const elapsed = performance.now() / 1000;
  topology.root.rotation.y = Math.sin(elapsed * 0.18) * 0.08;
  topology.starField.rotation.z = elapsed * 0.012;
  for (const node of topology.nodes.values()) {
    const focused = topology.focusNodeId === node.userData.id;
    const pulse = 1 + Math.sin(elapsed * 2.5 + node.position.x) * 0.035;
    const target = focused ? 1.22 : 1;
    node.scale.setScalar(target * pulse);
    node.userData.halo.material.opacity = focused ? 0.22 : 0.13;
  }
  for (const link of topology.links) {
    for (const particle of link.particles) {
      const t = (elapsed * 0.18 + particle.userData.offset) % 1;
      particle.position.copy(link.curve.getPointAt(t));
    }
  }
  topology.renderer.render(topology.scene, topology.camera);
  requestAnimationFrame(animateTopology);
}

function resizeTopology() {
  const topology = state.topology;
  if (!topology || !topologyCanvas) return;
  const rect = topologyCanvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  if (width === topology.lastWidth && height === topology.lastHeight) return;
  topology.lastWidth = width;
  topology.lastHeight = height;
  topology.renderer.setSize(width, height, false);
  topology.camera.aspect = width / height;
  topology.camera.updateProjectionMatrix();
}

function updateTopologyFromPipelines(pipelines) {
  const topology = state.topology;
  if (!topology) return;
  const runtimeHealth = internalPeerRuntimeHealth();
  const domesticHealth = runtimeHealth || combinedHealth(pipelines.filter((pipeline) => pipeline.kind === 'domestic'));
  const overseaHealth = combinedHealth(pipelines.filter((pipeline) => pipeline.kind === 'oversea'));
  const internalHealth = runtimeHealth || combinedHealth(pipelines);
  const overallHealth = combinedHealthValues([domesticHealth, internalHealth, overseaHealth]);
  setTopologyNodeHealth('domestic', domesticHealth);
  setTopologyNodeHealth('internal', internalHealth);
  setTopologyNodeHealth('oversea', overseaHealth);
  setTopologyNodeHealth('h', overallHealth === 'failed' ? 'blocked' : 'ready');
  setTopologyLinkColor(0, overallHealth === 'failed' ? 'blocked' : domesticHealth);
  setTopologyLinkColor(1, internalHealth);
  setTopologyLinkColor(2, overseaHealth);
}

function focusTopologyNode(kind) {
  const topology = state.topology;
  if (!topology) return;
  topology.focusNodeId = kind === 'oversea' ? 'oversea' : 'domestic';
}

function setTopologyNodeHealth(nodeId, health) {
  const topology = state.topology;
  const node = topology?.nodes.get(nodeId);
  if (!node) return;
  const color = new THREE.Color(healthColor(health));
  node.userData.sphere.material.color.copy(color);
  node.userData.sphere.material.emissive.copy(color);
  node.userData.halo.material.color.copy(color);
}

function setTopologyLinkColor(index, health) {
  const topology = state.topology;
  const link = topology?.links[index];
  if (!link) return;
  const color = new THREE.Color(healthColor(health));
  link.line.material.color.copy(color);
  for (const particle of link.particles) {
    particle.material.color.copy(color);
  }
}

function combinedHealth(pipelines) {
  return combinedHealthValues(asArray(pipelines).map((pipeline) => pipeline.health));
}

function combinedHealthValues(values) {
  const normalized = asArray(values).map((value) => normalizeStageStatus(value));
  if (!normalized.length) return 'ready';
  if (normalized.includes('failed')) return 'failed';
  if (normalized.includes('rollback')) return 'rollback';
  if (normalized.includes('running')) return 'running';
  if (normalized.includes('passed')) return 'passed';
  if (normalized.includes('ready')) return 'ready';
  if (normalized.includes('blocked')) return 'blocked';
  return 'ready';
}

function healthColor(health) {
  const theme = topologyTheme();
  if (health === 'failed') return theme.danger;
  if (health === 'blocked') return theme.warning;
  if (health === 'rollback') return theme.archetype;
  if (health === 'running') return theme.info;
  if (health === 'passed') return theme.success;
  return theme.primary;
}

function topologyTheme() {
  return {
    canvas: cssColor('--mx-bg-workspace', '#1a1b23'),
    primary: cssColor('--mx-primary', '#2bf6d2'),
    info: cssColor('--mx-info', '#5e8eec'),
    success: cssColor('--mx-success', '#48bc77'),
    warning: cssColor('--mx-warning', '#f8d06c'),
    danger: cssColor('--mx-danger', '#ee6067'),
    archetype: cssColor('--mx-archetype', '#b974ff'),
    text: cssColor('--mx-text', '#e2e2e2'),
    textSoft: cssColor('--mx-text-soft', 'rgba(226,226,226,0.72)')
  };
}

function cssColor(name, fallback) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function formatCounts(counts) {
  if (!counts) return '0 objects';
  const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
  return `${total} objects`;
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
