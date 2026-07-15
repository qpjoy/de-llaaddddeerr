<template>
  <section class="surface-panel oversea-panel" aria-labelledby="oversea-title">
    <div class="oversea-hero">
      <div>
        <p class="qp-kicker">HOME TO OVERSEA</p>
        <h3 id="oversea-title">{{ oversea.subscriptionName || 'System Oversea 默认订阅' }}</h3>
        <p>{{ oversea.message }}</p>
      </div>
      <div class="oversea-hero__actions">
        <q-toggle
          :model-value="oversea.autoConnect"
          color="primary"
          label="登录后自动连接"
          :disable="busy"
          @update:model-value="setAutoConnect"
        />
        <q-btn
          outline
          color="primary"
          icon="sync"
          label="刷新订阅"
          :loading="busyAction === 'refresh'"
          :disable="!canOperate || busy"
          @click="refreshSubscription"
        />
        <q-btn
          v-if="!oversea.tunnel.running"
          color="positive"
          icon="play_arrow"
          label="启动"
          :loading="busyAction === 'start'"
          :disable="!canOperate || busy"
          @click="startOversea"
        />
        <q-btn
          v-else
          outline
          color="warning"
          icon="stop"
          label="停止"
          :loading="busyAction === 'stop'"
          :disable="busy"
          @click="stopOversea"
        />
      </div>
    </div>

    <div class="oversea-statusline">
      <q-badge :color="statusColor" outline>{{ statusLabel }}</q-badge>
      <span>{{ oversea.siteIds.length ? oversea.siteIds.join(' · ') : '等待 Internal 分配站点' }}</span>
      <span v-if="oversea.lastProxyDecision">代理决策 {{ oversea.lastProxyDecision }}</span>
    </div>

    <q-tabs
      v-model="activeTab"
      dense
      no-caps
      inline-label
      outside-arrows
      mobile-arrows
      active-color="primary"
      indicator-color="primary"
      class="oversea-tabs"
      align="left"
    >
      <q-tab name="home" icon="home" label="首页" />
      <q-tab name="proxy" icon="lan" label="代理" />
      <q-tab name="subscription" icon="receipt_long" label="订阅" />
      <q-tab name="rules" icon="rule" label="规则" />
      <q-tab name="test" icon="travel_explore" label="测试" />
      <q-tab name="logs" icon="terminal" label="日志" />
    </q-tabs>

    <q-separator dark />

    <q-tab-panels v-model="activeTab" animated class="oversea-panels">
      <q-tab-panel name="home">
        <div class="oversea-metrics">
          <article>
            <span>当前模式</span>
            <strong>{{ modeLabel }}</strong>
          </article>
          <article>
            <span>本地代理</span>
            <strong>:{{ oversea.tunnel.ports.mixed }}</strong>
          </article>
          <article>
            <span>运行状态</span>
            <strong>{{ statusLabel }}</strong>
          </article>
        </div>
        <div class="oversea-readiness">
          <div>
            <q-icon :name="identityReady ? 'check_circle' : 'person_off'" :color="identityReady ? 'positive' : 'warning'" />
            <span>登录用户</span>
            <strong>{{ identityReady ? runtime.identity.displayName || runtime.identity.userId : '等待登录' }}</strong>
          </div>
          <div>
            <q-icon :name="internalReady ? 'check_circle' : 'vpn_lock'" :color="internalReady ? 'positive' : 'warning'" />
            <span>Internal</span>
            <strong>{{ internalReady ? 'network-ready' : runtime.connection.status }}</strong>
          </div>
          <div>
            <q-icon :name="subscriptionReady ? 'check_circle' : 'hourglass_top'" :color="subscriptionReady ? 'positive' : 'warning'" />
            <span>用户订阅</span>
            <strong>{{ subscriptionReady ? `${oversea.nodeCount} 个节点` : oversea.syncStatus || '等待确保' }}</strong>
          </div>
          <div>
            <q-icon :name="oversea.tunnel.engine.available ? 'check_circle' : 'error'" :color="oversea.tunnel.engine.available ? 'positive' : 'negative'" />
            <span>mihomo 引擎</span>
            <strong>{{ oversea.tunnel.engine.available ? oversea.tunnel.engine.source : '缺失' }}</strong>
          </div>
        </div>
      </q-tab-panel>

      <q-tab-panel name="proxy">
        <div class="oversea-section-heading">
          <div>
            <p class="qp-kicker">PROXY MODE</p>
            <h4>应用代理策略</h4>
          </div>
          <q-badge :color="oversea.tunnel.running ? 'positive' : 'grey-6'" outline>
            {{ oversea.tunnel.running ? 'mixed listening' : 'stopped' }}
          </q-badge>
        </div>
        <q-btn-toggle
          :model-value="oversea.mode"
          spread
          no-caps
          unelevated
          toggle-color="primary"
          color="grey-9"
          text-color="grey-4"
          :options="modeOptions"
          :disable="!canOperate || busy"
          @update:model-value="setMode"
        />
        <p class="oversea-note">
          应用全局代理让 Oversea 测试窗口默认走代理；规则代理只放行常用外网域名。首版不开放系统 TUN，避免抢占 Internal WireGuard 路由。
        </p>
        <div class="oversea-details">
          <div><span>Mixed</span><strong>127.0.0.1:{{ oversea.tunnel.ports.mixed }}</strong></div>
          <div><span>Controller</span><strong>127.0.0.1:{{ oversea.tunnel.ports.controller }}</strong></div>
          <div><span>DNS</span><strong>127.0.0.1:{{ oversea.tunnel.ports.dns }}</strong></div>
          <div><span>健康</span><strong>{{ oversea.tunnel.health.ok ? 'ok' : oversea.tunnel.health.message || 'pending' }}</strong></div>
        </div>
      </q-tab-panel>

      <q-tab-panel name="subscription">
        <div class="oversea-section-heading">
          <div>
            <p class="qp-kicker">INTERNAL ISSUED</p>
            <h4>{{ oversea.subscriptionName || '等待用户订阅' }}</h4>
          </div>
          <q-badge :color="subscriptionReady ? 'positive' : 'warning'" outline>
            {{ oversea.syncStatus || 'pending' }}
          </q-badge>
        </div>
        <div class="oversea-details oversea-details--stacked">
          <div><span>Entitlement</span><strong>{{ oversea.entitlementId || '-' }}</strong></div>
          <div><span>Subscription path</span><strong>{{ oversea.subscriptionPath || '-' }}</strong></div>
          <div><span>站点</span><strong>{{ oversea.siteIds.join(', ') || '-' }}</strong></div>
          <div><span>最近确保</span><strong>{{ formatTime(oversea.ensuredAt) }}</strong></div>
        </div>
        <p class="oversea-note">登录 token 只用于向 Internal 换取订阅；renderer 只看到脱敏状态，不接触 token、YAML 或 Hysteria2 密钥。</p>
      </q-tab-panel>

      <q-tab-panel name="rules">
        <div class="oversea-section-heading">
          <div>
            <p class="qp-kicker">APP RULE ALLOWLIST</p>
            <h4>常用外网规则</h4>
          </div>
          <q-badge color="primary" outline>{{ presetRules.length }} 组</q-badge>
        </div>
        <div class="oversea-rule-list">
          <article v-for="rule in presetRules" :key="rule.name">
            <q-icon :name="rule.icon" />
            <div><strong>{{ rule.name }}</strong><span>{{ rule.domains }}</span></div>
            <q-badge color="positive" outline>enabled</q-badge>
          </article>
        </div>
        <p class="oversea-note">全局模式仍优先直连私网和中国大陆流量；规则模式只代理以上域名，其余流量不会进入 Oversea。</p>
      </q-tab-panel>

      <q-tab-panel name="test">
        <div class="oversea-testbar">
          <q-input
            v-model="testUrl"
            dark
            outlined
            dense
            aria-label="Oversea 测试地址"
            placeholder="https://www.google.com"
            @keyup.enter="openTest(testUrl)"
          />
          <q-btn
            color="primary"
            icon="open_in_new"
            label="打开测试窗口"
            :loading="busyAction === 'test'"
            :disable="!canOperate || busy"
            @click="openTest(testUrl)"
          />
        </div>
        <div class="oversea-shortcuts" aria-label="常用外网测试站点">
          <q-btn
            v-for="site in quickSites"
            :key="site.label"
            outline
            no-caps
            color="grey-4"
            :icon="site.icon"
            :label="site.label"
            :disable="!canOperate || busy"
            @click="openTest(site.url)"
          />
        </div>
        <div class="oversea-metrics">
          <article><span>当前模式</span><strong>{{ modeLabel }}</strong></article>
          <article><span>本地代理</span><strong>:{{ oversea.tunnel.ports.mixed }}</strong></article>
          <article><span>代理决策</span><strong>{{ oversea.lastProxyDecision || '尚未测试' }}</strong></article>
        </div>
      </q-tab-panel>

      <q-tab-panel name="logs">
        <div class="oversea-log" aria-live="polite">
          <article v-for="event in oversea.tunnel.events" :key="event.id">
            <time>{{ formatTime(event.createdAt) }}</time>
            <q-badge :color="logColor(event.level)" outline>{{ event.level }}</q-badge>
            <span>{{ event.message }}</span>
          </article>
          <p v-if="oversea.tunnel.events.length === 0">等待 Oversea runtime 日志。</p>
        </div>
      </q-tab-panel>
    </q-tab-panels>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuasar } from 'quasar';

