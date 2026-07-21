const electronApi = window.mxH2i || null;
const api = electronApi || createMockApi();
const root = document.getElementById('app');
const isWindows = api.platform === 'win32';
document.documentElement.dataset.platform = api.platform || 'browser';
const H2O_DEFAULT_TEST_URL = 'https://www.google.com';
const H2O_TEST_PRESETS = [
  { id: 'google', label: 'Google', url: H2O_DEFAULT_TEST_URL },
  { id: 'youtube', label: 'YouTube', url: 'https://www.youtube.com' },
  { id: 'x', label: 'X / Twitter', url: 'https://x.com' },
  { id: 'telegram', label: 'Telegram', url: 'https://web.telegram.org' }
];
const H2O_RULE_PACKS = [
  {
    id: 'google',
    label: 'Google',
    kind: 'allow',
    hosts: ['google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com', 'ggpht.com', 'google-analytics.com', 'doubleclick.net']
  },
  {
    id: 'youtube',
    label: 'YouTube',
    kind: 'allow',
    hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com', 'ytimg.com', 'youtubei.googleapis.com', 'youtube.googleapis.com', 'ggpht.com']
  },
  {
    id: 'x',
    label: 'X / Twitter',
    kind: 'allow',
    hosts: ['x.com', 'twitter.com', 't.co', 'twimg.com', 'abs.twimg.com', 'pbs.twimg.com', 'video.twimg.com']
  },
  {
    id: 'telegram',
    label: 'Telegram',
    kind: 'allow',
    hosts: ['telegram.org', 't.me', 'telegram.me', 'telegra.ph', 'web.telegram.org', 'tdesktop.com']
  }
];

let state = null;
let busyAction = '';
let screen = 'launcher';
let modeDraft = 'guest';
let windowDrag = null;
let windowDragSequence = 0;
let appSearch = '';
let appCategory = 'all';
let selectedAppId = 'h2o';
let appCenterRoute = 'catalog';
let h2oManagerView = 'overview';
let appDebugOpen = false;
let foundationOpen = false;
let appShellMenuOpen = false;
let phoneMenuOpen = false;
let appInspectorCollapsed = false;
let appGridScrollTop = 0;
let h2oTestUrlDraft = H2O_DEFAULT_TEST_URL;
let h2oSubscriptionEditId = '';
let h2oSubscriptionDraft = defaultH2oSubscriptionDraft();
const EMPLOYEE_ACCOUNT_HISTORY_KEY = 'mx-h2i.employeeAccountHistory';
const EMPLOYEE_ACCOUNT_HISTORY_LIMIT = 10;
let employeeLoginDraft = { account: '', password: '' };
let employeeAccountHistory = readEmployeeAccountHistory();

void boot();

async function boot() {
  state = await api.getState();
  if (isWindows) await api.setWindowMode?.('launcher');
  modeDraft = state.connection?.mode === 'employee' ? 'employee' : 'guest';
  syncEmployeeLoginDraftFromState();
  render();
  if (typeof api.onState === 'function') {
    api.onState((next) => {
      state = next;
      syncEmployeeLoginDraftFromState();
      render();
    });
  }
}

root.addEventListener('click', (event) => {
  const control = event.target.closest('[data-window-control]');
  if (control) {
    void api.windowControl?.(control.dataset.windowControl);
    return;
  }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  rememberAppGridScroll();
  if (button.dataset.appId && action !== 'select-app') {
    selectedAppId = button.dataset.appId;
  }
  if (action === 'phone-back') {
    handlePhoneBack();
    return;
  }
  if (action === 'toggle-phone-menu') {
    phoneMenuOpen = !phoneMenuOpen;
    appShellMenuOpen = false;
    render();
    return;
  }
  if (action === 'switch-phone-shell') {
    phoneMenuOpen = false;
    const target = button.dataset.target || 'h2i';
    if (target === 'appcenter') {
      if (state.apps?.appcenter?.installed) {
        void setScreen('appcenter');
      } else {
        void runAction('installAppCenter');
      }
      return;
    }
    if (target === 'close') {
      void api.windowControl?.('close');
      return;
    }
    void setScreen('launcher');
    return;
  }
  if (action === 'select-mode') {
    phoneMenuOpen = false;
    modeDraft = button.dataset.mode === 'employee' ? 'employee' : 'guest';
    render();
    return;
  }
  if (action === 'show-launcher') {
    phoneMenuOpen = false;
    appShellMenuOpen = false;
    void setScreen('launcher');
    return;
  }
  if (action === 'show-advanced') {
    phoneMenuOpen = false;
    appShellMenuOpen = false;
    void setScreen('advanced');
    return;
  }
  if (action === 'show-appcenter') {
    phoneMenuOpen = false;
    appShellMenuOpen = false;
    if (state.apps?.appcenter?.installed) {
      void setScreen('appcenter');
    } else {
      void runAction('installAppCenter');
    }
    return;
  }
  if (action === 'select-app') {
    phoneMenuOpen = false;
    appCenterRoute = 'catalog';
    appInspectorCollapsed = false;
    selectedAppId = button.dataset.appId || selectedAppId;
    render();
    return;
  }
  if (action === 'show-app-catalog') {
    appCenterRoute = 'catalog';
    appInspectorCollapsed = false;
    appShellMenuOpen = false;
    render();
    return;
  }
  if (action === 'showH2oManager') {
    selectedAppId = 'h2o';
    appCenterRoute = 'h2o';
    appInspectorCollapsed = true;
    appShellMenuOpen = false;
    render();
    return;
  }
  if (action === 'set-h2o-view') {
    h2oManagerView = button.dataset.view || 'overview';
    appShellMenuOpen = false;
    render();
    return;
  }
  if (action === 'toggle-foundation-panel') {
    foundationOpen = !foundationOpen;
    appShellMenuOpen = false;
    render();
    return;
  }
  if (action === 'toggle-app-shell-menu') {
    appShellMenuOpen = !appShellMenuOpen;
    render();
    return;
  }
  if (action === 'switch-app-shell') {
    appShellMenuOpen = false;
    const target = button.dataset.target || 'appcenter';
    if (target === 'h2i') {
      void setScreen('launcher');
      return;
    }
    if (target === 'appcenter') {
      void setScreen('appcenter');
      return;
    }
    if (target === 'close') {
      void setScreen('launcher');
      return;
    }
  }
  if (action === 'set-app-category') {
    appCategory = button.dataset.category || 'all';
    appCenterRoute = 'catalog';
    appInspectorCollapsed = false;
    appGridScrollTop = 0;
    appShellMenuOpen = false;
    render();
    return;
  }
  if (action === 'toggle-app-debug') {
    appDebugOpen = !appDebugOpen;
    appShellMenuOpen = false;
    render();
    return;
  }
  if (action === 'toggle-app-inspector') {
    appInspectorCollapsed = !appInspectorCollapsed;
    appShellMenuOpen = false;
    render();
    return;
  }
  if (action === 'setH2oMode') {
    const runtime = h2oRuntime();
    const nextMode = normalizeH2oModeUi(button.dataset.mode || 'app-global');
    appShellMenuOpen = false;
    if (!h2oHasUsableSubscription(runtime)) {
      h2oManagerView = 'subscriptions';
      void runAction('updateH2oRuntime', {
        ...runtime,
        status: 'subscription-required',
        lastAppliedAt: new Date().toISOString(),
        logLevel: 'warning',
        logMessage: 'H2O mode change blocked: no usable oversea subscription for current user.'
      });
      return;
    }
    if (nextMode === 'system-tun' && !runtime.tunInstalled) {
      h2oManagerView = 'proxy';
      void runAction('updateH2oRuntime', {
        ...runtime,
        status: 'tun-required',
        lastAppliedAt: new Date().toISOString(),
        logLevel: 'warning',
        logMessage: 'H2O system TUN mode requires TUN helper installation first.'
      });
      return;
    }
    void runAction('setH2oMode', nextMode);
    return;
  }
  if (action === 'installH2oTun' || action === 'uninstallH2oTun') {
    const runtime = h2oRuntime();
    const tunInstalled = action === 'installH2oTun';
    void runAction('updateH2oRuntime', {
      ...runtime,
      tunInstalled,
      mode: !tunInstalled && runtime.mode === 'system-tun' ? 'app-global' : runtime.mode,
      status: runtime.running ? 'running' : 'ready',
      applyTunnelRuntime: true,
      lastAppliedAt: new Date().toISOString(),
      logMessage: tunInstalled ? 'H2O TUN helper installed by AppCenter.' : 'H2O TUN helper removed by AppCenter.'
    });
    return;
  }
  if (action === 'saveH2oPorts') {
    const runtime = h2oRuntime();
    void runAction('updateH2oRuntime', {
      ...runtime,
      ports: { ...runtime.ports, ...readH2oPortFields() },
      applyTunnelRuntime: true,
      lastAppliedAt: new Date().toISOString(),
      logMessage: 'H2O ports saved from AppCenter.'
    });
    return;
  }
  if (action === 'setH2oSubscription') {
    const runtime = h2oRuntime();
    const subscriptionId = button.dataset.subscriptionId || runtime.activeSubscription.id;
    const activeSubscription = runtime.subscriptions.find((item) => item.id === subscriptionId) || runtime.activeSubscription;
    if (!h2oSubscriptionUsable(activeSubscription)) {
      h2oManagerView = 'subscriptions';
      void runAction('updateH2oRuntime', {
        ...runtime,
        status: 'subscription-required',
        lastAppliedAt: new Date().toISOString(),
        logLevel: 'warning',
        logMessage: `H2O subscription is not usable for current identity: ${activeSubscription.name}.`
      });
      return;
    }
    void runAction('updateH2oRuntime', {
      ...runtime,
      activeSubscription,
      activeSubscriptionId: activeSubscription.id,
      applyTunnelRuntime: true,
      lastAppliedAt: new Date().toISOString(),
      logMessage: `H2O active subscription switched to ${activeSubscription.name}.`
    });
    return;
  }
  if (action === 'pinH2oSubscription') {
    const runtime = h2oRuntime();
    const subscriptionId = button.dataset.subscriptionId || runtime.activeSubscription.id;
    const target = runtime.subscriptions.find((item) => item.id === subscriptionId);
    if (!target) return;
    void runAction('updateH2oRuntime', {
      ...runtime,
      subscriptions: pinH2oSubscription(runtime.subscriptions, subscriptionId),
      lastAppliedAt: new Date().toISOString(),
      logMessage: `H2O subscription pinned: ${target.name}.`
    });
    return;
  }
  if (action === 'editH2oSubscription') {
    const runtime = h2oRuntime();
    const subscriptionId = button.dataset.subscriptionId || '';
    const target = runtime.subscriptions.find((item) => item.id === subscriptionId);
    if (!target || target.source !== 'custom') return;
    h2oSubscriptionEditId = target.id;
    h2oSubscriptionDraft = h2oSubscriptionDraftFromItem(target);
    render();
    return;
  }
  if (action === 'cancelH2oSubscriptionEdit') {
    resetH2oSubscriptionDraft();
    render();
    return;
  }
  if (action === 'deleteH2oSubscription') {
    const runtime = h2oRuntime();
    const subscriptionId = button.dataset.subscriptionId || '';
    const target = runtime.subscriptions.find((item) => item.id === subscriptionId);
    if (!h2oSubscriptionCanDelete(target)) return;
    const nextSubscriptions = runtime.subscriptions.filter((item) => item.id !== subscriptionId);
    const activeSubscription = runtime.activeSubscription.id === subscriptionId
      ? nextSubscriptions.find((item) => h2oSubscriptionUsable(item)) || nextSubscriptions[0] || runtime.activeSubscription
      : runtime.activeSubscription;
    if (h2oSubscriptionEditId === subscriptionId) resetH2oSubscriptionDraft();
    void runAction('updateH2oRuntime', {
      ...runtime,
      subscriptions: nextSubscriptions,
      activeSubscription,
      activeSubscriptionId: activeSubscription.id,
      status: h2oSubscriptionUsable(activeSubscription) ? (runtime.running ? 'running' : 'ready') : 'subscription-required',
      applyTunnelRuntime: true,
      lastAppliedAt: new Date().toISOString(),
      logMessage: `H2O subscription deleted: ${target.name}.`
    });
    return;
  }
  if (action === 'refreshH2oSubscription') {
    const runtime = h2oRuntime();
    const subscriptionId = button.dataset.subscriptionId || runtime.activeSubscription.id;
    const current = runtime.subscriptions.find((item) => item.id === subscriptionId) || runtime.activeSubscription;
    if (current.requiresUser && !isUserIdentity()) {
      h2oManagerView = 'subscriptions';
      const subscriptions = runtime.subscriptions.map((item) => item.id === subscriptionId
        ? { ...item, status: 'login-required', lastUpdatedAt: new Date().toISOString() }
        : item);
      void runAction('updateH2oRuntime', {
        ...runtime,
        subscriptions,
        activeSubscription: subscriptions.find((item) => item.id === runtime.activeSubscription.id) || runtime.activeSubscription,
        lastAppliedAt: new Date().toISOString(),
        logLevel: 'warning',
        logMessage: `H2O subscription refresh requires logged-in user: ${current.name}.`
      });
      return;
    }
    void runAction('refreshH2oSubscription', { subscriptionId });
    return;
  }
  if (action === 'toggleH2oRule') {
    const runtime = h2oRuntime();
    const ruleId = button.dataset.ruleId || '';
    void runAction('updateH2oRuntime', {
      ...runtime,
      rules: runtime.rules.map((rule) => rule.id === ruleId ? { ...rule, enabled: rule.enabled === false } : rule),
      applyTunnelRuntime: true,
      lastAppliedAt: new Date().toISOString(),
      logMessage: `H2O rule toggled: ${ruleId}.`
    });
    return;
  }
  if (action === 'addH2oRulePack' || action === 'removeH2oRulePack') {
    const runtime = h2oRuntime();
    const pack = h2oRulePack(button.dataset.rulePack);
    const adding = action === 'addH2oRulePack';
    const rules = adding
      ? addH2oRulePack(runtime.rules, pack)
      : removeH2oRulePack(runtime.rules, pack);
    void runAction('updateH2oRuntime', {
      ...runtime,
      rules,
      applyTunnelRuntime: true,
      lastAppliedAt: new Date().toISOString(),
      logMessage: adding ? `H2O rule pack added: ${pack.label}.` : `H2O rule pack removed: ${pack.label}.`
    });
    return;
  }
  if (action === 'requestH2oProxy') {
    const runtime = h2oRuntime();
    void runAction('updateH2oRuntime', {
      ...runtime,
      metrics: {
        ...runtime.metrics,
        connections: runtime.running ? runtime.metrics.connections + 1 : runtime.metrics.connections,
        lastProxyAppliedAt: new Date().toISOString()
      },
      lastAppliedAt: new Date().toISOString(),
      logMessage: `H2O broker policy applied in ${h2oModeLabel(runtime.mode)}.`
    });
    return;
  }
  if (action === 'runH2oTest') {
    const targetUrl = button.dataset.testUrl || readH2oTestUrl();
    setH2oTestUrl(targetUrl);
    void runAction('openH2oTestWindow', { url: targetUrl });
    return;
  }
  if (action === 'openRollback') {
    appShellMenuOpen = false;
    phoneMenuOpen = false;
    void runAction('openRollback', button.dataset.rollbackId || '');
    return;
  }
  if (action === 'connectGuest') {
    modeDraft = 'guest';
  }
  appShellMenuOpen = false;
  phoneMenuOpen = false;
  void runAction(action);
});

root.addEventListener('input', (event) => {
  const employeeField = event.target.closest('[data-employee-login-field]');
  if (employeeField) {
    const key = employeeField.dataset.employeeLoginField === 'password' ? 'password' : 'account';
    employeeLoginDraft = {
      ...employeeLoginDraft,
      [key]: employeeField.value || ''
    };
    return;
  }
  const input = event.target.closest('[data-app-search]');
  if (input) {
    appSearch = input.value || '';
    appGridScrollTop = 0;
    render();
    return;
  }
  const testUrlInput = event.target.closest('[data-h2o-test-url]');
  if (testUrlInput) {
    h2oTestUrlDraft = testUrlInput.value || '';
    return;
  }
  const subscriptionForm = event.target.closest('.h2o-subscription-form');
  if (subscriptionForm) {
    h2oSubscriptionDraft = readH2oSubscriptionForm(subscriptionForm);
  }
});

root.addEventListener('change', (event) => {
  const subscriptionForm = event.target.closest('.h2o-subscription-form');
  if (subscriptionForm) {
    h2oSubscriptionDraft = readH2oSubscriptionForm(subscriptionForm);
  }
});

root.addEventListener('scroll', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.classList.contains('appcenter-card-grid')) {
    appGridScrollTop = target.scrollTop;
  }
}, true);

root.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target instanceof Element ? event.target : null;
  const card = target?.closest('.appcenter-app-card[data-action="select-app"]');
  if (!card || target.closest('button,input,select,a')) return;
  event.preventDefault();
  card.click();
});

root.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const action = form.dataset.formAction;
  if (action === 'save-config') {
    void runAction(action, readConfigForm(form));
  }
  if (action === 'login-employee') {
    const payload = Object.fromEntries(new FormData(form).entries());
    employeeLoginDraft = {
      account: String(payload.account || ''),
      password: String(payload.password || '')
    };
    rememberEmployeeAccount(employeeLoginDraft.account);
    void runAction(action, { ...employeeLoginDraft });
  }
  if (action === 'add-h2o-rule') {
    const runtime = h2oRuntime();
    const rule = h2oRuleFromInput(readH2oRuleForm(form));
    void runAction('updateH2oRuntime', {
      ...runtime,
      rules: upsertH2oRule(runtime.rules, rule),
      applyTunnelRuntime: true,
      lastAppliedAt: new Date().toISOString(),
      logMessage: `H2O rule added: ${rule.host} -> ${rule.kind}.`
    });
  }
  if (action === 'add-h2o-subscription') {
    const runtime = h2oRuntime();
    const draft = readH2oSubscriptionForm(form);
    h2oSubscriptionDraft = draft;
    const validationError = h2oCustomSubscriptionValidationError(draft);
    if (validationError) {
      state = {
        ...state,
        feedback: {
          tone: 'warning',
          message: validationError
        }
      };
      render();
      return;
    }
    const wasEditing = Boolean(h2oSubscriptionEditId);
    const subscription = h2oCustomSubscriptionFromInput({
      ...draft,
      id: h2oSubscriptionEditId
    });
    if (!subscription) {
      state = {
        ...state,
        feedback: {
          tone: 'warning',
          message: '请输入有效的 http 或 https 订阅链接。'
        }
      };
      render();
      return;
    }
    resetH2oSubscriptionDraft();
    const subscriptions = upsertH2oSubscription(runtime.subscriptions, subscription);
    const editingActive = wasEditing && subscription.id === runtime.activeSubscription.id;
    const shouldActivate = editingActive || !h2oSubscriptionUsable(runtime.activeSubscription);
    const activeSubscription = shouldActivate
      ? subscription
      : subscriptions.find((item) => item.id === runtime.activeSubscription.id) || runtime.activeSubscription;
    void runAction('updateH2oRuntime', {
      ...runtime,
      subscriptions,
      activeSubscription,
      activeSubscriptionId: activeSubscription.id,
      status: runtime.running ? 'running' : h2oSubscriptionUsable(activeSubscription) ? 'ready' : 'subscription-required',
      applyTunnelRuntime: shouldActivate,
      lastAppliedAt: new Date().toISOString(),
      logMessage: wasEditing
        ? `H2O custom subscription updated: ${subscription.name}${shouldActivate ? '' : '; active subscription unchanged'}.`
        : `H2O custom subscription saved: ${subscription.name}${shouldActivate ? ' and selected because no usable active subscription exists' : '; active subscription unchanged'}.`
    });
  }
});

root.addEventListener('pointerdown', (event) => {
  if (isWindows && screen === 'appcenter') return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target || event.button !== 0) return;
  if (target.closest('button,input,select,a')) return;
  const dragHandle = target.closest('[data-window-drag]');
  if (!dragHandle || typeof api.moveWindowBy !== 'function') return;
  windowDragSequence = (windowDragSequence + 1) % 1000;
  const dragId = Date.now() * 1000 + windowDragSequence;
  windowDrag = {
    dragId,
    pointerId: event.pointerId,
    screenX: event.screenX,
    screenY: event.screenY,
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    totalDx: 0,
    totalDy: 0
  };
  void api.startWindowDrag?.({ dragId });
  dragHandle.setPointerCapture?.(event.pointerId);
  document.body.classList.add('is-window-dragging');
  event.preventDefault();
});

