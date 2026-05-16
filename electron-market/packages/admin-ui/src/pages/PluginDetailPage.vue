<template>
  <q-page class="content-panel plugin-detail-page">
    <div class="toolbar-row q-mb-md">
      <q-btn flat round icon="arrow_back" to="/" />
      <div>
        <div class="text-h5 text-weight-bold">{{ plugin?.manifest.name ?? id }}</div>
        <div class="plugin-id">{{ id }}<span v-if="plugin">@{{ plugin.version }}</span></div>
      </div>
      <q-space />

      <q-chip
        v-if="plugin"
        :color="stateColor(plugin.state)"
        text-color="white"
        :icon="stateIcon(plugin.state)"
      >
        {{ stateLabel(plugin.state) }}
      </q-chip>

      <q-btn
        v-if="plugin?.state === 'active'"
        outline
        color="secondary"
        icon="pause"
        label="停用"
        @click="host.deactivate(plugin.id)"
      />
      <q-btn
        v-else-if="plugin"
        color="primary"
        icon="play_arrow"
        label="激活"
        :disable="plugin.state === 'awaitingGrant'"
        @click="host.activate(plugin.id)"
      />

      <q-btn flat icon="article" label="日志" :to="`/logs/${encodeURIComponent(id)}`" />
    </div>

    <!-- Plugin not installed -->
    <div v-if="!plugin" class="section-surface q-pa-xl text-center text-grey-7">
      该插件尚未安装。
      <router-link to="/marketplace">前往市场</router-link> 浏览。
    </div>

    <template v-else>
      <div class="detail-grid">
        <!-- Left column: metadata + permissions -->
        <div class="detail-side">
          <section class="section-surface q-pa-md">
            <div class="text-subtitle2 text-weight-bold q-mb-sm">基本信息</div>
            <div class="detail-row">
              <span class="detail-label">作者</span>
              <span>{{ plugin.manifest.author ?? '—' }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">版本</span>
              <span>{{ plugin.version }}</span>
            </div>
            <div class="detail-row">
              <span class="detail-label">引擎</span>
              <span class="text-caption">
                electron-market {{ plugin.manifest.engines.electronMarket ?? plugin.manifest.engines.electronPlugin ?? '—' }}
              </span>
            </div>
            <div class="detail-row">
              <span class="detail-label">安装路径</span>
              <span class="text-caption ellipsis" :title="plugin.installPath">
                {{ plugin.installPath }}
              </span>
            </div>
            <p class="q-mt-md text-body2">{{ plugin.manifest.description }}</p>
          </section>

          <section class="section-surface q-pa-md q-mt-md">
            <div class="text-subtitle2 text-weight-bold q-mb-sm">权限</div>
            <div
              v-for="perm in plugin.manifest.permissions"
              :key="perm"
              class="permission-row q-mb-xs"
            >
              <q-icon
                :name="plugin.grantedPermissions.includes(perm) ? 'check_circle' : 'cancel'"
                :color="plugin.grantedPermissions.includes(perm) ? 'positive' : 'grey-6'"
                size="18px"
              />
              <div class="col">
                <div class="permission-name">{{ perm }}</div>
              </div>
            </div>
          </section>
        </div>

        <!-- Right column: the plugin's own admin panel embedded in an iframe -->
        <div class="detail-main">
          <section class="section-surface plugin-admin-frame-wrapper">
            <div class="frame-bar">
              <q-icon name="open_in_new" size="16px" color="primary" />
              <span class="text-body2 text-weight-medium">
                插件管理面板
                <span v-if="adminUrl" class="text-grey-7">— {{ adminUrl }}</span>
              </span>
              <q-space />
              <q-btn
                v-if="adminUrl"
                flat
                dense
                size="sm"
                icon="open_in_new"
                label="新标签打开"
                @click="openExternal"
              />
              <q-btn
                v-if="adminUrl"
                flat
                dense
                size="sm"
                icon="refresh"
                @click="reloadFrame"
              />
            </div>

            <div v-if="!adminUrl" class="frame-empty">
              该插件未声明 <code>contributes.adminPanel</code>，没有可嵌入的面板。
            </div>
            <div v-else-if="plugin.state !== 'active'" class="frame-empty">
              插件尚未激活；激活后面板会自动加载。
            </div>
            <iframe
              v-else
              ref="iframeEl"
              :src="adminUrl"
              class="plugin-admin-frame"
              :title="`${plugin.manifest.name} admin`"
              loading="lazy"
            />
          </section>
        </div>
      </div>
    </template>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { usePluginHost } from 'src/composables/usePluginHost';
import type { PluginState } from 'src/types/api';

const props = defineProps<{ id: string }>();
const host = usePluginHost();

const iframeEl = ref<HTMLIFrameElement | null>(null);

onMounted(() => {
  host.refreshInstalled();
});

// Light polling so state badges + permissions update in real time after
// the user grants/activates from elsewhere.
const interval = setInterval(() => host.refreshInstalled(), 3500);
watch(
  () => props.id,
  () => host.refreshInstalled()
);
window.addEventListener('beforeunload', () => clearInterval(interval));

const plugin = computed(() => host.findInstalled(props.id));
const adminUrl = computed(() => plugin.value?.manifest.contributes?.adminPanel?.url ?? null);

function stateLabel(s: PluginState): string {
  return { installed: '已安装', awaitingGrant: '待授权', active: '运行中', errored: '出错', disabled: '已停用' }[s];
}
function stateColor(s: PluginState): string {
  return { installed: 'grey-7', awaitingGrant: 'warning', active: 'positive', errored: 'negative', disabled: 'grey-5' }[s];
}
function stateIcon(s: PluginState): string {
  return { installed: 'inventory_2', awaitingGrant: 'lock_open', active: 'check_circle', errored: 'error', disabled: 'block' }[s];
}

function reloadFrame(): void {
  if (iframeEl.value && adminUrl.value) {
    // Force a hard reload by reassigning src.
    iframeEl.value.src = adminUrl.value + '?_t=' + Date.now();
  }
}

function openExternal(): void {
  if (adminUrl.value) window.open(adminUrl.value, '_blank', 'noopener');
}
</script>

<style scoped lang="scss">
.plugin-detail-page {
  display: flex;
  flex-direction: column;
}

.detail-grid {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 18px;
  flex: 1;
  min-height: 0;
}

.detail-side {
  min-width: 0;
}

.detail-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.detail-row {
  display: flex;
  gap: 12px;
  padding: 4px 0;
  font-size: 13px;
}
.detail-label {
  width: 70px;
  color: #6d7280;
  flex-shrink: 0;
}

.plugin-admin-frame-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1;
  padding: 0;
  overflow: hidden;
}

.frame-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid #eef0f3;
  background: #f7f9fc;
}

.frame-empty {
  padding: 64px 24px;
  text-align: center;
  color: #6d7280;
}

.plugin-admin-frame {
  flex: 1;
  border: 0;
  width: 100%;
  min-height: calc(100vh - 260px);
  background: #ffffff;
}

@media (max-width: 900px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}
</style>