import type { LuopanOverseaMode, LuopanRuntimeState } from 'src/types/launcher';

const props = defineProps<{ runtime: LuopanRuntimeState }>();
const emit = defineEmits<{ runtime: [state: LuopanRuntimeState] }>();
const $q = useQuasar();
const activeTab = ref('home');
const busyAction = ref<string | null>(null);
const testUrl = ref(props.runtime.oversea.lastTestUrl);

const oversea = computed(() => props.runtime.oversea);
const busy = computed(() => Boolean(busyAction.value) || ['ensuring', 'starting'].includes(oversea.value.status));
const identityReady = computed(() => props.runtime.identity.kind === 'user' && props.runtime.identity.tokenPresent);
const internalReady = computed(() => props.runtime.connection.status === 'network-ready');
const canOperate = computed(() => identityReady.value && internalReady.value);
const subscriptionReady = computed(() => Boolean(
  oversea.value.subscriptionPath
  && (
    oversea.value.syncStatus === 'passed'
    || ['ready', 'starting', 'running', 'stopped'].includes(oversea.value.status)
  )
));
const modeLabel = computed(() => oversea.value.mode === 'app-rule' ? '规则代理' : '应用全局代理');
const statusLabel = computed(() => ({
  'waiting-login': '等待登录',
  'waiting-internal': '等待 Internal',
  ensuring: '正在确保订阅',
  'pending-sync': '等待远端同步',
  starting: '正在启动',
  ready: '订阅就绪',
  running: '已连接',
  stopped: '已停止',
  error: '需要处理'
}[oversea.value.status] || oversea.value.status));
const statusColor = computed(() => {
  if (oversea.value.status === 'running' || oversea.value.status === 'ready') return 'positive';
  if (oversea.value.status === 'error') return 'negative';
  if (oversea.value.status === 'stopped') return 'grey-6';
  return 'warning';
});

