/**
 * Embed mode glue.
 *
 * When the admin SPA is iframed by a host app (`?embed=1` in the URL), it
 * talks to the parent over `postMessage`. The protocol is intentionally
 * tiny and stable; see `electron-market/docs/EMBED_PROTOCOL.md`.
 *
 *  parent → SPA              SPA → parent
 *  ───────────────           ─────────────
 *  set-theme                 ready
 *  set-locale                request-close
 *  navigate                  route-change
 *                            notify
 */
import { computed, onBeforeUnmount, onMounted, reactive, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Notify, setCssVar } from 'quasar';

interface EmbedConfig {
  enabled: boolean;
  /** Where the host wants us to go back to when the user clicks ←. */
  returnUrl: string | null;
  /** Initial theme passed via URL. */
  theme: 'light' | 'dark';
  /** Optional primary color override. */
  primary: string | null;
  /** Initial locale. */
  locale: string | null;
}

interface InboundMessage {
  type: string;
  payload?: Record<string, unknown>;
}

const state = reactive<EmbedConfig>({
  enabled: false,
  returnUrl: null,
  theme: 'light',
  primary: null,
  locale: null
});

let inited = false;

function send(type: string, payload?: Record<string, unknown>): void {
  if (!state.enabled || typeof window === 'undefined' || window.parent === window) return;
  window.parent.postMessage({ source: 'qpjoy-plugin-market', type, payload }, '*');
}

function applyTheme(theme: 'light' | 'dark', primary?: string | null): void {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  document.body.classList.toggle('body--dark', theme === 'dark');
  if (primary) {
    state.primary = primary;
    try {
      setCssVar('primary', primary);
    } catch {
      /* ignore — happens during very early boot */
    }
  }
}

export function useEmbed() {
  const route = useRoute();
  const router = useRouter();

  // Parse `?embed=1&theme=dark&primary=%23ff6600&returnUrl=...` once.
  function parseQuery(): void {
    if (inited) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('embed') !== '1') return;
    state.enabled = true;
    state.returnUrl = params.get('returnUrl');
    const theme = params.get('theme');
    if (theme === 'dark' || theme === 'light') {
      applyTheme(theme, params.get('primary'));
    } else if (params.get('primary')) {
      applyTheme(state.theme, params.get('primary'));
    }
    state.locale = params.get('locale');
    inited = true;
  }

  function onMessage(ev: MessageEvent<InboundMessage>): void {
    if (!ev.data || typeof ev.data !== 'object') return;
    const { type, payload } = ev.data;
    switch (type) {
      case 'set-theme':
        applyTheme(
          (payload?.mode as 'light' | 'dark') ?? state.theme,
          (payload?.primary as string | undefined) ?? null
        );
        break;
      case 'set-locale':
        state.locale = (payload?.locale as string) ?? null;
        // i18n hook point — we don't have a translator yet, so just store.
        break;
      case 'navigate':
        if (typeof payload?.path === 'string') {
          router.push(payload.path).catch(() => undefined);
        }
        break;
      case 'notify':
        Notify.create({
          message: String(payload?.message ?? ''),
          color: (payload?.level as string) === 'error' ? 'negative' : 'positive',
          position: 'top-right'
        });
        break;
    }
  }

  onMounted(() => {
    parseQuery();
    if (!state.enabled) return;
    window.addEventListener('message', onMessage);
    send('ready', { version: '0.1.0', route: route.fullPath });
  });

  onBeforeUnmount(() => {
    window.removeEventListener('message', onMessage);
  });

  // Echo route changes to the parent so it can render breadcrumbs / tabs.
  watch(
    () => route.fullPath,
    (path) => send('route-change', { path }),
    { flush: 'post' }
  );

  function requestClose(): void {
    send('request-close', { returnUrl: state.returnUrl });
  }

  function notifyParent(level: 'info' | 'warn' | 'error', message: string): void {
    send('notify', { level, message });
  }

  return {
    embed: computed(() => state.enabled),
    theme: computed(() => state.theme),
    primary: computed(() => state.primary),
    locale: computed(() => state.locale),
    returnUrl: computed(() => state.returnUrl),
    requestClose,
    notifyParent
  };
}
