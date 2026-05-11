<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">订阅</div>
      <q-space />
      <q-btn round flat icon="refresh" @click="refresh" />
      <q-btn outline color="primary" icon="download" label="更新当前" @click="updateActiveSubscription" />
    </div>

    <div class="content-stack">
      <section class="section-surface q-pa-md">
        <div class="toolbar-row">
          <q-input v-model="subscriptionForm.url" dense outlined placeholder="订阅文件链接" class="col" />
          <q-input v-model="subscriptionForm.name" dense outlined placeholder="名称" style="width: 180px" />
          <q-input v-model="subscriptionForm.username" dense outlined placeholder="用户" style="width: 140px" />
          <q-input v-model="subscriptionForm.password" dense outlined type="password" placeholder="密码" style="width: 140px" />
          <q-btn color="primary" icon="add" label="新建" @click="createSubscription" />
        </div>
      </section>

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
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, reactive } from 'vue';

import { useTunnel } from 'src/composables/useTunnel';

const {
  snapshot,
  refresh,
  run,
  redactedUrl,
  relativeTime
} = useTunnel();

const subscriptionForm = reactive({
  name: '',
  url: '',
  username: '',
  password: ''
});

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

onMounted(() => {
  void refresh();
});
</script>