const modeOptions = [
  { label: '应用全局代理', value: 'app-global', icon: 'public' },
  { label: '规则代理', value: 'app-rule', icon: 'rule' }
];
const quickSites = [
  { label: 'Google', url: 'https://www.google.com', icon: 'search' },
  { label: 'YouTube', url: 'https://www.youtube.com', icon: 'smart_display' },
  { label: 'X / Twitter', url: 'https://x.com', icon: 'alternate_email' },
  { label: 'Telegram', url: 'https://web.telegram.org', icon: 'send' }
];
const presetRules = [
  { name: 'Google', domains: 'google.com · googleapis.com · gstatic.com', icon: 'search' },
  { name: 'YouTube', domains: 'youtube.com · youtu.be · googlevideo.com', icon: 'smart_display' },
  { name: 'X / Twitter', domains: 'x.com · twitter.com · twimg.com', icon: 'alternate_email' },
  { name: 'Telegram', domains: 'telegram.org · t.me · telegram.me', icon: 'send' }
];

watch(() => props.runtime.oversea.lastTestUrl, (value) => {
  if (value) testUrl.value = value;
});

async function withAction(name: string, action: () => Promise<LuopanRuntimeState> | undefined) {
  if (busyAction.value) return;
  busyAction.value = name;
  try {
    const next = await action();
    if (next) emit('runtime', next);
    if (next?.oversea.status === 'error') {
      $q.notify({ type: 'negative', message: next.oversea.message });
    }
  } catch (error) {
    $q.notify({ type: 'negative', message: error instanceof Error ? error.message : String(error) });
  } finally {
    busyAction.value = null;
  }
}

function refreshSubscription() {
  return withAction('refresh', () => window.luopanLauncher?.refreshOverseaSubscription());
}

function startOversea() {
  return withAction('start', () => window.luopanLauncher?.startOversea());
}

function stopOversea() {
  return withAction('stop', () => window.luopanLauncher?.stopOversea());
}

function setMode(mode: LuopanOverseaMode) {
  return withAction('mode', () => window.luopanLauncher?.setOverseaMode(mode));
}

function setAutoConnect(enabled: boolean) {
  return withAction('auto', () => window.luopanLauncher?.setOverseaAutoConnect(enabled));
}

function openTest(url: string) {
  testUrl.value = url;
  return withAction('test', () => window.luopanLauncher?.openOverseaTestWindow({ url }));
}

