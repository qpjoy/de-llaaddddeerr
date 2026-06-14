import * as THREE from './node_modules/three/build/three.module.js';

const SSH_READONLY_PROBE_FEATURE_KEY = 'site-slot.ssh-readonly-probe.execute';

const api = window.mxLauncher || {
  getConfig: async () => ({
    serverBaseUrl: 'http://127.0.0.1:18090',
    productConfigs: { hdo: { defaultMode: 'visitor' } }
  }),
  saveConfig: async (input) => input,
  getProducts: async () => [{
    id: 'hdo',
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
    window.open(`${serverBaseUrl || 'http://127.0.0.1:18090'}/admin`, '_blank');
    return true;
  }
};

const state = {
  activeView: 'app-center',
  sidebarCollapsed: false,
  adminSubnavCollapsed: false,
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
  awxActionDraft: {
    providerId: '',
    token: '',
    timeoutSeconds: '',
    waitForCompletion: true
  },
  preferredActionFocus: null,
  domesticPeerDraft: {
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
    selectedOverseaUserId: null,
    overseaFeedback: null,
    overseaBusy: false,
    overseaSyncBusy: false,
    feedback: null,
    busy: false
  },
  relayEnrollment: {
    result: null,
    feedback: null,
    busy: false
  },
  awxProviders: [],
  selectedAwxProviderId: null,
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
const hdoLaunch = document.getElementById('hdo-launch');
const hdoAdmin = document.getElementById('hdo-admin');
const hdoStatus = document.getElementById('hdo-status');
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
const adminSubnavToggle = document.getElementById('admin-subnav-toggle');
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
const evidenceBackdrop = document.getElementById('evidence-backdrop');
const evidenceDrawer = document.getElementById('evidence-drawer');
const evidenceClose = document.getElementById('evidence-close');
const evidenceKind = document.getElementById('evidence-kind');
const evidenceTitle = document.getElementById('evidence-title');
const evidenceMeta = document.getElementById('evidence-meta');
const evidenceSummary = document.getElementById('evidence-summary');
const evidenceSteps = document.getElementById('evidence-steps');
const evidenceJson = document.getElementById('evidence-json');

const tabs = Array.from(document.querySelectorAll('.nav-tab'));
const views = Array.from(document.querySelectorAll('.view'));

void boot();

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    state.hoverAdminMenu = null;
    setActiveView(tab.dataset.view, adminNavFromElement(tab));
  });
  tab.addEventListener('mouseenter', () => {
    previewCollapsedAdminSubnav(tab);
  });
  tab.addEventListener('focus', () => {
    previewCollapsedAdminSubnav(tab);
  });
}

hdoLaunch.addEventListener('click', () => {
  void launchHdo();
});

hdoAdmin.addEventListener('click', () => {
  void api.openAdmin(serverInput.value);
});

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
  sidebar.classList.toggle('is-collapsed', state.sidebarCollapsed);
  sidebar.classList.toggle('is-subnav-open', state.sidebarCollapsed && state.activeView === 'admin');
  sidebarCollapse.setAttribute('aria-expanded', state.sidebarCollapsed ? 'false' : 'true');
  sidebarCollapse.textContent = state.sidebarCollapsed ? '展开 →' : '收起 ←';
  renderAdminSubnav();
  requestAnimationFrame(() => resizeTopology());
});

sidebar.addEventListener('mouseleave', () => {
  if (!state.sidebarCollapsed) return;
  state.hoverAdminMenu = null;
  sidebar.classList.toggle('is-subnav-open', state.activeView === 'admin');
  renderAdminSubnav();
});

if (adminSubnavToggle) {
  adminSubnavToggle.addEventListener('click', () => {
    state.adminSubnavCollapsed = !state.adminSubnavCollapsed;
    renderAdminSubnav();
  });
}

for (const tab of adminModuleTabs) {
  tab.addEventListener('click', () => {
    applyAdminNavigation(adminNavFromElement(tab), { stopSetupMessage: 'Stopped because the operator changed sections.' });
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
  });
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

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !evidenceDrawer.hidden) {
    closeEvidenceDrawer();
  }
});

