<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">应用市场</div>
      <q-tabs
        v-model="section"
        dense
        class="text-primary"
        active-color="primary"
        indicator-color="primary"
      >
        <q-tab name="plugin" icon="extension" label="插件" />
        <q-tab name="game" icon="sports_esports" label="游戏" />
      </q-tabs>
      <q-chip
        v-if="sourceLabel"
        :icon="sourceIcon"
        :color="sourceColor"
        text-color="white"
        dense
      >
        {{ sourceLabel }}
      </q-chip>
      <q-space />
      <q-input v-model="query" dense outlined placeholder="搜索" style="min-width: 240px">
        <template #prepend><q-icon name="search" /></template>
      </q-input>
      <q-btn flat round icon="refresh" @click="host.refreshMarketplace()">
        <q-tooltip>重新拉取</q-tooltip>
      </q-btn>
      <q-btn
        v-if="host.mode === 'local' && host.sync.value?.configured"
        color="primary"
        icon="cloud_sync"
        :label="host.syncing.value ? '同步中…' : '从服务器同步'"
        :loading="host.syncing.value"
        :disable="host.syncing.value"
        @click="host.syncNow()"
      />
      <!-- Server-mode admin action: trigger an immediate npm scan inside the
           market container. Same mutex as the scheduler — if a run is in
           flight, returns its report. -->
      <q-btn
        v-if="host.mode === 'server' && auth.state.value.user?.role === 'admin'"
        color="primary"
        icon="cloud_sync"
        :label="serverSyncing ? '同步中…' : '立即同步 npm'"
        :loading="serverSyncing"
        :disable="serverSyncing"
        @click="triggerServerSync"
      />
    </div>

    <q-banner
      v-if="legacyOfflineBannerVisible"
      class="bg-warning text-dark q-mb-md"
      dense
    >
      <template #avatar><q-icon name="cloud_off" /></template>
      远端无法访问，正在显示本地缓存 / 内置目录。<br />
      <span class="text-caption">{{ host.marketplace.value?.remoteError }}</span>
    </q-banner>

    <q-banner
      v-if="host.lastInstallError.value"
      class="bg-negative text-white q-mb-md"
      dense
    >
      <template #avatar><q-icon name="error" /></template>
      <div class="text-weight-bold">安装失败</div>
      <div class="text-caption" style="word-break: break-all">{{ host.lastInstallError.value }}</div>
      <div v-if="installErrorHint" class="text-caption q-mt-xs">
        提示：{{ installErrorHint }}
      </div>
      <template #action>
        <q-btn flat dense color="white" icon="close" @click="host.clearInstallError()" />
      </template>
    </q-banner>

    <q-card v-if="host.mode === 'local' && host.sync.value" flat bordered class="q-mb-md">
      <q-card-section class="row items-center q-gutter-md">
        <q-icon
          :name="host.sync.value.configured ? 'cloud' : 'cloud_off'"
          :color="host.sync.value.failureCount > 0 ? 'negative' : 'primary'"
          size="28px"
        />
        <div class="col">
          <div class="text-subtitle2 text-weight-bold">
            远端同步
            <span v-if="!host.sync.value.configured" class="text-grey-7 text-caption">
              （未配置 serverBaseUrl，仅使用本地数据）
            </span>
          </div>
          <div v-if="host.sync.value.configured" class="text-caption text-grey-8">
            服务端：<code>{{ host.sync.value.baseUrl }}</code><br />
            release：{{ host.sync.value.lastRelease ?? host.sync.value.knownReleaseFromMeta ?? '—' }}
            <span v-if="host.sync.value.lastFetchedAt">
              · 最近同步 {{ formatRelative(host.sync.value.lastFetchedAt) }}
            </span>
            <span v-if="host.sync.value.failureCount > 0" class="text-negative">
              · 连续失败 {{ host.sync.value.failureCount }} 次
            </span>
          </div>
        </div>
        <q-chip
          v-if="host.sync.value.lastError"
          color="negative"
          text-color="white"
          dense
        >
          上次错误
          <q-tooltip>{{ host.sync.value.lastError }}</q-tooltip>
        </q-chip>
      </q-card-section>
    </q-card>

    <!-- Server-mode: scheduler status card -->
    <q-card v-if="host.mode === 'server' && serverSyncStatus" flat bordered class="q-mb-md">
      <q-card-section class="row items-center q-gutter-md">
        <q-icon
          :name="serverSyncStatus.enabled ? 'schedule' : 'pause_circle'"
          :color="serverSyncStatus.lastError ? 'negative' : 'primary'"
          size="28px"
        />
        <div class="col">
          <div class="text-subtitle2 text-weight-bold">
            npm 同步调度器
            <q-chip
              v-if="serverSyncStatus.running"
              color="info"
              text-color="white"
              dense
              icon="autorenew"
              label="运行中"
            />
            <q-chip
              v-else-if="!serverSyncStatus.enabled"
              color="grey-7"
              text-color="white"
              dense
              icon="pause"
              label="已禁用"
            />
            <q-chip
              v-else
              color="positive"
              text-color="white"
              dense
              icon="check_circle"
              label="已启用"
            />
          </div>
          <div class="text-caption text-grey-8">
            周期 {{ Math.round(serverSyncStatus.intervalMs / 60_000) }} 分钟（± {{ Math.round(serverSyncStatus.jitterMs / 1_000) }} 秒）
            <span v-if="serverSyncStatus.lastReport">
              · 上次拉到 {{ serverSyncStatus.lastReport.acceptedPlugins }} 个条目
              ({{ serverSyncStatus.lastReport.durationMs }} ms)
            </span>
            <span v-if="serverSyncStatus.lastFinishedAt">
              · 最近完成 {{ formatRelative(serverSyncStatus.lastFinishedAt) }}
            </span>
            <span v-if="serverSyncStatus.nextRunAt">
              · 下一次 {{ formatRelativeFuture(serverSyncStatus.nextRunAt) }}
            </span>
          </div>
        </div>
        <q-chip
          v-if="serverSyncStatus.lastError"
          color="negative"
          text-color="white"
          dense
        >
          上次错误
          <q-tooltip>{{ serverSyncStatus.lastError }}</q-tooltip>
        </q-chip>
      </q-card-section>
    </q-card>

    <div v-if="!host.marketplace.value" class="text-grey-7">加载市场索引中…</div>
    <div
      v-else-if="filtered.length === 0"
      class="section-surface q-pa-xl text-center text-grey-7"
    >
      {{ emptyMessage }}
    </div>

    <div class="plugin-grid">
      <div
        v-for="entry in filtered"
        :key="entry.id"
        class="plugin-card"
        :class="{ locked: isLocked(entry) }"
      >
        <div class="plugin-card-header">
          <q-icon
            :name="isLocked(entry) ? 'lock' : entryIcon(entry)"
            :color="isLocked(entry) ? 'warning' : 'primary'"
            size="22px"
          />
          <div class="col">
            <div class="text-subtitle1 text-weight-bold">
              {{ entry.name }}
              <q-chip
                v-if="entry.verified"
                color="positive"
                text-color="white"
                dense
                icon="verified"
                label="官方"
              />
              <q-chip
                v-if="entry.bootstrap"
                color="info"
                text-color="white"
                dense
                icon="rocket_launch"
                label="bootstrap"
              />
              <q-chip
                v-if="entryVisibilityLabel(entry)"
                :color="visibilityColor(entry)"
                text-color="white"
                dense
                :icon="visibilityIcon(entry)"
                :label="entryVisibilityLabel(entry) ?? ''"
              />
              <q-chip
                v-if="host.mode === 'local' && installed(entry.id)"
                :color="installedState(entry.id) === 'active' ? 'positive' : 'grey-7'"
                text-color="white"
                dense
                :icon="installedState(entry.id) === 'active' ? 'check_circle' : 'inventory_2'"
                :label="installedState(entry.id) === 'active' ? '运行中' : '已安装'"
              />
              <q-chip
                v-if="host.mode === 'local' && host.hasUpgrade(entry.id, entry.latest)"
                color="warning"
                text-color="dark"
                dense
                icon="upgrade"
                :label="`有更新 → ${entry.latest}`"
              />
            </div>
            <div class="plugin-id">{{ entry.npm }}@{{ entry.latest }}</div>
          </div>
        </div>

        <div class="text-caption text-grey-8">
          {{ entry.description }}
        </div>

        <div class="toolbar-row q-mt-sm">
          <!-- Server-mode panel is read-only: no host to install into. -->
          <template v-if="host.mode === 'server'">
            <q-chip dense color="grey-7" text-color="white" icon="info" label="桌面客户端可安装" />
          </template>
          <template v-else-if="installed(entry.id) && isGame(entry)">
            <q-btn
              v-if="installedState(entry.id) === 'active'"
              color="primary"
              icon="sports_esports"
              label="试玩"
              :disable="host.busy.value"
              @click="launchGame(entry.id)"
            />
            <q-btn
              v-else
              color="primary"
              icon="play_arrow"
              label="激活"
              :disable="host.busy.value"
              @click="host.activate(entry.id)"
            />
            <q-btn
              outline
              color="primary"
              icon="settings"
              label="管理"
              :to="`/plugin/${encodeURIComponent(entry.id)}`"
            />
          </template>
          <template v-else-if="installed(entry.id)">
            <!-- Newer version available? Highlight the upgrade. -->
            <q-btn
              v-if="host.hasUpgrade(entry.id, entry.latest)"
              color="primary"
              icon="upgrade"
              :label="`升级到 ${entry.latest}`"
              :disable="host.busy.value"
              :loading="host.busy.value"
              @click="host.upgrade(entry.id, entry.latest)"
            />
            <q-btn
              outline
              color="primary"
              icon="settings"
              label="管理"
              :to="`/plugin/${encodeURIComponent(entry.id)}`"
            />
            <!-- Plugin-specific quick toggle: NotYet ball visibility. Wired
                 via the generic `/api/plugins/:id/rpc` route so other plugins
                 can pick up the same pattern later (manifest opt-in is a
                 future generalization). -->
            <q-toggle
              v-if="entry.id === NOTYET_ID && state(entry.id) === 'active'"
              :model-value="notyetVisible"
              :loading="notyetToggling"
              :disable="notyetToggling || notyetVisible === null"
              color="primary"
              label="悬浮球"
              left-label
              @update:model-value="onToggleNotyet"
            >
              <q-tooltip>显示 / 隐藏每个窗口上的悬浮咨询球</q-tooltip>
            </q-toggle>
          </template>
          <q-btn
            v-else-if="isLocked(entry)"
            color="warning"
            icon="lock_open"
            label="登录解锁"
            to="/login"
          />
          <!-- Bootstrap plugins (or anything the host has a local seed source
               for) re-bootstrap via the host instead of going through npm.
               This sidesteps the "missing qpjoyPlugin field" failure mode. -->
          <q-btn
            v-else-if="host.isSeedable(entry.id)"
            color="primary"
            icon="restart_alt"
            label="重新预装"
            :disable="host.busy.value"
            :loading="host.busy.value"
            @click="host.reseed(entry.id)"
          >
            <q-tooltip>从客户端内置源恢复，绕过 npm 市场流程。</q-tooltip>
          </q-btn>
          <q-btn
            v-else
            color="primary"
            icon="cloud_download"
            :label="isGame(entry) ? '安装游戏' : '安装'"
            :disable="host.busy.value"
            :loading="host.busy.value"
            @click="host.install(entry.id, entry.latest)"
          />
          <q-btn
            v-if="entry.homepage"
            flat
            icon="open_in_new"
            label="主页"
            @click="host.openExternal(entry.homepage)"
          />
          <q-space />
          <span v-if="entry.tarballUrl" class="text-caption text-grey-7">
            支持 tarball 直链
          </span>
        </div>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { usePluginHost } from 'src/composables/usePluginHost';
