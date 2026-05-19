<template>
  <q-page class="content-panel hdo-page">
    <div class="toolbar-row q-mb-md">
      <div>
        <div class="page-title">HDO 控制面</div>
        <div class="text-caption text-grey-7">Mesh 许可、设备插件清单和远程任务</div>
      </div>
      <q-space />
      <q-btn flat round icon="refresh" :loading="loading" @click="reload">
        <q-tooltip>刷新</q-tooltip>
      </q-btn>
    </div>

    <div v-if="loading && !overview" class="text-grey-7">加载中…</div>
    <q-banner v-else-if="error" class="bg-negative text-white q-mb-md">
      {{ error }}
    </q-banner>

    <template v-if="overview">
      <div class="metric-grid q-mb-md">
        <div class="section-surface metric-tile q-pa-md">
          <strong>{{ activeMemberships.length }}</strong>
          <span>有效 mesh 许可</span>
        </div>
        <div class="section-surface metric-tile q-pa-md">
          <strong>{{ overview.devices.length }}</strong>
          <span>已注册设备</span>
        </div>
        <div class="section-surface metric-tile q-pa-md">
          <strong>{{ overview.pluginStates.length }}</strong>
          <span>已上报插件</span>
        </div>
        <div class="section-surface metric-tile q-pa-md">
          <strong>{{ pendingTasks.length }}</strong>
          <span>待处理任务</span>
        </div>
      </div>

      <q-tabs
        v-model="tab"
        dense
        no-caps
        align="left"
        active-color="primary"
        indicator-color="primary"
        class="section-surface q-mb-md"
      >
        <q-tab name="mesh" icon="hub" label="Mesh" />
        <q-tab name="licenses" icon="verified_user" label="许可" />
        <q-tab name="devices" icon="devices" label="设备" />
        <q-tab name="tasks" icon="send_to_mobile" label="任务" />
      </q-tabs>

      <q-tab-panels v-model="tab" animated class="bg-transparent">
        <q-tab-panel name="mesh" class="q-pa-none">
          <div class="split-layout">
            <section class="section-surface q-pa-md">
              <div class="section-title">创建 / 更新 mesh 组</div>
              <q-input v-model="meshName" outlined dense label="名称" class="q-mb-sm" />
              <q-input v-model="meshSlug" outlined dense label="slug（可空）" class="q-mb-sm" />
              <q-select
                v-model="meshDefaultProfileId"
                outlined
                dense
                emit-value
                map-options
                clearable
                :options="profileOptions"
                label="默认路由 profile"
                class="q-mb-sm"
              />
              <q-input
                v-model="meshDescription"
                outlined
                dense
                type="textarea"
                label="描述"
                class="q-mb-sm"
              />
              <div class="toolbar-row">
                <q-toggle v-model="meshEnabled" label="启用" />
                <q-space />
                <q-btn color="primary" icon="save" label="保存 mesh" @click="saveMeshGroup" />
              </div>
            </section>

            <section class="section-surface q-pa-md">
              <div class="toolbar-row q-mb-sm">
                <div class="section-title">Mesh 组</div>
                <q-space />
                <q-btn
                  flat
                  dense
                  icon="add"
                  label="默认组"
                  @click="createDefaultMesh"
                />
              </div>
              <q-table
                :rows="overview.meshGroups"
                :columns="meshColumns"
                row-key="id"
                flat
                bordered
                dense
                :pagination="{ rowsPerPage: 8 }"
              >
                <template #body-cell-enabled="props">
                  <q-td :props="props">
                    <q-badge :color="props.value ? 'positive' : 'grey-6'" :label="props.value ? '启用' : '停用'" />
                  </q-td>
                </template>
                <template #body-cell-actions="props">
                  <q-td :props="props">
                    <q-btn flat dense round icon="edit" @click="editMesh(props.row)">
                      <q-tooltip>编辑</q-tooltip>
                    </q-btn>
                  </q-td>
                </template>
              </q-table>
            </section>
          </div>
        </q-tab-panel>

        <q-tab-panel name="licenses" class="q-pa-none">
          <div class="split-layout">
            <section class="section-surface q-pa-md">
              <div class="section-title">发放 mesh 许可</div>
              <q-select
                v-model="membershipUserId"
                outlined
                dense
                emit-value
                map-options
                :options="userOptions"
                label="用户"
                class="q-mb-sm"
              />
              <q-select
                v-model="membershipMeshGroupId"
                outlined
                dense
                emit-value
                map-options
                :options="meshOptions"
                label="mesh 组"
                class="q-mb-sm"
              />
              <q-select
                v-model="membershipRole"
                outlined
                dense
                :options="['member', 'admin', 'support']"
                label="角色"
                class="q-mb-sm"
              />
              <q-select
                v-model="membershipStatus"
                outlined
                dense
                :options="['active', 'suspended', 'revoked']"
                label="状态"
                class="q-mb-sm"
              />
              <q-select
                v-model="membershipProfileId"
                outlined
                dense
                emit-value
                map-options
                clearable
                :options="profileOptions"
                label="覆盖 profile（可空）"
                class="q-mb-md"
              />
              <q-btn color="primary" icon="verified_user" label="保存许可" @click="saveMembership" />
            </section>

            <section class="section-surface q-pa-md">
              <div class="section-title q-mb-sm">许可列表</div>
              <q-table
                :rows="membershipRows"
                :columns="membershipColumns"
                row-key="id"
                flat
                bordered
                dense
                :pagination="{ rowsPerPage: 12 }"
              >
                <template #body-cell-status="props">
                  <q-td :props="props">
                    <q-badge :color="statusColor(props.value)" :label="props.value" />
                  </q-td>
                </template>
              </q-table>
            </section>
          </div>
        </q-tab-panel>

        <q-tab-panel name="devices" class="q-pa-none">
          <div class="section-surface q-pa-md q-mb-md">
            <div class="section-title q-mb-sm">设备</div>
            <q-table
              :rows="deviceRows"
              :columns="deviceColumns"
              row-key="id"
              flat
              bordered
              dense
              :pagination="{ rowsPerPage: 12 }"
            />
          </div>
          <div class="section-surface q-pa-md">
            <div class="section-title q-mb-sm">设备插件清单</div>
            <q-table
              :rows="pluginRows"
              :columns="pluginColumns"
              row-key="id"
              flat
              bordered
              dense
              :pagination="{ rowsPerPage: 16 }"
            />
          </div>
        </q-tab-panel>

        <q-tab-panel name="tasks" class="q-pa-none">
          <div class="split-layout">
            <section class="section-surface q-pa-md">
              <div class="section-title">创建远程任务</div>
              <q-select
                v-model="taskUserId"
                outlined
                dense
                emit-value
                map-options
                :options="userOptions"
                label="用户"
                class="q-mb-sm"
                @update:model-value="taskDeviceId = null"
              />
              <q-select
                v-model="taskDeviceId"
                outlined
                dense
                emit-value
                map-options
                clearable
                :options="taskDeviceOptions"
                label="设备（可空，空表示用户级任务）"
                class="q-mb-sm"
              />
              <q-select
                v-model="taskKind"
                outlined
                dense
                :options="taskKinds"
                label="任务类型"
                class="q-mb-sm"
              />
              <q-input v-model="taskPluginId" outlined dense label="插件 ID / npm（可空）" class="q-mb-sm" />
              <q-input
                v-model="taskPayloadText"
                outlined
                dense
                type="textarea"
                label="payload JSON（可空）"
                placeholder='安装并激活示例：{"autoGrant":"manifest","activate":true}'
                class="q-mb-md"
              />
              <q-btn color="primary" icon="send" label="创建任务" @click="createTask" />
            </section>

            <section class="section-surface q-pa-md">
              <div class="section-title q-mb-sm">任务列表</div>
              <q-table
                :rows="taskRows"
                :columns="taskColumns"
                row-key="id"
                flat
                bordered
                dense
                :pagination="{ rowsPerPage: 12 }"
              >
                <template #body-cell-status="props">
                  <q-td :props="props">
                    <q-badge :color="taskStatusColor(props.value)" :label="props.value" />
                  </q-td>
                </template>
              </q-table>
            </section>
          </div>
        </q-tab-panel>
      </q-tab-panels>
    </template>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

