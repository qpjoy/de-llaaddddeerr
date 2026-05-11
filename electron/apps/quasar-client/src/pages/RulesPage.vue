<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">规则</div>
      <q-space />
      <q-btn round flat icon="refresh" @click="refresh" />
    </div>

    <div class="content-stack">
      <section class="section-surface q-pa-md">
        <div class="toolbar-row">
          <q-btn outline color="primary" icon="public" label="Google" @click="addPreset('google')" />
          <q-btn outline color="primary" icon="smart_display" label="YouTube" @click="addPreset('youtube')" />
          <q-btn outline color="primary" icon="alternate_email" label="X / Twitter" @click="addPreset('x')" />
          <q-btn outline color="primary" icon="send" label="Telegram" @click="addPreset('telegram')" />
          <q-space />
          <q-input v-model="ruleForm.domain" dense outlined placeholder="example.com" style="width: 220px" />
          <q-select v-model="ruleForm.kind" dense outlined emit-value map-options :options="ruleKindOptions" style="width: 130px" />
          <q-btn color="primary" icon="add" label="添加" @click="addRule" />
        </div>
      </section>

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
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, reactive } from 'vue';

import { ruleKindOptions, useTunnel } from 'src/composables/useTunnel';

type Preset = 'google' | 'youtube' | 'x' | 'telegram';

const {
  snapshot,
  refresh,
  run
} = useTunnel();

const ruleForm = reactive({
  kind: 'allow' as 'allow' | 'block',
  domain: ''
});

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

onMounted(() => {
  void refresh();
});
</script>
