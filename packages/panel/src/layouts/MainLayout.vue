<template>
  <n-layout has-sider style="height: 100vh; height: 100dvh">
    <div v-if="isMobile && mobileMenuOpen" class="sidebar-overlay" @click="closeMobileMenu" />
    <n-layout-sider
      :collapsed="collapsed"
      :width="240"
      :collapsed-width="64"
      collapse-mode="transform"
      :native-scrollbar="false"
      :class="{ 'mobile-open': isMobile && mobileMenuOpen, collapsed }"
      class="app-sider"
    >
      <div class="sidebar-inner" :class="{ collapsed }">
        <div class="sidebar-brand">
          <svg class="brand-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" />
            <path d="M8 12l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="brand-name">ChorusPanel</span>
        </div>
        <nav ref="sidebarNavRef" class="sidebar-nav" aria-label="Main navigation">
          <router-link
            v-for="item in menuItems"
            :key="item.key"
            :to="{ name: item.key }"
            class="nav-row"
            :class="{ active: currentRoute === item.key }"
            @click="onNavClick"
          >
            <span class="nav-icon" v-html="item.icon" />
            <span class="nav-label">{{ item.label }}</span>
          </router-link>
        </nav>
        <div class="sidebar-footer">
          <button class="logout-btn" @click="handleLogout" aria-label="Logout">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M16 17l5-5-5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              <path d="M21 12H9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            <span class="nav-label">Logout</span>
          </button>
          <div class="sidebar-footer-divider" />
          <button class="collapse-btn" @click="collapsed = !collapsed" :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'">
            <svg v-if="!collapsed" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
            <span class="nav-label">{{ collapsed ? 'Expand' : 'Collapse' }}</span>
          </button>
        </div>
      </div>
    </n-layout-sider>
    <n-layout>
      <n-layout-header class="layout-header">
        <button v-if="isMobile" class="hamburger-btn" @click="toggleMobileMenu" aria-label="Toggle menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        </button>
        <h1 class="header-title">{{ pageTitle }}</h1>
      </n-layout-header>
      <n-layout-content content-style="padding: var(--content-padding);" :native-scrollbar="false" class="layout-content">
        <router-view />
      </n-layout-content>
    </n-layout>
  </n-layout>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { NLayout, NLayoutSider, NLayoutHeader, NLayoutContent } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'

const collapsed = ref(false)
const mobileMenuOpen = ref(false)
const isMobile = ref(false)
const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const MOBILE_QUERY = '(max-width: 767px)'

let mobileMq: MediaQueryList | null = null

function onMobileChange(event: MediaQueryListEvent) {
  isMobile.value = event.matches
  if (isMobile.value) {
    collapsed.value = true
  }
}

function toggleMobileMenu() {
  mobileMenuOpen.value = !mobileMenuOpen.value
}

function closeMobileMenu() {
  mobileMenuOpen.value = false
}

function onNavClick() {
  if (isMobile.value) {
    closeMobileMenu()
  }
}

onMounted(() => {
  mobileMq = window.matchMedia(MOBILE_QUERY)
  isMobile.value = mobileMq.matches
  if (isMobile.value) {
    collapsed.value = true
  }
  mobileMq.addEventListener('change', onMobileChange)
})

onUnmounted(() => {
  mobileMq?.removeEventListener('change', onMobileChange)
})

const currentRoute = computed(() => route.name as string || 'dashboard')

const pageTitle = computed(() => {
  const names: Record<string, string> = {
    dashboard: 'Dashboard',
    configs: 'Configurations',
    'config-create': 'Create Configuration',
    'config-detail': 'Configuration Detail',
    deploy: 'Deploy',
    subscriptions: 'Subscriptions',
    'subscription-create': 'Create Subscription',
    'subscription-detail': 'Subscription Detail',
    validate: 'Validate',
    templates: 'Templates',
    'settings-system': 'Settings',
    setup: 'Setup',
  }
  return names[currentRoute.value] || 'ChorusPanel'
})

const icons = {
  dashboard: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
  configs: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
  deploy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  subscriptions: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>',
  validate: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>',
  templates: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
  'settings-system': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
}

const menuItems = [
  { label: 'Dashboard', key: 'dashboard', icon: icons.dashboard },
  { label: 'Configurations', key: 'configs', icon: icons.configs },
  { label: 'Deploy', key: 'deploy', icon: icons.deploy },
  { label: 'Subscriptions', key: 'subscriptions', icon: icons.subscriptions },
  { label: 'Templates', key: 'templates', icon: icons.templates },
  { label: 'Validate', key: 'validate', icon: icons.validate },
  { label: 'Settings', key: 'settings-system', icon: icons['settings-system'] },
]

async function handleLogout() {
  await auth.logout()
  router.push({ name: 'login' })
}
</script>

<style scoped>
.app-sider {
  height: 100vh;
  background: var(--color-sidebar-bg) !important;
  transition: max-width 0.3s ease;
  overflow: hidden !important;
  justify-content: flex-start !important;
}

:deep(.n-scrollbar-container) {
  display: flex;
  flex-direction: column;
  flex: 1;
}

:deep(.n-scrollbar-content) {
  display: flex;
  flex-direction: column;
  flex: 1;
}



.sidebar-inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  flex-grow: 1;
}

