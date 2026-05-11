<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="text-h4 text-weight-bold">隧道管理</div>
      <q-space />
      <q-btn round flat icon="refresh" @click="refresh" />
      <q-btn round flat icon="open_in_browser" @click="openAdmin" />
      <q-btn round color="primary" :icon="snapshot?.status.running ? 'stop' : 'play_arrow'" @click="toggleCore" />
    </div>

    <div class="status-strip q-mb-md">
      <div class="metric-cell">
        <div class="metric-label">运行状态</div>
        <div class="metric-value">{{ snapshot?.status.running ? '运行中' : '已停止' }}</div>
      </div>
      <div class="metric-cell">
        <div class="metric-label">当前模式</div>
        <div class="metric-value">{{ modeLabel }}</div>
      </div>
      <div class="metric-cell">
        <div class="metric-label">本地代理</div>
        <div class="metric-value">:{{ snapshot?.status.ports.mixed ?? 7890 }}</div>
      </div>
      <div class="metric-cell">
        <div class="metric-label">管理后台</div>
        <div class="metric-value">:{{ snapshot?.status.ports.admin ?? 23456 }}</div>
      </div>
      <div class="metric-cell">
        <div class="metric-label">控制接口</div>
        <div class="metric-value">:{{ snapshot?.status.ports.controller ?? 23457 }}</div>
      </div>
    </div>

    <section class="section-surface q-pa-md q-mb-md">
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

    <section class="section-surface q-pa-md q-mb-md">
      <div class="toolbar-row">
        <q-input v-model="corePath" dense outlined placeholder="自动使用内置隧道引擎" class="col" />
        <q-btn color="primary" icon="save" label="保存引擎路径" @click="saveCorePath" />
      </div>
    </section>

    <section class="section-surface q-pa-md q-mb-md">
      <div class="toolbar-row q-mb-md">
        <q-input v-model="subscriptionForm.url" dense outlined placeholder="订阅文件链接" class="col" />
        <q-input v-model="subscriptionForm.name" dense outlined placeholder="名称" style="width: 180px" />
        <q-input v-model="subscriptionForm.username" dense outlined placeholder="用户" style="width: 140px" />
        <q-input v-model="subscriptionForm.password" dense outlined type="password" placeholder="密码" style="width: 140px" />
        <q-btn color="primary" icon="add" label="新建" @click="createSubscription" />
        <q-btn outline color="primary" icon="download" label="更新当前" @click="updateActiveSubscription" />
      </div>

      <div class="subscription-grid">
        <div
          v-for="subscription in snapshot?.subscriptions"
          :key="subscription.id"
          class="subscription-card q-pa-md"
          :class="{ active: subscription.active }"
        >
          <div class="row items-center no-wrap q-gutter-sm">
            <q-icon name="drag_indicator" size="24px" />
            <div class="text-h6 ellipsis">{{ subscription.name }}</div>
            <q-space />
            <q-btn flat round dense icon="refresh" @click="updateSubscription(subscription.id)" />
          </div>
          <div class="text-grey-7 ellipsis q-mt-xs">{{ redactedUrl(subscription.url) }}</div>
          <div class="row items-center q-mt-md">
            <span class="text-grey-6">{{ subscription.lastUpdatedAt ? relativeTime(subscription.lastUpdatedAt) : '未更新' }}</span>
            <q-space />
            <q-btn dense outline color="primary" label="启用" @click="setActive(subscription.id)" />
          </div>
        </div>
      </div>
    </section>

    <section class="section-surface q-pa-md q-mb-md">
      <div class="toolbar-row q-mb-md">
        <q-btn outline color="primary" icon="public" label="Google" @click="addPreset('google')" />
        <q-btn outline color="primary" icon="smart_display" label="YouTube" @click="addPreset('youtube')" />
        <q-btn outline color="primary" icon="alternate_email" label="X / Twitter" @click="addPreset('x')" />
        <q-btn outline color="primary" icon="send" label="Telegram" @click="addPreset('telegram')" />
        <q-space />
        <q-input v-model="ruleForm.domain" dense outlined placeholder="example.com" style="width: 220px" />
        <q-select v-model="ruleForm.kind" dense outlined emit-value map-options :options="ruleKindOptions" style="width: 130px" />
        <q-btn color="primary" icon="add" label="添加" @click="addRule" />
      </div>

      <div class="row q-col-gutter-sm">
        <div v-for="rule in snapshot?.rules" :key="rule.id" class="col-12 col-sm-6 col-md-4">
          <q-item class="section-surface">
            <q-item-section avatar>
              <q-icon :name="rule.kind === 'allow' ? 'check_circle' : 'block'" :color="rule.kind === 'allow' ? 'positive' : 'negative'" />
            </q-item-section>
            <q-item-section>
              <q-item-label>{{ rule.domain }}</q-item-label>
              <q-item-label caption>{{ rule.source }}</q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-btn flat round dense icon="delete" @click="removeRule(rule.id)" />
            </q-item-section>
          </q-item>
        </div>
      </div>
    </section>

    <section class="section-surface q-pa-md">
      <div class="toolbar-row q-mb-sm">
        <div class="text-h6">日志</div>
        <q-space />
        <q-btn flat round icon="refresh" @click="refresh" />
      </div>
      <div class="mono-log">{{ eventText }}</div>
    </section>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { Notify } from 'quasar';

