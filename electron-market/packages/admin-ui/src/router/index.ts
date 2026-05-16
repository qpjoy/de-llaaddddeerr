import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

import MainLayout from 'src/layouts/MainLayout.vue';
import InstalledPage from 'src/pages/InstalledPage.vue';
import MarketplacePage from 'src/pages/MarketplacePage.vue';
import PluginDetailPage from 'src/pages/PluginDetailPage.vue';
import LogsPage from 'src/pages/LogsPage.vue';
import LoginPage from 'src/pages/LoginPage.vue';
import SettingsPage from 'src/pages/SettingsPage.vue';
import ServerUsersPage from 'src/pages/ServerUsersPage.vue';
import ServerAuditPage from 'src/pages/ServerAuditPage.vue';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: MainLayout,
    children: [
      { path: '', name: 'installed', component: InstalledPage },
      { path: 'marketplace', name: 'marketplace', component: MarketplacePage },
      { path: 'plugin/:id', name: 'plugin-detail', component: PluginDetailPage, props: true },
      { path: 'logs/:id', name: 'logs', component: LogsPage, props: true },
      { path: 'login', name: 'login', component: LoginPage },
      { path: 'settings', name: 'settings', component: SettingsPage },
      // Server-only pages: hidden from local-mode navigation but still reachable
      // by URL — useful when the same bundle is iframed from elsewhere too.
      { path: 'server/users', name: 'server-users', component: ServerUsersPage },
      { path: 'server/audit', name: 'server-audit', component: ServerAuditPage }
    ]
  }
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes
});
