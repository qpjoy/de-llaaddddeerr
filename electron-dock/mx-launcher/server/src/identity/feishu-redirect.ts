import { createHash } from 'node:crypto';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const script = "window.location.replace(document.getElementById('feishu-continue').href);";

/** Only accepts the authorization URL from the authenticated registration backend. */
export function feishuRedirectPage(authorizationUrl: string) {
  const url = new URL(authorizationUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid Feishu authorization URL');
  return {
    scriptHash: `'sha256-${createHash('sha256').update(script).digest('base64')}'`,
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>前往飞书 · MX 账号</title><style>
    :root{color-scheme:dark;--bg:#141417;--panel:#21232d;--line:#3c4658;--text:#e2e2e2;--muted:#a7b3bf;--accent:#2bf6d2;--on-accent:#052823}
    *{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--text);font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}
    main{width:100%;max-width:460px;padding:32px;border:1px solid var(--line);border-radius:16px;background:var(--panel)}.brand{display:flex;align-items:center;gap:12px;font-weight:600}.mark{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:var(--accent);color:var(--on-accent);font-weight:800}
    h1{font-size:24px;line-height:1.4;margin:24px 0 8px}p{color:var(--muted);margin:0 0 24px}a{display:block;padding:12px 16px;border-radius:9px;background:var(--accent);color:var(--on-accent);font-weight:600;text-align:center;text-decoration:none}a:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
    @media(prefers-color-scheme:light){:root{color-scheme:light;--bg:#f3f7fa;--panel:#f8fbfd;--line:#c7d8df;--text:#192b3a;--muted:#657584;--accent:#008d82;--on-accent:#fff}}
    @media(max-width:480px){body{padding:16px}main{padding:24px}}
    </style></head><body><main><div class="brand"><span class="mark" aria-hidden="true">MX</span><span>MX 统一账号</span></div><h1>正在前往飞书</h1><p>完成授权后将自动返回。</p><a id="feishu-continue" href="${escape(url.href)}" rel="noreferrer">继续前往飞书</a></main><script>${script}</script></body></html>`
  };
}
