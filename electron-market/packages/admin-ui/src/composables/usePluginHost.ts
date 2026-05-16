import { ref } from 'vue';
import { Notify } from 'quasar';

import type {
  InstalledPluginRecord,
  MarketplaceIndex,
  PluginLogEntry,
  Permission
} from 'src/types/api';
import { detectMode, getServerToken } from 'src/composables/useMode';

const MODE = detectMode();
// Local mode talks to the host on :23455 (relay endpoints under `/api/*`).
// Server mode talks to electron-server (`:8080`) directly at `/api/v1/*`.
const API_BASE = '';

export interface MarketplaceState extends MarketplaceIndex {
  /** Where the data came from on the last fetch. */
  source: 'remote' | 'cache' | 'seed';
  /** ISO timestamp of the last successful remote fetch, if any. */
  remoteFetchedAt: string | null;
  /** Last remote error, if any. */
  remoteError: string | null;
}

export interface SyncStatus {
  configured: boolean;
  baseUrl: string | null;
  lastRelease: string | null;
  lastFetchedAt: string | null;
  failureCount: number;
  lastError: string | null;
  knownReleaseFromMeta: string | null;
}

export interface SyncResult {
  outcome: 'ok' | 'skipped' | 'failed';
  startedAt: string;
  finishedAt: string;
  newRelease: string | null;
  entriesSynced: number;
  migrationsApplied: number[];
  error: string | null;
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Shared reactive state                                                      */
/* ────────────────────────────────────────────────────────────────────────── */

const installed = ref<InstalledPluginRecord[]>([]);
const marketplace = ref<MarketplaceState | null>(null);
const sync = ref<SyncStatus | null>(null);
const busy = ref(false);
const syncing = ref(false);
const seedIds = ref<string[]>([]);

/* ────────────────────────────────────────────────────────────────────────── */
/* Fetch helpers                                                              */
/* ────────────────────────────────────────────────────────────────────────── */

async function get<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  const tok = getServerToken();
  if (tok) headers.authorization = `Bearer ${tok}`;
  const res = await fetch(API_BASE + path, { headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : '{}'
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} ${text}`);
  }
  return (await res.json()) as T;
}

function toast(message: string, color: 'positive' | 'negative' | 'warning' = 'positive') {
  Notify.create({ message, color, position: 'top-right', timeout: 2400 });
}

/**
 * Tiny semver comparator. Returns -1 / 0 / +1. Strips pre-release tags;
 * for ordered comparison of `0.1.3` vs `0.1.4` etc. that's enough.
 */
function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((p) => Number(p) || 0);
  const aa = parse(a);
  const bb = parse(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const d = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function reportError(action: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  toast(`${action} 失败：${msg}`, 'negative');
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Public composable                                                          */
/* ────────────────────────────────────────────────────────────────────────── */

export function usePluginHost() {
  async function refreshInstalled() {
    // Server-mode panel never has "installed" — that's a host-local concept.
    if (MODE === 'server') {
      installed.value = [];
      return;
    }
    installed.value = await get<InstalledPluginRecord[]>('/api/plugins');
  }

  async function refreshMarketplace() {
    try {
      if (MODE === 'server') {
        // Talk directly to electron-server's `/api/v1/marketplace/index.json`
        // and adapt the shape: the server-side DTO uses `latestVersion` whereas
        // the local route uses `latest`. We also synthesise `source: 'remote'`
        // so the chip rendering keeps working.
        type ServerEntry = {
          id: string;
          npm: string;
          name: string;
          description: string | null;
          latestVersion: string;
          manifestUrl: string | null;
          tarballUrl: string | null;
          homepage: string | null;
          verified: boolean;
          bootstrap: boolean;
          visibility: 'public' | 'free' | 'paid' | 'private';
        };
        type ServerIndex = { generatedAt: string; release: string; entries: ServerEntry[] };
        const raw = await get<ServerIndex>('/api/v1/marketplace/index.json');
        marketplace.value = {
          generatedAt: raw.generatedAt,
          entries: raw.entries.map((e) => ({
            id: e.id,
            npm: e.npm,
            name: e.name,
            description: e.description ?? '',
            versions: [e.latestVersion],
            latest: e.latestVersion,
            manifestUrl: e.manifestUrl ?? '',
            tarballUrl: e.tarballUrl ?? undefined,
            homepage: e.homepage ?? undefined,
            verified: e.verified,
            bootstrap: e.bootstrap,
            visibility: e.visibility
          })),
          source: 'remote',
          remoteFetchedAt: new Date().toISOString(),
          remoteError: null
        };
        return;
      }
      marketplace.value = await get<MarketplaceState>('/api/marketplace');
    } catch (err) {
      reportError('拉取市场索引', err);
      marketplace.value = {
        generatedAt: '',
        entries: [],
        source: 'seed',
        remoteFetchedAt: null,
        remoteError: err instanceof Error ? err.message : String(err)
      };
    }
  }

  function findInstalled(id: string): InstalledPluginRecord | undefined {
    return installed.value.find((p) => p.id === id);
  }

  async function refreshSync() {
    // Sync is a host concept — the server itself IS the upstream, so it
    // has no sync state to report.
    if (MODE === 'server') {
      sync.value = null;
      return;
    }
    try {
      sync.value = await get<SyncStatus>('/api/sync');
    } catch {
      sync.value = null;
    }
  }

  async function syncNow(): Promise<SyncResult | null> {
    if (syncing.value) return null;
    syncing.value = true;
    try {
      const result = await post<SyncResult>('/api/sync');
      const verbal =
        result.outcome === 'ok'
          ? `已同步 ${result.entriesSynced} 个条目${result.newRelease ? `（${result.newRelease}）` : ''}`
          : result.outcome === 'skipped'
          ? '已有同步在进行中'
          : `同步失败：${result.error}`;
      toast(verbal, result.outcome === 'failed' ? 'negative' : 'positive');
      await Promise.all([refreshMarketplace(), refreshInstalled(), refreshSync()]);
      return result;
    } catch (err) {
      reportError('手动同步', err);
      return null;
    } finally {
      syncing.value = false;
    }
  }

  async function refreshSeedConfig() {
    // Server mode has no host-local seeds.
    if (MODE === 'server') {
      seedIds.value = [];
      return;
    }
    try {
      const out = await get<{ seedIds: string[] }>('/api/seed-config');
      seedIds.value = out.seedIds ?? [];
    } catch {
      seedIds.value = [];
    }
  }

  async function refreshAll() {
    // Refresh installed FIRST so the marketplace's "is installed?" check
    // has accurate state on first paint. Then in parallel with the rest.
    await refreshInstalled();
    await Promise.all([refreshMarketplace(), refreshSync(), refreshSeedConfig()]);
  }

  function isSeedable(id: string): boolean {
    return seedIds.value.includes(id);
  }

  async function reseed(id: string): Promise<boolean> {
    busy.value = true;
    lastInstallError.value = null;
    try {
      await post<{ ok: boolean }>(`/api/plugins/${encodeURIComponent(id)}/reseed`);
      toast(`已重新预装 ${id}`);
      await refreshInstalled();
      return true;
    } catch (err) {
      lastInstallError.value = err instanceof Error ? err.message : String(err);
      reportError('重新预装', err);
      return false;
    } finally {
      busy.value = false;
    }
  }

  /** Upgrade an installed plugin. Defaults to marketplace latest. */
  async function upgrade(id: string, version?: string): Promise<boolean> {
    busy.value = true;
    lastInstallError.value = null;
    try {
      await post<{ ok: boolean }>(
        `/api/plugins/${encodeURIComponent(id)}/upgrade`,
        version ? { version } : undefined
      );
      toast(`${id} 已升级${version ? ` 到 ${version}` : ''}`);
      await refreshInstalled();
      return true;
    } catch (err) {
      lastInstallError.value = err instanceof Error ? err.message : String(err);
      reportError('升级', err);
      return false;
    } finally {
      busy.value = false;
    }
  }

  /**
   * Call a method that a plugin exposed via `ctx.expose(...)`. Returns the
   * resolved value or null on error (errors are toast-reported, never thrown,
   * so the SPA doesn't have to wrap every call in a try). Server mode has no
   * plugin runtime, so calls there short-circuit and return null.
   */
  async function rpc<T = unknown>(id: string, method: string, args: unknown[] = []): Promise<T | null> {
    if (MODE === 'server') return null;
    try {
      const out = await post<{ ok: true; result: T } | { error: string }>(
        `/api/plugins/${encodeURIComponent(id)}/rpc`,
        { method, args }
      );
      if ('error' in out) throw new Error(out.error);
      return out.result ?? null;
    } catch (err) {
      reportError(`${id}.${method}`, err);
      return null;
    }
  }

  /**
   * Open a URL in the user's system default browser via the host's
   * `shell.openExternal`. In local mode this bypasses Electron's window
   * machinery entirely — important for plugin homepage links where the
   * host's session may have a proxy / tunnel configured that the marketing
   * site shouldn't be routed through.
   *
   * In server mode (SPA loaded via `/admin/` from the marketplace server)
   * there's no Electron host to call into; we fall back to `window.open`,
   * which the user's actual browser handles normally.
   */
  async function openExternal(url: string): Promise<void> {
    if (!url) return;
    if (MODE === 'server') {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    try {
      await post('/api/open-external', { url });
    } catch (err) {
      reportError('打开主页', err);
    }
  }

  /** True iff the entry's latest version is strictly newer than the installed one. */
  function hasUpgrade(id: string, latestVersion: string | undefined): boolean {
    if (!latestVersion) return false;
    const inst = installed.value.find((p) => p.id === id);
    if (!inst) return false;
    return compareSemver(latestVersion, inst.version) > 0;
  }

  /** Last install attempt's error (for the longer-lived banner). */
  const lastInstallError = ref<string | null>(null);

  async function install(id: string, version?: string) {
    busy.value = true;
    lastInstallError.value = null;
    try {
      await post('/api/plugins/install', { id, version });
      toast(`已下载 ${id}@${version ?? 'latest'}，请审核权限并激活`);
      await refreshInstalled();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lastInstallError.value = msg;
      reportError('安装', err);
    } finally {
      busy.value = false;
    }
  }

  function clearInstallError(): void {
    lastInstallError.value = null;
  }

  async function installLocal(payload: {
    id: string;
    npm: string;
    source: { type: 'tarball' | 'local-dir'; path: string };
  }) {
    busy.value = true;
    try {
      await post('/api/plugins/install-local', payload);
      toast('本地安装完成');
      await refreshInstalled();
    } catch (err) {
      reportError('本地安装', err);
    } finally {
      busy.value = false;
    }
  }

  async function grant(id: string, permissions: Permission[]) {
    await post(`/api/plugins/${encodeURIComponent(id)}/grant`, { permissions });
    toast('权限已授予');
    await refreshInstalled();
  }

  async function activate(id: string) {
    try {
      await post(`/api/plugins/${encodeURIComponent(id)}/activate`);
      toast(`${id} 已激活`);
    } catch (err) {
      reportError('激活', err);
    }
    await refreshInstalled();
  }

  async function deactivate(id: string) {
    await post(`/api/plugins/${encodeURIComponent(id)}/deactivate`);
    toast(`${id} 已停用`);
    await refreshInstalled();
  }

  async function uninstall(id: string) {
    await post(`/api/plugins/${encodeURIComponent(id)}/uninstall`);
    toast(`${id} 已卸载`);
    await refreshInstalled();
  }

  async function logs(id: string): Promise<PluginLogEntry[]> {
    return get<PluginLogEntry[]>(`/api/plugins/${encodeURIComponent(id)}/logs`);
  }

  return {
    mode: MODE,
    installed,
    marketplace,
    sync,
    busy,
    syncing,
    seedIds,
    lastInstallError,
    refreshAll,
    refreshInstalled,
    refreshMarketplace,
    refreshSync,
    refreshSeedConfig,
    findInstalled,
    isSeedable,
    install,
    installLocal,
    grant,
    activate,
    deactivate,
    uninstall,
    reseed,
    upgrade,
    hasUpgrade,
    logs,
    syncNow,
    clearInstallError,
    rpc,
    openExternal
  };
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Permission descriptions — keyed by category prefix.                        */
/* ────────────────────────────────────────────────────────────────────────── */

export interface PermissionDescription {
  label: string;
  danger: boolean;
}

export function describePermission(p: Permission): PermissionDescription {
  if (p === 'fs:userData') return { label: '读写自己的数据沙箱（userData/<id>）', danger: false };
  if (p === 'fs:any') return { label: '读写任意文件系统路径', danger: true };
  if (p.startsWith('net:listen:')) {
    const rest = p.slice('net:listen:'.length);
    return { label: `监听本地端口 ${rest}`, danger: false };
  }
  if (p === 'net:fetch:*') return { label: '访问任意外部主机', danger: true };
  if (p.startsWith('net:fetch:')) {
    return { label: `访问外部主机 ${p.slice('net:fetch:'.length)}`, danger: false };
  }
  if (p === 'system:proxy') return { label: '修改系统 / Electron 会话代理', danger: true };
  if (p === 'system:exec:*') return { label: '执行任意外部程序', danger: true };
  if (p.startsWith('system:exec:')) {
    return { label: `执行外部程序 ${p.slice('system:exec:'.length)}`, danger: true };
  }
  if (p === 'ipc:cross') return { label: '与其他插件互相调用', danger: false };
  if (p.startsWith('ipc:')) return { label: `注册 IPC 通道 ${p.slice('ipc:'.length)}`, danger: false };
  if (p === 'ui:adminPanel') return { label: '在市场面板注册入口卡片', danger: false };
  return { label: p, danger: false };
}
