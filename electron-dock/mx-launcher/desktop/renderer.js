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
  dashboard: null,
  selectedPlanId: null,
  currentActions: [],
  selectedAction: null,
  actionBusy: false,
  actionFeedback: null,
  currentPipeline: null,
  selectedTimelineEntryId: null,
  pendingEvidenceFocus: null,
  sshProfiles: [],
  selectedSshProfileId: null,
  sshProfileBusy: false,
  sshBootstrapBusy: false,
  sshPlanBusy: false,
  sshReadinessBusy: false,
  sshPolicyBusy: false,
  sshProfileBootstrap: null,
  sshProfileReadiness: null,
  sshRuntimePolicy: null,
  sshProfileFeedback: null,
  topology: null
};

const stateChip = document.getElementById('connection-state');
const hdoLaunch = document.getElementById('hdo-launch');
const hdoAdmin = document.getElementById('hdo-admin');
const hdoStatus = document.getElementById('hdo-status');
const serverInput = document.getElementById('server-input');
const platformStatus = document.getElementById('platform-status');
const appRefresh = document.getElementById('app-refresh');
const adminRefresh = document.getElementById('admin-refresh');
const adminGenerated = document.getElementById('admin-generated');
const pipelineList = document.getElementById('pipeline-list');
const pipelineCount = document.getElementById('pipeline-count');
const pipelineTimeline = document.getElementById('pipeline-timeline');
const pipelineSummary = document.getElementById('pipeline-summary');
const pipelineStepper = document.getElementById('pipeline-stepper');
const pipelineActions = document.getElementById('pipeline-actions');
const pipelineHealth = document.getElementById('pipeline-health');
const metricSiteSlots = document.getElementById('metric-site-slots');
const metricRollbacks = document.getElementById('metric-rollbacks');
const metricReleases = document.getElementById('metric-releases');
const metricTests = document.getElementById('metric-tests');
const sshProfileCount = document.getElementById('ssh-profile-count');
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
const sshProfileHostKeyAlias = document.getElementById('ssh-profile-host-key-alias');
const sshProfileSave = document.getElementById('ssh-profile-save');
const sshProfileBootstrap = document.getElementById('ssh-profile-bootstrap');
const sshProfileCreatePlan = document.getElementById('ssh-profile-create-plan');
const sshProfileFeedback = document.getElementById('ssh-profile-feedback');
const sshProfileBootstrapResult = document.getElementById('ssh-profile-bootstrap-result');
const sshProfileList = document.getElementById('ssh-profile-list');
const sshReadinessStatus = document.getElementById('ssh-readiness-status');
const sshProfileReadinessRun = document.getElementById('ssh-profile-readiness-run');
const sshProfilePolicyEnable = document.getElementById('ssh-profile-policy-enable');
const sshProfileReadiness = document.getElementById('ssh-profile-readiness');
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
    setActiveView(tab.dataset.view);
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

sshProfileForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void saveSshProfile();
});

sshProfileCreatePlan.addEventListener('click', () => {
  void createPlanFromSshProfile();
});

sshProfileBootstrap.addEventListener('click', () => {
  void bootstrapSshProfile();
});

sshProfileReadinessRun.addEventListener('click', () => {
  void checkSshProfileReadiness();
});

sshProfilePolicyEnable.addEventListener('click', () => {
  void allowSshProfileReadonlyPolicy();
});

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

