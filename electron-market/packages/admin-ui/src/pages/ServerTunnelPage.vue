<template>
  <q-page class="content-panel tunnel-page">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">Tunnel 控制面</div>
      <q-space />
      <q-btn flat round icon="refresh" :loading="loading" @click="reload">
        <q-tooltip>刷新</q-tooltip>
      </q-btn>
    </div>

    <div v-if="loading && !overview" class="text-grey-7">加载中...</div>
    <q-banner v-else-if="error" class="bg-negative text-white q-mb-md">
      {{ error }}
    </q-banner>

    <template v-if="overview">
      <div class="stats-grid q-mb-md">
        <div class="stat-tile">
          <div class="stat-value">{{ overview.nodes.length }}</div>
          <div class="stat-label">O 节点</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">{{ overview.accounts.length }}</div>
          <div class="stat-label">Tunnel 账号</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">{{ pendingAccounts }}</div>
          <div class="stat-label">待同步账号</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">{{ overview.policies.length }}</div>
          <div class="stat-label">策略</div>
        </div>
      </div>

      <div class="form-grid q-mb-lg">
        <q-card flat bordered>
          <q-card-section class="row items-center q-pb-sm">
            <div class="section-title">Oversea 节点</div>
            <q-space />
            <q-btn v-if="nodeForm.id" flat dense icon="add" label="新建" @click="resetNodeForm" />
          </q-card-section>
          <q-card-section class="q-gutter-md">
            <q-input v-model="nodeForm.name" outlined dense label="名称" />
            <q-input v-model="nodeForm.publicHost" outlined dense label="公网 IP / 域名" />
            <q-input v-model="nodeForm.serverPorts" outlined dense label="Hysteria2 UDP 端口" />
            <q-input v-model="nodeForm.runnerUrl" outlined dense label="Runner URL" />
            <q-input v-model="nodeForm.runnerToken" outlined dense label="Runner Token" type="password" />
            <q-btn color="primary" icon="save" label="保存节点" :loading="savingNode" @click="submitNode" />
          </q-card-section>
        </q-card>

        <q-card flat bordered>
          <q-card-section class="row items-center q-pb-sm">
            <div class="section-title">策略</div>
            <q-space />
            <q-btn v-if="policyForm.id" flat dense icon="add" label="新建" @click="resetPolicyForm" />
          </q-card-section>
          <q-card-section class="q-gutter-md">
            <q-input v-model="policyForm.name" outlined dense label="名称" />
            <q-select
              v-model="policyForm.routingMode"
              outlined
              dense
              :options="routingModes"
              label="路由"
            />
            <q-select
              v-model="policyForm.runtimeMode"
              outlined
              dense
              :options="runtimeModes"
              label="客户端模式"
            />
            <q-toggle v-model="policyForm.isDefault" label="默认策略" />
            <q-input v-model="policyForm.rulesJson" outlined dense type="textarea" autogrow label="规则 JSON" />
            <q-btn color="primary" icon="policy" label="保存策略" :loading="savingPolicy" @click="submitPolicy" />
          </q-card-section>
        </q-card>

        <q-card flat bordered>
          <q-card-section class="row items-center q-pb-sm">
            <div class="section-title">发放账号</div>
          </q-card-section>
          <q-card-section class="q-gutter-md">
            <q-select
              v-model="accountForm.userId"
              outlined
              dense
              emit-value
              map-options
              :options="userOptions"
              label="用户"
            />
            <q-select
              v-model="accountForm.nodeId"
              outlined
              dense
              emit-value
              map-options
              :options="nodeOptions"
              label="O 节点"
            />
            <q-select
              v-model="accountForm.policyId"
              outlined
              dense
              emit-value
              map-options
              :options="policyOptions"
              label="策略"
            />
            <q-input v-model="accountForm.username" outlined dense label="Tunnel 用户名" />
            <div class="row q-col-gutter-sm">
              <div class="col">
                <q-input v-model="accountForm.downRate" outlined dense label="下载限速" />
              </div>
              <div class="col">
                <q-input v-model="accountForm.upRate" outlined dense label="上传限速" />
              </div>
            </div>
            <q-btn color="primary" icon="vpn_key" label="发放 Tunnel" :loading="savingAccount" @click="submitAccount" />
          </q-card-section>
        </q-card>
      </div>

      <q-table
        class="q-mb-lg"
        :rows="overview.nodes"
        :columns="nodeColumns"
        row-key="id"
        flat
        bordered
        dense
        :pagination="{ rowsPerPage: 8 }"
      >
        <template #body-cell-status="props">
          <q-td :props="props">
            <q-badge :color="statusColor(props.value)" :label="props.value" />
          </q-td>
        </template>
        <template #body-cell-revision="props">
          <q-td :props="props">
            {{ props.row.appliedRevision ?? '-' }} / {{ props.row.desiredRevision }}
          </q-td>
        </template>
        <template #body-cell-actions="props">
          <q-td :props="props" class="q-gutter-xs">
            <q-btn dense flat icon="edit" @click="editNode(props.row)">
              <q-tooltip>编辑节点</q-tooltip>
            </q-btn>
            <q-btn
              dense
              color="primary"
              icon="sync"
              :loading="reconcilingNodeId === props.row.id"
              @click="reconcileNode(props.row.id)"
            >
              <q-tooltip>同步到 O</q-tooltip>
            </q-btn>
          </q-td>
        </template>
      </q-table>

      <q-table
        class="q-mb-lg"
        :rows="overview.accounts"
        :columns="accountColumns"
        row-key="id"
        flat
        bordered
        dense
        :pagination="{ rowsPerPage: 12 }"
      >
        <template #body-cell-userId="props">
          <q-td :props="props">{{ userLabel(props.value) }}</q-td>
        </template>
        <template #body-cell-nodeId="props">
          <q-td :props="props">{{ nodeLabel(props.value) }}</q-td>
        </template>
        <template #body-cell-policyId="props">
          <q-td :props="props">{{ policyLabel(props.value) }}</q-td>
        </template>
        <template #body-cell-status="props">
          <q-td :props="props">
            <q-badge :color="props.value === 'active' ? 'positive' : 'grey-7'" :label="props.value" />
          </q-td>
        </template>
        <template #body-cell-revision="props">
          <q-td :props="props">
            {{ props.row.appliedRevision ?? '-' }} / {{ props.row.desiredRevision }}
          </q-td>
        </template>
        <template #body-cell-subscriptionUrl="props">
          <q-td :props="props">
            <div class="url-cell">{{ props.value }}</div>
          </q-td>
        </template>
        <template #body-cell-actions="props">
          <q-td :props="props" class="q-gutter-xs">
            <q-btn dense flat icon="content_copy" @click="copySubscription(props.row.subscriptionUrl)">
              <q-tooltip>复制订阅</q-tooltip>
            </q-btn>
            <q-btn dense flat icon="restart_alt" color="warning" @click="rotateAccount(props.row.id)">
              <q-tooltip>轮换 token</q-tooltip>
            </q-btn>
          </q-td>
        </template>
      </q-table>

      <q-table
        :rows="overview.policies"
        :columns="policyColumns"
        row-key="id"
        flat
        bordered
        dense
        :pagination="{ rowsPerPage: 8 }"
      >
        <template #body-cell-enabled="props">
          <q-td :props="props">
            <q-badge :color="props.value ? 'positive' : 'grey-7'" :label="props.value ? 'enabled' : 'disabled'" />
          </q-td>
        </template>
        <template #body-cell-isDefault="props">
          <q-td :props="props">
            <q-icon v-if="props.value" name="check_circle" color="primary" size="20px" />
          </q-td>
        </template>
        <template #body-cell-actions="props">
          <q-td :props="props">
            <q-btn dense flat icon="edit" @click="editPolicy(props.row)">
              <q-tooltip>编辑策略</q-tooltip>
            </q-btn>
          </q-td>
        </template>
      </q-table>
    </template>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { Notify } from 'quasar';

