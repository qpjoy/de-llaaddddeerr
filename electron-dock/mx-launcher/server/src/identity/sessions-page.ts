import type { BrowserSession } from './repository.js';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const date = (seconds: number) => new Date(seconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
function browser(agent: string) {
  const os = /iPhone|iPad|Android|Windows|Macintosh|Linux/.exec(agent)?.[0]?.replace('Macintosh', 'macOS');
  const name = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '浏览器';
  return os ? `${name} · ${os}` : agent === '历史浏览器会话' ? agent : name;
}
export function sessionsPage({ name, sessions = [], csrf = '', recent = false, links, done = false }: {
  name?: string; sessions?: BrowserSession[]; csrf?: string; recent?: boolean; links: Array<{ name: string; url: string; reauthenticate: string }>; done?: boolean;
}) {
  const field = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>网页登录会话 · MX</title><style>
  :root{color-scheme:light;--bg:#f1f5f9;--panel:#fff;--text:#182637;--muted:#627085;--line:#cfdae6;--accent:#087f75;--soft:#e5f1ef}
  @media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#191b23;--panel:#21232d;--text:#e2e2e2;--muted:#a7b3bf;--line:#3c4658;--accent:#2bf6d2;--soft:#153b37}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}main{max-width:900px;margin:48px auto;padding:0 24px}header{display:flex;justify-content:space-between;gap:16px;align-items:center}h1{font-size:26px;margin:10px 0}h2{font-size:16px;margin:0}p{color:var(--muted);margin:8px 0 20px}.brand{color:var(--accent);font-weight:700;letter-spacing:.12em}nav{display:flex;gap:14px;flex-wrap:wrap}a{color:var(--accent);text-underline-offset:3px}article,.notice,.all{border:1px solid var(--line);border-radius:8px;padding:18px 20px;background:var(--panel);margin:12px 0}article{display:flex;justify-content:space-between;align-items:center;gap:16px}.meta{color:var(--muted);font-size:12px;margin-top:6px}.badge{background:var(--soft);color:var(--accent);font-size:11px;border-radius:4px;padding:3px 6px;margin-left:8px}button{font:inherit;min-height:36px;padding:7px 13px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--text);cursor:pointer;white-space:nowrap}button:hover{border-color:var(--accent)}button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.45;cursor:not-allowed}.all{margin-top:24px}.all p{margin-bottom:12px}.notice{border-color:var(--accent)}@media(max-width:560px){main{margin:24px auto;padding:0 16px}header,article{align-items:flex-start;flex-direction:column}h1{font-size:22px}article form,article button{width:100%}}
  </style></head><body><main><header><span class="brand">MX / ACCOUNT</span><nav>${links.map(link => `<a href="${escape(link.url)}">返回 ${escape(link.name)}</a>`).join('')}</nav></header>
  <h1>网页登录会话</h1><p>${name ? `${escape(name)} · 查看和管理你的浏览器登录。` : '此处需要有效的 MX 登录，请返回应用重新登录后再打开。'}</p>
  ${done ? '<div class="notice" role="status">撤销已保存。Launcher 在下一次请求拒绝旧会话；Hub 写操作即时复核，已缓存的读取最多保留 30 秒。已显示的页面内容不会被远程擦除。</div>' : ''}
  ${name && !recent ? `<div class="notice">撤销会话需要最近 5 分钟内验证身份。${links.map(link => `<a href="${escape(link.reauthenticate)}">在 ${escape(link.name)} 重新验证</a>`).join(' · ')}，然后返回此页。</div>` : ''}
  ${sessions.map(session => `<article><div><h2>${escape(browser(session.agent))}${session.current ? '<span class="badge">当前浏览器</span>' : ''}</h2><div class="meta">最近登录 ${date(session.authTime)}<br>应用：${escape(session.apps.map(app => /hub/i.test(app) ? 'MX Insight Hub' : 'MX Launcher').filter((app, index, all) => all.indexOf(app) === index).join('、') || 'MX Auth')}<br>到期 ${date(Date.parse(session.expiresAt) / 1000)}</div></div><form method="post" action="/identity/sessions">${field}<input type="hidden" name="target" value="${escape(session.id)}"><button ${recent ? '' : 'disabled'} type="submit">退出此浏览器</button></form></article>`).join('')}
  ${name ? `<section class="all"><h2>退出全部网页登录</h2><p>退出 Auth、Launcher 和 Hub 的网页登录，包括当前浏览器。不会撤销 MX-H2I、Luopan 的客户端 Token、网络连接或 Hub API Key。</p><form method="post" action="/identity/sessions">${field}<input type="hidden" name="target" value="all"><button type="submit" ${recent ? '' : 'disabled'}>退出全部网页登录</button></form></section><p class="meta">最多显示最近 100 个有效浏览器会话。升级前的 Launcher 会话可能尚未关联到具体浏览器，可用“退出全部网页登录”撤销，重新登录后支持逐个管理。</p>` : ''}
  </main></body></html>`;
}
