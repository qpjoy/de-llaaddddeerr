<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">测试</div>
      <q-space />
      <q-btn round flat icon="refresh" @click="refresh" />
    </div>

    <div class="content-stack">
      <section class="section-surface q-pa-md">
        <div class="toolbar-row">
          <q-input v-model="testUrl" dense outlined placeholder="https://www.google.com" class="col" @keyup.enter="openTest" />
          <q-btn color="primary" icon="open_in_new" label="打开测试窗口" @click="openTest" />
        </div>
      </section>

      <section class="section-surface q-pa-md">
        <div class="toolbar-row">
          <q-btn outline color="primary" icon="public" label="Google" @click="openQuick('https://www.google.com')" />
          <q-btn outline color="primary" icon="smart_display" label="YouTube" @click="openQuick('https://www.youtube.com')" />
          <q-btn outline color="primary" icon="alternate_email" label="X" @click="openQuick('https://x.com')" />
          <q-btn outline color="primary" icon="send" label="Telegram" @click="openQuick('https://web.telegram.org')" />
        </div>
      </section>

      <div class="status-strip">
        <div class="metric-cell">
          <div class="metric-label">当前模式</div>
          <div class="metric-value">{{ modeLabel }}</div>
        </div>
        <div class="metric-cell">
          <div class="metric-label">本地代理</div>
          <div class="metric-value">:{{ snapshot?.status.ports.mixed ?? 23458 }}</div>
        </div>
        <div class="metric-cell">
          <div class="metric-label">运行状态</div>
          <div class="metric-value">{{ snapshot?.status.running ? '运行中' : '已停止' }}</div>
        </div>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { useTunnel } from 'src/composables/useTunnel';

const {
  snapshot,
  modeLabel,
  refresh,
  run
} = useTunnel();

const testUrl = ref('https://www.google.com');

async function openTest(): Promise<void> {
  await run(() => window.tunnel.openTestWindow(testUrl.value), '已打开测试窗口');
}

async function openQuick(url: string): Promise<void> {
  testUrl.value = url;
  await openTest();
}

onMounted(() => {
  void refresh();
});
</script>
