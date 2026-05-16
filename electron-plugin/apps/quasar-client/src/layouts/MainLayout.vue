<template>
  <q-layout view="lHh Lpr lFf" class="app-shell">
    <q-drawer show-if-above :width="220" class="side-panel">
      <div class="brand-lockup">
        <q-icon name="hub" size="34px" />
        <span>QPJoy Tunnel</span>
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
          <q-item-section>{{ item.label }}</q-item-section>
        </q-item>
      </q-list>
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
const navItems = [
  { label: '首页', icon: 'dashboard', to: '/' },
  { label: '代理', icon: 'lan', to: '/proxy' },
  { label: '订阅', icon: 'dns', to: '/subscriptions' },
  { label: '规则', icon: 'rule', to: '/rules' },
  { label: '测试', icon: 'lock_open', to: '/test' },
  { label: '日志', icon: 'article', to: '/logs' }
];
</script>