import { useAuth } from 'src/composables/useAuth';
import { useServerAdmin, type SchedulerStatus } from 'src/composables/useServerAdmin';

const host = usePluginHost();
const auth = useAuth();
const serverAdmin = useServerAdmin();
const query = ref('');
const section = ref<'plugin' | 'game'>('plugin');

/* ── NotYet ball visibility quick-toggle ──────────────────────────────── */

const NOTYET_ID = 'qpjoy.electron-plugin-notyet';
// `null` = "not yet known" (loading). Used by the toggle's disable+model.
const notyetVisible = ref<boolean | null>(null);
const notyetToggling = ref(false);

async function fetchNotyetVisibility(): Promise<void> {
  // Only ask if the plugin is actually active on this host — calling RPC on
  // a non-active plugin would 404. We also gate by mode (server mode has no
  // local plugin runtime).
  if (host.mode !== 'local') { notyetVisible.value = null; return; }
  const active = host.installed.value.find((p) => p.id === NOTYET_ID)?.state === 'active';
  if (!active) { notyetVisible.value = null; return; }
  const v = await host.rpc<boolean>(NOTYET_ID, 'isVisible');
  notyetVisible.value = typeof v === 'boolean' ? v : null;
}

async function onToggleNotyet(next: boolean): Promise<void> {
  if (notyetToggling.value || notyetVisible.value === null) return;
  notyetToggling.value = true;
  try {
    await host.rpc(NOTYET_ID, 'setVisible', [next]);
    notyetVisible.value = next;
  } finally {
    notyetToggling.value = false;
  }
}

