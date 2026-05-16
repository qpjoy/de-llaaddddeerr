<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">审计日志</div>
      <q-input
        v-model="actionFilter"
        dense
        outlined
        placeholder="按 action 过滤（如 auth.login）"
        style="min-width: 240px"
        @keyup.enter="reload"
      >
        <template #prepend><q-icon name="filter_list" /></template>
      </q-input>
      <q-input
        v-model="actorFilter"
        dense
        outlined
        placeholder="按用户 id 过滤"
        style="min-width: 240px"
        @keyup.enter="reload"
      />
      <q-btn flat round icon="refresh" @click="reload" />
    </div>

    <div v-if="loading" class="text-grey-7">加载中…</div>
    <q-banner v-else-if="error" class="bg-negative text-white">{{ error }}</q-banner>

    <q-table
      v-else
      :rows="rows"
      :columns="columns"
      row-key="id"
      flat
      bordered
      dense
      :pagination="{ rowsPerPage: 50 }"
    >
      <template #body-cell-action="props">
        <q-td :props="props">
          <q-chip dense :color="chipColor(props.value)" text-color="white" :label="props.value" />
        </q-td>
      </template>
      <template #body-cell-meta="props">
        <q-td :props="props">
          <code class="text-caption">{{
            props.value ? JSON.stringify(props.value).slice(0, 80) : ''
          }}</code>
        </q-td>
      </template>
    </q-table>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { useServerAdmin, type AuditEntry } from 'src/composables/useServerAdmin';

const admin = useServerAdmin();

const rows = ref<AuditEntry[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const actionFilter = ref('');
const actorFilter = ref('');

const columns = [
  { name: 'id', label: 'id', field: 'id', align: 'left' as const, style: 'width: 60px' },
  { name: 'createdAt', label: '时间', field: 'createdAt', align: 'left' as const },
  { name: 'action', label: 'action', field: 'action', align: 'left' as const },
  { name: 'actorUserId', label: '执行者', field: 'actorUserId', align: 'left' as const },
  { name: 'targetKind', label: '目标类型', field: 'targetKind', align: 'left' as const },
  { name: 'targetId', label: '目标 id', field: 'targetId', align: 'left' as const },
  { name: 'actorIp', label: 'ip', field: 'actorIp', align: 'left' as const },
  { name: 'meta', label: 'meta', field: 'meta', align: 'left' as const }
];

function chipColor(action: string): string {
  if (action.startsWith('auth.login.fail') || action.startsWith('plugin.download.deny'))
    return 'negative';
  if (action.startsWith('admin.')) return 'warning';
  if (action.startsWith('auth.')) return 'primary';
  if (action.startsWith('plugin.')) return 'info';
  return 'grey-7';
}

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    rows.value = await admin.listAudit({
      action: actionFilter.value || undefined,
      actorUserId: actorFilter.value || undefined,
      limit: 200
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(reload);
</script>
