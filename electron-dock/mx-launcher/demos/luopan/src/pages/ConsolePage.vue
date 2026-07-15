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
            <q-btn color="positive" icon="vpn_lock" :loading="connecting" label="Connect Internal" @click="connectInternal" />
            <q-btn outline color="primary" icon="hub" :loading="connecting" label="Request lease" @click="connectTestMode" />
            <q-btn
              outline
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

            <section class="surface-panel release-panel">
              <div class="panel-heading">
                <div>
                  <p class="qp-kicker">RELEASE CENTER</p>
                  <h3>更新与灰度</h3>
                </div>
                <div class="toolbar-actions">
                  <q-btn dense outline color="primary" icon="update" :loading="updateBusy" label="检查更新" @click="checkUpdates" />
                  <q-btn
                    dense
                    outline
                    color="positive"
                    icon="play_arrow"
                    :disable="runtime.update.status !== 'update-available'"
                    :loading="updateBusy"
                    label="应用"
                    @click="applyUpdate"
                  />
                  <q-btn
                    dense
                    outline
                    color="warning"
                    icon="install_desktop"
                    :disable="!hasInstallerArtifact"
                    label="立即安装"
                    @click="openStagedInstaller"
                  />
                  <q-btn-dropdown dense outline color="grey-4" icon="history" label="回滚">
                    <q-list dark>
                      <q-item clickable v-close-popup @click="rollbackUpdateSlot('config')">
                        <q-item-section>回滚 config 槽位</q-item-section>
                      </q-item>
                      <q-item clickable v-close-popup @click="rollbackUpdateSlot('renderer')">
                        <q-item-section>回滚 renderer 槽位</q-item-section>
                      </q-item>
                    </q-list>
                  </q-btn-dropdown>
                </div>
              </div>
              <div class="runtime-state">
                <div>
                  <span>状态</span>
                  <strong><q-badge :color="updateStatusColor" outline>{{ runtime.update.status }}</q-badge></strong>
                </div>
                <div>
                  <span>当前版本</span>
                  <strong>{{ runtime.update.currentVersion }}</strong>
                </div>
                <div>
                  <span>目标版本</span>
                  <strong>{{ runtime.update.targetVersion || '-' }}</strong>
                </div>
                <div>
                  <span>灰度命中</span>
                  <strong>{{ runtime.update.matchedBy || '-' }}</strong>
                </div>
                <div>
                  <span>Release</span>
                  <strong>{{ runtime.update.releaseId || '-' }}</strong>
                </div>
              </div>
              <p v-if="runtime.update.releaseNotes" class="runtime-message release-notes">{{ runtime.update.releaseNotes }}</p>
              <p class="runtime-message">{{ runtime.update.message }}</p>
              <div v-if="runtime.update.featureFlags.length" class="runtime-message">
                feature flags: {{ runtime.update.featureFlags.join(', ') }}
              </div>
              <q-table
                v-if="runtime.update.artifacts.length"
                flat
                dark
                dense
                hide-bottom
                row-key="artifactId"
                :rows="runtime.update.artifacts"
                :columns="artifactColumns"
                table-class="task-table"
              />
              <div v-if="runtime.update.execution.length" class="data-plane-probes">
                <div v-for="item in runtime.update.execution" :key="item.artifactId" class="data-plane-probe">
                  <span>{{ item.artifactClass }}</span>
                  <strong>{{ item.phase }}</strong>
                  <q-badge :color="item.error ? 'negative' : item.activated ? 'positive' : item.deferredReason ? 'warning' : 'grey-6'" outline>
                    {{ item.error || item.deferredReason || (item.activated ? 'activated' : 'staged') }}
                  </q-badge>
                </div>
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
                  <span>Bootstrap</span>
                  <strong>{{ runtime.connection.bootstrapBaseUrl || '-' }}</strong>
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

            <section class="surface-panel identity-panel">
              <div class="panel-heading">
                <div>
                  <p class="qp-kicker">USER CENTER</p>
                  <h3>用户中心</h3>
                </div>
                <q-badge :color="runtime.identity.kind === 'user' ? 'positive' : 'grey-6'" outline>
                  {{ runtime.identity.kind === 'user' ? '已登录' : '匿名' }}
                </q-badge>
              </div>
              <template v-if="runtime.identity.kind === 'user'">
                <div class="runtime-state">
                  <div>
                    <span>用户</span>
                    <strong>{{ runtime.identity.displayName || runtime.identity.userId }}</strong>
                  </div>
                  <div>
                    <span>User ID</span>
                    <strong>{{ shortId(runtime.identity.userId || '-') }}</strong>
                  </div>
                  <div>
                    <span>Lease 段</span>
                    <strong>登录段（user range）</strong>
                  </div>
                  <div>
                    <span>Token</span>
                    <strong>{{ runtime.identity.tokenPresent ? 'active' : 'expired/none' }}</strong>
                  </div>
                </div>
                <p v-if="runtime.identity.scopes.length" class="runtime-message">
                  scopes: {{ runtime.identity.scopes.join(' ') }}
                </p>
                <q-btn outline color="grey-4" icon="logout" label="登出" @click="logout" />
              </template>
              <template v-else>
                <q-input v-model="loginDraft.account" dark outlined dense label="账号 / 邮箱" @keyup.enter="login" />
                <q-input v-model="loginDraft.password" dark outlined dense type="password" label="密码" @keyup.enter="login" />
                <q-btn color="primary" icon="login" :loading="loggingIn" label="登录 User Center" @click="login" />
                <p class="runtime-message">登录后重新 Connect Internal，lease 切到登录段并可命中定向发版。</p>
              </template>
            </section>

            <section class="surface-panel config-panel">
              <div class="panel-heading">
                <div>
                  <p class="qp-kicker">CONFIG</p>
                  <h3>测试连接</h3>
                </div>
              </div>
              <q-input v-model="draft.baseUrl" dark outlined dense label="MX Server (VIP, in-tunnel)" @blur="saveConfig" />
              <q-input
                v-model="bootstrapDraft"
                dark
                outlined
                dense
                label="Bootstrap URLs (首连入口，逗号分隔)"
                hint="隧道未建立时走这里；留空则用 .env 的 LUOPAN_BOOTSTRAP_URLS"
                @blur="saveConfig"
              />
              <q-input v-model="draft.deviceLabel" dark outlined dense label="Device label" @blur="saveConfig" />
              <div class="config-pair">
                <span>App ID</span>
                <strong>{{ runtime.config.productId }}</strong>
              </div>
              <div class="config-pair config-pair--copy" role="button" tabindex="0" @click="copyInstallId">
                <span>Install</span>
                <strong>{{ shortId(runtime.installId) }} <q-icon name="content_copy" size="14px" /></strong>
                <q-tooltip>点击复制完整 installId（发版定向 target-install 用）</q-tooltip>
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
import { copyToClipboard, useQuasar, type QTableColumn } from 'quasar';

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
    baseUrl: 'http://10.88.100.3:18090',
    bootstrapUrls: [],
    productId: 'luopan',
    mode: 'standalone',
    sdkTestMode: false,
    deviceLabel: 'Luopan Quasar Demo'
  },
  identity: {
    kind: 'anonymous',
    userId: null,
    displayName: null,
    account: null,
    scopes: [],
    tokenExpiresAt: null,
    loginAt: null,
    tokenPresent: false
  },
  connection: {
    status: 'idle',
    bootstrapBaseUrl: null,
    leaseIp: null,
    serviceVip: null,
    dnsServer: null,
    routeCidrs: [],
    snapshotDigest: null,
    dataPlane: null,
    message: 'Renderer fallback mode. Start with Quasar Electron to use launcher IPC.',
    updatedAt: null
  },
  update: {
    status: 'idle',
    checkedAt: null,
    currentVersion: '0.0.0',
    targetVersion: null,
    releaseId: null,
    releaseNotes: null,
    matchedBy: null,
    featureFlags: [],
    artifacts: [],
    execution: [],
    message: 'Release Center not checked yet.'
  },
  events: []
};

