<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">发版控制</div>
      <q-space />
      <q-btn color="primary" icon="rocket_launch" label="新建计划" @click="openCreate" />
      <q-btn flat round icon="refresh" @click="reload" />
    </div>

    <div v-if="loading" class="text-grey-7">加载中…</div>
    <q-banner v-else-if="error" class="bg-negative text-white">{{ error }}</q-banner>

    <template v-else>
      <q-table
        :rows="plans"
        :columns="planColumns"
        row-key="id"
        flat
        bordered
        dense
        class="q-mb-lg"
        :pagination="{ rowsPerPage: 20 }"
      >
        <template #body-cell-state="props">
          <q-td :props="props">
            <q-chip dense :color="stateColor(props.value)" text-color="white" :label="props.value" />
          </q-td>
        </template>
        <template #body-cell-target="props">
          <q-td :props="props">
            <div class="text-weight-medium">{{ props.row.targetId }}</div>
            <div class="text-caption text-grey-7">{{ props.row.targetKind }} → {{ props.row.targetVersion }}</div>
          </q-td>
        </template>
        <template #body-cell-rollout="props">
          <q-td :props="props">
            {{ props.row.rollout?.percentage ?? 100 }}%
            <span v-if="props.row.rollout?.platforms?.length" class="text-grey-7">
              · {{ props.row.rollout.platforms.join(',') }}
            </span>
          </q-td>
        </template>
        <template #body-cell-actions="props">
          <q-td :props="props">
            <q-btn flat dense round icon="edit" @click="openEdit(props.row)">
              <q-tooltip>编辑</q-tooltip>
            </q-btn>
            <q-btn
              v-if="props.row.state !== 'active'"
              flat
              dense
              round
              color="positive"
              icon="play_arrow"
              @click="setState(props.row.id, 'active')"
            >
              <q-tooltip>激活</q-tooltip>
            </q-btn>
            <q-btn
              v-if="props.row.state === 'active'"
              flat
              dense
              round
              color="warning"
              icon="pause"
              @click="setState(props.row.id, 'paused')"
            >
              <q-tooltip>暂停</q-tooltip>
            </q-btn>
            <q-btn
              flat
              dense
              round
              color="negative"
              icon="history"
              @click="setState(props.row.id, 'rolled_back')"
            >
              <q-tooltip>标记回滚</q-tooltip>
            </q-btn>
          </q-td>
        </template>
      </q-table>

      <div class="text-subtitle2 text-weight-bold q-mb-sm">最近客户端上报</div>
      <q-table
        :rows="reports"
        :columns="reportColumns"
        row-key="id"
        flat
        bordered
        dense
        :pagination="{ rowsPerPage: 20 }"
      >
        <template #body-cell-status="props">
          <q-td :props="props">
            <q-chip dense :color="reportColor(props.value)" text-color="white" :label="props.value" />
          </q-td>
        </template>
        <template #body-cell-version="props">
          <q-td :props="props">
            {{ props.row.fromVersion || '未安装' }} → {{ props.row.toVersion }}
          </q-td>
        </template>
        <template #body-cell-error="props">
          <q-td :props="props">
            <span class="text-negative text-caption">{{ props.value }}</span>
          </q-td>
        </template>
      </q-table>
    </template>

    <q-dialog v-model="editOpen">
      <q-card style="min-width: 620px">
        <q-card-section>
          <div class="text-h6">{{ editingId ? '编辑发版计划' : '新建发版计划' }}</div>
        </q-card-section>
        <q-card-section class="q-gutter-md">
          <div class="row q-col-gutter-md">
            <div class="col-6">
              <q-input v-model="formName" outlined dense label="名称" />
            </div>
            <div class="col-3">
              <q-select v-model="formTargetKind" outlined dense :options="targetKindOptions" label="目标" />
            </div>
            <div class="col-3">
              <q-input v-model.number="formPercentage" outlined dense type="number" label="灰度 %" />
            </div>
          </div>
          <q-input v-model="formTargetId" outlined dense label="插件 / 市场 id" />
          <div class="row q-col-gutter-md">
            <div class="col-6">
              <q-input v-model="formNpm" outlined dense label="npm 包名（可空）" />
            </div>
            <div class="col-3">
              <q-input v-model="formVersion" outlined dense label="目标版本" />
            </div>
            <div class="col-3">
              <q-input v-model="formChannel" outlined dense label="渠道" />
            </div>
          </div>
          <div class="row q-col-gutter-md">
            <div class="col-4">
              <q-select v-model="formMode" outlined dense :options="modeOptions" label="模式" />
            </div>
            <div class="col-4">
              <q-select v-model="formRestartPolicy" outlined dense :options="restartOptions" label="重启策略" />
            </div>
            <div class="col-4">
              <q-select v-model="formAutoGrant" outlined dense :options="autoGrantOptions" label="自动授权" />
            </div>
          </div>
          <q-toggle v-model="formAutoActivate" color="primary" label="应用后自动激活" />
          <div class="row q-col-gutter-md">
            <div class="col-6">
              <q-input v-model="formPlatforms" outlined dense label="平台过滤（逗号分隔，可空）" />
            </div>
            <div class="col-6">
              <q-input v-model="formInstallIds" outlined dense label="指定 installId（逗号分隔，可空）" />
            </div>
          </div>
          <q-input v-model="formNotes" outlined dense type="textarea" label="备注" />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="取消" v-close-popup />
          <q-btn color="primary" label="保存" :loading="saving" @click="save" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

import {
  useServerAdmin,
  type ReleaseMode,
  type ReleasePlan,
  type ReleasePlanState,
  type ReleaseTargetKind,
  type RestartPolicy,
  type UpdateReport
} from 'src/composables/useServerAdmin';