const serverSyncStatus = ref<SchedulerStatus | null>(null);
const serverSyncing = ref(false);

async function fetchServerSyncStatus(): Promise<void> {
  // Only meaningful in server mode (route prefix `/admin/`) AND as admin.
  if (host.mode !== 'server') return;
  if (auth.state.value.user?.role !== 'admin') return;
  try {
    serverSyncStatus.value = await serverAdmin.getSyncStatus();
  } catch {
    // 401 = not logged in / not admin, leave null and let the UI fall back
    serverSyncStatus.value = null;
  }
}

async function triggerServerSync(): Promise<void> {
  if (serverSyncing.value) return;
  serverSyncing.value = true;
  try {
    await serverAdmin.triggerSync();
    // Refresh both the index (new content) and the scheduler card.
    await Promise.all([host.refreshMarketplace(), fetchServerSyncStatus()]);
  } catch {
    // toast already shown by useServerAdmin
  } finally {
    serverSyncing.value = false;
  }
}

let pollInstalled: ReturnType<typeof setInterval> | null = null;
let pollSync: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await host.refreshAll();
  await auth.refresh();
  await fetchServerSyncStatus();
  await fetchNotyetVisibility();

  // Light polling so newly-seeded plugins flip to "已安装" without a manual
  // refresh, and so paid-plugin entitlements that arrived since open get
  // picked up. Also pick up notyet visibility changes from elsewhere (e.g.
  // user clicking the "隐" petal in-app).
  pollInstalled = setInterval(async () => {
    await host.refreshInstalled();
    await fetchNotyetVisibility();
  }, 4000);
  // Scheduler status updates every 10s so the user sees a sync that started
  // from another tab / cron-equivalent.
  if (host.mode === 'server') {
    pollSync = setInterval(fetchServerSyncStatus, 10_000);
  }
});

