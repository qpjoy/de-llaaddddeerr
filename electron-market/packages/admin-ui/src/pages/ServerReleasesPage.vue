<template>
  <q-page class="content-panel release-page">
    <div class="release-header q-mb-lg">
      <div>
        <div class="page-title">发版控制</div>
        <div class="page-subtitle">
          管理市场包、插件和游戏应用的稳定版、灰度、强制更新与回滚。
        </div>
      </div>
      <q-space />
      <q-btn color="primary" icon="rocket_launch" label="新建计划" @click="openCreate" />
      <q-btn flat round icon="refresh" @click="reload">
        <q-tooltip>刷新</q-tooltip>
      </q-btn>
    </div>

    <div v-if="loading" class="loading-panel">
      <q-spinner color="primary" size="24px" />
      <span>正在加载发版数据…</span>
    </div>
    <q-banner v-else-if="error" class="bg-negative text-white q-mb-md">{{ error }}</q-banner>

    <template v-else>
      <div class="summary-grid q-mb-lg">
        <div class="summary-tile">
          <span class="summary-label">活跃计划</span>
          <strong>{{ activePlanCount }}</strong>
        </div>
        <div class="summary-tile">
          <span class="summary-label">灰度中</span>
          <strong>{{ canaryPlanCount }}</strong>
        </div>
        <div class="summary-tile">
          <span class="summary-label">需要重启</span>
          <strong>{{ restartReportCount }}</strong>
        </div>
        <div class="summary-tile summary-tile--warn">
          <span class="summary-label">最近失败</span>
          <strong>{{ failedReportCount }}</strong>
        </div>
      </div>

      <div class="release-workbench q-mb-lg">
        <section class="release-panel release-panel--main">
          <div class="section-head">
            <div>
              <div class="section-title">发版计划</div>
              <div class="section-note">灰度使用稳定哈希，同一安装在同一计划里会保持命中或不命中。</div>
            </div>
          </div>

          <q-table
            :rows="plans"
            :columns="planColumns"
            row-key="id"
            flat
            bordered
            dense
            :pagination="{ rowsPerPage: 20 }"
            :rows-per-page-options="[10, 20, 50]"
          >
            <template #body-cell-name="props">
              <q-td :props="props">
                <div class="plan-name">{{ props.row.name }}</div>
                <div class="plan-subtitle">{{ props.row.channel }} · {{ formatDate(props.row.updatedAt) }}</div>
              </q-td>
            </template>
            <template #body-cell-target="props">
              <q-td :props="props">
                <div class="text-weight-medium">{{ props.row.targetId }}</div>
                <div class="text-caption text-grey-7">
                  {{ targetKindLabel(props.row.targetKind) }} → {{ props.row.targetVersion }}
                </div>
              </q-td>
            </template>
            <template #body-cell-mode="props">
              <q-td :props="props">
                <q-chip dense square color="blue-grey-1" text-color="blue-grey-9" :label="modeLabel(props.value)" />
              </q-td>
            </template>
            <template #body-cell-restartPolicy="props">
              <q-td :props="props">
                <q-chip
                  dense
                  square
                  :color="props.value === 'none' ? 'grey-3' : 'orange-2'"
                  text-color="blue-grey-10"
                  :label="restartLabel(props.value)"
                />
              </q-td>
            </template>
            <template #body-cell-rollout="props">
              <q-td :props="props">
                <div class="rollout-cell">
                  <q-linear-progress
                    :value="Math.max(0, Math.min(100, props.row.rollout?.percentage ?? 100)) / 100"
                    rounded
                    size="8px"
                    color="primary"
                  />
                  <span>{{ props.row.rollout?.percentage ?? 100 }}%</span>
                </div>
                <div v-if="rolloutSummary(props.row)" class="text-caption text-grey-7">
                  {{ rolloutSummary(props.row) }}
                </div>
              </q-td>
            </template>
            <template #body-cell-state="props">
              <q-td :props="props">
                <q-chip dense :color="stateColor(props.value)" text-color="white" :label="stateLabel(props.value)" />
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
        </section>

        <aside class="release-panel release-help">
          <div class="section-title">字段含义</div>
          <div class="help-list">
            <div v-for="item in fieldHints" :key="item.name" class="help-item">
              <strong>{{ item.name }}</strong>
              <span>{{ item.description }}</span>
            </div>
          </div>
        </aside>
      </div>

      <section class="release-panel">
        <div class="section-head">
          <div>
            <div class="section-title">最近客户端上报</div>
            <div class="section-note">客户端每次看到、应用、跳过或失败都会记录一条上报。</div>
          </div>
        </div>
        <q-table
          :rows="reports"
          :columns="reportColumns"
          row-key="id"
          flat
          bordered
          dense
          :pagination="{ rowsPerPage: 20 }"
          :rows-per-page-options="[10, 20, 50]"
        >
          <template #body-cell-createdAt="props">
            <q-td :props="props">{{ formatDate(props.value) }}</q-td>
          </template>
          <template #body-cell-status="props">
            <q-td :props="props">
              <q-chip dense :color="reportColor(props.value)" text-color="white" :label="reportLabel(props.value)" />
            </q-td>
          </template>
          <template #body-cell-version="props">
            <q-td :props="props">
              {{ props.row.fromVersion || '未安装' }} → {{ props.row.toVersion }}
            </q-td>
          </template>
          <template #body-cell-installId="props">
            <q-td :props="props">
              <code class="short-code">{{ props.value || '-' }}</code>
            </q-td>
          </template>
          <template #body-cell-error="props">
            <q-td :props="props">
              <span class="text-negative text-caption">{{ props.value }}</span>
            </q-td>
          </template>
        </q-table>
      </section>
    </template>

    <q-dialog v-model="editOpen">
      <q-card class="release-dialog">
        <q-card-section class="dialog-head">
          <div>
            <div class="text-h6">{{ editingId ? '编辑发版计划' : '新建发版计划' }}</div>
            <div class="text-caption text-grey-7">先确定发给谁，再选择客户端怎样处理这个版本。</div>
          </div>
          <q-space />
          <q-btn flat round dense icon="close" v-close-popup />
        </q-card-section>

        <q-card-section class="dialog-body">
          <section class="form-section">
            <div class="form-section-title">发布对象</div>
            <div class="form-grid form-grid--3">
              <q-input v-model="formName" outlined dense label="计划名称">
                <q-tooltip>后台识别用，不影响客户端展示。</q-tooltip>
              </q-input>
              <q-select
                v-model="formTargetKind"
                outlined
                dense
                emit-value
                map-options
                :options="targetKindOptions"
                label="目标类型"
              />
              <q-select
                v-model="formState"
                outlined
                dense
                emit-value
                map-options
                :options="stateOptions"
                label="保存状态"
              />
            </div>
            <div class="form-grid form-grid--2">
              <q-input v-model="formTargetId" outlined dense label="插件 / 市场 / 应用 id" />
              <q-input v-model="formNpm" outlined dense label="npm 包名（可空）" />
            </div>
            <div class="form-grid form-grid--3">
              <q-input v-model="formVersion" outlined dense label="目标版本" />
              <q-input v-model="formFallbackVersion" outlined dense label="回退版本（可空）" />
              <q-input v-model="formChannel" outlined dense label="渠道" />
            </div>
          </section>

          <section class="form-section">
            <div class="form-section-title">客户端策略</div>
            <q-btn-toggle
              v-model="formMode"
              class="mode-toggle"
              unelevated
              spread
              no-caps
              toggle-color="primary"
              :options="modeToggleOptions"
            />
            <q-banner class="mode-banner">
              {{ modeDescriptions[formMode] }}
            </q-banner>
            <div class="form-grid form-grid--3">
              <q-select
                v-model="formRestartPolicy"
                outlined
                dense
                emit-value
                map-options
                :options="restartOptions"
                label="重启策略"
              />
              <q-select
                v-model="formAutoGrant"
                outlined
                dense
                emit-value
                map-options
                :options="autoGrantOptions"
                label="自动授权"
              />
              <q-toggle v-model="formAutoActivate" color="primary" label="应用后自动激活" />
            </div>
          </section>

          <section class="form-section">
            <div class="form-section-title">灰度范围</div>
            <div class="rollout-editor">
              <q-slider
                v-model="formPercentage"
                :min="0"
                :max="100"
                :step="1"
                color="primary"
                label
                label-always
              />
              <q-input
                v-model.number="formPercentage"
                outlined
                dense
                type="number"
                min="0"
                max="100"
                suffix="%"
                label="灰度比例"
              />
            </div>
            <div class="form-grid form-grid--2">
              <q-input v-model="formPlatforms" outlined dense label="平台过滤（逗号分隔，可空）" />
              <q-input v-model="formInstallIds" outlined dense label="指定 installId（逗号分隔，可空）" />
            </div>
            <q-input v-model="formNotes" outlined dense type="textarea" label="备注" />
          </section>
        </q-card-section>

        <q-card-actions align="right" class="dialog-actions">
          <q-btn flat label="取消" v-close-popup />
          <q-btn color="primary" icon="save" label="保存" :loading="saving" @click="save" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';

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
const formFallbackVersion = ref('');
const formChannel = ref('stable');
const formMode = ref<ReleaseMode>('auto');
const formRestartPolicy = ref<RestartPolicy>('plugin');
const formState = ref<ReleasePlanState>('active');
const formPercentage = ref(100);
const formAutoGrant = ref<'none' | 'manifest'>('none');
const formAutoActivate = ref(false);
const formPlatforms = ref('');
const formInstallIds = ref('');
const formNotes = ref('');

