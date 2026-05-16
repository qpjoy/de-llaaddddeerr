# Embedding the plugin market in another app

The QPJoy plugin market is just a same-origin HTTP server on `127.0.0.1:23455`.
Any local UI — Quasar, React, vanilla, native — can host it by dropping in
an `<iframe>` and talking to it over `postMessage`.

## 1. Add the iframe

```html
<iframe
  id="plugin-market"
  src="http://127.0.0.1:23455/?embed=1&theme=dark&returnUrl=/dashboard"
  style="width: 100%; height: 100%; border: 0;"
></iframe>
```

URL parameters the iframe reads on first load:

| Param | Required | Default | Notes |
| --- | --- | --- | --- |
| `embed=1` | yes | — | Switches the SPA into embed mode (hides drawer, shows top bar with ←). |
| `theme` | no | `light` | `light` or `dark`. |
| `primary` | no | `#1578ff` | URL-encoded color (`%23ff6600`). |
| `locale` | no | `zh-CN` | Reserved; no i18n bundle yet. |
| `returnUrl` | no | — | The market sends it back in `request-close`. Useful for routing decisions in the host. |

You can also navigate to a deep link directly: `…/?embed=1#/marketplace`,
`…/?embed=1#/plugin/qpjoy.electron-tunnel`, etc.

## 2. The postMessage protocol

All messages carry `{ source: 'qpjoy-plugin-market', type, payload }`. The
host should filter on `source` to avoid cross-talk with other iframes.

### Parent → market

| `type` | `payload` | Effect |
| --- | --- | --- |
| `set-theme` | `{ mode: 'light' \| 'dark', primary?: string }` | Re-themes the SPA on the fly. |
| `set-locale` | `{ locale: 'zh-CN' \| 'en-US' }` | Stored; will become active once i18n lands. |
| `navigate` | `{ path: '/marketplace' }` | Programmatic deep link from the host. |

### Market → parent

| `type` | `payload` | When |
| --- | --- | --- |
| `ready` | `{ version, route }` | SPA mounted; safe to send commands. |
| `route-change` | `{ path }` | Every router navigation inside the SPA. Use it to render breadcrumbs / sync tabs. |
| `request-close` | `{ returnUrl }` | User clicked the ← button. Host should hide the iframe or route to `returnUrl`. |
| `notify` | `{ level, message }` | Optional bridge so the host can render its own toast. |

## 3. Minimal host shim

```ts
// 40-line drop-in. Plug your own routing logic in handlers.
const frame = document.getElementById('plugin-market') as HTMLIFrameElement;
const targetOrigin = '*'; // tighten to 'http://127.0.0.1:23455' in prod.

function send(type: string, payload?: Record<string, unknown>): void {
  frame.contentWindow?.postMessage({ source: 'qpjoy-plugin-market', type, payload }, targetOrigin);
}

window.addEventListener('message', (ev) => {
  if (ev.data?.source !== 'qpjoy-plugin-market') return;
  switch (ev.data.type) {
    case 'ready':
      send('set-theme', { mode: 'dark', primary: '#1578ff' });
      break;
    case 'route-change':
      // syncBreadcrumb(ev.data.payload.path);
      break;
    case 'request-close':
      // hideMarketTab() or router.push(ev.data.payload.returnUrl);
      break;
    case 'notify':
      // showHostToast(ev.data.payload);
      break;
  }
});

// User clicked a tab in your app:
function openMarket(): void {
  frame.src = 'http://127.0.0.1:23455/?embed=1&theme=dark&returnUrl=/dashboard';
}
function jumpToMarketplaceTab(): void {
  send('navigate', { path: '/marketplace' });
}
```

## 4. Nested plugin admin panels

Inside the market, the route `/plugin/:id` mounts an inner iframe pointing
at the plugin's own `contributes.adminPanel.url`. The host never has to
care about this — the market handles the second hop. The user sees:

```
host app
  └─ iframe → market
        └─ iframe → tunnel's 23456 admin
```

`request-close` from a nested level pops back to `/` inside the market
first; only the outer "back" closes the embed.

## 5. Security notes

- The market and the plugin admin servers all bind to `127.0.0.1` only.
- Bearer-token auth on these endpoints is on the TODO list; until then,
  treat them as trusted on-device traffic only.
- When you tighten `targetOrigin` away from `'*'`, also tighten the SPA's
  side by checking `event.origin` in `useEmbed.ts`.