onUnmounted(() => {
  if (pollInstalled) clearInterval(pollInstalled);
  if (pollSync) clearInterval(pollSync);
});

const filtered = computed(() => {
  const entries = host.marketplace.value?.entries ?? [];
  const q = query.value.trim().toLowerCase();
  const scoped = entries.filter((entry) => entryKind(entry) === section.value);
  if (!q) return scoped;
  return scoped.filter(
    (e) =>
      e.id.toLowerCase().includes(q) ||
      e.npm.toLowerCase().includes(q) ||
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q)
  );
});

const sectionEntries = computed(() =>
  (host.marketplace.value?.entries ?? []).filter((entry) => entryKind(entry) === section.value)
);

const emptyMessage = computed(() => {
  if ((host.marketplace.value?.entries.length ?? 0) === 0) return '市场暂无条目';
  if (sectionEntries.value.length === 0) return section.value === 'game' ? '游戏板块暂无条目' : '插件板块暂无条目';
  return '没有匹配的结果';
});

function installed(id: string): boolean {
  return host.installed.value.some((p) => p.id === id);
}

function installedState(id: string): string | null {
  return host.installed.value.find((p) => p.id === id)?.state ?? null;
}

// Alias used inline in the template (shorter than `installedState`).
const state = installedState;

type MarketplaceSection = 'plugin' | 'game';

