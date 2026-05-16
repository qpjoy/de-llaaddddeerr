<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <q-btn flat round icon="arrow_back" to="/" />
      <div class="page-title">{{ id }} · 日志</div>
      <q-space />
      <q-btn flat round icon="refresh" @click="reload" />
    </div>

    <div class="section-surface q-pa-sm" style="max-height: calc(100vh - 160px); overflow: auto">
      <div v-if="entries.length === 0" class="q-pa-md text-grey-7">尚无日志。</div>
      <div v-for="entry in entries" :key="entry.id" class="log-row" :class="entry.level">
        [{{ entry.createdAt }}] {{ entry.level.toUpperCase() }} {{ entry.message }}
        <span v-if="entry.meta">  {{ JSON.stringify(entry.meta) }}</span>
      </div>
    </div>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

import { usePluginHost } from 'src/composables/usePluginHost';
import type { PluginLogEntry } from 'src/types/api';

const props = defineProps<{ id: string }>();
const host = usePluginHost();
const entries = ref<PluginLogEntry[]>([]);
let interval: ReturnType<typeof setInterval> | null = null;

async function reload() {
  entries.value = await host.logs(props.id);
}

onMounted(() => {
  reload();
  interval = setInterval(reload, 2500);
});
onUnmounted(() => {
  if (interval) clearInterval(interval);
});
</script>