const runtime = ref<LuopanRuntimeState>(fallbackRuntime);
const draft = reactive<LuopanRuntimeConfig>({ ...fallbackRuntime.config });
const bootstrapDraft = ref('');
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

const artifactColumns: QTableColumn[] = [
  { name: 'artifactClass', label: '类型', field: 'artifactClass', align: 'left' },
  { name: 'kind', label: 'Kind', field: 'kind', align: 'left' },
  { name: 'version', label: '版本', field: 'version', align: 'left' },
  { name: 'activation', label: '激活', field: 'activation', align: 'left' },
  { name: 'sizeBytes', label: '大小', field: 'sizeBytes', align: 'right', format: (value: number | null) => (value ? `${(value / 1024 / 1024).toFixed(1)} MB` : '-') }
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
  bootstrapDraft.value = next.config.bootstrapUrls.join(', ');
}

async function getRuntime() {
  const next = await window.luopanLauncher?.getRuntime();
  if (next) applyRuntime(next);
}

async function saveConfig() {
  const next = await window.luopanLauncher?.saveConfig({
    ...draft,
    bootstrapUrls: bootstrapDraft.value.split(/[\s,;]+/).filter(Boolean)
  });
  if (next) applyRuntime(next);
}

async function connectTestMode() {
  const next = await window.luopanLauncher?.connectTestMode();
  if (next) applyRuntime(next);
  if (next?.connection.status === 'error') {
    $q.notify({ type: 'negative', message: next.connection.message || 'Launcher request failed' });
  }
}