const targetKindLabels: Record<ReleaseTargetKind, string> = {
  market: '市场包',
  plugin: '插件',
  game: '游戏 / 应用'
};

const modeLabels: Record<ReleaseMode, string> = {
  manual: '手动',
  notify: '提醒',
  auto: '自动',
  force: '强制',
  silent: '静默'
};

const modeDescriptions: Record<ReleaseMode, string> = {
  manual: '只在市场里显示可更新，用户需要自己点击更新。',
  notify: '提醒用户有更新，但不会直接替换当前版本。',
  auto: '客户端具备能力时自动下载并切到目标版本，失败会保留当前版本。',
  force: '用于安全修复或紧急回滚，命中客户端必须进入目标版本。',
  silent: '后台安静应用，适合官方插件、内置能力和无需用户理解的配置更新。'
};

const restartLabels: Record<RestartPolicy, string> = {
  none: '无需重启',
  plugin: '重启插件',
  app: '重启应用',
  system: '重启系统'
};

const stateLabels: Record<ReleasePlanState, string> = {
  draft: '草稿',
  active: '进行中',
  paused: '暂停',
  completed: '完成',
  rolled_back: '已回滚'
};

const reportLabels: Record<UpdateReport['status'], string> = {
  seen: '已看到',
  applied: '已应用',
  failed: '失败',
  skipped: '跳过',
  restart_required: '待重启',
  awaiting_grant: '待授权'
};

