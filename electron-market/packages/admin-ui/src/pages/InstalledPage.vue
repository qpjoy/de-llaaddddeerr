<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">已安装插件</div>
      <q-space />
      <q-btn flat round icon="refresh" @click="host.refreshInstalled()" />
      <q-btn color="primary" icon="add" label="安装本地包…" @click="openLocalInstall" />
    </div>

    <div v-if="visibleInstalled.length === 0" class="section-surface q-pa-xl text-center text-grey-7">
      还没有任何插件。打开 <router-link to="/marketplace">市场</router-link> 浏览，或安装本地 tarball / 目录。
    </div>

    <div class="plugin-grid">
      <div
        v-for="plugin in visibleInstalled"
        :key="plugin.id"
        class="plugin-card"
        :class="{ active: plugin.state === 'active' || isSelfPlugin(plugin) }"
      >
        <div class="plugin-card-header">
          <q-icon
            :name="plugin.manifest.contributes?.adminPanel ? 'open_in_new' : 'extension'"
            color="primary"
            size="22px"
          />
          <div class="col">
            <div class="text-subtitle1 text-weight-bold">{{ plugin.manifest.name }}</div>
            <div class="plugin-id">{{ plugin.id }}@{{ plugin.version }}</div>
          </div>
          <q-chip :color="isSelfPlugin(plugin) ? 'positive' : stateColor(plugin.state)" text-color="white" dense>
            {{ isSelfPlugin(plugin) ? '运行中' : stateLabel(plugin.state) }}
          </q-chip>
        </div>

        <div v-if="plugin.errorMessage" class="text-negative text-caption">
          {{ plugin.errorMessage }}
        </div>

        <div class="text-caption text-grey-8">
          {{ plugin.manifest.description || '（无描述）' }}
        </div>

        <div class="text-caption">
          权限：
          <span v-if="plugin.grantedPermissions.length === plugin.manifest.permissions.length" class="text-positive">
            全部已授予 ({{ plugin.grantedPermissions.length }})
          </span>
          <span v-else class="text-warning">
            {{ plugin.grantedPermissions.length }} / {{ plugin.manifest.permissions.length }} 已授予
          </span>
        </div>

        <div class="toolbar-row q-mt-sm">
          <q-chip
            v-if="isSelfPlugin(plugin)"
            color="positive"
            text-color="white"
            icon="verified"
            dense
          >
            内置运行中
          </q-chip>
          <template v-else>
            <q-btn
              v-if="plugin.state === 'awaitingGrant'"
              color="primary"
              icon="lock_open"
              label="审核权限"
              @click="openGrant(plugin)"
            />
            <q-btn
              v-else-if="plugin.state !== 'active'"
              color="primary"
              icon="play_arrow"
              label="激活"
              @click="host.activate(plugin.id)"
            />
            <q-btn
              v-else
              outline
              color="secondary"
              icon="pause"
              label="停用"
              @click="host.deactivate(plugin.id)"
            />
          </template>

          <q-btn
            v-if="plugin.manifest.contributes?.adminPanel && !isSelfPlugin(plugin)"
            flat
            icon="open_in_new"
            :label="plugin.manifest.contributes.adminPanel.label || '管理面板'"
            :to="`/plugin/${encodeURIComponent(plugin.id)}`"
          />

          <q-btn flat icon="article" label="日志" :to="`/logs/${encodeURIComponent(plugin.id)}`" />

          <q-space />

          <!-- Newer version available on the marketplace? -->
          <q-btn
            v-if="canRepairSeed(plugin)"
            outline
            color="primary"
            icon="restart_alt"
            label="修复预装"
            :loading="host.busy.value"
            :disable="host.busy.value"
            @click="host.reseed(plugin.id)"
          />

          <q-btn
            v-if="!isSelfPlugin(plugin) && latestFor(plugin.id) && host.hasUpgrade(plugin.id, latestFor(plugin.id))"
            color="primary"
            icon="upgrade"
            :label="`升级到 ${latestFor(plugin.id)}`"
            :loading="host.busy.value"
            :disable="host.busy.value"
            @click="host.upgrade(plugin.id, latestFor(plugin.id))"
          />

          <q-btn v-if="!isSelfPlugin(plugin)" flat color="negative" icon="delete" @click="confirmUninstall(plugin.id)" />
        </div>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { Dialog } from 'quasar';