function formatTime(value: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function logColor(level: 'info' | 'warn' | 'error') {
  if (level === 'error') return 'negative';
  if (level === 'warn') return 'warning';
  return 'cyan';
}
</script>

<style scoped>
.oversea-panel {
  overflow: hidden;
  margin-bottom: var(--qp-space-4, 16px);
  padding: 0;
}

.oversea-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--qp-space-5, 20px);
  padding: var(--qp-space-6, 24px);
  border-bottom: 1px solid var(--qp-line, rgba(81, 108, 163, 0.5));
  background:
    linear-gradient(100deg, rgba(43, 246, 210, 0.12), rgba(230, 180, 83, 0.08) 56%, rgba(43, 246, 210, 0.08)),
    var(--qp-bg-elevated, rgba(24, 29, 44, 0.88));
}

.oversea-hero h3 {
  margin: 4px 0 8px;
  color: var(--qp-text, #f9fbff);
  font-size: clamp(25px, 2.6vw, 38px);
  line-height: 1.08;
  font-weight: 900;
}

.oversea-hero p:last-child,
.oversea-note {
  margin: 0;
  color: var(--qp-text-muted, rgba(229, 237, 248, 0.68));
  line-height: 1.55;
}

.oversea-hero__actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--qp-space-3, 12px);
}

.oversea-statusline {
  display: flex;
  align-items: center;
  gap: var(--qp-space-3, 12px);
  min-height: 44px;
  padding: 8px var(--qp-space-6, 24px);
  color: var(--qp-text-muted, rgba(229, 237, 248, 0.66));
  font-size: 12px;
}

.oversea-tabs {
  padding: 8px var(--qp-space-4, 16px) 0;
  background: var(--qp-bg-deep, rgba(11, 15, 24, 0.48));
}

.oversea-panels {
  min-height: 332px;
  background: transparent;
  color: var(--qp-text, #eef3f8);
}

.oversea-metrics,
.oversea-readiness,
.oversea-details {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--qp-space-3, 12px);
}

.oversea-metrics article,
.oversea-readiness > div,
.oversea-details > div {
  display: grid;
  gap: 8px;
  min-width: 0;
  padding: var(--qp-space-4, 16px);
  border: 1px solid var(--qp-line, rgba(81, 108, 163, 0.46));
  border-radius: var(--qp-radius-md, 8px);
  background: var(--qp-bg-deep, rgba(11, 15, 24, 0.48));
}

.oversea-metrics span,
.oversea-readiness span,
.oversea-details span {
  color: var(--qp-text-muted, rgba(229, 237, 248, 0.56));
  font-size: 11px;
  font-weight: 900;
  text-transform: uppercase;
}

.oversea-metrics strong {
  overflow-wrap: anywhere;
  font-size: 24px;
}

.oversea-readiness {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin-top: var(--qp-space-4, 16px);
}

.oversea-readiness .q-icon {
  font-size: 22px;
}

.oversea-readiness strong,
.oversea-details strong {
  overflow-wrap: anywhere;
}

.oversea-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: var(--qp-space-4, 16px);
}

.oversea-section-heading h4 {
  margin: 2px 0 0;
  font-size: 20px;
}

.oversea-note {
  margin-top: var(--qp-space-4, 16px);
}

.oversea-details {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: var(--qp-space-4, 16px);
}

.oversea-details--stacked {
  grid-template-columns: 1fr;
}

.oversea-rule-list,
.oversea-log {
  display: grid;
  gap: 10px;
}

.oversea-rule-list article {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--qp-line, rgba(81, 108, 163, 0.4));
  border-radius: var(--qp-radius-md, 8px);
  background: var(--qp-bg-deep, rgba(11, 15, 24, 0.4));
}

.oversea-rule-list .q-icon {
  color: var(--qp-primary, #2bf6d2);
  font-size: 22px;
}

.oversea-rule-list article div {
  display: grid;
  gap: 3px;
}

.oversea-rule-list article span {
  color: var(--qp-text-muted, rgba(229, 237, 248, 0.58));
  font-size: 12px;
}

.oversea-testbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
}

.oversea-shortcuts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin: var(--qp-space-4, 16px) 0;
}

.oversea-log {
  max-height: 330px;
  overflow: auto;
}

.oversea-log article {
  display: grid;
  grid-template-columns: 150px 58px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--qp-line, rgba(81, 108, 163, 0.28));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.oversea-log time {
  color: var(--qp-text-muted, rgba(229, 237, 248, 0.56));
}

.oversea-log span {
  overflow-wrap: anywhere;
  line-height: 1.5;
}

@media (max-width: 980px) {
  .oversea-hero {
    align-items: flex-start;
    flex-direction: column;
  }

  .oversea-hero__actions {
    justify-content: flex-start;
  }

  .oversea-readiness,
  .oversea-shortcuts {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 660px) {
  .oversea-metrics,
  .oversea-readiness,
  .oversea-details,
  .oversea-shortcuts,
  .oversea-testbar,
  .oversea-log article {
    grid-template-columns: 1fr;
  }
}
</style>
