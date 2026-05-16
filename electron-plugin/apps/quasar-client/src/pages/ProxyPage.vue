<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">代理</div>
      <q-space />
      <q-btn round flat icon="refresh" @click="refresh" />
    </div>

    <div class="content-stack">
      <section class="section-surface q-pa-md">
        <div class="toolbar-row">
          <q-select
            v-model="selectedMode"
            dense
            outlined
            emit-value
            map-options
            :options="modeOptions"
            style="min-width: 220px"
          />
          <q-btn color="primary" icon="sync_alt" label="切换" @click="saveMode" />
          <q-btn outline color="primary" icon="add_moderator" label="安装 TUN" @click="installTun" />
          <q-btn outline color="negative" icon="remove_moderator" label="卸载 TUN" @click="uninstallTun" />
          <q-chip :color="snapshot?.status.tunInstalled ? 'positive' : 'grey-6'" text-color="white">
            TUN {{ snapshot?.status.tunInstalled ? '已安装' : '未安装' }}
          </q-chip>
        </div>
      </section>

      <section class="section-surface q-pa-md">
        <div class="toolbar-row">
          <q-input v-model="corePath" dense outlined placeholder="自动使用内置隧道引擎" class="col" />
          <q-btn color="primary" icon="save" label="保存引擎路径" @click="saveCorePath" />
        </div>
      </section>

      <section class="section-surface q-pa-md">
        <div class="toolbar-row">
          <q-input
            v-model.number="localPorts.mixed"
            dense
            outlined
            type="number"
            label="本地代理端口"
            style="width: 220px"
          />
          <q-input
            v-model.number="localPorts.dns"
            dense
            outlined
            type="number"
            label="DNS 端口"
            style="width: 220px"
          />
          <q-btn color="primary" icon="save" label="保存端口" @click="saveLocalPorts" />
          <q-chip color="grey-7" text-color="white">
            推荐 23458 / 23459，避开 Clash 7890
          </q-chip>
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
          <div class="metric-label">DNS</div>
          <div class="metric-value">:{{ snapshot?.status.ports.dns ?? 23459 }}</div>
        </div>
        <div class="metric-cell">
          <div class="metric-label">控制接口</div>
          <div class="metric-value">:{{ snapshot?.status.ports.controller ?? 23457 }}</div>
        </div>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';

import { modeOptions, useTunnel } from 'src/composables/useTunnel';

const {
  snapshot,
  selectedMode,
  corePath,
  localPorts,
  modeLabel,
  refresh,
  run
} = useTunnel();

async function saveMode(): Promise<void> {
  await run(() => window.tunnel.setMode(selectedMode.value), '模式已切换');
}

async function installTun(): Promise<void> {
  await run(() => window.tunnel.installTun(), 'TUN 已安装');
}

async function uninstallTun(): Promise<void> {
  await run(() => window.tunnel.uninstallTun(), 'TUN 已卸载');
}

async function saveCorePath(): Promise<void> {
  await run(() => window.tunnel.setCorePath(corePath.value), '引擎路径已保存');
}

async function saveLocalPorts(): Promise<void> {
  await run(() => window.tunnel.setLocalPorts({ ...localPorts.value }), '本地端口已保存');
}

onMounted(() => {
  void refresh();
});
</script>