import {
  useServerAdmin,
  type TunnelNodeRow,
  type TunnelOverview,
  type TunnelPolicyRow
} from 'src/composables/useServerAdmin';

const admin = useServerAdmin();

const overview = ref<TunnelOverview | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const savingNode = ref(false);
const savingPolicy = ref(false);
const savingAccount = ref(false);
const reconcilingNodeId = ref<string | null>(null);

const routingModes = ['cn-direct', 'global'];
const runtimeModes = ['system-tun', 'app-global', 'app-rule'];

const nodeForm = ref({
  id: '',
  name: 'oversea-1',
  publicHost: '',
  serverPorts: '52120-52159',
  runnerUrl: 'http://host.docker.internal:18081',
  runnerToken: ''
});

const policyForm = ref({
  id: '',
  name: 'default-cn-direct',
  routingMode: 'cn-direct' as TunnelPolicyRow['routingMode'],
  runtimeMode: 'system-tun' as TunnelPolicyRow['runtimeMode'],
  isDefault: true,
  rulesJson: '{\n  "rules": []\n}'
});

const accountForm = ref({
  userId: '',
  nodeId: '',
  policyId: '',
  username: '',
  downRate: '3 Mbps',
  upRate: '30 Mbps'
});

const nodeColumns = [
  { name: 'name', label: '节点', field: 'name', align: 'left' as const },
  { name: 'publicHost', label: '公网', field: 'publicHost', align: 'left' as const },
  { name: 'serverPorts', label: '端口', field: 'serverPorts', align: 'left' as const },
  { name: 'runnerUrl', label: 'Runner', field: 'runnerUrl', align: 'left' as const },
  { name: 'status', label: '状态', field: 'status', align: 'left' as const },
  { name: 'revision', label: '同步', field: 'desiredRevision', align: 'left' as const },
  { name: 'actions', label: '', field: 'id', align: 'right' as const }
];