function entryKind(entry: { category?: string | null; metadata?: Record<string, unknown> | null }): MarketplaceSection {
  if (entry.metadata?.kind === 'game') return 'game';
  if (entry.category?.startsWith('game')) return 'game';
  return 'plugin';
}

function isGame(entry: { category?: string | null; metadata?: Record<string, unknown> | null }): boolean {
  return entryKind(entry) === 'game';
}

function entryIcon(entry: { category?: string | null; metadata?: Record<string, unknown> | null }): string {
  return isGame(entry) ? 'sports_esports' : 'extension';
}

async function launchGame(id: string): Promise<void> {
  await host.rpc(id, 'launch');
}

const legacyOfflineBannerVisible = computed(() => {
  if (host.mode !== 'local') return false;
  const m = host.marketplace.value;
  if (!m?.remoteError) return false;
  if (m.source === 'remote') return false;
  // Suppress the legacy "no indexUrl configured" — it's the MarketplaceClient
  // complaining that the (deprecated) single-file URL isn't set, but the
  // RemoteSyncJob is doing its job. Real failures still surface.
  if (m.remoteError === 'no indexUrl configured') return false;
  return true;
});

const installErrorHint = computed(() => {
  const err = host.lastInstallError.value;
  if (!err) return null;
  if (/not a QPJoy plugin/i.test(err) || /missing qpjoyPlugin/i.test(err)) {
    return '该 npm 包还没发布带 qpjoyPlugin 字段的版本，市场暂时无法安装。如果是 @qpjoy/electron-plugin-tunnel，本机已经通过 seed 装好了，可以直接在「已安装」里使用。';
  }
  if (/Cannot find module/i.test(err)) {
    return '插件依赖未完整安装。重启 host 再试。';
  }
  if (/ENOENT/i.test(err) || /tarball not found/i.test(err)) {
    return '本地源文件路径不存在。';
  }
  return null;
});

interface VisibilityCarrier {
  visibility?: 'public' | 'free' | 'paid' | 'private';
}

function entryVisibilityLabel(entry: VisibilityCarrier): string | null {
  switch (entry.visibility) {
    case 'free':
      return '免费会员';
    case 'paid':
      return '付费';
    case 'private':
      return '私有';
    default:
      return null;
  }
}
function visibilityColor(entry: VisibilityCarrier): string {
  if (entry.visibility === 'paid') return 'warning';
  if (entry.visibility === 'private') return 'negative';
  return 'grey-7';
}
function visibilityIcon(entry: VisibilityCarrier): string {
  if (entry.visibility === 'paid') return 'workspace_premium';
  if (entry.visibility === 'private') return 'lock';
  return 'card_membership';
}

function isLocked(entry: VisibilityCarrier): boolean {
  // Already installed → never locked.
  if (installed((entry as { id: string }).id)) return false;
  if (entry.visibility === 'paid' || entry.visibility === 'private') {
    return !auth.state.value.user || auth.state.value.user.role !== 'admin';
  }
  if (entry.visibility === 'free') return !auth.state.value.user;
  return false;
}

const sourceLabel = computed(() => {
  const src = host.marketplace.value?.source;
  if (!src) return null;
  return { remote: '在线', cache: '缓存', seed: '内置' }[src];
});
const sourceColor = computed(() => {
  const src = host.marketplace.value?.source;
  return { remote: 'positive', cache: 'info', seed: 'grey-7' }[src ?? 'seed'];
});
const sourceIcon = computed(() => {
  const src = host.marketplace.value?.source;
  return { remote: 'cloud_done', cache: 'cloud_queue', seed: 'inventory_2' }[src ?? 'seed'];
});

function formatRelativeFuture(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return '即将';
  if (ms < 60_000) return `${Math.ceil(ms / 1_000)} 秒后`;
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)} 分钟后`;
  if (ms < 86_400_000) return `${Math.ceil(ms / 3_600_000)} 小时后`;
  return `${Math.ceil(ms / 86_400_000)} 天后`;
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '刚刚';
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3600_000)} 小时前`;
  return `${Math.floor(ms / 86_400_000)} 天前`;
}
</script>
