import { DOMAIN_PRESETS } from '../defaults';

const navItems = [
  { id: 'home', label: '首页', icon: 'dashboard' },
  { id: 'proxy', label: '代理', icon: 'proxy' },
  { id: 'subscriptions', label: '订阅', icon: 'subscriptions' },
  { id: 'rules', label: '规则', icon: 'rules' },
  { id: 'test', label: '测试', icon: 'test' },
  { id: 'logs', label: '日志', icon: 'logs' }
];

const presetLabels: Record<string, { label: string; icon: string }> = {
  google: { label: 'Google', icon: 'globe' },
  youtube: { label: 'YouTube', icon: 'play' },
  x: { label: 'X / Twitter', icon: 'at' },
  telegram: { label: 'Telegram', icon: 'send' }
};

function icon(name: string): string {
  const common = 'viewBox="0 0 24 24" aria-hidden="true"';
  const shapes: Record<string, string> = {
    logo: '<svg ' + common + '><circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="3.8" r="2"/><circle cx="12" cy="20.2" r="2"/><circle cx="3.8" cy="12" r="2"/><circle cx="20.2" cy="12" r="2"/><circle cx="6.2" cy="6.2" r="1.8"/><circle cx="17.8" cy="6.2" r="1.8"/><circle cx="6.2" cy="17.8" r="1.8"/><circle cx="17.8" cy="17.8" r="1.8"/><path d="M12 6v12M6 12h12M7.6 7.6l8.8 8.8M16.4 7.6l-8.8 8.8" fill="none" stroke="currentColor" stroke-width="1.9"/></svg>',
    dashboard: '<svg ' + common + '><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/></svg>',
    proxy: '<svg ' + common + '><path d="M10 4h4v5h-4zM4 15h5v5H4zM15 15h5v5h-5z"/><path d="M12 9v3M6.5 15v-3h11v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    subscriptions: '<svg ' + common + '><path d="M5 4h14v6H5zM5 14h14v6H5z"/><circle cx="8" cy="7" r="1" fill="#fff"/><circle cx="8" cy="17" r="1" fill="#fff"/></svg>',
    rules: '<svg ' + common + '><path d="M4 7h8M4 17h8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="m16 6 2 2 3-4M16 18l4-4M20 18l-4-4" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    test: '<svg ' + common + '><path d="M7 10V7a5 5 0 0 1 10 0v3" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M5 10h14v10H5z" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="15" r="1.5"/></svg>',
    logs: '<svg ' + common + '><path d="M6 4h12v16H6z"/><path d="M9 8h6M9 12h6M9 16h4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
    refresh: '<svg ' + common + '><path d="M20 6v5h-5M4 18v-5h5" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 9a7 7 0 0 0-12-3M6 15a7 7 0 0 0 12 3" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/></svg>',
    restart: '<svg ' + common + '><path d="M12 5a7 7 0 1 1-6.2 3.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M5 5v5h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    play: '<svg ' + common + '><path d="M8 5v14l11-7z"/></svg>',
    stop: '<svg ' + common + '><path d="M7 7h10v10H7z"/></svg>',
    open: '<svg ' + common + '><path d="M5 5h7v2H7v10h10v-5h2v7H5z"/><path d="M14 4h6v6h-2V7.4l-7.3 7.3-1.4-1.4L16.6 6H14z"/></svg>',
    download: '<svg ' + common + '><path d="M12 4v10M8 10l4 4 4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    save: '<svg ' + common + '><path d="M5 4h12l2 2v14H5z"/><path d="M8 4v6h8V4M8 17h8" stroke="#fff" stroke-width="1.8"/></svg>',
    add: '<svg ' + common + '><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    delete: '<svg ' + common + '><path d="M6 7h12M9 7V5h6v2M8 10l1 9h6l1-9" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    shieldAdd: '<svg ' + common + '><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z" fill="currentColor"/><path d="M12 8v7M8.5 11.5h7" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
    shieldRemove: '<svg ' + common + '><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6z" fill="currentColor"/><path d="m7 7 10 10" stroke="#fff" stroke-width="2"/></svg>',
    globe: '<svg ' + common + '><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 12h16M12 4c2 2.4 3 5 3 8s-1 5.6-3 8M12 4c-2 2.4-3 5-3 8s1 5.6 3 8" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
    at: '<svg ' + common + '><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8v5a3 3 0 0 0 6 0 10 10 0 1 0-4 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    send: '<svg ' + common + '><path d="M3 11 21 3l-7 18-3-7z"/></svg>',
    check: '<svg ' + common + '><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    block: '<svg ' + common + '><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m7 7 10 10" stroke="currentColor" stroke-width="2.2"/></svg>'
  };
  return shapes[name] ?? shapes.dashboard;
}