function setActiveView(view) {
  state.activeView = view === 'admin' ? 'admin' : 'app-center';
  for (const tab of tabs) {
    tab.classList.toggle('is-active', tab.dataset.view === state.activeView);
  }
  for (const item of views) {
    item.classList.toggle('is-active', item.id === `view-${state.activeView}`);
  }
  if (state.activeView === 'admin' && !state.dashboard) {
    void refreshAdmin();
  }
  if (state.activeView === 'admin') {
    requestAnimationFrame(() => resizeTopology());
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
    const [dashboard, profilePayload] = await Promise.all([
      fetchJson('/internal/v1/admin/dashboard'),
      loadSshProfiles()
    ]);
    state.dashboard = dashboard;
    state.sshProfiles = asArray(profilePayload.profiles);
    const pipelines = dashboard.siteSlotPipelines || [];
    state.selectedPlanId = pipelines.some((item) => item.planId === state.selectedPlanId)
      ? state.selectedPlanId
      : pipelines[0]?.planId || null;
    primeSshProfileForm(pipelines);
    renderAdminDashboard(dashboard);
    if (state.selectedPlanId) {
      await refreshPipelineDetail(state.selectedPlanId);
    } else {
      renderEmptyPipeline();
    }
    setConnection('connected', 'Connected', `${dashboard.overview.siteId} / ${dashboard.overview.storeDriver}`);
  } catch (error) {
    state.dashboard = null;
    renderAdminError(error);
    setConnection('error', 'Offline', 'Admin API unavailable');
  }
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
    renderPipelineDetail(payload.pipeline);
    consumePendingEvidenceFocus(payload.pipeline);
  } catch (error) {
    pipelineSummary.textContent = error.message;
    pipelineStepper.innerHTML = '';
    pipelineActions.innerHTML = '';
    pipelineTimeline.innerHTML = '';
  }
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
    state.sshProfileReadiness = null;
    state.sshRuntimePolicy = null;
    state.sshProfileFeedback = {
      kind: 'success',
      message: saved ? `Saved ${saved.siteId} / ${saved.sshUser}@${saved.host || '-'}` : 'Saved profile'
    };
    const profilePayload = await loadSshProfiles();
    state.sshProfiles = asArray(profilePayload.profiles);
    renderSshProfiles(state.sshProfiles);
    if (saved) fillSshProfileForm(saved);
  } catch (error) {
    state.sshProfileFeedback = { kind: 'error', message: error.message };
    renderSshProfileFeedback();
  } finally {
    state.sshProfileBusy = false;
    renderSshProfileSaveState();
    renderSshProfileBootstrap();
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
    state.sshProfileFeedback = { kind: 'error', message: error.message };
    renderSshProfileFeedback();
  } finally {
    state.sshBootstrapBusy = false;
    renderSshProfileSaveState();
    renderSshProfileBootstrap();
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

async function checkSshProfileReadiness() {
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
  state.sshProfileFeedback = { kind: 'info', message: 'Checking SSH profile readiness' };
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  try {
    const payload = await fetchJson(`/internal/v1/config-center/site-slot-ssh-profiles/${encodeURIComponent(profileId)}/readiness-probe`, {
      method: 'POST',
      body: {
        confirmReadOnlyProbe: true,
        executeReadOnlyProbe: false,
        requestedBy: 'desktop-admin',
        requestId: `desktop-ssh-readiness-${Date.now()}`
      }
    });
    const readiness = payload.readiness || null;
    state.sshProfileReadiness = readiness;
    state.sshRuntimePolicy = readiness?.gates?.configGate?.policy || null;
    state.sshProfileFeedback = {
      kind: readiness && (readiness.status === 'ready' || readiness.status === 'passed') ? 'success' : 'error',
      message: readiness ? `Readiness ${readiness.status}` : 'Readiness unavailable'
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
    hostKeyAlias: blankToNull(sshProfileHostKeyAlias.value),
    strictHostKeyChecking: sshProfileStrict.value,
    connectTimeoutSeconds: positiveNumberOrNull(sshProfileTimeout.value) || 10,
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
    connectTimeoutSeconds: positiveNumberOrNull(sshProfileTimeout.value) || 20,
    rotateKey: sshProfileRotateKey.checked,
    scanHostKey: true,
    executeBootstrap: true,
    confirmBootstrap: true,
    requestedBy: 'desktop-admin',
    requestId: `desktop-ssh-bootstrap-${Date.now()}`
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

function renderSshProfiles(profiles) {
  const items = asArray(profiles);
  sshProfileCount.textContent = String(items.length);
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  renderSshProfileBootstrap();
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
  sshProfileTimeout.value = String(profile.connectTimeoutSeconds || 10);
  sshProfileIdentity.value = profile.identityFile || '';
  sshProfileKnownHosts.value = profile.knownHostsFile || '';
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
  sshProfileTimeout.value = '10';
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
  sshProfileBootstrap.disabled = state.sshProfileBusy || state.sshBootstrapBusy || !blankToNull(sshProfileSiteId.value) || !blankToNull(sshProfileHost.value);
  sshProfileBootstrap.textContent = state.sshBootstrapBusy ? 'Bootstrapping' : 'Bootstrap Key';
  sshProfileCreatePlan.disabled = state.sshProfileBusy || state.sshPlanBusy || !sshProfileId.value.trim();
  sshProfileCreatePlan.textContent = state.sshPlanBusy ? 'Creating' : 'Create Plan';
  sshProfileReadinessRun.disabled = state.sshProfileBusy || state.sshReadinessBusy || !selectedSshProfileId();
  sshProfileReadinessRun.textContent = state.sshReadinessBusy ? 'Checking' : 'Check Readiness';
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

function renderAdminLoading() {
  state.currentPipeline = null;
  state.sshProfileBootstrap = null;
  closeEvidenceDrawer();
  adminGenerated.textContent = 'Loading';
  sshProfileCount.textContent = '0';
  sshProfileList.innerHTML = '<div class="empty-state">Loading SSH profiles</div>';
  renderSshProfileFeedback();
  renderSshProfileSaveState();
  renderSshProfileBootstrap();
  renderSshProfileReadiness();
  pipelineList.innerHTML = '<div class="empty-state">Loading pipelines</div>';
  pipelineTimeline.innerHTML = '';
  pipelineSummary.textContent = '';
  pipelineStepper.innerHTML = '';
  pipelineActions.innerHTML = '';
}

function renderAdminError(error) {
  state.currentPipeline = null;
  state.sshProfileBootstrap = null;
  closeEvidenceDrawer();
  adminGenerated.textContent = 'Admin API unavailable';
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
  pipelineCount.textContent = '0';
  pipelineHealth.textContent = 'Offline';
  pipelineHealth.dataset.health = 'failed';
  pipelineList.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
  pipelineSummary.textContent = '';
  pipelineStepper.innerHTML = '';
  pipelineActions.innerHTML = '';
  pipelineTimeline.innerHTML = '';
}

function renderAdminDashboard(dashboard) {
  const overview = dashboard.overview || {};
  const principal = dashboard.actionPolicy?.principal;
  adminGenerated.textContent = principal
    ? `Snapshot ${formatTime(dashboard.generatedAt)} / ${principal.displayName}`
    : `Snapshot ${formatTime(dashboard.generatedAt)}`;
  metricSiteSlots.textContent = String(overview.siteSlotPlans || 0);
  metricRollbacks.textContent = String(overview.siteSlotRollbackExecutions || 0);
  metricReleases.textContent = String(overview.releaseManagementPlans || 0);
  metricTests.textContent = String(overview.testRuns || 0);
  renderSshProfiles(state.sshProfiles);
  renderPipelineList(dashboard.siteSlotPipelines || []);
  updateTopologyFromPipelines(dashboard.siteSlotPipelines || []);
}

function renderPipelineList(pipelines) {
  pipelineCount.textContent = String(pipelines.length);
  if (pipelines.length === 0) {
    pipelineList.innerHTML = '<div class="empty-state">No pipelines</div>';
    return;
  }
  pipelineList.innerHTML = pipelines.map((pipeline) => `
    <button class="pipeline-item ${pipeline.planId === state.selectedPlanId ? 'is-selected' : ''}" type="button" data-plan-id="${escapeHtml(pipeline.planId)}">
      <span class="pipeline-top">
        <strong>${escapeHtml(pipeline.siteId)}</strong>
        <span class="health-chip" data-health="${escapeHtml(pipeline.health)}">${escapeHtml(pipeline.health)}</span>
      </span>
      <span class="pipeline-meta">${escapeHtml(pipeline.kind)} / ${escapeHtml(pipeline.currentStage)} / ${escapeHtml(pipeline.latestStatus)}</span>
      <span class="pipeline-counts">${formatCounts(pipeline.counts)}</span>
    </button>
  `).join('');
  for (const item of pipelineList.querySelectorAll('.pipeline-item')) {
    item.addEventListener('click', () => {
      void refreshPipelineDetail(item.dataset.planId);
    });
  }
}

function renderPipelineSelection() {
  for (const item of pipelineList.querySelectorAll('.pipeline-item')) {
    item.classList.toggle('is-selected', item.dataset.planId === state.selectedPlanId);
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
  pipelineSummary.innerHTML = `
    <span><strong>${escapeHtml(summary.siteId)}</strong></span>
    <span>${escapeHtml(summary.kind)}</span>
    <span>${escapeHtml(summary.currentStage)}</span>
    <span>${escapeHtml(summary.latestStatus)}</span>
    <span>${formatTime(summary.latestUpdatedAt)}</span>
  `;
  const timeline = pipeline.timeline || [];
  pipelineStepper.innerHTML = renderPipelineStepper(pipeline);
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
  const { entry, object, steps, summary } = evidence;
  evidenceKind.textContent = entry.kind;
  evidenceTitle.textContent = entry.title;
  evidenceMeta.textContent = `${objectId(object, entry.kind)} / ${entry.status} / ${formatTime(entry.at)}`;
  evidenceSummary.innerHTML = renderEvidenceSummary(summary);
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
  const nextAction = actions.find((action) => action.allowed) || actions[0];
  const feedback = state.actionFeedback && state.actionFeedback.planId === state.selectedPlanId
    ? `<div class="action-feedback" data-kind="${escapeHtml(state.actionFeedback.kind)}">${escapeHtml(state.actionFeedback.message)}</div>`
    : '';
  pipelineActions.innerHTML = `
    <div class="action-title">
      <h4>Action Gates</h4>
      <span>${actions.filter((action) => action.allowed).length}/${actions.length}</span>
    </div>
    ${renderNextGate(nextAction)}
    <div class="action-grid">
      ${actions.map((action, index) => `
        <button
          class="admin-action ${action.allowed ? 'is-allowed' : 'is-locked'} ${selected && sameAction(action, selected) ? 'is-selected' : ''}"
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
  `;
  for (const button of pipelineActions.querySelectorAll('.admin-action')) {
    button.addEventListener('click', () => {
      const action = actions[Number(button.dataset.actionIndex)];
      if (!action || !action.allowed) return;
      state.selectedAction = action;
      state.actionFeedback = null;
      renderPipelineActions(actions);
    });
  }
  const nextButton = pipelineActions.querySelector('[data-action-next]');
  if (nextButton) {
    nextButton.addEventListener('click', () => {
      if (!nextAction?.allowed) return;
      state.selectedAction = nextAction;
      state.actionFeedback = null;
      renderPipelineActions(actions);
    });
  }
  const cancelButton = pipelineActions.querySelector('[data-action-cancel]');
  if (cancelButton) {
    cancelButton.addEventListener('click', () => {
      state.selectedAction = null;
      renderPipelineActions(actions);
    });
  }
  const executeButton = pipelineActions.querySelector('[data-action-execute]');
  if (executeButton) {
    const refreshExecuteState = () => {
      const checks = Array.from(pipelineActions.querySelectorAll('[data-confirm-field]'));
      executeButton.disabled = state.actionBusy || checks.some((input) => !input.checked);
    };
    for (const checkbox of pipelineActions.querySelectorAll('[data-confirm-field]')) {
      checkbox.addEventListener('change', refreshExecuteState);
    }
    executeButton.addEventListener('click', () => {
      void executeSelectedAction();
    });
    refreshExecuteState();
  }
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
      <button class="secondary-button" type="button" data-action-next ${action.allowed ? '' : 'disabled'}>Select</button>
    </section>
  `;
}

function renderActionConfirm(action) {
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
      <pre class="action-body">${escapeHtml(formatJson(action.bodyTemplate || {}))}</pre>
      <div class="action-controls">
        <button class="secondary-button" type="button" data-action-cancel>Cancel</button>
        <button class="primary-button" type="button" data-action-execute>${state.actionBusy ? 'Running' : 'Execute'}</button>
      </div>
    </section>
  `;
}

async function executeSelectedAction() {
  const action = state.selectedAction;
  if (!action || !action.allowed || state.actionBusy) return;
  state.actionBusy = true;
  renderPipelineActions(state.currentActions);
  try {
    const payload = await fetchJson('/internal/v1/admin/actions/execute', {
      method: 'POST',
      body: {
        actionId: action.actionId,
        path: action.path,
        body: action.bodyTemplate || {}
      }
    });
    state.actionFeedback = {
      planId: state.selectedPlanId,
      kind: 'success',
      message: summarizeActionPayload(action, payload)
    };
    state.pendingEvidenceFocus = evidenceFocusFromActionPayload(payload, state.selectedPlanId);
    if (state.pendingEvidenceFocus?.planId) state.selectedPlanId = state.pendingEvidenceFocus.planId;
    state.selectedAction = null;
    await refreshAdmin();
  } catch (error) {
    state.pendingEvidenceFocus = null;
    state.actionFeedback = {
      planId: state.selectedPlanId,
      kind: 'error',
      message: error.message
    };
    renderPipelineActions(state.currentActions);
  } finally {
    state.actionBusy = false;
    if (state.selectedAction) renderPipelineActions(state.currentActions);
  }
}

function evidenceFocusFromActionPayload(payload, planId) {
  const target = actionPayloadTarget(payload);
  if (target) return { planId: target.object.planId || planId || target.id, kind: target.kind, id: target.id };
  return null;
}

function summarizeActionPayload(action, payload) {
  const target = actionPayloadTarget(payload);
  const created = target?.object || payload.fakeTransport || payload.workerHandoff || payload.readOnlyProbe || payload.gate || payload.result;
  const id = target?.id || created?.fakeTransportId || created?.handoffId || created?.probeId || created?.gateId || created?.snapshotId || created?.syncId || created?.applyId || action.actionId;
  const status = created?.status || created?.verdict || created?.allowed;
  return status ? `${action.label}: ${id} / ${status}` : `${action.label}: ${id}`;
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
    const renderer = new THREE.WebGLRenderer({
      canvas: topologyCanvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);

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
      { id: 'h', label: 'H', name: 'H Endpoint', position: [-5.2, -0.9, 0], color: 0x4b7dff },
      { id: 'domestic', label: 'D', name: 'Domestic', position: [-2.0, 0.7, 0.4], color: 0x22c55e },
      { id: 'internal', label: 'I', name: 'Internal', position: [1.4, 0.1, -0.2], color: 0x2dd4bf },
      { id: 'oversea', label: 'O', name: 'Oversea', position: [4.9, 1.0, 0.2], color: 0xf97316 }
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
      const label = createTopologyLabel(spec.label, spec.name);
      label.position.set(0, -0.9, 0);
      group.add(halo, sphere, label);
      group.userData = { id: spec.id, baseScale: 1, color: spec.color, sphere, halo };
      root.add(group);
      nodes.set(spec.id, group);
    }

    const links = [
      createTopologyLink(nodes.get('h'), nodes.get('domestic'), 0x4b7dff),
      createTopologyLink(nodes.get('domestic'), nodes.get('internal'), 0x2dd4bf),
      createTopologyLink(nodes.get('internal'), nodes.get('oversea'), 0xf97316)
    ];
    for (const link of links) root.add(link.group);

    const starField = createStarField();
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

function createTopologyLabel(letter, name) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(255,255,255,0.94)';
  context.font = '700 34px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif';
  context.textAlign = 'center';
  context.fillText(letter, 128, 36);
  context.fillStyle = 'rgba(226,232,240,0.86)';
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

function createStarField() {
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
    color: 0x9ab6ff,
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
  if (health === 'failed') return 0xef4444;
  if (health === 'blocked') return 0xf59e0b;
  if (health === 'rollback') return 0xd946ef;
  if (health === 'running') return 0x38bdf8;
  if (health === 'passed') return 0x22c55e;
  return 0x2dd4bf;
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