import type { RuntimeMode, TunnelSnapshot } from 'src/types/tunnel';

type Preset = 'google' | 'youtube' | 'x' | 'telegram';

const snapshot = ref<TunnelSnapshot | null>(null);
const selectedMode = ref<RuntimeMode>('app-rule');
const corePath = ref('');
const subscriptionForm = reactive({
  name: '',
  url: '',
  username: '',
  password: ''
});
const ruleForm = reactive({
  kind: 'allow' as 'allow' | 'block',
  domain: ''
});

const modeOptions = [
  { label: '虚拟网卡', value: 'system-tun' },
  { label: '全局模式', value: 'app-global' },
  { label: 'App 模式', value: 'app-rule' }
];

const ruleKindOptions = [
  { label: '白名单', value: 'allow' },
  { label: '黑名单', value: 'block' }
];

const modeLabel = computed(() => modeOptions.find((item) => item.value === snapshot.value?.status.mode)?.label ?? 'App 模式');
const eventText = computed(() => (snapshot.value?.events ?? [])
  .map((event) => `[${event.level}] ${new Date(event.createdAt).toLocaleString()} ${event.message}`)
  .join('\n'));

function toast(message: string, color = 'positive'): void {
  Notify.create({ message, color, timeout: 1400, position: 'top-right' });
}

function redactedUrl(url: string): string {
  return url.replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
}

function relativeTime(value: string): string {
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.max(1, Math.round(diff / 60000));
  if (minutes < 60) {
    return `${minutes} 分钟前`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} 小时前`;
  }
  return `${Math.round(hours / 24)} 天前`;
}

async function run(action: () => Promise<unknown>, message: string): Promise<void> {
  try {
    await action();
    await refresh();
    toast(message);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 'negative');
  }
}

async function refresh(): Promise<void> {
  snapshot.value = await window.tunnel.snapshot();
  selectedMode.value = snapshot.value.status.mode;
  corePath.value = snapshot.value.status.corePath ?? '';
}

async function saveMode(): Promise<void> {
  await run(() => window.tunnel.setMode(selectedMode.value), '模式已切换');
}

async function installTun(): Promise<void> {
  await run(() => window.tunnel.installTun(), 'TUN 已安装');
}

async function saveCorePath(): Promise<void> {
  await run(() => window.tunnel.setCorePath(corePath.value), '引擎路径已保存');
}

async function uninstallTun(): Promise<void> {
  await run(() => window.tunnel.uninstallTun(), 'TUN 已卸载');
}

async function toggleCore(): Promise<void> {
  if (snapshot.value?.status.running) {
    await run(() => window.tunnel.stop(), '隧道已停止');
    return;
  }
  await run(() => window.tunnel.start(), '隧道已启动');
}

async function createSubscription(): Promise<void> {
  await run(async () => {
    await window.tunnel.createSubscription({ ...subscriptionForm });
    subscriptionForm.name = '';
    subscriptionForm.url = '';
    subscriptionForm.username = '';
    subscriptionForm.password = '';
  }, '订阅已保存');
}

async function setActive(id: number): Promise<void> {
  await run(() => window.tunnel.setActiveSubscription(id), '订阅已启用');
}

async function updateSubscription(id: number): Promise<void> {
  await run(() => window.tunnel.updateSubscription(id), '订阅已更新');
}

async function updateActiveSubscription(): Promise<void> {
  await run(() => window.tunnel.updateActiveSubscription(), '当前订阅已更新');
}

async function addPreset(preset: Preset): Promise<void> {
  await run(() => window.tunnel.addPreset(preset), '白名单集合已加入');
}

async function addRule(): Promise<void> {
  await run(async () => {
    await window.tunnel.addRule({ ...ruleForm });
    ruleForm.domain = '';
  }, '规则已添加');
}

async function removeRule(id: number): Promise<void> {
  await run(() => window.tunnel.removeRule(id), '规则已删除');
}

function openAdmin(): void {
  const url = snapshot.value?.status.adminUrl ?? 'http://127.0.0.1:23456';
  window.open(url, '_blank');
}

onMounted(() => {
  void refresh();
});
</script>
