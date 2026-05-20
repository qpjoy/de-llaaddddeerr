<template>
  <q-page class="content-panel hdo-page">
    <div class="toolbar-row q-mb-md">
      <div>
        <div class="page-title">HDO 控制面</div>
        <div class="text-caption text-grey-7">服务部署、Mesh 许可、设备插件清单和远程任务</div>
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
        <q-tab name="deploy" icon="construction" label="部署" />
        <q-tab name="mesh" icon="hub" label="Mesh" />
        <q-tab name="licenses" icon="verified_user" label="许可" />
        <q-tab name="nodes" icon="lan" label="节点" />
        <q-tab name="services" icon="dns" label="服务" />
        <q-tab name="profiles" icon="route" label="Profile" />
        <q-tab name="limits" icon="speed" label="限速" />
        <q-tab name="devices" icon="devices" label="设备" />
        <q-tab name="tasks" icon="send_to_mobile" label="任务" />
      </q-tabs>

      <q-tab-panels v-model="tab" animated class="bg-transparent">
        <q-tab-panel name="deploy" class="q-pa-none">
          <div class="section-surface q-pa-md q-mb-md">
            <div class="toolbar-row q-mb-sm">
              <div>
                <div class="section-title">推荐流程</div>
                <div class="text-caption text-grey-7">
                  Runner：{{ deployments?.runner.available ? deployments.runner.scriptPath : deployments?.runner.note ?? '加载中' }}
                </div>
              </div>
              <q-space />
              <q-btn flat round icon="refresh" :loading="deploymentLoading" @click="loadDeployments" />
            </div>
            <div class="deploy-flow">
              <div v-for="step in deploymentSteps" :key="step.label" class="deploy-step">
                <q-icon :name="step.done ? 'check_circle' : 'radio_button_unchecked'" :color="step.done ? 'positive' : 'grey-6'" size="22px" />
                <div>
                  <div class="text-weight-medium">{{ step.label }}</div>
                  <div class="text-caption text-grey-7">{{ step.detail }}</div>
                </div>
              </div>
            </div>
          </div>
          <div class="deploy-card-grid">
            <section v-for="card in deploymentCards" :key="card.key" class="section-surface q-pa-md">
              <div class="toolbar-row q-mb-sm">
                <div>
                  <div class="section-title q-mb-xs">{{ card.title }}</div>
                  <div class="text-caption text-grey-7">{{ card.subtitle }}</div>
                </div>
                <q-space />
                <q-badge :color="card.done ? 'positive' : 'warning'" :label="card.done ? '已登记' : '待处理'" />
              </div>
              <q-input
                :model-value="card.command"
                outlined
                dense
                readonly
                autogrow
                type="textarea"
                class="mono-command q-mb-sm"
              />
              <div class="toolbar-row">
                <q-btn flat icon="content_copy" label="复制命令" @click="copyInstallCommand(card.command)" />
                <q-btn
                  color="positive"
                  icon="play_arrow"
                  label="执行"
                  :disable="!deployments?.runner.available"
                  :loading="deployingKind === card.runKind"
                  @click="runDeployment(card)"
                />
                <q-space />
                <q-btn color="primary" :icon="card.actionIcon" :label="card.actionLabel" @click="tab = card.targetTab" />
              </div>
            </section>
          </div>
          <div class="section-surface q-pa-md q-mt-md">
            <div class="section-title q-mb-sm">最近部署任务</div>
            <div v-if="!deploymentJobs.length" class="text-grey-7">暂无任务。点击上方“执行”后会显示脚本输出。</div>
            <q-expansion-item
              v-for="job in deploymentJobs"
              :key="job.id"
              dense
              expand-separator
              :label="`${job.kind} · ${job.status}`"
              :caption="job.error ?? job.command"
            >
              <q-badge class="q-mb-sm" :color="deploymentStatusColor(job.status)" :label="job.status" />
              <pre class="deploy-output">{{ job.output || '等待脚本输出...' }}</pre>
            </q-expansion-item>
          </div>
        </q-tab-panel>

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

        <q-tab-panel name="nodes" class="q-pa-none">
          <div class="split-layout">
            <section class="section-surface q-pa-md">
              <div class="section-title">保存节点</div>
              <q-input v-model="nodeName" outlined dense label="名称" class="q-mb-sm" />
              <q-select
                v-model="nodeKind"
                outlined
                dense
                :options="nodeKindOptions"
                label="类型"
                class="q-mb-sm"
              />
              <q-select
                v-model="nodeStatus"
                outlined
                dense
                :options="nodeStatusOptions"
                label="状态"
                class="q-mb-sm"
              />
              <q-input
                v-model="nodePublicHost"
                outlined
                dense
                label="公网地址 / endpoint host"
                placeholder="121.43.253.179 或 example.com"
                class="q-mb-sm"
              />
              <q-input
                v-model="nodeOverlayIp"
                outlined
                dense
                label="Overlay IP"
                placeholder="100.88.0.1"
                class="q-mb-sm"
              />
              <q-input
                v-model="nodeWireGuardPublicKey"
                outlined
                dense
                label="WireGuard 公钥"
                class="q-mb-sm"
              />
              <div class="two-col q-mb-sm">
                <q-input
                  v-model="nodeWireGuardEndpointHost"
                  outlined
                  dense
                  label="WG endpoint host（可空）"
                  placeholder="默认取公网地址去端口"
                />
                <q-input
                  v-model="nodeWireGuardListenPort"
                  outlined
                  dense
                  type="number"
                  label="WG UDP 端口"
                  placeholder="51888"
                />
              </div>
              <div class="toolbar-row">
                <q-btn flat icon="restart_alt" label="清空" @click="resetNodeForm" />
                <q-space />
                <q-btn color="primary" icon="save" label="保存节点" @click="saveNode" />
              </div>
            </section>

            <section class="section-surface q-pa-md">
              <div class="section-title q-mb-sm">节点列表</div>
              <q-table
                :rows="nodeRows"
                :columns="nodeColumns"
                row-key="id"
                flat
                bordered
                dense
                :pagination="{ rowsPerPage: 12 }"
              >
                <template #body-cell-status="props">
                  <q-td :props="props">
                    <q-badge :color="nodeStatusColor(props.value)" :label="props.value" />
                  </q-td>
                </template>
                <template #body-cell-actions="props">
                  <q-td :props="props">
                    <q-btn flat dense round icon="edit" @click="editNode(props.row)">
                      <q-tooltip>编辑</q-tooltip>
                    </q-btn>
                    <q-btn flat dense round icon="favorite" @click="heartbeatNode(props.row)">
                      <q-tooltip>标记在线</q-tooltip>
                    </q-btn>
                  </q-td>
                </template>
              </q-table>
            </section>
          </div>
        </q-tab-panel>

        <q-tab-panel name="services" class="q-pa-none">
          <div class="split-layout">
            <section class="section-surface q-pa-md">
              <div class="section-title">保存服务</div>
              <q-input v-model="serviceName" outlined dense label="名称" class="q-mb-sm" />
              <q-select
                v-model="serviceNodeId"
                outlined
                dense
                emit-value
                map-options
                clearable
                :options="nodeOptions"
                label="节点"
                class="q-mb-sm"
              />
              <div class="two-col q-mb-sm">
                <q-input v-model="serviceTargetHost" outlined dense label="目标地址" placeholder="100.88.0.10" />
                <q-input v-model="serviceTargetPort" outlined dense type="number" label="端口" placeholder="8080" />
              </div>
              <q-select
                v-model="serviceProtocol"
                outlined
                dense
                :options="serviceProtocolOptions"
                label="协议"
                class="q-mb-sm"
              />
              <q-input
                v-model="serviceDomains"
                outlined
                dense
                label="域名，逗号分隔"
                placeholder="home.example.com, db.example.com"
                class="q-mb-sm"
              />
              <div class="toolbar-row">
                <q-toggle v-model="serviceEnabled" label="启用" />
                <q-space />
                <q-btn flat icon="restart_alt" label="清空" @click="resetServiceForm" />
                <q-btn color="primary" icon="save" label="保存服务" @click="saveService" />
              </div>
            </section>

            <section class="section-surface q-pa-md">
              <div class="section-title q-mb-sm">服务列表</div>
              <q-table
                :rows="serviceRows"
                :columns="serviceColumns"
                row-key="id"
                flat
                bordered
                dense
                :pagination="{ rowsPerPage: 12 }"
              >
                <template #body-cell-enabled="props">
                  <q-td :props="props">
                    <q-badge :color="props.value ? 'positive' : 'grey-6'" :label="props.value ? '启用' : '停用'" />
                  </q-td>
                </template>
                <template #body-cell-actions="props">
                  <q-td :props="props">
                    <q-btn flat dense round icon="edit" @click="editService(props.row)">
                      <q-tooltip>编辑</q-tooltip>
                    </q-btn>
                  </q-td>
                </template>
              </q-table>
            </section>
          </div>
        </q-tab-panel>

        <q-tab-panel name="profiles" class="q-pa-none">
          <div class="split-layout">
            <section class="section-surface q-pa-md">
              <div class="section-title">保存路由 Profile</div>
              <q-input v-model="profileName" outlined dense label="名称" class="q-mb-sm" />
              <q-select
                v-model="profileMode"
                outlined
                dense
                :options="profileModeOptions"
                label="模式"
                class="q-mb-sm"
              />
              <q-input
                v-model="profileRulesText"
                outlined
                dense
                type="textarea"
                label="rules JSON（可空）"
                placeholder='{"domains":["example.com"]}'
                class="q-mb-sm"
              />
              <div class="toolbar-row">
                <q-toggle v-model="profileEnabled" label="启用" />
                <q-space />
                <q-btn flat icon="restart_alt" label="清空" @click="resetProfileForm" />
                <q-btn color="primary" icon="save" label="保存 Profile" @click="saveProfile" />
              </div>
            </section>

            <section class="section-surface q-pa-md">
              <div class="section-title q-mb-sm">Profile 列表</div>
              <q-table
                :rows="overview.profiles"
                :columns="profileColumns"
                row-key="id"
                flat
                bordered
                dense
                :pagination="{ rowsPerPage: 12 }"
              >
                <template #body-cell-enabled="props">
                  <q-td :props="props">
                    <q-badge :color="props.value ? 'positive' : 'grey-6'" :label="props.value ? '启用' : '停用'" />
                  </q-td>
                </template>
                <template #body-cell-actions="props">
                  <q-td :props="props">
                    <q-btn flat dense round icon="edit" @click="editProfile(props.row)">
                      <q-tooltip>编辑</q-tooltip>
                    </q-btn>
                  </q-td>
                </template>
              </q-table>
            </section>
          </div>
        </q-tab-panel>

        <q-tab-panel name="limits" class="q-pa-none">
          <div class="split-layout">
            <section class="section-surface q-pa-md">
              <div class="section-title">保存限速</div>
              <q-select
                v-model="rateSubjectType"
                outlined
                dense
                :options="rateSubjectTypeOptions"
                label="对象类型"
                class="q-mb-sm"
                @update:model-value="rateSubjectId = null"
              />
              <q-select
                v-model="rateSubjectId"
                outlined
                dense
                emit-value
                map-options
                use-input
                fill-input
                clearable
                :options="rateSubjectOptions"
                label="对象 ID"
                class="q-mb-sm"
              />
              <div class="two-col q-mb-sm">
                <q-input v-model="rateDownRate" outlined dense label="下载 rate" placeholder="3mbit" />
                <q-input v-model="rateDownCeil" outlined dense label="下载 ceil" placeholder="30mbit" />
              </div>
              <div class="two-col q-mb-sm">
                <q-input v-model="rateUpRate" outlined dense label="上传 rate" placeholder="3mbit" />
                <q-input v-model="rateUpCeil" outlined dense label="上传 ceil" placeholder="30mbit" />
              </div>
              <div class="toolbar-row">
                <q-btn flat icon="restart_alt" label="清空" @click="resetRateLimitForm" />
                <q-space />
                <q-btn color="primary" icon="save" label="保存限速" @click="saveRateLimit" />
              </div>
            </section>

            <section class="section-surface q-pa-md">
              <div class="section-title q-mb-sm">限速列表</div>
              <q-table
                :rows="rateLimitRows"
                :columns="rateLimitColumns"
                row-key="id"
                flat
                bordered
                dense
                :pagination="{ rowsPerPage: 12 }"
              >
                <template #body-cell-actions="props">
                  <q-td :props="props">
                    <q-btn flat dense round icon="edit" @click="editRateLimit(props.row)">
                      <q-tooltip>编辑</q-tooltip>
                    </q-btn>
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
  type HdoDeploymentJob,
  type HdoDeploymentKind,
  type HdoDeploymentState,
  type HdoMeshGroupRow,
  type HdoNodeRow,
  type HdoOverview,
  type HdoProfileRow,
  type HdoRateLimitRow,
  type HdoServiceRow
} from 'src/composables/useServerAdmin';