function iconButton(name: string, id: string, title: string, extraClass = ''): string {
  return '<button id="' + id + '" class="icon-button ' + extraClass + '" title="' + title + '">' + icon(name) + '</button>';
}

function navMarkup(): string {
  return navItems.map((item) => (
    '<button class="nav-item" data-page="' + item.id + '">' +
      '<span class="nav-icon">' + icon(item.icon) + '</span>' +
      '<span>' + item.label + '</span>' +
    '</button>'
  )).join('');
}

function presetMarkup(): string {
  return Object.keys(DOMAIN_PRESETS).map((id) => {
    const preset = presetLabels[id] ?? { label: id, icon: 'globe' };
    return '<button class="btn outline" data-preset="' + id + '" data-preset-button="' + id + '">' + icon(preset.icon) + '<span>' + preset.label + '</span></button>';
  }).join('');
}

export function adminHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QPJoy Tunnel Admin</title>
  <style>
    :root{color:#101418;background:#f3f5f7;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}
    body{margin:0;background:#f3f5f7;color:#101418}
    button,input,select{font:inherit}
    button{cursor:pointer}
    button:disabled{cursor:wait;opacity:.62}
    svg{width:22px;height:22px;display:block;fill:currentColor}
    .login-page{min-height:100vh;display:grid;place-items:center;padding:24px}
    .login-card{width:min(420px,100%);border:1px solid #dfe4ea;border-radius:8px;background:#fff;padding:24px}
    .brand-lockup{height:72px;display:flex;align-items:center;gap:12px;padding:0 22px;font-size:24px;font-weight:800}
    .brand-lockup svg{width:38px;height:38px}
    .login-card .brand-lockup{height:auto;padding:0 0 20px}
    .login-form{display:grid;gap:12px}
    .app-shell{min-height:100vh;display:grid;grid-template-columns:220px 1fr}
    .side-panel{background:#fbfcfd;border-right:1px solid #dfe4ea}
    .nav-list{padding:6px 12px}
    .nav-item{width:100%;height:54px;border:0;border-radius:8px;margin:6px 0;padding:0 18px;display:flex;align-items:center;gap:18px;background:transparent;color:#111827;font-size:16px;font-weight:800;text-align:left}
    .nav-item.active{background:#dce9ff;color:#0f62d0}
    .nav-icon{width:28px;display:grid;place-items:center}
    .content-panel{padding:22px;min-width:0}
    .toolbar-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
    .page-toolbar{margin-bottom:18px}
    .page-title{font-size:30px;line-height:1.2;font-weight:800}
    .spacer{flex:1}
    .content-stack{display:grid;gap:18px}
    .section-surface,.metric-cell,.subscription-card,.rule-item{background:#fff;border:1px solid #dfe4ea;border-radius:8px}
    .section-surface{padding:16px}
    .status-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
    .metric-cell{min-height:86px;padding:12px}
    .metric-label{color:#697386;font-size:13px;margin-bottom:8px}
    .metric-value{font-size:20px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .field{height:42px;border:1px solid #c9d4e2;border-radius:6px;background:#fff;color:#101418;padding:0 12px;min-width:0}
    .field:focus{outline:2px solid #b8d6ff;border-color:#1578ff}
    .field-grow{flex:1 1 320px}
    .field-short{width:150px}
    .btn{height:42px;border:1px solid #1578ff;border-radius:6px;background:#1976d2;color:#fff;padding:0 16px;display:inline-flex;align-items:center;justify-content:center;gap:9px;font-weight:800;white-space:nowrap}
    .btn.outline{background:#fff;color:#1976d2}
    .btn.active{background:#dce9ff;color:#0f62d0}
    .btn.negative{background:#fff;color:#c10015;border-color:#c10015}
    .icon-button{width:46px;height:46px;border:0;border-radius:50%;background:transparent;color:#101418;display:grid;place-items:center}
    .icon-button.outline{border:1px solid #1976d2;color:#1976d2;background:#fff}
    .icon-button.primary{background:#1976d2;color:#fff;box-shadow:0 3px 8px rgba(16,24,40,.18)}
    .chip{min-height:34px;border-radius:999px;padding:6px 16px;display:inline-flex;align-items:center;color:#fff;background:#8b929a;font-weight:700}
    .chip.positive{background:#21ba45}
    .subscription-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
    .subscription-card{min-height:118px;padding:16px}
    .subscription-card.active{border-color:#1578ff;box-shadow:inset 4px 0 0 #1578ff}
    .card-head{display:flex;align-items:center;gap:8px;min-width:0}
    .card-title{font-size:18px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .muted{color:#6b7280}
    .ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .rule-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
    .rule-item{min-height:64px;padding:10px;display:grid;grid-template-columns:34px minmax(0,1fr) 38px;gap:10px;align-items:center}
    .rule-icon.allow{color:#21ba45}.rule-icon.block{color:#c10015}
    .mono-log{height:calc(100vh - 150px);min-height:280px;overflow:auto;border-radius:8px;background:#101418;color:#dbeafe;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;padding:12px;white-space:pre-wrap}
    .toast{position:fixed;right:18px;top:18px;z-index:20;max-width:min(520px,calc(100vw - 36px));border-radius:6px;padding:12px 16px;background:#21ba45;color:#fff;box-shadow:0 8px 24px rgba(16,24,40,.18);font-weight:700}
    .toast.negative{background:#c10015}
    .modal-backdrop{position:fixed;inset:0;z-index:15;display:grid;place-items:center;background:rgba(15,23,42,.28);padding:24px}
    .modal-card{width:min(720px,100%);border:1px solid #dfe4ea;border-radius:8px;background:#fff;padding:18px;box-shadow:0 18px 48px rgba(16,24,40,.22)}
    .modal-title{margin:0 0 14px;font-size:22px;font-weight:800}
    .modal-form{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .modal-form .wide{grid-column:1 / -1}
    .modal-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:16px}
    .empty{color:#697386;padding:10px 0}
    [hidden]{display:none!important}
    @media (max-width:860px){
      .app-shell{grid-template-columns:1fr}
      .side-panel{position:static;border-right:0;border-bottom:1px solid #dfe4ea}
      .brand-lockup{height:62px}
      .nav-list{display:flex;overflow:auto;gap:8px;padding:0 12px 12px}
      .nav-item{width:auto;min-width:108px;margin:0}
      .content-panel{padding:18px}
    }
  </style>
</head>
<body>
  <section id="login" class="login-page">
    <div class="login-card">
      <div class="brand-lockup">${icon('logo')}<span>QPJoy Tunnel</span></div>
      <div class="login-form">
        <input id="loginUser" class="field" placeholder="admin" value="admin">
        <input id="loginPass" class="field" type="password" placeholder="password" value="admin">
        <button id="loginBtn" class="btn">${icon('check')}<span>登录</span></button>
      </div>
    </div>
  </section>

  <div id="app" class="app-shell" hidden>
    <aside class="side-panel">
      <div class="brand-lockup">${icon('logo')}<span>QPJoy Tunnel</span></div>
      <nav class="nav-list">${navMarkup()}</nav>
    </aside>
    <main class="content-panel">
      <div class="toolbar-row page-toolbar">
        <div id="pageTitle" class="page-title">首页</div>
        <div class="spacer"></div>
        ${iconButton('refresh', 'refreshBtn', '刷新')}
        ${iconButton('restart', 'restartBtn', '重载', 'outline')}
        ${iconButton('play', 'toggleCoreBtn', '启动', 'primary')}
      </div>
      <div id="pageBody" class="content-stack"></div>
    </main>
  </div>

  <div id="toast" class="toast" hidden></div>
  <div id="modal" class="modal-backdrop" hidden></div>

  <script>
    var token = window.localStorage.getItem('qpjoyTunnelAdminToken') || '';
    var currentPage = window.localStorage.getItem('qpjoyTunnelAdminPage') || 'home';
    var snapshot = null;
    var busy = false;
    var modeLabels = { 'system-tun': '虚拟网卡', 'app-global': '全局模式', 'app-rule': 'App 模式' };
    var pageTitles = { home: '首页', proxy: '代理', subscriptions: '订阅', rules: '规则', test: '测试', logs: '日志' };

    function byId(id) { return document.getElementById(id); }
    function escapeHtml(value) {
      return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char];
      });
    }
    function errorMessage(text) {
      try {
        var data = JSON.parse(text);
        return data.error || data.message || text;
      } catch (_error) {
        return text || '请求失败';
      }
    }
    async function api(path, options) {
      var res = await fetch(path, {
        method: options && options.method ? options.method : 'GET',
        body: options && options.body,
        headers: Object.assign({ 'content-type': 'application/json', authorization: token ? 'Bearer ' + token : '' }, options && options.headers ? options.headers : {})
      });
      var text = await res.text();
      if (!res.ok) {
        throw new Error(errorMessage(text));
      }
      return text ? JSON.parse(text) : {};
    }
    function setBusy(value) {
      busy = value;
      document.querySelectorAll('button,input,select').forEach(function (element) {
        if (element.id !== 'loginUser' && element.id !== 'loginPass') {
          element.disabled = value;
        }
      });
    }
    function toast(message, negative) {
      var el = byId('toast');
      el.textContent = message;
      el.className = negative ? 'toast negative' : 'toast';
      el.hidden = false;
      window.clearTimeout(toast.timer);
      toast.timer = window.setTimeout(function () { el.hidden = true; }, 1800);
    }
    async function run(action, message) {
      if (busy) return false;
      setBusy(true);
      try {
        await action();
        await refresh();
        if (message) toast(message, false);
        return true;
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error), true);
        return false;
      } finally {
        setBusy(false);
      }
    }
    function formatBytes(bytes) {
      var value = Number(bytes || 0);
      if (value < 1024) return value + ' B';
      var units = ['KB', 'MB', 'GB', 'TB'];
      var unit = -1;
      do {
        value = value / 1024;
        unit += 1;
      } while (value >= 1024 && unit < units.length - 1);
      return value.toFixed(value >= 10 ? 1 : 2).replace(/\\.0$/, '') + ' ' + units[unit];
    }
    function relativeTime(value) {
      if (!value) return '未更新';
      var diff = Date.now() - new Date(value).getTime();
      var minutes = Math.max(1, Math.round(diff / 60000));
      if (minutes < 60) return minutes + ' 分钟前';
      var hours = Math.round(minutes / 60);
      if (hours < 24) return hours + ' 小时前';
      return Math.round(hours / 24) + ' 天前';
    }
    function redactedUrl(url) {
      return String(url || '').replace(/\\/\\/([^:@/]+):([^@/]+)@/, '//***:***@');
    }
    function metric(label, value) {
      return '<div class="metric-cell"><div class="metric-label">' + escapeHtml(label) + '</div><div class="metric-value">' + escapeHtml(value) + '</div></div>';
    }
    function statusChip(text, positive) {
      return '<span class="chip ' + (positive ? 'positive' : '') + '">' + escapeHtml(text) + '</span>';
    }
    function normalizeUrl(value) {
      var raw = String(value || '').trim();
      if (!raw) throw new Error('测试网址不能为空');
      return /^https?:\\/\\//i.test(raw) ? raw : 'https://' + raw;
    }
    function status() {
      return snapshot ? snapshot.status : null;
    }
    function presetActive(preset) {
      return !!((snapshot && snapshot.rules) || []).some(function (rule) { return rule.source === 'preset:' + preset; });
    }
    function subscriptionById(id) {
      return ((snapshot && snapshot.subscriptions) || []).find(function (sub) { return sub.id === Number(id); });
    }
    function renderFrame() {
      var s = status();
      byId('pageTitle').textContent = pageTitles[currentPage] || '首页';
      document.querySelectorAll('.nav-item').forEach(function (item) {
        item.classList.toggle('active', item.dataset.page === currentPage);
      });
      var toggle = byId('toggleCoreBtn');
      toggle.innerHTML = s && s.running ? '${icon('stop')}' : '${icon('play')}';
      toggle.title = s && s.running ? '停止' : '启动';
    }
    function renderHome() {
      var s = status();
      var traffic = snapshot ? snapshot.traffic : {};
      return '<div class="status-strip">' +
        metric('运行状态', s && s.running ? '运行中' : '已停止') +
        metric('当前模式', modeLabels[s ? s.mode : 'app-rule'] || 'App 模式') +
        metric('当前订阅', s && s.activeSubscription ? s.activeSubscription.name : '未选择') +
        metric('连接数', traffic.connections || 0) +
        '</div>' +
        '<div class="status-strip">' +
        metric('上传总量', formatBytes(traffic.uploadTotal)) +
        metric('下载总量', formatBytes(traffic.downloadTotal)) +
        metric('本地代理', ':' + (s ? s.ports.mixed : 23458)) +
        metric('管理后台', ':' + (s ? s.ports.admin : 23456)) +
        '</div>' +
        '<section class="section-surface"><div class="toolbar-row">' +
        '<button id="updateActiveSub" class="btn">${icon('download')}<span>更新当前订阅</span></button>' +
        '<button id="openAdminTab" class="btn outline">${icon('open')}<span>浏览器后台</span></button>' +
        statusChip('TUN ' + (s && s.tunInstalled ? '已安装' : '未安装'), !!(s && s.tunInstalled)) +
        statusChip('流量 ' + (traffic.available ? '可读' : '未连接'), !!traffic.available) +
        '</div></section>';
    }
    function renderProxy() {
      var s = status();
      return '<section class="section-surface"><div class="toolbar-row">' +
        '<select id="modeSelect" class="field field-short" style="width:220px">' +
        '<option value="app-rule">App 模式</option><option value="app-global">全局模式</option><option value="system-tun">虚拟网卡</option>' +
        '</select>' +
        '<button id="saveMode" class="btn">${icon('refresh')}<span>切换</span></button>' +
        '<button id="installTun" class="btn outline">${icon('shieldAdd')}<span>安装 TUN</span></button>' +
        '<button id="uninstallTun" class="btn negative">${icon('shieldRemove')}<span>卸载 TUN</span></button>' +
        statusChip('TUN ' + (s && s.tunInstalled ? '已安装' : '未安装'), !!(s && s.tunInstalled)) +
        '</div></section>' +
        '<section class="section-surface"><div class="toolbar-row">' +
        '<input id="corePath" class="field field-grow" placeholder="自动使用内置隧道引擎" value="' + escapeHtml(s && s.corePath ? s.corePath : '') + '">' +
        '<button id="saveCorePath" class="btn">${icon('save')}<span>保存引擎路径</span></button>' +
        '</div></section>' +
        '<section class="section-surface"><div class="toolbar-row">' +
        '<input id="mixedPort" class="field field-short" type="number" placeholder="本地代理端口" value="' + escapeHtml(s ? s.ports.mixed : 23458) + '">' +
        '<input id="dnsPort" class="field field-short" type="number" placeholder="DNS 端口" value="' + escapeHtml(s ? s.ports.dns : 23459) + '">' +
        '<button id="savePorts" class="btn">${icon('save')}<span>保存端口</span></button>' +
        statusChip('推荐 23458 / 23459，避开 Clash 7890', false) +
        '</div></section>' +
        '<div class="status-strip">' +
        metric('当前模式', modeLabels[s ? s.mode : 'app-rule'] || 'App 模式') +
        metric('本地代理', ':' + (s ? s.ports.mixed : 23458)) +
        metric('DNS', ':' + (s ? s.ports.dns : 23459)) +
        metric('控制接口', ':' + (s ? s.ports.controller : 23457)) +
        '</div>';
    }
    function renderSubscriptions() {
      var items = snapshot ? snapshot.subscriptions : [];
      var cards = items.length ? items.map(function (sub) {
        return '<article class="subscription-card ' + (sub.active ? 'active' : '') + '">' +
          '<div class="card-head"><span>${icon('subscriptions')}</span><div class="card-title">' + escapeHtml(sub.name) + '</div><div class="spacer"></div>' +
          '<button class="icon-button" data-edit-sub="' + sub.id + '" title="编辑">${icon('save')}</button>' +
          '<button class="icon-button" data-refresh-sub="' + sub.id + '" title="刷新">${icon('refresh')}</button>' +
          '<button class="icon-button" data-delete-sub="' + sub.id + '" title="删除">${icon('delete')}</button></div>' +
          '<div class="muted ellipsis">' + escapeHtml(redactedUrl(sub.url)) + '</div>' +
          '<div class="toolbar-row" style="margin-top:14px"><span class="muted">' + escapeHtml(relativeTime(sub.lastUpdatedAt)) + '</span><div class="spacer"></div>' +
          '<button class="btn outline" data-active-sub="' + sub.id + '">启用</button></div>' +
          '</article>';
      }).join('') : '<div class="empty">暂无订阅</div>';
      return '<section class="section-surface"><div class="toolbar-row">' +
        '<input id="subUrl" class="field field-grow" placeholder="订阅文件链接">' +
        '<input id="subName" class="field field-short" placeholder="名称" style="width:180px">' +
        '<input id="subUser" class="field field-short" placeholder="用户" style="width:140px">' +
        '<input id="subPass" class="field field-short" type="password" placeholder="密码" style="width:140px">' +
        '<button id="addSub" class="btn">${icon('add')}<span>新建</span></button>' +
        '</div></section>' +
        '<div class="subscription-grid">' + cards + '</div>';
    }
    function renderRules() {
      var items = snapshot ? snapshot.rules : [];
      var cards = items.length ? items.map(function (rule) {
        var allow = rule.kind === 'allow';
        return '<article class="rule-item">' +
          '<span class="rule-icon ' + (allow ? 'allow' : 'block') + '">' + (allow ? '${icon('check')}' : '${icon('block')}') + '</span>' +
          '<div><div class="ellipsis" style="font-weight:700">' + escapeHtml(rule.domain) + '</div><div class="muted ellipsis">' + escapeHtml(rule.source) + '</div></div>' +
          '<button class="icon-button" data-rule-remove="' + rule.id + '" title="删除">${icon('delete')}</button>' +
          '</article>';
      }).join('') : '<div class="empty">暂无规则</div>';
      return '<section class="section-surface"><div class="toolbar-row">' +
        '${presetMarkup()}' +
        '<div class="spacer"></div>' +
        '<input id="ruleDomain" class="field" placeholder="example.com" style="width:220px">' +
        '<select id="ruleKind" class="field" style="width:130px"><option value="allow">白名单</option><option value="block">黑名单</option></select>' +
        '<button id="addRule" class="btn">${icon('add')}<span>添加</span></button>' +
        '</div></section>' +
        '<div class="rule-grid">' + cards + '</div>';
    }
    function renderTest() {
      var s = status();
      return '<section class="section-surface"><div class="toolbar-row">' +
        '<input id="testUrl" class="field field-grow" value="https://www.google.com" placeholder="https://www.google.com">' +
        '<button id="openTest" class="btn">${icon('open')}<span>打开测试窗口</span></button>' +
        '</div></section>' +
        '<section class="section-surface"><div class="toolbar-row">' +
        '<button class="btn outline" data-test-url="https://www.google.com">${icon('globe')}<span>Google</span></button>' +
        '<button class="btn outline" data-test-url="https://www.youtube.com">${icon('play')}<span>YouTube</span></button>' +
        '<button class="btn outline" data-test-url="https://x.com">${icon('at')}<span>X</span></button>' +
        '<button class="btn outline" data-test-url="https://web.telegram.org">${icon('send')}<span>Telegram</span></button>' +
        '</div></section>' +
        '<div class="status-strip">' +
        metric('当前模式', modeLabels[s ? s.mode : 'app-rule'] || 'App 模式') +
        metric('本地代理', ':' + (s ? s.ports.mixed : 23458)) +
        metric('运行状态', s && s.running ? '运行中' : '已停止') +
        '</div>';
    }
    function renderLogs() {
      var events = snapshot ? snapshot.events : [];
      var text = events.map(function (event) {
        return '[' + event.level + '] ' + new Date(event.createdAt).toLocaleString() + ' ' + event.message;
      }).join('\\n');
      return '<section class="section-surface"><div class="mono-log">' + escapeHtml(text) + '</div></section>';
    }
    function renderPage() {
      renderFrame();
      var body = byId('pageBody');
      if (currentPage === 'proxy') body.innerHTML = renderProxy();
      else if (currentPage === 'subscriptions') body.innerHTML = renderSubscriptions();
      else if (currentPage === 'rules') body.innerHTML = renderRules();
      else if (currentPage === 'test') body.innerHTML = renderTest();
      else if (currentPage === 'logs') body.innerHTML = renderLogs();
      else body.innerHTML = renderHome();
      bindPageEvents();
      document.querySelectorAll('[data-preset-button]').forEach(function (button) {
        var preset = button.dataset.presetButton;
        var active = presetActive(preset);
        button.classList.toggle('active', active);
        button.title = active ? '再次点击移除这一组白名单' : '点击加入这一组白名单';
      });
    }
    function closeModal() {
      var modal = byId('modal');
      modal.hidden = true;
      modal.innerHTML = '';
    }
    function openEditSubscriptionModal(id) {
      var sub = subscriptionById(id);
      if (!sub) return;
      var modal = byId('modal');
      modal.innerHTML = '<div class="modal-card">' +
        '<h2 class="modal-title">编辑订阅</h2>' +
        '<div class="modal-form">' +
        '<input id="editSubUrl" class="field wide" placeholder="订阅文件链接" value="' + escapeHtml(sub.url) + '">' +
        '<input id="editSubName" class="field" placeholder="名称" value="' + escapeHtml(sub.name) + '">' +
        '<input id="editSubUser" class="field" placeholder="用户" value="' + escapeHtml(sub.username || '') + '">' +
        '<input id="editSubPass" class="field wide" type="password" placeholder="密码" value="' + escapeHtml(sub.password || '') + '">' +
        '</div>' +
        '<div class="modal-actions">' +
        '<button id="cancelEditSub" class="btn outline">取消</button>' +
        '<button id="saveEditSub" class="btn">${icon('save')}<span>保存</span></button>' +
        '</div>' +
        '</div>';
      modal.hidden = false;
      byId('cancelEditSub').onclick = closeModal;
      byId('saveEditSub').onclick = async function () {
        var saved = await run(function () {
          return api('/api/subscriptions/' + sub.id, {
            method: 'PATCH',
            body: JSON.stringify({
              name: byId('editSubName').value,
              url: byId('editSubUrl').value,
              username: byId('editSubUser').value,
              password: byId('editSubPass').value
            })
          });
        }, '订阅已保存');
        if (saved) closeModal();
      };
    }
    function bindPageEvents() {
      var modeSelect = byId('modeSelect');
      if (modeSelect && status()) modeSelect.value = status().mode;
      var saveMode = byId('saveMode');
      if (saveMode) saveMode.onclick = function () { run(function () { return api('/api/mode', { method: 'POST', body: JSON.stringify({ mode: byId('modeSelect').value }) }); }, '模式已切换'); };
      var installTun = byId('installTun');
      if (installTun) installTun.onclick = function () { run(function () { return api('/api/tun/install', { method: 'POST' }); }, 'TUN 已安装'); };
      var uninstallTun = byId('uninstallTun');
      if (uninstallTun) uninstallTun.onclick = function () { run(function () { return api('/api/tun/uninstall', { method: 'POST' }); }, 'TUN 已卸载'); };
      var saveCorePath = byId('saveCorePath');
      if (saveCorePath) saveCorePath.onclick = function () { run(function () { return api('/api/core/path', { method: 'POST', body: JSON.stringify({ corePath: byId('corePath').value }) }); }, '引擎路径已保存'); };
      var savePorts = byId('savePorts');
      if (savePorts) savePorts.onclick = function () { run(function () { return api('/api/ports', { method: 'POST', body: JSON.stringify({ mixed: Number(byId('mixedPort').value), dns: Number(byId('dnsPort').value) }) }); }, '本地端口已保存'); };
      var updateActiveSub = byId('updateActiveSub');
      if (updateActiveSub) updateActiveSub.onclick = function () { run(function () { return api('/api/subscriptions/active/update', { method: 'POST' }); }, '当前订阅已更新'); };
      var openAdminTab = byId('openAdminTab');
      if (openAdminTab) openAdminTab.onclick = function () { window.open(window.location.href, '_blank'); };
      var addSub = byId('addSub');
      if (addSub) addSub.onclick = function () {
        run(function () {
          return api('/api/subscriptions', { method: 'POST', body: JSON.stringify({ name: byId('subName').value, url: byId('subUrl').value, username: byId('subUser').value, password: byId('subPass').value }) });
        }, '订阅已保存');
      };
      var addRule = byId('addRule');
      if (addRule) addRule.onclick = function () {
        run(function () { return api('/api/rules', { method: 'POST', body: JSON.stringify({ kind: byId('ruleKind').value, domain: byId('ruleDomain').value }) }); }, '规则已添加');
      };
      var openTest = byId('openTest');
      if (openTest) openTest.onclick = function () { try { window.open(normalizeUrl(byId('testUrl').value), '_blank'); } catch (error) { toast(error.message, true); } };
    }
    async function refresh() {
      snapshot = await api('/api/snapshot');
      renderPage();
    }
    document.querySelectorAll('.nav-item').forEach(function (item) {
      item.onclick = function () {
        currentPage = item.dataset.page || 'home';
        window.localStorage.setItem('qpjoyTunnelAdminPage', currentPage);
        renderPage();
      };
    });
    byId('refreshBtn').onclick = function () { run(function () { return refresh(); }); };
    byId('restartBtn').onclick = function () { run(function () { return api('/api/core/restart', { method: 'POST' }); }, '隧道已重载'); };
    byId('toggleCoreBtn').onclick = function () {
      var running = status() && status().running;
      run(function () { return api(running ? '/api/core/stop' : '/api/core/start', { method: 'POST' }); }, running ? '隧道已停止' : '隧道已启动');
    };
    document.body.onclick = function (event) {
      var target = event.target;
      if (!(target instanceof Element)) return;
      var element = target.closest('[data-preset],[data-active-sub],[data-refresh-sub],[data-delete-sub],[data-edit-sub],[data-rule-remove],[data-test-url]');
      if (!element) return;
      if (element.dataset.preset) {
        var active = presetActive(element.dataset.preset);
        run(function () { return api('/api/presets/' + element.dataset.preset, { method: active ? 'DELETE' : 'POST' }); }, active ? '白名单集合已移除' : '白名单集合已加入');
      }
      if (element.dataset.activeSub) run(function () { return api('/api/subscriptions/' + element.dataset.activeSub + '/active', { method: 'POST' }); }, '订阅已启用');
      if (element.dataset.refreshSub) run(function () { return api('/api/subscriptions/' + element.dataset.refreshSub + '/update', { method: 'POST' }); }, '订阅已更新');
      if (element.dataset.deleteSub) run(function () { return api('/api/subscriptions/' + element.dataset.deleteSub, { method: 'DELETE' }); }, '订阅已删除');
      if (element.dataset.editSub) openEditSubscriptionModal(Number(element.dataset.editSub));
      if (element.dataset.ruleRemove) run(function () { return api('/api/rules/' + element.dataset.ruleRemove, { method: 'DELETE' }); }, '规则已删除');
      if (element.dataset.testUrl) {
        var testInput = byId('testUrl');
        if (testInput) testInput.value = element.dataset.testUrl;
        window.open(element.dataset.testUrl, '_blank');
      }
    };
    byId('loginBtn').onclick = async function () {
      await run(async function () {
        var result = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: byId('loginUser').value, password: byId('loginPass').value }) });
        token = result.token;
        window.localStorage.setItem('qpjoyTunnelAdminToken', token);
        byId('login').hidden = true;
        byId('app').hidden = false;
        await refresh();
      }, '已登录');
    };
    if (token) {
      byId('login').hidden = true;
      byId('app').hidden = false;
      refresh().catch(function () {
        token = '';
        window.localStorage.removeItem('qpjoyTunnelAdminToken');
        byId('login').hidden = false;
        byId('app').hidden = true;
      });
    }
  </script>
</body>
</html>`;
}