const targetKindOptions = [
  { label: '插件', value: 'plugin' },
  { label: '市场包', value: 'market' },
  { label: '游戏 / 应用', value: 'game' }
] satisfies Array<{ label: string; value: ReleaseTargetKind }>;

const stateOptions = [
  { label: '立即激活', value: 'active' },
  { label: '保存草稿', value: 'draft' },
  { label: '暂停', value: 'paused' },
  { label: '完成', value: 'completed' },
  { label: '已回滚', value: 'rolled_back' }
] satisfies Array<{ label: string; value: ReleasePlanState }>;

const modeToggleOptions = [
  { label: '手动', value: 'manual' },
  { label: '提醒', value: 'notify' },
  { label: '自动', value: 'auto' },
  { label: '强制', value: 'force' },
  { label: '静默', value: 'silent' }
] satisfies Array<{ label: string; value: ReleaseMode }>;

const restartOptions = [
  { label: '无需重启', value: 'none' },
  { label: '重启插件', value: 'plugin' },
  { label: '重启应用', value: 'app' },
  { label: '重启系统', value: 'system' }
] satisfies Array<{ label: string; value: RestartPolicy }>;

const autoGrantOptions = [
  { label: '不自动授权', value: 'none' },
  { label: '按 manifest 自动授权', value: 'manifest' }
] satisfies Array<{ label: string; value: 'none' | 'manifest' }>;