const admin = useServerAdmin();

const loading = ref(true);
const saving = ref(false);
const error = ref<string | null>(null);
const plans = ref<ReleasePlan[]>([]);
const reports = ref<UpdateReport[]>([]);
const editOpen = ref(false);
const editingId = ref<string | null>(null);

const formName = ref('');
const formTargetKind = ref<ReleaseTargetKind>('plugin');
const formTargetId = ref('');
const formNpm = ref('');
const formVersion = ref('');
const formChannel = ref('stable');
const formMode = ref<ReleaseMode>('auto');
const formRestartPolicy = ref<RestartPolicy>('plugin');
const formPercentage = ref(100);
const formAutoGrant = ref<'none' | 'manifest'>('none');
const formAutoActivate = ref(false);
const formPlatforms = ref('');
const formInstallIds = ref('');
const formNotes = ref('');

const targetKindOptions: ReleaseTargetKind[] = ['plugin', 'game', 'market'];
const modeOptions: ReleaseMode[] = ['manual', 'notify', 'auto', 'force', 'silent'];
const restartOptions: RestartPolicy[] = ['none', 'plugin', 'app', 'system'];
const autoGrantOptions: Array<'none' | 'manifest'> = ['none', 'manifest'];

const planColumns = [
  { name: 'name', label: '名称', field: 'name', align: 'left' as const },
  { name: 'target', label: '目标', field: 'targetId', align: 'left' as const },
  { name: 'mode', label: '模式', field: 'mode', align: 'left' as const },
  { name: 'restartPolicy', label: '重启', field: 'restartPolicy', align: 'left' as const },
  { name: 'rollout', label: '灰度', field: 'rollout', align: 'left' as const },
  { name: 'state', label: '状态', field: 'state', align: 'left' as const },
  { name: 'updatedAt', label: '更新时间', field: 'updatedAt', align: 'left' as const },
  { name: 'actions', label: '', field: 'id', align: 'right' as const }
];

const reportColumns = [
  { name: 'createdAt', label: '时间', field: 'createdAt', align: 'left' as const },
  { name: 'targetId', label: '目标', field: 'targetId', align: 'left' as const },
  { name: 'version', label: '版本', field: 'toVersion', align: 'left' as const },
  { name: 'status', label: '状态', field: 'status', align: 'left' as const },
  { name: 'installId', label: 'installId', field: 'installId', align: 'left' as const },
  { name: 'error', label: '错误', field: 'error', align: 'left' as const }
];

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const data = await admin.listReleasePlans();
    plans.value = data.plans;
    reports.value = data.reports;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  editingId.value = null;
  formName.value = '';
  formTargetKind.value = 'plugin';
  formTargetId.value = '';
  formNpm.value = '';
  formVersion.value = '';
  formChannel.value = 'stable';
  formMode.value = 'auto';
  formRestartPolicy.value = 'plugin';
  formPercentage.value = 100;
  formAutoGrant.value = 'none';
  formAutoActivate.value = false;
  formPlatforms.value = '';
  formInstallIds.value = '';
  formNotes.value = '';
  editOpen.value = true;
}

function openEdit(plan: ReleasePlan): void {
  editingId.value = plan.id;
  formName.value = plan.name;
  formTargetKind.value = plan.targetKind;
  formTargetId.value = plan.targetId;
  formNpm.value = plan.npm ?? '';
  formVersion.value = plan.targetVersion;
  formChannel.value = plan.channel;
  formMode.value = plan.mode;
  formRestartPolicy.value = plan.restartPolicy;
  formPercentage.value = plan.rollout?.percentage ?? 100;
  formAutoGrant.value = plan.autoGrant === 'manifest' ? 'manifest' : 'none';
  formAutoActivate.value = plan.autoActivate;
  formPlatforms.value = plan.rollout?.platforms?.join(',') ?? '';
  formInstallIds.value = plan.rollout?.installIds?.join(',') ?? '';
  formNotes.value = plan.notes ?? '';
  editOpen.value = true;
}

async function save(): Promise<void> {
  if (!formTargetId.value.trim() || !formVersion.value.trim()) return;
  saving.value = true;
  try {
    await admin.saveReleasePlan({
      id: editingId.value ?? undefined,
      name: formName.value || `${formTargetId.value}@${formVersion.value}`,
      targetKind: formTargetKind.value,
      targetId: formTargetId.value,
      npm: formNpm.value || null,
      targetVersion: formVersion.value,
      channel: formChannel.value || 'stable',
      mode: formMode.value,
      restartPolicy: formRestartPolicy.value,
      state: 'active',
      rollout: {
        percentage: Math.max(0, Math.min(100, Number(formPercentage.value) || 0)),
        platforms: csv(formPlatforms.value),
        installIds: csv(formInstallIds.value)
      },
      autoGrant: formAutoGrant.value === 'manifest' ? 'manifest' : null,
      autoActivate: formAutoActivate.value,
      notes: formNotes.value || null
    });
    editOpen.value = false;
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

async function setState(id: string, state: ReleasePlanState): Promise<void> {
  try {
    await admin.setReleasePlanState(id, state);
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function csv(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function stateColor(state: ReleasePlanState): string {
  return {
    draft: 'grey-7',
    active: 'positive',
    paused: 'warning',
    completed: 'info',
    rolled_back: 'negative'
  }[state];
}

function reportColor(status: UpdateReport['status']): string {
  return {
    seen: 'grey-7',
    applied: 'positive',
    failed: 'negative',
    skipped: 'warning',
    restart_required: 'info',
    awaiting_grant: 'warning'
  }[status];
}

onMounted(reload);
</script>
