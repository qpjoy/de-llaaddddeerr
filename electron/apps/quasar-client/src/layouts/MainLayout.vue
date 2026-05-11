<template>
  <q-layout view="lHh Lpr lFf" class="app-shell">
    <q-drawer show-if-above :width="220" class="side-panel">
      <div class="brand-lockup">
        <q-icon name="hub" size="34px" />
        <span>QPJoy Tunnel</span>
      </div>

      <q-list padding>
        <q-item active clickable class="nav-item">
          <q-item-section avatar>
            <q-icon name="dashboard" />
          </q-item-section>
          <q-item-section>首页</q-item-section>
        </q-item>

        <q-item clickable class="nav-item">
          <q-item-section avatar>
            <q-icon name="lan" />
          </q-item-section>
          <q-item-section>代理</q-item-section>
        </q-item>

        <q-item clickable class="nav-item">
          <q-item-section avatar>
            <q-icon name="dns" />
          </q-item-section>
          <q-item-section>订阅</q-item-section>
        </q-item>

        <q-item clickable class="nav-item">
          <q-item-section avatar>
            <q-icon name="rule" />
          </q-item-section>
          <q-item-section>规则</q-item-section>
        </q-item>

        <q-item clickable class="nav-item">
          <q-item-section avatar>
            <q-icon name="article" />
          </q-item-section>
          <q-item-section>日志</q-item-section>
        </q-item>
      </q-list>
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>
