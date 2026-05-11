import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { parse as parseUrl } from 'url';

import { createSessionToken, verifyPassword } from '../security';
import { DOMAIN_PRESETS, type DomainPresetId } from '../defaults';
import type { MihomoManager } from '../mihomo/MihomoManager';

type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;

const sessions = new Set<string>();

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, data: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  res.end(data);
}

function adminHtml(): string {
  const presets = Object.keys(DOMAIN_PRESETS)
    .map((id) => `<button data-preset="${id}">${id}</button>`)
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>QPJoy Tunnel Admin</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f4f6f8;color:#121417}
    header{height:64px;display:flex;align-items:center;justify-content:space-between;padding:0 24px;background:#fff;border-bottom:1px solid #dde1e6}
    main{max-width:1160px;margin:0 auto;padding:24px;display:grid;gap:18px}
    section{background:#fff;border:1px solid #dde1e6;border-radius:8px;padding:18px}
    input,select,button{height:36px;border:1px solid #c9d1d9;border-radius:6px;padding:0 10px;font-size:14px}
    button{background:#1264d8;color:#fff;border-color:#1264d8;cursor:pointer}
    button.secondary{background:#fff;color:#202833}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px}
    .muted{color:#6b7280}
    .card{border:1px solid #e3e7ec;border-radius:8px;padding:14px}
    pre{white-space:pre-wrap;max-height:280px;overflow:auto;background:#101418;color:#dbeafe;border-radius:8px;padding:14px}
    #login{max-width:360px;margin:12vh auto}
    #app{display:none}
  </style>
</head>
<body>
  <section id="login">
    <h2>QPJoy Tunnel</h2>
    <div class="row"><input id="user" placeholder="admin" value="admin"><input id="pass" type="password" placeholder="password" value="admin"><button id="loginBtn">登录</button></div>
  </section>
  <div id="app">
    <header><strong>QPJoy Tunnel Admin</strong><span id="status" class="muted"></span></header>
    <main>
      <section>
        <h3>模式</h3>
        <div class="row">
          <select id="mode">
            <option value="system-tun">虚拟网卡</option>
            <option value="app-global">全局模式</option>
            <option value="app-rule">App 模式</option>
          </select>
          <button id="saveMode">切换</button>
          <button id="installTun" class="secondary">安装 TUN</button>
          <button id="uninstallTun" class="secondary">卸载 TUN</button>
          <button id="start">启动</button>
          <button id="stop" class="secondary">停止</button>
        </div>
      </section>
      <section>
        <h3>Mihomo Core</h3>
        <div class="row">
          <input id="corePath" placeholder="/usr/local/bin/mihomo" style="flex:1;min-width:320px">
          <button id="saveCorePath">保存路径</button>
        </div>
      </section>
      <section>
        <h3>本地端口</h3>
        <div class="row">
          <input id="mixedPort" placeholder="23458">
          <input id="dnsPort" placeholder="23459">
          <button id="savePorts">保存端口</button>
        </div>
      </section>
      <section>
        <h3>订阅</h3>
        <div class="row">
          <input id="subName" placeholder="名称">
          <input id="subUrl" placeholder="订阅文件链接" style="flex:1;min-width:320px">
          <input id="subUser" placeholder="用户">
          <input id="subPass" placeholder="密码" type="password">
          <button id="addSub">新建</button>
          <button id="updateSub" class="secondary">更新当前</button>
        </div>
        <div id="subs" class="grid"></div>
      </section>
      <section>
        <h3>白名单 / 黑名单</h3>
        <div class="row">
          ${presets}
          <input id="ruleDomain" placeholder="example.com">
          <select id="ruleKind"><option value="allow">白名单</option><option value="block">黑名单</option></select>
          <button id="addRule">添加</button>
        </div>
        <div id="rules" class="grid"></div>
      </section>
      <section>
        <h3>日志</h3>
        <pre id="events"></pre>
      </section>
    </main>
  </div>
  <script>
    let token = '';
    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: { 'content-type': 'application/json', authorization: token ? 'Bearer ' + token : '', ...(options.headers || {}) }
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
    async function refresh() {
      const data = await api('/api/snapshot');
      document.querySelector('#status').textContent = data.status.running ? '运行中' : '已停止';
      document.querySelector('#mode').value = data.status.mode;
      document.querySelector('#corePath').value = data.status.corePath || '';
      document.querySelector('#mixedPort').value = data.status.ports.mixed;
      document.querySelector('#dnsPort').value = data.status.ports.dns;
      document.querySelector('#subs').innerHTML = data.subscriptions.map(s => '<div class="card"><strong>'+s.name+'</strong><p class="muted">'+s.url+'</p><p>'+(s.active?'当前':'')+' '+(s.lastUpdatedAt||'未更新')+'</p><button data-active="'+s.id+'">启用</button> <button class="secondary" data-refresh="'+s.id+'">刷新</button> <button class="secondary" data-sub-remove="'+s.id+'">删除</button></div>').join('');
      document.querySelector('#rules').innerHTML = data.rules.map(r => '<div class="card"><strong>'+r.kind+'</strong> '+r.domain+'<p class="muted">'+r.source+'</p><button class="secondary" data-rule-remove="'+r.id+'">删除</button></div>').join('');
      document.querySelector('#events').textContent = data.events.map(e => '['+e.level+'] '+e.createdAt+' '+e.message).join('\\n');
    }
    document.querySelector('#loginBtn').onclick = async () => {
      const result = await api('/api/login', { method:'POST', body: JSON.stringify({ username:user.value, password:pass.value }) });
      token = result.token;
      login.style.display = 'none';
      app.style.display = 'block';
      refresh();
    };
    document.querySelector('#saveMode').onclick = async () => { await api('/api/mode', { method:'POST', body: JSON.stringify({ mode: mode.value }) }); refresh(); };
    document.querySelector('#saveCorePath').onclick = async () => { await api('/api/core/path', { method:'POST', body: JSON.stringify({ corePath: corePath.value }) }); refresh(); };
    document.querySelector('#savePorts').onclick = async () => { await api('/api/ports', { method:'POST', body: JSON.stringify({ mixed: Number(mixedPort.value), dns: Number(dnsPort.value) }) }); refresh(); };
    document.querySelector('#installTun').onclick = async () => { await api('/api/tun/install', { method:'POST' }); refresh(); };
    document.querySelector('#uninstallTun').onclick = async () => { await api('/api/tun/uninstall', { method:'POST' }); refresh(); };
    document.querySelector('#start').onclick = async () => { await api('/api/core/start', { method:'POST' }); refresh(); };
    document.querySelector('#stop').onclick = async () => { await api('/api/core/stop', { method:'POST' }); refresh(); };
    document.querySelector('#updateSub').onclick = async () => { await api('/api/subscriptions/active/update', { method:'POST' }); refresh(); };
    document.querySelector('#addSub').onclick = async () => { await api('/api/subscriptions', { method:'POST', body: JSON.stringify({ name: subName.value, url: subUrl.value, username: subUser.value, password: subPass.value }) }); refresh(); };
    document.querySelector('#addRule').onclick = async () => { await api('/api/rules', { method:'POST', body: JSON.stringify({ kind: ruleKind.value, domain: ruleDomain.value }) }); refresh(); };
    document.body.onclick = async (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.dataset.preset) await api('/api/presets/'+target.dataset.preset, { method:'POST' });
      if (target.dataset.active) await api('/api/subscriptions/'+target.dataset.active+'/active', { method:'POST' });
      if (target.dataset.refresh) await api('/api/subscriptions/'+target.dataset.refresh+'/update', { method:'POST' });
      if (target.dataset.subRemove) await api('/api/subscriptions/'+target.dataset.subRemove, { method:'DELETE' });
      if (target.dataset.ruleRemove) await api('/api/rules/'+target.dataset.ruleRemove, { method:'DELETE' });
      if (target.dataset.preset || target.dataset.active || target.dataset.refresh || target.dataset.subRemove || target.dataset.ruleRemove) refresh();
    };
  </script>
</body>
</html>`;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    return false;
  }
  return sessions.has(header.slice('Bearer '.length));
}

export class AdminServer {
  private server: Server | null = null;

  constructor(private readonly manager: MihomoManager) {}

  start(): void {
    if (this.server) {
      return;
    }

    const settings = this.manager.db.getSettings();
    this.server = createServer(async (req, res) => {
      try {
        await this.handle(req, res);
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
    this.server.listen(settings.ports.admin, '127.0.0.1');
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    const pathname = parseUrl(req.url ?? '/', true).pathname ?? '/';

    if (method === 'GET' && pathname === '/') {
      sendText(res, 200, adminHtml(), 'text/html; charset=utf-8');
      return;
    }

    const body = await readBody(req);

    if (method === 'POST' && pathname === '/api/login') {
      const { username, password } = body as { username?: string; password?: string };
      const settings = this.manager.db.getSettings();
      if (username === settings.adminUser && password && verifyPassword(password, settings.adminPasswordHash)) {
        const token = createSessionToken();
        sessions.add(token);
        sendJson(res, 200, { token });
        return;
      }
      sendJson(res, 401, { error: 'invalid credentials' });
      return;
    }

    if (!isAuthed(req)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const route = this.route(method, pathname);
    if (!route) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    await route(req, res, body);
  }

  private route(method: string, pathname: string): RouteHandler | null {
    if (method === 'GET' && pathname === '/api/snapshot') {
      return async (_req, res) => sendJson(res, 200, await this.manager.snapshot());
    }
    if (method === 'POST' && pathname === '/api/mode') {
      return async (_req, res, body) => {
        const { mode } = body as { mode: never };
        this.manager.setMode(mode);
        await this.manager.applyRuntimeConfigChange();
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/ports') {
      return async (_req, res, body) => {
        const { mixed, dns } = body as { mixed: number; dns: number };
        await this.manager.setLocalPorts({ mixed, dns });
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/tun/install') {
      return async (_req, res) => {
        this.manager.installTunFeature();
        await this.manager.applyRuntimeConfigChange();
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/tun/uninstall') {
      return async (_req, res) => {
        this.manager.uninstallTunFeature();
        await this.manager.applyRuntimeConfigChange();
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/core/start') {
      return async (_req, res) => {
        await this.manager.start();
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/core/stop') {
      return async (_req, res) => {
        await this.manager.stop();
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/core/path') {
      return (_req, res, body) => {
        const { corePath } = body as { corePath: string };
        this.manager.setCorePath(corePath);
        sendJson(res, 200, this.manager.status());
      };
    }
    if (method === 'POST' && pathname === '/api/subscriptions') {
      return async (_req, res, body) => {
        sendJson(res, 200, await this.manager.createSubscription(body as never));
      };
    }
    if (method === 'POST' && pathname === '/api/subscriptions/active/update') {
      return async (_req, res) => {
        const subscription = await this.manager.updateActiveSubscription();
        await this.manager.applyRuntimeConfigChange();
        sendJson(res, 200, subscription);
      };
    }

    const activeMatch = pathname.match(/^\/api\/subscriptions\/(\d+)\/active$/);
    if (method === 'POST' && activeMatch) {
      return async (_req, res) => {
        const subscription = this.manager.setActiveSubscription(Number(activeMatch[1]));
        await this.manager.applyRuntimeConfigChange();
        sendJson(res, 200, subscription);
      };
    }
    const updateMatch = pathname.match(/^\/api\/subscriptions\/(\d+)\/update$/);
    if (method === 'POST' && updateMatch) {
      return async (_req, res) => {
        const subscription = await this.manager.updateSubscription(Number(updateMatch[1]));
        if (subscription.active) {
          await this.manager.applyRuntimeConfigChange();
        }
        sendJson(res, 200, subscription);
      };
    }
    const deleteSubscriptionMatch = pathname.match(/^\/api\/subscriptions\/(\d+)$/);
    if (method === 'DELETE' && deleteSubscriptionMatch) {
      return async (_req, res) => {
        this.manager.deleteSubscription(Number(deleteSubscriptionMatch[1]));
        await this.manager.applyRuntimeConfigChange();
        sendJson(res, 200, { ok: true });
      };
    }
    if (method === 'POST' && pathname === '/api/rules') {
      return async (_req, res, body) => {
        const { kind, domain } = body as { kind: 'allow' | 'block'; domain: string };
        const rule = this.manager.addDomainRule(kind, domain);
        await this.manager.applyRuntimeConfigChange();
        sendJson(res, 200, rule);
      };
    }
    const ruleDeleteMatch = pathname.match(/^\/api\/rules\/(\d+)$/);
    if (method === 'DELETE' && ruleDeleteMatch) {
      return async (_req, res) => {
        this.manager.removeDomainRule(Number(ruleDeleteMatch[1]));
        await this.manager.applyRuntimeConfigChange();
        sendJson(res, 200, { ok: true });
      };
    }
    const presetMatch = pathname.match(/^\/api\/presets\/([a-z]+)$/);
    if (method === 'POST' && presetMatch) {
      return async (_req, res) => {
        const rules = this.manager.addPreset(presetMatch[1] as DomainPresetId);
        await this.manager.applyRuntimeConfigChange();
        sendJson(res, 200, rules);
      };
    }

    return null;
  }
}