const accountColumns = [
  { name: 'username', label: '账号', field: 'username', align: 'left' as const },
  { name: 'userId', label: '用户', field: 'userId', align: 'left' as const },
  { name: 'nodeId', label: '节点', field: 'nodeId', align: 'left' as const },
  { name: 'policyId', label: '策略', field: 'policyId', align: 'left' as const },
  { name: 'status', label: '状态', field: 'status', align: 'left' as const },
  { name: 'revision', label: '同步', field: 'desiredRevision', align: 'left' as const },
  { name: 'subscriptionUrl', label: '订阅 URL', field: 'subscriptionUrl', align: 'left' as const },
  { name: 'actions', label: '', field: 'id', align: 'right' as const }
];

const policyColumns = [
  { name: 'name', label: '策略', field: 'name', align: 'left' as const },
  { name: 'routingMode', label: '路由', field: 'routingMode', align: 'left' as const },
  { name: 'runtimeMode', label: '客户端模式', field: 'runtimeMode', align: 'left' as const },
  { name: 'enabled', label: '启用', field: 'enabled', align: 'left' as const },
  { name: 'isDefault', label: '默认', field: 'isDefault', align: 'left' as const },
  { name: 'actions', label: '', field: 'id', align: 'right' as const }
];

const userOptions = computed(() =>
  (overview.value?.users ?? []).map((user) => ({
    label: user.username ?? user.email ?? user.id,
    value: user.id
  }))
);
const nodeOptions = computed(() =>
  (overview.value?.nodes ?? []).map((node) => ({ label: node.name, value: node.id }))
);
const policyOptions = computed(() =>
  (overview.value?.policies ?? []).map((policy) => ({ label: policy.name, value: policy.id }))
);
const pendingAccounts = computed(() =>
  (overview.value?.accounts ?? []).filter((row) => row.appliedRevision !== row.desiredRevision).length
);

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    overview.value = await admin.getTunnelOverview();
    hydrateDefaults();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function hydrateDefaults(): void {
  const data = overview.value;
  if (!data) return;
  if (!accountForm.value.userId && data.users[0]) accountForm.value.userId = data.users[0].id;
  if (!accountForm.value.nodeId && data.nodes[0]) accountForm.value.nodeId = data.nodes[0].id;
  if (!accountForm.value.policyId && data.policies[0]) accountForm.value.policyId = data.policies[0].id;
  const defaultPolicy = data.policies.find((row) => row.isDefault) ?? data.policies[0];
  if (!policyForm.value.id && defaultPolicy) editPolicy(defaultPolicy);
  const firstNode = data.nodes[0];
  if (!nodeForm.value.id && firstNode) editNode(firstNode);
}

function resetNodeForm(): void {
  nodeForm.value = {
    id: '',
    name: 'oversea-1',
    publicHost: '',
    serverPorts: '52120-52159',
    runnerUrl: 'http://host.docker.internal:18081',
    runnerToken: ''
  };
}

function editNode(row: TunnelNodeRow): void {
  nodeForm.value = {
    id: row.id,
    name: row.name,
    publicHost: row.publicHost,
    serverPorts: row.serverPorts ?? '52120-52159',
    runnerUrl: row.runnerUrl ?? '',
    runnerToken: ''
  };
}