import {
  useServerAdmin,
  type HdoDeviceRow,
  type HdoDeviceTaskRow,
  type HdoMeshGroupRow,
  type HdoOverview
} from 'src/composables/useServerAdmin';

const admin = useServerAdmin();

const overview = ref<HdoOverview | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const tab = ref('mesh');

const editingMeshId = ref<string | null>(null);
const meshName = ref('');
const meshSlug = ref('');
const meshDescription = ref('');
const meshDefaultProfileId = ref<string | null>(null);
const meshEnabled = ref(true);

const membershipUserId = ref<string | null>(null);
const membershipMeshGroupId = ref<string | null>(null);
const membershipRole = ref<'member' | 'admin' | 'support'>('member');
const membershipStatus = ref<'active' | 'suspended' | 'revoked'>('active');
const membershipProfileId = ref<string | null>(null);

const taskUserId = ref<string | null>(null);
const taskDeviceId = ref<string | null>(null);
const taskKind = ref<HdoDeviceTaskRow['kind']>('install-plugin');
const taskPluginId = ref('');
const taskPayloadText = ref('');
const taskKinds: HdoDeviceTaskRow['kind'][] = [
  'install-plugin',
  'uninstall-plugin',
  'activate-plugin',
  'deactivate-plugin',
  'apply-hdo-profile'
];

