import type { RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('layouts/MainLayout.vue'),
    children: [
      {
        path: '',
        component: () => import('pages/HomePage.vue')
      },
      {
        path: 'proxy',
        component: () => import('pages/ProxyPage.vue')
      },
      {
        path: 'subscriptions',
        component: () => import('pages/SubscriptionsPage.vue')
      },
      {
        path: 'rules',
        component: () => import('pages/RulesPage.vue')
      },
      {
        path: 'test',
        component: () => import('pages/TestPage.vue')
      },
      {
        path: 'logs',
        component: () => import('pages/LogsPage.vue')
      }
    ]
  }
];

export default routes;