window.addEventListener('pointermove', (event) => {
  if (!windowDrag || event.pointerId !== windowDrag.pointerId) return;
  const dx = Math.round(event.screenX - windowDrag.screenX);
  const dy = Math.round(event.screenY - windowDrag.screenY);
  if (!dx && !dy) return;
  windowDrag.screenX = event.screenX;
  windowDrag.screenY = event.screenY;
  windowDrag.totalDx = Math.round(event.screenX - windowDrag.startScreenX);
  windowDrag.totalDy = Math.round(event.screenY - windowDrag.startScreenY);
  void api.moveWindowBy?.({
    dragId: windowDrag.dragId,
    dx,
    dy,
    totalDx: windowDrag.totalDx,
    totalDy: windowDrag.totalDy
  });
  event.preventDefault();
});

window.addEventListener('pointerup', finishWindowDrag);
window.addEventListener('pointercancel', finishWindowDrag);
root.addEventListener('mouseleave', () => {
  if (!windowDrag) void api.hideTopDockIfPending?.();
});

function finishWindowDrag(event) {
  if (!windowDrag) return;
  if (event && windowDrag && event.pointerId !== windowDrag.pointerId) return;
  const dragId = windowDrag.dragId;
  const hasFinalCoordinates = event?.type === 'pointerup'
    && Number.isFinite(event.screenX)
    && Number.isFinite(event.screenY);
  const totalDx = hasFinalCoordinates
    ? Math.round(event.screenX - windowDrag.startScreenX)
    : windowDrag.totalDx;
  const totalDy = hasFinalCoordinates
    ? Math.round(event.screenY - windowDrag.startScreenY)
    : windowDrag.totalDy;
  windowDrag = null;
  document.body.classList.remove('is-window-dragging');
  void api.finishWindowDrag?.({ dragId, totalDx, totalDy });
}

async function runAction(action, payload) {
  if (busyAction) return;
  busyAction = action;
  render();
  try {
    const handlers = {
      connectGuest: () => api.connectGuest(),
      disconnect: () => api.disconnect(),
      'login-employee': () => api.loginEmployee(payload),
      'save-config': () => api.saveConfig(payload),
      installAppCenter: () => api.installAppCenter(),
      enableH2o: () => api.enableH2o(),
      launchH2o: () => api.launchH2o?.() || api.enableH2o(),
      stopH2o: () => api.stopH2o?.(),
      setH2oMode: () => api.setH2oMode?.(payload),
      updateH2oRuntime: () => api.updateH2oRuntime?.(payload),
      refreshH2oSubscription: () => api.refreshH2oSubscription?.(payload),
      provisionH2oOversea: () => api.provisionH2oOversea?.(payload),
      openH2oTestWindow: () => api.openH2oTestWindow?.(payload),
      checkUpdates: () => api.checkUpdates(),
      applyUpdate: () => api.applyUpdate?.(),
      restartApp: () => api.restartApp?.(),
      openRollback: () => api.openRollbackInstaller?.(payload),
      refreshDiagnostics: () => api.refreshDiagnostics?.(),
      repairSystemNetwork: () => api.repairSystemNetwork?.(),
      openDiagnosticLogs: () => api.openDiagnosticLogs?.(),
      exportDiagnostics: () => api.exportDiagnostics?.(),
      openAdmin: () => api.openAdmin()
    };
    if (handlers[action]) {
      const next = await handlers[action]();
      if (next && typeof next === 'object' && 'connection' in next) {
        state = next;
        if (action === 'login-employee') syncEmployeeLoginDraftFromState();
      }
      if (action === 'installAppCenter' && state.apps?.appcenter?.installed) {
        await setScreen('appcenter');
      }
      if (action === 'launchH2o' && state.apps?.h2o?.installed) {
        selectedAppId = 'h2o';
        appCenterRoute = 'h2o';
        appInspectorCollapsed = true;
      }
    }
  } finally {
    busyAction = '';
    render();
  }
}

async function setScreen(nextScreen) {
  screen = nextScreen;
  phoneMenuOpen = false;
  if (nextScreen === 'appcenter') {
    await api.setWindowMode?.('appcenter');
  } else {
    await api.setWindowMode?.('launcher');
  }
  render();
}

function handlePhoneBack() {
  phoneMenuOpen = false;
  appShellMenuOpen = false;
  if (screen === 'advanced') {
    void setScreen('launcher');
    return;
  }
  if (isEmployeeLoginVisible()) {
    modeDraft = state.connection?.mode === 'employee' ? 'employee' : 'guest';
    if (modeDraft === 'employee' && state.connection?.state !== 'connected') modeDraft = 'guest';
    render();
    return;
  }
  void api.setWindowMode?.('launcher');
  render();
}