.sidebar-brand {
  padding: var(--space-md) var(--space-md) var(--space-sm);
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  min-height: 56px;
  box-sizing: border-box;
}

.brand-icon {
  color: var(--color-sidebar-brand);
  flex-shrink: 0;
}

.brand-name {
  font-size: var(--font-title-size);
  font-weight: var(--font-title-weight);
  color: var(--color-sidebar-brand);
  letter-spacing: var(--font-title-tracking);
  white-space: nowrap;
  overflow: hidden;
}

.sidebar-inner.collapsed .brand-name,
.sidebar-inner.collapsed .nav-label {
  visibility: hidden;
  width: 0;
  overflow: hidden;
}

.sidebar-inner:not(.collapsed) .brand-name,
.sidebar-inner:not(.collapsed) .nav-label {
  visibility: visible;
  width: auto;
  overflow: hidden;
}

.sidebar-inner.collapsed .sidebar-brand {
  padding: var(--space-md) var(--space-md) var(--space-sm);
}

.sidebar-inner.collapsed .nav-row {
  padding-left: var(--space-sm);
  padding-right: var(--space-sm);
  gap: 0;
}

.sidebar-inner.collapsed .logout-btn {
  padding-left: var(--space-sm);
  padding-right: var(--space-sm);
  gap: 0;
}

.sidebar-inner.collapsed .sidebar-footer-divider {
  margin: var(--space-xs) 0;
}

.sidebar-inner.collapsed .collapse-btn .nav-label {
  visibility: hidden;
  width: 0;
  overflow: hidden;
}

.sidebar-inner.collapsed .collapse-btn {
  padding-left: var(--space-sm);
  padding-right: var(--space-sm);
  gap: 0;
}

.sidebar-nav {
  padding: var(--space-xs) var(--space-xs);
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.nav-row {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--rounded-sm);
  font-size: var(--font-body-md-size);
  color: var(--color-sidebar-text);
  text-decoration: none;
  cursor: pointer;
  position: relative;
  min-height: 44px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s, color 0.15s;
}

.nav-row:focus-visible {
  outline: 2px solid var(--color-sidebar-brand);
  outline-offset: -2px;
}

.nav-row:hover {
  background: var(--color-sidebar-item-hover);
  color: var(--color-sidebar-text-hover);
}

.nav-row.active {
  background: var(--color-sidebar-item-active);
  color: var(--color-sidebar-text-active);
  font-weight: 500;
}

.nav-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.nav-icon :deep(svg) {
  display: block;
}

.nav-label {
  line-height: 1.25;
  white-space: nowrap;
  overflow: hidden;
}

.sidebar-footer {
  padding: var(--space-sm) var(--space-xs);
  margin-top: auto;
  display: flex;
  flex-direction: column;
  background: var(--color-sidebar-bg);
  flex-shrink: 0;
}

.sidebar-footer-divider {
  height: 1px;
  background: var(--color-sidebar-divider);
  margin: var(--space-xs) 0;
}

.logout-btn {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--rounded-sm);
  font-size: var(--font-body-md-size);
  color: var(--color-sidebar-text);
  background: transparent;
  border: none;
  cursor: pointer;
  width: 100%;
  min-height: 44px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s, color 0.15s;
}

.logout-btn:focus-visible {
  outline: 2px solid var(--color-sidebar-brand);
  outline-offset: -2px;
}

.logout-btn:hover {
  background: var(--color-sidebar-item-hover);
  color: var(--color-sidebar-text-hover);
}

.collapse-btn {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  padding: var(--space-xs) var(--space-sm);
  border-radius: var(--rounded-sm);
  font-size: var(--font-body-md-size);
  color: var(--color-sidebar-text);
  background: transparent;
  border: none;
  cursor: pointer;
  width: 100%;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s, color 0.15s;
}

.collapse-btn:focus-visible {
  outline: 2px solid var(--color-sidebar-brand);
  outline-offset: -2px;
}

.collapse-btn:hover {
  background: var(--color-sidebar-item-hover);
  color: var(--color-sidebar-text-hover);
}

.layout-header {
  padding: 0 var(--content-padding);
  height: 56px;
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  border-bottom: 1px solid var(--color-hairline);
  background: var(--color-canvas);
}

.hamburger-btn {
  display: none;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border: none;
  border-radius: var(--rounded-sm);
  background: transparent;
  color: var(--color-ink-secondary);
  cursor: pointer;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  flex-shrink: 0;
}

.hamburger-btn:hover {
  background: rgba(0, 0, 0, 0.04);
}

.header-title {
  font-size: var(--font-title-size);
  font-weight: var(--font-title-weight);
  letter-spacing: var(--font-title-tracking);
  line-height: var(--font-title-line-height);
  color: var(--color-ink);
  margin: 0;
}

.layout-content {
  background: var(--color-canvas-soft);
}

.sidebar-overlay {
  display: none;
}

@media (max-width: 768px) {
  .app-sider {
    position: fixed !important;
    top: 0;
    left: 0;
    z-index: 100;
    transform: translateX(-100%);
  }

  .app-sider.mobile-open {
    transform: translateX(0);
  }

  .sidebar-overlay {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 99;
    background: rgba(0, 0, 0, 0.35);
  }

  .hamburger-btn {
    display: flex;
  }
}
</style>
