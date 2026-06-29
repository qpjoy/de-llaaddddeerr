<template>
  <q-layout view="lHh Lpr lFf" class="luopan-shell">
    <q-drawer show-if-above :width="280" class="luopan-sidebar">
      <div class="brand-lockup">
        <div class="brand-mark">LP</div>
        <div>
          <h1>Luopan</h1>
          <p>AI intelligence console</p>
        </div>
      </div>

      <q-list class="nav-list">
        <q-item v-for="item in navItems" :key="item.label" clickable :active="item.active" class="nav-item">
          <q-item-section avatar>
            <q-icon :name="item.icon" />
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ item.label }}</q-item-label>
            <q-item-label caption>{{ item.caption }}</q-item-label>
          </q-item-section>
        </q-item>
      </q-list>

      <div class="runtime-mini">
        <span>Launcher</span>
        <strong>{{ runtime.packageName }}</strong>
        <q-badge :color="statusColor" outline>{{ runtime.connection.status }}</q-badge>
      </div>
    </q-drawer>

    <q-page-container>
      <q-page class="console-page qp-app qp-theme-neon-void qp-density--medium">
        <header class="console-toolbar">
          <div>
            <p class="qp-kicker">LUOPAN / STANDALONE CHANNEL</p>
            <h2>情报作业台</h2>
          </div>
          <div class="toolbar-actions">
            <q-btn flat round icon="open_in_new" @click="openAdmin">
              <q-tooltip>Open MX Launcher Admin</q-tooltip>
            </q-btn>
            <q-btn outline color="primary" icon="dns" label="Internal entry" @click="openInternalEntry" />
            <q-btn color="primary" icon="hub" :loading="connecting" label="Request lease" @click="connectTestMode" />
            <q-btn
              color="secondary"
              icon="lan"
              :disable="!runtime.connection.leaseIp || connecting"
              :loading="connecting"
              label="Apply data plane"
              @click="applyDataPlane"
            />
            <q-btn
              outline
              color="grey-4"
              icon="power_settings_new"
              :disable="connecting"
              label="Disconnect"
              @click="disconnectDataPlane"
            />
          </div>
        </header>

        <section class="kpi-grid" aria-label="runtime summary">
          <article v-for="item in kpis" :key="item.label" class="metric-panel">
            <span>{{ item.label }}</span>
            <strong>{{ item.value }}</strong>
            <small>{{ item.hint }}</small>
          </article>
        </section>

        <section class="work-grid">
          <main class="main-column">
            <section class="surface-panel operations-panel">
              <div class="panel-heading">
                <div>
                  <p class="qp-kicker">INTELLIGENCE PIPELINE</p>
                  <h3>任务队列</h3>
                </div>
                <q-btn dense flat round icon="refresh" @click="refreshSnapshot">
                  <q-tooltip>Refresh launcher snapshot</q-tooltip>
                </q-btn>
              </div>
              <q-table
                flat
                dark
                hide-bottom
                row-key="id"
                :rows="tasks"
                :columns="taskColumns"
                table-class="task-table"
              >
                <template #body-cell-state="props">
                  <q-td :props="props">
                    <q-badge :color="props.row.color" outline>{{ props.row.state }}</q-badge>
                  </q-td>
                </template>
              </q-table>
            </section>

            <section class="surface-panel topology-panel">
              <div class="panel-heading">
                <div>
                  <p class="qp-kicker">LAUNCHER ADAPTER</p>
                  <h3>通用 Electron 接入边界</h3>
                </div>
                <q-toggle v-model="draft.sdkTestMode" color="primary" label="SDK test mode" @update:model-value="saveConfig" />
              </div>
              <div class="boundary-grid">
                <article v-for="item in boundary" :key="item.title" class="boundary-node">
                  <q-icon :name="item.icon" />
                  <strong>{{ item.title }}</strong>
                  <span>{{ item.detail }}</span>
                </article>
              </div>
            </section>
          </main>

          <aside class="side-column">
            <section class="surface-panel runtime-panel">
              <div class="panel-heading">
                <div>
                  <p class="qp-kicker">RUNTIME</p>
                  <h3>Launcher Network</h3>
                </div>
                <q-btn dense flat round icon="restart_alt" @click="resetSession">
                  <q-tooltip>Reset local session view</q-tooltip>
                </q-btn>
              </div>
              <div class="runtime-state">
                <div>
                  <span>Status</span>
                  <strong>{{ runtime.connection.status }}</strong>
                </div>
                <div>
                  <span>Lease IP</span>
                  <strong>{{ runtime.connection.leaseIp || '-' }}</strong>
                </div>
                <div>
                  <span>Service VIP</span>
                  <strong>{{ runtime.connection.serviceVip || '-' }}</strong>
                </div>
                <div>
                  <span>DNS</span>
                  <strong>{{ runtime.connection.dnsServer || '-' }}</strong>
                </div>
                <div>
                  <span>Data Plane</span>
                  <strong>{{ runtime.connection.dataPlane?.state || '-' }}</strong>
                </div>
              </div>
              <p class="runtime-message">{{ runtime.connection.message }}</p>
              <div v-if="dataPlaneProbes.length" class="data-plane-probes">
                <div v-for="probe in dataPlaneProbes" :key="probe.target" class="data-plane-probe">
                  <span>{{ probe.label }}</span>
                  <strong>{{ probe.address }}</strong>
                  <q-badge :color="probe.ok ? 'positive' : probe.viaProxyTun ? 'negative' : 'warning'" outline>
                    {{ routeProbeHint(probe) }}
                  </q-badge>
                </div>
              </div>
            </section>

            <section class="surface-panel config-panel">
              <div class="panel-heading">
                <div>
                  <p class="qp-kicker">CONFIG</p>
                  <h3>测试连接</h3>
                </div>
              </div>
              <q-input v-model="draft.baseUrl" dark outlined dense label="MX Server" @blur="saveConfig" />
              <q-input v-model="draft.deviceLabel" dark outlined dense label="Device label" @blur="saveConfig" />
              <div class="config-pair">
                <span>App ID</span>
                <strong>{{ runtime.config.productId }}</strong>
              </div>
              <div class="config-pair">
                <span>Install</span>
                <strong>{{ shortId(runtime.installId) }}</strong>
              </div>
            </section>

            <section class="surface-panel event-panel">
              <div class="panel-heading">
                <div>
                  <p class="qp-kicker">EVIDENCE</p>
                  <h3>本机事件</h3>
                </div>
              </div>
              <div class="event-log">
                <p v-for="event in runtime.events" :key="event">{{ event }}</p>
                <p v-if="runtime.events.length === 0">waiting for launcher runtime events</p>
              </div>
            </section>
          </aside>
        </section>
      </q-page>
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useQuasar, type QTableColumn } from 'quasar';