const meshColumns = [
  { name: 'name', label: '名称', field: 'name', align: 'left' as const },
  { name: 'slug', label: 'slug', field: 'slug', align: 'left' as const },
  { name: 'enabled', label: '状态', field: 'enabled', align: 'left' as const },
  { name: 'defaultProfileId', label: '默认 profile', field: 'defaultProfileId', align: 'left' as const },
  { name: 'actions', label: '', field: 'id', align: 'right' as const }
];

const membershipColumns = [
  { name: 'user', label: '用户', field: 'userLabel', align: 'left' as const },
  { name: 'mesh', label: 'mesh', field: 'meshLabel', align: 'left' as const },
  { name: 'role', label: '角色', field: 'role', align: 'left' as const },
  { name: 'status', label: '状态', field: 'status', align: 'left' as const },
  { name: 'profileId', label: 'profile', field: 'profileId', align: 'left' as const },
  { name: 'updatedAt', label: '更新时间', field: 'updatedAt', align: 'left' as const }
];

const deviceColumns = [
  { name: 'label', label: '设备', field: 'label', align: 'left' as const },
  { name: 'user', label: '用户', field: 'userLabel', align: 'left' as const },
  { name: 'platform', label: '平台', field: 'platform', align: 'left' as const },
  { name: 'overlayIp', label: 'Overlay IP', field: 'overlayIp', align: 'left' as const },
  { name: 'status', label: '状态', field: 'status', align: 'left' as const },
  { name: 'plugins', label: '插件数', field: 'pluginCount', align: 'right' as const },
  { name: 'lastSeenAt', label: '最后在线', field: 'lastSeenAt', align: 'left' as const }
];

const pluginColumns = [
  { name: 'pluginId', label: '插件', field: 'pluginId', align: 'left' as const },
  { name: 'device', label: '设备', field: 'deviceLabel', align: 'left' as const },
  { name: 'user', label: '用户', field: 'userLabel', align: 'left' as const },
  { name: 'version', label: '版本', field: 'version', align: 'left' as const },
  { name: 'state', label: '状态', field: 'state', align: 'left' as const },
  { name: 'lastSeenAt', label: '最后上报', field: 'lastSeenAt', align: 'left' as const }
];

const taskColumns = [
  { name: 'kind', label: '类型', field: 'kind', align: 'left' as const },
  { name: 'status', label: '状态', field: 'status', align: 'left' as const },
  { name: 'user', label: '用户', field: 'userLabel', align: 'left' as const },
  { name: 'device', label: '设备', field: 'deviceLabel', align: 'left' as const },
  { name: 'pluginId', label: '插件', field: 'pluginId', align: 'left' as const },
  { name: 'createdAt', label: '创建时间', field: 'createdAt', align: 'left' as const }
];

const usersById = computed(() => new Map((overview.value?.users ?? []).map((row) => [row.id, row])));
const meshById = computed(() => new Map((overview.value?.meshGroups ?? []).map((row) => [row.id, row])));
const devicesById = computed(() => new Map((overview.value?.devices ?? []).map((row) => [row.id, row])));

const userOptions = computed(() =>
  (overview.value?.users ?? []).map((row) => ({
    label: row.displayName || row.username || row.email || row.id,
    value: row.id
  }))
);

const meshOptions = computed(() =>
  (overview.value?.meshGroups ?? []).map((row) => ({ label: `${row.name} (${row.slug})`, value: row.id }))
);

const profileOptions = computed(() =>
  (overview.value?.profiles ?? []).map((row) => ({ label: `${row.name} / ${row.mode}`, value: row.id }))
);

const activeMemberships = computed(() =>
  (overview.value?.memberships ?? []).filter((row) => row.status === 'active')
);

const pendingTasks = computed(() =>
  (overview.value?.tasks ?? []).filter((row) => row.status === 'pending' || row.status === 'claimed')
);

const membershipRows = computed(() =>
  (overview.value?.memberships ?? []).map((row) => ({
    ...row,
    userLabel: userLabel(row.userId),
    meshLabel: meshById.value.get(row.meshGroupId)?.name ?? row.meshGroupId
  }))
);

const deviceRows = computed(() =>
  (overview.value?.devices ?? []).map((row) => ({
    ...row,
    userLabel: userLabel(row.userId),
    pluginCount: (overview.value?.pluginStates ?? []).filter((plugin) => plugin.deviceId === row.id).length
  }))
);

