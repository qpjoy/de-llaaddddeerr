<template>
  <q-layout view="hHh Lpr lFf" class="app-shell">
    <!-- Top bar (only in embed mode). Lets the host's iframe show breadcrumbs
         + a "back to host" button. In standalone mode we hide it because the
         drawer already carries the brand. -->
    <q-header v-if="embed" elevated class="embed-bar bg-white text-dark">
      <q-toolbar>
        <q-btn flat dense round icon="arrow_back" aria-label="Back" @click="onBack" />
        <q-toolbar-title class="text-weight-bold">
          {{ pageTitle }}
        </q-toolbar-title>
        <q-space />
        <q-btn flat dense round icon="open_in_new" @click="openStandalone">
          <q-tooltip>在新窗口打开</q-tooltip>
        </q-btn>
      </q-toolbar>
      <q-tabs
        v-model="activeTab"
        dense
        active-color="primary"
        indicator-color="primary"
        align="left"
        narrow-indicator
        no-caps
        @update:model-value="onTabChange"
      >
        <q-tab name="installed" label="已安装" />
        <q-tab name="marketplace" label="市场" />
      </q-tabs>
      <UserMenu />
    </q-header>

    <q-drawer
      v-if="!embed"
      show-if-above
      :width="220"
      :mini="drawerMini"
      :mini-width="72"
      class="side-panel"
    >
      <div class="brand-lockup">
        <q-icon
          :name="mode === 'server' ? 'dns' : 'extension'"
          :size="drawerMini ? '26px' : '30px'"
          color="primary"
        />
        <span v-if="!drawerMini">{{ mode === 'server' ? '市场后台' : '插件市场' }}</span>
        <q-space v-if="!drawerMini" />
        <q-btn
          flat
          dense
          round
          :icon="drawerMini ? 'keyboard_double_arrow_right' : 'keyboard_double_arrow_left'"
          :aria-label="drawerMini ? '展开菜单' : '收起菜单'"
          @click="toggleDrawerMini"
        >
          <q-tooltip>{{ drawerMini ? '展开菜单' : '收起菜单' }}</q-tooltip>
        </q-btn>
      </div>

      <q-list padding>
        <q-item
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          exact
          clickable
          class="nav-item"
        >
          <q-item-section avatar>
            <q-icon :name="item.icon" />
          </q-item-section>
          <q-item-section v-if="!drawerMini">{{ item.label }}</q-item-section>
          <q-tooltip v-if="drawerMini" anchor="center right" self="center left">
            {{ item.label }}
          </q-tooltip>
        </q-item>
      </q-list>

      <div v-if="mode === 'server' && !drawerMini" class="q-mx-md q-mt-sm">
        <q-chip color="primary" text-color="white" dense icon="dns" label="服务端管理" />
      </div>

      <div class="side-panel-footer">
        <UserMenu v-if="!drawerMini" inline />
        <q-btn
          v-else
          flat
          round
          icon="login"
          to="/login"
          aria-label="登录 / 注册"
        >
          <q-tooltip>登录 / 注册</q-tooltip>
        </q-btn>
        <div class="text-caption text-grey-7 q-mt-sm">
          <template v-if="!drawerMini">
            QPJoy Plugin Host<br />
            127.0.0.1:23455
          </template>
          <template v-else>23455</template>
        </div>
      </div>
    </q-drawer>

    <q-page-container :class="{ 'embed-page-container': embed }">
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useEmbed } from 'src/composables/useEmbed';
import { detectMode } from 'src/composables/useMode';
import UserMenu from 'src/components/UserMenu.vue';

const mode = detectMode();

// Local mode = the host's iframe. Server mode = the marketplace server's
// admin UI. Different tabs in each.
const navItems = computed(() =>
  mode === 'server'
    ? [
        { label: '市场', icon: 'travel_explore', to: '/marketplace' },
        { label: 'HDO', icon: 'hub', to: '/server/hdo' },
        { label: '用户', icon: 'group', to: '/server/users' },
        { label: '审计', icon: 'fact_check', to: '/server/audit' }
      ]
    : [
        { label: '已安装', icon: 'dashboard', to: '/' },
        { label: '市场', icon: 'travel_explore', to: '/marketplace' },
        { label: '设置', icon: 'settings', to: '/settings' }
      ]
);

const route = useRoute();
const router = useRouter();
const { embed, requestClose } = useEmbed();
const drawerMini = ref(localStorage.getItem('qpjoy.market.drawerMini') === '1');

const activeTab = ref<'installed' | 'marketplace'>(
  route.path.startsWith('/marketplace') ? 'marketplace' : 'installed'
);

watch(
  () => route.path,
  (path) => {
    if (path.startsWith('/marketplace')) activeTab.value = 'marketplace';
    else if (path === '/' || path.startsWith('/plugin') || path.startsWith('/logs')) activeTab.value = 'installed';
  }
);

const pageTitle = computed(() => {
  if (route.path.startsWith('/marketplace')) return '插件市场';
  if (route.path.startsWith('/plugin/')) return '插件详情';
  if (route.path.startsWith('/logs/')) return '插件日志';
  if (route.path.startsWith('/settings')) return '设置';
  return '插件市场';
});

function onTabChange(name: string | number | null): void {
  if (name === 'installed' && route.path !== '/') router.push('/');
  if (name === 'marketplace' && !route.path.startsWith('/marketplace')) router.push('/marketplace');
}

function onBack(): void {
  // If we're inside a sub-route (plugin detail / logs), pop back to its
  // parent first; otherwise ask the host to close the iframe.
  if (route.path.startsWith('/plugin/') || route.path.startsWith('/logs/')) {
    router.push('/');
    return;
  }
  requestClose();
}

function openStandalone(): void {
  window.open(window.location.origin + '/#' + route.fullPath, '_blank', 'noopener');
}

function toggleDrawerMini(): void {
  drawerMini.value = !drawerMini.value;
  localStorage.setItem('qpjoy.market.drawerMini', drawerMini.value ? '1' : '0');
}
</script>

<style scoped lang="scss">
.embed-bar {
  border-bottom: 1px solid #e3e8ef;
}
.embed-page-container {
  background: #f3f5f7;
}
</style>