import type { LuopanRuntimeConfig, LuopanRuntimeState } from 'src/types/launcher';

const $q = useQuasar();
const fallbackRuntime: LuopanRuntimeState = {
  appId: 'luopan',
  displayName: 'Luopan',
  packageName: '@qpjoy/electron-launcher',
  launcherMode: 'standalone',
  installId: '-',
  deviceId: '-',
  config: {
    baseUrl: 'http://100.89.0.12:18090',
    productId: 'luopan',
    mode: 'standalone',
    sdkTestMode: true,
    deviceLabel: 'Luopan Quasar Demo'
  },
  connection: {
    status: 'idle',
    leaseIp: null,
    serviceVip: null,
    dnsServer: null,
    routeCidrs: [],
    snapshotDigest: null,
    dataPlane: null,
    message: 'Renderer fallback mode. Start with Quasar Electron to use launcher IPC.',
    updatedAt: null
  },
  events: []
};

const runtime = ref<LuopanRuntimeState>(fallbackRuntime);
const draft = reactive<LuopanRuntimeConfig>({ ...fallbackRuntime.config });
const connecting = computed(() => runtime.value.connection.status === 'connecting');
const dataPlaneProbes = computed(() => runtime.value.connection.dataPlane?.probes ?? []);
const statusColor = computed(() => {
  if (runtime.value.connection.status === 'network-ready') return 'positive';
  if (runtime.value.connection.status === 'error') return 'negative';
  if (runtime.value.connection.status === 'connecting' || runtime.value.connection.status === 'data-plane-pending') return 'warning';
  if (runtime.value.connection.status === 'lease-active') return 'cyan';
  return 'grey-6';
});

