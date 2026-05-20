<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">用户管理</div>
      <q-space />
      <q-btn color="primary" icon="person_add" label="新建用户" @click="createOpen = true" />
      <q-btn flat round icon="refresh" @click="reload" />
    </div>

    <div v-if="loading" class="text-grey-7">加载中…</div>
    <q-banner v-else-if="error" class="bg-negative text-white">
      {{ error }}
    </q-banner>

    <q-table
      v-else
      :rows="users"
      :columns="columns"
      row-key="id"
      flat
      bordered
      dense
      :pagination="{ rowsPerPage: 20 }"
    >
      <template #body-cell-role="props">
        <q-td :props="props">
          <q-badge :color="roleColor(props.value)" :label="props.value" />
        </q-td>
      </template>
      <template #body-cell-actions="props">
        <q-td :props="props">
          <q-btn-dropdown size="sm" flat icon="settings" label="操作">
            <q-list dense>
              <q-item clickable v-close-popup @click="setRole(props.row, 'admin')">
                <q-item-section>设为 admin</q-item-section>
              </q-item>
              <q-item clickable v-close-popup @click="setRole(props.row, 'user')">
                <q-item-section>设为 user</q-item-section>
              </q-item>
              <q-item clickable v-close-popup @click="setRole(props.row, 'banned')">
                <q-item-section class="text-negative">禁用</q-item-section>
              </q-item>
              <q-separator />
              <q-item clickable v-close-popup @click="openEntitlements(props.row)">
                <q-item-section>授权 / Entitlements</q-item-section>
              </q-item>
            </q-list>
          </q-btn-dropdown>
        </q-td>
      </template>
    </q-table>

    <q-dialog v-model="createOpen">
      <q-card style="min-width: 460px">
        <q-card-section>
          <div class="text-h6">新建用户</div>
          <div class="text-caption text-grey-7">可用于预先创建 HWindows / HMac 等账号，再在 HDO 许可页加入 mesh。</div>
        </q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input v-model="createUsername" outlined dense label="用户名" />
          <q-input v-model="createEmail" outlined dense label="邮箱（可空）" />
          <q-input v-model="createDisplayName" outlined dense label="显示名（可空）" />
          <q-input v-model="createPassword" outlined dense label="初始密码" type="password" />
          <q-select v-model="createRole" outlined dense :options="['user', 'admin']" label="角色" />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="取消" v-close-popup />
          <q-btn color="primary" label="创建" :loading="creating" @click="submitCreate" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <q-dialog v-model="grantOpen">
      <q-card style="min-width: 420px">
        <q-card-section>
          <div class="text-h6">为 {{ grantUser?.username ?? grantUser?.id }} 授权</div>
        </q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input v-model="grantPluginId" outlined label="plugin id（如 qpjoy.electron-tunnel）" dense />
          <q-select
            v-model="grantKind"
            outlined
            dense
            :options="['free', 'paid', 'trial']"
            label="kind"
          />
          <q-input v-model="grantExpiresAt" outlined dense label="过期时间（ISO，可空）" />
          <div v-if="grantExisting.length > 0" class="text-caption text-grey-7">
            已有：
            <q-chip
              v-for="e in grantExisting"
              :key="e.id"
              dense
              :label="`${e.pluginId} (${e.kind})`"
            />
          </div>
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="取消" v-close-popup />
          <q-btn color="primary" label="授权" :loading="granting" @click="submitGrant" />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';

import { useServerAdmin, type EntitlementRow } from 'src/composables/useServerAdmin';
import type { PublicUser } from 'src/composables/useAuth';

const admin = useServerAdmin();

const users = ref<PublicUser[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

const columns = [
  { name: 'username', label: '用户名', field: 'username', align: 'left' as const },
  { name: 'email', label: '邮箱', field: 'email', align: 'left' as const },
  { name: 'role', label: '角色', field: 'role', align: 'left' as const },
  { name: 'createdAt', label: '注册时间', field: 'createdAt', align: 'left' as const },
  { name: 'actions', label: '', field: 'id', align: 'right' as const }
];

const grantOpen = ref(false);
const grantUser = ref<PublicUser | null>(null);
const grantPluginId = ref('');
const grantKind = ref<'free' | 'paid' | 'trial'>('paid');
const grantExpiresAt = ref('');
const grantExisting = ref<EntitlementRow[]>([]);
const granting = ref(false);
const createOpen = ref(false);
const createUsername = ref('');
const createEmail = ref('');
const createDisplayName = ref('');
const createPassword = ref('');
const createRole = ref<'user' | 'admin'>('user');
const creating = ref(false);

async function reload(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    users.value = await admin.listUsers();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function setRole(user: PublicUser, role: 'user' | 'admin' | 'banned'): Promise<void> {
  try {
    await admin.setUserRole(user.id, role);
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

async function submitCreate(): Promise<void> {
  if (!createPassword.value.trim() || (!createUsername.value.trim() && !createEmail.value.trim())) return;
  creating.value = true;
  try {
    await admin.createUser({
      username: createUsername.value || null,
      email: createEmail.value || null,
      displayName: createDisplayName.value || null,
      password: createPassword.value,
      role: createRole.value
    });
    createOpen.value = false;
    createUsername.value = '';
    createEmail.value = '';
    createDisplayName.value = '';
    createPassword.value = '';
    createRole.value = 'user';
    await reload();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    creating.value = false;
  }
}

function roleColor(role: string): string {
  return { user: 'grey-7', admin: 'primary', banned: 'negative' }[role] ?? 'grey-7';
}

async function openEntitlements(user: PublicUser): Promise<void> {
  grantUser.value = user;
  grantPluginId.value = '';
  grantKind.value = 'paid';
  grantExpiresAt.value = '';
  grantOpen.value = true;
  try {
    grantExisting.value = await admin.listEntitlements(user.id);
  } catch {
    grantExisting.value = [];
  }
}

async function submitGrant(): Promise<void> {
  if (!grantUser.value || !grantPluginId.value) return;
  granting.value = true;
  try {
    await admin.grantEntitlement(grantUser.value.id, {
      pluginId: grantPluginId.value,
      kind: grantKind.value,
      expiresAt: grantExpiresAt.value || null
    });
    grantOpen.value = false;
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    granting.value = false;
  }
}

onMounted(reload);
</script>
