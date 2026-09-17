<template>
  <n-config-provider :theme-overrides="notionThemeOverrides">
    <n-message-provider>
      <n-dialog-provider>
        <router-view />
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { NConfigProvider, NMessageProvider, NDialogProvider } from 'naive-ui'
import { notionThemeOverrides } from './styles/naive-theme'
</script>

<style>
html, body, #app {
  margin: 0;
  padding: 0;
  height: 100%;
  font-family: var(--font-family);
  color: var(--color-ink);
  background: var(--color-canvas-soft);
}
</style>