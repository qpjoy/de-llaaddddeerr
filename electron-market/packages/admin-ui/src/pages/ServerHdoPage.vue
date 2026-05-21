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
        <q-tab name="topology" icon="account_tree" label="拓扑" />
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
              <q-btn flat round icon="refresh" :loading="deploymentLoading" @click="() => loadDeployments()" />
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
            <q-banner
              v-if="deploymentNotice"
              dense
              rounded
              class="q-mt-md"
              :class="deploymentNotice.className"
            >
              <div class="text-weight-medium">{{ deploymentNotice.title }}</div>
              <div class="text-caption">{{ deploymentNotice.detail }}</div>
            </q-banner>
          </div>
          <div class="deploy-card-grid">
            <section v-for="card in deploymentCards" :key="card.key" class="section-surface q-pa-md">
              <div class="toolbar-row q-mb-sm">
                <div>
                  <div class="section-title q-mb-xs">{{ card.title }}</div>
                  <div class="text-caption text-grey-7">{{ card.subtitle }}</div>
                </div>
                <q-space />
                <q-badge
                  :color="deploymentCardBadge(card).color"
                  :label="deploymentCardBadge(card).label"
                />
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
                  :icon="deploymentButtonIcon(card)"
                  :label="deploymentButtonLabel(card)"
                  :disable="deploymentButtonDisabled(card)"
                  :loading="isDeploymentKindRunning(card.runKind) || deployingKind === card.runKind"
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
              <div class="section-subtitle">地址规划</div>
              <div class="two-col q-mb-sm">
                <q-input v-model="meshHomeCidr" outlined dense label="H/Home CIDR" />
                <q-input v-model="meshUserCidr" outlined dense label="客户端 CIDR" />
                <q-input v-model="meshServiceCidr" outlined dense label="服务 CIDR" />
                <q-input v-model="meshDomesticIp" outlined dense label="Domestic IP" />
              </div>
              <q-toggle
                v-model="meshGatewayForwarding"
                label="Domestic 网关转发"
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

        <q-tab-panel name="topology" class="q-pa-none">
          <div class="topology-layout">
            <section class="section-surface q-pa-md">
              <div class="toolbar-row q-mb-sm">
                <div>
                  <div class="section-title q-mb-xs">HDO 拓扑</div>
                  <div class="text-caption text-grey-7">把 Mesh、节点、设备、服务和 Profile 放在同一张操作图里。</div>
                </div>
                <q-space />
                <div class="topology-legend">
                  <span><i class="legend-dot bg-positive" />在线</span>
                  <span><i class="legend-dot bg-grey-5" />离线</span>
                  <span><i class="legend-dot bg-warning" />待处理</span>
                </div>
              </div>

              <svg class="topology-map" viewBox="0 0 960 520" role="img" aria-label="HDO topology graph">
                <line
                  v-for="edge in topologyEdges"
                  :key="edge.key"
                  class="topology-edge"
                  :x1="edge.x1"
                  :y1="edge.y1"
                  :x2="edge.x2"
                  :y2="edge.y2"
                />
                <g
                  v-for="item in topologyItems"
                  :key="item.key"
                  class="topology-node"
                  :class="{ 'is-selected': selectedTopologyItem?.key === item.key }"
                  :transform="`translate(${item.x} ${item.y})`"
                  tabindex="0"
                  @click="selectTopologyItem(item.key)"
                  @keydown.enter="selectTopologyItem(item.key)"
                >
                  <title>{{ topologyTooltip(item) }}</title>
                  <circle class="topology-node-ring" r="31" />
                  <circle class="topology-node-fill" r="24" :class="`text-${item.color}`" />
                  <text class="topology-node-glyph" y="7">{{ item.glyph }}</text>
                  <circle class="topology-status" cx="22" cy="-20" r="7" :class="`text-${item.color}`" />
                  <text class="topology-node-label" y="49">{{ item.shortLabel }}</text>
                  <text class="topology-node-caption" y="66">{{ item.caption }}</text>
                </g>
              </svg>
            </section>

            <section class="section-surface q-pa-md">
              <template v-if="selectedTopologyItem">
                <div class="toolbar-row q-mb-sm">
                  <div>
                    <div class="section-title q-mb-xs">{{ selectedTopologyItem.label }}</div>
                    <div class="text-caption text-grey-7">{{ selectedTopologyItem.description }}</div>
                  </div>
                  <q-space />
                  <q-badge :color="selectedTopologyItem.color" :label="selectedTopologyItem.statusLabel" />
                </div>

                <div class="topology-detail-list q-mb-md">
                  <div>
                    <span>类型</span>
                    <strong>{{ selectedTopologyItem.kindLabel }}</strong>
                  </div>
                  <div v-if="selectedTopologyItem.userLabel">
                    <span>用户</span>
                    <strong>{{ selectedTopologyItem.userLabel }}</strong>
                  </div>
                  <div v-if="selectedTopologyItem.overlayIp">
                    <span>Overlay IP</span>
                    <strong>{{ selectedTopologyItem.overlayIp }}</strong>
                  </div>
                  <div v-if="selectedTopologyItem.publicHost">
                    <span>公网地址</span>
                    <strong>{{ selectedTopologyItem.publicHost }}</strong>
                  </div>
                  <div v-if="selectedTopologyItem.profileLabel">
                    <span>Profile</span>
                    <strong>{{ selectedTopologyItem.profileLabel }}</strong>
                  </div>
                  <div v-if="selectedTopologyItem.rateLimitLabel">
                    <span>限速</span>
                    <strong>{{ selectedTopologyItem.rateLimitLabel }}</strong>
                  </div>
                </div>

                <div class="section-subtitle">关联服务</div>
                <q-list v-if="selectedTopologyServices.length" bordered dense class="q-mb-md">
                  <q-item v-for="service in selectedTopologyServices" :key="service.id">
                    <q-item-section>
                      <q-item-label>{{ service.name }}</q-item-label>
                      <q-item-label caption>{{ service.targetHost }}:{{ service.targetPort }} / {{ service.protocol }}</q-item-label>
                    </q-item-section>
                    <q-item-section side>
                      <q-btn flat dense round icon="edit" @click="openService(service)">
                        <q-tooltip>编辑服务</q-tooltip>
                      </q-btn>
                    </q-item-section>
                  </q-item>
                </q-list>
                <div v-else class="text-caption text-grey-7 q-mb-md">暂无直接绑定或指向该对象的服务。</div>

                <div class="topology-actions">
                  <q-btn
                    v-if="selectedTopologyItem.action === 'node'"
                    color="primary"
                    outline
                    icon="edit"
                    label="编辑节点"
                    @click="openNode(selectedTopologyItem.id)"
                  />
                  <q-btn
                    v-if="selectedTopologyItem.action === 'service'"
                    color="primary"
                    outline
                    icon="edit"
                    label="编辑服务"
                    @click="openServiceById(selectedTopologyItem.id)"
                  />
                  <q-btn
                    v-if="selectedTopologyItem.action === 'profile'"
                    color="primary"
                    outline
                    icon="edit"
                    label="编辑 Profile"
                    @click="openProfile(selectedTopologyItem.id)"
                  />
                  <q-btn
                    v-if="selectedTopologyItem.canRateLimit"
                    color="primary"
                    icon="speed"
                    label="设置限速"
                    @click="openRateLimit(selectedTopologyItem)"
                  />
                  <q-btn
                    v-if="selectedTopologyItem.action === 'device'"
                    color="primary"
                    outline
                    icon="send_to_mobile"
                    label="创建任务"
                    @click="openDeviceTask(selectedTopologyItem)"
                  />
                </div>
              </template>
              <div v-else class="text-grey-7">暂无拓扑数据。</div>
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
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import {
  useServerAdmin,
  type HdoDeviceRow,
  type HdoDeviceTaskRow,
  type HdoDeploymentJob,
  type HdoDeploymentKind,
  type HdoDeploymentState,
  type HdoMeshGroupRow,
  type HdoMeshMembershipRow,
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
let deploymentPollTimer: number | null = null;
const DEPLOYMENT_POLL_INTERVAL_MS = 8000;

const editingMeshId = ref<string | null>(null);
const meshName = ref('');
const meshSlug = ref('');
const meshDescription = ref('');
const meshDefaultProfileId = ref<string | null>(null);
const meshEnabled = ref(true);
const meshGatewayForwarding = ref(true);
const defaultMeshAddressPlan = {
  homeCidr: '100.88.0.0/16',
  userCidr: '100.89.0.0/16',
  serviceCidr: '100.90.0.0/16',
  domesticIp: '100.88.0.1'
};
const meshHomeCidr = ref(defaultMeshAddressPlan.homeCidr);
const meshUserCidr = ref(defaultMeshAddressPlan.userCidr);
const meshServiceCidr = ref(defaultMeshAddressPlan.serviceCidr);
const meshDomesticIp = ref(defaultMeshAddressPlan.domesticIp);

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

type TopologyAction = 'mesh' | 'node' | 'device' | 'service' | 'profile';

interface TopologyItem {
  key: string;
  id: string;
  action: TopologyAction;
  label: string;
  shortLabel: string;
  caption: string;
  description: string;
  kindLabel: string;
  statusLabel: string;
  color: string;
  glyph: string;
  x: number;
  y: number;
  overlayIp: string | null;
  publicHost: string | null;
  userId: string | null;
  userLabel: string | null;
  profileLabel: string | null;
  rateLimitLabel: string | null;
  canRateLimit: boolean;
  parentKey: string | null;
}

interface TopologyEdge {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const selectedTopologyKey = ref<string | null>(null);

const meshColumns = [
  { name: 'name', label: '名称', field: 'name', align: 'left' as const },
  { name: 'slug', label: 'slug', field: 'slug', align: 'left' as const },
  {
    name: 'addressPlan',
    label: '地址规划',
    field: (row: HdoMeshGroupRow) => meshAddressPlanLabel(row),
    align: 'left' as const
  },
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
const runningDeploymentJob = computed(() =>
  deploymentJobs.value.find((job) => job.status === 'running') ?? null
);
const latestFinishedDeploymentJob = computed(() =>
  deploymentJobs.value.find((job) => job.status !== 'running') ?? null
);
const browserPublicHost = computed(() => window.location.hostname || null);
const domesticDeploymentPublicHost = computed(
  () => overview.value?.nodes.find((row) => row.kind === 'domestic')?.publicHost ?? browserPublicHost.value
);
const deploymentNotice = computed(() => {
  const running = runningDeploymentJob.value;
  if (running) {
    return {
      className: 'bg-info text-white',
      title: `正在执行：${running.kind}`,
      detail: running.output ? lastOutputLine(running.output) : '任务已提交，正在等待脚本输出。'
    };
  }
  const latest = latestFinishedDeploymentJob.value;
  if (!latest) return null;
  if (latest.status === 'failed') {
    return {
      className: 'bg-negative text-white',
      title: `执行失败：${latest.kind}`,
      detail: latest.output ? lastOutputLine(latest.output) : latest.error ?? '脚本返回失败。'
    };
  }
  return {
    className: 'bg-positive text-white',
    title: `执行完成：${latest.kind}`,
    detail: latest.output ? lastOutputLine(latest.output) : '任务已成功完成。'
  };
});

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
      label: '接入 H 成员 / 服务',
      detail: '登记 H 成员节点、客户端和可见服务，服务端会按 mesh 可见性下发到客户端。',
      done: hasHome && hasService
    },
    {
      label: '客户端入网',
      detail: '用户打开 HDO 插件，在“我的 Mesh”里连接 / 更新 HDO。',
      done: hasDevice
    },
    {
      label: '同步并修复网关',
      detail: '后台执行 sync-and-repair-domestic，把服务端 peer 写入 domestic，并补齐 live WireGuard、路由和转发。',
      done: hasDevice && hasDomestic
    }
  ];
});