const pluginRows = computed(() =>
  (overview.value?.pluginStates ?? []).map((row) => {
    const device = devicesById.value.get(row.deviceId);
    return {
      ...row,
      deviceLabel: device?.label ?? row.deviceId,
      userLabel: device ? userLabel(device.userId) : ''
    };
  })
);

const taskRows = computed(() =>
  (overview.value?.tasks ?? []).map((row) => ({
    ...row,
    userLabel: userLabel(row.userId),
    deviceLabel: row.deviceId ? devicesById.value.get(row.deviceId)?.label ?? row.deviceId : '用户级'
  }))
);

const taskDeviceOptions = computed(() =>
  (overview.value?.devices ?? [])
    .filter((row) => !taskUserId.value || row.userId === taskUserId.value)
    .map((row) => ({ label: `${row.label} / ${row.platform ?? row.id}`, value: row.id }))
);

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    overview.value = await admin.getHdoOverview();
    if (!membershipUserId.value) membershipUserId.value = overview.value.users[0]?.id ?? null;
    if (!taskUserId.value) taskUserId.value = overview.value.users[0]?.id ?? null;
    if (!membershipMeshGroupId.value) membershipMeshGroupId.value = overview.value.meshGroups[0]?.id ?? null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function createDefaultMesh(): Promise<void> {
  try {
    await admin.upsertHdoMeshGroup({
      name: '默认组织网络',
      slug: 'default',
      description: '默认 HDO mesh 组，用于给普通用户发放入网许可。',
      enabled: true
    });
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function saveMeshGroup(): Promise<void> {
  if (!meshName.value.trim()) return;
  try {
    await admin.upsertHdoMeshGroup({
      id: editingMeshId.value ?? undefined,
      name: meshName.value.trim(),
      slug: meshSlug.value.trim() || null,
      description: meshDescription.value.trim() || null,
      defaultProfileId: meshDefaultProfileId.value,
      enabled: meshEnabled.value
    });
    resetMeshForm();
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function editMesh(row: HdoMeshGroupRow): void {
  editingMeshId.value = row.id;
  meshName.value = row.name;
  meshSlug.value = row.slug;
  meshDescription.value = row.description ?? '';
  meshDefaultProfileId.value = row.defaultProfileId;
  meshEnabled.value = row.enabled;
}

function resetMeshForm(): void {
  editingMeshId.value = null;
  meshName.value = '';
  meshSlug.value = '';
  meshDescription.value = '';
  meshDefaultProfileId.value = null;
  meshEnabled.value = true;
}

async function saveMembership(): Promise<void> {
  if (!membershipUserId.value || !membershipMeshGroupId.value) return;
  try {
    await admin.upsertHdoMembership({
      userId: membershipUserId.value,
      meshGroupId: membershipMeshGroupId.value,
      role: membershipRole.value,
      status: membershipStatus.value,
      profileId: membershipProfileId.value
    });
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function createTask(): Promise<void> {
  if (!taskUserId.value) return;
  try {
    await admin.createHdoDeviceTask({
      userId: taskUserId.value,
      deviceId: taskDeviceId.value,
      kind: taskKind.value,
      pluginId: taskPluginId.value.trim() || null,
      payload: parsePayload()
    });
    taskPluginId.value = '';
    taskPayloadText.value = '';
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function parsePayload(): Record<string, unknown> | null {
  const text = taskPayloadText.value.trim();
  if (!text) return null;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('payload 必须是 JSON object');
  }
  return parsed as Record<string, unknown>;
}

function userLabel(userId: string): string {
  const user = usersById.value.get(userId);
  return user?.displayName || user?.username || user?.email || userId;
}

function statusColor(status: string): string {
  return { active: 'positive', suspended: 'warning', revoked: 'negative' }[status] ?? 'grey-7';
}

function taskStatusColor(status: string): string {
  return {
    pending: 'warning',
    claimed: 'info',
    done: 'positive',
    failed: 'negative',
    cancelled: 'grey-7'
  }[status] ?? 'grey-7';
}

onMounted(reload);
</script>

<style scoped lang="scss">
.hdo-page {
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }

  .metric-tile {
    display: grid;
    gap: 4px;
  }

  .metric-tile strong {
    font-size: 28px;
    line-height: 1.1;
  }

  .metric-tile span {
    color: #667085;
  }

  .section-title {
    font-weight: 700;
    font-size: 16px;
    margin-bottom: 12px;
  }

  .split-layout {
    display: grid;
    grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
    gap: 16px;
  }

  @media (max-width: 980px) {
    .metric-grid,
    .split-layout {
      grid-template-columns: 1fr;
    }
  }
}
</style>
