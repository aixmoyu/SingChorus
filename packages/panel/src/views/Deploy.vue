<template>
  <div class="page">
    <div class="page-header">
      <h1>Deploy</h1>
    </div>

    <n-card title="Deploy Status">
      <div class="section">
        <div aria-live="polite" aria-atomic="true">
          <n-tag :type="statusTagType" size="medium" :bordered="statusTagType === 'info'">
            <template v-if="statusTagType === 'info'" #icon><n-spin :size="12" /></template>
            {{ deployStatusText }}
          </n-tag>
        </div>
        <n-form-item label="Server Template" :show-feedback="false">
          <n-select
            v-model:value="serverTemplateId"
            :options="serverTemplateOptions"
            :loading="templateStore.loading"
            clearable
            placeholder="Default (cloud server template)"
          />
        </n-form-item>
        <div class="button-row">
          <n-button type="primary" :loading="busy" :disabled="lifecycleLocked" @click="handleDeploy">Deploy</n-button>
          <n-button type="warning" :loading="busy" :disabled="busy || deployStore.deployStatus?.status !== 'running'" @click="handleRestart">Restart</n-button>
          <n-button type="error" :loading="busy" :disabled="busy || deployStore.deployStatus?.status !== 'running'" @click="handleStop">Stop</n-button>
        </div>
      </div>
    </n-card>

    <n-card title="Logs">
      <div class="section">
        <div ref="logContainerRef" class="log-container" tabindex="0" role="log" aria-label="Deployment logs">
          <n-code :code="logText || 'No logs available'" language="plaintext" word-wrap />
        </div>
        <div class="button-row">
          <n-button size="small" @click="refreshLogs">Refresh Logs</n-button>
          <n-button size="small" @click="copyLogs">Copy Logs</n-button>
        </div>
      </div>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NCard, NTag, NButton, NCode, NFormItem, NSelect, NSpin, useMessage } from 'naive-ui'
import { useDeployStore } from '@/stores/deploy'
import { useTemplateStore } from '@/stores/template'
import { extractApiError } from '@/lib/http'

const deployStore = useDeployStore()
const templateStore = useTemplateStore()
const message = useMessage()
let pollTimer: ReturnType<typeof setInterval> | null = null
const logContainerRef = ref<HTMLElement | null>(null)

/** Selected cloud server overall template; empty = cloud default. */
const serverTemplateId = ref<string | null>(null)
const serverTemplateOptions = computed(() =>
  templateStore.templates
    .filter((t) => t.role === 'server')
    .map((t) => ({ label: t.name, value: t.id })),
)

/** True while a deploy/stop/restart request is in flight. */
const busy = ref(false)

/** No lifecycle buttons may fire: an op is running, or status is transitioning. */
const lifecycleLocked = computed(() =>
  busy.value
  || deployStore.deployStatus?.status === 'running'
  || deployStore.deployStatus?.status === 'deploying'
)

const statusTagType = computed((): 'default' | 'success' | 'warning' | 'info' => {
  const status = deployStore.deployStatus?.status
  if (status === 'running') return 'success'
  if (status === 'deploying') return 'info'
  if (busy.value) return 'info'
  return 'warning'
})

const deployStatusText = computed(() => {
  if (busy.value) return 'working…'
  return deployStore.deployStatus?.status || 'unknown'
})
const logText = computed(() => deployStore.logs.join('\n'))

async function handleDeploy() {
  await runAction(
    () => deployStore.deploy(serverTemplateId.value ? { serverOverallId: serverTemplateId.value } : {}),
    'Deploy failed',
  )
}
async function handleRestart() { await runAction(() => deployStore.restartDeploy(), 'Restart failed') }
async function handleStop() { await runAction(() => deployStore.stopDeploy(), 'Stop failed') }
async function refreshLogs() {
  try { await deployStore.fetchLogs(100) } catch (e: unknown) { message.error(extractApiError(e, 'Failed to fetch logs').message) }
}

async function copyLogs() {
  try {
    await navigator.clipboard.writeText(logText.value)
    message.success('Logs copied')
  } catch {
    message.error('Failed to copy — clipboard unavailable (requires HTTPS or a secure context)')
  }
}

// Auto-scroll the log container to the bottom as new logs stream in.
watch(logText, async () => {
  await nextTick()
  const el = logContainerRef.value
  if (el) el.scrollTop = el.scrollHeight
})

/** Run a deploy lifecycle action then refresh status, with user-visible errors. */
async function runAction(action: () => Promise<void>, fallback: string) {
  if (busy.value) return
  busy.value = true
  try {
    await action()
    await deployStore.fetchDeployStatus()
  } catch (e: unknown) {
    message.error(extractApiError(e, fallback).message)
  } finally {
    busy.value = false
  }
}

function startPolling() {
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    try { await deployStore.fetchDeployStatus(); await deployStore.fetchLogs(100) } catch { /* transient */ }
  }, 10000)
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

function handleVisibilityChange() {
  if (document.hidden) stopPolling()
  else startPolling()
}

onMounted(async () => {
  document.addEventListener('visibilitychange', handleVisibilityChange)
  try {
    await deployStore.fetchDeployStatus()
    await deployStore.fetchLogs(100)
  } catch { /* core may be unreachable on first load */ }
  templateStore.fetchTemplates('server').catch(() => { /* selector stays empty */ })
  startPolling()
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  stopPolling()
})
</script>

<style scoped>
.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.button-row {
  display: flex;
  gap: var(--space-sm);
  flex-wrap: wrap;
}

.log-container {
  max-height: 400px;
  overflow-y: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 6px);
  padding: var(--space-sm);
  background: var(--color-surface);
}
</style>