const admin = useServerAdmin();

const overview = ref<HdoOverview | null>(null);
const deployments = ref<HdoDeploymentState | null>(null);
const loading = ref(true);
const deploymentLoading = ref(false);
const deployingKind = ref<HdoDeploymentKind | null>(null);
const error = ref<string | null>(null);
const tab = ref('deploy');

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

const editingNodeId = ref<string | null>(null);
const nodeName = ref('domestic-vps');
const nodeKind = ref<HdoNodeRow['kind']>('domestic');
const nodeStatus = ref<HdoNodeRow['status']>('pending');
const nodePublicHost = ref('');
const nodeOverlayIp = ref('100.88.0.1');
const nodeWireGuardPublicKey = ref('');
const nodeWireGuardEndpointHost = ref('');
const nodeWireGuardListenPort = ref('51888');
const nodeKindOptions: HdoNodeRow['kind'][] = ['domestic', 'home', 'oversea'];
const nodeStatusOptions: HdoNodeRow['status'][] = ['pending', 'online', 'offline', 'error'];

const editingServiceId = ref<string | null>(null);
const serviceName = ref('home-web');
const serviceNodeId = ref<string | null>(null);
const serviceTargetHost = ref('100.88.0.10');
const serviceTargetPort = ref('8080');
const serviceProtocol = ref<HdoServiceRow['protocol']>('tcp');
const serviceDomains = ref('');
const serviceEnabled = ref(true);
const serviceProtocolOptions: HdoServiceRow['protocol'][] = ['tcp', 'udp', 'http', 'https'];

