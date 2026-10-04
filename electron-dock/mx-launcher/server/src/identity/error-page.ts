const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export interface RecoveryApplication { name: string; url: string; loginUrl: string }
export function identityErrorPage({ title = '登录请求已失效', description = '页面可能已过期，或登录状态发生了变化。请从应用重新开始登录。', application, applications, account }: {
  title?: string; description?: string; application?: RecoveryApplication; applications: RecoveryApplication[];
  account?: { name: string; login?: string };
}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · MX 账号</title><style>
  :root{color-scheme:dark;--bg:#141417;--panel:#21232d;--line:#3c4658;--text:#e2e2e2;--muted:#a7b3bf;--accent:#2bf6d2;--on-accent:#052823;--input:#252936}
  *{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
  main{width:100%;max-width:460px;padding:32px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}.brand{display:flex;align-items:center;gap:12px;font-weight:600}.mark{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:var(--accent);color:var(--on-accent);font-weight:800}
  .symbol{display:grid;place-items:center;width:52px;height:52px;margin:28px 0 18px;border:1px solid var(--line);border-radius:15px;background:var(--input);color:var(--muted)}svg{width:27px;height:27px}h1{font-size:25px;line-height:1.4;letter-spacing:-.02em;margin:0 0 12px}p{color:var(--muted);margin:0 0 24px;overflow-wrap:anywhere}.account{padding:12px 16px;background:var(--input);border:1px solid var(--line);border-radius:10px;margin-bottom:16px}.account strong,.account span{display:block}.account span{font-size:12px;color:var(--muted)}
  a{color:var(--accent);text-decoration:none}a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.action{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:46px;padding:10px 16px;border:1px solid var(--line);border-radius:9px;color:var(--text);margin-top:10px;overflow-wrap:anywhere}.action:hover{border-color:var(--accent)}.primary{justify-content:center;background:var(--accent);color:var(--on-accent);border-color:var(--accent);font-weight:600}.primary:hover{filter:brightness(.94)}.back{display:block;text-align:center;margin-top:16px;padding:6px}details{border-top:1px solid var(--line);margin-top:24px;padding-top:18px}summary{cursor:pointer;color:var(--muted);font-size:13px}footer{font-size:12px;color:var(--muted);margin-top:24px;text-align:center}
  @media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f3f7fa;--panel:#fff;--line:#d4dfe6;--text:#192b3a;--muted:#657584;--accent:#008d82;--on-accent:#fff;--input:#edf4f6}}
  @media(max-width:480px){body{padding:16px}main{padding:24px}h1{font-size:23px}}
  </style></head><body><main aria-labelledby="error-title"><div class="brand"><span class="mark" aria-hidden="true">MX</span><span>${escape(application?.name ?? 'MX 统一账号')}</span></div>
  <div class="symbol" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg></div>
  <h1 id="error-title">${escape(title)}</h1>
  ${account ? `<div class="account"><span>当前账号</span><strong>${escape(account.name)}</strong>${account.login ? `<span>@${escape(account.login)}</span>` : ''}</div>` : ''}
  <p>${escape(description)}</p>
  ${application ? `<a class="action primary" href="${escape(application.loginUrl)}">${application.loginUrl === application.url ? `返回 ${escape(application.name)}` : '重新登录'}</a>${application.loginUrl !== application.url ? `<a class="back" href="${escape(application.url)}">返回 ${escape(application.name)}</a>` : ''}` : ''}
  ${application ? '<details><summary>前往其他应用</summary>' : '<div aria-label="应用入口">'}${applications.filter(app => app.name !== application?.name).map(app => `<a class="action" href="${escape(app.url)}"><span>${escape(app.name)}</span><span aria-hidden="true">→</span></a>`).join('')}${application ? '</details>' : '</div>'}
  <footer>MX 账号 · 安全登录</footer></main></body></html>`;
}