const navItems = [
  { label: '任务', caption: 'reports / graph / triage', icon: 'dashboard', active: true },
  { label: '数据源', caption: 'feeds / crawlers', icon: 'dataset', active: false },
  { label: '模型', caption: 'rules / scoring', icon: 'schema', active: false },
  { label: '审计', caption: 'evidence / export', icon: 'fact_check', active: false }
];

const taskColumns: QTableColumn[] = [
  { name: 'name', label: '对象', field: 'name', align: 'left' },
  { name: 'owner', label: '负责人', field: 'owner', align: 'left' },
  { name: 'state', label: '状态', field: 'state', align: 'left' },
  { name: 'risk', label: '风险', field: 'risk', align: 'right' }
];

const tasks = [
  { id: 'case-2048', name: '境外节点异常聚合', owner: 'analyst-a', state: 'review', risk: '86', color: 'orange' },
  { id: 'case-2173', name: '企业画像更新', owner: 'analyst-b', state: 'running', risk: '42', color: 'cyan' },
  { id: 'case-2191', name: 'OpenVPN 入口线索', owner: 'network', state: 'verified', risk: '71', color: 'positive' },
  { id: 'case-2207', name: '资产侧写补全', owner: 'model', state: 'queued', risk: '24', color: 'grey-6' }
];

const boundary = [
  { title: 'Electron main', detail: 'imports @qpjoy/electron-launcher', icon: 'integration_instructions' },
  { title: 'Preload IPC', detail: 'safe runtime bridge for any renderer', icon: 'terminal' },
  { title: 'Quasar Vue', detail: 'business UI without Node access', icon: 'view_quilt' },
  { title: 'Admin registry', detail: 'entitlement owns real network access', icon: 'verified_user' }
];

const kpis = computed(() => [
  { label: 'Application', value: runtime.value.displayName, hint: runtime.value.launcherMode },
  { label: 'Lease', value: runtime.value.connection.leaseIp || 'not issued', hint: runtime.value.connection.status },
  { label: 'DNS Route', value: 'luopan.mxinfo-inc.cn', hint: 'Internal gateway upstream' },
  { label: 'SDK Mode', value: draft.sdkTestMode ? 'test' : 'registered', hint: 'entitlement gate' }
]);

function applyRuntime(next: LuopanRuntimeState) {
  runtime.value = next;
  Object.assign(draft, next.config);
}

async function getRuntime() {
  const next = await window.luopanLauncher?.getRuntime();
  if (next) applyRuntime(next);
}

async function saveConfig() {
  const next = await window.luopanLauncher?.saveConfig({ ...draft });
  if (next) applyRuntime(next);
}

async function connectTestMode() {
  const next = await window.luopanLauncher?.connectTestMode();
  if (next) applyRuntime(next);
  if (next?.connection.status === 'error') {
    $q.notify({ type: 'negative', message: next.connection.message || 'Launcher request failed' });
  }
}

async function applyDataPlane() {
  const next = await window.luopanLauncher?.applyDataPlane();
  if (next) applyRuntime(next);
  if (next?.connection.status === 'error') {
    $q.notify({ type: 'negative', message: next.connection.message || 'Launcher data-plane apply failed' });
  }
}

async function disconnectDataPlane() {
  const next = await window.luopanLauncher?.disconnectDataPlane();
  if (next) applyRuntime(next);
}

async function refreshSnapshot() {
  const next = await window.luopanLauncher?.refreshSnapshot();
  if (next) applyRuntime(next);
}

async function resetSession() {
  const next = await window.luopanLauncher?.resetSession();
  if (next) applyRuntime(next);
}

async function openAdmin() {
  await window.luopanLauncher?.openAdmin();
}

async function openInternalEntry() {
  await window.luopanLauncher?.openInternalEntry();
}

function shortId(value: string) {
  if (!value || value === '-') return '-';
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-6)}` : value;
}

function routeProbeHint(probe: { ok: boolean; viaProxyTun: boolean; interfaceName: string | null; gateway: string | null }) {
  if (probe.ok) return probe.interfaceName || 'ok';
  if (probe.viaProxyTun) return `proxy ${probe.gateway || ''}`.trim();
  return probe.interfaceName || probe.gateway || 'pending';
}

onMounted(() => {
  void getRuntime();
  window.luopanLauncher?.onRuntime(applyRuntime);
});
</script>