const editingProfileId = ref<string | null>(null);
const profileName = ref('');
const profileMode = ref<HdoProfileRow['mode']>('home-only');
const profileEnabled = ref(true);
const profileRulesText = ref('');
const profileModeOptions: HdoProfileRow['mode'][] = ['home-only', 'home-foreign', 'domestic-global'];

const editingRateLimitId = ref<string | null>(null);
const rateSubjectType = ref<HdoRateLimitRow['subjectType']>('user');
const rateSubjectId = ref<string | null>(null);
const rateDownRate = ref('');
const rateDownCeil = ref('');
const rateUpRate = ref('');
const rateUpCeil = ref('');
const rateSubjectTypeOptions: HdoRateLimitRow['subjectType'][] = ['user', 'device', 'profile', 'node'];

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

const nodeColumns = [
  { name: 'kind', label: '类型', field: 'kind', align: 'left' as const },
  { name: 'name', label: '名称', field: 'name', align: 'left' as const },
  { name: 'publicHost', label: '公网地址', field: 'publicHost', align: 'left' as const },
  { name: 'overlayIp', label: 'Overlay IP', field: 'overlayIp', align: 'left' as const },
  { name: 'wg', label: 'WireGuard', field: 'wireGuardLabel', align: 'left' as const },
  { name: 'status', label: '状态', field: 'status', align: 'left' as const },
  { name: 'actions', label: '', field: 'id', align: 'right' as const }
];