async function boot() {
  const config = await api.getConfig();
  serverInput.value = config.serverBaseUrl || 'http://127.0.0.1:18090';
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

function previewCollapsedAdminSubnav(tab) {
  if (!state.sidebarCollapsed || tab.dataset.view !== 'admin') return;
  state.hoverAdminMenu = tab.dataset.adminMenu || 'operations';
  sidebar.classList.add('is-subnav-open');
  renderAdminSubnav();
}

function setActiveView(view, nav = {}) {
  if (view !== 'admin' && state.setupRun.active) {
    clearSetupRun('Stopped because the operator left I-HDO.', 'stopped');
  }
  if (view === 'admin') {
    applyAdminNavigation(nav);
  }
  state.activeView = view === 'admin' ? 'admin' : 'app-center';
  if (state.activeView !== 'admin') {
    state.hoverAdminMenu = null;
    sidebar.classList.remove('is-subnav-open');
  } else {
    sidebar.classList.toggle('is-subnav-open', state.sidebarCollapsed);
  }
  for (const tab of tabs) {
    const active = state.activeView === 'app-center'
      ? tab.dataset.view === 'app-center'
      : tab.dataset.view === 'admin' && (tab.dataset.adminMenu || 'operations') === state.adminMenu;
    tab.classList.toggle('is-active', active);
  }
  for (const item of views) {
    item.classList.toggle('is-active', item.id === `view-${state.activeView}`);
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
    state.deploymentKind = nav.deploymentKind === 'domestic' ? 'domestic' : 'oversea';
  }
  const changedDeployment = previousKind !== state.deploymentKind;
  const changedSection = previousSection !== state.adminSection;
  if ((changedDeployment || changedSection) && state.setupRun.active) {
    clearSetupRun(options.stopSetupMessage || 'Stopped because the operator changed sections.', 'stopped');
  }
  if (changedDeployment) {
    state.selectedSiteId = null;
    state.selectedPlanId = null;
    state.selectedAction = null;
    state.actionFeedback = null;
    closeEvidenceDrawer();
  }
}

async function refreshProducts() {
  const products = await api.getProducts();
  const hdo = products.find((product) => product.id === 'hdo');
  hdoStatus.textContent = hdo && hdo.status === 'installed' ? 'Installed' : 'Not installed';
}

async function persistConfig() {
  const current = await api.getConfig();
  await api.saveConfig({
    serverBaseUrl: serverInput.value,
    productConfigs: current.productConfigs || {}
  });
}

async function launchHdo() {
  await persistConfig();
  stateChip.textContent = 'Starting';
  stateChip.dataset.state = 'connecting';
  const result = await api.launchProduct({
    productId: 'hdo',
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
    const [dashboard, profilePayload, overseaPayload, userCenterPayload] = await Promise.all([
      fetchJson('/internal/v1/admin/dashboard'),
      loadSshProfiles(),
      loadOverseaOverview(),
      loadUserCenterOverview()
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
    state.awxRuntimePolicies = asArray(dashboard.runtimeFeaturePolicies);
    state.overseaOverview = overseaPayload.overview;
    state.overseaOverviewError = overseaPayload.error;
    const pipelines = dashboard.siteSlotPipelines || [];
    const active = activePipelineForCurrentDeployment(pipelines);
    state.selectedPlanId = active?.planId || null;
    state.selectedSiteId = selectedSiteFromOverseaOverview() || active?.siteId || state.selectedSiteId;
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
    state.deploymentKind = pipeline?.summary?.kind === 'domestic' ? 'domestic' : pipeline?.summary?.kind === 'oversea' ? 'oversea' : state.deploymentKind;
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
  state.sshPlanBusy = true;
  state.sshProfileFeedback = { kind: 'info', message: 'Creating site slot plan' };
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  try {
    const payload = await fetchJson('/internal/v1/site-slots/plans', {
      method: 'POST',
      body: sshProfilePlanPayload()
    });
    const plan = payload.plan;
    state.selectedPlanId = plan?.planId || state.selectedPlanId;
    state.pendingEvidenceFocus = plan?.planId
      ? { planId: plan.planId, kind: 'plan', id: plan.planId }
      : null;
    state.sshProfileFeedback = {
      kind: 'success',
      message: plan ? `Created plan ${plan.siteId} / ${plan.status}` : 'Created plan'
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
    const payload = await fetchJson(`/internal/v1/admin/oversea/${encodeURIComponent(siteId)}/ensure`, {
      method: 'POST',
      body: {
        executeRemote: true,
        confirmInstall: true,
        force: true,
        internalBaseUrl: normalizedServerBase(),
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
  return {
    profileId: blankToNull(sshProfileId.value),
    siteId: blankToNull(sshProfileSiteId.value),
    kind: sshProfileKind.value,
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
    requestedBy: 'desktop-admin',
    requestId: `desktop-ssh-profile-${Date.now()}`
  };
}

function sshProfilePlanPayload() {
  const kind = sshProfileKind.value === 'domestic' ? 'domestic' : 'oversea';
  return {
    siteId: blankToNull(sshProfileSiteId.value),
    kind,
    sshProfileId: blankToNull(sshProfileId.value),
    host: blankToNull(sshProfileHost.value),
    sshUser: blankToNull(sshProfileUser.value) || 'root',
    sshPort: positiveNumberOrNull(sshProfilePort.value) || 22,
    rootAccess: (blankToNull(sshProfileUser.value) || 'root') === 'root',
    hasDocker: true,
    hasOutboundInternet: kind === 'oversea',
    internalBaseUrl: normalizedServerBase(),
    createdBy: 'desktop-admin',
    requestId: `desktop-site-slot-plan-${Date.now()}`
  };
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
    internalBaseUrl: normalizedServerBase(),
    awxProviderId: blankToNull(awxProviderId.value) || state.selectedAwxProviderId || provider?.providerId || null,
    awxToken: blankToNull(awxProviderToken.value),
    awxRequestTimeoutSeconds: positiveNumberOrNull(awxProviderTimeout.value) || 30,
    requestedBy: 'desktop-admin',
    requestId: `desktop-oversea-shadow-setup-${Date.now()}`
  };
}

function sshProfileBootstrapPayload(password) {
  return {
    profileId: blankToNull(sshProfileId.value),
    siteId: blankToNull(sshProfileSiteId.value),
    kind: sshProfileKind.value,
    host: blankToNull(sshProfileHost.value),
    sshUser: blankToNull(sshProfileUser.value) || 'root',
    sshPort: positiveNumberOrNull(sshProfilePort.value) || 22,
    password,
    hostKeyAlias: blankToNull(sshProfileHostKeyAlias.value),
    connectTimeoutSeconds: positiveNumberOrNull(sshProfileTimeout.value) || 30,
    rotateKey: sshProfileRotateKey.checked,
    scanHostKey: true,
    executeBootstrap: true,
    confirmBootstrap: true,
    requestedBy: 'desktop-admin',
    requestId: `desktop-ssh-bootstrap-${Date.now()}`
  };
}

function sshProfileHostKeyRefreshPayload() {
  return {
    profileId: blankToNull(sshProfileId.value),
    siteId: blankToNull(sshProfileSiteId.value),
    kind: sshProfileKind.value,
    host: blankToNull(sshProfileHost.value),
    sshUser: blankToNull(sshProfileUser.value) || 'root',
    sshPort: positiveNumberOrNull(sshProfilePort.value) || 22,
    hostKeyAlias: blankToNull(sshProfileHostKeyAlias.value) || blankToNull(sshProfileSiteId.value),
    connectTimeoutSeconds: positiveNumberOrNull(sshProfileTimeout.value) || 30,
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
}

async function bootstrapUserCenterFromAdmin() {
  if (state.userCenter.busy) return;
  state.userCenter.busy = true;
  state.userCenter.feedback = { kind: 'info', message: 'Bootstrapping User Center' };
  renderFoundationGrid(state.dashboard?.overview || {});
  try {
    const payload = await fetchJson('/internal/v1/user-center/bootstrap', { method: 'POST', body: {} });
    state.userCenter.feedback = {
      kind: 'success',
      message: `Bootstrapped ${asArray(payload.userCenter?.users).length} users`
    };
    await refreshUserCenterPanels();
  } catch (error) {
    state.userCenter.feedback = { kind: 'error', message: error.message };
    renderFoundationGrid(state.dashboard?.overview || {});
  } finally {
    state.userCenter.busy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
  }
}

async function createUserFromAdmin() {
  if (state.userCenter.busy) return;
  const email = blankToNull(foundationGrid.querySelector('[data-user-field="email"]')?.value);
  const displayName = blankToNull(foundationGrid.querySelector('[data-user-field="displayName"]')?.value);
  const roleId = blankToNull(foundationGrid.querySelector('[data-user-field="roleId"]')?.value);
  if (!email || !displayName) {
    state.userCenter.feedback = { kind: 'error', message: 'Email and display name are required' };
    renderFoundationGrid(state.dashboard?.overview || {});
    return;
  }
  state.userCenter.busy = true;
  state.userCenter.feedback = { kind: 'info', message: 'Creating user' };
  renderFoundationGrid(state.dashboard?.overview || {});
  try {
    const payload = await fetchJson('/internal/v1/user-center/users', {
      method: 'POST',
      body: {
        email,
        displayName,
        roleIds: roleId ? [roleId] : [],
        orgIds: ['org_default'],
        requestId: `desktop-user-${Date.now()}`
      }
    });
    state.userCenter.feedback = {
      kind: 'success',
      message: `Created ${payload.user?.displayName || payload.user?.userId || email}`
    };
    await refreshUserCenterPanels();
  } catch (error) {
    state.userCenter.feedback = { kind: 'error', message: error.message };
    renderFoundationGrid(state.dashboard?.overview || {});
  } finally {
    state.userCenter.busy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
  }
}

async function assignUserOverseaFromAdmin() {
  if (state.userCenter.overseaBusy) return;
  const userId = blankToNull(foundationGrid.querySelector('[data-oversea-user]')?.value);
  const siteIds = [...foundationGrid.querySelectorAll('[data-oversea-site]:checked')]
    .map((item) => item.value)
    .filter(Boolean);
  if (!userId) {
    state.userCenter.overseaFeedback = { kind: 'error', message: 'Select a user first' };
    renderFoundationGrid(state.dashboard?.overview || {});
    return;
  }
  state.userCenter.selectedOverseaUserId = userId;
  state.userCenter.overseaBusy = true;
  state.userCenter.overseaFeedback = {
    kind: 'info',
    message: siteIds.length ? 'Issuing user Oversea entitlement' : 'Disabling user Oversea access'
  };
  renderFoundationGrid(state.dashboard?.overview || {});
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
      renderFoundationGrid(state.dashboard?.overview || {});
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
    renderFoundationGrid(state.dashboard?.overview || {});
  } finally {
    state.userCenter.overseaBusy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
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

async function syncUserOverseaRuntimeFromAdmin() {
  if (state.userCenter.overseaSyncBusy || state.userCenter.overseaBusy) return;
  const userId = blankToNull(foundationGrid.querySelector('[data-oversea-user]')?.value);
  let siteIds = [...foundationGrid.querySelectorAll('[data-oversea-site]:checked')]
    .map((item) => item.value)
    .filter(Boolean);
  if (!userId) {
    state.userCenter.overseaFeedback = { kind: 'error', message: 'Select a user first' };
    renderFoundationGrid(state.dashboard?.overview || {});
    return;
  }
  const entitlement = entitlementForUser(userId);
  if (!siteIds.length) siteIds = asArray(entitlement?.siteIds);
  if (!siteIds.length) {
    state.userCenter.overseaFeedback = { kind: 'error', message: 'Assign at least one Oversea site before syncing' };
    renderFoundationGrid(state.dashboard?.overview || {});
    return;
  }
  state.userCenter.selectedOverseaUserId = userId;
  state.userCenter.overseaSyncBusy = true;
  state.userCenter.overseaFeedback = { kind: 'info', message: 'Syncing this user to selected remote site(s)' };
  renderFoundationGrid(state.dashboard?.overview || {});
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
    renderFoundationGrid(state.dashboard?.overview || {});
  } finally {
    state.userCenter.overseaSyncBusy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
  }
}

async function enrollHomeRelayFromAdmin() {
  if (state.relayEnrollment.busy) return;
  const siteId = blankToNull(foundationGrid.querySelector('[data-relay-field="siteId"]')?.value) || 'domestic-main';
  const publicKey = blankToNull(foundationGrid.querySelector('[data-relay-field="publicKey"]')?.value);
  const installId = blankToNull(foundationGrid.querySelector('[data-relay-field="installId"]')?.value);
  const deviceId = blankToNull(foundationGrid.querySelector('[data-relay-field="deviceId"]')?.value);
  if (!publicKey) {
    state.relayEnrollment.feedback = { kind: 'error', message: 'Home WireGuard public key is required' };
    renderFoundationGrid(state.dashboard?.overview || {});
    return;
  }
  state.relayEnrollment.busy = true;
  state.relayEnrollment.feedback = { kind: 'info', message: 'Creating relay enrollment' };
  renderFoundationGrid(state.dashboard?.overview || {});
  try {
    const payload = await fetchJson('/internal/v1/enrollments/anonymous', {
      method: 'POST',
      body: {
        productId: 'hdo',
        siteId,
        installId,
        deviceId,
        platform: 'desktop-admin',
        publicKey,
        relayMode: 'h2i',
        requestId: `desktop-relay-enroll-${Date.now()}`
      }
    });
    const enrollment = payload.enrollment || null;
    state.relayEnrollment.result = enrollment;
    state.relayEnrollment.feedback = {
      kind: 'success',
      message: enrollment ? `Relay lease ${enrollment.overlayIp}` : 'Relay enrollment created'
    };
    if (enrollment?.overlayIp) {
      state.domesticPeerDraft = {
        peerRole: 'guest',
        leaseIp: enrollment.overlayIp,
        publicKey
      };
    }
  } catch (error) {
    state.relayEnrollment.feedback = { kind: 'error', message: error.message };
  } finally {
    state.relayEnrollment.busy = false;
    renderFoundationGrid(state.dashboard?.overview || {});
  }
}

function renderSshProfiles(profiles) {
  const items = asArray(profiles);
  sshProfileCount.textContent = String(items.length);
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  renderSshProfileBootstrap();
  renderSshProfileShadowSetup();
  renderSshProfileReadiness();
  if (!items.length) {
    sshProfileList.innerHTML = '<div class="empty-state">No SSH profiles</div>';
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

function fillSshProfileForm(profile) {
  sshProfileId.value = profile.profileId || '';
  sshProfileSiteId.value = profile.siteId || '';
  sshProfileKind.value = profile.kind === 'domestic' ? 'domestic' : 'oversea';
  sshProfileHost.value = profile.host || '';
  sshProfileUser.value = profile.sshUser || 'root';
  sshProfilePassword.value = '';
  sshProfileRotateKey.checked = false;
  sshProfilePort.value = String(profile.sshPort || 22);
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
  const pipeline = asArray(pipelines).find((item) => item.kind === 'oversea') || asArray(pipelines)[0];
  const kind = pipeline?.kind === 'domestic' ? 'domestic' : 'oversea';
  const siteId = pipeline?.siteId || `${kind}-main`;
  sshProfileId.value = '';
  sshProfileSiteId.value = siteId;
  sshProfileKind.value = kind;
  sshProfileHostKeyAlias.value = siteId;
  sshProfileUser.value = 'root';
  sshProfilePassword.value = '';
  sshProfileRotateKey.checked = false;
  sshProfilePort.value = '22';
  sshProfileStrict.value = 'yes';
  sshProfileBatchMode.value = 'yes';
  sshProfileTimeout.value = '30';
  sshProfileIdentity.value = '';
  sshProfileKnownHosts.value = '';
  sshProfileConfigFile.value = '';
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
  const response = await fetch(`${base}${path}`, {
    method: options.method || 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body
  });
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
  const raw = serverInput.value.trim().replace(/\/+$/, '');
  return raw || 'http://127.0.0.1:18090';
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
  for (const tab of tabs) {
    const active = state.activeView === 'app-center'
      ? tab.dataset.view === 'app-center'
      : tab.dataset.view === 'admin' && (tab.dataset.adminMenu || 'operations') === state.adminMenu;
    tab.classList.toggle('is-active', active);
  }
}

function renderAdminShell() {
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
    const label = state.deploymentKind === 'domestic' ? 'Domestic' : 'Oversea';
    deploymentTitle.textContent = `${label} Deployment`;
    deploymentSubtitle.textContent = state.deploymentKind === 'domestic'
      ? 'Domestic 负责 WG relay、H2I proxy、Internal DNS 可达性和缓存/观测转发。'
      : 'Oversea 负责 Docker hysteria2、site-agent、runner-worker；mihomo authority 留在 Internal。';
    sshProfileKind.value = state.deploymentKind;
  }
}

function renderAdminSubnav() {
  if (!adminSubnav) return;
  const displayMenuName = state.hoverAdminMenu || state.adminMenu;
  const visible = state.activeView === 'admin' || Boolean(state.hoverAdminMenu);
  const menu = adminMenuMeta[displayMenuName] || adminMenuMeta.operations;
  const anchor = tabs.find((tab) => tab.dataset.view === 'admin' && (tab.dataset.adminMenu || 'operations') === displayMenuName);
  if (anchor && adminSubnav.previousElementSibling !== anchor) {
    anchor.insertAdjacentElement('afterend', adminSubnav);
  }
  if (anchor) {
    adminSubnav.style.setProperty('--admin-subnav-top', `${anchor.offsetTop}px`);
  }
  adminSubnav.hidden = !visible;
  adminSubnav.dataset.menu = displayMenuName;
  adminSubnav.setAttribute('aria-label', `${menu.heading} modules`);
  adminSubnav.classList.toggle('is-collapsed', state.adminSubnavCollapsed);
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
  if (adminSubnavItems) adminSubnavItems.hidden = state.adminSubnavCollapsed;
  if (adminSubnavToggle) {
    adminSubnavToggle.setAttribute('aria-expanded', state.adminSubnavCollapsed ? 'false' : 'true');
    adminSubnavToggle.textContent = state.adminSubnavCollapsed ? '⌄' : '⌃';
  }
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
  const sites = deploymentSites(pipelines, state.deploymentKind);
  if (state.selectedSiteId) {
    return sites.find((site) => site.siteId === state.selectedSiteId)?.activePipeline || null;
  }
  return sites[0]?.activePipeline || null;
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
    if (left.siteId === state.selectedSiteId) return -1;
    if (right.siteId === state.selectedSiteId) return 1;
    return String(right.latestPipeline?.latestUpdatedAt || '').localeCompare(String(left.latestPipeline?.latestUpdatedAt || ''));
  });
}

function chooseOperationalPipeline(pipelines) {
  const items = asArray(pipelines);
  const open = items.filter((pipeline) => !['passed', 'failed', 'rollback'].includes(pipeline.health));
  const preferred = open.length ? open : items;
  return preferred
    .slice()
    .sort((left, right) => pipelineOperationalScore(right) - pipelineOperationalScore(left)
      || String(right.latestUpdatedAt || '').localeCompare(String(left.latestUpdatedAt || '')))[0] || null;
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
  if (state.deploymentKind === 'oversea') {
    renderOverseaWorkbench(pipelines);
    return;
  }
  const sites = deploymentSites(pipelines, state.deploymentKind);
  deploymentSiteCount.textContent = `${sites.length} sites`;
  if (!state.selectedSiteId && sites[0]) state.selectedSiteId = sites[0].siteId;
  const site = sites.find((item) => item.siteId === state.selectedSiteId) || sites[0] || null;
  if (!site?.activePipeline) {
    siteWorkbench.innerHTML = `<div class="empty-state">No ${escapeHtml(state.deploymentKind)} site yet</div>`;
    renderInspector();
    return;
  }
  syncSshProfileFormToSelectedSite(site.siteId, site.kind);
  const pipeline = site.activePipeline;
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
  `;
  renderInspector();
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
      const active = activePipelineForCurrentDeployment(pipelines);
      if (active?.planId) {
        void refreshPipelineDetail(active.planId);
      } else {
        state.selectedPlanId = null;
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
  if (profile && selectedSshProfileId() !== profile.profileId) {
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
    body = renderUserCenterPanel() + renderUserOverseaSubscriptionPanel() + renderUserServiceAccessPanel() + renderOverseaEntitlementPanel() + renderUserIntegrationPanel();
  } else if (activeId === 'rbac') {
    body = renderRbacPanel() + renderPermissionRegistryPanel() + renderExternalSystemContractPanel();
  } else if (activeId === 'config-center') {
    body = renderConfigCenterPanel(overview || {});
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
  const createUser = foundationGrid.querySelector('[data-user-create]');
  if (createUser) createUser.addEventListener('click', () => void createUserFromAdmin());
  const overseaUserSelect = foundationGrid.querySelector('[data-oversea-user]');
  if (overseaUserSelect) {
    overseaUserSelect.addEventListener('change', () => {
      state.userCenter.selectedOverseaUserId = overseaUserSelect.value || null;
      renderFoundationGrid(state.dashboard?.overview || overview || {});
    });
  }
  const assignOversea = foundationGrid.querySelector('[data-oversea-assign]');
  if (assignOversea) assignOversea.addEventListener('click', () => void assignUserOverseaFromAdmin());
  const syncOverseaUser = foundationGrid.querySelector('[data-oversea-sync-user]');
  if (syncOverseaUser) syncOverseaUser.addEventListener('click', () => void syncUserOverseaRuntimeFromAdmin());
  const enrollRelay = foundationGrid.querySelector('[data-relay-enroll]');
  if (enrollRelay) enrollRelay.addEventListener('click', () => void enrollHomeRelayFromAdmin());
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
      description: 'Internal CoreDNS authority、split DNS、Domestic edge cache。'
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

function renderUserOverseaSyncChips(accounts) {
  const list = asArray(accounts);
  if (!list.length) return '<span class="foundation-chip" data-tone="muted">-</span>';
  return `
    <span class="foundation-chip-row">
      ${list.map((account) => {
        const status = account.runtimeSync?.status || 'unknown';
        return `<span class="foundation-chip" data-tone="${escapeHtml(runtimeSyncTone(status))}" title="${escapeHtml(account.runtimeSync?.reason || account.username || status)}">${escapeHtml(`${account.siteId}: ${status}`)}</span>`;
      }).join('')}
    </span>
  `;
}

function runtimeSyncTone(status) {
  if (status === 'synced') return 'success';
  if (status === 'pending-sync') return 'warning';
  if (status === 'no-runtime-evidence') return 'danger';
  return 'muted';
}

function renderUserCenterPanel() {
  const roles = asArray(state.userCenter.roles);
  const users = asArray(state.userCenter.users);
  const roleOptions = roles.map((role) => `
    <option value="${escapeHtml(role.roleId)}">${escapeHtml(role.displayName || role.roleId)}</option>
  `).join('');
  const feedback = state.userCenter.feedback;
  return `
    <section class="foundation-panel foundation-wide">
      <div class="foundation-panel-head">
        <div>
          <h4>User registry</h4>
          <p>用户、服务账号、设备身份和外部系统 token 都从这里拿到统一 subject，再进入 RBAC 和发布门禁。</p>
        </div>
        <span>${escapeHtml(users.length)} users</span>
      </div>
      <div class="foundation-operation-grid">
        <label class="form-field">
          <span>Email</span>
          <input data-user-field="email" autocomplete="off" placeholder="user@example.com" />
        </label>
        <label class="form-field">
          <span>Display Name</span>
          <input data-user-field="displayName" autocomplete="off" placeholder="MX User" />
        </label>
        <label class="form-field">
          <span>Role</span>
          <select data-user-field="roleId">
            ${roleOptions || '<option value="">bootstrap roles first</option>'}
          </select>
        </label>
      </div>
      <div class="foundation-operation-actions">
        <button class="secondary-button" type="button" data-user-bootstrap ${state.userCenter.busy ? 'disabled' : ''}>Bootstrap Users</button>
        <button class="primary-button" type="button" data-user-create ${state.userCenter.busy ? 'disabled' : ''}>Create User</button>
        ${feedback ? `<span class="profile-feedback" data-kind="${escapeHtml(feedback.kind)}">${escapeHtml(feedback.message)}</span>` : ''}
      </div>
      <div class="foundation-table user-center-table">
        <article class="foundation-table-row is-header">
          <strong>User</strong>
          <span>Identity</span>
          <span>Roles</span>
          <span>Enabled services</span>
          <span>Internal usage</span>
          <small>Oversea</small>
        </article>
        ${users.map((user) => `
          <article class="foundation-table-row">
            <strong>${escapeHtml(user.displayName || user.userId)}</strong>
            <span>${escapeHtml(`${user.email || user.userId} / ${userKind(user)} / ${user.status || 'active'}`)}</span>
            <span>${renderChipList(asArray(user.roleIds).map(roleLabel), 'info')}</span>
            <span>${renderChipList(userEnabledServices(user).slice(0, 4), 'success')}</span>
            <span>${escapeHtml(userInternalUsage(user))}</span>
            <small>${escapeHtml(userOverseaAccess(user))}</small>
          </article>
        `).join('') || '<div class="empty-state">No users yet</div>'}
      </div>
    </section>
  `;
}

function renderUserOverseaSubscriptionPanel() {
  const users = asArray(state.userCenter.users);
  const sites = overseaAuthoritySites();
  const activeEntitlements = asArray(state.userCenter.overseaEntitlements).filter((item) => item.status === 'active');
  const selectedUserId = state.userCenter.selectedOverseaUserId
    || activeEntitlements[0]?.userId
    || users[0]?.userId
    || '';
  const selectedEntitlement = entitlementForUser(selectedUserId);
  const selectedSiteIds = new Set(asArray(selectedEntitlement?.siteIds));
  const feedback = state.userCenter.overseaFeedback;
  const subscriptionUrl = selectedEntitlement?.status === 'active'
    ? userOverseaSubscriptionUrl(selectedUserId)
    : '';
  const selectedSyncAccounts = selectedEntitlement?.status === 'active'
    ? asArray(selectedEntitlement.accounts)
    : [];
  return `
    <section class="foundation-panel foundation-wide">
      <div class="foundation-panel-head">
        <div>
          <h4>User Oversea subscriptions</h4>
          <p>创建用户后，在这里分配可用 Oversea site。Internal 会为每个 site 发行用户专属 hysteria2 account，并生成一个聚合 mihomo 订阅。</p>
        </div>
        <span>${escapeHtml(String(activeEntitlements.length))} active</span>
      </div>
      <div class="foundation-operation-grid user-oversea-grid">
        <label class="form-field">
          <span>User</span>
          <select data-oversea-user ${users.length ? '' : 'disabled'}>
            ${users.map((user) => `
              <option value="${escapeHtml(user.userId)}" ${user.userId === selectedUserId ? 'selected' : ''}>
                ${escapeHtml(user.displayName || user.email || user.userId)}
              </option>
            `).join('') || '<option value="">create a user first</option>'}
          </select>
        </label>
        <div class="form-field wide-field">
          <span>Allowed Oversea sites</span>
          <div class="foundation-checkbox-grid">
            ${sites.map((siteId) => `
              <label class="foundation-checkbox-option">
                <input type="checkbox" data-oversea-site value="${escapeHtml(siteId)}" ${selectedSiteIds.has(siteId) ? 'checked' : ''} />
                <span>${escapeHtml(siteId)}</span>
              </label>
            `).join('') || '<span class="oversea-boundary-note">No Oversea mihomo site is ready yet. Install / Sync an Oversea first.</span>'}
          </div>
        </div>
      </div>
      <div class="foundation-operation-actions">
        <button class="primary-button" type="button" data-oversea-assign ${state.userCenter.overseaBusy || !selectedUserId || !sites.length ? 'disabled' : ''}>
          ${state.userCenter.overseaBusy ? 'Assigning' : selectedSiteIds.size ? 'Assign / Issue' : 'Disable Access'}
        </button>
        <button class="secondary-button" type="button" data-oversea-sync-user ${state.userCenter.overseaBusy || state.userCenter.overseaSyncBusy || !selectedUserId || !selectedSyncAccounts.length ? 'disabled' : ''}>
          ${state.userCenter.overseaSyncBusy ? 'Syncing User' : 'Sync User Remote'}
        </button>
        ${feedback ? `<span class="profile-feedback" data-kind="${escapeHtml(feedback.kind)}">${escapeHtml(feedback.message)}</span>` : ''}
      </div>
      <div class="foundation-subscription-url">
        <span>Subscription URL</span>
        <code>${escapeHtml(subscriptionUrl || 'Assign one or more Oversea sites to generate a user subscription URL')}</code>
      </div>
      <div class="foundation-subscription-url">
        <span>Runtime sync</span>
        <code>${selectedSyncAccounts.length ? escapeHtml(selectedSyncAccounts.map((account) => `${account.siteId}:${account.runtimeSync?.status || 'unknown'}`).join(' / ')) : 'No runtime account selected'}</code>
      </div>
      <div class="foundation-table user-subscription-table">
        <article class="foundation-table-row is-header">
          <strong>User</strong>
          <span>Sites</span>
          <span>Runtime sync</span>
          <small>Subscription</small>
        </article>
        ${asArray(state.userCenter.overseaEntitlements).map((entitlement) => `
          <article class="foundation-table-row">
            <strong>${escapeHtml(users.find((user) => user.userId === entitlement.userId)?.displayName || entitlement.userId)}</strong>
            <span>${renderChipList(asArray(entitlement.siteIds), 'success')}</span>
            <span>${renderUserOverseaSyncChips(entitlement.accounts)}</span>
            <small>${escapeHtml(entitlement.status === 'active' ? userOverseaSubscriptionUrl(entitlement.userId) : 'disabled')}</small>
          </article>
        `).join('') || '<div class="empty-state">No user Oversea entitlement yet</div>'}
      </div>
    </section>
  `;
}

function renderUserServiceAccessPanel() {
  const rows = [
    ['Launcher Runtime', 'login / device identity / AppCenter host', 'User Center subject + device binding', 'login, update, network traces'],
    ['AppCenter', 'install H2O and future apps', 'entitlement + app release channel', 'app install evidence'],
    ['H2O', 'consume Launcher Network and app config', 'app permission manifest', 'E2E + runtime logs'],
    ['Oversea Access', 'hysteria2 subscription, site group, node switch', 'oversea.access.use + subscription issue policy', 'subscription issue + node health'],
    ['Domestic Relay', 'WG/H2I/DNS reachability for H endpoints', 'relay lease + device enrollment', 'relay lease evidence'],
    ['SDK Gateway', 'external systems call Internal APIs', 'service account + route scopes', 'token introspection + API audit']
  ];
  return `
    <section class="foundation-panel foundation-wide">
      <div class="foundation-panel-head">
        <div>
          <h4>Service access matrix</h4>
          <p>User Center 不只是用户表，它还记录用户开通了哪些服务、经过哪些内部系统、由哪些证据闭环。</p>
        </div>
        <span>entitlement model</span>
      </div>
      <div class="foundation-table service-access-table">
        <article class="foundation-table-row is-header">
          <strong>Service</strong>
          <span>Capability</span>
          <span>Grant source</span>
          <small>Evidence</small>
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
    </section>
  `;
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

function renderOverseaEntitlementPanel() {
  const sites = overseaAuthoritySites();
  const rows = [
    ['Site group', sites.length ? sites.join(' / ') : 'oversea sites pending', '一个订阅可以包含多台 Oversea 节点，用户在 Clash/Launcher Network 内切换。'],
    ['Account issue', 'user-scoped + bootstrap accounts', '预设账号保留，真实用户访问走 User Center entitlement 和可吊销凭证。'],
    ['Subscription authority', 'Internal mihomo', 'Internal 生成 YAML，Oversea 仅提供 Docker hysteria2 runtime 和健康证据出口。'],
    ['Runtime check', 'hysteria2 + health exporter', 'Stack Status 只看 Docker runtime；3434 定位为健康和证据出口，不做订阅真相。'],
    ['Revoke / rotate', 'RBAC action gate', '禁用用户或撤销 oversea.access.use 后，订阅凭证旋转并写入 Evidence History。']
  ];
  return `
    <section class="foundation-panel foundation-wide">
      <div class="foundation-panel-head">
        <div>
          <h4>Oversea entitlement</h4>
          <p>刚跑通的 Oversea 部署会接入 User Center / RBAC：用户可开通 Oversea，选择站点组，订阅由 Internal 生成和审计。</p>
        </div>
        <span>${escapeHtml(String(sites.length))} sites</span>
      </div>
      ${renderFoundationRows(rows)}
    </section>
  `;
}

function renderUserIntegrationPanel() {
  const endpoints = [
    ['Identity API', 'POST /internal/v1/user-center/tokens/introspect', '外部系统验证用户、服务账号、设备身份。'],
    ['Entitlement API', 'GET /internal/v1/user-center/users/:id/services', '查询 Launcher、H2O、Oversea、SDK Gateway 的服务开通状态。'],
    ['Subscription API', 'GET /internal/v1/launcher-network/mihomo/sites/:site/account/:account.yaml', 'H 端通过 Internal/Domestic 路径获取 mihomo 配置。'],
    ['Audit API', 'GET /internal/v1/evidence?subject=:id', '统一拉取用户、权限、发版、订阅和远程执行证据。']
  ];
  return `
    <section class="foundation-panel">
      <div class="foundation-panel-head">
        <div>
          <h4>API surface</h4>
          <p>自有系统和外部客户系统都用同一组接口接入 Internal。</p>
        </div>
      </div>
      ${renderFoundationRows(endpoints)}
    </section>
    ${renderRelayEnrollmentPanel()}
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

function renderRelayEnrollmentPanel() {
  const result = state.relayEnrollment.result;
  const feedback = state.relayEnrollment.feedback;
  const siteId = state.deploymentKind === 'domestic'
    ? selectedDomesticSiteId()
    : 'domestic-main';
  return `
    <section class="foundation-operation-panel">
      <div class="section-title compact-title">
        <h4>Home Relay Enrollment</h4>
        <span>${escapeHtml(state.domesticPeerDraft.leaseIp || result?.overlayIp || '10.91')}</span>
      </div>
      <div class="foundation-operation-grid relay-operation-grid">
        <label class="form-field">
          <span>Domestic Site</span>
          <input data-relay-field="siteId" autocomplete="off" value="${escapeHtml(siteId)}" />
        </label>
        <label class="form-field">
          <span>Install ID</span>
          <input data-relay-field="installId" autocomplete="off" placeholder="optional" />
        </label>
        <label class="form-field">
          <span>Device ID</span>
          <input data-relay-field="deviceId" autocomplete="off" placeholder="optional" />
        </label>
        <label class="form-field wide-field">
          <span>Home WG Public Key</span>
          <input data-relay-field="publicKey" autocomplete="off" value="${escapeHtml(state.domesticPeerDraft.publicKey)}" placeholder="base64 public key" />
        </label>
      </div>
      <div class="foundation-operation-actions">
        <button class="primary-button" type="button" data-relay-enroll ${state.relayEnrollment.busy ? 'disabled' : ''}>
          ${state.relayEnrollment.busy ? 'Enrolling' : 'Create Relay Lease'}
        </button>
        ${feedback ? `<span class="profile-feedback" data-kind="${escapeHtml(feedback.kind)}">${escapeHtml(feedback.message)}</span>` : ''}
      </div>
      <div class="foundation-list">
        <article>
          <strong>${escapeHtml(state.domesticPeerDraft.leaseIp || result?.overlayIp || '-')}</strong>
          <span>${escapeHtml(result?.anonymousPrincipalId || 'guest relay peer')}</span>
          <small>${escapeHtml(state.domesticPeerDraft.publicKey || result?.publicKey || '-')}</small>
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
  const health = normalizeStageStatus(summary?.health || selectedSite?.status || 'ready');

  inspectorKind.textContent = kind;
  inspectorTitle.textContent = title;
  inspectorMeta.textContent = inspectorMetaText(summary, selectedSite);
  inspectorStatus.textContent = summary?.health || selectedSite?.status || 'ready';
  inspectorStatus.dataset.health = health;
  inspectorFacts.innerHTML = renderInspectorFacts([
    ['Host', selectedSite?.host || profile?.host || '-'],
    ['SSH Profile', selectedSite?.sshProfile?.profileId || profile?.profileId || '-'],
    ['Provider', consoleProviderLabel(dashboard)],
    ['OS Scope', 'Ubuntu + CentOS/RHEL'],
    ['Stage', summary?.currentStage || '-'],
    ['Latest', summary?.latestStatus || selectedSite?.status || '-'],
    ['Updated', formatTime(summary?.latestUpdatedAt)],
    ['Objects', summary ? String(pipelineObjectCount(summary)) : '-']
  ]);
  inspectorNext.innerHTML = renderInspectorNextAction(summary, selectedSite);
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
  const sites = deploymentSites(pipelines, state.deploymentKind);
  pipelineCount.textContent = String(sites.length);
  if (sites.length === 0) {
    pipelineList.innerHTML = `<div class="empty-state">No ${escapeHtml(state.deploymentKind)} sites</div>`;
    return;
  }
  pipelineList.innerHTML = sites.map((site) => {
    const pipeline = site.activePipeline;
    return `
    <button class="pipeline-item ${site.siteId === state.selectedSiteId ? 'is-selected' : ''}" type="button" data-site-id="${escapeHtml(site.siteId)}" data-plan-id="${escapeHtml(pipeline.planId)}">
      <span class="pipeline-top">
        <strong>${escapeHtml(site.siteId)}</strong>
        <span class="health-chip" data-health="${escapeHtml(pipeline.health)}">${escapeHtml(pipeline.health)}</span>
      </span>
      <span class="pipeline-meta">${escapeHtml(site.kind)} / ${escapeHtml(pipeline.currentStage)} / ${escapeHtml(pipeline.latestStatus)}</span>
      <span class="pipeline-counts">${pipelineObjectCount(pipeline)} active objects / ${site.pipelines.length} history</span>
    </button>
  `;
  }).join('');
  for (const item of pipelineList.querySelectorAll('.pipeline-item')) {
    item.addEventListener('click', () => {
      state.selectedSiteId = item.dataset.siteId || null;
      void refreshPipelineDetail(item.dataset.planId);
    });
  }
}

function renderPipelineSelection() {
  for (const item of pipelineList.querySelectorAll('.pipeline-item')) {
    item.classList.toggle('is-selected', item.dataset.siteId === state.selectedSiteId);
  }
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
  const actionText = nextAction ? actionGuidanceText(nextAction) : '当前没有可执行 gate。可以刷新或查看 Evidence History。';
  const runState = setupRunViewState(nextAction);
  setupGuide.innerHTML = `
    <section class="setup-guide-card" data-ready="${nextAction?.allowed ? 'true' : 'false'}">
      <div>
        <span class="site-kind">Setup Assistant</span>
        <strong>${escapeHtml(runState.title || setupHeadline(summary, nextAction))}</strong>
        <p>${escapeHtml(runState.message || actionText)}</p>
        ${renderSetupRunProgress()}
        ${renderAwxSummaryPanel(setupAwxSummary(), 'setup')}
      </div>
      <div class="setup-guide-actions">
        <button class="primary-button" type="button" data-setup-continue ${nextAction?.allowed && !state.actionBusy && !state.setupRun.active ? '' : 'disabled'}>
          ${escapeHtml(runState.buttonLabel)}
        </button>
        ${state.setupRun.active ? '<button class="secondary-button" type="button" data-setup-stop>Stop</button>' : ''}
        <button class="secondary-button" type="button" data-setup-refresh>Refresh</button>
      </div>
    </section>
  `;
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
    return {
      done: true,
      status: 'failed',
      stepStatus: 'failed',
      message: `${summary.siteId || 'slot'} failed at ${summary.currentStage || 'pipeline'}.`
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
    'site-slot.runner.awx-shadow': '创建 AWX runner session，后续会挂 worker job 并同步 AWX objects。',
    'site-slot.runner.remote-ssh': '创建 Remote SSH runner session，由 Internal 直接把 slot artifact 和配置下发到远端。',
    'site-slot.runner.simulate': '创建模拟 runner session，用于本机 shadow 验证。',
    'site-slot.worker-job.create': '创建 worker job。Oversea 默认走 Remote SSH handoff；AWX 保留在高级 provider 面。',
    'site-slot.worker-run.awx-sync-plan': '生成 AWX 对象计划，先预览 inventory、credential、job template 名称。',
    'site-slot.worker-run.awx-credential-sync': '把当前 SSH Profile 写成 AWX Machine Credential，需要确认和 API token。',
    'site-slot.worker-run.awx-object-sync': '在 AWX 中创建/更新 organization、project、inventory、host 和 job template。',
    'site-slot.worker-run.awx-launch': '提交 AWX job，真正执行 Ansible 并把结果回写成 worker report。',
    'site-slot.worker-run.remote-ssh-gate': '先检查 Remote SSH 执行边界和 SSH Profile，不会改远端主机。',
    'site-slot.worker-run.remote-ssh-readonly-probe': '通过 SSH 做只读探测，收集 OS、Docker、磁盘和访问栈状态证据。',
    'site-slot.worker-run.remote-ssh-execute': '通过 Remote SSH 执行 Internal-controlled artifact push 和远端 worker，同步 Oversea Docker hysteria2。',
    'site-slot.worker-run.artifact-push-remote-ssh-plan': '生成 Remote SSH artifact push 计划报告，便于审计下发内容。',
    'site-slot.domestic-relay-peer-append-awx.prepare': '为 Domestic relay peer append 准备 AWX worker job。',
    'site-slot.worker-run.domestic-relay-readonly-probe': '先只读检查 Domestic WG relay 状态。',
    'site-slot.worker-run.domestic-relay-peer-append': '生成 Home peer append handoff，确认 lease/public key 和安全边界。'
  };
  return map[action.actionId] || `${action.gate || 'gate'} / ${action.reason || 'review next action'}`;
}

function preferredNextAction(actions) {
  const preferred = actionFromFocus(actions, state.preferredActionFocus);
  return preferred || defaultPreferredAction(actions) || actions.find((action) => action.allowed) || actions[0];
}

function defaultPreferredAction(actions) {
  const candidates = asArray(actions).filter((action) => action.allowed);
  const priority = [
    'site-slot.preflight.create',
    'site-slot.apply.confirm',
    'site-slot.runner.remote-ssh',
    'site-slot.runner.awx-shadow',
    'site-slot.runner.simulate',
    'site-slot.worker-job.create',
    'site-slot.worker-run.remote-ssh-gate',
    'site-slot.worker-run.remote-ssh-readonly-probe',
    'site-slot.worker-run.remote-ssh-execute',
    'site-slot.worker-run.artifact-push-remote-ssh-plan',
    'site-slot.worker-run.awx-sync-plan',
    'site-slot.worker-run.awx-credential-sync',
    'site-slot.worker-run.awx-object-sync',
    'site-slot.worker-run.awx-launch',
    'site-slot.worker-run.awx-shadow',
    'site-slot.domestic-relay-peer-append-awx.prepare',
    'site-slot.domestic-relay-peer-append-ssh.prepare',
    'site-slot.worker-run.domestic-relay-readonly-probe',
    'site-slot.worker-run.domestic-relay-peer-append',
    'site-slot.worker-run.domestic-relay-peer-append-ssh'
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
  if (bodyObject) prepareAwxActionDraft(action, bodyObject);
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
          ${action.confirmFields.map((field) => `
            <label>
              <input type="checkbox" data-confirm-field="${escapeHtml(field)}" />
              <span>${escapeHtml(field)}</span>
            </label>
          `).join('')}
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
  if (!action || !action.allowed || state.actionBusy) return { ok: false, error: new Error('No executable action selected.') };
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
      void continueSetupRun();
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

function materializeActionBodyTemplate(action) {
  const now = new Date();
  const changeWindowStart = now.toISOString();
  const changeWindowEnd = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
  const requestId = `desktop-${String(action?.actionId || 'admin-action').replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
  const body = replaceActionTemplateValue(action?.bodyTemplate || {}, {
    '<change-window-start-iso>': changeWindowStart,
    '<change-window-end-iso>': changeWindowEnd,
    '<internal-base-url>': normalizedServerBase(),
    '<home-lease-ip>': state.domesticPeerDraft.leaseIp || '<home-lease-ip>',
    '<home-wg-public-key>': state.domesticPeerDraft.publicKey || '<home-wg-public-key>',
    '<request-id>': requestId
  });
  return awxActionBodyDefaults(action, body);
}

function replaceActionTemplateValue(value, replacements) {
  if (Array.isArray(value)) return value.map((item) => replaceActionTemplateValue(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceActionTemplateValue(item, replacements)]));
  }
  if (typeof value !== 'string') return value;
  return replacements[value] || value;
}

function actionBodyForExecution(action) {
  const text = state.selectedAction && sameAction(state.selectedAction, action) && state.selectedActionBody
    ? state.selectedActionBody
    : formatJson(materializeActionBodyTemplate(action));
  if (!isActionBodyExecutable(text)) {
    throw new Error('Action body JSON is invalid or still contains placeholders.');
  }
  const body = JSON.parse(text);
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

function renderHomePeerQuickFields(bodyText) {
  const body = parseActionBodyObject(bodyText);
  const hasHomePeer = body && ('leaseIp' in body || 'publicKey' in body || 'peerRole' in body);
  if (!hasHomePeer) return '';
  const peerRole = body.peerRole === 'user' || body.peerRole === 'guest'
    ? body.peerRole
    : state.domesticPeerDraft.peerRole;
  const leaseIp = typeof body.leaseIp === 'string' && !hasUnresolvedActionPlaceholder(body.leaseIp)
    ? body.leaseIp
    : state.domesticPeerDraft.leaseIp;
  const publicKey = typeof body.publicKey === 'string' && !hasUnresolvedActionPlaceholder(body.publicKey)
    ? body.publicKey
    : state.domesticPeerDraft.publicKey;
  return `
    <section class="home-peer-fields" aria-label="Home relay peer">
      <label>
        <span>Peer Role</span>
        <select data-home-peer-field="peerRole">
          <option value="guest" ${peerRole === 'guest' ? 'selected' : ''}>guest / 10.91</option>
          <option value="user" ${peerRole === 'user' ? 'selected' : ''}>user / 10.89</option>
        </select>
      </label>
      <label>
        <span>Lease IP</span>
        <input data-home-peer-field="leaseIp" value="${escapeHtml(leaseIp)}" placeholder="10.91.x.y" />
      </label>
      <label>
        <span>WG Public Key</span>
        <input data-home-peer-field="publicKey" value="${escapeHtml(publicKey)}" placeholder="Home WireGuard public key" />
      </label>
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
  if (field === 'peerRole') {
    state.domesticPeerDraft.peerRole = input.value === 'user' ? 'user' : 'guest';
  } else if (field === 'leaseIp') {
    state.domesticPeerDraft.leaseIp = input.value.trim();
    if (state.domesticPeerDraft.leaseIp.startsWith('10.89.')) state.domesticPeerDraft.peerRole = 'user';
    if (state.domesticPeerDraft.leaseIp.startsWith('10.91.')) state.domesticPeerDraft.peerRole = 'guest';
  } else if (field === 'publicKey') {
    state.domesticPeerDraft.publicKey = input.value.trim();
  }
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
  if ('peerRole' in body) body.peerRole = state.domesticPeerDraft.peerRole;
  if ('leaseIp' in body) body.leaseIp = state.domesticPeerDraft.leaseIp || '<home-lease-ip>';
  if ('publicKey' in body) body.publicKey = state.domesticPeerDraft.publicKey || '<home-wg-public-key>';
  state.selectedActionBody = formatJson(body);
  bodyInput.value = state.selectedActionBody;
  const roleSelect = pipelineActions.querySelector('[data-home-peer-field="peerRole"]');
  if (roleSelect) roleSelect.value = state.domesticPeerDraft.peerRole;
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
  const leaseIp = typeof value.leaseIp === 'string' && !hasUnresolvedActionPlaceholder(value.leaseIp) ? value.leaseIp : null;
  const publicKey = typeof value.publicKey === 'string' && !hasUnresolvedActionPlaceholder(value.publicKey) ? value.publicKey : null;
  if (role === 'user' || role === 'guest') state.domesticPeerDraft.peerRole = role;
  if (leaseIp) {
    state.domesticPeerDraft.leaseIp = leaseIp;
    if (leaseIp.startsWith('10.89.')) state.domesticPeerDraft.peerRole = 'user';
    if (leaseIp.startsWith('10.91.')) state.domesticPeerDraft.peerRole = 'guest';
  }
  if (publicKey) state.domesticPeerDraft.publicKey = publicKey;
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
  const preparedAwxJobId = payload?.relayPeerAppendAwxPrepare?.jobId;
  if (preparedAwxJobId) {
    return {
      jobId: preparedAwxJobId,
      actionIds: [
        'site-slot.worker-run.domestic-relay-readonly-probe',
        'site-slot.worker-run.domestic-relay-peer-append',
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
        'site-slot.worker-run.domestic-relay-readonly-probe',
        'site-slot.worker-run.domestic-relay-peer-append',
        'site-slot.worker-run.domestic-relay-peer-append-ssh'
      ]
    };
  }
  const jobId = jobIdFromActionPath(action?.path);
  if (!jobId) return state.preferredActionFocus;
  if (action?.actionId === 'site-slot.worker-run.remote-ssh-gate' && payload?.gate?.verdict !== 'passed') {
    return { jobId, actionIds: ['site-slot.worker-run.remote-ssh-gate'] };
  }
  if (action?.actionId === 'site-slot.worker-run.domestic-relay-readonly-probe'
    && payload?.relayReadOnlyProbe?.status !== 'ready') {
    return { jobId, actionIds: ['site-slot.worker-run.domestic-relay-readonly-probe'] };
  }
  if (action?.actionId === 'site-slot.worker-run.domestic-relay-peer-append'
    && payload?.relayPeerAppend?.status !== 'ready') {
    return { jobId, actionIds: ['site-slot.worker-run.domestic-relay-peer-append'] };
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
    'site-slot.worker-run.domestic-relay-readonly-probe': ['site-slot.worker-run.domestic-relay-peer-append'],
    'site-slot.worker-run.domestic-relay-peer-append': ['site-slot.worker-run.awx-sync-plan', 'site-slot.worker-run.awx-credential-sync', 'site-slot.worker-run.awx-object-sync', 'site-slot.worker-run.awx-launch', 'site-slot.worker-run.awx-shadow', 'site-slot.worker-run.domestic-relay-peer-append-ssh'],
    'site-slot.worker-run.awx-sync-plan': ['site-slot.worker-run.awx-credential-sync', 'site-slot.worker-run.awx-object-sync', 'site-slot.worker-run.awx-launch', 'site-slot.worker-run.awx-shadow'],
    'site-slot.worker-run.awx-credential-sync': ['site-slot.worker-run.awx-object-sync', 'site-slot.worker-run.awx-launch'],
    'site-slot.worker-run.awx-object-sync': ['site-slot.worker-run.awx-launch', 'site-slot.worker-run.awx-sync-plan']
  };
  const actionIds = nextByActionId[action?.actionId];
  return actionIds ? { jobId, actionIds } : state.preferredActionFocus;
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
    || payload.fakeTransport
    || payload.workerHandoff
    || payload.readOnlyProbe
    || payload.gate
    || payload.result;
  const id = target?.id || created?.credentialSyncId || created?.objectSyncId || created?.syncPlanId || created?.awxLaunchId || created?.fakeTransportId || created?.handoffId || created?.probeId || created?.gateId || created?.snapshotId || created?.syncId || created?.applyId || action.actionId;
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
  const domesticHealth = combinedHealth(pipelines.filter((pipeline) => pipeline.kind === 'domestic'));
  const overseaHealth = combinedHealth(pipelines.filter((pipeline) => pipeline.kind === 'oversea'));
  const overallHealth = combinedHealth(pipelines);
  setTopologyNodeHealth('domestic', domesticHealth);
  setTopologyNodeHealth('internal', overallHealth);
  setTopologyNodeHealth('oversea', overseaHealth);
  setTopologyNodeHealth('h', overallHealth === 'failed' ? 'blocked' : 'ready');
  setTopologyLinkColor(0, overallHealth === 'failed' ? 'blocked' : domesticHealth);
  setTopologyLinkColor(1, overallHealth);
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
  const values = pipelines.map((pipeline) => pipeline.health);
  if (values.includes('failed')) return 'failed';
  if (values.includes('rollback')) return 'rollback';
  if (values.includes('blocked')) return 'blocked';
  if (values.includes('running')) return 'running';
  if (values.includes('passed')) return 'passed';
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
