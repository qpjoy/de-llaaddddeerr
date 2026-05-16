<template>
  <q-dialog ref="dialogRef" persistent>
    <q-card style="min-width: 480px; max-width: 90vw">
      <q-card-section class="row items-center q-gutter-md">
        <q-icon name="lock_open" color="primary" size="32px" />
        <div>
          <div class="text-h6">{{ plugin.manifest.name }} 申请权限</div>
          <div class="plugin-id">{{ plugin.id }}@{{ plugin.version }}</div>
        </div>
      </q-card-section>

      <q-separator />

      <q-card-section style="max-height: 60vh; overflow: auto">
        <div v-if="dangerCount > 0" class="text-negative q-mb-sm text-weight-bold">
          ⚠ 包含 {{ dangerCount }} 项高危权限，请仔细确认。
        </div>

        <div class="q-gutter-y-sm">
          <div
            v-for="perm in describedPermissions"
            :key="perm.raw"
            class="permission-row"
            :class="{ danger: perm.danger }"
          >
            <q-checkbox v-model="selected" :val="perm.raw" />
            <div class="col">
              <div class="permission-name">{{ perm.raw }}</div>
              <div class="permission-desc">{{ perm.label }}</div>
            </div>
          </div>
        </div>
      </q-card-section>

      <q-separator />

      <q-card-actions align="right" class="q-pa-md">
        <q-btn flat label="取消" @click="onCancel" />
        <q-btn flat label="只授不勾选项" :disable="selected.length === 0" @click="onPartial" />
        <q-btn
          color="primary"
          label="全部同意并激活"
          :disable="selected.length !== plugin.manifest.permissions.length"
          @click="onAcceptAll"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDialogPluginComponent } from 'quasar';

import type { InstalledPluginRecord } from 'src/types/api';
import { describePermission } from 'src/composables/usePluginHost';

const props = defineProps<{ plugin: InstalledPluginRecord }>();

defineEmits([...useDialogPluginComponent.emits]);
const { dialogRef, onDialogOK, onDialogCancel } = useDialogPluginComponent();

const selected = ref<string[]>([...props.plugin.manifest.permissions]);

const describedPermissions = computed(() =>
  props.plugin.manifest.permissions.map((p) => ({ raw: p, ...describePermission(p) }))
);
const dangerCount = computed(
  () => describedPermissions.value.filter((p) => p.danger).length
);

function onAcceptAll(): void {
  onDialogOK({ permissions: props.plugin.manifest.permissions, activate: true });
}
function onPartial(): void {
  onDialogOK({ permissions: selected.value, activate: false });
}
function onCancel(): void {
  onDialogCancel();
}
</script>
