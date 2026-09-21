import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('@/views/Login.vue'), meta: { public: true } },
    { path: '/setup', name: 'setup', component: () => import('@/views/Setup.vue') },
    {
      path: '/',
      component: () => import('@/layouts/MainLayout.vue'),
      children: [
        { path: '', redirect: '/dashboard' },
        { path: 'dashboard', name: 'dashboard', component: () => import('@/views/Dashboard.vue') },
        { path: 'configs', name: 'configs', component: () => import('@/views/configs/ConfigList.vue') },
        { path: 'configs/create', name: 'config-create', component: () => import('@/views/configs/ConfigCreate.vue') },
        { path: 'configs/:name', name: 'config-detail', component: () => import('@/views/configs/ConfigDetail.vue') },
        { path: 'deploy', name: 'deploy', component: () => import('@/views/Deploy.vue') },
        { path: 'subscriptions', name: 'subscriptions', component: () => import('@/views/Subscriptions.vue') },
        { path: 'subscriptions/create', name: 'subscription-create', component: () => import('@/views/SubscriptionCreate.vue') },
        { path: 'subscriptions/:id', name: 'subscription-detail', component: () => import('@/views/SubscriptionDetail.vue') },
        { path: 'settings', name: 'settings-system', component: () => import('@/views/settings/SystemSettings.vue') },
      ],
    },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFound.vue') },
  ],
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (to.meta.public) return true
  if (!auth.checked) await auth.checkStatus()
  if (!auth.isAuthenticated) {
    return to.name === 'login' ? true : { name: 'login' }
  }
  // Authenticated but not initialized → force the setup wizard
  // (except the setup page itself).
  if (!auth.initialized && to.name !== 'setup') {
    return { name: 'setup' }
  }
  // Initialized users shouldn't linger on /setup — but allow re-entry
  // intentionally (the wizard doubles as an identity editor).
  return true
})

export default router