import PermissionGrantDialog from 'src/components/PermissionGrantDialog.vue';
import { usePluginHost } from 'src/composables/usePluginHost';
import type { InstalledPluginRecord, PluginState } from 'src/types/api';

const host = usePluginHost();
const MARKETPLACE_SELF_PLUGIN_ID = 'qpjoy.electron-market';
const visibleInstalled = computed(() => host.installed.value.filter((plugin) => !isSelfPlugin(plugin)));

onMounted(() => {
  host.refreshInstalled();
  // Pull the marketplace too so `latestFor()` can detect upgrades.
  host.refreshMarketplace();
  // Light polling so live state stays roughly fresh.
  const iv = setInterval(() => host.refreshInstalled(), 4000);
  return () => clearInterval(iv);
});

/** Latest version on the marketplace for `id`, if any. */
function latestFor(id: string): string | undefined {
  return host.marketplace.value?.entries.find((e) => e.id === id)?.latest;
}

function isSelfPlugin(plugin: InstalledPluginRecord): boolean {
  return plugin.id === MARKETPLACE_SELF_PLUGIN_ID || plugin.npm === '@qpjoy/electron-market';
}

function canRepairSeed(plugin: InstalledPluginRecord): boolean {
  return !isSelfPlugin(plugin) && host.isSeedable(plugin.id) && plugin.state === 'errored';
}

function stateLabel(s: PluginState): string {
  return {
    installed: '已安装',
    awaitingGrant: '待授权',
    active: '运行中',
    errored: '出错',
    disabled: '已停用'
  }[s];
}
function stateColor(s: PluginState): string {
  return {
    installed: 'grey-7',
    awaitingGrant: 'warning',
    active: 'positive',
    errored: 'negative',
    disabled: 'grey-5'
  }[s];
}

function openGrant(plugin: InstalledPluginRecord) {
  Dialog.create({
    component: PermissionGrantDialog,
    componentProps: { plugin }
  }).onOk(async (payload: { permissions: string[]; activate: boolean }) => {
    await host.grant(plugin.id, payload.permissions);
    if (payload.activate) {
      await host.activate(plugin.id);
    }
  });
}

function confirmUninstall(id: string) {
  const isBootstrap = host.isSeedable(id);
  Dialog.create({
    title: '确认卸载',
    message: isBootstrap
      ? `要卸载 ${id} 吗？这是客户端预装的核心插件，卸载后可以从「市场」用「重新预装」找回。`
      : `要卸载 ${id} 吗？该插件的安装目录会被删除，但用户数据保留。`,
    ok: { label: '卸载', color: 'negative' },
    cancel: { label: '取消', flat: true }
  }).onOk(() => host.uninstall(id));
}

function openLocalInstall() {
  Dialog.create({
    title: '安装本地包',
    message: '输入 tarball (.tgz) 路径或一个包目录的绝对路径。',
    prompt: { model: '', type: 'text', label: '路径' },
    cancel: true
  }).onOk((rawPath: string) => {
    const trimmed = rawPath.trim();
    if (!trimmed) return;
    const sourceType = trimmed.endsWith('.tgz') ? 'tarball' : 'local-dir';
    Dialog.create({
      title: '插件元信息',
      message: '填写插件 id 和它的 npm 包名（必须和 manifest 中一致）。',
      prompt: { model: '', type: 'text', label: 'id  npm（用空格分隔）' },
      cancel: true
    }).onOk((idAndNpm: string) => {
      const [id, npm] = idAndNpm.trim().split(/\s+/);
      if (!id || !npm) return;
      host.installLocal({ id, npm, source: { type: sourceType, path: trimmed } });
    });
  });
}
</script>