const serviceColumns = [
  { name: 'name', label: '名称', field: 'name', align: 'left' as const },
  { name: 'node', label: '节点', field: 'nodeLabel', align: 'left' as const },
  { name: 'target', label: '目标', field: 'targetLabel', align: 'left' as const },
  { name: 'protocol', label: '协议', field: 'protocol', align: 'left' as const },
  { name: 'domains', label: '域名', field: 'domainsLabel', align: 'left' as const },
  { name: 'enabled', label: '状态', field: 'enabled', align: 'left' as const },
  { name: 'actions', label: '', field: 'id', align: 'right' as const }
];

const profileColumns = [
  { name: 'name', label: '名称', field: 'name', align: 'left' as const },
  { name: 'mode', label: '模式', field: 'mode', align: 'left' as const },
  { name: 'enabled', label: '状态', field: 'enabled', align: 'left' as const },
  { name: 'updatedAt', label: '更新时间', field: 'updatedAt', align: 'left' as const },
  { name: 'actions', label: '', field: 'id', align: 'right' as const }
];

const rateLimitColumns = [
  { name: 'subjectType', label: '对象', field: 'subjectType', align: 'left' as const },
  { name: 'subject', label: '对象 ID', field: 'subjectLabel', align: 'left' as const },
  { name: 'down', label: '下载', field: 'downLabel', align: 'left' as const },
  { name: 'up', label: '上传', field: 'upLabel', align: 'left' as const },
  { name: 'updatedAt', label: '更新时间', field: 'updatedAt', align: 'left' as const },
  { name: 'actions', label: '', field: 'id', align: 'right' as const }
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
const nodesById = computed(() => new Map((overview.value?.nodes ?? []).map((row) => [row.id, row])));
const profilesById = computed(() => new Map((overview.value?.profiles ?? []).map((row) => [row.id, row])));

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

const nodeOptions = computed(() =>
  (overview.value?.nodes ?? []).map((row) => ({ label: `${row.kind} / ${row.name}`, value: row.id }))
);

const activeMemberships = computed(() =>
  (overview.value?.memberships ?? []).filter((row) => row.status === 'active')
);

const pendingTasks = computed(() =>
  (overview.value?.tasks ?? []).filter((row) => row.status === 'pending' || row.status === 'claimed')
);

const deploymentJobs = computed(() => deployments.value?.jobs ?? []);

const deploymentSteps = computed(() => {
  const hasMesh = (overview.value?.meshGroups ?? []).some((row) => row.enabled);
  const hasLicense = activeMemberships.value.length > 0;
  const hasDomestic = hasNodeKind('domestic');
  const hasHome = hasNodeKind('home');
  const hasService = (overview.value?.services ?? []).some((row) => row.enabled);
  const hasDevice = (overview.value?.devices ?? []).length > 0;
  return [
    {
      label: '启动 electron-server',
      detail: '服务器上通过 ./scripts/manage.sh server up / deploy 启动控制面。',
      done: true
    },
    {
      label: '部署 Domestic gateway',
      detail: '在本机或 domestic-vps 安装 WireGuard gateway，并把 domestic 节点登记到控制面。',
      done: hasDomestic
    },
    {
      label: '创建 Mesh 并发放许可',
      detail: '创建启用中的 mesh 组，把用户加入 mesh；客户端只有拿到许可才会收到 peer 和订阅。',
      done: hasMesh && hasLicense
    },
    {
      label: '接入 Home / 服务',
      detail: '登记 Home 节点和可见服务，服务端会按 mesh 可见性下发到客户端。',
      done: hasHome && hasService
    },
    {
      label: '客户端入网',
      detail: '用户打开 HDO 插件，在“我的 Mesh”里连接 / 更新 HDO。',
      done: hasDevice
    }
  ];
});

const deploymentCards = computed(() => [
  {
    key: 'domestic-wireguard',
    title: 'Domestic WireGuard gateway',
    subtitle: 'H/D mesh 基础能力；没有 Oversea 也可以让多个 Home 互联。',
    command: [
      "HDO_TOKEN='<admin bearer token>' ./scripts/manage.sh hdo deploy-domestic --yes --server-url http://127.0.0.1:8080 --public-host <domestic-public-ip-or-domain> --port 51888",
      "HDO_TOKEN='<admin bearer token>' ./scripts/manage.sh hdo sync-peers --server-url http://127.0.0.1:8080"
    ].join('\n'),
    runKind: 'deploy-domestic' as HdoDeploymentKind,
    done: hasNodeKind('domestic'),
    targetTab: 'nodes',
    actionIcon: 'dns',
    actionLabel: '登记节点'
  },
  {
    key: 'domestic-mihomo-wireguard',
    title: 'Domestic Docker Mihomo + WireGuard',
    subtitle: '复用现有 wg-mihomo-stack；通过 HDO gateway 统一入口调用。',
    command: 'sudo ./scripts/manage.sh hdo deploy-domestic-mihomo-wireguard',
    runKind: 'deploy-domestic-mihomo-wireguard' as HdoDeploymentKind,
    done: hasNodeKind('domestic') && (overview.value?.services ?? []).some((row) => row.enabled),
    targetTab: 'services',
    actionIcon: 'dns',
    actionLabel: '登记服务'
  },
  {
    key: 'oversea-mihomo-hysteria2',
    title: 'Oversea Docker Mihomo + Hysteria2',
    subtitle: '给 D 提供显式外网出站能力；H 客户端无需感知 O。',
    command: 'sudo ./scripts/manage.sh hdo deploy-oversea-mihomo-hysteria2',
    runKind: 'deploy-oversea-mihomo-hysteria2' as HdoDeploymentKind,
    done: hasNodeKind('oversea'),
    targetTab: 'nodes',
    actionIcon: 'public',
    actionLabel: '登记 O 节点'
  },
  {
    key: 'sync-domestic-peers',
    title: '同步 Domestic peers',
    subtitle: '把服务端管理的 Home / Client peers 下发到 D，并热更新 hdo-home。',
    command: "HDO_TOKEN='<admin bearer token>' ./scripts/manage.sh hdo sync-peers --server-url http://127.0.0.1:8080",
    runKind: 'sync-domestic-peers' as HdoDeploymentKind,
    done: (overview.value?.devices ?? []).some((row) => Boolean(row.publicKey && row.overlayIp)),
    targetTab: 'devices',
    actionIcon: 'devices',
    actionLabel: '查看设备'
  }
]);

const membershipRows = computed(() =>
  (overview.value?.memberships ?? []).map((row) => ({
    ...row,
    userLabel: userLabel(row.userId),
    meshLabel: meshById.value.get(row.meshGroupId)?.name ?? row.meshGroupId
  }))
);

const nodeRows = computed(() =>
  (overview.value?.nodes ?? []).map((row) => {
    const wireGuard = wireGuardMetadata(row);
    const publicKey = stringValue(wireGuard?.publicKey);
    const listenPort = wireGuard?.listenPort ?? wireGuard?.port ?? '51888';
    return {
      ...row,
      wireGuardLabel: publicKey
        ? `${publicKey.slice(0, 10)}… / ${listenPort}`
        : ''
    };
  })
);

const serviceRows = computed(() =>
  (overview.value?.services ?? []).map((row) => ({
    ...row,
    nodeLabel: row.nodeId ? nodesById.value.get(row.nodeId)?.name ?? row.nodeId : '不绑定',
    targetLabel: `${row.targetHost}:${row.targetPort}`,
    domainsLabel: row.domains.join(', ')
  }))
);

const rateLimitRows = computed(() =>
  (overview.value?.rateLimits ?? []).map((row) => ({
    ...row,
    subjectLabel: subjectLabel(row.subjectType, row.subjectId),
    downLabel: [row.downRate, row.downCeil].filter(Boolean).join(' / '),
    upLabel: [row.upRate, row.upCeil].filter(Boolean).join(' / ')
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

const rateSubjectOptions = computed(() => {
  switch (rateSubjectType.value) {
    case 'user':
      return (overview.value?.users ?? []).map((row) => ({
        label: userLabel(row.id),
        value: row.id
      }));
    case 'device':
      return (overview.value?.devices ?? []).map((row) => ({
        label: `${row.label} / ${row.platform ?? row.id}`,
        value: row.id
      }));
    case 'profile':
      return (overview.value?.profiles ?? []).map((row) => ({
        label: `${row.name} / ${row.mode}`,
        value: row.id
      }));
    case 'node':
      return (overview.value?.nodes ?? []).map((row) => ({
        label: `${row.kind} / ${row.name}`,
        value: row.id
      }));
    default:
      return [];
  }
});

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const [nextOverview, nextDeployments] = await Promise.all([
      admin.getHdoOverview(),
      admin.getHdoDeployments()
    ]);
    overview.value = nextOverview;
    deployments.value = nextDeployments;
    if (!membershipUserId.value) membershipUserId.value = overview.value.users[0]?.id ?? null;
    if (!taskUserId.value) taskUserId.value = overview.value.users[0]?.id ?? null;
    if (!membershipMeshGroupId.value) membershipMeshGroupId.value = overview.value.meshGroups[0]?.id ?? null;
    if (!serviceNodeId.value) serviceNodeId.value = overview.value.nodes[0]?.id ?? null;
    if (!rateSubjectId.value) rateSubjectId.value = overview.value.users[0]?.id ?? null;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function loadDeployments(): Promise<void> {
  deploymentLoading.value = true;
  try {
    deployments.value = await admin.getHdoDeployments();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    deploymentLoading.value = false;
  }
}

async function runDeployment(card: { runKind: HdoDeploymentKind }): Promise<void> {
  deployingKind.value = card.runKind;
  error.value = null;
  try {
    await admin.runHdoDeployment({ kind: card.runKind });
    await loadDeployments();
    window.setTimeout(() => {
      void loadDeployments();
    }, 1800);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    deployingKind.value = null;
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

async function saveNode(): Promise<void> {
  if (!nodeName.value.trim()) return;
  try {
    await admin.upsertHdoNode({
      id: editingNodeId.value ?? undefined,
      name: nodeName.value.trim(),
      kind: nodeKind.value,
      publicHost: nodePublicHost.value.trim() || null,
      overlayIp: nodeOverlayIp.value.trim() || null,
      status: nodeStatus.value,
      metadata: buildNodeMetadata()
    });
    resetNodeForm();
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function heartbeatNode(row: HdoNodeRow): Promise<void> {
  try {
    await admin.heartbeatHdoNode(row.id);
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function editNode(row: HdoNodeRow): void {
  const wireGuard = wireGuardMetadata(row);
  editingNodeId.value = row.id;
  nodeName.value = row.name;
  nodeKind.value = row.kind;
  nodeStatus.value = row.status;
  nodePublicHost.value = row.publicHost ?? '';
  nodeOverlayIp.value = row.overlayIp ?? '';
  nodeWireGuardPublicKey.value = stringValue(wireGuard?.publicKey) ?? '';
  nodeWireGuardEndpointHost.value =
    stringValue(wireGuard?.endpointHost) ?? stringValue(wireGuard?.host) ?? '';
  nodeWireGuardListenPort.value = String(wireGuard?.listenPort ?? wireGuard?.port ?? '');
}

function resetNodeForm(): void {
  editingNodeId.value = null;
  nodeName.value = 'domestic-vps';
  nodeKind.value = 'domestic';
  nodeStatus.value = 'pending';
  nodePublicHost.value = '';
  nodeOverlayIp.value = '100.88.0.1';
  nodeWireGuardPublicKey.value = '';
  nodeWireGuardEndpointHost.value = '';
  nodeWireGuardListenPort.value = '51888';
}

async function saveService(): Promise<void> {
  const targetPort = Number(serviceTargetPort.value);
  if (!serviceName.value.trim() || !serviceTargetHost.value.trim() || !Number.isInteger(targetPort)) return;
  try {
    await admin.upsertHdoService({
      id: editingServiceId.value ?? undefined,
      name: serviceName.value.trim(),
      nodeId: serviceNodeId.value,
      targetHost: serviceTargetHost.value.trim(),
      targetPort,
      protocol: serviceProtocol.value,
      domains: splitCsv(serviceDomains.value),
      enabled: serviceEnabled.value
    });
    resetServiceForm();
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function editService(row: HdoServiceRow): void {
  editingServiceId.value = row.id;
  serviceName.value = row.name;
  serviceNodeId.value = row.nodeId;
  serviceTargetHost.value = row.targetHost;
  serviceTargetPort.value = String(row.targetPort);
  serviceProtocol.value = row.protocol;
  serviceDomains.value = row.domains.join(', ');
  serviceEnabled.value = row.enabled;
}

function resetServiceForm(): void {
  editingServiceId.value = null;
  serviceName.value = 'home-web';
  serviceNodeId.value = null;
  serviceTargetHost.value = '100.88.0.10';
  serviceTargetPort.value = '8080';
  serviceProtocol.value = 'tcp';
  serviceDomains.value = '';
  serviceEnabled.value = true;
}

async function saveProfile(): Promise<void> {
  if (!profileName.value.trim()) return;
  try {
    await admin.upsertHdoProfile({
      id: editingProfileId.value ?? undefined,
      name: profileName.value.trim(),
      mode: profileMode.value,
      enabled: profileEnabled.value,
      rules: parseJsonObject(profileRulesText.value)
    });
    resetProfileForm();
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function editProfile(row: HdoProfileRow): void {
  editingProfileId.value = row.id;
  profileName.value = row.name;
  profileMode.value = row.mode;
  profileEnabled.value = row.enabled;
  profileRulesText.value = row.rules ? JSON.stringify(row.rules, null, 2) : '';
}

function resetProfileForm(): void {
  editingProfileId.value = null;
  profileName.value = '';
  profileMode.value = 'home-only';
  profileEnabled.value = true;
  profileRulesText.value = '';
}

async function saveRateLimit(): Promise<void> {
  if (!rateSubjectId.value) return;
  try {
    await admin.upsertHdoRateLimit({
      id: editingRateLimitId.value ?? undefined,
      subjectType: rateSubjectType.value,
      subjectId: rateSubjectId.value,
      downRate: rateDownRate.value.trim() || null,
      downCeil: rateDownCeil.value.trim() || null,
      upRate: rateUpRate.value.trim() || null,
      upCeil: rateUpCeil.value.trim() || null
    });
    resetRateLimitForm();
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function editRateLimit(row: HdoRateLimitRow): void {
  editingRateLimitId.value = row.id;
  rateSubjectType.value = row.subjectType;
  rateSubjectId.value = row.subjectId;
  rateDownRate.value = row.downRate ?? '';
  rateDownCeil.value = row.downCeil ?? '';
  rateUpRate.value = row.upRate ?? '';
  rateUpCeil.value = row.upCeil ?? '';
}

function resetRateLimitForm(): void {
  editingRateLimitId.value = null;
  rateSubjectType.value = 'user';
  rateSubjectId.value = null;
  rateDownRate.value = '';
  rateDownCeil.value = '';
  rateUpRate.value = '';
  rateUpCeil.value = '';
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

async function copyInstallCommand(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command);
    error.value = null;
  } catch {
    error.value = '浏览器未允许复制，请手动选中命令复制。';
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

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('JSON 必须是 object');
  }
  return parsed as Record<string, unknown>;
}

function buildNodeMetadata(): Record<string, unknown> | null {
  const existing = editingNodeId.value
    ? (nodesById.value.get(editingNodeId.value)?.metadata ?? {})
    : {};
  const metadata: Record<string, unknown> = { ...existing };
  const publicKey = nodeWireGuardPublicKey.value.trim();
  const endpointHost = nodeWireGuardEndpointHost.value.trim();
  const listenPort = Number(nodeWireGuardListenPort.value);

  if (publicKey || endpointHost || Number.isInteger(listenPort)) {
    metadata.wireGuard = {
      ...(plainObject(metadata.wireGuard) ?? plainObject(metadata.wg) ?? {}),
      publicKey: publicKey || null,
      endpointHost: endpointHost || null,
      listenPort: Number.isInteger(listenPort) ? listenPort : null
    };
  }

  return Object.keys(metadata).length ? metadata : null;
}

function wireGuardMetadata(row: HdoNodeRow | { metadata: HdoNodeRow['metadata'] }): Record<string, unknown> | null {
  const metadata = plainObject(row.metadata);
  return plainObject(metadata?.wireGuard) ?? plainObject(metadata?.wg);
}

function plainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function userLabel(userId: string): string {
  const user = usersById.value.get(userId);
  return user?.displayName || user?.username || user?.email || userId;
}

function hasNodeKind(kind: HdoNodeRow['kind']): boolean {
  return (overview.value?.nodes ?? []).some((row) => row.kind === kind);
}

function subjectLabel(subjectType: HdoRateLimitRow['subjectType'], subjectId: string): string {
  if (subjectType === 'user') return userLabel(subjectId);
  if (subjectType === 'device') return devicesById.value.get(subjectId)?.label ?? subjectId;
  if (subjectType === 'profile') return profilesById.value.get(subjectId)?.name ?? subjectId;
  if (subjectType === 'node') return nodesById.value.get(subjectId)?.name ?? subjectId;
  return subjectId;
}

function statusColor(status: string): string {
  return { active: 'positive', suspended: 'warning', revoked: 'negative' }[status] ?? 'grey-7';
}

function nodeStatusColor(status: string): string {
  return {
    online: 'positive',
    pending: 'warning',
    offline: 'grey-7',
    error: 'negative'
  }[status] ?? 'grey-7';
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

function deploymentStatusColor(status: HdoDeploymentJob['status']): string {
  return {
    running: 'info',
    succeeded: 'positive',
    failed: 'negative'
  }[status];
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

  .deploy-flow {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 12px;
  }

  .deploy-step {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
    min-width: 0;
  }

  .deploy-card-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
  }

  .mono-command :deep(textarea) {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
  }

  .deploy-output {
    max-height: 280px;
    overflow: auto;
    padding: 12px;
    border-radius: 8px;
    background: #111827;
    color: #e5e7eb;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .two-col {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  @media (max-width: 980px) {
    .metric-grid,
    .split-layout,
    .deploy-flow,
    .deploy-card-grid,
    .two-col {
      grid-template-columns: 1fr;
    }
  }
}
</style>