const fieldHints = [
  { name: '目标类型', description: 'market 更新市场宿主包；plugin 更新单个插件；game 用于游戏或独立应用。' },
  { name: '目标 id', description: '客户端上报的 manifest id 或应用 id，决定这条计划匹配哪个本地安装。' },
  { name: 'npm 包名', description: '可空；填写后用于精确匹配包，也便于回滚到 npm 上的历史版本。' },
  { name: '目标版本', description: '要切换到的精确版本。回滚也是发一个指向旧版本的新计划。' },
  { name: '渠道', description: 'stable、canary、internal 等管理标签，客户端会收到并上报。' },
  { name: '模式', description: '从手动到静默控制客户端的介入程度，官方插件通常用 auto 或 silent。' },
  { name: '重启策略', description: '声明应用后是否需要重启插件、应用或系统，客户端据此提醒或延后完成。' },
  { name: '灰度比例', description: '按 installId、deviceId 或 userId 做稳定随机；50% 表示同一批客户端持续命中一半。' },
  { name: '指定 installId', description: '小规模测试时直接填 10 台机器的 installId，可绕过比例随机。' }
];

const planColumns = [
  { name: 'name', label: '计划', field: 'name', align: 'left' as const },
  { name: 'target', label: '目标', field: 'targetId', align: 'left' as const },
  { name: 'mode', label: '模式', field: 'mode', align: 'left' as const },
  { name: 'restartPolicy', label: '重启', field: 'restartPolicy', align: 'left' as const },
  { name: 'rollout', label: '灰度', field: 'rollout', align: 'left' as const },
  { name: 'state', label: '状态', field: 'state', align: 'left' as const },
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

const activePlanCount = computed(() => plans.value.filter((plan) => plan.state === 'active').length);
const canaryPlanCount = computed(() =>
  plans.value.filter((plan) => {
    const percentage = plan.rollout?.percentage ?? 100;
    return plan.state === 'active' && percentage > 0 && percentage < 100;
  }).length
);
const failedReportCount = computed(() => reports.value.filter((report) => report.status === 'failed').length);
const restartReportCount = computed(() => reports.value.filter((report) => report.status === 'restart_required').length);

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
  formFallbackVersion.value = '';
  formChannel.value = 'stable';
  formMode.value = 'auto';
  formRestartPolicy.value = 'plugin';
  formState.value = 'active';
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
  formFallbackVersion.value = plan.fallbackVersion ?? '';
  formChannel.value = plan.channel;
  formMode.value = plan.mode;
  formRestartPolicy.value = plan.restartPolicy;
  formState.value = plan.state;
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
      fallbackVersion: formFallbackVersion.value || null,
      channel: formChannel.value || 'stable',
      mode: formMode.value,
      restartPolicy: formRestartPolicy.value,
      state: formState.value,
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

function targetKindLabel(value: unknown): string {
  return targetKindLabels[value as ReleaseTargetKind] ?? String(value || '-');
}

function modeLabel(value: unknown): string {
  return modeLabels[value as ReleaseMode] ?? String(value || '-');
}

function restartLabel(value: unknown): string {
  return restartLabels[value as RestartPolicy] ?? String(value || '-');
}

function stateLabel(value: unknown): string {
  return stateLabels[value as ReleasePlanState] ?? String(value || '-');
}

function reportLabel(value: unknown): string {
  return reportLabels[value as UpdateReport['status']] ?? String(value || '-');
}

function rolloutSummary(plan: ReleasePlan): string {
  const parts: string[] = [];
  if (plan.rollout?.platforms?.length) parts.push(plan.rollout.platforms.join(', '));
  if (plan.rollout?.installIds?.length) parts.push(`${plan.rollout.installIds.length} 个指定安装`);
  return parts.join(' · ');
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

onMounted(reload);
</script>

<style scoped>
.release-page {
  color: #172033;
}

.release-header,
.section-head,
.dialog-head,
.rollout-cell,
.loading-panel {
  display: flex;
  align-items: center;
  gap: 12px;
}

.release-header {
  min-height: 44px;
}

.page-subtitle,
.section-note {
  color: #667085;
  font-size: 13px;
  line-height: 1.5;
}

.loading-panel {
  min-height: 120px;
  color: #667085;
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.summary-tile {
  min-height: 78px;
  border: 1px solid #e3e8ef;
  border-radius: 8px;
  background: #ffffff;
  padding: 14px 16px;
}

.summary-tile strong {
  display: block;
  margin-top: 8px;
  font-size: 26px;
  line-height: 1;
}

.summary-tile--warn strong {
  color: #b42318;
}

.summary-label {
  color: #667085;
  font-size: 12px;
}

.release-workbench {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: 16px;
  align-items: start;
}

.release-panel {
  border: 1px solid #e3e8ef;
  border-radius: 8px;
  background: #ffffff;
  padding: 16px;
}

.release-panel--main {
  min-width: 0;
}

.section-head {
  justify-content: space-between;
  margin-bottom: 12px;
}

.section-title {
  font-weight: 700;
  font-size: 15px;
}

.help-list {
  display: grid;
  gap: 12px;
  margin-top: 12px;
}

.help-item {
  display: grid;
  gap: 3px;
}

.help-item strong {
  font-size: 12px;
  color: #344054;
}

.help-item span {
  color: #667085;
  font-size: 12px;
  line-height: 1.55;
}

.plan-name {
  font-weight: 700;
}

.plan-subtitle {
  color: #667085;
  font-size: 12px;
}

.rollout-cell {
  min-width: 140px;
}

.rollout-cell span {
  width: 42px;
  text-align: right;
  color: #344054;
  font-size: 12px;
}

.short-code {
  display: inline-block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  vertical-align: bottom;
}

.release-dialog {
  width: min(940px, calc(100vw - 48px));
  max-width: 940px;
}

.dialog-head {
  border-bottom: 1px solid #eef2f6;
}

.dialog-body {
  display: grid;
  gap: 18px;
  max-height: min(72vh, 760px);
  overflow: auto;
}

.form-section {
  display: grid;
  gap: 12px;
}

.form-section-title {
  color: #344054;
  font-size: 13px;
  font-weight: 700;
}

.form-grid {
  display: grid;
  gap: 12px;
}

.form-grid--2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.form-grid--3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.mode-toggle {
  border: 1px solid #e3e8ef;
  border-radius: 8px;
  overflow: hidden;
}

.mode-banner {
  border: 1px solid #d9e7ff;
  border-radius: 8px;
  background: #f5f9ff;
  color: #344054;
  min-height: 44px;
}

.rollout-editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 140px;
  gap: 18px;
  align-items: center;
}

.dialog-actions {
  border-top: 1px solid #eef2f6;
}

@media (max-width: 1120px) {
  .release-workbench {
    grid-template-columns: 1fr;
  }

  .release-help {
    order: -1;
  }
}

@media (max-width: 760px) {
  .summary-grid,
  .form-grid--2,
  .form-grid--3,
  .rollout-editor {
    grid-template-columns: 1fr;
  }

  .release-header {
    align-items: flex-start;
    flex-wrap: wrap;
  }
}
</style>
