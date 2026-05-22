export function adminHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>QPJoy HDO</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #17202a;
      --muted: #637083;
      --line: #dce2ea;
      --accent: #1267b1;
      --accent-2: #11845b;
      --warn: #a65f00;
      --bad: #b42318;
      --shadow: 0 8px 28px rgba(20, 31, 43, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    button, input, select, textarea {
      font: inherit;
    }
    .shell {
      min-height: 100vh;
      display: grid;
      grid-template-columns: 248px minmax(0, 1fr);
    }
    .side {
      border-right: 1px solid var(--line);
      background: #ffffff;
      padding: 28px 20px;
      position: sticky;
      top: 0;
      height: 100vh;
    }
    .brand {
      display: flex;
      gap: 12px;
      align-items: center;
      margin-bottom: 28px;
    }
    .mark {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      background: linear-gradient(135deg, #1267b1, #16a06d);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.38);
    }
    .brand h1 {
      font-size: 20px;
      margin: 0;
      letter-spacing: 0;
    }
    .brand p {
      margin: 2px 0 0;
      color: var(--muted);
      font-size: 12px;
    }
    .nav {
      display: grid;
      gap: 8px;
    }
    .nav button {
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
      text-align: left;
      padding: 11px 12px;
      border-radius: 8px;
      cursor: pointer;
    }
    .nav button.active {
      border-color: #bad6ee;
      background: #edf6ff;
      color: #0f5797;
      font-weight: 650;
    }
    .main {
      padding: 30px clamp(22px, 4vw, 52px) 48px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 18px;
      margin-bottom: 24px;
    }
    .topbar h2 {
      margin: 0;
      font-size: 30px;
      letter-spacing: 0;
    }
    .sub {
      margin: 8px 0 0;
      color: var(--muted);
      line-height: 1.5;
    }
    .btn {
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      border-radius: 8px;
      padding: 10px 14px;
      cursor: pointer;
      min-height: 40px;
    }
    .btn.primary {
      border-color: var(--accent);
      background: var(--accent);
      color: #fff;
    }
    .btn.good {
      border-color: var(--accent-2);
      background: var(--accent-2);
      color: #fff;
    }
    .btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 16px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 18px;
    }
    .span-12 { grid-column: span 12; }
    .span-8 { grid-column: span 8; }
    .span-6 { grid-column: span 6; }
    .span-4 { grid-column: span 4; }
    .span-3 { grid-column: span 3; }
    .panel h3 {
      margin: 0 0 14px;
      font-size: 16px;
      letter-spacing: 0;
    }
    .metric {
      display: grid;
      gap: 6px;
    }
    .metric strong {
      font-size: 26px;
    }
    .metric span {
      color: var(--muted);
      font-size: 13px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #fff;
      color: var(--muted);
      white-space: nowrap;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
    }
    .dot.ok { background: var(--accent-2); }
    .dot.warn { background: var(--warn); }
    .dot.bad { background: var(--bad); }
    label.switch-control {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-height: 40px;
      padding: 7px 11px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--muted);
      cursor: pointer;
      user-select: none;
      margin-bottom: 0;
      font-size: inherit;
    }
    .switch-control input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      width: 1px;
      height: 1px;
      min-height: 0;
      margin: 0;
      padding: 0;
    }
    .switch-track {
      position: relative;
      width: 48px;
      height: 26px;
      border-radius: 999px;
      border: 1px solid #cbd5df;
      background: #dbe2ea;
      transition: background 120ms ease, border-color 120ms ease;
      flex: none;
    }
    .switch-thumb {
      position: absolute;
      top: 2px;
      left: 2px;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.26);
      transition: transform 120ms ease;
    }
    .switch-control input:checked + .switch-track {
      border-color: var(--accent-2);
      background: var(--accent-2);
    }
    .switch-control input:checked + .switch-track .switch-thumb {
      transform: translateX(22px);
    }
    .switch-control input:disabled + .switch-track,
    .switch-control input:disabled ~ .switch-text {
      opacity: 0.55;
    }
    .switch-text {
      color: var(--ink);
      white-space: nowrap;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 12px;
    }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 11px;
      color: var(--ink);
      background: #fff;
      min-height: 40px;
    }
    textarea {
      min-height: 96px;
      resize: vertical;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }
    .row {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .list {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .list li {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 11px;
      background: #fbfcfd;
      color: var(--ink);
      line-height: 1.4;
    }
    .list .muted { color: var(--muted); }
    .checklist {
      display: grid;
      gap: 10px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .checklist li {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      gap: 10px;
      align-items: start;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 11px;
      background: #fbfcfd;
    }
    .step-mark {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      border: 1px solid var(--line);
      color: var(--muted);
      background: #fff;
    }
    .step-mark.ok {
      color: #fff;
      border-color: var(--accent-2);
      background: var(--accent-2);
    }
    .step-mark.warn {
      color: #fff;
      border-color: var(--warn);
      background: var(--warn);
    }
    .step-mark.optional {
      color: var(--muted);
      border-color: var(--line);
      background: #eef2f6;
    }
    .step-title {
      font-weight: 700;
    }
    .step-detail {
      margin-top: 3px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .table th, .table td {
      border-bottom: 1px solid var(--line);
      padding: 9px 8px;
      text-align: left;
      vertical-align: top;
    }
    .table th {
      color: var(--muted);
      font-weight: 600;
    }
    .topology-grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(260px, 340px);
      gap: 16px;
    }
    .topology-map {
      width: 100%;
      min-height: 420px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #f8fafc;
    }
    .topology-edge {
      stroke: #cbd5df;
      stroke-width: 2;
    }
    .topology-node {
      cursor: pointer;
      outline: none;
    }
    .topology-node-ring {
      fill: #fff;
      stroke: #d0d7e2;
      stroke-width: 2;
    }
    .topology-node.selected .topology-node-ring,
    .topology-node:focus .topology-node-ring {
      stroke: var(--accent);
      stroke-width: 4;
    }
    .topology-node-fill,
    .topology-status {
      fill: #637083;
    }
    .topology-node.ok .topology-node-fill,
    .topology-node.ok .topology-status { fill: var(--accent-2); }
    .topology-node.warn .topology-node-fill,
    .topology-node.warn .topology-status { fill: var(--warn); }
    .topology-node.bad .topology-node-fill,
    .topology-node.bad .topology-status { fill: var(--bad); }
    .topology-node.off .topology-node-fill,
    .topology-node.off .topology-status { fill: #98a2b3; }
    .topology-glyph {
      fill: #fff;
      font-size: 18px;
      font-weight: 700;
      text-anchor: middle;
      pointer-events: none;
      letter-spacing: 0;
    }
    .topology-label,
    .topology-caption {
      text-anchor: middle;
      pointer-events: none;
      letter-spacing: 0;
    }
    .topology-label {
      fill: var(--ink);
      font-size: 13px;
      font-weight: 700;
    }
    .topology-caption {
      fill: var(--muted);
      font-size: 11px;
    }
    .topology-detail {
      display: grid;
      gap: 10px;
    }
    .topology-detail-row {
      display: grid;
      grid-template-columns: 78px minmax(0, 1fr);
      gap: 8px;
      border-bottom: 1px solid #eef2f6;
      padding-bottom: 8px;
    }
    .topology-detail-row span {
      color: var(--muted);
      font-size: 12px;
    }
    .topology-detail-row strong {
      overflow-wrap: anywhere;
    }
    .topology-legend {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
      margin-top: 8px;
    }
    .topology-legend span {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .legend-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      display: inline-block;
      background: #98a2b3;
    }
    .legend-dot.ok { background: var(--accent-2); }
    .legend-dot.warn { background: var(--warn); }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      background: #101820;
      color: #e8eef4;
      border-radius: 8px;
      padding: 12px;
      max-height: 260px;
      overflow: auto;
      font-size: 12px;
    }
    .tab { display: none; }
    .tab.active { display: block; }
    .error {
      color: var(--bad);
      background: #fff2f0;
      border: 1px solid #ffd1cc;
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 16px;
    }
    .notice {
      color: #4b5563;
      background: #f8fafc;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      margin-bottom: 16px;
    }
    .banner {
      display: grid;
      gap: 12px;
      border-radius: 8px;
      padding: 16px;
      border: 1px solid var(--line);
      background: #f8fafc;
      color: var(--ink);
    }
    .banner h3 {
      margin: 0;
      font-size: 18px;
    }
    .banner p {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
    }
    .banner.warn {
      border-color: #f0c36d;
      background: #fff8eb;
    }
    .banner.bad {
      border-color: #ffb8ad;
      background: #fff3f0;
    }
    .banner.good {
      border-color: #9bd6bf;
      background: #f0fbf6;
    }
    @media (max-width: 900px) {
      .shell { grid-template-columns: 1fr; }
      .side {
        height: auto;
        position: static;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .nav { grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); }
      .topology-grid { grid-template-columns: 1fr; }
      .span-8, .span-6, .span-4, .span-3 { grid-column: span 12; }
      .topbar { display: grid; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="side">
      <div class="brand">
        <div class="mark" aria-hidden="true"></div>
        <div>
          <h1>QPJoy HDO</h1>
          <p>Home · Domestic · Oversea</p>
        </div>
      </div>
      <nav class="nav">
        <button class="active" data-tab="mesh">我的 Mesh</button>
        <button data-tab="topology">拓扑</button>
        <button data-tab="overview">总览</button>
        <button data-tab="client">客户端</button>
        <button data-tab="advanced">高级</button>
        <button data-tab="server">服务器</button>
        <button data-tab="install">安装</button>
        <button data-tab="egress">出站</button>
      </nav>
    </aside>
    <main class="main">
      <div class="topbar">
        <div>
          <h2 id="title">我的 Mesh</h2>
          <p class="sub" id="subtitle">查看当前入网状态、可访问服务和必要操作。</p>
        </div>
        <div class="row">
          <span class="status"><span id="status-dot" class="dot"></span><span id="status-text">加载中</span></span>
          <button class="btn" id="refresh">刷新</button>
        </div>
      </div>
      <div id="message"></div>

      <section class="tab active" id="tab-mesh">
        <div class="grid">
          <div class="panel span-12" id="meshHomeBanner"></div>
          <div class="panel span-3 metric"><strong id="meshHomeGroup">未入网</strong><span>当前 Mesh</span></div>
          <div class="panel span-3 metric"><strong id="meshHomeTunnel">未连接</strong><span>WireGuard</span></div>
          <div class="panel span-3 metric"><strong id="meshHomeServiceCount">0</strong><span>可见服务</span></div>
          <div class="panel span-3 metric"><strong id="meshHomeNodeCount">0</strong><span>可见节点</span></div>
          <div class="panel span-12">
            <h3>常用操作</h3>
            <div class="row">
              <button class="btn primary" id="meshQuickStart">连接 / 更新 HDO</button>
              <label class="switch-control" title="启动或停止当前 WireGuard peer">
                <input id="meshWireGuardSwitch" type="checkbox" />
                <span class="switch-track"><span class="switch-thumb"></span></span>
                <span class="switch-text" id="meshWireGuardSwitchText">WireGuard 未运行</span>
              </label>
              <button class="btn" id="meshRefreshSubscription">更新订阅</button>
            </div>
          </div>
          <div class="panel span-6">
            <h3>我的设备</h3>
            <ul class="list" id="meshHomeDeviceList"></ul>
          </div>
          <div class="panel span-6">
            <h3>状态与任务</h3>
            <ul class="list" id="meshHomeStatusList"></ul>
          </div>
          <div class="panel span-12">
            <h3>可访问服务</h3>
            <table class="table">
              <thead><tr><th>名称</th><th>目标</th><th>协议</th><th>来源</th><th>域名</th></tr></thead>
              <tbody id="meshHomeServicesTable"></tbody>
            </table>
          </div>
          <div class="panel span-12">
            <h3>Mesh 节点</h3>
            <table class="table">
              <thead><tr><th>类型</th><th>名称</th><th>Overlay</th><th>状态</th></tr></thead>
              <tbody id="meshHomeNodesTable"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="tab" id="tab-topology">
        <div class="grid">
          <div class="panel span-12">
            <div class="topology-grid">
              <div>
                <h3>客户端可见拓扑</h3>
                <p class="sub">展示当前账号已授权可见的 Mesh、节点、设备、服务和 Profile。</p>
                <div class="topology-legend">
                  <span><i class="legend-dot ok"></i>在线</span>
                  <span><i class="legend-dot"></i>离线</span>
                  <span><i class="legend-dot warn"></i>待处理</span>
                </div>
                <svg id="clientTopologyMap" class="topology-map" viewBox="0 0 960 520" role="img" aria-label="HDO client topology"></svg>
              </div>
              <div>
                <h3>详情</h3>
                <div id="clientTopologyDetail" class="topology-detail"></div>
              </div>
            </div>
          </div>
          <div class="panel span-12">
            <h3>拓扑服务</h3>
            <table class="table">
              <thead><tr><th>名称</th><th>目标</th><th>协议</th><th>来源</th><th>域名</th></tr></thead>
              <tbody id="clientTopologyServicesTable"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="tab" id="tab-overview">
        <div class="grid">
          <div class="panel span-12" id="deployBanner"></div>
          <div class="panel span-3 metric"><strong id="oDomestic">未完成</strong><span>Domestic 服务端</span></div>
          <div class="panel span-3 metric"><strong id="oHome">未完成</strong><span>Home 节点</span></div>
          <div class="panel span-3 metric"><strong id="oDevice">未注册</strong><span>当前客户端</span></div>
          <div class="panel span-3 metric"><strong id="oSubscription">未生成</strong><span>Mihomo 订阅</span></div>
          <div class="panel span-6">
            <h3>完成路径</h3>
            <ul class="checklist" id="deployChecklist"></ul>
          </div>
          <div class="panel span-6">
            <h3>下一步</h3>
            <ul class="list" id="overviewNextActions"></ul>
          </div>
        </div>
      </section>

      <section class="tab" id="tab-client">
        <div class="grid">
          <div class="panel span-12">
            <h3>控制面</h3>
            <label>HDO 控制面 URL
              <input id="baseUrl" placeholder="默认使用插件市场服务器 URL" />
            </label>
            <div class="row">
              <button class="btn primary" id="saveSettings">保存</button>
              <button class="btn good" id="quickStart">连接 / 更新 HDO</button>
              <span class="status"><span class="dot ok"></span><span id="serverText">未配置</span></span>
            </div>
          </div>
          <div class="panel span-3 metric"><strong id="mLicense">未授权</strong><span>Mesh 许可</span></div>
          <div class="panel span-3 metric"><strong id="mNodes">0</strong><span>节点</span></div>
          <div class="panel span-3 metric"><strong id="mDevices">0</strong><span>本用户设备</span></div>
          <div class="panel span-3 metric"><strong id="mTasks">0</strong><span>待处理任务</span></div>

          <div class="panel span-12">
            <h3>公开本机服务</h3>
            <div class="grid">
              <label class="span-3">名称<input id="publishedServiceName" placeholder="mac-ssh" /></label>
              <label class="span-3">端口<input id="publishedServicePort" type="number" min="1" max="65535" placeholder="22" /></label>
              <label class="span-3">协议
                <select id="publishedServiceProtocol">
                  <option value="tcp">tcp</option>
                  <option value="http">http</option>
                  <option value="https">https</option>
                  <option value="udp">udp</option>
                </select>
              </label>
              <label class="span-3">域名<input id="publishedServiceDomains" placeholder="mac.local" /></label>
            </div>
            <div class="row">
              <button class="btn primary" id="publishService">公开服务</button>
            </div>
          </div>

          <div class="panel span-12">
            <h3>运行状态</h3>
            <p class="sub" id="wgStatus">未生成</p>
            <ul class="list" id="wgRouteWarnings"></ul>
            <div class="row" style="margin-top: 12px;">
              <button class="btn" data-jump-tab="advanced">打开高级工具</button>
            </div>
          </div>

          <div class="panel span-6">
            <h3>还需要完成</h3>
            <ul class="list" id="nextActions"></ul>
          </div>
          <div class="panel span-6">
            <h3>已完成</h3>
            <ul class="list" id="completed"></ul>
          </div>
        </div>
      </section>

      <section class="tab" id="tab-advanced">
        <div class="grid">
          <div class="panel span-6">
            <h3>客户端设备</h3>
            <label>设备 ID
              <input id="deviceId" placeholder="留空自动生成" />
            </label>
            <label>设备名称
              <input id="deviceLabel" />
            </label>
            <div class="row">
              <button class="btn primary" id="registerDevice">注册 / 更新设备</button>
              <button class="btn" id="reportPlugins">上报插件清单</button>
              <button class="btn good" id="runTasks">执行待处理任务</button>
              <button class="btn" id="fetchManifest">拉取 manifest</button>
              <button class="btn" id="fetchSubscription">拉取订阅</button>
            </div>
            <p class="sub" id="taskRunnerText"></p>
          </div>
          <div class="panel span-6">
            <h3>WireGuard Peer</h3>
            <label>公钥
              <input id="wgPublicKey" readonly />
            </label>
            <label>Overlay IP
              <input id="wgOverlayIp" readonly />
            </label>
            <label>AllowedIPs
              <textarea id="wgAllowedIps" readonly></textarea>
            </label>
            <label>配置文件
              <input id="wgConfigPath" readonly />
            </label>
            <label>Shell 命令
              <textarea id="wgShellCommands" readonly></textarea>
            </label>
            <p class="sub" id="wgDaemonText">系统守护未检测</p>
            <p class="sub" id="wgDaemonPath"></p>
            <div class="row">
              <button class="btn primary" id="prepareWireGuard">生成 / 更新本机 Peer</button>
              <label class="switch-control" title="启动或停止当前 WireGuard peer">
                <input id="wireGuardSwitch" type="checkbox" />
                <span class="switch-track"><span class="switch-thumb"></span></span>
                <span class="switch-text" id="wireGuardSwitchText">WireGuard 未运行</span>
              </label>
              <button class="btn good" id="installWireGuardDaemon">安装系统守护</button>
              <button class="btn" id="uninstallWireGuardDaemon">卸载系统守护</button>
              <button class="btn" id="repairWireGuardRoutes">修复路由</button>
              <button class="btn" id="openWireGuard">定位配置</button>
              <button class="btn" id="rotateWireGuard">轮换密钥</button>
            </div>
          </div>
          <div class="panel span-6">
            <h3>WireGuard 运行状态</h3>
            <p class="sub" id="wgRuntimeText">未检测</p>
            <p class="sub" id="wgRouteLogPath"></p>
            <pre id="wgRouteLogTail">暂无路由执行记录</pre>
            <table class="table">
              <thead><tr><th>Peer</th><th>Endpoint</th><th>Handshake</th><th>流量</th></tr></thead>
              <tbody id="wgRuntimePeersTable"></tbody>
            </table>
          </div>
          <div class="panel span-6">
            <h3>Mesh 节点与设备</h3>
            <table class="table">
              <thead><tr><th>类型</th><th>名称</th><th>Overlay</th><th>状态</th></tr></thead>
              <tbody id="meshPeersTable"></tbody>
            </table>
          </div>
          <div class="panel span-12">
            <h3>Mesh 服务</h3>
            <table class="table">
              <thead><tr><th>名称</th><th>目标</th><th>协议</th><th>来源</th><th>域名</th></tr></thead>
              <tbody id="meshServicesTable"></tbody>
            </table>
          </div>
          <div class="panel span-6">
            <h3>本地生成物</h3>
            <label>Manifest
              <textarea id="manifestOut" readonly></textarea>
            </label>
            <label>Mihomo 订阅
              <textarea id="subscriptionOut" readonly></textarea>
            </label>
            <label>WireGuard 配置
              <textarea id="wgConfigOut" readonly></textarea>
            </label>
          </div>
          <div class="panel span-6">
            <h3>本机插件清单</h3>
            <table class="table">
              <thead><tr><th>插件</th><th>版本</th><th>状态</th></tr></thead>
              <tbody id="localPluginsTable"></tbody>
            </table>
          </div>
          <div class="panel span-6">
            <h3>服务端待处理任务</h3>
            <table class="table">
              <thead><tr><th>类型</th><th>插件</th><th>状态</th></tr></thead>
              <tbody id="deviceTasksTable"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="tab" id="tab-server">
        <div class="grid">
          <div class="panel span-12" id="adminNotice"></div>
          <div class="panel span-6">
            <h3>节点</h3>
            <div class="grid">
              <label class="span-6">名称<input id="nodeName" placeholder="domestic-vps" /></label>
              <label class="span-6">类型
                <select id="nodeKind">
                  <option value="domestic">domestic</option>
                  <option value="home">home</option>
                  <option value="oversea">oversea</option>
                </select>
              </label>
            </div>
            <label>公网地址<input id="nodePublicHost" placeholder="domestic.example.com:8080" /></label>
            <label>Overlay IP<input id="nodeOverlayIp" placeholder="100.88.0.1" /></label>
            <div class="grid">
              <label class="span-8">WG 公钥<input id="nodeWgPublicKey" placeholder="domestic wg public key" /></label>
              <label class="span-4">WG 端口<input id="nodeWgListenPort" type="number" min="1" max="65535" placeholder="51888" /></label>
            </div>
            <button class="btn primary" id="saveNode">保存节点</button>
          </div>
          <div class="panel span-6">
            <h3>服务</h3>
            <label>名称<input id="serviceName" placeholder="home-web" /></label>
            <label>节点<select id="serviceNode"></select></label>
            <div class="grid">
              <label class="span-8">目标地址<input id="serviceHost" placeholder="100.88.0.10" /></label>
              <label class="span-4">端口<input id="servicePort" type="number" min="1" max="65535" placeholder="8080" /></label>
            </div>
            <label>域名，逗号分隔<input id="serviceDomains" placeholder="home.example.com" /></label>
            <button class="btn primary" id="saveService">保存服务</button>
          </div>
          <div class="panel span-8">
            <h3>服务器现状</h3>
            <table class="table">
              <thead><tr><th>类型</th><th>名称</th><th>地址</th><th>状态</th></tr></thead>
              <tbody id="nodesTable"></tbody>
            </table>
          </div>
          <div class="panel span-4">
            <h3>限速</h3>
            <label>对象类型
              <select id="limitSubjectType">
                <option value="user">user</option>
                <option value="device">device</option>
                <option value="profile">profile</option>
                <option value="node">node</option>
              </select>
            </label>
            <label>对象 ID<input id="limitSubjectId" /></label>
            <label>下载速率<input id="limitDown" placeholder="3mbit" /></label>
            <label>上传速率<input id="limitUp" placeholder="30mbit" /></label>
            <button class="btn primary" id="saveLimit">保存限速</button>
          </div>
          <div class="panel span-12">
            <h3>服务列表</h3>
            <table class="table">
              <thead><tr><th>名称</th><th>目标</th><th>协议</th><th>来源</th><th>域名</th></tr></thead>
              <tbody id="servicesTable"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section class="tab" id="tab-install">
        <div class="grid">
          <div class="panel span-12 notice">
            先在 domestic-vps 执行 Domestic 命令；服务启动后回到服务器页保存 domestic 节点，再按需添加 Home 与 Oversea。
          </div>
          <div class="panel span-4">
            <h3>Domestic 服务端</h3>
            <pre id="cmdDomestic"></pre>
          </div>
          <div class="panel span-4">
            <h3>Home 节点</h3>
            <pre id="cmdHome"></pre>
          </div>
          <div class="panel span-4">
            <h3>Oversea 出站</h3>
            <pre id="cmdOversea"></pre>
          </div>
        </div>
      </section>

      <section class="tab" id="tab-egress">
        <div class="grid">
          <div class="panel span-12 notice">
            domestic-vps 不能常驻开启主机全局代理或 TUN；npm、Docker、GitHub 和 provider relay 应使用显式 egress。
          </div>
          <div class="panel span-12">
            <h3>规则</h3>
            <ul class="list">
              <li>public ingress 始终 direct，保留 domestic 自有 IP 入站和回包路径。</li>
              <li>market npm sync 使用 server 端 scoped proxy，避免依赖 npm search 延迟时可调用精确同步。</li>
              <li>docker pull 只给 docker/containerd daemon 配 proxy，应用容器端口仍直连暴露。</li>
              <li>github ssh/https 用 host 级限定规则，不写全局 profile。</li>
            </ul>
          </div>
        </div>
      </section>
    </main>
  </div>
  <script>
    const $ = (id) => document.getElementById(id);
    let snapshot = null;
    let tab = 'mesh';
    let wireGuardActionBusy = false;
    let wireGuardActionStartedAt = 0;
    let pendingLoadRetryTimer = null;
    let selectedClientTopologyKey = null;

    function showMessage(text, kind) {
      const el = $('message');
      if (!text) { el.innerHTML = ''; return; }
      el.innerHTML = '<div class="' + (kind === 'error' ? 'error' : 'notice') + '">' + escapeHtml(text) + '</div>';
    }

    async function request(path, options) {
      const res = await fetch(path, options);
      const type = res.headers.get('content-type') || '';
      const body = type.includes('application/json') ? await res.json() : await res.text();
      if (!res.ok) {
        throw new Error(
          typeof body === 'object' && body
            ? (body.error || body.message || JSON.stringify(body))
            : String(body)
        );
      }
      return body;
    }

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function waitForWireGuardState(active, attempts = 8) {
      for (let i = 0; i < attempts; i += 1) {
        await sleep(i === 0 ? 250 : 700);
        const status = await request('/api/client/wireguard/status').catch(() => null);
        if (status) {
          snapshot = {
            ...(snapshot || {}),
            wireGuardStatus: status
          };
          renderWireGuardRuntimeStatus(status);
          renderWireGuardSwitches(status, (snapshot.settings && snapshot.settings.wireGuardPeer) || null);
        }
        if (status && Boolean(status.active) === active) return status;
      }
      return null;
    }

    function hasMissingWireGuardRoutes(status) {
      return Boolean(status && Array.isArray(status.missingRoutes) && status.missingRoutes.length);
    }

    function routeListSummary(routes) {
      if (!Array.isArray(routes) || routes.length === 0) return '';
      if (routes.length <= 6) return routes.join(', ');
      return routes.length + ' 条（' + routes.slice(0, 4).join(', ') + ' ...）';
    }

    async function waitForWireGuardRoutesReady(attempts = 8) {
      let latest = null;
      for (let i = 0; i < attempts; i += 1) {
        await sleep(i === 0 ? 400 : 800);
        const status = await request('/api/client/wireguard/status').catch(() => null);
        if (!status) continue;
        latest = status;
        snapshot = {
          ...(snapshot || {}),
          wireGuardStatus: status
        };
        renderWireGuardRuntimeStatus(status);
        renderWireGuardSwitches(status, (snapshot.settings && snapshot.settings.wireGuardPeer) || null);
        if (status.active && !hasMissingWireGuardRoutes(status)) return status;
      }
      return latest;
    }

    async function repairWireGuardRoutesIfMissing(status) {
      if (!hasMissingWireGuardRoutes(status)) return status;
      const result = await request('/api/client/wireguard/repair-routes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      if (result && result.ok === false) {
        throw new Error(result.message || result.command || 'HDO 路由修复失败');
      }
      return await waitForWireGuardRoutesReady(10) || status;
    }

    async function recoverLocalWireGuardIfDesired() {
      const settings = snapshot && snapshot.settings ? snapshot.settings : {};
      const peer = settings.wireGuardPeer || null;
      if (!peer || !peer.configPath || settings.wireGuardDesiredActive === false) return null;
      const current = await request('/api/client/wireguard/status').catch(() =>
        (snapshot && snapshot.wireGuardStatus) || null
      );
      if (current && current.active && !hasMissingWireGuardRoutes(current)) return current;
      const result = await request('/api/client/wireguard/recover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'admin-quick-start', allowPrivileged: true })
      });
      if (result && result.ok === false && !result.skipped) {
        throw new Error(result.message || result.command || '本地 WireGuard 恢复失败');
      }
      if (result && result.skipped) return null;
      let status = await waitForWireGuardState(true, 10);
      if (status) status = await repairWireGuardRoutesIfMissing(status);
      return status && status.active ? status : null;
    }

    function isAuthorizationCancelled(err) {
      const text = err && err.message ? String(err.message) : String(err || '');
      return text.includes('已取消 WireGuard 管理员授权')
        || text.includes('用户已取消')
        || text.includes('(-128)')
        || /user canceled/i.test(text)
        || /cancelled/i.test(text);
    }

    function isTransientFetchError(err) {
      const text = err && err.message ? String(err.message) : String(err || '');
      return /fetch failed/i.test(text)
        || /failed to fetch/i.test(text)
        || /load failed/i.test(text)
        || /networkerror/i.test(text);
    }

    function scheduleLoadRetry(successMessage) {
      const delays = [900, 1800, 3500, 6000];
      let index = 0;
      if (pendingLoadRetryTimer) {
        clearTimeout(pendingLoadRetryTimer);
        pendingLoadRetryTimer = null;
      }
      const retry = async () => {
        pendingLoadRetryTimer = null;
        const ok = await load({ silent: true });
        if (ok) {
          showMessage(successMessage || '状态已刷新', 'info');
          return;
        }
        if (index >= delays.length) return;
        pendingLoadRetryTimer = setTimeout(retry, delays[index]);
        index += 1;
      };
      pendingLoadRetryTimer = setTimeout(retry, delays[index]);
      index += 1;
    }

    async function finishActionWithRefresh(label) {
      const ok = await load({ silent: true });
      if (ok) {
        showMessage(label + '成功', 'info');
        return true;
      }
      showMessage(label + '已完成，网络路由正在切换，稍后自动刷新状态…', 'info');
      scheduleLoadRetry(label + '成功，状态已刷新');
      return false;
    }

    function updateWireGuardBusyControls() {
      ['meshQuickStart', 'quickStart'].forEach((id) => {
        const el = $(id);
        if (el) el.disabled = wireGuardActionBusy;
      });
      const s = snapshot || {};
      renderWireGuardSwitches(s.wireGuardStatus || null, (s.settings && s.settings.wireGuardPeer) || null);
    }

    async function runAction(label, task, options = {}) {
      if (options.wireGuard && wireGuardActionBusy) {
        showMessage('WireGuard 操作进行中，请先完成系统授权。', 'info');
        return null;
      }
      if (options.wireGuard) {
        wireGuardActionBusy = true;
        wireGuardActionStartedAt = Date.now();
        updateWireGuardBusyControls();
      }
      showMessage(label + '中…', 'info');
      try {
        const result = await task();
        await finishActionWithRefresh(label);
        return result;
      } catch (err) {
        if (options.treatCancelAsInfo && isAuthorizationCancelled(err)) {
          await load({ silent: true }).catch(() => undefined);
          showMessage(label + '已取消', 'info');
          return null;
        }
        if (
          options.wireGuard
          && typeof options.recoverWireGuardActive === 'boolean'
          && isTransientFetchError(err)
        ) {
          let recovered = await waitForWireGuardState(options.recoverWireGuardActive, 10);
          if (options.recoverWireGuardActive && hasMissingWireGuardRoutes(recovered)) {
            recovered = await repairWireGuardRoutesIfMissing(recovered).catch(() => recovered);
          }
          if (recovered) {
            snapshot = {
              ...(snapshot || {}),
              wireGuardStatus: recovered
            };
            showMessage(
              hasMissingWireGuardRoutes(recovered)
                ? label + '已完成，但 HDO 路由仍缺失：' + routeListSummary(recovered.missingRoutes)
                : label + '已完成，网络路由正在切换，稍后自动刷新状态…',
              hasMissingWireGuardRoutes(recovered) ? 'error' : 'info'
            );
            scheduleLoadRetry(label + '成功，状态已刷新');
            return null;
          }
          showMessage(label + '请求已发出，正在等待网络切换完成，稍后自动确认状态…', 'info');
          scheduleLoadRetry(label + '状态已刷新');
          return null;
        }
        showMessage(label + '失败：' + (err.message || String(err)), 'error');
        throw err;
      } finally {
        if (options.wireGuard) {
          wireGuardActionBusy = false;
          wireGuardActionStartedAt = 0;
          updateWireGuardBusyControls();
        }
      }
    }

    async function load(options = {}) {
      try {
        snapshot = await request('/api/snapshot');
        if (wireGuardActionBusy && wireGuardActionStartedAt && Date.now() - wireGuardActionStartedAt > 20000) {
          wireGuardActionBusy = false;
          wireGuardActionStartedAt = 0;
        }
        const commands = await request('/api/install-commands');
        render(commands);
        if (!options.silent) {
          showMessage(snapshot.lastError, snapshot.lastError ? 'error' : 'info');
        }
        return true;
      } catch (err) {
        if (!options.silent) {
          showMessage(err.message || String(err), 'error');
        }
        return false;
      }
    }

    function render(commands) {
      const s = snapshot || {};
      const settings = s.settings || {};
      const safeCommands = commands || {};
      $('baseUrl').value = settings.hdoControlBaseUrl || '';
      $('deviceId').value = settings.deviceId || '';
      $('deviceLabel').value = settings.deviceLabel || '';
      $('serverText').textContent = s.serverBaseUrl || '未配置';
      $('manifestOut').value = settings.lastManifest ? JSON.stringify(settings.lastManifest, null, 2) : '';
      $('subscriptionOut').value = settings.lastSubscription || '';
      renderWireGuardPeer(settings.wireGuardPeer || null);
      renderWireGuardRuntimeStatus(s.wireGuardStatus || null);
      renderWireGuardDaemonStatus(s.wireGuardDaemonStatus || null, settings.wireGuardPeer || null);
      renderWireGuardSwitches(s.wireGuardStatus || null, settings.wireGuardPeer || null);
      $('cmdDomestic').textContent = safeCommands.domestic || '';
      $('cmdHome').textContent = safeCommands.home || '';
      $('cmdOversea').textContent = safeCommands.oversea || '';

      const ready = s.readiness || {};
      const summary = ready.summary || {};
      const mesh = summary.mesh || {};
      $('mNodes').textContent = String((summary.nodes && summary.nodes.total) || 0);
      $('mDevices').textContent = String(summary.devices || 0);
      $('mLicense').textContent = mesh.licensed ? '已授权' : '未授权';
      $('mTasks').textContent = String((s.deviceTasks || []).length || 0);
      $('taskRunnerText').textContent = taskRunnerText(s);
      renderList('nextActions', ready.nextActions || ['等待连接 HDO 控制面']);
      renderList('completed', ready.completed || []);
      renderLocalPlugins(s.localPlugins || []);
      renderDeviceTasks(s.deviceTasks || []);

      const deployment = deploymentState(s);
      renderDeployment(deployment);
      renderMeshHome(s, deployment);
      renderClientTopology(s);

      const dot = $('status-dot');
      dot.className = 'dot ' + (deployment.level === 'good' ? 'ok' : deployment.level === 'bad' ? 'bad' : 'warn');
      $('status-text').textContent = deployment.shortLabel;

      const admin = s.admin;
      $('adminNotice').textContent = admin
        ? '管理员接口可用。'
        : '服务器面板需要插件市场管理员登录态。';
      renderNodes(admin ? admin.nodes : []);
      renderServices(admin ? admin.services : []);
      renderServiceNodeOptions(admin ? admin.nodes : []);
      renderMeshPeers(s);
      renderMeshServices(s);
    }

    function deploymentState(s) {
      const settings = s.settings || {};
      const ready = s.readiness || {};
      const summary = ready.summary || {};
      const summaryNodes = summary.nodes || {};
      const adminNodes = s.admin && Array.isArray(s.admin.nodes) ? s.admin.nodes : [];
      const adminServices = s.admin && Array.isArray(s.admin.services) ? s.admin.services : [];
      const hasNode = (kind) => Number(summaryNodes[kind] || 0) > 0 || adminNodes.some((node) => node && node.kind === kind);
      const serviceCount = Number(summary.services || 0) || adminServices.filter((svc) => svc && svc.enabled !== false).length;
      const mesh = summary.mesh || {};
      const hasServer = Boolean(s.serverBaseUrl);
      const loggedIn = Boolean(s.session && s.session.loggedIn);
      const licenseReady = Boolean(mesh.licensed);
      const domesticReady = hasNode('domestic');
      const homeReady = hasNode('home');
      const overseaReady = hasNode('oversea');
      const deviceReady = Number(summary.devices || 0) > 0 || (Array.isArray(s.devices) && s.devices.length > 0) || Boolean(settings.deviceId);
      const wireGuardReady = Boolean(settings.wireGuardPeer && settings.wireGuardPeer.publicKey);
      const wireGuardConfigReady = Boolean(settings.wireGuardPeer && settings.wireGuardPeer.config);
      const subscriptionReady = Boolean(settings.lastManifest && settings.lastSubscription);
      const controlReachable = Boolean(ready.summary);

      const steps = [
        {
          label: '设置 HDO 控制面',
          detail: hasServer ? '当前控制面：' + s.serverBaseUrl : '默认会使用插件市场服务器 URL，也可以在客户端页手动指定 domestic 地址。',
          done: hasServer,
          tab: 'client'
        },
        {
          label: '登录插件市场',
          detail: loggedIn ? '已复用插件市场登录态调用 HDO API。' : '先在插件市场登录 / 注册，HDO 客户端才能读取服务端配置。',
          done: loggedIn,
          tab: 'client'
        },
        {
          label: '获得 mesh 许可',
          detail: licenseReady ? '服务端已给当前用户发放有效 HDO mesh 许可。' : '请管理员在服务器 HDO 控制面把当前用户加入一个启用中的 mesh 组。',
          done: licenseReady,
          tab: 'client'
        },
        {
          label: '部署 domestic 服务端',
          detail: domesticReady ? '已登记 domestic 节点。' : '到安装页复制 Domestic 命令，在 domestic-vps 执行后回到服务器页保存节点。',
          done: domesticReady,
          tab: 'install'
        },
        {
          label: '添加 Home 节点',
          detail: homeReady ? '已登记 home 节点。' : '在 home 侧生成 WireGuard peer，并在服务器页保存 home 节点。',
          done: homeReady,
          tab: 'install'
        },
        {
          label: '配置可下发服务',
          detail: serviceCount > 0 ? '已有可下发服务。' : '在服务器页添加至少一个 home 或 oversea 服务，客户端订阅才有实际目标。',
          done: serviceCount > 0,
          tab: 'server'
        },
        {
          label: '注册当前客户端',
          detail: deviceReady ? '当前客户端已有设备记录。' : '在客户端页点“连接 / 更新 HDO”会自动注册；高级页可手动填写设备 ID。',
          done: deviceReady,
          tab: 'client'
        },
        {
          label: '生成本机 WireGuard peer',
          detail: wireGuardReady
            ? (wireGuardConfigReady ? '本机已生成密钥并保存 WireGuard 配置。' : '本机密钥已生成；等待 domestic 节点下发 WireGuard 公钥和 endpoint。')
            : '客户端页会自动准备 peer；需要手动轮换密钥或查看公钥时再进高级页。',
          done: wireGuardReady,
          tab: 'client'
        },
        {
          label: '生成 manifest 与 Mihomo 订阅',
          detail: subscriptionReady ? '本地已保存最近一次 manifest 和 Mihomo 订阅。' : '节点与服务就绪后，客户端页会一并拉取 manifest 和订阅；高级页可单独刷新。',
          done: subscriptionReady,
          tab: 'client'
        },
        {
          label: '配置 oversea 显式出站',
          detail: overseaReady ? '已登记 oversea 节点。' : '可选项。需要访问 npm/GitHub/Docker 时再配置，不影响 Home overlay 和 SSH 测试。',
          done: overseaReady,
          tab: 'egress',
          optional: true
        }
      ];

      let level = 'warn';
      let shortLabel = '待完成';
      let title = 'HDO 还需要完成部署';
      let detail = '按下面的完成路径继续配置，插件会随着服务端状态刷新更新下一步。';
      const actions = [];

      if (!hasServer) {
        title = '还没有 HDO 控制面地址';
        detail = '先确认插件市场服务器 URL，或在客户端页填写 domestic-vps 的 HDO 控制面地址。';
        shortLabel = '未配置控制面';
        actions.push({ tab: 'client', label: '设置控制面', primary: true });
      } else if (!loggedIn) {
        title = '已安装 HDO 插件，仍需登录插件市场';
        detail = '登录后 HDO 插件才能用同一用户身份注册设备、读取 manifest 和订阅。';
        shortLabel = '未登录';
        actions.push({ tab: 'client', label: '查看客户端', primary: true });
      } else if (s.lastError && !controlReachable) {
        level = 'bad';
        title = 'Domestic 服务端尚未部署或暂不可达';
        detail = '当前控制面是 ' + s.serverBaseUrl + '。如果 domestic-vps 还没安装，请先执行安装页的 Domestic 命令；如果已经安装，检查端口、防火墙和 electron-server。';
        shortLabel = '控制面不可达';
        actions.push({ tab: 'install', label: '查看安装命令', primary: true });
        actions.push({ tab: 'server', label: '登记服务器' });
      } else if (!licenseReady) {
        title = 'HDO 服务端可达，但当前用户还没有 mesh 许可';
        detail = '管理员需要在服务器 HDO 控制面创建 mesh 组，并把当前登录用户加入该组；之后客户端才能生成有效 manifest 和订阅。';
        shortLabel = '缺 mesh 许可';
        actions.push({ tab: 'client', label: '查看客户端', primary: true });
      } else if (!domesticReady) {
        title = 'Domestic 服务端尚未完成登记';
        detail = 'HDO 插件已经就绪，下一步是在 domestic-vps 部署服务端，并在服务器页保存 domestic 节点。';
        shortLabel = '缺 domestic';
        actions.push({ tab: 'install', label: '查看安装命令', primary: true });
        actions.push({ tab: 'server', label: '保存节点' });
      } else if (!homeReady) {
        title = 'Domestic 已就绪，继续添加 Home 节点';
        detail = 'Home 节点接入后，客户端 manifest 才能拿到内网目标和 WireGuard overlay 信息。';
        shortLabel = '缺 home';
        actions.push({ tab: 'install', label: '查看 Home 命令', primary: true });
      } else if (serviceCount <= 0) {
        title = '还没有可下发服务';
        detail = '节点已登记后，需要在服务器页保存至少一个服务，订阅规则才会指向具体目标。';
        shortLabel = '缺服务';
        actions.push({ tab: 'server', label: '添加服务', primary: true });
      } else if (!deviceReady) {
        title = '服务端基础信息已就绪，注册当前客户端';
        detail = '注册本机设备后，服务端会按用户和设备生成 manifest 与 Mihomo 订阅。';
        shortLabel = '待注册设备';
        actions.push({ tab: 'client', label: '注册设备', primary: true });
      } else if (!wireGuardReady) {
        title = '当前客户端还没有本机 WireGuard peer';
        detail = 'HDO 会用内置 WireGuard CLI 在本机生成密钥，并把公钥和本地路由探测结果注册到服务端；私钥不会上传。';
        shortLabel = '待生成 WG peer';
        actions.push({ tab: 'client', label: '生成 WG peer', primary: true });
      } else if (!subscriptionReady) {
        title = '客户端已注册，继续拉取订阅';
        detail = '在客户端页拉取 manifest 与 Mihomo 订阅，本地会保存最近一次生成物。';
        shortLabel = '待拉订阅';
        actions.push({ tab: 'client', label: '拉取订阅', primary: true });
      } else {
        level = 'good';
        shortLabel = '基础流程完成';
        title = 'HDO 基础流程已完成';
        detail = '客户端、服务端节点、服务目录和订阅生成物都已具备，可以继续按需配置限速和 oversea 显式出站。';
        actions.push({ tab: 'server', label: '查看服务器' });
        actions.push({ tab: 'egress', label: '查看出站规则' });
      }

      const nextActions = steps
        .filter((step) => !step.done && !step.optional)
        .map((step) => step.detail);

      return {
        level,
        shortLabel,
        title,
        detail,
        actions,
        steps,
        nextActions,
        domesticReady,
        homeReady,
        deviceReady,
        wireGuardReady,
        subscriptionReady
      };
    }

    function renderDeployment(state) {
      $('oDomestic').textContent = state.domesticReady ? '已配置' : '未完成';
      $('oHome').textContent = state.homeReady ? '已配置' : '未完成';
      $('oDevice').textContent = state.deviceReady ? '已注册' : '未注册';
      $('oSubscription').textContent = state.subscriptionReady ? '已生成' : '未生成';

      const actions = state.actions.map((action) => (
        '<button class="btn ' + (action.primary ? 'primary' : '') + '" data-jump-tab="' + escapeAttr(action.tab) + '">' +
        escapeHtml(action.label) +
        '</button>'
      )).join('');
      $('deployBanner').innerHTML =
        '<div class="banner ' + escapeAttr(state.level) + '">' +
        '<h3>' + escapeHtml(state.title) + '</h3>' +
        '<p>' + escapeHtml(state.detail) + '</p>' +
        (actions ? '<div class="row">' + actions + '</div>' : '') +
        '</div>';

      $('deployChecklist').innerHTML = state.steps.map((step) => {
        const markClass = step.done ? 'ok' : (step.optional ? 'optional' : 'warn');
        const markText = step.done ? '&#10003;' : (step.optional ? '可' : '!');
        return '<li>' +
          '<span class="step-mark ' + markClass + '">' + markText + '</span>' +
          '<div><div class="step-title">' + escapeHtml(step.label + (step.optional ? '（可选）' : '')) + '</div>' +
          '<div class="step-detail">' + escapeHtml(step.detail) + '</div></div>' +
          '</li>';
      }).join('');
      renderList('overviewNextActions', state.nextActions.length ? state.nextActions : ['暂无，基础流程已经完成']);
    }

    function renderMeshHome(s, deployment) {
      const settings = s.settings || {};
      const manifest = settings.lastManifest || {};
      const license = manifest.license || {};
      const groups = Array.isArray(license.groups) ? license.groups : [];
      const services = Array.isArray(manifest.services) ? manifest.services : [];
      const nodes = Array.isArray(manifest.nodes) ? manifest.nodes : [];
      const meshDevices = Array.isArray(manifest.devices) ? manifest.devices : [];
      const device = manifest.device || (Array.isArray(s.devices) && s.devices[0]) || {};
      const peer = settings.wireGuardPeer || {};
      const runtime = s.wireGuardStatus || {};
      const tasks = Array.isArray(s.deviceTasks) ? s.deviceTasks : [];
      const notification = settings.lastNotification || null;
      const groupsLabel = groups.length ? groups.map((row) => row.name || row.slug || row.id).join(', ') : '未入网';
      const routeMissing = Boolean(runtime.active && hasMissingWireGuardRoutes(runtime));
      const tunnelLabel = runtime.active
        ? (routeMissing ? '路由缺失' : '已连接')
        : (peer.publicKey ? '已配置' : '未配置');

      $('meshHomeGroup').textContent = groupsLabel;
      $('meshHomeTunnel').textContent = tunnelLabel;
      $('meshHomeServiceCount').textContent = String(services.length);
      $('meshHomeNodeCount').textContent = String(nodes.length + meshDevices.length);
      $('meshHomeBanner').innerHTML =
        '<div class="banner ' + escapeAttr(deployment.level) + '">' +
        '<h3>' + escapeHtml(deployment.title) + '</h3>' +
        '<p>' + escapeHtml(deployment.detail) + '</p>' +
        '</div>';

      renderList('meshHomeDeviceList', [
        '设备：' + (device.label || settings.deviceLabel || settings.deviceId || '未注册'),
        'Overlay IP：' + (device.overlayIp || peer.overlayIp || '未分配'),
        '公钥：' + shortKey(device.publicKey || peer.publicKey || ''),
        'Profile：' + currentProfileLabel(manifest)
      ]);

      const statusItems = [
        '控制面：' + (s.serverBaseUrl || '未配置'),
        'WireGuard：' + (runtime.active
          ? ((runtime.realInterfaceName || runtime.interfaceName || '接口') + (routeMissing ? ' 路由缺失' : ' 运行中'))
          : tunnelLabel),
        '订阅 generation：' + (manifest.generation || '未生成'),
        '待处理任务：' + tasks.length
      ];
      if (notification) {
        statusItems.push('通知：' + (notification.title || 'HDO 通知') + ' - ' + (notification.body || ''));
      }
      if (s.lastError) statusItems.unshift('错误：' + s.lastError);
      renderList('meshHomeStatusList', statusItems);

      $('meshHomeServicesTable').innerHTML = services.length ? services.map((svc) => (
        '<tr><td>' + escapeHtml(svc.name || '') + '</td><td>' +
        escapeHtml((svc.targetHost || svc.host || '') + ':' + (svc.targetPort || svc.port || '')) + '</td><td>' +
        escapeHtml(svc.protocol || '') + '</td><td>' +
        escapeHtml(serviceSourceLabel(svc)) + '</td><td>' +
        escapeHtml((svc.domains || []).join(', ')) + '</td></tr>'
      )).join('') : '<tr><td colspan="5" class="muted">暂无服务；等待服务端下发可见服务</td></tr>';

      const meshRows = [
        ...nodes.map((node) => ({
          kind: node.kind || 'node',
          name: node.name || node.id || '',
          overlay: node.overlayIp || node.publicHost || '',
          status: node.status || ''
        })),
        ...meshDevices.map((row) => ({
          kind: 'device',
          name: row.label || row.id || '',
          overlay: row.overlayIp || '',
          status: row.status || row.platform || ''
        }))
      ];
      $('meshHomeNodesTable').innerHTML = meshRows.length ? meshRows.map((node) => (
        '<tr><td>' + escapeHtml(node.kind || '') + '</td><td>' +
        escapeHtml(node.name || '') + '</td><td>' +
        escapeHtml(node.overlay || '') + '</td><td>' +
        escapeHtml(node.status || '') + '</td></tr>'
      )).join('') : '<tr><td colspan="4" class="muted">暂无节点；等待服务端下发 mesh 节点</td></tr>';
    }

    function renderClientTopology(s) {
      const model = buildClientTopology(s || {});
      if (!model.items.length) {
        $('clientTopologyMap').innerHTML = '<text x="480" y="260" text-anchor="middle" fill="#637083">暂无拓扑数据；先连接 / 更新 HDO</text>';
        $('clientTopologyDetail').innerHTML = '<div class="notice">暂无拓扑数据。</div>';
        $('clientTopologyServicesTable').innerHTML = '<tr><td colspan="5" class="muted">暂无服务</td></tr>';
        return;
      }
      if (!selectedClientTopologyKey || !model.items.some((item) => item.key === selectedClientTopologyKey)) {
        selectedClientTopologyKey = model.items[0].key;
      }
      const selected = model.items.find((item) => item.key === selectedClientTopologyKey) || model.items[0];
      const edges = model.edges.map((edge) => (
        '<line class="topology-edge" x1="' + edge.x1 + '" y1="' + edge.y1 +
        '" x2="' + edge.x2 + '" y2="' + edge.y2 + '"></line>'
      )).join('');
      const nodes = model.items.map((item) => {
        const selectedClass = item.key === selected.key ? ' selected' : '';
        return '<g class="topology-node ' + escapeAttr(item.level + selectedClass) +
          '" data-topology-key="' + escapeAttr(item.key) +
          '" tabindex="0" transform="translate(' + item.x + ' ' + item.y + ')">' +
          '<title>' + escapeHtml(topologyTitle(item)) + '</title>' +
          '<circle class="topology-node-ring" r="31"></circle>' +
          '<circle class="topology-node-fill" r="24"></circle>' +
          '<text class="topology-glyph" y="7">' + escapeHtml(item.glyph) + '</text>' +
          '<circle class="topology-status" cx="22" cy="-20" r="7"></circle>' +
          '<text class="topology-label" y="49">' + escapeHtml(item.shortLabel) + '</text>' +
          '<text class="topology-caption" y="66">' + escapeHtml(item.caption) + '</text>' +
          '</g>';
      }).join('');
      $('clientTopologyMap').innerHTML = edges + nodes;
      $('clientTopologyDetail').innerHTML = renderTopologyDetail(selected);
      renderTopologyServices(selected, model.services);
    }

    function buildClientTopology(s) {
      const settings = s.settings || {};
      const manifest = settings.lastManifest || {};
      const license = manifest.license || {};
      const groups = Array.isArray(license.groups) ? license.groups : [];
      const nodes = Array.isArray(manifest.nodes) ? manifest.nodes : [];
      const manifestDevices = Array.isArray(manifest.devices) ? manifest.devices : [];
      const services = Array.isArray(manifest.services) ? manifest.services : [];
      const profiles = Array.isArray(manifest.profiles) ? manifest.profiles : [];
      const rateLimits = Array.isArray(manifest.rateLimits) ? manifest.rateLimits : [];
      const currentDevice = manifest.device || (Array.isArray(s.devices) && s.devices[0]) || {};
      const peer = settings.wireGuardPeer || {};
      const runtime = s.wireGuardStatus || {};
      const items = [];
      const positions = new Map();
      const meshName = groups.length ? groups.map((row) => row.name || row.slug || row.id).join(', ') : '当前 Mesh';
      const meshKey = 'mesh:current';

      pushTopology(items, positions, {
        key: meshKey,
        id: 'current',
        type: 'mesh',
        label: meshName,
        shortLabel: truncateText(meshName, 16),
        caption: license.active ? 'active' : 'no license',
        description: license.active ? '当前账号已加入 Mesh' : '当前账号还没有 active mesh 许可',
        kindLabel: 'Mesh',
        statusLabel: license.active ? '在线' : '待处理',
        level: license.active ? 'ok' : 'warn',
        glyph: 'M',
        x: 480,
        y: 74,
        overlayIp: manifest.wireGuard && manifest.wireGuard.addressPlan ? manifest.wireGuard.addressPlan.domesticIp : null,
        publicHost: null,
        profileLabel: currentProfileLabel(manifest),
        rateLimitLabel: null,
        parentKey: null
      });

      nodes.forEach((node, index) => {
        const visual = topologyStatus(node.status || (node.kind === 'domestic' ? 'pending' : 'offline'));
        pushTopology(items, positions, {
          key: 'node:' + (node.id || index),
          id: node.id || String(index),
          type: 'node',
          label: node.name || node.id || node.kind || 'node',
          shortLabel: truncateText(node.name || node.id || node.kind || 'node', 15),
          caption: node.kind || 'node',
          description: node.publicKey ? 'WireGuard ' + shortKey(node.publicKey) : (node.publicHost || 'Mesh 节点'),
          kindLabel: nodeKindLabel(node.kind || 'node'),
          statusLabel: visual.label,
          level: visual.level,
          glyph: nodeGlyph(node.kind || 'node'),
          x: nodeX(node, index, nodes.length),
          y: nodeY(node, index),
          overlayIp: node.overlayIp || null,
          publicHost: node.publicHost || null,
          profileLabel: null,
          rateLimitLabel: rateLimitFor(rateLimits, 'node', node.id),
          parentKey: meshKey
        });
      });

      const deviceRows = dedupeDevices([
        currentDevice,
        ...manifestDevices
      ]);
      deviceRows.forEach((device, index) => {
        const isCurrent = (device.id && currentDevice.id && device.id === currentDevice.id)
          || (device.overlayIp && peer.overlayIp && device.overlayIp === peer.overlayIp);
        const visual = isCurrent
          ? topologyStatus('online')
          : topologyStatus(device.status || 'offline');
        const owner = shortUser(device.userId || currentDevice.userId || '');
        const label = owner ? owner + '/' + (device.label || device.id || 'device') : (device.label || device.id || 'device');
        pushTopology(items, positions, {
          key: 'device:' + (device.id || device.overlayIp || index),
          id: device.id || String(index),
          type: 'device',
          label: label,
          shortLabel: truncateText(label, 16),
          caption: isCurrent ? 'this device' : (device.platform || 'device'),
          description: device.publicKey ? 'WireGuard ' + shortKey(device.publicKey) : '客户端设备',
          kindLabel: isCurrent ? '当前设备' : '可见设备',
          statusLabel: visual.label,
          level: visual.level,
          glyph: isCurrent ? '我' : 'D',
          x: spread(index, deviceRows.length, 145, 815),
          y: 350 + Math.floor(index / 6) * 78,
          overlayIp: device.overlayIp || peer.overlayIp || null,
          publicHost: null,
          profileLabel: currentProfileLabel(manifest),
          rateLimitLabel: rateLimitFor(rateLimits, 'device', device.id) || rateLimitFor(rateLimits, 'user', device.userId),
          parentKey: domesticTopologyKey(nodes) || meshKey
        });
      });

      profiles.forEach((profile, index) => {
        if (index > 2) return;
        const visual = topologyStatus(profile.enabled === false ? 'offline' : 'online');
        pushTopology(items, positions, {
          key: 'profile:' + (profile.id || index),
          id: profile.id || String(index),
          type: 'profile',
          label: profile.name || profile.mode || profile.id || 'profile',
          shortLabel: truncateText(profile.name || profile.mode || profile.id || 'profile', 15),
          caption: profile.mode || 'profile',
          description: '路由和出站策略',
          kindLabel: 'Profile',
          statusLabel: profile.enabled === false ? '停用' : '启用',
          level: visual.level,
          glyph: 'P',
          x: spread(index, Math.min(profiles.length, 3), 250, 710),
          y: 150,
          overlayIp: null,
          publicHost: null,
          profileLabel: profile.mode || null,
          rateLimitLabel: rateLimitFor(rateLimits, 'profile', profile.id),
          parentKey: meshKey
        });
      });

      services.forEach((service, index) => {
        const parentKey = serviceParentKey(service, nodes, deviceRows) || meshKey;
        const parent = positions.get(parentKey);
        const visual = topologyStatus(service.enabled === false ? 'offline' : 'online');
        pushTopology(items, positions, {
          key: 'service:' + (service.id || service.name || index),
          id: service.id || String(index),
          type: 'service',
          label: service.name || service.id || 'service',
          shortLabel: truncateText(service.name || service.id || 'service', 15),
          caption: (service.protocol || 'tcp') + ' ' + (service.targetPort || service.port || ''),
          description: (service.targetHost || service.host || '') + ':' + (service.targetPort || service.port || ''),
          kindLabel: '可访问服务',
          statusLabel: service.enabled === false ? '停用' : '启用',
          level: visual.level,
          glyph: 'S',
          x: clamp((parent ? parent.x : 480) + serviceOffset(index), 88, 872),
          y: clamp((parent ? parent.y : 270) + 92, 115, 492),
          overlayIp: service.targetHost || service.host || null,
          publicHost: Array.isArray(service.domains) ? service.domains[0] || null : null,
          profileLabel: null,
          rateLimitLabel: null,
          parentKey
        });
      });

      const byKey = new Map(items.map((item) => [item.key, item]));
      const edges = items
        .filter((item) => item.parentKey && byKey.has(item.parentKey))
        .map((item) => {
          const parent = byKey.get(item.parentKey);
          return { x1: parent.x, y1: parent.y, x2: item.x, y2: item.y };
        });
      return { items, edges, services };
    }

    function pushTopology(items, positions, item) {
      items.push(item);
      positions.set(item.key, { x: item.x, y: item.y });
    }

    function renderTopologyDetail(item) {
      const rows = [
        ['类型', item.kindLabel],
        ['状态', item.statusLabel],
        ['Overlay', item.overlayIp || ''],
        ['公网/域名', item.publicHost || ''],
        ['Profile', item.profileLabel || ''],
        ['限速', item.rateLimitLabel || '']
      ].filter((row) => row[1]);
      return '<div class="topology-detail">' + rows.map((row) => (
        '<div class="topology-detail-row"><span>' + escapeHtml(row[0]) + '</span><strong>' +
        escapeHtml(row[1]) + '</strong></div>'
      )).join('') + '<p class="sub">' + escapeHtml(item.description || '') + '</p></div>';
    }

    function renderTopologyServices(selected, services) {
      const rows = services.filter((service) => topologyServiceMatches(selected, service));
      $('clientTopologyServicesTable').innerHTML = rows.length ? rows.map((svc) => (
        '<tr><td>' + escapeHtml(svc.name || '') + '</td><td>' +
        escapeHtml((svc.targetHost || svc.host || '') + ':' + (svc.targetPort || svc.port || '')) + '</td><td>' +
        escapeHtml(svc.protocol || '') + '</td><td>' +
        escapeHtml(serviceSourceLabel(svc)) + '</td><td>' +
        escapeHtml((svc.domains || []).join(', ')) + '</td></tr>'
      )).join('') : '<tr><td colspan="5" class="muted">当前选择没有直接关联服务</td></tr>';
    }

    function topologyServiceMatches(selected, service) {
      if (!selected || selected.type === 'mesh') return true;
      if (selected.type === 'service') return selected.id === (service.id || '');
      if (selected.type === 'node') return selected.id === (service.nodeId || '') || selected.overlayIp === (service.targetHost || service.host || '');
      if (selected.type === 'device') return selected.overlayIp && selected.overlayIp === (service.targetHost || service.host || '');
      return false;
    }

    function topologyTitle(item) {
      return [
        item.label,
        item.kindLabel,
        item.overlayIp ? 'Overlay: ' + item.overlayIp : '',
        item.publicHost ? 'Public: ' + item.publicHost : '',
        'Status: ' + item.statusLabel
      ].filter(Boolean).join('\\n');
    }

    function renderList(id, items) {
      const rows = items.length ? items : ['暂无'];
      $(id).innerHTML = rows.map((item) => '<li>' + escapeHtml(String(item)) + '</li>').join('');
    }

    function renderNodes(nodes) {
      $('nodesTable').innerHTML = nodes.length ? nodes.map((n) => (
        '<tr><td>' + escapeHtml(n.kind || '') + '</td><td>' + escapeHtml(n.name || '') +
        '</td><td>' + escapeHtml(n.publicHost || n.overlayIp || '') + '</td><td>' +
        escapeHtml(n.status || '') + '</td></tr>'
      )).join('') : '<tr><td colspan="4" class="muted">暂无节点</td></tr>';
    }

    function renderServices(services) {
      $('servicesTable').innerHTML = services.length ? services.map((svc) => (
        '<tr><td>' + escapeHtml(svc.name || '') + '</td><td>' + escapeHtml((svc.targetHost || '') + ':' + (svc.targetPort || '')) +
        '</td><td>' + escapeHtml(svc.protocol || '') + '</td><td>' +
        escapeHtml(serviceSourceLabel(svc)) + '</td><td>' +
        escapeHtml((svc.domains || []).join(', ')) + '</td></tr>'
      )).join('') : '<tr><td colspan="5" class="muted">暂无服务</td></tr>';
    }

    function serviceSourceLabel(service) {
      const metadata = service && service.metadata && typeof service.metadata === 'object' ? service.metadata : {};
      if (metadata.source === 'server-probe') return '服务端探测';
      if (metadata.source === 'device-published') return '客户端公开';
      return '管理员登记';
    }

    function renderLocalPlugins(plugins) {
      $('localPluginsTable').innerHTML = plugins.length ? plugins.map((plugin) => (
        '<tr><td>' + escapeHtml(plugin.pluginId || '') + '</td><td>' +
        escapeHtml(plugin.version || '') + '</td><td>' +
        escapeHtml(plugin.state || '') + '</td></tr>'
      )).join('') : '<tr><td colspan="3" class="muted">暂无本机插件记录</td></tr>';
    }

    function renderDeviceTasks(tasks) {
      $('deviceTasksTable').innerHTML = tasks.length ? tasks.map((task) => (
        '<tr><td>' + escapeHtml(task.kind || '') + '</td><td>' +
        escapeHtml(task.pluginId || '') + '</td><td>' +
        escapeHtml(task.status || '') + '</td></tr>'
      )).join('') : '<tr><td colspan="3" class="muted">暂无待处理任务</td></tr>';
    }

    function renderWireGuardPeer(peer) {
      const routeProbe = peer && peer.routeProbe ? peer.routeProbe : {};
      const warnings = [];
      if (peer && peer.lastError) warnings.push(peer.lastError);
      if (routeProbe && Array.isArray(routeProbe.warnings)) warnings.push(...routeProbe.warnings);
      if (routeProbe && Array.isArray(routeProbe.conflicts) && routeProbe.conflicts.length) {
        warnings.push('重叠网段：' + routeProbe.conflicts.map((row) => row.localCidr + ' ↔ ' + row.hdoCidr).join(', '));
      }
      $('wgPublicKey').value = peer && peer.publicKey ? peer.publicKey : '';
      $('wgOverlayIp').value = peer && peer.overlayIp ? peer.overlayIp : '';
      $('wgAllowedIps').value = peer && Array.isArray(peer.allowedIps) ? peer.allowedIps.join(', ') : '';
      $('wgConfigPath').value = peer && peer.configPath ? peer.configPath : '';
      $('wgShellCommands').value = peer && peer.configPath ? wireGuardShellCommands(peer.configPath, snapshot) : '';
      $('wgConfigOut').value = peer && peer.config ? peer.config : '';
      $('wgStatus').textContent = peer && peer.publicKey
        ? (peer.config ? '已生成本机 peer 与 WireGuard 配置。' : '已生成本机 peer，等待 domestic 节点补齐 WireGuard endpoint。')
        : '未生成。HDO 会使用插件自带 WireGuard CLI，本机无需预装 wg 命令。';
      renderList('wgRouteWarnings', warnings.length ? warnings : ['本机路由未发现与 HDO 默认网段冲突']);
    }

    function renderWireGuardRuntimeStatus(status) {
      if (!status) {
        $('wgRuntimeText').textContent = '未生成配置或尚未检测到运行状态。';
        $('wgRouteLogPath').textContent = '';
        $('wgRouteLogTail').textContent = '暂无路由执行记录';
        $('wgRuntimePeersTable').innerHTML = '<tr><td colspan="4" class="muted">暂无运行中的 peer</td></tr>';
        return;
      }
      const label = status.active
        ? '已运行：' + (status.realInterfaceName || status.interfaceName || '未知接口')
        : '未运行';
      const detail = status.error ? '；' + status.error : '';
      const missingRoutes = Array.isArray(status.missingRoutes) ? status.missingRoutes : [];
      const routes = Array.isArray(status.routes) && status.routes.length
        ? '；路由 ' + status.routes.length + ' 条'
        : '';
      const routeDetail = missingRoutes.length ? '；缺路由 ' + routeListSummary(missingRoutes) : routes;
      $('wgRuntimeText').textContent = label + '；模式 ' + (status.mode || 'unknown') + routeDetail + detail;
      const routeProbes = Array.isArray(status.routeProbes) ? status.routeProbes : [];
      const probeLines = routeProbes.map((probe) => (
        (probe.ok ? 'OK ' : 'MISS ') + probe.target + ' -> ' +
        (probe.actualInterface || 'unknown') + ' / expected ' + (probe.expectedInterface || '')
      ));
      $('wgRouteLogPath').textContent = status.routeLogPath ? ('路由执行日志：' + status.routeLogPath) : '';
      $('wgRouteLogTail').textContent = [
        probeLines.length ? ('Route probes:\\n' + probeLines.join('\\n')) : '',
        status.routeLogTail || ''
      ].filter(Boolean).join('\\n\\n') || '暂无路由执行记录';
      const peers = Array.isArray(status.peers) ? status.peers : [];
      $('wgRuntimePeersTable').innerHTML = peers.length ? peers.map((peer) => (
        '<tr><td>' + escapeHtml(shortKey(peer.publicKey)) + '</td><td>' +
        escapeHtml(peer.endpoint || '') + '</td><td>' +
        escapeHtml(handshakeText(peer.latestHandshakeSeconds)) + '</td><td>' +
        escapeHtml(formatBytes(peer.transferRxBytes || 0) + ' / ' + formatBytes(peer.transferTxBytes || 0)) +
        '</td></tr>'
      )).join('') : '<tr><td colspan="4" class="muted">暂无运行中的 peer；若刚启动失败，先看上方错误。</td></tr>';
    }

    function renderWireGuardDaemonStatus(status, peer) {
      const hasConfig = Boolean(peer && peer.configPath);
      const installButton = $('installWireGuardDaemon');
      const uninstallButton = $('uninstallWireGuardDaemon');
      if (!status) {
        $('wgDaemonText').textContent = hasConfig ? '系统守护未安装。' : '系统守护等待 WireGuard 配置。';
        $('wgDaemonPath').textContent = '';
        if (installButton) installButton.disabled = wireGuardActionBusy || !hasConfig;
        if (uninstallButton) uninstallButton.disabled = true;
        return;
      }
      if (!status.supported) {
        $('wgDaemonText').textContent = '系统守护仅支持 macOS userspace WireGuard。';
        $('wgDaemonPath').textContent = '';
        if (installButton) installButton.disabled = true;
        if (uninstallButton) uninstallButton.disabled = true;
        return;
      }
      const daemonState = status.running
        ? '运行中'
        : (status.loaded ? '已加载' : (status.installed ? '已安装未加载' : '未安装'));
      $('wgDaemonText').textContent = '系统守护：' + daemonState + '；KeepAlive ' + (status.installed ? '可用' : '未启用');
      $('wgDaemonPath').textContent = status.plistPath ? ('LaunchDaemon：' + status.plistPath) : '';
      if (installButton) installButton.disabled = wireGuardActionBusy || !hasConfig;
      if (uninstallButton) uninstallButton.disabled = wireGuardActionBusy || !hasConfig || !(status.installed || status.loaded);
    }

    function renderWireGuardSwitches(status, peer) {
      const active = Boolean(status && status.active);
      const routeMissing = active && hasMissingWireGuardRoutes(status);
      const hasConfig = Boolean(peer && peer.configPath);
      const label = wireGuardActionBusy
        ? 'WireGuard 操作中…'
        : (active ? (routeMissing ? 'WireGuard 路由缺失' : 'WireGuard 运行中') : (hasConfig ? 'WireGuard 已停止' : 'WireGuard 未配置'));
      [
        ['meshWireGuardSwitch', 'meshWireGuardSwitchText'],
        ['wireGuardSwitch', 'wireGuardSwitchText']
      ].forEach(([inputId, textId]) => {
        const input = $(inputId);
        const text = $(textId);
        if (!input || !text) return;
        input.checked = active && !routeMissing;
        input.disabled = wireGuardActionBusy || !hasConfig;
        input.title = routeMissing ? 'WireGuard 已启动，但 HDO 路由缺失；打开开关会尝试修复路由。' : '';
        text.textContent = label;
      });
      ['meshQuickStart', 'quickStart', 'repairWireGuardRoutes'].forEach((id) => {
        const button = $(id);
        if (button) button.disabled = wireGuardActionBusy;
      });
      const installDaemon = $('installWireGuardDaemon');
      if (installDaemon) installDaemon.disabled = wireGuardActionBusy || !hasConfig;
    }

    function renderMeshPeers(s) {
      const admin = s.admin || {};
      const rows = [];
      const seen = new Set();
      const addRow = (kind, name, overlay, status) => {
        const key = [kind, name, overlay].join(':');
        if (seen.has(key)) return;
        seen.add(key);
        rows.push({ kind, name, overlay, status });
      };
      (Array.isArray(admin.nodes) ? admin.nodes : []).forEach((node) => {
        addRow(node.kind || 'node', node.name || node.id || '', node.overlayIp || node.publicHost || '', node.status || '');
      });
      (Array.isArray(admin.devices) ? admin.devices : []).forEach((device) => {
        addRow('device', device.label || device.name || device.id || '', device.overlayIp || '', device.status || device.platform || '');
      });
      (Array.isArray(s.devices) ? s.devices : []).forEach((device) => {
        addRow('device', device.label || device.name || device.id || '', device.overlayIp || '', device.status || device.platform || '');
      });
      const manifest = s.settings && s.settings.lastManifest ? s.settings.lastManifest : {};
      const manifestNodes = Array.isArray(manifest.nodes) ? manifest.nodes : [];
      manifestNodes.forEach((node) => {
        addRow(node.kind || 'manifest', node.name || node.id || '', node.overlayIp || node.publicHost || '', node.status || '');
      });
      const manifestDevices = Array.isArray(manifest.devices) ? manifest.devices : [];
      manifestDevices.forEach((device) => {
        addRow('device', device.label || device.name || device.id || '', device.overlayIp || '', device.status || device.platform || '');
      });
      $('meshPeersTable').innerHTML = rows.length ? rows.map((row) => (
        '<tr><td>' + escapeHtml(row.kind) + '</td><td>' +
        escapeHtml(row.name) + '</td><td>' +
        escapeHtml(row.overlay) + '</td><td>' +
        escapeHtml(row.status) + '</td></tr>'
      )).join('') : '<tr><td colspan="4" class="muted">暂无 mesh 节点或设备清单</td></tr>';
    }

    function renderMeshServices(s) {
      const adminServices = s.admin && Array.isArray(s.admin.services) ? s.admin.services : [];
      const manifest = s.settings && s.settings.lastManifest ? s.settings.lastManifest : {};
      const manifestServices = Array.isArray(manifest.services) ? manifest.services : [];
      const rows = adminServices.length ? adminServices : manifestServices;
      $('meshServicesTable').innerHTML = rows.length ? rows.map((svc) => (
        '<tr><td>' + escapeHtml(svc.name || '') + '</td><td>' +
        escapeHtml((svc.targetHost || svc.host || '') + ':' + (svc.targetPort || svc.port || '')) + '</td><td>' +
        escapeHtml(svc.protocol || '') + '</td><td>' +
        escapeHtml(serviceSourceLabel(svc)) + '</td><td>' +
        escapeHtml((svc.domains || []).join(', ')) + '</td></tr>'
      )).join('') : '<tr><td colspan="5" class="muted">暂无服务</td></tr>';
    }

    function taskRunnerText(s) {
      if (s.taskRunnerBusy) return '任务执行器正在运行。';
      const last = s.settings && s.settings.lastTaskRun;
      if (!last) return '默认会自动执行可领取的 pending 任务；也可以手动点击执行。';
      return '上次执行：done ' + (last.done || 0) + ' / failed ' + (last.failed || 0) + ' / skipped ' + (last.skipped || 0);
    }

    function renderServiceNodeOptions(nodes) {
      $('serviceNode').innerHTML = '<option value="">不绑定</option>' + nodes.map((n) => (
        '<option value="' + escapeAttr(n.id) + '">' + escapeHtml(n.kind + ' / ' + n.name) + '</option>'
      )).join('');
    }

    function currentProfileLabel(manifest) {
      const profiles = Array.isArray(manifest.profiles) ? manifest.profiles : [];
      const memberships = manifest.license && Array.isArray(manifest.license.memberships) ? manifest.license.memberships : [];
      const profileId = memberships.map((row) => row.profileId).find(Boolean);
      if (profileId) {
        const profile = profiles.find((row) => row.id === profileId);
        return profile ? (profile.name || profile.mode || profile.id) : profileId;
      }
      return profiles[0] ? (profiles[0].name || profiles[0].mode || profiles[0].id) : '默认';
    }

    function nodeKindLabel(kind) {
      if (kind === 'domestic') return 'Domestic 网关';
      if (kind === 'home') return 'Home 节点';
      if (kind === 'oversea') return 'Oversea 节点';
      return 'Mesh 节点';
    }

    function nodeGlyph(kind) {
      if (kind === 'domestic') return 'G';
      if (kind === 'home') return 'H';
      if (kind === 'oversea') return 'O';
      return 'N';
    }

    function topologyStatus(status) {
      const value = String(status || '').toLowerCase();
      if (value === 'online' || value === 'active' || value === 'enabled') return { level: 'ok', label: '在线' };
      if (value === 'pending' || value === 'claimed') return { level: 'warn', label: '待处理' };
      if (value === 'error' || value === 'failed') return { level: 'bad', label: '异常' };
      return { level: 'off', label: '离线' };
    }

    function nodeX(node, index, total) {
      if (node.kind === 'domestic') return 480;
      if (node.kind === 'home') return 245;
      if (node.kind === 'oversea') return 715;
      return spread(index, total, 190, 770);
    }

    function nodeY(node, index) {
      if (node.kind === 'domestic') return 185;
      if (node.kind === 'home' || node.kind === 'oversea') return 230 + index * 34;
      return 205 + index * 54;
    }

    function domesticTopologyKey(nodes) {
      const domestic = nodes.find((node) => node && node.kind === 'domestic');
      return domestic ? 'node:' + domestic.id : null;
    }

    function serviceParentKey(service, nodes, devices) {
      if (service.nodeId) return 'node:' + service.nodeId;
      const target = service.targetHost || service.host || '';
      const device = devices.find((row) => row && row.overlayIp === target);
      if (device) return 'device:' + (device.id || device.overlayIp);
      const node = nodes.find((row) => row && row.overlayIp === target);
      return node ? 'node:' + node.id : null;
    }

    function dedupeDevices(devices) {
      const rows = [];
      const seen = new Set();
      devices.forEach((device) => {
        if (!device || typeof device !== 'object') return;
        if (!device.id && !device.overlayIp && !device.publicKey && !device.label) return;
        const key = device.id || device.overlayIp || device.publicKey || device.label;
        if (seen.has(key)) return;
        seen.add(key);
        rows.push(device);
      });
      return rows;
    }

    function rateLimitFor(rateLimits, subjectType, subjectId) {
      if (!subjectId) return null;
      const rows = rateLimits.filter((row) => row && row.subjectType === subjectType && row.subjectId === subjectId);
      if (!rows.length) return null;
      return rows.map((row) => {
        const down = [row.downRate, row.downCeil].filter(Boolean).join(' / ');
        const up = [row.upRate, row.upCeil].filter(Boolean).join(' / ');
        return [down ? '下行 ' + down : '', up ? '上行 ' + up : ''].filter(Boolean).join('，');
      }).filter(Boolean).join('；');
    }

    function shortUser(value) {
      const text = String(value || '');
      return text.length > 10 ? text.slice(0, 6) : text;
    }

    function truncateText(value, max) {
      const text = String(value || '');
      return text.length > max ? text.slice(0, Math.max(1, max - 1)) + '…' : text;
    }

    function spread(index, total, start, end) {
      if (total <= 1) return (start + end) / 2;
      return start + ((end - start) * index) / (total - 1);
    }

    function serviceOffset(index) {
      return ((index % 3) - 1) * 84;
    }

    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value));
    }

    function formValue(id) {
      const v = $(id).value.trim();
      return v || null;
    }

    function setTab(next) {
      const titles = {
        mesh: ['我的 Mesh', '查看当前入网状态、可访问服务和必要操作。'],
        topology: ['拓扑', '查看当前账号可见的 Mesh、节点、设备、服务和策略。'],
        overview: ['总览', '查看 HDO 从服务端部署到客户端订阅的完成状态。'],
        client: ['客户端', '注册本机设备，拉取 HDO manifest 与 Mihomo 订阅。'],
        advanced: ['高级', '手动管理设备、WireGuard peer、生成物和服务端待处理任务。'],
        server: ['服务器', '维护 domestic/home/oversea 节点、服务目录和限速记录。'],
        install: ['安装', '按角色生成安装命令，先完成 domestic-vps，再接入 home 和 oversea。'],
        egress: ['出站', '保留 domestic 公网入口，只让指定任务走 oversea。']
      };
      if (!titles[next]) return;
      tab = next;
      document.querySelectorAll('.nav button').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
      document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.id === 'tab-' + tab));
      $('title').textContent = titles[tab][0];
      $('subtitle').textContent = titles[tab][1];
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/"/g, '&quot;');
    }

    function shortKey(value) {
      const text = String(value || '');
      return text.length > 14 ? text.slice(0, 8) + '…' + text.slice(-6) : text;
    }

    function handshakeText(seconds) {
      if (seconds === null || seconds === undefined || seconds === '') return '未握手';
      const n = Number(seconds);
      if (!Number.isFinite(n)) return '未知';
      if (n < 60) return Math.round(n) + ' 秒前';
      if (n < 3600) return Math.round(n / 60) + ' 分钟前';
      return Math.round(n / 3600) + ' 小时前';
    }

    function formatBytes(value) {
      const n = Number(value || 0);
      if (!Number.isFinite(n) || n <= 0) return '0 B';
      const units = ['B', 'KiB', 'MiB', 'GiB'];
      let size = n;
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return (index === 0 ? String(Math.round(size)) : size.toFixed(1)) + ' ' + units[index];
    }

    function wireGuardShellCommands(configPath, s) {
      const platform = s && s.settings && s.settings.devicePlatform;
      if (platform === 'win32') {
        const quoted = "'" + String(configPath).replace(/'/g, "''") + "'";
        return [
          'Get-Content ' + quoted,
          'wireguard /installtunnelservice ' + quoted
        ].join('\\n');
      }
      const quoted = "'" + String(configPath).replace(/'/g, "'\\\\''") + "'";
      if (platform === 'darwin') {
        return [
          'cat ' + quoted,
          '# 启动/停止请使用上方按钮；HDO 会调用内置 wireguard-go + wg。'
        ].join('\\n');
      }
      return [
        'cat ' + quoted,
        'sudo wg-quick up ' + quoted,
        'sudo wg-quick down ' + quoted
      ].join('\\n');
    }

    async function setWireGuardRunning(shouldRun) {
      const label = shouldRun ? '启动 WireGuard peer' : '停止 WireGuard peer';
      try {
        await runAction(label, async () => {
          const current = await request('/api/client/wireguard/status').catch(() =>
            (snapshot && snapshot.wireGuardStatus) || null
          );
          if (shouldRun && current && current.active && hasMissingWireGuardRoutes(current)) {
            const repaired = await repairWireGuardRoutesIfMissing(current);
            if (hasMissingWireGuardRoutes(repaired)) {
              throw new Error('WireGuard 已启动，但 HDO 路由仍缺失：' + routeListSummary(repaired.missingRoutes));
            }
            return repaired;
          }
          const result = await request('/api/client/wireguard/connect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: shouldRun ? 'up' : 'down' })
          });
          if (result && result.ok === false) {
            throw new Error(result.message || result.command || (shouldRun ? 'WireGuard 未启动' : 'WireGuard 未停止'));
          }
          const status = await waitForWireGuardState(shouldRun, 16);
          if (shouldRun) {
            const repaired = await repairWireGuardRoutesIfMissing(status);
            if (hasMissingWireGuardRoutes(repaired)) {
              throw new Error('WireGuard 已启动，但 HDO 路由仍缺失：' + routeListSummary(repaired.missingRoutes));
            }
          }
        }, { wireGuard: true, treatCancelAsInfo: true, recoverWireGuardActive: shouldRun });
      } catch {
        const s = snapshot || {};
        renderWireGuardSwitches(s.wireGuardStatus || null, (s.settings && s.settings.wireGuardPeer) || null);
      }
    }

    async function repairWireGuardRoutes() {
      await runAction('修复 HDO 路由', async () => {
        const result = await request('/api/client/wireguard/repair-routes', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({})
        });
        if (result && result.ok === false) {
          throw new Error(result.message || result.command || 'HDO 路由修复失败');
        }
        const status = await waitForWireGuardRoutesReady(10);
        if (hasMissingWireGuardRoutes(status)) {
          throw new Error('HDO 路由仍缺失：' + routeListSummary(status.missingRoutes));
        }
      }, { wireGuard: true, treatCancelAsInfo: true, recoverWireGuardActive: true });
    }

    document.querySelectorAll('.nav button').forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab));
    });
    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-jump-tab]') : null;
      if (target) setTab(target.dataset.jumpTab);
      const topologyTarget = event.target instanceof Element ? event.target.closest('[data-topology-key]') : null;
      if (topologyTarget) {
        selectedClientTopologyKey = topologyTarget.dataset.topologyKey;
        renderClientTopology(snapshot || {});
      }
    });
    document.addEventListener('keydown', (event) => {
      const topologyTarget = event.target instanceof Element ? event.target.closest('[data-topology-key]') : null;
      if (!topologyTarget || event.key !== 'Enter') return;
      selectedClientTopologyKey = topologyTarget.dataset.topologyKey;
      renderClientTopology(snapshot || {});
    });

    $('refresh').addEventListener('click', () => {
      if (pendingLoadRetryTimer) {
        clearTimeout(pendingLoadRetryTimer);
        pendingLoadRetryTimer = null;
      }
      wireGuardActionBusy = false;
      wireGuardActionStartedAt = 0;
      load();
    });
    $('meshQuickStart').addEventListener('click', () => $('quickStart').click());
    $('meshRefreshSubscription').addEventListener('click', () => $('fetchSubscription').click());
    $('meshWireGuardSwitch').addEventListener('change', (event) => setWireGuardRunning(event.currentTarget.checked));
    $('wireGuardSwitch').addEventListener('change', (event) => setWireGuardRunning(event.currentTarget.checked));
    $('repairWireGuardRoutes').addEventListener('click', () => repairWireGuardRoutes().catch(() => undefined));
    $('installWireGuardDaemon').addEventListener('click', () => runAction('安装 WireGuard 系统守护', async () => {
      const result = await request('/api/client/wireguard/daemon/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      if (result && result.ok === false) {
        throw new Error(result.message || result.command || '系统守护安装失败');
      }
      const status = await waitForWireGuardState(true, 16);
      const repaired = await repairWireGuardRoutesIfMissing(status);
      if (hasMissingWireGuardRoutes(repaired)) {
        throw new Error('系统守护已启动，但 HDO 路由仍缺失：' + routeListSummary(repaired.missingRoutes));
      }
    }, { wireGuard: true, treatCancelAsInfo: true, recoverWireGuardActive: true }).catch(() => undefined));
    $('uninstallWireGuardDaemon').addEventListener('click', () => runAction('卸载 WireGuard 系统守护', async () => {
      const result = await request('/api/client/wireguard/daemon/uninstall', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stopTunnel: true })
      });
      if (result && result.ok === false) {
        throw new Error(result.message || result.command || '系统守护卸载失败');
      }
      await waitForWireGuardState(false, 8);
    }, { wireGuard: true, treatCancelAsInfo: true, recoverWireGuardActive: false }).catch(() => undefined));
    $('saveSettings').addEventListener('click', () => runAction('保存控制面', async () => {
      await request('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hdoControlBaseUrl: formValue('baseUrl') })
      });
    }).catch(() => undefined));
    $('quickStart').addEventListener('click', () => runAction('连接 HDO', async () => {
      await request('/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hdoControlBaseUrl: formValue('baseUrl') })
      });
      let connectAttempted = false;
      try {
        const prepared = await request('/api/client/wireguard/prepare', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rotate: false })
        });
        if (prepared && prepared.ok === false) {
          throw new Error(prepared.message || 'WireGuard 配置尚未就绪');
        }
        await request('/api/client/subscription', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({})
        });
        connectAttempted = true;
        const connected = await request('/api/client/wireguard/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'restart' })
        });
        if (connected && connected.ok === false) {
          throw new Error(connected.message || connected.command || 'WireGuard 未启动');
        }
      } catch (err) {
        if (!connectAttempted && isTransientFetchError(err)) {
          const locallyRecovered = await recoverLocalWireGuardIfDesired().catch(() => null);
          if (locallyRecovered && !hasMissingWireGuardRoutes(locallyRecovered)) {
            showMessage('已先恢复本地 HDO 隧道；控制面暂不可达，网络恢复后再更新订阅。', 'info');
            return locallyRecovered;
          }
        }
        throw err;
      }
      const status = await waitForWireGuardState(true, 16);
      const repaired = await repairWireGuardRoutesIfMissing(status);
      if (hasMissingWireGuardRoutes(repaired)) {
        throw new Error('WireGuard 已启动，但 HDO 路由仍缺失：' + routeListSummary(repaired.missingRoutes));
      }
    }, { wireGuard: true, treatCancelAsInfo: true, recoverWireGuardActive: true }).catch(() => undefined));
    $('registerDevice').addEventListener('click', () => runAction('注册设备', async () => {
      await request('/api/client/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: formValue('deviceId'), label: formValue('deviceLabel') })
      });
    }).catch(() => undefined));
    $('reportPlugins').addEventListener('click', () => runAction('上报插件清单', async () => {
      await request('/api/client/plugin-states', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: formValue('deviceId') })
      });
    }).catch(() => undefined));
    $('prepareWireGuard').addEventListener('click', () => runAction('生成 WireGuard peer', async () => {
      await request('/api/client/wireguard/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rotate: false })
      });
    }).catch(() => undefined));
    $('rotateWireGuard').addEventListener('click', () => runAction('轮换 WireGuard 密钥', async () => {
      await request('/api/client/wireguard/prepare', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rotate: true })
      });
    }).catch(() => undefined));
    $('openWireGuard').addEventListener('click', () => runAction('定位 WireGuard 配置', async () => {
      const result = await request('/api/client/wireguard/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
      if (result && result.ok === false) {
        throw new Error(result.message || result.command || 'WireGuard 未启动');
      }
    }).catch(() => undefined));
    $('runTasks').addEventListener('click', () => runAction('执行待处理任务', async () => {
      await request('/api/client/tasks/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({})
      });
    }).catch(() => undefined));
    $('fetchManifest').addEventListener('click', () => runAction('拉取 manifest', async () => {
      await request('/api/client/manifest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: formValue('deviceId') })
      });
    }).catch(() => undefined));
    $('fetchSubscription').addEventListener('click', () => runAction('拉取订阅', async () => {
      const text = await request('/api/client/subscription', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: formValue('deviceId') })
      });
      $('subscriptionOut').value = text;
    }).catch(() => undefined));
    $('publishService').addEventListener('click', () => runAction('公开服务', async () => {
      const targetPort = Number(formValue('publishedServicePort'));
      if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
        throw new Error('请输入 1-65535 的本机端口');
      }
      await request('/api/client/services/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: formValue('publishedServiceName'),
          targetPort,
          protocol: $('publishedServiceProtocol').value,
          domains: (formValue('publishedServiceDomains') || '').split(',').map((s) => s.trim()).filter(Boolean),
          enabled: true
        })
      });
      await request('/api/client/manifest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: formValue('deviceId') })
      });
    }).catch(() => undefined));
    $('saveNode').addEventListener('click', () => runAction('保存节点', async () => {
      await request('/api/admin/nodes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: formValue('nodeName'),
          kind: $('nodeKind').value,
          publicHost: formValue('nodePublicHost'),
          overlayIp: formValue('nodeOverlayIp'),
          status: 'pending',
          metadata: nodeMetadata()
        })
      });
    }).catch(() => undefined));
    $('saveService').addEventListener('click', () => runAction('保存服务', async () => {
      await request('/api/admin/services', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: formValue('serviceName'),
          nodeId: formValue('serviceNode'),
          targetHost: formValue('serviceHost'),
          targetPort: Number(formValue('servicePort')),
          protocol: 'tcp',
          domains: (formValue('serviceDomains') || '').split(',').map((s) => s.trim()).filter(Boolean),
          enabled: true
        })
      });
    }).catch(() => undefined));
    $('saveLimit').addEventListener('click', () => runAction('保存限速', async () => {
      await request('/api/admin/rate-limits', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subjectType: $('limitSubjectType').value,
          subjectId: formValue('limitSubjectId'),
          downRate: formValue('limitDown'),
          upRate: formValue('limitUp')
        })
      });
    }).catch(() => undefined));

    load();

    function nodeMetadata() {
      const publicKey = formValue('nodeWgPublicKey');
      const listenPort = Number(formValue('nodeWgListenPort') || 0);
      const publicHost = formValue('nodePublicHost');
      if (!publicKey && !listenPort) return null;
      return {
        wireGuard: {
          publicKey,
          listenPort: listenPort || 51888,
          endpointHost: publicHost ? publicHost.replace(/^https?:\\/\\//, '').replace(/:.*/, '') : null
        }
      };
    }
  <\/script>
</body>
</html>`;
}
