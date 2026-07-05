const electronApi = window.mxH2i || null;
const api = electronApi || createMockApi();
const root = document.getElementById('app');

let state = null;
let busyAction = '';
let screen = 'launcher';
let modeDraft = 'guest';
let windowDrag = null;
let appSearch = '';
let appCategory = 'all';
let selectedAppId = 'h2o';
let appDebugOpen = false;
let foundationOpen = false;
let appShellMenuOpen = false;
let phoneMenuOpen = false;
let appInspectorCollapsed = false;
let appGridScrollTop = 0;

void boot();

async function boot() {
  state = await api.getState();
  modeDraft = state.connection?.mode === 'employee' ? 'employee' : 'guest';
  render();
  if (typeof api.onState === 'function') {
    api.onState((next) => {
      state = next;
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
    selectedAppId = button.dataset.appId || selectedAppId;
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
    appShellMenuOpen = false;
    void runAction('setH2oMode', button.dataset.mode || 'app-rule');
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
  const input = event.target.closest('[data-app-search]');
  if (!input) return;
  appSearch = input.value || '';
  appGridScrollTop = 0;
  render();
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
    void runAction(action, {
      account: String(payload.account || ''),
      password: String(payload.password || '')
    });
  }
});

root.addEventListener('pointerdown', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target || event.button !== 0) return;
  if (target.closest('button,input,select,a')) return;
  const dragHandle = target.closest('[data-window-drag]');
  if (!dragHandle || typeof api.moveWindowBy !== 'function') return;
  windowDrag = {
    pointerId: event.pointerId,
    screenX: event.screenX,
    screenY: event.screenY,
    startScreenY: event.screenY,
    totalDy: 0
  };
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
  windowDrag.totalDy = Math.round(event.screenY - windowDrag.startScreenY);
  void api.moveWindowBy?.({ dx, dy, totalDy: windowDrag.totalDy });
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
  const totalDy = windowDrag.totalDy;
  windowDrag = null;
  document.body.classList.remove('is-window-dragging');
  void api.finishWindowDrag?.({ totalDy });
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
      checkUpdates: () => api.checkUpdates(),
      applyUpdate: () => api.applyUpdate?.(),
      refreshDiagnostics: () => api.refreshDiagnostics?.(),
      repairSystemNetwork: () => api.repairSystemNetwork?.(),
      openAdmin: () => api.openAdmin()
    };
    if (handlers[action]) {
      const next = await handlers[action]();
      if (next && typeof next === 'object' && 'connection' in next) state = next;
      if (action === 'installAppCenter' && state.apps?.appcenter?.installed) {
        await setScreen('appcenter');
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

function isEmployeeLoginVisible() {
  const connected = state.connection?.state === 'connected';
  return modeDraft === 'employee' && (!connected || state.connection?.mode !== 'employee');
}

function render() {
  if (!state) return;
  const connected = state.connection?.state === 'connected';
  const leaseOnly = state.connection?.state === 'lease-only';
  const tunnelOnly = state.connection?.state === 'tunnel-only';
  const connecting = state.connection?.state === 'connecting';
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
  const modeTitle = connected
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
  const label = connected ? '断开连接' : connecting ? '连接中' : leaseOnly ? '重新连接' : '连接';
  const action = connected ? 'disconnect' : 'connectGuest';
  return `
    <section class="connect-panel">
      <button class="connect-dial ${connected && !leaseOnly ? 'is-connected' : ''}" type="button" data-action="${action}" ${connecting ? 'disabled' : ''}>
        <span>${escapeHtml(label)}</span>
      </button>
      <div class="connect-actions">
        <button class="text-button" type="button" data-action="select-mode" data-mode="employee">员工登录</button>
        <button class="text-button" type="button" data-action="checkUpdates">检查更新</button>
        <button class="text-button" type="button" data-action="show-advanced">高级选项</button>
      </div>
    </section>
  `;
}

function renderEmployeeLogin(connecting) {
  return `
    <form class="login-panel" data-form-action="login-employee">
      <label class="field">
        <span>账号</span>
        <input name="account" value="${escapeAttr(state.identity?.account || '')}" autocomplete="username" placeholder="Username/Email/Phone" />
      </label>
      <label class="field">
        <span>密码</span>
        <input name="password" type="password" autocomplete="current-password" placeholder="Password" />
      </label>
      <button class="primary-button block-button" type="submit" ${connecting ? 'disabled' : ''}>
        ${connecting ? '连接中' : '连接'}
      </button>
      <button class="secondary-button block-button" type="button" data-action="connectGuest" ${connecting ? 'disabled' : ''}>
        使用飞书连接
      </button>
    </form>
  `;
}

function renderPhoneFooterInfo(connected) {
  const update = state.update || {};
  const version = update.currentVersion || '0.1.0';
  const channel = update.channel || state.config?.releaseChannel || 'stable';
  const status = connected ? 'ready' : (update.status || state.connection?.state || 'idle');
  return `
    <section class="phone-footer-info">
      <div>
        <h2>MX-H2I</h2>
        <p>版本 ${escapeHtml(version)} · ${escapeHtml(channel)}</p>
      </div>
      <span>${escapeHtml(status)}</span>
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
        <input name="hostResolve" value="${escapeAttr(config.hostResolve || '')}" placeholder="api.mxinfo-inc.cn=<gateway-ip>" />
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
        <input name="splitDnsDomains" value="${escapeAttr(config.splitDnsDomains || '')}" placeholder="mxinfo-inc.cn, api.mxinfo-inc.cn" />
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
  const visibleApps = filteredAppCatalog(apps);
  if (!apps.some((app) => app.appId === selectedAppId)) selectedAppId = apps[0]?.appId || 'h2o';
  const selected = apps.find((app) => app.appId === selectedAppId) || visibleApps[0] || apps[0] || null;
  const categories = appCenterCategories(apps);
  const hasError = apps.some((app) => app.errorMessage || app.runtimeState === 'error' || app.status === 'error');
  return `
    <section class="appcenter-window appcenter-product ${appDebugOpen ? 'is-debug-open' : ''} ${appInspectorCollapsed ? 'is-inspector-collapsed' : ''}">
      <aside class="appcenter-rail">
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
      </aside>

      <section class="appcenter-main">
        <header class="appcenter-titlebar">
          <div>
            <p class="kicker">APPCENTER</p>
            <h3>应用中心</h3>
            <span>${escapeHtml(connected ? 'MX-H2I 已连接，可以安装和打开应用' : '连接 MX-H2I 后可安装应用')}</span>
          </div>
          <div class="toolbar-actions">
            <button class="secondary-button" type="button" data-action="toggle-app-debug">${appDebugOpen ? '关闭 Debug' : 'Debug'}</button>
            <button class="primary-button" type="button" data-action="checkUpdates" ${busyAction === 'checkUpdates' ? 'disabled' : ''}>检查更新</button>
          </div>
        </header>

        ${hasError ? renderAppCenterErrorBanner(apps) : ''}

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
      </section>

      ${selected ? renderAppCenterSidePanel(selected, connected) : ''}
    </section>
  `;
}

function appCatalog() {
  const appcenter = state.apps?.appcenter || {};
  const h2o = state.apps?.h2o || {};
  const staticAppIds = ['appcenter', 'h2o', 'diagnostics', 'luopan-bridge'];
  const dynamicApps = Object.entries(state.apps || {})
    .filter(([appId]) => !staticAppIds.includes(appId))
    .map(([appId, app]) => normalizeCatalogApp(app, {
      appId,
      displayName: app?.displayName || appId,
      category: app?.category || 'custom',
      description: app?.description || '',
      packageName: app?.packageName || `@qpjoy/electron-launcher-app-${appId}`
    }));
  return [
    normalizeCatalogApp(appcenter, {
      appId: 'appcenter',
      displayName: 'AppCenter',
      category: 'platform',
      description: '内置应用市场，负责安装、版本、权限和入口管理。',
      packageName: '@qpjoy/electron-launcher-appcenter',
      permissions: ['auth.read', 'appcenter.read', 'permission.request']
    }),
    normalizeCatalogApp(h2o, {
      appId: 'h2o',
      displayName: 'H2O',
      fullName: 'Home To Oversea',
      category: 'network',
      description: 'AppCenter 内置的 Home To Oversea 网络插件，提供类 Clash 的代理模式、PAC、Split DNS 和 Internal 出海状态面板。',
      packageName: '@qpjoy/electron-launcher-app-h2o',
      permissions: ['network.hdi.status', 'network.proxy.app', 'network.dns.policy', 'network.pac.policy'],
      requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'app-center-runtime'],
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
        requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'app-center-runtime'],
        network: { scope: 'broker-session' },
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
      installSource: 'builtin',
      permissions: ['observability.read', 'release.read'],
      entrypoints: { desktop: 'app://diagnostics/index.html' }
    }, {}),
    normalizeCatalogApp({
      appId: 'luopan-bridge',
      displayName: 'Luopan Bridge',
      category: 'bridge',
      description: '预留给 Luopan standalone channel 的桥接测试入口，不影响 Luopan 自己的 WG。',
      packageName: '@qpjoy/electron-launcher-app-luopan-bridge',
      launcherMode: 'embed',
      standaloneChannelProductId: 'luopan',
      networkScope: 'broker-session',
      version: '0.1.0',
      latestVersion: '0.1.0',
      installed: false,
      enabled: false,
      status: 'reserved',
      runtimeState: 'reserved',
      installSource: 'registry',
      permissions: ['launcher.bridge.read'],
      entrypoints: { desktop: 'app://luopan-bridge/index.html' }
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
  return [
    { id: 'all', label: '全部应用', count: apps.length },
    { id: 'network', label: '网络工具', count: apps.filter((app) => app.category === 'network').length },
    { id: 'platform', label: '平台应用', count: apps.filter((app) => app.category === 'platform').length },
    { id: 'ops', label: '工具箱', count: apps.filter((app) => app.category === 'ops').length },
    { id: 'updates', label: '可更新', count: apps.filter((app) => app.latestVersion && app.latestVersion !== (app.installedVersion || app.version)).length }
  ];
}

function categoryTitle(category) {
  return appCenterCategories(appCatalog()).find((item) => item.id === category)?.label || '应用';
}

function renderAppCenterErrorBanner(apps) {
  const errored = apps.find((app) => app.errorMessage || app.runtimeState === 'error' || app.status === 'error');
  if (!errored) return '';
  return `
    <div class="appcenter-error-banner">
      <strong>${escapeHtml(errored.displayName)} 需要处理</strong>
      <span>${escapeHtml(errored.errorMessage || '应用运行状态异常，打开 Debug 查看详情。')}</span>
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
      ${app.errorMessage ? `<div class="app-inline-error">${escapeHtml(app.errorMessage)}</div>` : ''}
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

function renderH2oPluginPanel(app) {
  const runtime = app.runtime || {};
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
        ${h2oModeButton('direct', runtime.mode, '直连')}
      </div>
      <div class="h2o-runtime-facts">
        <div><span>订阅</span><strong>${escapeHtml(subscription.name || 'Home To Oversea 默认策略')}</strong></div>
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
  if (mode === 'direct') return '直连';
  return '规则模式';
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
  if (app.errorMessage || app.runtimeState === 'error' || app.status === 'error') return '需要处理';
  if (app.status === 'reserved') return '即将推出';
  if (app.runtimeState === 'running') return '运行中';
  if (app.installed && app.enabled) return '已安装';
  if (app.installed) return '已缓存';
  return '可安装';
}

function appUserFeatures(app) {
  if (app.appId === 'h2o') {
    return [
      { title: 'Home To Oversea', detail: '按规则、全局、TUN 或直连模式托管出海策略。' },
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
  if (!logs.length && !app.errorMessage) return '';
  const rows = app.errorMessage
    ? [{ level: 'error', message: app.errorMessage, at: app.lastAction || new Date().toISOString() }, ...logs]
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

function appPrimaryAction(app, connected) {
  if (app.appId === 'appcenter') {
    return { action: 'show-appcenter', label: app.installed ? '打开' : '安装', disabled: !connected || busyAction === 'installAppCenter' };
  }
  if (app.appId === 'h2o') {
    if (app.installed && app.enabled) {
      return {
        action: 'launchH2o',
        label: app.runtimeState === 'running' ? '打开管理' : '启动',
        disabled: !connected || busyAction === 'launchH2o'
      };
    }
    return { action: 'enableH2o', label: '安装', disabled: !connected || !state.apps?.appcenter?.installed || busyAction === 'enableH2o' };
  }
  if (app.appId === 'diagnostics') {
    return { action: 'checkUpdates', label: '打开', disabled: busyAction === 'checkUpdates' };
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
  const installer = update.activation === 'installer-manual' || update.majorUpdateRequiresInstaller === true;
  const actionLabel = downloading ? '下载中' : installer ? '下载并打开' : '下载更新包';
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
        ${metric('Activation', update.activation || (update.majorUpdateRequiresInstaller ? 'installer-manual' : update.hotUpdateAuto ? 'hot-auto' : '-'))}
      </div>
      <div class="update-actions">
        <button class="secondary-button" type="button" data-action="checkUpdates" ${busyAction === 'checkUpdates' ? 'disabled' : ''}>检查更新</button>
        <button class="primary-button" type="button" data-action="applyUpdate" ${!hasArtifact || downloading ? 'disabled' : ''}>${escapeHtml(actionLabel)}</button>
      </div>
      ${update.reason ? `<p class="panel-note">${escapeHtml(update.reason)}</p>` : ''}
    </section>
  `;
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '-')}</strong></div>`;
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

function createMockApi() {
  let mockState = {
    config: {
      bootstrapApiBaseUrl: 'http://api.mxinfo-inc.cn:18090',
      internalApiBaseUrl: 'http://10.88.88.88:18090',
      domesticRelayHost: '121.43.253.179',
      domesticRelayPort: 51280,
      sdkGatewayBaseUrl: 'http://api.mxinfo-inc.cn:18090/internal/v1/sdk',
      hostResolve: '',
      bootstrapResolveMode: 'env-first',
      bootstrapDnsServers: '',
      routePathPreference: 'auto',
      splitDnsDomains: 'mxinfo-inc.cn,api.mxinfo-inc.cn',
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
        permissions: ['network.hdi.status', 'network.proxy.app', 'network.dns.policy', 'network.pac.policy'],
        requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'app-center-runtime'],
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
          requiredCapabilities: ['user.session', 'network.status', 'network.proxy', 'network.dns.policy', 'network.pac.policy', 'app-center-runtime'],
          network: { scope: 'broker-session' },
          embed: { standaloneChannelProductId: 'mx-h2i', launchWithoutBroker: 'blocked' }
        },
        installSource: 'npm',
        installPath: null,
        runtime: {
          kind: 'h2o-plugin',
          mode: 'app-rule',
          running: false,
          status: 'stopped',
          tunInstalled: false,
          adminUrl: 'http://127.0.0.1:23456',
          ports: { admin: 23456, controller: 23457, mixed: 23458, dns: 1053 },
          activeSubscription: {
            id: 'h2o-default',
            name: 'Home To Oversea 默认策略',
            nodes: 6,
            latencyMs: 42
          },
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
      lastCheckedAt: null
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
    loginEmployee: async (input) => commit({
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
      feedback: null
    }),
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
            lastAppliedAt: new Date().toISOString()
          },
          lastAction: new Date().toISOString()
        }
      },
      feedback: { tone: 'success', message: 'H2O 运行态已就绪。开发态从 mx-app-h2o 单独启动窗口。' }
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
    checkUpdates: async () => commit({
      update: {
        ...mockState.update,
        status: 'ready',
        latestVersion: '0.1.1',
        planId: 'mock_release_plan',
        releaseId: 'mock_release_0_1_1',
        componentId: 'mx-h2i',
        componentKind: 'mx-h2i-installer',
        artifactKind: 'dmg',
        artifactId: 'mock_mx_h2i_0_1_1_dmg',
        artifactUrl: 'https://example.invalid/mx-h2i-0.1.1.dmg',
        artifactDigest: 'sha256:mock',
        activation: 'installer-manual',
        restartRequired: true,
        majorUpdateRequiresInstaller: true,
        canSkip: true,
        lastCheckedAt: new Date().toISOString(),
        reason: 'mock Release Center 发现安装包更新。'
      },
      feedback: { tone: 'info', message: '更新策略已刷新。' }
    }),
    applyUpdate: async () => commit({
      update: {
        ...mockState.update,
        status: 'ready-to-install',
        stagedPath: '/tmp/mx-h2i-0.1.1.dmg',
        downloadedAt: new Date().toISOString(),
        downloadedBytes: 42,
        downloadedDigest: mockState.update.artifactDigest || 'sha256:mock'
      },
      feedback: { tone: 'success', message: '安装包已下载并校验。' }
    }),
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
    openAdmin: async () => true,
    setWindowMode: async () => true,
    moveWindowBy: async () => true,
    finishWindowDrag: async () => true,
    hideTopDockIfPending: async () => true,
    windowControl: async () => true,
    onState: () => () => {}
  };
}
