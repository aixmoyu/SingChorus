<template>
  <n-alert
    v-if="incompatible.length > 0"
    type="warning"
    title="Component version mismatch"
    class="compat-banner"
    :bordered="false"
  >
    <div>{{ messages.join(' ') }}</div>
    <div>Please contact your administrator to upgrade the mismatched components.</div>
  </n-alert>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NAlert } from 'naive-ui'
import { useInfoStore } from '@/stores/info'
import { useCompatCheck } from '@/composables/useCompatCheck'

const infoStore = useInfoStore()
useCompatCheck()

const info = computed(() => infoStore.systemInfo)

/** Only definite mismatches (ok === false) raise the banner; unknown (null, e.g. cloud unreachable) stays silent. */
const incompatible = computed(() => {
  const compat = info.value?.compat
  if (!compat) return []
  const parts: Array<'core' | 'cloud'> = []
  if (compat.core.ok === false) parts.push('core')
  if (compat.cloud.ok === false) parts.push('cloud')
  return parts
})

const messages = computed(() =>
  incompatible.value.map((part) => {
    const check = info.value!.compat[part]
    const version = check.version ?? 'unknown'
    return `${part === 'core' ? 'Core' : 'Cloud'} version ${version} is outside the supported range (${check.range}).`
  }),
)
</script>

<style scoped>
.compat-banner {
  border-radius: 0;
}
</style>