const deploymentCards = computed(() => [
  {
    key: 'domestic-wireguard',
    title: 'Domestic WireGuard gateway',
    subtitle: 'H/D mesh 基础能力；没有 Oversea 也可以让多个 H 成员互联。',
    command: [
      `HDO_TOKEN='<admin bearer token>' ./scripts/manage.sh hdo deploy-domestic --yes --server-url http://127.0.0.1:8080 --public-host ${domesticDeploymentPublicHost.value ?? '<domestic-public-ip-or-domain>'} --port 51888`,
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
    key: 'sync-and-repair-domestic',
    title: '同步并修复 D peers / routes',
    subtitle: '把服务端管理的 H 成员节点 / 客户端 peer 写入 D，并热更新 live WireGuard、路由和转发。',
    command: "sudo HDO_TOKEN='<admin bearer token>' ./scripts/manage.sh hdo sync-and-repair-domestic --server-url http://127.0.0.1:8080",
    runKind: 'sync-and-repair-domestic' as HdoDeploymentKind,
    done: (overview.value?.devices ?? []).some((row) => Boolean(row.publicKey && row.overlayIp)),
    targetTab: 'devices',
    actionIcon: 'devices',
    actionLabel: '查看设备'
  },
  {
    key: 'repair-domestic-routes',
    title: '修复 D 路由 / 转发',
    subtitle: '只重载已有 /etc/wireguard/hdo-home.conf，补齐 ip_forward、DOCKER-USER/FORWARD 和 peer 路由。',
    command: 'sudo ./scripts/manage.sh hdo repair-routes',
    runKind: 'repair-domestic-routes' as HdoDeploymentKind,
    done: hasNodeKind('domestic'),
    targetTab: 'topology',
    actionIcon: 'account_tree',
    actionLabel: '查看拓扑'
  },
  {
    key: 'gateway-status',
    title: '查看 D 网关状态',
    subtitle: '输出生成文件、live WG allowed-ips、transfer、hdo-home routes 和 iptables 放行情况。',
    command: 'sudo ./scripts/manage.sh hdo status',
    runKind: 'status' as HdoDeploymentKind,
    done: hasNodeKind('domestic'),
    targetTab: 'deploy',
    actionIcon: 'terminal',
    actionLabel: '查看任务'
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

const activeMembershipByUserId = computed(() => {
  const rows = new Map<string, HdoMeshMembershipRow>();
  for (const row of activeMemberships.value) {
    if (!rows.has(row.userId)) rows.set(row.userId, row);
  }
  return rows;
});

const topologyItems = computed<TopologyItem[]>(() => {
  const data = overview.value;
  if (!data) return [];

  const items: TopologyItem[] = [];
  const itemPositions = new Map<string, { x: number; y: number }>();
  const meshRows = data.meshGroups;
  const domesticRows = data.nodes.filter((row) => row.kind === 'domestic');
  const homeRows = data.nodes.filter((row) => row.kind === 'home');
  const overseaRows = data.nodes.filter((row) => row.kind === 'oversea');
  const firstMeshKey = meshRows[0] ? topologyKey('mesh', meshRows[0].id) : null;
  const firstDomesticKey = domesticRows[0] ? topologyKey('node', domesticRows[0].id) : firstMeshKey;

  meshRows.forEach((row, index) => {
    const visual = topologyStatus(row.enabled ? 'online' : 'offline');
    pushTopologyItem(items, itemPositions, {
      key: topologyKey('mesh', row.id),
      id: row.id,
      action: 'mesh',
      label: row.name,
      shortLabel: truncateLabel(row.name, 15),
      caption: row.slug || 'mesh',
      description: meshAddressPlanLabel(row),
      kindLabel: 'Mesh 组',
      statusLabel: row.enabled ? '启用' : '停用',
      color: visual.color,
      glyph: 'M',
      x: spreadPosition(index, meshRows.length, 170, 790),
      y: 74,
      overlayIp: meshAddressPlan(row).domesticIp,
      publicHost: null,
      userId: null,
      userLabel: null,
      profileLabel: row.defaultProfileId ? profilesById.value.get(row.defaultProfileId)?.name ?? row.defaultProfileId : null,
      rateLimitLabel: null,
      canRateLimit: false,
      parentKey: null
    });
  });

  addNodeTopologyItems(items, itemPositions, domesticRows, 480, 188, firstMeshKey);
  addNodeTopologyItems(items, itemPositions, homeRows, 235, 220, firstDomesticKey);
  addNodeTopologyItems(items, itemPositions, overseaRows, 725, 220, firstDomesticKey);

  data.devices.forEach((row, index) => {
    const member = activeMembershipByUserId.value.get(row.userId);
    const profileId = member?.profileId ?? (member ? meshById.value.get(member.meshGroupId)?.defaultProfileId : null);
    const owner = userLabel(row.userId);
    const visual = topologyStatus(row.status);
    pushTopologyItem(items, itemPositions, {
      key: topologyKey('device', row.id),
      id: row.id,
      action: 'device',
      label: `${owner} / ${row.label}`,
      shortLabel: truncateLabel(`${owner}/${row.label}`, 16),
      caption: row.platform ?? 'device',
      description: row.publicKey ? `WireGuard peer ${row.publicKey.slice(0, 10)}...` : '尚未登记 WireGuard 公钥',
      kindLabel: '客户端设备',
      statusLabel: visual.label,
      color: visual.color,
      glyph: 'D',
      x: spreadPosition(index % 6, Math.min(data.devices.length, 6), 145, 815),
      y: 350 + Math.floor(index / 6) * 82,
      overlayIp: row.overlayIp,
      publicHost: null,
      userId: row.userId,
      userLabel: owner,
      profileLabel: profileId ? profilesById.value.get(profileId)?.name ?? profileId : null,
      rateLimitLabel: rateLimitLabel('device', row.id) ?? rateLimitLabel('user', row.userId),
      canRateLimit: true,
      parentKey: firstDomesticKey
    });
  });

  data.services.forEach((row, index) => {
    const parentKey = serviceTopologyParentKey(row, itemPositions) ?? firstDomesticKey;
    const parent = parentKey ? itemPositions.get(parentKey) : null;
    const visual = topologyStatus(row.enabled ? 'online' : 'offline');
    pushTopologyItem(items, itemPositions, {
      key: topologyKey('service', row.id),
      id: row.id,
      action: 'service',
      label: row.name,
      shortLabel: truncateLabel(row.name, 15),
      caption: `${row.protocol} ${row.targetPort}`,
      description: `${row.targetHost}:${row.targetPort}`,
      kindLabel: '可访问服务',
      statusLabel: row.enabled ? '启用' : '停用',
      color: visual.color,
      glyph: 'S',
      x: clamp((parent?.x ?? 480) + serviceOffset(index), 88, 872),
      y: clamp((parent?.y ?? 280) + 92, 120, 492),
      overlayIp: row.targetHost,
      publicHost: row.domains[0] ?? null,
      userId: null,
      userLabel: null,
      profileLabel: null,
      rateLimitLabel: null,
      canRateLimit: false,
      parentKey
    });
  });

  data.profiles.forEach((row, index) => {
    const defaultMesh = meshRows.find((mesh) => mesh.defaultProfileId === row.id);
    const parentKey = defaultMesh ? topologyKey('mesh', defaultMesh.id) : firstMeshKey;
    const visual = topologyStatus(row.enabled ? 'online' : 'offline');
    pushTopologyItem(items, itemPositions, {
      key: topologyKey('profile', row.id),
      id: row.id,
      action: 'profile',
      label: row.name,
      shortLabel: truncateLabel(row.name, 15),
      caption: row.mode,
      description: '路由和出站策略',
      kindLabel: '路由 Profile',
      statusLabel: row.enabled ? '启用' : '停用',
      color: visual.color,
      glyph: 'P',
      x: spreadPosition(index, data.profiles.length, 230, 730),
      y: 145,
      overlayIp: null,
      publicHost: null,
      userId: null,
      userLabel: null,
      profileLabel: row.mode,
      rateLimitLabel: rateLimitLabel('profile', row.id),
      canRateLimit: true,
      parentKey
    });
  });

  return items;
});

const topologyEdges = computed<TopologyEdge[]>(() => {
  const byKey = new Map(topologyItems.value.map((item) => [item.key, item]));
  return topologyItems.value
    .filter((item) => item.parentKey && byKey.has(item.parentKey))
    .map((item) => {
      const parent = byKey.get(item.parentKey as string) as TopologyItem;
      return {
        key: `${parent.key}->${item.key}`,
        x1: parent.x,
        y1: parent.y,
        x2: item.x,
        y2: item.y
      };
    });
});

const selectedTopologyItem = computed(() => {
  const items = topologyItems.value;
  return items.find((item) => item.key === selectedTopologyKey.value) ?? items[0] ?? null;
});

const selectedTopologyServices = computed(() => {
  const selected = selectedTopologyItem.value;
  if (!selected) return [];
  return (overview.value?.services ?? []).filter((service) => serviceBelongsToTopologyItem(service, selected));
});

function isDeploymentKindRunning(kind: HdoDeploymentKind): boolean {
  return runningDeploymentJob.value?.kind === kind;
}

function hasAnyDeploymentRunning(): boolean {
  return Boolean(runningDeploymentJob.value || deployingKind.value);
}

function deploymentButtonDisabled(card: { runKind: HdoDeploymentKind }): boolean {
  return !deployments.value?.runner.available || hasAnyDeploymentRunning();
}

function deploymentButtonLabel(card: { runKind: HdoDeploymentKind }): string {
  if (isDeploymentKindRunning(card.runKind) || deployingKind.value === card.runKind) return '运行中';
  if (hasAnyDeploymentRunning()) return '等待中';
  const latestForKind = deploymentJobs.value.find((job) => job.kind === card.runKind);
  if (latestForKind?.status === 'succeeded') return '重新执行';
  return '执行';
}

function deploymentButtonIcon(card: { runKind: HdoDeploymentKind }): string {
  if (isDeploymentKindRunning(card.runKind) || deployingKind.value === card.runKind) return 'hourglass_top';
  if (hasAnyDeploymentRunning()) return 'lock';
  const latestForKind = deploymentJobs.value.find((job) => job.kind === card.runKind);
  if (latestForKind?.status === 'succeeded') return 'replay';
  return 'play_arrow';
}

function deploymentCardBadge(card: { runKind: HdoDeploymentKind; done: boolean }): { color: string; label: string } {
  const latestForKind = deploymentJobs.value.find((job) => job.kind === card.runKind);
  if (latestForKind?.status === 'running') return { color: 'info', label: '运行中' };
  if (latestForKind?.status === 'failed') return { color: 'negative', label: '失败' };
  if (latestForKind?.status === 'succeeded') return { color: 'positive', label: '已执行' };
  return { color: card.done ? 'positive' : 'warning', label: card.done ? '已登记' : '待处理' };
}

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

async function loadDeployments(options: { silent?: boolean } = {}): Promise<void> {
  if (!options.silent) deploymentLoading.value = true;
  try {
    deployments.value = await admin.getHdoDeployments();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (!options.silent) deploymentLoading.value = false;
  }
}

function pushTopologyItem(
  items: TopologyItem[],
  positions: Map<string, { x: number; y: number }>,
  item: TopologyItem
): void {
  items.push(item);
  positions.set(item.key, { x: item.x, y: item.y });
}

function addNodeTopologyItems(
  items: TopologyItem[],
  positions: Map<string, { x: number; y: number }>,
  rows: HdoNodeRow[],
  x: number,
  baseY: number,
  parentKey: string | null
): void {
  rows.forEach((row, index) => {
    const visual = topologyStatus(row.status);
    const wireGuard = wireGuardMetadata(row);
    const publicKey = stringValue(wireGuard?.publicKey);
    pushTopologyItem(items, positions, {
      key: topologyKey('node', row.id),
      id: row.id,
      action: 'node',
      label: row.name,
      shortLabel: truncateLabel(row.name, 15),
      caption: row.kind,
      description: publicKey ? `WireGuard ${publicKey.slice(0, 10)}...` : '尚未登记 WireGuard 公钥',
      kindLabel: nodeKindLabel(row.kind),
      statusLabel: visual.label,
      color: visual.color,
      glyph: nodeKindGlyph(row.kind),
      x,
      y: baseY + index * 76,
      overlayIp: row.overlayIp,
      publicHost: row.publicHost,
      userId: null,
      userLabel: null,
      profileLabel: null,
      rateLimitLabel: rateLimitLabel('node', row.id),
      canRateLimit: true,
      parentKey
    });
  });
}

function selectTopologyItem(key: string): void {
  selectedTopologyKey.value = key;
}

function openNode(id: string): void {
  const row = nodesById.value.get(id);
  if (!row) return;
  editNode(row);
  tab.value = 'nodes';
}

function openService(row: HdoServiceRow): void {
  editService(row);
  tab.value = 'services';
}

function openServiceById(id: string): void {
  const row = overview.value?.services.find((service) => service.id === id);
  if (row) openService(row);
}

function openProfile(id: string): void {
  const row = profilesById.value.get(id);
  if (!row) return;
  editProfile(row);
  tab.value = 'profiles';
}

function openRateLimit(item: TopologyItem): void {
  const subjectType =
    item.action === 'device' || item.action === 'node' || item.action === 'profile'
      ? item.action
      : null;
  if (!subjectType) return;
  rateSubjectType.value = subjectType;
  rateSubjectId.value = item.id;
  tab.value = 'limits';
}

function openDeviceTask(item: TopologyItem): void {
  if (item.action !== 'device' || !item.userId) return;
  taskUserId.value = item.userId;
  taskDeviceId.value = item.id;
  tab.value = 'tasks';
}

async function runDeployment(card: { runKind: HdoDeploymentKind }): Promise<void> {
  if (hasAnyDeploymentRunning()) return;
  deployingKind.value = card.runKind;
  error.value = null;
  try {
    const input: {
      kind: HdoDeploymentKind;
      publicHost?: string | null;
      port?: number | null;
    } = { kind: card.runKind };
    if (card.runKind === 'deploy-domestic') {
      input.publicHost = domesticDeploymentPublicHost.value;
      input.port = 51888;
    }
    await admin.runHdoDeployment(input);
    await loadDeployments();
    window.setTimeout(() => {
      void loadDeployments();
    }, 1800);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    await loadDeployments({ silent: true });
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
      enabled: true,
      metadata: {
        addressPlan: defaultMeshAddressPlanPayload(),
        gatewayPolicy: defaultGatewayPolicyPayload()
      }
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
      enabled: meshEnabled.value,
      metadata: buildMeshMetadata()
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
  const addressPlan = meshAddressPlan(row);
  meshHomeCidr.value = addressPlan.homeCidr;
  meshUserCidr.value = addressPlan.userCidr;
  meshServiceCidr.value = addressPlan.serviceCidr;
  meshDomesticIp.value = addressPlan.domesticIp;
  meshGatewayForwarding.value = meshGatewayPolicy(row).forwarding;
}

function resetMeshForm(): void {
  editingMeshId.value = null;
  meshName.value = '';
  meshSlug.value = '';
  meshDescription.value = '';
  meshDefaultProfileId.value = null;
  meshEnabled.value = true;
  meshHomeCidr.value = defaultMeshAddressPlan.homeCidr;
  meshUserCidr.value = defaultMeshAddressPlan.userCidr;
  meshServiceCidr.value = defaultMeshAddressPlan.serviceCidr;
  meshDomesticIp.value = defaultMeshAddressPlan.domesticIp;
  meshGatewayForwarding.value = true;
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

function buildMeshMetadata(): Record<string, unknown> {
  const existing = editingMeshId.value
    ? (meshById.value.get(editingMeshId.value)?.metadata ?? {})
    : {};
  return {
    ...existing,
    addressPlan: defaultMeshAddressPlanPayload({
      homeCidr: meshHomeCidr.value,
      userCidr: meshUserCidr.value,
      serviceCidr: meshServiceCidr.value,
      domesticIp: meshDomesticIp.value
    }),
    gatewayPolicy: defaultGatewayPolicyPayload(
      plainObject(existing.gatewayPolicy) ?? plainObject(plainObject(existing.wireGuard)?.gatewayPolicy),
      meshGatewayForwarding.value
    )
  };
}

function defaultMeshAddressPlanPayload(
  input: Partial<typeof defaultMeshAddressPlan> = {}
): Record<string, unknown> {
  const homeCidr = input.homeCidr?.trim() || defaultMeshAddressPlan.homeCidr;
  const userCidr = input.userCidr?.trim() || defaultMeshAddressPlan.userCidr;
  const serviceCidr = input.serviceCidr?.trim() || defaultMeshAddressPlan.serviceCidr;
  const domesticIp = input.domesticIp?.trim() || defaultMeshAddressPlan.domesticIp;
  return {
    homeCidr,
    userCidr,
    serviceCidr,
    domesticIp,
    routeCidrs: [homeCidr, userCidr, serviceCidr]
  };
}

function defaultGatewayPolicyPayload(
  existing: Record<string, unknown> | null = null,
  forwarding = true
): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    forwarding,
    interfaceName: stringValue(existing?.interfaceName) ?? 'hdo-home',
    firewall: stringValue(existing?.firewall) ?? 'auto'
  };
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

function meshAddressPlan(row: HdoMeshGroupRow): typeof defaultMeshAddressPlan {
  const metadata = plainObject(row.metadata);
  const wireGuard = plainObject(metadata?.wireGuard);
  const plan = plainObject(metadata?.addressPlan) ?? plainObject(wireGuard?.addressPlan);
  return {
    homeCidr: stringValue(plan?.homeCidr) ?? defaultMeshAddressPlan.homeCidr,
    userCidr: stringValue(plan?.userCidr) ?? defaultMeshAddressPlan.userCidr,
    serviceCidr: stringValue(plan?.serviceCidr) ?? defaultMeshAddressPlan.serviceCidr,
    domesticIp: stringValue(plan?.domesticIp) ?? defaultMeshAddressPlan.domesticIp
  };
}

function meshGatewayPolicy(row: HdoMeshGroupRow): { forwarding: boolean } {
  const metadata = plainObject(row.metadata);
  const wireGuard = plainObject(metadata?.wireGuard);
  const policy = plainObject(metadata?.gatewayPolicy) ?? plainObject(wireGuard?.gatewayPolicy);
  return {
    forwarding: typeof policy?.forwarding === 'boolean' ? policy.forwarding : true
  };
}

function meshAddressPlanLabel(row: HdoMeshGroupRow): string {
  const plan = meshAddressPlan(row);
  return `${plan.homeCidr} / ${plan.userCidr} / ${plan.serviceCidr}`;
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

function lastOutputLine(value: string): string {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.at(-1) ?? value.trim();
}

function topologyKey(action: TopologyAction, id: string): string {
  return `${action}:${id}`;
}

function topologyTooltip(item: TopologyItem): string {
  return [
    item.label,
    item.kindLabel,
    item.overlayIp ? `Overlay: ${item.overlayIp}` : null,
    item.publicHost ? `Public: ${item.publicHost}` : null,
    `Status: ${item.statusLabel}`
  ]
    .filter(Boolean)
    .join('\n');
}

function topologyStatus(status: string): { color: string; label: string } {
  if (status === 'online') return { color: 'positive', label: '在线' };
  if (status === 'pending') return { color: 'warning', label: '待处理' };
  if (status === 'error') return { color: 'negative', label: '异常' };
  return { color: 'grey-5', label: '离线' };
}

function nodeKindLabel(kind: HdoNodeRow['kind']): string {
  return {
    domestic: 'Domestic 网关',
    home: 'Home 节点',
    oversea: 'Oversea 节点'
  }[kind];
}

function nodeKindGlyph(kind: HdoNodeRow['kind']): string {
  return {
    domestic: 'G',
    home: 'H',
    oversea: 'O'
  }[kind];
}

function serviceTopologyParentKey(
  service: HdoServiceRow,
  positions: Map<string, { x: number; y: number }>
): string | null {
  if (service.nodeId) {
    const nodeKey = topologyKey('node', service.nodeId);
    if (positions.has(nodeKey)) return nodeKey;
  }
  const device = overview.value?.devices.find((row) => row.overlayIp === service.targetHost);
  if (device) return topologyKey('device', device.id);
  const node = overview.value?.nodes.find((row) => row.overlayIp === service.targetHost);
  return node ? topologyKey('node', node.id) : null;
}

function serviceBelongsToTopologyItem(service: HdoServiceRow, item: TopologyItem): boolean {
  if (item.action === 'mesh') return true;
  if (item.action === 'service') return service.id === item.id;
  if (item.action === 'node') return service.nodeId === item.id || service.targetHost === item.overlayIp;
  if (item.action === 'device') return service.targetHost === item.overlayIp;
  return false;
}

function rateLimitLabel(subjectType: HdoRateLimitRow['subjectType'], subjectId: string): string | null {
  const rows = (overview.value?.rateLimits ?? []).filter(
    (row) => row.subjectType === subjectType && row.subjectId === subjectId
  );
  if (!rows.length) return null;
  return rows
    .map((row) => {
      const down = [row.downRate, row.downCeil].filter(Boolean).join(' / ');
      const up = [row.upRate, row.upCeil].filter(Boolean).join(' / ');
      return [
        down ? `下行 ${down}` : null,
        up ? `上行 ${up}` : null
      ]
        .filter(Boolean)
        .join('，');
    })
    .filter(Boolean)
    .join('；');
}

function spreadPosition(index: number, total: number, start: number, end: number): number {
  if (total <= 1) return (start + end) / 2;
  return start + ((end - start) * index) / (total - 1);
}

function serviceOffset(index: number): number {
  return ((index % 3) - 1) * 84;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function truncateLabel(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(1, maxLength - 1))}…`;
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

onMounted(() => {
  void reload();
  deploymentPollTimer = window.setInterval(() => {
    if (runningDeploymentJob.value || deployingKind.value) {
      void loadDeployments({ silent: true });
    }
  }, DEPLOYMENT_POLL_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (deploymentPollTimer !== null) {
    window.clearInterval(deploymentPollTimer);
    deploymentPollTimer = null;
  }
});
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

  .section-subtitle {
    color: #667085;
    font-size: 13px;
    font-weight: 600;
    margin: 4px 0 8px;
  }

  .split-layout {
    display: grid;
    grid-template-columns: minmax(300px, 380px) minmax(0, 1fr);
    gap: 16px;
  }

  .deploy-flow {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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

  .topology-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(300px, 380px);
    gap: 16px;
  }

  .topology-legend {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    color: #667085;
    font-size: 12px;
  }

  .topology-legend span {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }

  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }

  .topology-map {
    width: 100%;
    min-height: 420px;
    border: 1px solid #e4e7ec;
    border-radius: 8px;
    background: #f8fafc;
  }

  .topology-edge {
    stroke: #cbd5e1;
    stroke-width: 2;
  }

  .topology-node {
    cursor: pointer;
    outline: none;
  }

  .topology-node-ring {
    fill: #ffffff;
    stroke: #d0d5dd;
    stroke-width: 2;
  }

  .topology-node-fill,
  .topology-status {
    fill: currentColor;
  }

  .topology-node-glyph {
    fill: #ffffff;
    font-size: 18px;
    font-weight: 700;
    text-anchor: middle;
    letter-spacing: 0;
    pointer-events: none;
  }

  .topology-node-label,
  .topology-node-caption {
    text-anchor: middle;
    letter-spacing: 0;
    pointer-events: none;
  }

  .topology-node-label {
    fill: #101828;
    font-size: 13px;
    font-weight: 700;
  }

  .topology-node-caption {
    fill: #667085;
    font-size: 11px;
  }

  .topology-node.is-selected .topology-node-ring,
  .topology-node:focus .topology-node-ring {
    stroke: #1976d2;
    stroke-width: 4;
  }

  .topology-detail-list {
    display: grid;
    gap: 8px;
  }

  .topology-detail-list > div {
    display: grid;
    grid-template-columns: 92px minmax(0, 1fr);
    gap: 8px;
    align-items: start;
    padding: 8px 0;
    border-bottom: 1px solid #eef2f6;
  }

  .topology-detail-list span {
    color: #667085;
    font-size: 12px;
  }

  .topology-detail-list strong {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .topology-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  @media (max-width: 980px) {
    .metric-grid,
    .split-layout,
    .topology-layout,
    .deploy-flow,
    .deploy-card-grid,
    .two-col {
      grid-template-columns: 1fr;
    }
  }
}
</style>