async function connectInternal() {
  const next = await window.luopanLauncher?.connectInternal();
  if (next) applyRuntime(next);
  if (next?.connection.status === 'error') {
    $q.notify({ type: 'negative', message: next.connection.message || 'Connect Internal failed' });
  } else if (next?.connection.status === 'network-ready') {
    $q.notify({ type: 'positive', message: `Connected: lease ${next.connection.leaseIp}, service VIP ${next.connection.serviceVip} reachable.` });
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

const loginDraft = reactive({ account: '', password: '' });
const loggingIn = ref(false);
const updateBusy = ref(false);

async function login() {
  if (!loginDraft.account || !loginDraft.password) {
    $q.notify({ type: 'warning', message: '请输入账号和密码。' });
    return;
  }
  loggingIn.value = true;
  try {
    const next = await window.luopanLauncher?.login({ ...loginDraft });
    if (next) applyRuntime(next);
    if (next?.identity.kind === 'user') {
      loginDraft.password = '';
      $q.notify({ type: 'positive', message: `已登录 ${next.identity.displayName || next.identity.userId}。重新 Connect Internal 可切换到登录 lease 段。` });
    } else {
      $q.notify({ type: 'negative', message: next?.events[0] || '登录失败' });
    }
  } finally {
    loggingIn.value = false;
  }
}

async function logout() {
  const next = await window.luopanLauncher?.logout();
  if (next) applyRuntime(next);
}

async function checkUpdates() {
  updateBusy.value = true;
  try {
    const next = await window.luopanLauncher?.checkUpdates();
    if (next) applyRuntime(next);
  } finally {
    updateBusy.value = false;
  }
}

async function applyUpdate() {
  updateBusy.value = true;
  try {
    const next = await window.luopanLauncher?.applyUpdate();
    if (next) applyRuntime(next);
  } finally {
    updateBusy.value = false;
  }
}

async function openStagedInstaller() {
  const next = await window.luopanLauncher?.openStagedInstaller();
  if (next) applyRuntime(next);
}

async function rollbackUpdateSlot(slot: 'config' | 'renderer') {
  const next = await window.luopanLauncher?.rollbackUpdateSlot(slot);
  if (next) applyRuntime(next);
}

const updateStatusColor = computed(() => {
  const status = runtime.value.update.status;
  if (status === 'update-available') return 'warning';
  if (status === 'up-to-date') return 'positive';
  if (status === 'failed' || status === 'blocked') return 'negative';
  return 'grey-6';
});

const hasInstallerArtifact = computed(() =>
  runtime.value.update.artifacts.some((artifact) => artifact.artifactClass === 'installer')
);

async function openAdmin() {
  await window.luopanLauncher?.openAdmin();
}

async function openInternalEntry() {
  await window.luopanLauncher?.openInternalEntry();
}

async function copyInstallId() {
  if (!runtime.value.installId || runtime.value.installId === '-') return;
  await copyToClipboard(runtime.value.installId);
  $q.notify({ type: 'positive', message: `installId 已复制: ${runtime.value.installId}` });
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
