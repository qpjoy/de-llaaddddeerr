<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">首页</div>
      <q-space />
      <q-btn round flat icon="refresh" @click="refresh" />
      <q-btn round flat icon="open_in_browser" @click="openAdmin" />
      <q-btn round outline color="primary" icon="restart_alt" @click="restartCore" />
      <q-btn round color="primary" :icon="snapshot?.status.running ? 'stop' : 'play_arrow'" @click="toggleCore" />
    </div>

    <div class="content-stack">
      <div class="status-strip">
        <div class="metric-cell">
          <div class="metric-label">运行状态</div>
          <div class="metric-value">{{ snapshot?.status.running ? '运行中' : '已停止' }}</div>
        </div>
        <div class="metric-cell">
          <div class="metric-label">当前模式</div>
          <div class="metric-value">{{ modeLabel }}</div>
        </div>
        <div class="metric-cell">
          <div class="metric-label">当前订阅</div>
          <div class="metric-value ellipsis">{{ snapshot?.status.activeSubscription?.name ?? '未选择' }}</div>
        </div>
        <div class="metric-cell">
          <div class="metric-label">连接数</div>
          <div class="metric-value">{{ snapshot?.traffic.connections ?? 0 }}</div>
        </div>
      </div>

      <div class="status-strip">
        <div class="metric-cell">
          <div class="metric-label">上传总量</div>
          <div class="metric-value">{{ formatBytes(snapshot?.traffic.uploadTotal ?? 0) }}</div>
        </div>
        <div class="metric-cell">
          <div class="metric-label">下载总量</div>
          <div class="metric-value">{{ formatBytes(snapshot?.traffic.downloadTotal ?? 0) }}</div>
        </div>
        <div class="metric-cell">
          <div class="metric-label">本地代理</div>
          <div class="metric-value">:{{ snapshot?.status.ports.mixed ?? 23458 }}</div>
        </div>
        <div class="metric-cell">
          <div class="metric-label">管理后台</div>
          <div class="metric-value">:{{ snapshot?.status.ports.admin ?? 23456 }}</div>
        </div>
      </div>

      <section class="section-surface q-pa-md">
        <div class="toolbar-row">
          <q-btn color="primary" icon="download" label="更新当前订阅" @click="updateActiveSubscription" />
          <q-btn outline color="primary" icon="open_in_browser" label="浏览器后台" @click="openAdmin" />
          <q-chip :color="snapshot?.status.tunInstalled ? 'positive' : 'grey-6'" text-color="white">
            TUN {{ snapshot?.status.tunInstalled ? '已安装' : '未安装' }}
          </q-chip>
          <q-chip :color="snapshot?.traffic.available ? 'positive' : 'grey-6'" text-color="white">
            流量 {{ snapshot?.traffic.available ? '可读' : '未连接' }}
          </q-chip>
        </div>
      </section>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';

import { useTunnel } from 'src/composables/useTunnel';

const {
  snapshot,
  modeLabel,
  refresh,
  run,
  formatBytes,
  toggleCore
} = useTunnel();

async function restartCore(): Promise<void> {
  await run(() => window.tunnel.restart(), '隧道已重启');
}

async function updateActiveSubscription(): Promise<void> {
  await run(() => window.tunnel.updateActiveSubscription(), '当前订阅已更新');
}

async function openAdmin(): Promise<void> {
  await run(() => window.tunnel.openAdmin(), '已打开后台');
}

onMounted(() => {
  void refresh();
});
</script>
