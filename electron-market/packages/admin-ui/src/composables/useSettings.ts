/**
 * Settings page composable — for now we only manage the marketplace server
 * URL, but this is where future host-level toggles (sync interval, telemetry
 * opt-in, …) would land too.
 *
 * Mode-aware: in server mode there is no "settings" concept (the server *is*
 * the upstream), so `available` is false and the page shows a banner.
 */
import { ref } from 'vue';
import { Notify } from 'quasar';

import { detectMode } from 'src/composables/useMode';

export type MarketServerSource =
  | 'explicit'
  | 'env'
  | 'meta'
  | 'default-dev'
  | 'default-prod'
  | 'offline';

export interface ResolvedMarketServer {
  url: string | null;
  source: MarketServerSource;
}

export interface MarketServerSettings {
  /** What the host is currently using (set at startup). */
  effective: ResolvedMarketServer;
  /** What would be used if the host restarted right now. */
  nextRestart: ResolvedMarketServer;
  /** Raw value from meta_kv. Empty string = no override. */
  userOverride: string | null;
  /** True iff the embedding app passed `serverBaseUrl` explicitly; the
   *  Settings page becomes read-only in that case. */
  explicitLocked: boolean;
  /** True iff `QPJOY_MARKET_SERVER` env var is set; meta override is shadowed. */
  envLocked: boolean;
  /** Built-in defaults — shown as quick-pick chips on the page.
   *  `prod` is null when the package author hasn't set a production URL —
   *  packaged builds default to offline in that case until the user picks one. */
  defaults: { dev: string; prod: string | null };
  /** Whether the host's Electron app is packaged (controls which default applies). */
  isPackaged: boolean;
}

export interface HostRuntimeStatus {
  app: {
    name: string;
    version: string;
    isPackaged: boolean;
    appPath: string;
  };
  market: {
    id: string;
    npm: string;
    currentVersion: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    installPath: string | null;
    homepage: string | null;
    canSelfUpgrade: boolean;
    upgradeMode: 'host-app';
    message: string;
  };
}

const MODE = detectMode();
const settings = ref<MarketServerSettings | null>(null);
const runtime = ref<HostRuntimeStatus | null>(null);
const loading = ref(false);
const saving = ref(false);

function toast(message: string, color: 'positive' | 'negative' | 'warning' = 'positive') {
  Notify.create({ message, color, position: 'top-right', timeout: 2800 });
}

export function useSettings() {
  /** Settings only make sense in local (host-embedded) mode. */
  const available = MODE === 'local';

  async function refresh(): Promise<void> {
    if (!available) return;
    loading.value = true;
    try {
      await Promise.all([refreshMarketServer(), refreshRuntime()]);
    } catch (err) {
      toast(`读取设置失败：${err instanceof Error ? err.message : String(err)}`, 'negative');
    } finally {
      loading.value = false;
    }
  }

  async function refreshMarketServer(): Promise<void> {
    const res = await fetch('/api/settings/market-server', {
      headers: { accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    settings.value = (await res.json()) as MarketServerSettings;
  }

  async function refreshRuntime(): Promise<void> {
    const res = await fetch('/api/host/runtime', {
      headers: { accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    runtime.value = (await res.json()) as HostRuntimeStatus;
  }

  /**
   * Write a new override (`url`) or clear it (`null` / empty). Returns true
   * on success. Tells the caller whether a restart is required to pick up
   * the change (almost always yes when the URL actually changed).
   */
  async function saveMarketServer(
    url: string | null
  ): Promise<{ ok: boolean; restartRequired: boolean }> {
    if (!available) return { ok: false, restartRequired: false };
    saving.value = true;
    try {
      const res = await fetch('/api/settings/market-server', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = (await res.json()) as
        | { ok: true; userOverride: string | null; nextRestart: ResolvedMarketServer; restartRequired: boolean }
        | { error: string };
      if (!res.ok || 'error' in data) {
        const msg = 'error' in data ? data.error : `${res.status} ${res.statusText}`;
        throw new Error(msg);
      }
      await refreshMarketServer();
      if (data.restartRequired) {
        toast('设置已保存，重启 app 后生效', 'warning');
      } else {
        toast('设置已保存');
      }
      return { ok: true, restartRequired: data.restartRequired };
    } catch (err) {
      toast(`保存失败：${err instanceof Error ? err.message : String(err)}`, 'negative');
      return { ok: false, restartRequired: false };
    } finally {
      saving.value = false;
    }
  }

  return {
    available,
    settings,
    runtime,
    loading,
    saving,
    refresh,
    refreshRuntime,
    saveMarketServer
  };
}

/**
 * Human-friendly label for the `source` enum. Used by the settings page
 * and any future "where is this URL coming from?" tooltips.
 */
export function describeMarketServerSource(source: MarketServerSource): string {
  switch (source) {
    case 'explicit':
      return '由宿主应用显式传入（不可在此修改）';
    case 'env':
      return '由环境变量 QPJOY_MARKET_SERVER 提供';
    case 'meta':
      return '用户在此页设置的运行时覆盖';
    case 'default-dev':
      return '内置默认值（开发：本地 docker）';
    case 'default-prod':
      return '内置默认值（生产 VPS）';
    case 'offline':
      return '离线模式（不与任何服务器通信）';
    default:
      return source;
  }
}
