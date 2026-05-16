<template>
  <!-- Embed-bar variant: compact icon-button + dropdown -->
  <template v-if="!inline">
    <q-btn
      v-if="!auth.state.value.user && auth.state.value.configured"
      flat
      no-caps
      icon="login"
      label="登录"
      :to="loginRoute"
    />
    <q-btn-dropdown
      v-if="auth.state.value.user"
      flat
      no-caps
      :label="displayName"
      icon="person"
    >
      <q-list dense style="min-width: 160px">
        <q-item>
          <q-item-section>
            <q-item-label caption>角色</q-item-label>
            <q-item-label>{{ roleLabel }}</q-item-label>
          </q-item-section>
        </q-item>
        <q-separator />
        <q-item clickable v-close-popup @click="onLogout">
          <q-item-section avatar>
            <q-icon name="logout" />
          </q-item-section>
          <q-item-section>退出</q-item-section>
        </q-item>
      </q-list>
    </q-btn-dropdown>
  </template>

  <!-- Drawer-footer variant: full card -->
  <div v-else>
    <div v-if="!auth.state.value.configured" class="text-caption text-grey-7">
      未配置 serverBaseUrl，本机离线运行
    </div>
    <template v-else-if="auth.state.value.user">
      <div class="row items-center q-gutter-sm">
        <q-icon name="account_circle" size="28px" color="primary" />
        <div class="col" style="min-width: 0">
          <div class="text-weight-bold ellipsis">{{ displayName }}</div>
          <div class="text-caption text-grey-7">{{ roleLabel }}</div>
        </div>
        <q-btn flat dense round icon="logout" @click="onLogout">
          <q-tooltip>退出</q-tooltip>
        </q-btn>
      </div>
    </template>
    <template v-else>
      <q-btn
        outline
        color="primary"
        icon="login"
        label="登录 / 注册"
        size="sm"
        class="full-width"
        :to="loginRoute"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useAuth } from 'src/composables/useAuth';

defineProps<{ inline?: boolean }>();

const route = useRoute();
const router = useRouter();
const auth = useAuth();

onMounted(() => auth.refresh());

// Preserve embed-mode flags so login still works inside an iframe.
const loginRoute = computed(() => ({
  path: '/login',
  query: route.query
}));

const displayName = computed(() => {
  const u = auth.state.value.user;
  if (!u) return '';
  return u.displayName || u.username || u.email || u.phone || u.id.slice(0, 8);
});

const roleLabel = computed(() => {
  const r = auth.state.value.user?.role ?? 'user';
  return { user: '普通用户', admin: '管理员', banned: '已禁用' }[r];
});

async function onLogout(): Promise<void> {
  await auth.logout();
  if (route.name !== 'marketplace') router.push('/marketplace');
}
</script>
