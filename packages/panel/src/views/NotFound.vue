<script setup lang="ts">
import { useRouter } from 'vue-router'
import { NResult, NButton } from 'naive-ui'

const router = useRouter()
</script>

<template>
  <div class="not-found">
    <n-result status="404" title="Page Not Found" description="The page you are looking for does not exist or has been moved.">
      <template #footer>
        <n-button type="primary" @click="router.push({ name: 'dashboard' })">Back to Dashboard</n-button>
      </template>
    </n-result>
  </div>
</template>

<style scoped>
.not-found {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  padding: var(--space-xl);
}
</style>