async function submitNode(): Promise<void> {
  if (!nodeForm.value.name.trim() || !nodeForm.value.publicHost.trim()) return;
  savingNode.value = true;
  try {
    const body: Parameters<typeof admin.upsertTunnelNode>[0] = {
      id: nodeForm.value.id || undefined,
      name: nodeForm.value.name,
      publicHost: nodeForm.value.publicHost,
      runnerUrl: nodeForm.value.runnerUrl || null,
      serverPorts: nodeForm.value.serverPorts || null
    };
    if (nodeForm.value.runnerToken.trim()) body.runnerToken = nodeForm.value.runnerToken;
    await admin.upsertTunnelNode(body);
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    savingNode.value = false;
  }
}

function resetPolicyForm(): void {
  policyForm.value = {
    id: '',
    name: 'default-cn-direct',
    routingMode: 'cn-direct',
    runtimeMode: 'system-tun',
    isDefault: false,
    rulesJson: '{\n  "rules": []\n}'
  };
}

function editPolicy(row: TunnelPolicyRow): void {
  policyForm.value = {
    id: row.id,
    name: row.name,
    routingMode: row.routingMode,
    runtimeMode: row.runtimeMode,
    isDefault: row.isDefault,
    rulesJson: JSON.stringify(row.rules ?? { rules: [] }, null, 2)
  };
}

async function submitPolicy(): Promise<void> {
  if (!policyForm.value.name.trim()) return;
  savingPolicy.value = true;
  try {
    await admin.upsertTunnelPolicy({
      id: policyForm.value.id || undefined,
      name: policyForm.value.name,
      routingMode: policyForm.value.routingMode,
      runtimeMode: policyForm.value.runtimeMode,
      isDefault: policyForm.value.isDefault,
      rules: parseJson(policyForm.value.rulesJson)
    });
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    savingPolicy.value = false;
  }
}

async function submitAccount(): Promise<void> {
  if (!accountForm.value.userId) return;
  savingAccount.value = true;
  try {
    await admin.provisionTunnelAccount({
      userId: accountForm.value.userId,
      nodeId: accountForm.value.nodeId || null,
      policyId: accountForm.value.policyId || null,
      username: accountForm.value.username || null,
      downRate: accountForm.value.downRate || null,
      upRate: accountForm.value.upRate || null
    });
    accountForm.value.username = '';
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    savingAccount.value = false;
  }
}

async function reconcileNode(id: string): Promise<void> {
  reconcilingNodeId.value = id;
  error.value = null;
  try {
    await admin.reconcileTunnelNode(id);
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    reconcilingNodeId.value = null;
  }
}

async function rotateAccount(id: string): Promise<void> {
  try {
    await admin.rotateTunnelAccountToken(id);
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function copySubscription(url: string): Promise<void> {
  await navigator.clipboard.writeText(url);
  Notify.create({ message: '订阅 URL 已复制', color: 'positive', position: 'top-right', timeout: 1600 });
}

function parseJson(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('规则 JSON 必须是对象');
  }
  return parsed as Record<string, unknown>;
}

function userLabel(id: string | null): string {
  if (!id) return '-';
  const user = overview.value?.users.find((row) => row.id === id);
  return user?.username ?? user?.email ?? id;
}

function nodeLabel(id: string | null): string {
  if (!id) return '-';
  return overview.value?.nodes.find((row) => row.id === id)?.name ?? id;
}

function policyLabel(id: string | null): string {
  if (!id) return '-';
  return overview.value?.policies.find((row) => row.id === id)?.name ?? id;
}

function statusColor(status: string): string {
  if (status === 'online') return 'positive';
  if (status === 'error') return 'negative';
  if (status === 'offline') return 'warning';
  return 'grey-7';
}

onMounted(reload);
</script>

<style scoped lang="scss">
.tunnel-page {
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }

  .stat-tile {
    border: 1px solid #dce3ea;
    border-radius: 8px;
    padding: 14px 16px;
    background: white;
  }

  .stat-value {
    font-size: 28px;
    line-height: 1.1;
    font-weight: 800;
  }

  .stat-label {
    color: #667085;
    margin-top: 4px;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
  }

  .section-title {
    font-size: 16px;
    font-weight: 800;
  }

  .url-cell {
    max-width: 420px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 12px;
  }
}

@media (max-width: 1200px) {
  .tunnel-page {
    .form-grid {
      grid-template-columns: 1fr;
    }

    .stats-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
}
</style>