function readEmployeeAccountHistory() {
  try {
    const raw = window.localStorage?.getItem(EMPLOYEE_ACCOUNT_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .slice(0, EMPLOYEE_ACCOUNT_HISTORY_LIMIT);
  } catch (_err) {
    return [];
  }
}

function writeEmployeeAccountHistory() {
  try {
    window.localStorage?.setItem(EMPLOYEE_ACCOUNT_HISTORY_KEY, JSON.stringify(employeeAccountHistory));
  } catch (_err) {
    // Account history is a convenience feature; login should keep working if storage is unavailable.
  }
}

function rememberEmployeeAccount(account) {
  const normalized = String(account || '').trim();
  if (!normalized) return;
  employeeAccountHistory = [
    normalized,
    ...employeeAccountHistory.filter((item) => item.toLowerCase() !== normalized.toLowerCase())
  ].slice(0, EMPLOYEE_ACCOUNT_HISTORY_LIMIT);
  writeEmployeeAccountHistory();
}

function syncEmployeeLoginDraftFromState() {
  const account = state?.identity?.kind === 'user' ? String(state.identity.account || '').trim() : '';
  if (!account) return;
  rememberEmployeeAccount(account);
  if (!employeeLoginDraft.account) {
    employeeLoginDraft = {
      ...employeeLoginDraft,
      account
    };
  }
}

function isEmployeeLoginVisible() {
  const connected = state.connection?.state === 'connected';
  return modeDraft === 'employee' && (!connected || state.connection?.mode !== 'employee');
}

function isGuestConnectionActive() {
  const connection = state?.connection || {};
  return connection.mode === 'guest'
    && ['connecting', 'connected', 'lease-only', 'tunnel-only', 'server-unavailable', 'network-unavailable', 'forbidden'].includes(connection.state);
}

function guestConnectionPrompt() {
  const ip = state?.connection?.localIp ? `（当前访客 IP：${state.connection.localIp}）` : '';
  return `当前已连接访客模式${ip}。员工认证成功后会自动切换到员工网络；认证失败或取消授权时保留访客连接。`;
}

function isConnectionPending() {
  return state?.connection?.state === 'connecting'
    || busyAction === 'connectGuest'
    || busyAction === 'login-employee';
}

function pendingConnectionLabel() {
  if (state?.connection?.state === 'lease-only') return '等待系统授权';
  if (busyAction === 'login-employee') return '正在连接员工模式';
  return '等待连接中';
}

function isInternalConnected() {
  return state?.connection?.state === 'connected';
}

function updateNeedsAttention() {
  if (!isInternalConnected()) return false;
  const update = state?.update || {};
  return update.updateAvailable === true
    || ['update-available', 'blocked', 'downloading', 'download-failed', 'ready-to-install', 'installer-opened', 'staged'].includes(update.status);
}

function renderCheckUpdatesButton(className = 'text-button') {
  const connected = isInternalConnected();
  const label = connected ? '检查更新' : '连接后检查';
  const attention = updateNeedsAttention();
  const disabled = busyAction === 'checkUpdates';
  return `
    <button class="${escapeAttr(className)} update-check-button ${attention ? 'has-update-attention' : ''}" type="button" data-action="checkUpdates" ${disabled ? 'disabled' : ''}>
      <span>${escapeHtml(label)}</span>
      ${attention ? '<span class="update-dot" aria-hidden="true"></span>' : ''}
    </button>
  `;
}

function render() {
  if (!state) return;
  const connected = state.connection?.state === 'connected';
  const leaseOnly = state.connection?.state === 'lease-only';
  const tunnelOnly = state.connection?.state === 'tunnel-only';
  const connecting = isConnectionPending();
  const degraded = ['server-unavailable', 'network-unavailable', 'forbidden'].includes(state.connection?.state);
  const shellClass = screen === 'appcenter' ? 'is-appcenter' : 'is-phone';
  root.innerHTML = `
    <div class="mx-shell ${shellClass}">
      ${screen === 'appcenter' ? '' : renderWindowChrome()}
      ${screen === 'appcenter' ? renderWorkbench(connected, connecting) : renderPhone(connected, connecting, leaseOnly, tunnelOnly, degraded)}
    </div>
  `;
  restoreAppCenterScroll();
}

function rememberAppGridScroll() {
  const grid = root.querySelector('.appcenter-card-grid');
  if (grid) appGridScrollTop = grid.scrollTop;
}

function restoreAppCenterScroll() {
  const grid = root.querySelector('.appcenter-card-grid');
  if (!grid) return;
  grid.scrollTop = appGridScrollTop;
}

function renderWindowChrome() {
  return `
    <div class="window-chrome" aria-label="Window controls">
      <div class="traffic-controls">
        <button class="traffic-dot is-close" type="button" data-window-control="close" aria-label="Close"></button>
        <button class="traffic-dot is-minimize" type="button" data-window-control="minimize" aria-label="Minimize"></button>
        <button class="traffic-dot is-zoom" type="button" data-window-control="zoom" aria-label="Zoom"></button>
      </div>
      <div class="top-drag-strip" data-window-drag="true" aria-hidden="true"><span></span></div>
    </div>
  `;
}

function renderPhone(connected, connecting, leaseOnly = false, tunnelOnly = false, degraded = false) {
  if (screen === 'advanced') return renderAdvancedPhone();
  const mode = modeDraft;
  const activeLease = connected || leaseOnly || tunnelOnly || degraded;
  const showEmployeeLogin = isEmployeeLoginVisible();
  const disconnecting = busyAction === 'disconnect';
  const pendingMode = busyAction === 'login-employee' ? 'employee' : state.connection?.mode;
  const modeTitle = disconnecting
    ? `${state.connection?.mode === 'employee' ? '员工' : '访客'}模式 正在断开`
    : connecting
    ? `${pendingMode === 'employee' ? '员工' : '访客'}模式 连接中`
    : connected
    ? showEmployeeLogin
      ? '员工模式'
      : `${state.connection.mode === 'employee' ? '员工' : '访客'}模式 已连接`
    : leaseOnly
      ? `${state.connection.mode === 'employee' ? '员工' : '访客'}模式 租约已保留`
      : tunnelOnly
        ? `${state.connection.mode === 'employee' ? '员工' : '访客'}模式 隧道待恢复`
        : degraded
          ? `${state.connection.mode === 'employee' ? '员工' : '访客'}模式 待恢复`
    : mode === 'employee'
      ? '员工模式'
      : '访客模式';
  return `
    <section class="mx-phone" aria-label="MX-H2I standalone launcher">
      <header class="phone-bar" data-window-drag="true">
        <button class="icon-button" type="button" data-action="phone-back" aria-label="Back">‹</button>
        ${renderPhoneShellMenu('h2i')}
      </header>

      <section class="phone-hero">
        <div class="app-mark">H2I</div>
        <p class="kicker">MX-H2I</p>
        <h1>${escapeHtml(modeTitle)}</h1>
        <p>${escapeHtml(connectionCaption())}</p>
      </section>
      ${renderFeedback()}

      ${showEmployeeLogin ? renderEmployeeLogin(connecting) : renderGuestConnect(connected, connecting, activeLease && !connected)}
      ${renderConnectionStrip()}
      ${renderPhoneFooterInfo(connected)}
    </section>
  `;
}

function renderGuestConnect(connected, connecting, leaseOnly = false) {
  const disconnecting = busyAction === 'disconnect';
  const disconnectable = connected || state.connection?.wireGuard?.active === true;
  const label = disconnecting ? '正在断开' : disconnectable ? '断开连接' : connecting ? pendingConnectionLabel() : leaseOnly ? '重新连接' : '连接';
  const action = disconnectable ? 'disconnect' : 'connectGuest';
  const disabled = connecting || disconnecting;
  return `
    <section class="connect-panel">
      <button class="connect-dial ${disconnectable ? 'is-connected' : ''} ${connecting ? 'is-connecting' : ''} ${disconnecting ? 'is-disconnecting' : ''}" type="button" data-action="${action}" aria-busy="${disabled ? 'true' : 'false'}" ${disabled ? 'disabled' : ''}>
        <span>${escapeHtml(label)}</span>
      </button>
      <div class="connect-actions">
        <button class="text-button" type="button" data-action="select-mode" data-mode="employee">员工登录</button>
        ${renderCheckUpdatesButton('text-button')}
        <button class="text-button" type="button" data-action="show-advanced">高级选项</button>
      </div>
    </section>
  `;
}

function renderEmployeeLogin(connecting) {
  const guestActive = isGuestConnectionActive();
  const loginPending = busyAction === 'login-employee';
  const replacingGuest = guestActive || (
    loginPending
    && state.networkEvent?.name === 'staff:connect'
    && state.networkEvent?.reason === 'visit-to-staff'
  );
  const historyOptions = employeeAccountHistory
    .map((account) => `<option value="${escapeAttr(account)}"></option>`)
    .join('');
  return `
    <form class="login-panel" data-form-action="login-employee">
      ${loginPending
        ? `<div class="login-transition" role="status" aria-live="polite"><span class="login-transition-wave" aria-hidden="true"></span><span>${escapeHtml(replacingGuest ? '正在验证员工身份；认证成功后将自动接管访客网络。' : '正在验证员工身份并建立员工网络。')}</span></div>`
        : guestActive ? `<div class="login-notice">${escapeHtml(guestConnectionPrompt())}</div>` : ''}
      <label class="field">
        <span>账号</span>
        <input name="account" data-employee-login-field="account" value="${escapeAttr(employeeLoginDraft.account)}" list="employee-account-history" autocomplete="username" placeholder="Username/Email/Phone" ${loginPending ? 'disabled' : ''} />
        <datalist id="employee-account-history">${historyOptions}</datalist>
      </label>
      <label class="field">
        <span>密码</span>
        <input name="password" data-employee-login-field="password" value="${escapeAttr(employeeLoginDraft.password)}" type="password" autocomplete="current-password" placeholder="Password" ${loginPending ? 'disabled' : ''} />
      </label>
      <button class="primary-button block-button" type="submit" aria-busy="${loginPending ? 'true' : 'false'}" ${connecting ? 'disabled' : ''}>
        ${loginPending ? (replacingGuest ? '正在切换员工模式' : '正在连接员工模式') : guestActive ? '登录并切换员工模式' : connecting ? '连接处理中' : '连接'}
      </button>
      <button class="secondary-button block-button" type="button" data-action="${guestActive ? 'disconnect' : 'connectGuest'}" ${connecting ? 'disabled' : ''}>
        ${guestActive ? '仅断开访客模式' : '使用飞书连接'}
      </button>
    </form>
  `;
}

function renderPhoneFooterInfo(connected) {
  const update = state.update || {};
  const version = update.currentVersion || '0.1.0';
  const channel = update.channel || state.config?.releaseChannel || 'stable';
  const status = update.status || (connected ? 'ready' : state.connection?.state || 'idle');
  const latest = update.latestVersion || version;
  const hasArtifact = Boolean(update.artifactUrl);
  const canApply = hasArtifact && !['downloading', 'staged', 'installer-opened'].includes(status);
  const canRestart = update.restartPrompt || ['installer-opened', 'ready-to-install', 'staged'].includes(status) && update.restartRequired;
  return `
    <section class="phone-footer-info update-surface">
      <div class="update-surface-head">
        <div>
          <h2>MX-H2I</h2>
          <p>当前 ${escapeHtml(version)} · ${escapeHtml(channel)}</p>
        </div>
        <span class="status-pill" data-state="${escapeAttr(status)}">${escapeHtml(updateStatusLabel(status))}</span>
      </div>
      <div class="update-summary-line">
        <strong>${escapeHtml(latest === version && !update.updateAvailable ? '已是最新版本' : `目标 ${latest}`)}</strong>
        <span>${escapeHtml(updateSummaryText(update))}</span>
      </div>
      ${renderUpdateProgress(update)}
      <div class="update-surface-actions">
        ${renderCheckUpdatesButton('secondary-button')}
        <button class="primary-button" type="button" data-action="applyUpdate" ${!canApply || busyAction === 'applyUpdate' ? 'disabled' : ''}>${escapeHtml(updateApplyLabel(update))}</button>
        ${canRestart ? '<button class="secondary-button" type="button" data-action="restartApp">重启</button>' : ''}
      </div>
      ${renderReleaseHistory(update)}
      ${renderRollbackSlots(update)}
    </section>
  `;
}

function renderAdvancedPhone() {
  return `
    <section class="mx-phone advanced-phone" aria-label="MX-H2I advanced options">
      <header class="phone-bar" data-window-drag="true">
        <button class="icon-button" type="button" data-action="phone-back" aria-label="Back">‹</button>
        ${renderPhoneShellMenu('h2i')}
      </header>
      <section class="advanced-title">
        <p class="kicker">MX-H2I</p>
        <h1>高级选项</h1>
        <p>Launcher Foundation / endpoint / release</p>
      </section>
      ${renderFeedback()}
      <section class="advanced-list">
        ${renderAdvancedRow('指纹、人脸与密码', 'identity / device binding', '◎')}
        ${renderAdvancedRow('安全', 'permission broker / helper policy', '◆')}
        ${renderAdvancedRow('隐私保护', 'audit scope / token isolation', '◇')}
        ${renderAdvancedRow('应用设置', 'AppCenter / H2O embed defaults', '⚙')}
        ${renderAdvancedRow('更多设置', 'network, release, diagnostics', '…')}
      </section>
      ${renderDiagnosticLogPanel()}
      ${renderWireGuardDiagnostics()}
      ${renderConfigForm()}
    </section>
  `;
}

function renderPhoneShellMenu(activeTarget) {
  const connected = state.connection?.state === 'connected';
  const appCenterInstalled = state.apps?.appcenter?.installed;
  return `
    <div class="phone-shell-menu">
      <button class="window-dots" type="button" data-action="toggle-phone-menu" aria-label="App menu">
        <span></span><span></span><span></span>
      </button>
      ${phoneMenuOpen ? `
        <div class="phone-shell-popover" role="menu">
          <button type="button" data-action="switch-phone-shell" data-target="h2i" class="${activeTarget === 'h2i' ? 'is-active' : ''}">
            <span>H2I（VPN）</span>
            <small>连接与身份</small>
          </button>
          <button type="button" data-action="switch-phone-shell" data-target="appcenter" ${!connected && !appCenterInstalled ? 'disabled' : ''}>
            <span>AppCenter</span>
            <small>${appCenterInstalled ? '应用中心' : '连接后安装'}</small>
          </button>
          <button type="button" data-action="switch-phone-shell" data-target="close">
            <span>关闭</span>
            <small>关闭当前窗口</small>
          </button>
        </div>
      ` : ''}
    </div>
  `;
}

function renderAdvancedRow(title, detail, icon) {
  return `
    <button class="advanced-row" type="button">
      <span class="advanced-row__icon">${escapeHtml(icon)}</span>
      <span>
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(detail)}</small>
      </span>
      <span class="advanced-row__arrow">›</span>
    </button>
  `;
}

function renderDiagnosticLogPanel() {
  const log = state.diagnosticLog || {};
  const recent = Array.isArray(log.recent) ? log.recent : [];
  const notable = recent.filter((entry) => entry?.level === 'error' || entry?.level === 'warning').slice(0, 5);
  const windowsNrpt = state.connection?.diagnostics?.networkEnvironment?.windowsNrpt;
  const nrptSummary = windowsNrpt
    ? `Windows NRPT：${windowsNrpt.state || 'unknown'}`
    : 'Windows 导出包会额外采集 NRPT、网卡 DNS、ipconfig 和路由。';
  return `
    <section class="settings-panel diagnostic-log-panel">
      <div class="panel-head">
        <div>
          <h2>运行日志与诊断包</h2>
          <p>异步滚动日志 / Windows DNS & NRPT</p>
        </div>
        <span class="status-pill" data-state="${log.enabled === false ? 'failed' : 'ready'}">${log.enabled === false ? 'OFF' : 'ON'}</span>
      </div>
      <p class="diagnostic-log-hint">${escapeHtml(nrptSummary)} 日志达到 ${escapeHtml(formatBytes(log.maxBytes || 2 * 1024 * 1024))} 后自动轮转，不阻塞连接主流程。</p>
      <div class="diagnostic-log-list">
        ${notable.length ? notable.map((entry) => `
          <div class="diagnostic-log-row" data-level="${escapeAttr(entry.level)}">
            <span>${escapeHtml(entry.level)}</span>
            <div>
              <strong>${escapeHtml(entry.event || 'runtime')}</strong>
              <p>${escapeHtml(entry.message || '')}</p>
              <small>${escapeHtml(formatDateTime(entry.at))}</small>
            </div>
          </div>
        `).join('') : '<p class="empty">当前会话暂无 warning / error。</p>'}
      </div>
      <div class="toolbar-actions diagnostic-log-actions">
        <button class="secondary-button" type="button" data-action="openDiagnosticLogs" ${busyAction === 'openDiagnosticLogs' ? 'disabled' : ''}>打开日志目录</button>
        <button class="primary-button" type="button" data-action="exportDiagnostics" ${busyAction === 'exportDiagnostics' ? 'disabled' : ''}>${busyAction === 'exportDiagnostics' ? '正在采集…' : '导出诊断包'}</button>
      </div>
      <p class="diagnostic-log-privacy">诊断包可能包含本机 IP、网卡、DNS 后缀和路由信息；常见 token、密码、私钥字段会自动隐藏。</p>
    </section>
  `;
}

function updateStatusLabel(status) {
  if (status === 'update-available') return 'UPDATE';
  if (status === 'blocked') return 'BLOCKED';
  if (status === 'downloading') return 'DOWNLOADING';
  if (status === 'ready-to-install') return 'READY';
  if (status === 'installer-opened') return 'INSTALL';
  if (status === 'staged') return 'STAGED';
  if (status === 'download-failed' || status === 'failed') return 'FAILED';
  if (status === 'needs-connection') return 'LOGIN';
  if (status === 'up-to-date') return 'LATEST';
  return status || 'READY';
}

function updateSummaryText(update) {
  if (!isInternalConnected()) return '连接 Internal 后自动检查 Release Center';
  if (update.status === 'downloading') return '正在下载并校验 artifact';
  if (update.status === 'installer-opened') return '安装包已打开，完成安装后可重启';
  if (update.status === 'ready-to-install') return '安装包已下载，可打开安装器';
  if (update.status === 'staged') return update.restartRequired ? '热更新已暂存，等待重启激活' : '热更新已暂存';
  if (update.status === 'blocked') return '发现新版本，等待 Release Gate';
  if (update.status === 'update-available') return update.activation === 'installer-manual' ? '发现大版本安装包' : '发现可自动更新版本';
  if (update.lastCheckedAt) return `上次检查 ${formatDateTime(update.lastCheckedAt)}`;
  return '尚未检查更新';
}

function updateApplyLabel(update) {
  if (busyAction === 'applyUpdate' || update.status === 'downloading') return '下载中';
  if (update.status === 'ready-to-install') return '打开安装包';
  if (update.status === 'installer-opened') return '已打开';
  if (update.status === 'staged') return update.restartRequired ? '等待重启' : '已暂存';
  if (update.status === 'download-failed') return '重新下载';
  if (update.activation === 'installer-manual' || update.majorUpdateRequiresInstaller) return '下载大版本';
  return '下载更新';
}

function renderUpdateProgress(update) {
  const progress = update.downloadProgress || null;
  if (!progress || !['downloading', 'downloaded', 'failed'].includes(progress.state)) return '';
  const percent = Number.isFinite(progress.percent) ? progress.percent : null;
  const width = percent == null ? 18 : Math.max(2, Math.min(100, percent));
  return `
    <div class="update-progress" data-state="${escapeAttr(progress.state)}">
      <div class="update-progress-track"><span style="width:${escapeAttr(String(width))}%"></span></div>
      <p>${escapeHtml(progressLabel(progress))}</p>
    </div>
  `;
}

function progressLabel(progress) {
  const bytes = formatBytes(progress.bytes);
  const total = progress.totalBytes ? formatBytes(progress.totalBytes) : '';
  const percent = Number.isFinite(progress.percent) ? `${progress.percent}%` : '下载中';
  if (progress.state === 'failed') return `下载失败 · ${bytes}${total ? ` / ${total}` : ''}`;
  if (progress.state === 'downloaded') return `已下载 · ${bytes}`;
  return `${percent} · ${bytes}${total ? ` / ${total}` : ''}`;
}

function renderReleaseHistory(update) {
  const releases = Array.isArray(update.availableReleases) ? update.availableReleases : [];
  const history = Array.isArray(update.history) ? update.history : [];
  const rows = releases.length
    ? releases.slice(0, 3).map((item) => ({
        title: item.version || item.releaseId || 'release',
        meta: [item.componentKind, item.artifactKind, item.channel].filter(Boolean).join(' · '),
        status: item.status || item.gate || '-',
        at: item.createdAt
      }))
    : history.slice(0, 3).map((item) => ({
        title: item.version || item.releaseId || item.kind,
        meta: [item.kind, item.componentKind, item.updateMode].filter(Boolean).join(' · '),
        status: item.status,
        at: item.at
      }));
  if (!rows.length) return '';
  return `
    <div class="update-mini-list">
      <div class="update-mini-list-head">
        <strong>版本记录</strong>
        <span>${escapeHtml(releases.length ? `${releases.length} releases` : `${history.length} events`)}</span>
      </div>
      ${rows.map((item) => `
        <div class="update-mini-row">
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <small>${escapeHtml(item.meta || formatDateTime(item.at))}</small>
          </div>
          <span>${escapeHtml(item.status || '-')}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderRollbackSlots(update) {
  const slots = Array.isArray(update.rollbackSlots) ? update.rollbackSlots.slice(0, 3) : [];
  if (!slots.length) return '';
  return `
    <div class="rollback-slots">
      <div class="update-mini-list-head">
        <strong>可回滚大版本</strong>
        <span>最近 ${escapeHtml(String(slots.length))} 个</span>
      </div>
      ${slots.map((slot) => `
        <div class="rollback-row">
          <div>
            <strong>${escapeHtml(slot.version || slot.releaseId || 'installer')}</strong>
            <small>${escapeHtml(`${formatBytes(slot.sizeBytes)} · ${formatDateTime(slot.downloadedAt)}`)}</small>
          </div>
          <button class="secondary-button" type="button" data-action="openRollback" data-rollback-id="${escapeAttr(slot.id || slot.artifactId || slot.path)}">打开</button>
        </div>
      `).join('')}
    </div>
  `;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function renderConnectionStrip() {
  const connection = state.connection || {};
  const health = connection.health || {};
  return `
    <section class="connection-strip">
      <div>
        <span>本机 IP</span>
        <strong>${escapeHtml(connection.localIp || '未分配')}</strong>
      </div>
      <div>
        <span>Channel</span>
        <strong>mx-h2i</strong>
      </div>
      <div>
        <span>Internal</span>
        <strong>${escapeHtml(health.internalApi || 'idle')}</strong>
      </div>
    </section>
  `;
}

function renderWireGuardDiagnostics() {
  const connection = state.connection || {};
  const wireGuard = connection.wireGuard || {};
  const diagnostics = connection.diagnostics || {};
  const route = diagnostics.route || {};
  const endpointRoute = diagnostics.endpointRoute || {};
  const internalApi = diagnostics.internalApi || {};
  const directSync = diagnostics.internalDirectPeerSync || {};
  const peerSync = connection.domesticPeerSync || diagnostics.domesticPeerSync || {};
  const relayDiag = diagnostics.domesticRelayDiagnostics || {};
  const relaySummary = relayDiag.summary || {};
  const relayBlockedReasons = Array.isArray(relayDiag.blockedReasons) ? relayDiag.blockedReasons : [];
  const relayFailures = Array.isArray(relayDiag.failures) ? relayDiag.failures : [];
  const directSyncFailures = directSync.status === 'skipped' ? [] : (Array.isArray(directSync.failures) ? directSync.failures : []);
  const directSyncStatus = directSync.status === 'skipped' && directSync.message ? 'relay fallback' : (directSync.status || '-');
  const networkEnvironment = diagnostics.networkEnvironment || {};
  const resolution = networkEnvironment.resolution || {};
  const resolutionAddresses = Array.isArray(resolution.addresses)
    ? resolution.addresses.map((row) => `${row.address || '-'} ${row.classification || ''}`.trim()).join(', ')
    : '';
  const systemProxy = networkEnvironment.systemDomainProxy || diagnostics.systemDomainProxy || {};
  const launchDaemon = wireGuard.launchDaemon || {};
  const launchDaemonStatus = launchDaemon.supported
    ? (launchDaemon.running ? 'running' : launchDaemon.loaded ? 'loaded' : launchDaemon.installed ? 'installed' : 'missing')
    : '-';
  return `
    <section class="settings-panel">
      <div class="panel-head">
        <div>
          <h2>WireGuard 诊断</h2>
          <p>route proof / overlay health</p>
        </div>
        <div class="toolbar-actions">
          <button class="secondary-button" type="button" data-action="repairSystemNetwork" ${busyAction === 'repairSystemNetwork' ? 'disabled' : ''}>修复网络</button>
          <button class="secondary-button" type="button" data-action="refreshDiagnostics" ${busyAction === 'refreshDiagnostics' ? 'disabled' : ''}>重新诊断</button>
        </div>
      </div>
      <div class="metric-grid">
        ${metric('WG', connection.health?.wireGuard || 'idle')}
        ${metric('Path', pathLabel(wireGuard.path || connection.routePlan?.preferredPath))}
        ${metric('DNS Phase', networkEnvironment.phase || '-')}
        ${metric('DNS Host', networkEnvironment.host || '-')}
        ${metric('Resolved', compactText(resolutionAddresses, 90))}
        ${metric('Resolution', resolution.state ? `${resolution.state} / ${resolution.severity || '-'}` : '-')}
        ${metric('System PAC', systemProxy.applied ? `on / ${systemProxy.systemResolverMode || '-'}` : 'off')}
        ${metric('Direct Sync', directSyncStatus)}
        ${metric('Peer Sync', peerSync.status || '-')}
        ${metric('Relay', relayDiag.status || '-')}
        ${metric('IP Forward', relaySummary.ipForward || '-')}
        ${metric('Relay FORWARD', relaySummary.firewallForward || '-')}
        ${metric('Relay Docker', relaySummary.firewallDockerUser || '-')}
        ${metric('Interface', wireGuard.realInterfaceName || wireGuard.interfaceName || '-')}
        ${metric('Expected', route.expectedInterfaceName || wireGuard.realInterfaceName || '-')}
        ${metric('Endpoint', wireGuard.endpoint || connection.domesticRelayEndpoint || '-')}
        ${metric('Endpoint route', endpointRoute.interfaceName ? `${endpointRoute.interfaceName}${endpointRoute.gateway ? ` / ${endpointRoute.gateway}` : ''}` : (endpointRoute.error || '-'))}
        ${metric('Endpoint proxy', endpointRoute.viaProxyTun ? 'proxy-tun' : (endpointRoute.ok ? 'clear' : '-'))}
        ${metric('Target', route.targetIp || '10.88.88.88')}
        ${metric('Route dev', route.interfaceName || '-')}
        ${metric('Service', wireGuard.serviceState || (wireGuard.active ? 'active' : '-'))}
        ${metric('LaunchDaemon', launchDaemonStatus)}
        ${metric('Internal', internalApi.ok ? 'ready' : (internalApi.error || connection.health?.internalApi || 'idle'))}
        ${metric('Relay to lease', relaySummary.routeToLease || '-')}
        ${metric('Relay client', relaySummary.clientPeerConfigured ? `${relaySummary.clientPeerConfigured} / ${relaySummary.clientLatestHandshake || '-'} / ${relaySummary.clientTransfer || '-'}` : '-')}
        ${metric('Relay Internal', relaySummary.internalPeerConfigured ? `${relaySummary.internalPeerConfigured} / ${relaySummary.internalLatestHandshake || '-'} / ${relaySummary.internalTransfer || '-'}` : '-')}
        ${metric('Relay healthz', relaySummary.internalHealthz || '-')}
        ${metric('AllowedIPs', compactList(wireGuard.allowedIps))}
        ${metric('Route CIDRs', compactList(connection.routeCidrs))}
        ${metric('Config', wireGuard.configPath || '-')}
      </div>
      ${directSync.message ? `<p class="diagnostic-note">${escapeHtml(directSync.message)}</p>` : ''}
      ${directSyncFailures.length ? `<p class="diagnostic-note">${escapeHtml(directSyncFailures.join(' / '))}</p>` : ''}
      ${peerSync.failures?.length ? `<p class="diagnostic-note">${escapeHtml(peerSync.failures.join(' / '))}</p>` : ''}
      ${relayBlockedReasons.length || relayFailures.length ? `<p class="diagnostic-note">${escapeHtml([...relayBlockedReasons, ...relayFailures].join(' / '))}</p>` : ''}
      ${wireGuard.statusError || wireGuard.routeLogTail ? `<p class="diagnostic-note">${escapeHtml(wireGuard.statusError || wireGuard.routeLogTail)}</p>` : ''}
      ${resolution.message ? `<p class="diagnostic-note">${escapeHtml(resolution.message)}</p>` : ''}
    </section>
  `;
}

function renderConfigForm() {
  const config = state.config || {};
  return `
    <form class="settings-panel" data-form-action="save-config">
      <div class="panel-head">
        <div>
          <h2>运行配置</h2>
          <p>endpoint injection</p>
        </div>
        <button class="secondary-button" type="submit" ${busyAction === 'save-config' ? 'disabled' : ''}>保存</button>
      </div>
      <label class="field">
        <span>Bootstrap API</span>
        <input name="bootstrapApiBaseUrl" value="${escapeAttr(config.bootstrapApiBaseUrl || '')}" />
      </label>
      <label class="field">
        <span>Overlay Internal API</span>
        <input name="internalApiBaseUrl" value="${escapeAttr(config.internalApiBaseUrl)}" />
      </label>
      <div class="field-row">
        <label class="field">
          <span>Domestic Host</span>
          <input name="domesticRelayHost" value="${escapeAttr(config.domesticRelayHost)}" />
        </label>
        <label class="field compact">
          <span>UDP</span>
          <input name="domesticRelayPort" inputmode="numeric" value="${escapeAttr(String(config.domesticRelayPort || ''))}" />
        </label>
      </div>
      <label class="field">
        <span>SDK Gateway</span>
        <input name="sdkGatewayBaseUrl" value="${escapeAttr(config.sdkGatewayBaseUrl)}" />
      </label>
      <label class="field">
        <span>Host Resolve</span>
        <input name="hostResolve" value="${escapeAttr(config.hostResolve || '')}" placeholder="h2i.mxinfo-inc.cn=<gateway-ip>" />
      </label>
      <label class="field">
        <span>Bootstrap DNS</span>
        <select name="bootstrapResolveMode">
          ${option('env-first', config.bootstrapResolveMode)}
          ${option('dns-first', config.bootstrapResolveMode)}
          ${option('env-only', config.bootstrapResolveMode)}
          ${option('dns-only', config.bootstrapResolveMode)}
        </select>
      </label>
      <label class="field">
        <span>Bootstrap DNS Servers</span>
        <input name="bootstrapDnsServers" value="${escapeAttr(config.bootstrapDnsServers || '')}" placeholder="223.5.5.5, 119.29.29.29" />
      </label>
      <label class="field">
        <span>WG Path</span>
        <select name="routePathPreference">
          ${option('auto', config.routePathPreference)}
          ${option('hybrid', config.routePathPreference)}
          ${option('direct', config.routePathPreference)}
          ${option('relay', config.routePathPreference)}
        </select>
      </label>
      <label class="field">
        <span>Split DNS Domains</span>
        <input name="splitDnsDomains" value="${escapeAttr(config.splitDnsDomains || '')}" placeholder="mxinfo-inc.cn, h2i.mxinfo-inc.cn" />
      </label>
      <div class="field-row">
        <label class="field">
          <span>Channel</span>
          <select name="releaseChannel">
            ${option('stable', config.releaseChannel)}
            ${option('beta', config.releaseChannel)}
            ${option('internal', config.releaseChannel)}
          </select>
        </label>
        <label class="field">
          <span>Gray</span>
          <input name="rolloutGroup" value="${escapeAttr(config.rolloutGroup)}" />
        </label>
      </div>
      <label class="check-row">
        <input name="useLocalEngineResources" type="checkbox" ${config.useLocalEngineResources ? 'checked' : ''} />
        <span>使用本地引擎资源</span>
      </label>
      <label class="check-row">
        <input name="restartAfterCodeUpdate" type="checkbox" ${config.restartAfterCodeUpdate ? 'checked' : ''} />
        <span>代码更新后自动重启</span>
      </label>
    </form>
  `;
}

function renderWorkbench(connected, connecting) {
  const contract = state.launcherContract || {};
  const foundation = contract.foundation || {};
  return `
    <section class="mx-workbench">
      ${screen === 'appcenter' ? renderAppShellBar('AppCenter', connected ? 'MX-H2I 已连接' : '等待 MX-H2I 连接', 'appcenter') : ''}
      ${renderFoundationDrawer(contract, foundation)}

      ${screen === 'appcenter' ? renderAppCenterView(connected) : renderLauncherView(connected, connecting)}
    </section>
  `;
}

function renderFoundationDrawer(contract, foundation) {
  const feedback = state.feedback?.message || '';
  const subject = state.connection?.subject || 'no active subject';
  const summary = feedback || `${state.connection?.state || 'idle'} / ${state.connection?.localIp || 'no lease'} / ${subject}`;
  return `
    <section class="foundation-drawer ${foundationOpen ? 'is-open' : ''}">
      <button class="foundation-toggle" type="button" data-action="toggle-foundation-panel">
        <span class="foundation-toggle-copy">
          <strong>MX-H2I Launcher Foundation</strong>
          <small>${escapeHtml(summary)}</small>
        </span>
        <span class="foundation-toggle-state">${foundationOpen ? '收起' : '展开'} <b>${foundationOpen ? '⌃' : '⌄'}</b></span>
      </button>
      ${foundationOpen ? renderFoundationDetails(contract, foundation) : ''}
    </section>
  `;
}

function renderFoundationDetails(contract, foundation) {
  return `
    <div class="foundation-content">
      ${renderFeedback()}
      <section class="workbench-grid">
        <section class="panel foundation-panel">
          <div class="panel-head">
            <div>
              <h3>Standalone owners</h3>
              <p>launcher 底座可被平级产品引用</p>
            </div>
            <span class="tag">${escapeHtml(contract.available ? 'sdk loaded' : 'sdk pending')}</span>
          </div>
          <div class="owner-list">
            ${(foundation.standaloneOwners || []).map(renderOwner).join('')}
          </div>
          <div class="capability-row">
            ${(foundation.sharedCapabilities || []).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
          </div>
        </section>

        <section class="panel runtime-panel">
          <div class="panel-head">
            <div>
              <h3>Runtime</h3>
              <p>${escapeHtml(state.connection?.subject || 'no active subject')}</p>
            </div>
            <span class="status-pill" data-state="${escapeAttr(state.connection?.state || 'idle')}">${escapeHtml(state.connection?.state || 'idle')}</span>
          </div>
          <div class="metric-grid">
            ${metric('Base URL', state.config?.internalApiBaseUrl)}
            ${metric('Relay', `${state.config?.domesticRelayHost}:${state.config?.domesticRelayPort}`)}
            ${metric('Local IP', state.connection?.localIp || '-')}
            ${metric('Route', state.connection?.routePolicy || '-')}
          </div>
        </section>
      </section>
    </div>
  `;
}

function renderAppShellBar(title, subtitle, activeTarget) {
  return `
    <header class="app-shell-bar" data-window-drag="true">
      <div class="app-shell-identity">
        <div class="app-shell-mark">MX</div>
        <div>
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml(subtitle)}</span>
        </div>
      </div>
      <div class="app-shell-actions">
        <button class="app-window-button" type="button" data-window-control="minimize" aria-label="Minimize">-</button>
        <button class="app-window-button" type="button" data-window-control="zoom" aria-label="Zoom">□</button>
        <div class="app-shell-menu">
          <button class="app-window-button" type="button" data-action="toggle-app-shell-menu" aria-label="App menu">...</button>
          ${appShellMenuOpen ? `
            <div class="app-shell-popover" role="menu">
              <button type="button" data-action="switch-app-shell" data-target="h2i" class="${activeTarget === 'h2i' ? 'is-active' : ''}">
                <span>H2I（VPN）</span>
                <small>返回连接面板</small>
              </button>
              <button type="button" data-action="switch-app-shell" data-target="appcenter" class="${activeTarget === 'appcenter' ? 'is-active' : ''}">
                <span>AppCenter</span>
                <small>应用中心</small>
              </button>
              <button type="button" data-action="switch-app-shell" data-target="close">
                <span>关闭</span>
                <small>关闭当前应用</small>
              </button>
            </div>
          ` : ''}
        </div>
      </div>
    </header>
  `;
}

function renderLauncherView(connected, connecting) {
  const appCenterInstalled = state.apps?.appcenter?.installed;
  return `
    <section class="panel app-registry-panel">
      <div class="panel-head">
        <div>
          <p class="kicker">APPLICATIONS</p>
          <h3>Launcher app registry</h3>
        </div>
        <button class="primary-button" type="button" data-action="${appCenterInstalled ? 'show-appcenter' : 'installAppCenter'}" ${!connected || busyAction === 'installAppCenter' ? 'disabled' : ''}>
          ${appCenterInstalled ? 'Open AppCenter' : 'Install AppCenter'}
        </button>
      </div>
      <div class="app-grid">
        ${renderAppCard(state.apps?.appcenter, {
          action: appCenterInstalled ? 'show-appcenter' : 'installAppCenter',
          actionLabel: appCenterInstalled ? 'Open' : 'Install',
          disabled: !connected || connecting
        })}
        ${renderAppCard(state.apps?.h2o, {
          action: 'enableH2o',
          actionLabel: state.apps?.h2o?.enabled ? 'Enabled' : 'Enable',
          disabled: !state.apps?.appcenter?.installed || state.apps?.h2o?.enabled
        })}
      </div>
    </section>
    ${renderUpdatePanel()}
  `;
}

function renderAppCenterView(connected) {
  const apps = appCatalog();
  const categories = appCenterCategories(apps);
  if (!categories.some((item) => item.id === appCategory)) appCategory = 'all';
  const visibleApps = filteredAppCatalog(apps);
  if (!apps.some((app) => app.appId === selectedAppId)) selectedAppId = apps[0]?.appId || 'h2o';
  const h2o = apps.find((app) => app.appId === 'h2o');
  const route = appCenterRoute === 'h2o' && h2o ? 'h2o' : 'catalog';
  const selected = route === 'h2o' ? h2o : apps.find((app) => app.appId === selectedAppId) || visibleApps[0] || apps[0] || null;
  const hasError = apps.some((app) => appNeedsAttention(app));
  return `
    <section class="appcenter-window appcenter-product ${route === 'h2o' ? 'is-app-managing' : ''} ${appDebugOpen ? 'is-debug-open' : ''} ${appInspectorCollapsed ? 'is-inspector-collapsed' : ''}">
      ${route === 'h2o' ? '' : `<aside class="appcenter-rail">
        <div class="appcenter-account">
          <div class="avatar-mark">${escapeHtml((state.identity?.displayName || 'V').slice(0, 1))}</div>
          <div>
            <strong>${escapeHtml(state.identity?.displayName || 'Visitor')}</strong>
            <span>${escapeHtml(state.identity?.account || 'MX-H2I workspace')}</span>
          </div>
        </div>
        <nav class="appcenter-nav" aria-label="AppCenter sections">
          ${categories.map((item) => `
            <button class="${appCategory === item.id ? 'is-active' : ''}" type="button" data-action="set-app-category" data-category="${escapeAttr(item.id)}">
              <span>${escapeHtml(item.label)}</span>
              <small>${escapeHtml(String(item.count))}</small>
            </button>
          `).join('')}
        </nav>
        <div class="appcenter-rail-foot">
          <button class="text-button" type="button" data-action="toggle-app-debug">${appDebugOpen ? '隐藏 Debug' : 'Debug'}</button>
          <span>${escapeHtml(hasError ? '有应用需要处理' : '所有应用正常')}</span>
        </div>
      </aside>`}

      <section class="appcenter-main ${route === 'h2o' ? 'is-h2o-manager' : ''}">
        <header class="appcenter-titlebar">
          <div>
            <p class="kicker">${route === 'h2o' ? 'APPCENTER / H2O' : 'APPCENTER'}</p>
            <h3>${route === 'h2o' ? 'H2O 管理' : '应用中心'}</h3>
            <span>${escapeHtml(route === 'h2o'
              ? 'Home To Oversea 通过 MX-H2I broker-session 托管出海策略'
              : connected ? 'MX-H2I 已连接，可以安装和打开应用' : '连接 MX-H2I 后可安装应用')}</span>
          </div>
          <div class="toolbar-actions">
            ${route === 'h2o' ? '<button class="secondary-button" type="button" data-action="show-app-catalog">返回市场</button>' : ''}
            <button class="secondary-button" type="button" data-action="toggle-app-debug">${appDebugOpen ? '关闭 Debug' : 'Debug'}</button>
            ${renderCheckUpdatesButton('primary-button')}
          </div>
        </header>

        ${hasError ? renderAppCenterErrorBanner(apps) : ''}

        ${route === 'h2o' ? renderH2oManager(h2o, connected) : `
          <section class="appcenter-marketbar">
            <div>
              <h4>${escapeHtml(appCategory === 'all' ? '推荐应用' : categoryTitle(appCategory))}</h4>
              <p>${escapeHtml(visibleApps.length)} 个应用</p>
            </div>
            <label class="appcenter-search">
              <span>⌕</span>
              <input data-app-search value="${escapeAttr(appSearch)}" placeholder="搜索应用" />
            </label>
          </section>

          <section class="catalog-grid appcenter-card-grid mx-scrollbar">
            ${visibleApps.length ? visibleApps.map((app) => renderAppCenterCard(app, connected, selected?.appId === app.appId)).join('') : renderEmptyCatalog()}
          </section>
        `}
      </section>

      ${selected ? renderAppCenterSidePanel(selected, connected) : ''}
    </section>
  `;
}

function appCatalog() {
  const h2o = state.apps?.h2o || {};
  const luo = state.apps?.luo || state.apps?.['luopan-bridge'] || {};
  const catalogShellAppIds = new Set([
    'appcenter',
    'mx-h2i',
    'mx-h2i-launcher',
    'h2i',
    'launcher',
    'h2o',
    'diagnostics',
    'luo',
    'luopan-bridge'
  ]);
  const dynamicApps = Object.entries(state.apps || {})
    .filter(([appId, app]) => {
      if (catalogShellAppIds.has(appId)) return false;
      const launcherMode = app?.launcherMode || 'embed';
      const channel = app?.standaloneChannelProductId || 'mx-h2i';
      return launcherMode === 'embed' && channel === 'mx-h2i';
    })
    .map(([appId, app]) => normalizeCatalogApp(app, {
      appId,
      displayName: app?.displayName || appId,
      category: app?.category || 'custom',
      description: app?.description || '',
      packageName: app?.packageName || `@qpjoy/electron-launcher-app-${appId}`
    }));
  return [
    normalizeCatalogApp(h2o, {
      appId: 'h2o',
      displayName: 'H2O',
      fullName: 'Home To Oversea',
      category: 'network',
      description: 'AppCenter 内置的 Home To Oversea 网络插件，提供类 Clash 的代理模式、PAC、Split DNS 和 Internal 出海状态面板。',
      packageName: '@qpjoy/electron-launcher-app-h2o',
      permissions: ['network.hdi.status', 'network.proxy.app', 'network.dns.policy', 'network.pac.policy', 'system:exec:mihomo'],
      requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'network.tunnel.mihomo', 'app-center-runtime'],
      manifest: {
        appId: 'h2o',
        productId: 'h2o',
        displayName: 'H2O',
        description: 'AppCenter 内置的 Home To Oversea 网络插件，提供类 Clash 的代理模式、PAC、Split DNS 和 Internal 出海状态面板。',
        packageName: '@qpjoy/electron-launcher-app-h2o',
        category: 'network',
        launcherMode: 'embed',
        protocolVersion: '2',
        runtimeContractVersion: '0.1',
        requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'network.tunnel.mihomo', 'app-center-runtime'],
        network: { scope: 'broker-session' },
        runtimeDependencies: {
          packages: ['@qpjoy/electron-plugin-tunnel', '@qpjoy/electron-core-mihomo'],
          optionalPackages: [
            '@qpjoy/electron-plugin-tunnel-engine-darwin-arm64',
            '@qpjoy/electron-plugin-tunnel-engine-darwin-x64',
            '@qpjoy/electron-plugin-tunnel-engine-linux-arm64',
            '@qpjoy/electron-plugin-tunnel-engine-linux-x64',
            '@qpjoy/electron-plugin-tunnel-engine-win32-x64'
          ]
        },
        embed: { standaloneChannelProductId: 'mx-h2i', launchWithoutBroker: 'blocked' }
      }
    }),
    ...dynamicApps,
    normalizeCatalogApp({
      appId: 'diagnostics',
      displayName: 'Diagnostics',
      category: 'ops',
      description: 'Route proof、H/D/I/O trace、broker smoke 和版本巡检。',
      packageName: '@qpjoy/electron-launcher-app-diagnostics',
      launcherMode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      networkScope: 'broker-session',
      version: '0.1.0',
      latestVersion: state.update?.latestVersion || '0.1.1',
      installed: true,
      enabled: true,
      status: 'ready',
      runtimeState: state.update?.status || 'idle',
      installSource: 'npm',
      permissions: ['observability.read', 'release.read'],
      entrypoints: { desktop: 'app://diagnostics/index.html' }
    }, {}),
    normalizeCatalogApp({
      ...luo,
      appId: 'luo',
      displayName: 'Luo',
      category: 'bridge',
      description: 'Launcher 网络、权限、用户和通道能力测试工具。',
      packageName: '@qpjoy/electron-launcher-app-luo',
      launcherMode: 'embed',
      standaloneChannelProductId: 'mx-h2i',
      networkScope: 'broker-session',
      version: luo.version || '0.1.0',
      latestVersion: luo.latestVersion || '0.1.0',
      installed: luo.installed === true,
      enabled: luo.enabled === true,
      status: luo.status || 'available',
      runtimeState: luo.runtimeState || (luo.installed ? 'ready' : 'idle'),
      installSource: luo.installSource || 'npm',
      permissions: ['launcher.bridge.read', 'network.status', 'permission.request'],
      entrypoints: { desktop: 'app://luo/index.html' }
    }, {})
  ];
}

function normalizeCatalogApp(app, defaults) {
  const row = app && typeof app === 'object' ? app : {};
  return {
    ...defaults,
    ...row,
    appId: row.appId || defaults.appId,
    displayName: row.displayName || defaults.displayName,
    fullName: row.fullName || defaults.fullName || '',
    category: row.category || defaults.category || 'custom',
    description: row.description || defaults.description || '',
    packageName: row.packageName || defaults.packageName || `@qpjoy/electron-launcher-app-${row.appId || defaults.appId}`,
    launcherMode: row.launcherMode || defaults.launcherMode || 'embed',
    standaloneChannelProductId: row.standaloneChannelProductId || defaults.standaloneChannelProductId || 'mx-h2i',
    networkScope: row.networkScope || defaults.networkScope || 'broker-session',
    version: row.version || defaults.version || '0.1.0',
    latestVersion: row.latestVersion || defaults.latestVersion || row.version || defaults.version || '0.1.0',
    installedVersion: row.installedVersion || defaults.installedVersion || null,
    installSource: row.installSource || defaults.installSource || 'npm',
    runtimeState: row.runtimeState || defaults.runtimeState || (row.enabled ? 'ready' : row.installed ? 'installed' : 'idle'),
    permissions: Array.isArray(row.permissions) ? row.permissions : defaults.permissions || [],
    requiredCapabilities: Array.isArray(row.requiredCapabilities) ? row.requiredCapabilities : defaults.requiredCapabilities || [],
    manifest: row.manifest || defaults.manifest || null,
    entrypoints: row.entrypoints || defaults.entrypoints || {}
  };
}

function filteredAppCatalog(apps) {
  const query = appSearch.trim().toLowerCase();
  return apps.filter((app) => {
    const matchesCategory = appCategory === 'all'
      || app.category === appCategory
      || (appCategory === 'updates' && app.latestVersion && app.latestVersion !== (app.installedVersion || app.version));
    if (!matchesCategory) return false;
    if (!query) return true;
    const haystack = [
      app.appId,
      app.displayName,
      app.category,
      app.packageName,
      app.description,
      app.networkScope,
      app.standaloneChannelProductId,
      ...(app.permissions || [])
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

function appCenterCategories(apps) {
  const rows = [
    { id: 'all', label: '全部应用', count: apps.length },
    { id: 'network', label: '网络工具', count: apps.filter((app) => app.category === 'network').length },
    { id: 'ops', label: '工具箱', count: apps.filter((app) => app.category === 'ops').length },
    { id: 'bridge', label: '测试工具', count: apps.filter((app) => app.category === 'bridge').length },
    { id: 'updates', label: '可更新', count: apps.filter((app) => app.latestVersion && app.latestVersion !== (app.installedVersion || app.version)).length }
  ];
  return rows.filter((item) => item.id === 'all' || item.count > 0);
}

function categoryTitle(category) {
  return appCenterCategories(appCatalog()).find((item) => item.id === category)?.label || '应用';
}

function renderAppCenterErrorBanner(apps) {
  const errored = apps.find((app) => appNeedsAttention(app));
  if (!errored) return '';
  const errorMessage = appVisibleErrorMessage(errored);
  return `
    <div class="appcenter-error-banner">
      <strong>${escapeHtml(errored.displayName)} 需要处理</strong>
      <span>${escapeHtml(errorMessage || '应用运行状态异常，打开 Debug 查看详情。')}</span>
      <button class="secondary-button" type="button" data-action="toggle-app-debug">Debug</button>
    </div>
  `;
}

function renderAppCenterCard(app, connected, selected) {
  const action = appPrimaryAction(app, connected);
  return `
    <article
      class="catalog-card appcenter-app-card ${selected ? 'is-active' : ''}"
      role="button"
      tabindex="0"
      data-action="select-app"
      data-app-id="${escapeAttr(app.appId)}"
      aria-label="${escapeAttr(`选择 ${app.displayName}`)}"
    >
      <div class="catalog-cover" data-category="${escapeAttr(app.category)}">
        <span>${escapeHtml(app.displayName.slice(0, 3).toUpperCase())}</span>
      </div>
      <div class="catalog-card-body">
        <div>
          <h4>${escapeHtml(app.displayName)}</h4>
          <p>${escapeHtml(app.description)}</p>
        </div>
        <div class="app-tag-row">
          ${appUserTags(app).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
        </div>
      </div>
      <div class="catalog-card-foot">
        <span class="status-dot" data-state="${escapeAttr(app.status || app.runtimeState || 'available')}">${escapeHtml(appUserStatus(app))}</span>
        <button class="secondary-button" type="button" data-action="${escapeAttr(action.action)}" data-app-id="${escapeAttr(app.appId)}" ${action.disabled ? 'disabled' : ''}>
          ${escapeHtml(action.label)}
        </button>
      </div>
    </article>
  `;
}

function renderAppCenterSidePanel(app, connected) {
  if (appInspectorCollapsed) return renderCollapsedAppInspector(app);
  return appDebugOpen ? renderAppCenterDebugPanel(app, connected) : renderAppCenterUserPanel(app, connected);
}

function renderCollapsedAppInspector(app) {
  return `
    <aside class="appcenter-inspector appcenter-inspector-rail">
      <button class="inspector-rail-button" type="button" data-action="toggle-app-inspector" aria-label="展开应用详情">
        <span class="app-icon-mini">${escapeHtml(app.displayName.slice(0, 3).toUpperCase())}</span>
        <strong>${escapeHtml(app.displayName)}</strong>
        <span aria-hidden="true">‹</span>
      </button>
    </aside>
  `;
}

function renderAppCenterUserPanel(app, connected) {
  const action = appPrimaryAction(app, connected);
  const errorMessage = appVisibleErrorMessage(app);
  return `
    <aside class="appcenter-inspector appcenter-user-panel mx-scrollbar">
      <div class="inspector-head">
        <div class="app-icon-large">${escapeHtml(app.displayName.slice(0, 3).toUpperCase())}</div>
        <div>
          <p class="kicker">${escapeHtml(categoryTitle(app.category))}</p>
          <h4>${escapeHtml(app.displayName)}</h4>
          <span>${escapeHtml(appUserStatus(app))}</span>
        </div>
        <button class="inspector-collapse-button" type="button" data-action="toggle-app-inspector" aria-label="收起应用详情">›</button>
      </div>
      <p class="inspector-summary">${escapeHtml(app.description)}</p>
      ${errorMessage ? `<div class="app-inline-error">${escapeHtml(errorMessage)}</div>` : ''}
      <div class="app-user-facts">
        <div><span>版本</span><strong>${escapeHtml(app.installedVersion || app.version || '0.1.0')}</strong></div>
        <div><span>更新</span><strong>${escapeHtml(app.latestVersion && app.latestVersion !== (app.installedVersion || app.version) ? `${app.latestVersion} 可用` : '已是最新')}</strong></div>
        <div><span>状态</span><strong>${escapeHtml(appUserStatus(app))}</strong></div>
      </div>
      <div class="app-feature-list">
        ${appUserFeatures(app).map((item) => `<div><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.detail)}</span></div>`).join('')}
      </div>
      ${app.appId === 'h2o' ? renderH2oPluginPanel(app) : ''}
      <div class="app-user-actions">
        <button class="primary-button block-button" type="button" data-action="${escapeAttr(action.action)}" ${action.disabled ? 'disabled' : ''}>
          ${escapeHtml(action.label)}
        </button>
        ${app.appId === 'h2o' && app.runtimeState === 'running'
          ? '<button class="secondary-button block-button" type="button" data-action="stopH2o">停止</button>'
          : ''}
        <button class="secondary-button block-button" type="button" data-action="toggle-app-debug">Debug</button>
      </div>
      ${renderAppRecentLogs(app)}
    </aside>
  `;
}

function renderAppCenterDebugPanel(app, connected) {
  const action = appPrimaryAction(app, connected);
  return `
    <aside class="appcenter-inspector appcenter-debug-panel mx-scrollbar">
      <div class="inspector-head">
        <div class="app-icon-large">${escapeHtml(app.displayName.slice(0, 3).toUpperCase())}</div>
        <div>
          <p class="kicker">DEBUG</p>
          <h4>${escapeHtml(app.displayName)}</h4>
          <span>${escapeHtml(app.packageName)}</span>
        </div>
        <button class="inspector-collapse-button" type="button" data-action="toggle-app-inspector" aria-label="收起应用详情">›</button>
      </div>
      <div class="detail-list">
        <div><span>Mode</span><strong>${escapeHtml(app.launcherMode)}</strong></div>
        <div><span>Channel</span><strong>${escapeHtml(app.standaloneChannelProductId || '-')}</strong></div>
        <div><span>Network</span><strong>${escapeHtml(app.networkScope || '-')}</strong></div>
        <div><span>Contract</span><strong>${escapeHtml(app.manifest?.runtimeContractVersion || '-')}</strong></div>
        <div><span>Install</span><strong>${escapeHtml(app.installSource || 'npm')}</strong></div>
        <div><span>Path</span><strong>${escapeHtml(app.installPath || '-')}</strong></div>
        <div><span>Installed</span><strong>${escapeHtml(app.installedVersion || (app.installed ? app.version : 'not installed'))}</strong></div>
        <div><span>Latest</span><strong>${escapeHtml(app.latestVersion || app.version)}</strong></div>
        <div><span>Runtime</span><strong>${escapeHtml(app.runtimeState || app.status || 'idle')}</strong></div>
        <div><span>Plugin Mode</span><strong>${escapeHtml(app.runtime?.mode || '-')}</strong></div>
        <div><span>Plugin Admin</span><strong>${escapeHtml(app.runtime?.adminUrl || '-')}</strong></div>
        <div><span>Plugin Ports</span><strong>${escapeHtml(app.runtime?.ports ? `mixed:${app.runtime.ports.mixed} dns:${app.runtime.ports.dns}` : '-')}</strong></div>
        <div><span>Last Action</span><strong>${escapeHtml(formatDateTime(app.lastAction))}</strong></div>
      </div>
      <div class="permission-stack">
        ${[...(app.permissions || []), ...(app.requiredCapabilities || [])].filter((item, index, rows) => rows.indexOf(item) === index).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}
      </div>
      <div class="entrypoint-box">
        <strong>Entrypoints</strong>
        ${Object.entries(app.entrypoints || {}).map(([key, value]) => `<span>${escapeHtml(key)}: ${escapeHtml(value)}</span>`).join('') || '<span>-</span>'}
      </div>
      ${renderAppRecentLogs(app, true)}
      <button class="primary-button block-button" type="button" data-action="${escapeAttr(action.action)}" ${action.disabled ? 'disabled' : ''}>
        ${escapeHtml(action.label)}
      </button>
      <button class="secondary-button block-button" type="button" data-action="toggle-app-debug">关闭 Debug</button>
    </aside>
  `;
}

function renderH2oManager(app, connected) {
  const runtime = h2oRuntime(app);
  const running = runtime.running === true;
  const activeSubscriptionReady = h2oHasUsableSubscription(runtime);
  const canLaunch = activeSubscriptionReady || h2oCanAutoHydrateSubscription(runtime);
  const refreshDisabled = !connected || (runtime.activeSubscription.requiresUser && !isUserIdentity()) || busyAction === 'refreshH2oSubscription';
  return `
    <section class="h2o-manager mx-scrollbar">
      <section class="h2o-manager-hero" data-state="${escapeAttr(running ? 'running' : runtime.status)}">
        <div>
          <p class="kicker">HOME TO OVERSEA</p>
          <h4>${escapeHtml(runtime.activeSubscription.name)}</h4>
          <span>${escapeHtml(h2oSubscriptionStatusText(runtime, connected))}</span>
        </div>
        <div class="h2o-manager-actions">
          <button class="secondary-button" type="button" data-action="refreshH2oSubscription" data-subscription-id="${escapeAttr(runtime.activeSubscription.id)}" ${refreshDisabled ? 'disabled' : ''}>刷新订阅</button>
          <button class="${running ? 'secondary-button' : 'primary-button'}" type="button" data-action="${running ? 'stopH2o' : 'launchH2o'}" ${!connected || (!running && !canLaunch) || busyAction === 'launchH2o' || busyAction === 'stopH2o' ? 'disabled' : ''}>
            ${running ? '停止' : '启动'}
          </button>
        </div>
      </section>

      <nav class="h2o-manager-tabs" aria-label="H2O sections">
        ${h2oManagerTab('overview', '首页')}
        ${h2oManagerTab('proxy', '代理')}
        ${h2oManagerTab('subscriptions', '订阅')}
        ${h2oManagerTab('rules', '规则')}
        ${h2oManagerTab('test', '测试')}
        ${h2oManagerTab('logs', '日志')}
      </nav>

      ${renderH2oManagerBody(runtime, app, connected)}
    </section>
  `;
}

function h2oManagerTab(id, label) {
  return `<button class="${h2oManagerView === id ? 'is-active' : ''}" type="button" data-action="set-h2o-view" data-view="${escapeAttr(id)}">${escapeHtml(label)}</button>`;
}

function renderH2oManagerBody(runtime, app, connected) {
  if (h2oManagerView === 'proxy') return renderH2oProxyManager(runtime, connected);
  if (h2oManagerView === 'subscriptions') return renderH2oSubscriptionManager(runtime, connected);
  if (h2oManagerView === 'rules') return renderH2oRuleManager(runtime, connected);
  if (h2oManagerView === 'test') return renderH2oTestManager(runtime, connected);
  if (h2oManagerView === 'logs') return renderH2oLogManager(runtime, app);
  return renderH2oOverviewManager(runtime, app, connected);
}

function renderH2oOverviewManager(runtime, app, connected) {
  const activeSubscriptionReady = h2oHasUsableSubscription(runtime);
  const canLaunch = activeSubscriptionReady || h2oCanAutoHydrateSubscription(runtime);
  return `
    <section class="h2o-manager-view">
      <div class="h2o-stat-grid">
        ${h2oStat('运行状态', h2oRuntimeStatusLabel(runtime))}
        ${h2oStat('当前模式', h2oModeLabel(runtime.mode))}
        ${h2oStat('当前订阅', runtime.activeSubscription.name)}
        ${h2oStat('活跃连接', String(runtime.metrics.connections || 0))}
        ${h2oStat('上传总量', formatBytes(runtime.metrics.uploadBytes))}
        ${h2oStat('下载总量', formatBytes(runtime.metrics.downloadBytes))}
        ${h2oStat('本地代理', `:${runtime.ports.mixed}`)}
        ${h2oStat('管理后台', `:${runtime.ports.admin}`)}
      </div>
      <section class="h2o-action-band">
        <div>
          <strong>${escapeHtml(runtime.running ? '策略运行中' : '策略未启动')}</strong>
          <span>${escapeHtml(runtime.running ? 'PAC、Split DNS 和代理规则由 MX-H2I broker-session 合并执行。' : '启动后 H2O 会使用当前 AppCenter 权限和 managed profile。')}</span>
        </div>
        <div class="toolbar-actions">
          <button class="secondary-button" type="button" data-action="requestH2oProxy" ${!runtime.running || !connected || !activeSubscriptionReady ? 'disabled' : ''}>应用策略</button>
          <button class="primary-button" type="button" data-action="${runtime.running ? 'stopH2o' : 'launchH2o'}" ${!connected || (!runtime.running && !canLaunch) ? 'disabled' : ''}>${runtime.running ? '停止' : '启动'}</button>
        </div>
      </section>
      <section class="h2o-rule-preview">
        <div class="panel-head">
          <div>
            <h4>常用规则</h4>
            <p>${escapeHtml(`${runtime.rules.filter((rule) => rule.enabled !== false).length} 条启用`)}</p>
          </div>
          <button class="secondary-button" type="button" data-action="set-h2o-view" data-view="rules">管理规则</button>
        </div>
        ${renderH2oRuleRows(runtime.rules.slice(0, 4), true)}
      </section>
      ${!app.installed ? '<p class="h2o-manager-note">H2O 尚未安装，先从右侧详情安装后再启动。</p>' : ''}
    </section>
  `;
}

function renderH2oProxyManager(runtime, connected) {
  const activeSubscriptionReady = h2oHasUsableSubscription(runtime);
  return `
    <section class="h2o-manager-view">
      <section class="h2o-action-band">
        <div>
          <strong>${escapeHtml(h2oModeLabel(runtime.mode))}</strong>
          <span>${escapeHtml(h2oModeGuidance(runtime.mode, runtime))}</span>
        </div>
        <div class="toolbar-actions">
          <button class="secondary-button" type="button" data-action="requestH2oProxy" ${!runtime.running || !connected || !activeSubscriptionReady ? 'disabled' : ''}>切换</button>
          <button class="primary-button" type="button" data-action="${runtime.tunInstalled ? 'uninstallH2oTun' : 'installH2oTun'}" ${!connected ? 'disabled' : ''}>${runtime.tunInstalled ? '卸载 TUN' : '安装 TUN'}</button>
        </div>
      </section>
      <div class="h2o-mode-grid">
        ${h2oManagerModeButton('app-rule', runtime.mode, 'App 模式')}
        ${h2oManagerModeButton('app-global', runtime.mode, '全局模式')}
        ${h2oManagerModeButton('system-tun', runtime.mode, '系统 TUN')}
      </div>
      <section class="h2o-port-panel">
        <div class="panel-head">
          <div>
            <h4>端口</h4>
            <p>推荐 mixed 23458 / DNS 1053</p>
          </div>
          <button class="secondary-button" type="button" data-action="saveH2oPorts">保存端口</button>
        </div>
        <div class="h2o-port-grid">
          ${h2oPortField('mixed', 'Mixed', runtime.ports.mixed)}
          ${h2oPortField('dns', 'DNS', runtime.ports.dns)}
          ${h2oPortField('controller', 'Controller', runtime.ports.controller)}
          ${h2oPortField('admin', 'Admin', runtime.ports.admin)}
        </div>
      </section>
      <div class="h2o-stat-grid is-compact">
        ${h2oStat('引擎来源', '内置 mihomo')}
        ${h2oStat('TUN', runtime.tunInstalled ? '已安装' : '未安装')}
        ${h2oStat('控制接口', `:${runtime.ports.controller}`)}
        ${h2oStat('最近应用', formatDateTime(runtime.lastAppliedAt))}
      </div>
    </section>
  `;
}

function renderH2oSubscriptionManager(runtime, connected) {
  const currentUserReady = isUserIdentity();
  const managedSubscription = runtime.subscriptions.find((item) => item.id === 'h2o-default') || runtime.activeSubscription;
  const refreshManagedDisabled = !connected || (managedSubscription.requiresUser && !currentUserReady) || busyAction === 'refreshH2oSubscription';
  const provisionDisabled = !connected || !currentUserReady || busyAction === 'provisionH2oOversea';
  const draft = h2oSubscriptionDraft || defaultH2oSubscriptionDraft();
  const editing = Boolean(h2oSubscriptionEditId);
  return `
    <section class="h2o-manager-view">
      <section class="h2o-action-band">
        <div>
          <strong>Managed Oversea Profile</strong>
          <span>${escapeHtml(h2oManagedProfileSummary(runtime, currentUserReady))}</span>
        </div>
        <div class="toolbar-actions">
          <button class="primary-button" type="button" data-action="provisionH2oOversea" ${provisionDisabled ? 'disabled' : ''}>分配系统默认</button>
          <button class="secondary-button" type="button" data-action="refreshH2oSubscription" data-subscription-id="${escapeAttr(managedSubscription.id)}" ${refreshManagedDisabled ? 'disabled' : ''}>刷新系统默认</button>
        </div>
      </section>
      <form class="h2o-subscription-form" data-form-action="add-h2o-subscription">
        <input name="name" placeholder="订阅名称" autocomplete="off" value="${escapeAttr(draft.name)}" />
        <input name="url" type="url" placeholder="订阅链接 https://..." autocomplete="off" required value="${escapeAttr(draft.url)}" />
        <select name="authType">
          <option value="none" ${draft.authType === 'basic' ? '' : 'selected'}>无认证</option>
          <option value="basic" ${draft.authType === 'basic' ? 'selected' : ''}>Basic Auth</option>
        </select>
        <input name="username" placeholder="Basic 用户" autocomplete="username" value="${escapeAttr(draft.username)}" />
        <input name="password" type="password" placeholder="Basic 密码" autocomplete="current-password" value="${escapeAttr(draft.password)}" />
        <button class="primary-button" type="submit" ${busyAction === 'updateH2oRuntime' ? 'disabled' : ''}>${editing ? '保存修改' : '保存订阅'}</button>
        ${editing ? '<button class="secondary-button" type="button" data-action="cancelH2oSubscriptionEdit">取消</button>' : ''}
      </form>
      <div class="h2o-subscription-list">
        ${runtime.subscriptions.map((item) => {
          const usable = h2oSubscriptionUsable(item);
          const authBadge = h2oSubscriptionAuthBadge(item);
          const isCustom = item.source === 'custom';
          const canDelete = h2oSubscriptionCanDelete(item);
          return `
          <article class="${item.id === runtime.activeSubscription.id ? 'is-active' : ''} ${usable ? '' : 'is-disabled'}">
            <div>
              <strong>${escapeHtml(item.name)}</strong>
              <span>${escapeHtml(item.url)}</span>
            </div>
            <div class="h2o-subscription-meta">
              <span>${escapeHtml(h2oSubscriptionBadge(item))}</span>
              ${authBadge ? `<span>${escapeHtml(authBadge)}</span>` : ''}
              <span>${escapeHtml(String(item.nodes || 0))} nodes</span>
              <span>${escapeHtml(String(item.latencyMs || '-'))} ms</span>
              <span>${escapeHtml(formatDateTime(item.lastUpdatedAt))}</span>
            </div>
            ${item.errorMessage ? `<small class="h2o-subscription-reason">${escapeHtml(item.errorMessage)}</small>` : ''}
            <div class="toolbar-actions">
              <button class="secondary-button" type="button" data-action="pinH2oSubscription" data-subscription-id="${escapeAttr(item.id)}" ${busyAction === 'updateH2oRuntime' ? 'disabled' : ''}>置顶</button>
              <button class="secondary-button" type="button" data-action="editH2oSubscription" data-subscription-id="${escapeAttr(item.id)}" ${!isCustom || busyAction === 'updateH2oRuntime' ? 'disabled' : ''}>编辑</button>
              <button class="secondary-button" type="button" data-action="deleteH2oSubscription" data-subscription-id="${escapeAttr(item.id)}" ${!canDelete || busyAction === 'updateH2oRuntime' ? 'disabled' : ''}>删除</button>
              <button class="secondary-button" type="button" data-action="refreshH2oSubscription" data-subscription-id="${escapeAttr(item.id)}" ${!connected || (item.requiresUser && !currentUserReady) || busyAction === 'refreshH2oSubscription' ? 'disabled' : ''}>刷新</button>
              <button class="primary-button" type="button" data-action="setH2oSubscription" data-subscription-id="${escapeAttr(item.id)}" ${item.id === runtime.activeSubscription.id || !connected || !usable ? 'disabled' : ''}>使用</button>
            </div>
          </article>
        `; }).join('')}
      </div>
    </section>
  `;
}

function renderH2oRuleManager(runtime, connected) {
  return `
    <section class="h2o-manager-view">
      <section class="h2o-rule-packs">
        ${H2O_RULE_PACKS.map((pack) => `
          <article>
            <div>
              <strong>${escapeHtml(pack.label)}</strong>
              <span>${escapeHtml(String(pack.hosts.length))} domains / CDN</span>
            </div>
            <div class="toolbar-actions">
              <button class="secondary-button" type="button" data-action="addH2oRulePack" data-rule-pack="${escapeAttr(pack.id)}" ${!connected ? 'disabled' : ''}>添加</button>
              <button class="secondary-button" type="button" data-action="removeH2oRulePack" data-rule-pack="${escapeAttr(pack.id)}" ${!connected ? 'disabled' : ''}>移除</button>
            </div>
          </article>
        `).join('')}
      </section>
      <form class="h2o-rule-form" data-form-action="add-h2o-rule">
        <input name="host" placeholder="example.com" />
        <select name="kind">
          <option value="allow">白名单</option>
          <option value="block">黑名单</option>
        </select>
        <button class="primary-button" type="submit" ${!connected ? 'disabled' : ''}>添加</button>
      </form>
      ${renderH2oRuleRows(runtime.rules, false)}
    </section>
  `;
}

function renderH2oTestManager(runtime, connected) {
  return `
    <section class="h2o-manager-view">
      <section class="h2o-test-panel">
        <input data-h2o-test-url value="${escapeAttr(h2oTestUrlDraft || H2O_DEFAULT_TEST_URL)}" />
        <button class="primary-button" type="button" data-action="runH2oTest" ${!connected ? 'disabled' : ''}>打开测试窗口</button>
      </section>
      <section class="h2o-test-presets">
        ${H2O_TEST_PRESETS.map((preset) => `
          <button class="secondary-button" type="button" data-action="runH2oTest" data-test-url="${escapeAttr(preset.url)}" ${!connected ? 'disabled' : ''}>${escapeHtml(preset.label)}</button>
        `).join('')}
      </section>
      <div class="h2o-stat-grid is-compact">
        ${h2oStat('当前模式', h2oModeLabel(runtime.mode))}
        ${h2oStat('本地代理', `:${runtime.ports.mixed}`)}
        ${h2oStat('运行状态', h2oRuntimeStatusLabel(runtime))}
      </div>
    </section>
  `;
}

function renderH2oLogManager(runtime, app) {
  const rows = h2oLogRows(runtime, app);
  return `
    <section class="h2o-manager-view">
      <div class="h2o-log-stream">
        ${rows.map((item) => `
          <div data-level="${escapeAttr(item.level || 'info')}">
            <strong>${escapeHtml(item.message)}</strong>
            <span>${escapeHtml(formatDateTime(item.at))}</span>
          </div>
        `).join('') || '<p class="empty">暂无日志</p>'}
      </div>
    </section>
  `;
}

function renderH2oRuleRows(rules, compact) {
  return `
    <div class="h2o-rule-list ${compact ? 'is-compact' : ''}">
      ${rules.map((rule) => `
        <article class="${rule.enabled === false ? 'is-disabled' : ''}" data-kind="${escapeAttr(rule.kind)}">
          <div>
            <strong>${escapeHtml(rule.host)}</strong>
            <span>${escapeHtml(rule.target)}</span>
          </div>
          <em>${escapeHtml(h2oRuleKindLabel(rule.kind))}</em>
          ${compact ? '' : `<button class="secondary-button" type="button" data-action="toggleH2oRule" data-rule-id="${escapeAttr(rule.id)}">${rule.enabled === false ? '启用' : '停用'}</button>`}
        </article>
      `).join('') || '<p class="empty">暂无规则</p>'}
    </div>
  `;
}

function h2oStat(label, value) {
  return `<article class="h2o-stat-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong></article>`;
}

function h2oManagerModeButton(mode, activeMode, label) {
  return `<button class="${mode === activeMode ? 'is-active' : ''}" type="button" data-action="setH2oMode" data-mode="${escapeAttr(mode)}">${escapeHtml(label)}</button>`;
}

function h2oPortField(name, label, value) {
  return `
    <label>
      <span>${escapeHtml(label)}</span>
      <input data-h2o-port="${escapeAttr(name)}" inputmode="numeric" value="${escapeAttr(String(value || ''))}" />
    </label>
  `;
}

function renderH2oPluginPanel(app) {
  const runtime = h2oRuntime(app);
  const ports = runtime.ports || {};
  const subscription = runtime.activeSubscription || {};
  return `
    <div class="h2o-plugin-panel">
      <div class="h2o-plugin-head">
        <strong>代理模式</strong>
        <span>${escapeHtml(h2oModeLabel(runtime.mode))}</span>
      </div>
      <div class="h2o-mode-row">
        ${h2oModeButton('app-rule', runtime.mode, '规则')}
        ${h2oModeButton('app-global', runtime.mode, '全局')}
        ${h2oModeButton('system-tun', runtime.mode, 'TUN')}
      </div>
      <div class="h2o-runtime-facts">
        <div><span>订阅</span><strong>${escapeHtml(subscription.name || 'System Oversea 默认订阅')}</strong></div>
        <div><span>节点</span><strong>${escapeHtml(String(subscription.nodes || 0))}</strong></div>
        <div><span>延迟</span><strong>${escapeHtml(subscription.latencyMs ? `${subscription.latencyMs} ms` : '-')}</strong></div>
        <div><span>端口</span><strong>${escapeHtml(`:${ports.mixed || 23458}`)}</strong></div>
      </div>
    </div>
  `;
}

function h2oModeButton(mode, activeMode, label) {
  return `<button class="${mode === activeMode ? 'is-active' : ''}" type="button" data-action="setH2oMode" data-mode="${escapeAttr(mode)}">${escapeHtml(label)}</button>`;
}

function h2oModeLabel(mode) {
  if (mode === 'app-global') return '全局模式';
  if (mode === 'system-tun') return '系统 TUN';
  return 'App 模式';
}

function h2oRuntimeStatusLabel(runtime) {
  if (runtime.running) return '运行中';
  if (runtime.status === 'starting') return '启动中';
  if (runtime.status === 'subscription-initializing') return '初始化订阅';
  if (runtime.status === 'ready') return '就绪';
  if (runtime.status === 'error') return '异常';
  if (runtime.status === 'proxy-unavailable') return '端口未监听';
  if (runtime.status === 'tun-required') return '等待 TUN';
  if (runtime.status === 'subscription-required') return '等待订阅';
  return '已停止';
}

function h2oModeGuidance(mode, runtime) {
  if (mode === 'system-tun') {
    return runtime.tunInstalled
      ? '系统 TUN 由 MX-H2I standalone 统一分发，覆盖当前应用、应用内通道以及系统浏览器和其他应用；黑名单阻止访问。'
      : '系统 TUN 需要先安装本机 helper。';
  }
  if (mode === 'app-global') return '全局模式由 MX-H2I standalone 注册分发，覆盖当前应用和后续新建 BrowserWindow；国内 cn-direct，黑名单阻止访问，其余走 H2O。';
  return 'App 模式只覆盖当前应用；cn-direct 优先，配置白名单后仅白名单域名走 H2O，H2O 不可用时回退系统代理。';
}

function h2oRuleKindLabel(kind) {
  return kind === 'block' ? '黑名单' : '白名单';
}

function h2oSubscriptionBadge(item) {
  if (item.requiresUser && !isUserIdentity()) return '等待登录';
  if (item.status === 'login-required') return '等待登录';
  if (item.syncStatus === 'initializing') return '初始化中';
  if (item.status === 'error') return '异常';
  if (item.status === 'pending') return item.syncStatus === 'pending-runtime-sync' ? '待同步' : '待分配';
  if (item.source === 'custom') return '自定义';
  if (item.source === 'demo') return 'Demo';
  return '系统';
}

function h2oSubscriptionAuthBadge(item) {
  if (item?.auth?.type === 'basic') return 'Basic Auth';
  if (item?.headers && Object.keys(item.headers).length) return 'Headers';
  return '';
}

function h2oManagedProfileSummary(runtime, currentUserReady) {
  if (!currentUserReady) return '系统 oversea 默认订阅需要登录用户；Visitor 不会自动获得 admin 指派节点。';
  const active = runtime?.activeSubscription || {};
  if (active.source === 'custom' || active.source === 'external') {
    return '当前使用自定义订阅；系统 oversea-main 可在这里分配/刷新，成功后不会覆盖自定义 active。';
  }
  if (active.syncStatus === 'initializing') return '正在为当前用户初始化系统 oversea 订阅；完成后会自动作为 H2O 默认连接。';
  if (h2oSubscriptionUsable(active)) return '已使用当前用户从 Internal / k8s admin 获取系统 oversea 配置。';
  return '已登录；可从 Internal 分配或刷新 oversea-main，失败时会保留已有可用外部订阅。';
}

function h2oSubscriptionStatusText(runtime, connected) {
  if (!connected) return '等待 MX-H2I standalone channel。';
  if (!h2oHasUsableSubscription(runtime)) {
    const subscription = runtime.activeSubscription || {};
    if (subscription.requiresUser && !isUserIdentity()) return '当前系统 oversea 订阅等待登录用户，暂不可启动 H2O。';
    if (subscription.syncStatus === 'initializing') return '正在为当前用户初始化系统 oversea 订阅，请稍等。';
    if (subscription.status === 'pending') {
      return subscription.syncStatus === 'pending-runtime-sync'
        ? '当前用户已有 oversea entitlement，但 oversea runtime 尚未同步完成。'
        : '当前用户还没有可用的系统 oversea 订阅，H2O 会尝试自动分配；失败后可手动添加订阅。';
    }
    if (subscription.status === 'error') {
      return subscription.errorMessage || '获取 Internal oversea 订阅失败，请检查 k8s admin 的 Oversea 状态。';
    }
    return '当前订阅未就绪，先在订阅页选择可用 profile。';
  }
  const subscription = runtime.activeSubscription || {};
  if (subscription.source === 'custom' || subscription.source === 'external') {
    return '当前使用自定义订阅，H2O 已通过 broker-session 托管代理策略。';
  }
  return 'Internal broker 已连接，H2O 使用当前用户的 managed oversea profile。';
}

function h2oHasUsableSubscription(runtime) {
  return h2oSubscriptionUsable(runtime?.activeSubscription);
}

function h2oCanAutoHydrateSubscription(runtime) {
  const subscription = runtime?.activeSubscription || {};
  return isUserIdentity()
    && (subscription.requiresUser === true || subscription.source === 'internal' || /^mx-h2i:\/\//i.test(String(subscription.url || '')));
}

function h2oSubscriptionUsable(item) {
  if (!item) return false;
  if (item.requiresUser && !isUserIdentity()) return false;
  if (['login-required', 'pending', 'error'].includes(item.status)) return false;
  if (!h2oLooksLikeHttpSubscriptionUrl(item.url)) return false;
  return Number(item.nodes || 0) > 0;
}

function h2oSubscriptionCanDelete(item) {
  if (!item) return false;
  return !['h2o-default', 'h2o-oversea-backup'].includes(String(item.id || ''));
}

function isUserIdentity() {
  return state?.identity?.kind === 'user'
    || state?.connection?.mode === 'employee'
    || h2oSubjectLooksLikeUser(state?.auth?.subject)
    || h2oSubjectLooksLikeUser(state?.connection?.subject);
}

function h2oSubjectLooksLikeUser(subject) {
  return String(subject || '').trim().startsWith('user:');
}

function h2oLooksLikeHttpSubscriptionUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

function h2oRuntime(app = state.apps?.h2o) {
  const runtime = app?.runtime && typeof app.runtime === 'object' ? app.runtime : {};
  const ports = runtime.ports && typeof runtime.ports === 'object' ? runtime.ports : {};
  const activeSeed = runtime.activeSubscription && typeof runtime.activeSubscription === 'object'
    ? runtime.activeSubscription
    : {};
  const subscriptions = normalizeH2oSubscriptions(runtime.subscriptions, activeSeed);
  const activeId = runtime.activeSubscriptionId || activeSeed.id || subscriptions[0]?.id || 'h2o-default';
  const activeSubscription = subscriptions.find((item) => item.id === activeId) || subscriptions[0] || normalizeH2oSubscription(activeSeed);
  const rawStatus = runtime.status || (runtime.running === true ? 'running' : 'stopped');
  const status = runtime.running !== true && rawStatus === 'ready' && !h2oSubscriptionUsable(activeSubscription)
    ? 'subscription-required'
    : rawStatus;
  return {
    kind: 'h2o-plugin',
    mode: normalizeH2oModeUi(runtime.mode),
    running: runtime.running === true,
    status,
    tunInstalled: runtime.tunInstalled === true,
    adminUrl: runtime.adminUrl || 'http://127.0.0.1:23456',
    ports: {
      admin: normalizePortUi(ports.admin, 23456),
      controller: normalizePortUi(ports.controller, 23457),
      mixed: normalizePortUi(ports.mixed, 23458),
      dns: normalizePortUi(ports.dns, 1053)
    },
    activeSubscription,
    activeSubscriptionId: activeSubscription.id,
    subscriptions,
    rules: normalizeH2oRules(runtime.rules),
    metrics: normalizeH2oMetrics(runtime.metrics),
    startedAt: runtime.startedAt || null,
    lastAppliedAt: runtime.lastAppliedAt || null
  };
}

function normalizeH2oModeUi(value) {
  const text = String(value || '').trim();
  if (text === 'global') return 'app-global';
  if (text === 'rule') return 'app-rule';
  if (text === 'tun') return 'system-tun';
  if (text === 'direct') return 'app-global';
  return ['app-rule', 'app-global', 'system-tun'].includes(text) ? text : 'app-global';
}

function normalizeH2oSubscriptions(value, activeSeed) {
  const rows = Array.isArray(value) ? value : [];
  const subscriptions = rows
    .map((item) => normalizeH2oSubscription(item))
    .filter((item) => item && !h2oShouldDropSubscription(item));
  const active = normalizeH2oSubscription(activeSeed);
  if (!h2oShouldDropSubscription(active) && !subscriptions.some((item) => item.id === active.id)) subscriptions.unshift(active);
  if (!subscriptions.some((item) => item.id === 'h2o-default')) {
    subscriptions.unshift(normalizeH2oSubscription({
      id: 'h2o-default',
      name: 'System Oversea 默认订阅',
      url: 'mx-h2i://managed/home-to-oversea',
      nodes: 6,
      latencyMs: 42,
      status: isUserIdentity() ? 'pending' : 'login-required',
      source: 'internal',
      requiresUser: true,
      syncStatus: isUserIdentity() ? 'missing-entitlement' : 'login-required',
      errorMessage: isUserIdentity() ? '当前用户还没有可用的系统 oversea 订阅。' : '系统 oversea 订阅需要先登录员工用户。'
    }));
  }
  return orderH2oSubscriptions(subscriptions).slice(0, 12);
}

function normalizeH2oSubscription(input) {
  const row = input && typeof input === 'object' ? input : {};
  const id = String(row.id || 'h2o-default');
  const source = String(row.source || 'internal');
  const requiresUser = row.requiresUser === true || (source !== 'demo' && source !== 'custom' && source !== 'external' && id.startsWith('h2o-'));
  let status = requiresUser && !isUserIdentity()
    ? 'login-required'
    : String(row.status || (requiresUser && source === 'internal' ? 'pending' : 'ready'));
  if (requiresUser && isUserIdentity() && status === 'login-required') {
    status = source === 'internal' || h2oIsManagedSubscriptionIdUi(id) ? 'pending' : status;
  }
  const rawSyncStatus = row.syncStatus || null;
  const syncStatus = status === 'pending' && rawSyncStatus === 'login-required' ? 'missing-entitlement' : rawSyncStatus;
  const rawErrorMessage = row.errorMessage || null;
  const errorMessage = status === 'pending' && /登录员工用户|等待登录|login/i.test(String(rawErrorMessage || ''))
    ? '当前用户还没有可用的系统 oversea 订阅。'
    : rawErrorMessage;
  return {
    id,
    name: String(row.name || 'System Oversea 默认订阅'),
    url: String(row.url || 'mx-h2i://managed/home-to-oversea'),
    nodes: normalizeNonNegativeUi(row.nodes, 6),
    latencyMs: normalizeNonNegativeUi(row.latencyMs, 42),
    status,
    source,
    requiresUser,
    assignable: row.assignable !== false,
    entitlementId: row.entitlementId || null,
    siteIds: Array.isArray(row.siteIds) ? row.siteIds.map((item) => String(item || '').trim()).filter(Boolean) : [],
    syncStatus,
    errorMessage,
    yamlBytes: normalizeNonNegativeUi(row.yamlBytes, 0),
    auth: normalizeH2oSubscriptionAuth(row.auth),
    headers: normalizeStringRecordUi(row.headers),
    pinnedAt: row.pinnedAt || null,
    lastUpdatedAt: row.lastUpdatedAt || new Date().toISOString()
  };
}

function h2oIsManagedSubscriptionIdUi(id) {
  const text = String(id || '');
  return text === 'h2o-default'
    || text === 'h2o-oversea-backup'
    || /^h2o-oversea-/i.test(text);
}

function h2oShouldDropSubscription(item) {
  return String(item?.id || '') === 'h2o-oversea-backup';
}

function orderH2oSubscriptions(subscriptions) {
  return subscriptions
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftPinned = Date.parse(left.item.pinnedAt || '');
      const rightPinned = Date.parse(right.item.pinnedAt || '');
      const leftHasPin = Number.isFinite(leftPinned);
      const rightHasPin = Number.isFinite(rightPinned);
      if (leftHasPin && rightHasPin) return rightPinned - leftPinned || left.index - right.index;
      if (leftHasPin) return -1;
      if (rightHasPin) return 1;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

function normalizeH2oSubscriptionAuth(value) {
  const row = value && typeof value === 'object' ? value : {};
  if (String(row.type || '').trim().toLowerCase() === 'basic') {
    return {
      type: 'basic',
      username: String(row.username || ''),
      password: String(row.password || '')
    };
  }
  return { type: 'none', username: null, password: null };
}

function normalizeH2oRules(value) {
  const rows = Array.isArray(value) ? value : [];
  const normalized = rows.map((item) => {
    const row = item && typeof item === 'object' ? item : {};
    const host = String(row.host || '').trim();
    if (!host) return null;
    const kind = normalizeH2oRuleKind(row.kind || policyToRuleKind(row.policy));
    return {
      id: String(row.id || ruleIdFromHost(host)),
      host,
      target: String(row.target || defaultRuleTarget(kind)),
      kind,
      enabled: row.enabled !== false,
      source: String(row.source || 'managed'),
      hitCount: normalizeNonNegativeUi(row.hitCount, 0)
    };
  }).filter(Boolean);
  if (normalized.length) return normalized.slice(0, 96);
  return [
    { id: 'google', host: 'google.com', target: 'App 模式白名单', kind: 'allow', enabled: true, source: 'preset:google', hitCount: 0 },
    { id: 'youtube', host: 'youtube.com', target: 'App 模式白名单', kind: 'allow', enabled: true, source: 'preset:youtube', hitCount: 0 },
    { id: 'telegram', host: 'telegram.org', target: 'App 模式白名单', kind: 'allow', enabled: true, source: 'preset:telegram', hitCount: 0 },
    { id: 'internal-api', host: 'api.mxinfo-inc.cn', target: '全局/TUN 黑名单', kind: 'block', enabled: true, source: 'builtin', hitCount: 0 }
  ];
}

function normalizeH2oMetrics(value) {
  const row = value && typeof value === 'object' ? value : {};
  return {
    uploadBytes: normalizeNonNegativeUi(row.uploadBytes, 0),
    downloadBytes: normalizeNonNegativeUi(row.downloadBytes, 0),
    connections: normalizeNonNegativeUi(row.connections, 0),
    lastProxyAppliedAt: row.lastProxyAppliedAt || null
  };
}

function normalizePortUi(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function normalizeNonNegativeUi(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function normalizeStringRecordUi(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [String(key || '').trim(), String(item || '').trim()])
    .filter(([key, item]) => key && item));
}

function readH2oPortFields() {
  const ports = {};
  for (const input of root.querySelectorAll('[data-h2o-port]')) {
    ports[input.dataset.h2oPort] = Number(input.value || 0);
  }
  return ports;
}

function readH2oRuleForm(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  return {
    host: String(payload.host || ''),
    kind: String(payload.kind || 'allow')
  };
}

function defaultH2oSubscriptionDraft() {
  return {
    name: '',
    url: '',
    authType: 'none',
    username: '',
    password: ''
  };
}

function resetH2oSubscriptionDraft() {
  h2oSubscriptionEditId = '';
  h2oSubscriptionDraft = defaultH2oSubscriptionDraft();
}

function h2oSubscriptionDraftFromItem(item) {
  return {
    name: String(item?.name || ''),
    url: String(item?.url || ''),
    authType: item?.auth?.type === 'basic' ? 'basic' : 'none',
    username: String(item?.auth?.username || ''),
    password: String(item?.auth?.password || '')
  };
}

function readH2oSubscriptionForm(form) {
  const payload = Object.fromEntries(new FormData(form).entries());
  return {
    name: String(payload.name || ''),
    url: String(payload.url || ''),
    authType: String(payload.authType || 'none'),
    username: String(payload.username || ''),
    password: String(payload.password || '')
  };
}

function readH2oTestUrl() {
  const input = root.querySelector('[data-h2o-test-url]');
  return input?.value || h2oTestUrlDraft || H2O_DEFAULT_TEST_URL;
}

function setH2oTestUrl(url) {
  h2oTestUrlDraft = url || H2O_DEFAULT_TEST_URL;
  const input = root.querySelector('[data-h2o-test-url]');
  if (input) input.value = h2oTestUrlDraft;
}

function h2oRuleFromInput(input) {
  const host = String(input?.host || '').trim() || 'example.com';
  const kind = normalizeH2oRuleKind(input?.kind || policyToRuleKind(input?.policy));
  return {
    id: input?.id || ruleIdFromHost(host),
    host,
    target: defaultRuleTarget(kind),
    kind,
    enabled: true,
    source: input?.source || 'manual',
    hitCount: 0
  };
}

function upsertH2oRule(rules, rule) {
  const host = String(rule.host || '').toLowerCase();
  const next = normalizeH2oRules(rules).filter((item) => (
    item.id !== rule.id
    && !(String(item.host || '').toLowerCase() === host && item.kind === rule.kind)
  ));
  return [rule, ...next].slice(0, 96);
}

function h2oRulePack(packId) {
  return H2O_RULE_PACKS.find((pack) => pack.id === packId) || H2O_RULE_PACKS[0];
}

function h2oRulesFromPack(pack) {
  return pack.hosts.map((host) => h2oRuleFromInput({
    id: `pack-${pack.id}-${ruleIdFromHost(host)}`,
    host,
    kind: pack.kind,
    source: `pack:${pack.id}`
  }));
}

function addH2oRulePack(rules, pack) {
  let next = normalizeH2oRules(rules);
  for (const rule of h2oRulesFromPack(pack)) {
    next = upsertH2oRule(next, rule);
  }
  return next;
}

function removeH2oRulePack(rules, pack) {
  const hosts = new Set(pack.hosts.map((host) => String(host || '').toLowerCase()));
  return normalizeH2oRules(rules).filter((rule) => (
    rule.source !== `pack:${pack.id}`
    && !hosts.has(String(rule.host || '').toLowerCase())
  ));
}

function h2oCustomSubscriptionFromInput(input) {
  const parsed = parseH2oCustomSubscriptionUrl(input?.url);
  if (!parsed) return null;
  const url = parsed.url;
  const name = String(input?.name || '').trim() || h2oSubscriptionNameFromUrl(url);
  const authType = String(input?.authType || '').trim().toLowerCase();
  const embeddedUsername = parsed.username;
  const embeddedPassword = parsed.password;
  const authUsername = String(input?.username || '').trim() || embeddedUsername;
  const authPassword = String(input?.password || '') || embeddedPassword;
  const auth = authType === 'basic' || embeddedUsername || embeddedPassword
    ? {
      type: 'basic',
      username: authUsername,
      password: authPassword
    }
    : { type: 'none', username: null, password: null };
  return normalizeH2oSubscription({
    id: input?.id || `custom-${subscriptionIdFromText(url)}`,
    name,
    url,
    nodes: 1,
    latencyMs: 0,
    status: 'ready',
    source: 'custom',
    requiresUser: false,
    assignable: true,
    auth,
    syncStatus: 'saved',
    errorMessage: null,
    lastUpdatedAt: new Date().toISOString()
  });
}

function h2oCustomSubscriptionValidationError(input) {
  const rawUrl = String(input?.url || '').trim();
  if (!rawUrl) return '请先填写订阅链接。';
  const parsed = parseH2oCustomSubscriptionUrl(rawUrl);
  if (!parsed) return '订阅链接必须是有效的 http 或 https 地址。';
  const authType = String(input?.authType || '').trim().toLowerCase();
  const needsBasic = authType === 'basic' || parsed.username || parsed.password;
  if (needsBasic) {
    const username = String(input?.username || '').trim() || parsed.username;
    const password = String(input?.password || '') || parsed.password;
    if (!username || !password) return 'Basic Auth 订阅需要填写用户名和密码，或在 URL 中带完整账号密码。';
  }
  return '';
}

function parseH2oCustomSubscriptionUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_err) {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const username = safeDecodeUrlPart(parsed.username);
  const password = safeDecodeUrlPart(parsed.password);
  parsed.username = '';
  parsed.password = '';
  return { url: parsed.toString(), username, password };
}

function safeDecodeUrlPart(value) {
  const text = String(value || '');
  if (!text) return '';
  try {
    return decodeURIComponent(text);
  } catch (_err) {
    return text;
  }
}

function upsertH2oSubscription(subscriptions, subscription) {
  const normalized = normalizeH2oSubscriptions(subscriptions, subscription);
  const normalizedUrl = normalizedSubscriptionUrlForCompare(subscription.url);
  const next = normalized.filter((item) => (
    item.id !== subscription.id
    && normalizedSubscriptionUrlForCompare(item.url) !== normalizedUrl
  ));
  return [subscription, ...next].slice(0, 12);
}

function pinH2oSubscription(subscriptions, subscriptionId) {
  const normalized = normalizeH2oSubscriptions(subscriptions);
  const target = normalized.find((item) => item.id === subscriptionId);
  if (!target) return normalized;
  const pinned = { ...target, pinnedAt: new Date().toISOString() };
  return [pinned, ...normalized.filter((item) => item.id !== subscriptionId)].slice(0, 12);
}

function normalizedSubscriptionUrlForCompare(url) {
  const parsed = parseH2oCustomSubscriptionUrl(url);
  return parsed?.url || String(url || '');
}

function h2oSubscriptionNameFromUrl(url) {
  try {
    return new URL(url).hostname || 'Custom Oversea 订阅';
  } catch (_err) {
    return 'Custom Oversea 订阅';
  }
}

function subscriptionIdFromText(value) {
  const safe = String(value || 'subscription')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return safe || 'subscription';
}

function ruleIdFromHost(host) {
  return String(host || 'rule').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'rule';
}

function defaultRuleTarget(kind) {
  return kind === 'block' ? '全局/TUN 黑名单' : 'App 模式白名单';
}

function normalizeH2oRuleKind(value) {
  return String(value || '').trim() === 'block' ? 'block' : 'allow';
}

function policyToRuleKind(policy) {
  return ['internal-direct', 'direct', 'block', 'blacklist'].includes(String(policy || '').trim()) ? 'block' : 'allow';
}

function h2oLogRows(runtime, app) {
  const logs = Array.isArray(app.logs) ? app.logs : [];
  const synthetic = [
    runtime.lastAppliedAt ? { level: 'info', message: `Runtime applied: ${h2oModeLabel(runtime.mode)}`, at: runtime.lastAppliedAt } : null,
    runtime.startedAt ? { level: 'info', message: 'H2O runtime started.', at: runtime.startedAt } : null,
    runtime.metrics.lastProxyAppliedAt ? { level: 'info', message: 'Broker proxy policy applied.', at: runtime.metrics.lastProxyAppliedAt } : null
  ].filter(Boolean);
  return [...logs, ...synthetic].slice(0, 20);
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function appUserTags(app) {
  const tags = [];
  if (app.category === 'network') tags.push('网络');
  if (app.category === 'platform') tags.push('平台');
  if (app.category === 'ops') tags.push('工具');
  if (app.installed) tags.push('已安装');
  if (app.latestVersion && app.latestVersion !== (app.installedVersion || app.version)) tags.push('可更新');
  if (!tags.length) tags.push('应用');
  return tags.slice(0, 3);
}

function appUserStatus(app) {
  if (appNeedsAttention(app)) return '需要处理';
  if (app.status === 'reserved') return '即将推出';
  if (app.runtimeState === 'running') return '运行中';
  if (app.installed && app.enabled) return '已安装';
  if (app.installed) return '已缓存';
  return '可安装';
}

function appUserFeatures(app) {
  if (app.appId === 'h2o') {
    return [
      { title: 'Home To Oversea', detail: '按 App、全局或系统 TUN 模式托管出海策略。' },
      { title: '订阅和规则', detail: '沿用类 Clash 的订阅、规则、端口和日志模型。' },
      { title: '共享底座', detail: '通过 MX-H2I broker-session 继承用户、网络和权限。' }
    ];
  }
  if (app.appId === 'appcenter') {
    return [
      { title: '应用管理', detail: '安装、打开和更新内置应用。' },
      { title: '轻量更新', detail: '应用以 package 形式分发，重启后即可生效。' }
    ];
  }
  if (app.appId === 'diagnostics') {
    return [
      { title: '问题排查', detail: '网络和更新检查集中在这里。' },
      { title: '日志收集', detail: '出现错误时可复制给开发人员。' }
    ];
  }
  return [
    { title: '预留应用', detail: '管理员开放后会出现在这里。' }
  ];
}

function renderAppRecentLogs(app, verbose = false) {
  const logs = Array.isArray(app.logs) ? app.logs : [];
  const errorMessage = appVisibleErrorMessage(app);
  if (!logs.length && !errorMessage) return '';
  const rows = errorMessage
    ? [{ level: 'error', message: errorMessage, at: app.lastAction || new Date().toISOString() }, ...logs]
    : logs;
  return `
    <div class="app-log-list ${verbose ? 'is-verbose' : ''}">
      <strong>${verbose ? 'Logs' : '最近状态'}</strong>
      ${rows.slice(0, verbose ? 8 : 3).map((item) => `
        <div data-level="${escapeAttr(item.level || 'info')}">
          <span>${escapeHtml(item.message)}</span>
          <small>${escapeHtml(formatDateTime(item.at))}</small>
        </div>
      `).join('')}
    </div>
  `;
}

function appNeedsAttention(app) {
  if (!app) return false;
  if (h2oHasIdleProxyError(app)) return false;
  return Boolean(app.errorMessage || app.runtimeState === 'error' || app.status === 'error');
}

function appVisibleErrorMessage(app) {
  if (h2oHasIdleProxyError(app)) return '';
  return app?.errorMessage || '';
}

function h2oHasIdleProxyError(app) {
  if (app?.appId !== 'h2o' || !app.errorMessage) return false;
  return /mixed-port|未监听|proxy-unavailable|H2O mihomo 恢复失败/i.test(String(app.errorMessage || ''));
}

function appPrimaryAction(app, connected) {
  if (app.appId === 'appcenter') {
    return { action: 'show-appcenter', label: app.installed ? '打开' : '安装', disabled: !connected || busyAction === 'installAppCenter' };
  }
  if (app.appId === 'h2o') {
    if (app.installed && app.enabled) {
      return {
        action: app.runtimeState === 'running' ? 'showH2oManager' : 'launchH2o',
        label: app.runtimeState === 'running' ? '打开管理' : '启动',
        disabled: !connected || busyAction === 'launchH2o'
      };
    }
    return { action: 'enableH2o', label: '安装', disabled: !connected || !state.apps?.appcenter?.installed || busyAction === 'enableH2o' };
  }
  if (app.appId === 'diagnostics') {
    return { action: 'checkUpdates', label: connected ? '检查' : '连接后检查', disabled: busyAction === 'checkUpdates' };
  }
  return { action: 'select-app', label: '即将推出', disabled: true };
}

function appStatusLabel(app) {
  if (app.status === 'reserved') return 'Reserved';
  if (app.runtimeState === 'running') return 'Running';
  if (app.installed && app.enabled) return 'Installed';
  if (app.installed) return 'Cached';
  return 'Available';
}

function renderEmptyCatalog() {
  return `
    <div class="empty-catalog">
      <strong>No app matched</strong>
      <span>Try another keyword or category.</span>
    </div>
  `;
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function renderLegacyAppCenterView(connected) {
  return `
    <section class="appcenter-window">
      <header class="appcenter-titlebar">
        <div>
          <p class="kicker">APPCENTER</p>
          <h3>Installed through MX-H2I</h3>
        </div>
        <span class="status-pill" data-state="${connected ? 'connected' : 'idle'}">${connected ? 'channel ready' : 'offline'}</span>
      </header>
      <div class="appcenter-layout">
        <aside class="appcenter-nav">
          <button class="is-active" type="button">All Apps</button>
          <button type="button">Network</button>
          <button type="button">Platform</button>
          <button type="button">Updates</button>
        </aside>
        <section class="catalog-grid">
          ${renderCatalogCard('H2O', 'network', '规则、订阅、PAC、Split DNS', state.apps?.h2o?.enabled ? 'Enabled' : 'Available', 'enableH2o')}
          ${renderCatalogCard('Diagnostics', 'ops', 'H/D/I/O trace、route plan、日志', 'Bundled', 'checkUpdates')}
          ${renderCatalogCard('Luopan Bridge', 'reserved', '未来可切换到 luopan standalone channel', 'Reserved', 'show-launcher')}
        </section>
        <aside class="detail-panel">
          <h4>H2O runtime</h4>
          <div class="detail-list">
            <div><span>Mode</span><strong>embed</strong></div>
            <div><span>Channel</span><strong>mx-h2i</strong></div>
            <div><span>Network scope</span><strong>broker-session</strong></div>
            <div><span>Service context</span><strong>via MX-H2I</strong></div>
            <div><span>Permissions</span><strong>network / dns / pac</strong></div>
          </div>
          <button class="primary-button block-button" type="button" data-action="enableH2o" ${!state.apps?.appcenter?.installed ? 'disabled' : ''}>
            ${state.apps?.h2o?.enabled ? 'Open H2O' : 'Enable H2O'}
          </button>
        </aside>
      </div>
    </section>
  `;
}

function renderFeedback() {
  const feedback = state.feedback;
  if (!feedback) return '';
  return `<div class="feedback" data-tone="${escapeAttr(feedback.tone || 'info')}">${escapeHtml(feedback.message || '')}</div>`;
}

function renderOwner(owner) {
  return `
    <article class="owner-row ${owner.state === 'active' ? 'is-active' : ''}">
      <div class="product-icon">${escapeHtml(owner.productId === 'mx-h2i' ? 'H2I' : 'LP')}</div>
      <div>
        <strong>${escapeHtml(owner.displayName)}</strong>
        <span>${escapeHtml(owner.productId)} / ${escapeHtml(owner.serviceVip)}</span>
      </div>
      <span class="status-pill" data-state="${escapeAttr(owner.state)}">${escapeHtml(owner.state)}</span>
    </article>
  `;
}

function renderAppCard(app, options) {
  if (!app) return '';
  return `
    <article class="app-card ${app.enabled ? 'is-enabled' : ''}">
      <div class="product-icon">${escapeHtml(app.appId === 'h2o' ? 'H2O' : 'APP')}</div>
      <div>
        <h4>${escapeHtml(app.displayName)}</h4>
        <p>${escapeHtml(app.launcherMode)} via ${escapeHtml(app.standaloneChannelProductId)}</p>
      </div>
      <div class="app-card-meta">
        <span>${escapeHtml(app.networkScope || (app.launcherMode === 'embed' ? 'broker-session' : app.serviceVip))}</span>
        <strong>${escapeHtml(app.installed ? app.status : 'available')}</strong>
      </div>
      <button class="secondary-button" type="button" data-action="${escapeAttr(options.action)}" ${options.disabled ? 'disabled' : ''}>
        ${escapeHtml(options.actionLabel)}
      </button>
    </article>
  `;
}

function renderCatalogCard(name, category, summary, status, action) {
  return `
    <article class="catalog-card">
      <div class="catalog-cover" data-category="${escapeAttr(category)}"></div>
      <div>
        <h4>${escapeHtml(name)}</h4>
        <p>${escapeHtml(summary)}</p>
      </div>
      <div class="catalog-card-foot">
        <span>${escapeHtml(status)}</span>
        <button class="secondary-button" type="button" data-action="${escapeAttr(action)}">${status === 'Enabled' ? 'Open' : 'Select'}</button>
      </div>
    </article>
  `;
}

function renderUpdatePanel() {
  const update = state.update || {};
  const hasArtifact = Boolean(update.artifactUrl);
  const downloading = busyAction === 'applyUpdate' || update.status === 'downloading';
  const applyDisabled = !hasArtifact || downloading || ['staged', 'installer-opened'].includes(update.status);
  const actionLabel = updateApplyLabel(update);
  return `
    <section class="panel update-panel">
      <div class="panel-head">
        <div>
          <h3>Release / Gray</h3>
          <p>由 Launcher standalone 更新器执行</p>
        </div>
        <button class="secondary-button" type="button" data-action="openAdmin">Admin</button>
      </div>
      <div class="metric-grid">
        ${metric('Status', update.status)}
        ${metric('Current', update.currentVersion)}
        ${metric('Latest', update.latestVersion)}
        ${metric('Policy', update.policy)}
        ${metric('Gray', update.rolloutGroup)}
        ${metric('Release', update.releaseId)}
        ${metric('Artifact', update.artifactKind || update.componentKind)}
        ${metric('Platform', update.artifactPlatform || '-')}
        ${metric('Activation', update.activation || (update.majorUpdateRequiresInstaller ? 'installer-manual' : update.hotUpdateAuto ? 'hot-auto' : '-'))}
        ${metric('Matched by', rolloutMatchedByLabel(update))}
      </div>
      ${update.releaseNotes ? `
        <div class="update-release-notes">
          <span>Release notes</span>
          <pre>${escapeHtml(update.releaseNotes)}</pre>
        </div>
      ` : ''}
      <div class="update-actions">
        ${renderCheckUpdatesButton('secondary-button')}
        <button class="primary-button" type="button" data-action="applyUpdate" ${applyDisabled ? 'disabled' : ''}>${escapeHtml(actionLabel)}</button>
        ${update.restartPrompt ? '<button class="secondary-button" type="button" data-action="restartApp">重启</button>' : ''}
      </div>
      ${renderUpdateProgress(update)}
      ${renderReleaseHistory(update)}
      ${renderRollbackSlots(update)}
      ${update.reason ? `<p class="panel-note">${escapeHtml(update.reason)}</p>` : ''}
    </section>
  `;
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong></div>`;
}

// docs/19 §6: the decision explains why this install did (not) receive the
// release, so the panel can answer "为什么我(没)拿到这个版本".
function rolloutMatchedByLabel(update) {
  if (update.rolloutMatchedBy === 'target-list') return '指定用户/安装';
  if (update.rolloutMatchedBy === 'percentage') {
    return Number.isFinite(update.rolloutBucket) ? `灰度命中（bucket ${update.rolloutBucket}）` : '灰度命中';
  }
  if (update.rolloutMatchedBy === 'all') return '全部用户';
  return '-';
}

function pathLabel(value) {
  if (value === 'hdi-relay') return 'H2I via Domestic relay';
  if (value === 'h2i-direct') return 'H2I direct';
  if (value === 'h2i-hybrid') return 'H2I hybrid';
  return value || '-';
}

function compactList(value) {
  const items = Array.isArray(value) ? value : [];
  if (!items.length) return '-';
  const text = items.map((item) => {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object') return item.cidr || item.destination || item.interfaceName || JSON.stringify(item);
    return String(item || '');
  }).filter(Boolean).join(', ');
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

function compactText(value, limit = 90) {
  const text = String(value || '').trim();
  if (!text) return '-';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

function connectionCaption() {
  const connection = state.connection || {};
  if (busyAction === 'disconnect') return '正在等待一次系统授权，以原子停止 WireGuard 并恢复 PAC / split DNS';
  if (isConnectionPending()) {
    if (connection.state === 'lease-only') return `${connection.localIp || '已分配租约'} / 等待系统授权完成`;
    if (busyAction === 'login-employee' && connection.mode === 'guest') return `${connection.localIp || '访客网络'} / 正在验证员工身份，访客连接保持中`;
    return '正在准备 WireGuard、DNS、PAC 和权限上下文';
  }
  if (connection.state === 'connecting') return '正在准备 WireGuard、DNS、PAC 和权限上下文';
  if (connection.state === 'connected') return `${connection.localIp} / ${connection.routePolicy}`;
  if (connection.state === 'tunnel-only') return `${connection.localIp} / tunnel only / ${connection.health?.internalApi || 'internal pending'}`;
  if (connection.state === 'lease-only') return `${connection.localIp} / lease only / ${connection.health?.wireGuard || 'wg pending'}`;
  if (connection.state === 'network-unavailable') return `${connection.localIp || '未分配'} / network unavailable`;
  if (connection.state === 'server-unavailable') return `${connection.localIp || '未分配'} / server redeploying`;
  if (connection.state === 'forbidden') return `${connection.localIp || '未分配'} / blocked`;
  return 'standalone launcher channel owner';
}

function readConfigForm(form) {
  const formData = new FormData(form);
  return {
    bootstrapApiBaseUrl: String(formData.get('bootstrapApiBaseUrl') || ''),
    internalApiBaseUrl: String(formData.get('internalApiBaseUrl') || ''),
    domesticRelayHost: String(formData.get('domesticRelayHost') || ''),
    domesticRelayPort: Number(formData.get('domesticRelayPort') || 0),
    sdkGatewayBaseUrl: String(formData.get('sdkGatewayBaseUrl') || ''),
    hostResolve: String(formData.get('hostResolve') || ''),
    bootstrapResolveMode: String(formData.get('bootstrapResolveMode') || ''),
    bootstrapDnsServers: String(formData.get('bootstrapDnsServers') || ''),
    routePathPreference: String(formData.get('routePathPreference') || ''),
    splitDnsDomains: String(formData.get('splitDnsDomains') || ''),
    releaseChannel: String(formData.get('releaseChannel') || ''),
    rolloutGroup: String(formData.get('rolloutGroup') || ''),
    useLocalEngineResources: formData.get('useLocalEngineResources') === 'on',
    restartAfterCodeUpdate: formData.get('restartAfterCodeUpdate') === 'on'
  };
}

function option(value, selected) {
  return `<option value="${escapeAttr(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(value)}</option>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mockH2oManagedSubscriptionUrl() {
  return 'http://10.88.88.88:18090/internal/v1/user-center/users/mock/oversea/subscription.yaml';
}

function createMockApi() {
  let mockState = {
    config: {
      bootstrapApiBaseUrl: 'http://h2i.mxinfo-inc.cn:18090',
      internalApiBaseUrl: 'http://10.88.88.88:18090',
      domesticRelayHost: '116.62.51.154',
      domesticRelayPort: 51280,
      sdkGatewayBaseUrl: 'http://h2i.mxinfo-inc.cn:18090/internal/v1/sdk',
      hostResolve: '',
      bootstrapResolveMode: 'env-first',
      bootstrapDnsServers: '',
      routePathPreference: 'auto',
      splitDnsDomains: 'mxinfo-inc.cn,h2i.mxinfo-inc.cn',
      releaseChannel: 'stable',
      rolloutGroup: 'staff-ring',
      useLocalEngineResources: true,
      restartAfterCodeUpdate: true
    },
    connection: {
      state: 'idle',
      mode: 'guest',
      localIp: null,
      routePolicy: 'none',
      subject: null,
      connectedAt: null,
      health: {
        wireGuard: 'idle',
        domesticRelay: 'idle',
        internalApi: 'idle',
        splitDns: 'idle',
        appBroker: 'idle'
      }
    },
    identity: {
      kind: 'anonymous',
      displayName: 'Visitor',
      account: null,
      scopes: ['auth.read']
    },
    apps: {
      appcenter: {
        appId: 'appcenter',
        displayName: 'AppCenter',
        category: 'platform',
        description: '内置应用市场，负责应用发现、安装、权限申请和版本状态。',
        packageName: '@qpjoy/electron-launcher-appcenter',
        launcherMode: 'embed',
        standaloneChannelProductId: 'mx-h2i',
        networkScope: 'broker-session',
        serviceVip: '10.88.100.9',
        version: '0.1.0',
        latestVersion: '0.1.0',
        updatePolicy: 'launcher-managed',
        permissions: ['auth.read', 'appcenter.read'],
        installSource: 'builtin',
        installPath: 'builtin://appcenter',
        runtimeState: 'idle',
        logs: [],
        entrypoints: {
          desktop: 'app://appcenter/index.html',
          settings: 'app://appcenter/settings.html'
        },
        installed: false,
        enabled: false,
        status: 'available'
      },
      h2o: {
        appId: 'h2o',
        displayName: 'H2O',
        fullName: 'Home To Oversea',
        category: 'network',
        description: 'AppCenter 内置的 Home To Oversea 网络插件，提供类 Clash 的代理模式、PAC、Split DNS 和 Internal 出海状态面板。',
        packageName: '@qpjoy/electron-launcher-app-h2o',
        launcherMode: 'embed',
        standaloneChannelProductId: 'mx-h2i',
        networkScope: 'broker-session',
        serviceVip: '10.88.100.10',
        version: '0.1.0',
        latestVersion: '0.1.0',
        updatePolicy: 'launcher-managed',
        permissions: ['network.hdi.status', 'network.proxy.app', 'network.dns.policy', 'network.pac.policy', 'system:exec:mihomo'],
        requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'network.tunnel.mihomo', 'app-center-runtime'],
        manifest: {
          appId: 'h2o',
          productId: 'h2o',
          displayName: 'H2O',
          description: 'AppCenter 内置的 Home To Oversea 网络插件，提供类 Clash 的代理模式、PAC、Split DNS 和 Internal 出海状态面板。',
          packageName: '@qpjoy/electron-launcher-app-h2o',
          category: 'network',
          launcherMode: 'embed',
          protocolVersion: '2',
          runtimeContractVersion: '0.1',
          requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'network.tunnel.mihomo', 'app-center-runtime'],
          network: { scope: 'broker-session' },
          runtimeDependencies: {
            packages: ['@qpjoy/electron-plugin-tunnel', '@qpjoy/electron-core-mihomo'],
            optionalPackages: [
              '@qpjoy/electron-plugin-tunnel-engine-darwin-arm64',
              '@qpjoy/electron-plugin-tunnel-engine-darwin-x64',
              '@qpjoy/electron-plugin-tunnel-engine-linux-arm64',
              '@qpjoy/electron-plugin-tunnel-engine-linux-x64',
              '@qpjoy/electron-plugin-tunnel-engine-win32-x64'
            ]
          },
          embed: { standaloneChannelProductId: 'mx-h2i', launchWithoutBroker: 'blocked' }
        },
        installSource: 'npm',
        installPath: null,
        runtime: {
          kind: 'h2o-plugin',
          mode: 'app-global',
          running: false,
          status: 'stopped',
          tunInstalled: false,
          adminUrl: 'http://127.0.0.1:23456',
          ports: { admin: 23456, controller: 23457, mixed: 23458, dns: 1053 },
          subscriptions: [
            { id: 'h2o-default', name: 'System Oversea 默认订阅', url: 'mx-h2i://managed/home-to-oversea', nodes: 6, latencyMs: 42, status: 'login-required', source: 'internal', requiresUser: true, lastUpdatedAt: new Date().toISOString() }
          ],
          activeSubscriptionId: 'h2o-default',
          activeSubscription: {
            id: 'h2o-default',
            name: 'System Oversea 默认订阅',
            url: 'mx-h2i://managed/home-to-oversea',
            nodes: 6,
            latencyMs: 42,
            status: 'login-required',
            source: 'internal',
            requiresUser: true,
            lastUpdatedAt: new Date().toISOString()
          },
          rules: [
            { id: 'google', host: 'google.com', target: 'App 模式白名单', kind: 'allow', enabled: true, source: 'preset:google', hitCount: 0 },
            { id: 'youtube', host: 'youtube.com', target: 'App 模式白名单', kind: 'allow', enabled: true, source: 'preset:youtube', hitCount: 0 },
            { id: 'telegram', host: 'telegram.org', target: 'App 模式白名单', kind: 'allow', enabled: true, source: 'preset:telegram', hitCount: 0 },
            { id: 'internal-api', host: 'api.mxinfo-inc.cn', target: '全局/TUN 黑名单', kind: 'block', enabled: true, source: 'builtin', hitCount: 0 }
          ],
          metrics: { uploadBytes: 0, downloadBytes: 0, connections: 0, lastProxyAppliedAt: null },
          startedAt: null,
          lastAppliedAt: null
        },
        runtimeState: 'idle',
        logs: [],
        entrypoints: {
          desktop: 'app://h2o/index.html',
          settings: 'app://h2o/settings.html',
          dev: 'workspace:demos/mx-app-h2o'
        },
        installed: false,
        enabled: false,
        status: 'available'
      }
    },
    update: {
      status: 'idle',
      currentVersion: '0.1.0',
      latestVersion: '0.1.0',
      policy: 'launcher-managed',
      channel: 'stable',
      rolloutGroup: 'staff-ring',
      canSkip: false,
      lastCheckedAt: null,
      updateAvailable: false,
      history: [],
      availableReleases: [],
      rollbackSlots: [],
      downloadProgress: null,
      restartPrompt: false
    },
    launcherContract: {
      packageName: '@qpjoy/electron-launcher',
      available: true,
      product: {
        productId: 'mx-h2i',
        displayName: 'MX-H2I',
        mode: 'standalone'
      },
      foundation: {
        runtimeName: 'Launcher Foundation',
        socketNamespace: '~/.qpjoy/mx-launcher/sockets/{standaloneChannelProductId}.sock',
        sharedCapabilities: ['auth', 'permission', 'release', 'network', 'observability'],
        standaloneOwners: [
          { productId: 'mx-h2i', displayName: 'MX-H2I', state: 'active', serviceVip: '10.88.100.1' },
          { productId: 'luopan', displayName: 'Luopan', state: 'reserved', serviceVip: '10.88.110.1' }
        ]
      }
    },
    diagnosticLog: {
      enabled: true,
      fileName: 'mx-h2i-runtime.ndjson',
      maxBytes: 2 * 1024 * 1024,
      rotations: 2,
      recent: [
        { at: new Date().toISOString(), level: 'warning', event: 'network.diagnostics-problem', message: 'Mock Windows NRPT global policy is disabled.' }
      ]
    },
    feedback: null,
    activity: [],
    updatedAt: new Date().toISOString()
  };

  const commit = (patch) => {
    mockState = {
      ...mockState,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    return clone(mockState);
  };

  return {
    getState: async () => clone(mockState),
    saveConfig: async (input) => commit({ config: { ...mockState.config, ...input }, feedback: { tone: 'success', message: '配置已保存。' } }),
    connectGuest: async () => commit({
      connection: {
        ...mockState.connection,
        state: 'connected',
        mode: 'guest',
        localIp: '10.89.120.24',
        routePolicy: 'guest limited',
        subject: 'anonymousPrincipal:h2i-demo',
        health: {
          wireGuard: 'ready',
          domesticRelay: 'ready',
          internalApi: 'ready',
          splitDns: 'ready',
          appBroker: 'ready'
        }
      },
      feedback: null
    }),
    loginEmployee: async (input) => {
      const now = new Date().toISOString();
      const subscriptions = (mockState.apps.h2o.runtime?.subscriptions || []).map((item) => item.requiresUser
        ? {
          ...item,
          url: h2oLooksLikeHttpSubscriptionUrl(item.url) ? item.url : mockH2oManagedSubscriptionUrl(),
          status: 'ready',
          syncStatus: 'synced',
          nodes: Math.max(item.nodes || 0, 1),
          lastUpdatedAt: now
        }
        : item);
      const activeSubscription = subscriptions.find((item) => item.id === 'h2o-default') || mockState.apps.h2o.runtime.activeSubscription;
      return commit({
        connection: {
          ...mockState.connection,
          state: 'connected',
          mode: 'employee',
          localIp: '10.89.8.24',
          routePolicy: 'user full',
          subject: `user:${String(input.account || 'employee').split('@')[0]}`,
          health: {
            wireGuard: 'ready',
            domesticRelay: 'ready',
            internalApi: 'ready',
            splitDns: 'ready',
            appBroker: 'ready'
          }
        },
        identity: {
          kind: 'user',
          displayName: String(input.account || 'employee').split('@')[0],
          account: input.account || 'employee@qpjoy.local',
          scopes: ['auth.read', 'appcenter.read', 'network.hdi.status']
        },
        apps: {
          ...mockState.apps,
          h2o: {
            ...mockState.apps.h2o,
            runtime: {
              ...mockState.apps.h2o.runtime,
              subscriptions,
              activeSubscription,
              activeSubscriptionId: activeSubscription.id,
              status: mockState.apps.h2o.runtime?.running ? 'running' : 'ready',
              lastAppliedAt: now
            }
          }
        },
        feedback: null
      });
    },
    disconnect: async () => commit({
      connection: {
        ...mockState.connection,
        state: 'idle',
        localIp: null,
        routePolicy: 'none',
        subject: null,
        health: {
          wireGuard: 'idle',
          domesticRelay: 'idle',
          internalApi: 'idle',
          splitDns: 'idle',
          appBroker: 'idle'
        }
      },
      feedback: { tone: 'info', message: '连接已断开。' }
    }),
    installAppCenter: async () => commit({
      apps: {
        ...mockState.apps,
        appcenter: {
          ...mockState.apps.appcenter,
          installed: true,
          enabled: true,
          status: 'ready',
          installedVersion: mockState.apps.appcenter.version,
          latestVersion: mockState.apps.appcenter.latestVersion || mockState.apps.appcenter.version,
          installPath: 'builtin://appcenter',
          installedAt: new Date().toISOString(),
          runtimeState: 'ready',
          lastAction: new Date().toISOString(),
          logs: [{ level: 'info', message: 'AppCenter builtin runtime is ready.', at: new Date().toISOString() }]
        }
      },
      feedback: { tone: 'success', message: 'AppCenter 已安装，package/version 已写入本地缓存。' }
    }),
    enableH2o: async () => commit({
      apps: {
        ...mockState.apps,
        h2o: {
          ...mockState.apps.h2o,
          installed: true,
          enabled: true,
          status: 'enabled',
          installedVersion: mockState.apps.h2o.version,
          latestVersion: mockState.apps.h2o.latestVersion || mockState.apps.h2o.version,
          installSource: 'workspace',
          installPath: 'workspace:demos/mx-app-h2o',
          installedAt: new Date().toISOString(),
          runtimeState: 'ready',
          lastAction: new Date().toISOString(),
          logs: [{ level: 'info', message: 'Installed @qpjoy/electron-launcher-app-h2o from workspace.', at: new Date().toISOString() }]
        }
      },
      feedback: { tone: 'success', message: 'H2O 已启用，broker-session 权限已就绪。' }
    }),
    launchH2o: async () => commit({
      apps: {
        ...mockState.apps,
        h2o: {
          ...mockState.apps.h2o,
          installed: true,
          enabled: true,
          status: 'running',
          runtimeState: 'running',
          installedVersion: mockState.apps.h2o.installedVersion || mockState.apps.h2o.version,
          runtime: {
            ...mockState.apps.h2o.runtime,
            running: true,
            status: 'running',
            startedAt: mockState.apps.h2o.runtime?.startedAt || new Date().toISOString(),
            lastAppliedAt: new Date().toISOString(),
            metrics: {
              ...(mockState.apps.h2o.runtime?.metrics || {}),
              connections: 1,
              lastProxyAppliedAt: new Date().toISOString()
            }
          },
          lastAction: new Date().toISOString(),
          logs: [{ level: 'info', message: 'H2O runtime started from AppCenter.', at: new Date().toISOString() }, ...(mockState.apps.h2o.logs || [])]
        }
      },
      feedback: { tone: 'success', message: 'H2O 运行态已就绪，已在 AppCenter 内打开管理页。' }
    }),
    stopH2o: async () => commit({
      apps: {
        ...mockState.apps,
        h2o: {
          ...mockState.apps.h2o,
          status: 'enabled',
          runtimeState: 'ready',
          runtime: {
            ...mockState.apps.h2o.runtime,
            running: false,
            status: 'stopped',
            startedAt: null,
            lastAppliedAt: new Date().toISOString()
          },
          lastAction: new Date().toISOString(),
          logs: [{ level: 'info', message: 'H2O runtime stopped from AppCenter.', at: new Date().toISOString() }, ...(mockState.apps.h2o.logs || [])]
        }
      },
      feedback: { tone: 'info', message: 'H2O 已停止，配置和订阅仍保留。' }
    }),
    setH2oMode: async (mode) => commit({
      apps: {
        ...mockState.apps,
        h2o: {
          ...mockState.apps.h2o,
          runtime: {
            ...mockState.apps.h2o.runtime,
            mode,
            lastAppliedAt: new Date().toISOString()
          },
          logs: [{ level: 'info', message: `H2O mode switched to ${mode}.`, at: new Date().toISOString() }, ...(mockState.apps.h2o.logs || [])]
        }
      },
      feedback: { tone: 'success', message: 'H2O 模式已切换。' }
    }),
    updateH2oRuntime: async (patch) => {
      const runtime = h2oRuntime({ runtime: { ...mockState.apps.h2o.runtime, ...(patch || {}) } });
      const logMessage = patch?.logMessage || 'H2O runtime updated from AppCenter.';
      return commit({
        apps: {
          ...mockState.apps,
          h2o: {
            ...mockState.apps.h2o,
            enabled: true,
            status: runtime.running ? 'running' : 'enabled',
            runtimeState: runtime.running ? 'running' : 'ready',
            runtime,
            lastAction: new Date().toISOString(),
            logs: [{ level: patch?.logLevel || 'info', message: logMessage, at: new Date().toISOString() }, ...(mockState.apps.h2o.logs || [])]
          }
        },
        feedback: { tone: 'success', message: 'H2O 运行配置已更新。' }
      });
    },
    refreshH2oSubscription: async () => {
      const now = new Date().toISOString();
      const runtime = h2oRuntime(mockState.apps.h2o);
      const mockUserReady = mockState.identity?.kind === 'user' || mockState.connection?.mode === 'employee';
      const subscriptions = runtime.subscriptions.map((item) => item.requiresUser
        ? {
          ...item,
          url: mockUserReady && !h2oLooksLikeHttpSubscriptionUrl(item.url) ? mockH2oManagedSubscriptionUrl() : item.url,
          status: mockUserReady ? 'ready' : 'login-required',
          syncStatus: mockUserReady ? 'synced' : 'login-required',
          errorMessage: null,
          nodes: mockUserReady ? Math.max(item.nodes || 0, 1) : item.nodes,
          lastUpdatedAt: now
        }
        : item);
      const activeSubscription = subscriptions.find((item) => item.id === runtime.activeSubscription.id) || subscriptions[0] || runtime.activeSubscription;
      return commit({
        apps: {
          ...mockState.apps,
          h2o: {
            ...mockState.apps.h2o,
            runtime: {
              ...runtime,
              subscriptions,
              activeSubscription,
              activeSubscriptionId: activeSubscription.id,
              status: runtime.running ? 'running' : h2oSubscriptionUsable(activeSubscription) ? 'ready' : 'subscription-required',
              lastAppliedAt: now
            },
            logs: [{ level: 'info', message: 'H2O mock subscription refreshed from user-center.', at: now }, ...(mockState.apps.h2o.logs || [])]
          }
        },
        feedback: {
          tone: h2oSubscriptionUsable(activeSubscription) ? 'success' : 'warning',
          message: h2oSubscriptionUsable(activeSubscription) ? 'H2O 已获得当前用户的默认 oversea 订阅。' : '请先登录员工用户。'
        }
      });
    },
    provisionH2oOversea: async () => {
      const now = new Date().toISOString();
      const runtime = h2oRuntime(mockState.apps.h2o);
      const mockUserReady = mockState.identity?.kind === 'user' || mockState.connection?.mode === 'employee';
      const subscriptions = runtime.subscriptions.map((item) => item.requiresUser
        ? {
          ...item,
          url: mockUserReady && !h2oLooksLikeHttpSubscriptionUrl(item.url) ? mockH2oManagedSubscriptionUrl() : item.url,
          status: mockUserReady ? 'ready' : 'login-required',
          syncStatus: mockUserReady ? 'synced' : 'login-required',
          errorMessage: mockUserReady ? null : '系统 oversea 订阅需要先登录员工用户。',
          nodes: mockUserReady ? Math.max(item.nodes || 0, 1) : item.nodes,
          lastUpdatedAt: now
        }
        : item);
      const activeSubscription = subscriptions.find((item) => item.id === runtime.activeSubscription.id) || subscriptions[0] || runtime.activeSubscription;
      return commit({
        apps: {
          ...mockState.apps,
          h2o: {
            ...mockState.apps.h2o,
            runtime: {
              ...runtime,
              subscriptions,
              activeSubscription,
              activeSubscriptionId: activeSubscription.id,
              status: runtime.running ? 'running' : h2oSubscriptionUsable(activeSubscription) ? 'ready' : 'subscription-required',
              lastAppliedAt: now
            },
            logs: [{ level: 'info', message: 'H2O mock oversea entitlement provisioned.', at: now }, ...(mockState.apps.h2o.logs || [])]
          }
        },
        feedback: {
          tone: h2oSubscriptionUsable(activeSubscription) ? 'success' : 'warning',
          message: h2oSubscriptionUsable(activeSubscription) ? '已为当前用户分配 H2O oversea 订阅。' : '请先登录员工用户。'
        }
      });
    },
    openH2oTestWindow: async (input) => {
      const now = new Date().toISOString();
      const runtime = h2oRuntime(mockState.apps.h2o);
      const url = String(input?.url || 'https://www.google.com');
      return commit({
        apps: {
          ...mockState.apps,
          h2o: {
            ...mockState.apps.h2o,
            runtime: {
              ...runtime,
              metrics: {
                ...runtime.metrics,
                connections: runtime.running ? runtime.metrics.connections + 1 : runtime.metrics.connections,
                lastProxyAppliedAt: now
              },
              lastAppliedAt: now
            },
            logs: [{ level: 'info', message: `H2O mock test window opened: ${url}.`, at: now }, ...(mockState.apps.h2o.logs || [])]
          }
        },
        feedback: { tone: 'success', message: `H2O 测试窗口已打开：${url}` }
      });
    },
    checkUpdates: async () => commit({
      update: {
        ...mockState.update,
        status: 'update-available',
        latestVersion: '0.1.1',
        updateAvailable: true,
        planId: 'mock_release_plan',
        releaseId: 'mock_release_0_1_1',
        componentId: 'mx-h2i',
        componentKind: 'mx-h2i-installer',
        artifactKind: 'dmg',
        artifactId: 'mock_mx_h2i_0_1_1_dmg',
        artifactUrl: 'https://example.invalid/mx-h2i-0.1.1.dmg',
        artifactDigest: 'sha256:mock',
        artifactPlatform: 'darwin',
        activation: 'installer-manual',
        restartRequired: true,
        majorUpdateRequiresInstaller: true,
        canSkip: true,
        lastCheckedAt: new Date().toISOString(),
        reason: 'mock Release Center 发现安装包更新。',
        availableReleases: [
          {
            id: 'mock_release_plan',
            releaseId: 'mock_release_0_1_1',
            planId: 'mock_release_plan',
            version: '0.1.1',
            channel: 'stable',
            status: 'ready',
            componentKind: 'mx-h2i-installer',
            artifactKind: 'dmg',
            activation: 'installer-manual',
            sizeBytes: 189695362,
            createdAt: new Date().toISOString(),
            gate: 'passed'
          }
        ],
        history: [
          { id: 'mock_check', kind: 'check', status: 'update-available', version: '0.1.1', fromVersion: '0.1.0', componentKind: 'mx-h2i-installer', updateMode: 'mandatory', message: '发现安装包更新。', at: new Date().toISOString() },
          ...(mockState.update.history || [])
        ].slice(0, 12)
      },
      feedback: { tone: 'success', message: '发现 MX-H2I 大版本 0.1.1，当前 0.1.0，通道 stable。' }
    }),
    applyUpdate: async () => commit({
      update: {
        ...mockState.update,
        status: 'installer-opened',
        stagedPath: '/tmp/mx-h2i-0.1.1.dmg',
        downloadedAt: new Date().toISOString(),
        downloadedBytes: 189695362,
        downloadedDigest: mockState.update.artifactDigest || 'sha256:mock',
        downloadProgress: { state: 'downloaded', bytes: 189695362, totalBytes: 189695362, percent: 100, updatedAt: new Date().toISOString() },
        restartPrompt: true,
        rollbackSlots: [
          { id: 'mock_mx_h2i_0_1_1_dmg', version: '0.1.1', releaseId: 'mock_release_0_1_1', artifactId: 'mock_mx_h2i_0_1_1_dmg', artifactKind: 'dmg', path: '/tmp/mx-h2i-0.1.1.dmg', digest: 'sha256:mock', sizeBytes: 189695362, platform: 'darwin', downloadedAt: new Date().toISOString() },
          ...(mockState.update.rollbackSlots || [])
        ].slice(0, 3),
        history: [
          { id: 'mock_download', kind: 'major-download', status: 'downloaded', version: '0.1.1', fromVersion: '0.1.0', componentKind: 'mx-h2i-installer', updateMode: 'mandatory', message: '大版本安装包已下载并校验。', at: new Date().toISOString() },
          ...(mockState.update.history || [])
        ].slice(0, 12)
      },
      feedback: { tone: 'success', message: '安装包已校验并打开。安装完成后可以立即重启 MX-H2I，也可以稍后手动重启。' }
    }),
    restartApp: async () => commit({ feedback: { tone: 'info', message: '正在重启 MX-H2I。' } }),
    openRollbackInstaller: async () => commit({ feedback: { tone: 'success', message: '已打开历史版本安装包。' } }),
    refreshDiagnostics: async () => commit({
      connection: {
        ...mockState.connection,
        domesticPeerSync: {
          status: 'passed',
          execution: 'executed',
          checkedAt: new Date().toISOString(),
          failures: []
        }
      },
      feedback: { tone: 'success', message: '诊断已刷新。' }
    }),
    repairSystemNetwork: async () => commit({
      connection: {
        ...mockState.connection,
        diagnostics: {
          ...(mockState.connection.diagnostics || {}),
          networkEnvironment: {
            reason: 'mock-repair',
            phase: mockState.connection.state === 'connected' ? 'connected' : 'disconnected',
            host: 'h2i.mxinfo-inc.cn',
            resolution: {
              state: mockState.connection.state === 'connected' ? 'expected-internal' : 'public',
              severity: 'ok',
              message: 'mock network repaired',
              addresses: [{ address: mockState.connection.state === 'connected' ? '10.88.88.88' : '116.62.51.154', classification: mockState.connection.state === 'connected' ? 'expected-internal-target' : 'public' }]
            },
            systemDomainProxy: { applied: mockState.connection.state === 'connected', systemResolverMode: 'dynamic' }
          }
        }
      },
      feedback: { tone: 'success', message: '系统网络状态已修复。' }
    }),
    openDiagnosticLogs: async () => commit({ feedback: { tone: 'info', message: '已打开 MX-H2I 日志目录。' } }),
    exportDiagnostics: async () => commit({ feedback: { tone: 'success', message: '诊断包已导出：MX-H2I-diagnostics-mock。' } }),
    openAdmin: async () => true,
    setWindowMode: async () => true,
    startWindowDrag: async () => true,
    moveWindowBy: async () => true,
    finishWindowDrag: async () => true,
    hideTopDockIfPending: async () => true,
    windowControl: async () => true,
    onState: () => () => {}
  };
}
