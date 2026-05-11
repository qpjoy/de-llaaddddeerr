<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">日志</div>
      <q-space />
      <q-btn round flat icon="refresh" @click="refresh" />
    </div>

    <section class="section-surface q-pa-md">
      <div class="mono-log">{{ eventText }}</div>
    </section>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';

import { useTunnel } from 'src/composables/useTunnel';

const {
  eventText,
  refresh
} = useTunnel();

onMounted(() => {
  void refresh();
});
</script>
