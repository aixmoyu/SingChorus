<template>
  <div class="page">
    <div class="page-header">
      <h1>{{ form?.name ?? 'Configuration' }}</h1>
      <n-tag v-if="isRemote" type="info" size="small">Read-only · from node {{ (form?.node_fingerprint || '').slice(0, 12) }}…</n-tag>
      <div class="page-header-actions" v-if="form && !isRemote">
        <n-button type="primary" :loading="saving" @click="save" :disabled="!dirty">Save</n-button>
        <n-button @click="revert" :disabled="!dirty">Reset</n-button>
      </div>
    </div>

    <n-card v-if="form">
      <n-form :model="form" :label-placement="labelPlacement" label-width="120">
        <n-form-item label="Type">
          <n-input :value="form.type" disabled />
        </n-form-item>
        <n-form-item label="Tag">
          <n-input :value="form.name" disabled />
          <template #feedback>Tag cannot be changed after creation — edit the config content only.</template>
        </n-form-item>
        <n-form-item label="Enabled">
          <n-switch v-model:value="form.enabled" :disabled="isRemote" />
        </n-form-item>
      </n-form>
    </n-card>

    <n-card v-if="form" title="Params">
      <div class="section">
        <n-input
          v-model:value="paramsText"
          type="textarea"
          :rows="4"
          class="mono-input"
          aria-label="Params JSON"
          placeholder='{"key": "value"}'
          :disabled="isRemote"
        />
        <div class="form-actions">
          <n-button size="small" @click="regenerate" :loading="regenerating" :disabled="isRemote">Regenerate</n-button>
          <n-button size="small" @click="formatJson('params')" :disabled="isRemote">Format</n-button>
        </div>
      </div>
    </n-card>

    <n-card v-if="form" title="Server Config">
      <div class="section">
        <n-input
          v-model:value="serverText"
          type="textarea"
          :rows="10"
          class="mono-input"
          aria-label="Server config JSON"
          placeholder='{}'
          :disabled="isRemote"
        />
        <div class="form-actions">
          <n-button size="small" @click="formatJson('server')">Format</n-button>
        </div>
      </div>
    </n-card>

    <n-card v-if="form" title="Client Config">
      <div class="section">
        <n-input
          v-model:value="clientText"
          type="textarea"
          :rows="10"
          class="mono-input"
          aria-label="Client config JSON"
          placeholder='{}'
          :disabled="isRemote"
        />
        <div class="form-actions">
          <n-button size="small" @click="formatJson('client')">Format</n-button>
        </div>
      </div>
    </n-card>

    <n-spin v-else-if="!loadError" />
    <n-card v-else>
      <n-result status="error" title="Failed to Load Config" :description="loadError">
        <template #footer>
          <n-button @click="retryLoad">Retry</n-button>
        </template>
      </n-result>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, onBeforeRouteLeave } from 'vue-router'
import { NCard, NForm, NFormItem, NInput, NSwitch, NButton, NSpin, NTag, NResult, useMessage, useDialog } from 'naive-ui'
import { useConfigStore } from '@/stores/config'
import { useTemplateStore } from '@/stores/template'
import { extractApiError } from '@/lib/http'
import http from '@/lib/http'
import { useFormLabelPlacement } from '@/composables/useBreakpoint'
import type { ConfigEntry } from '@/lib/types'

const message = useMessage()
const dialog = useDialog()
const route = useRoute()
const configStore = useConfigStore()
const templateStore = useTemplateStore()
const { labelPlacement } = useFormLabelPlacement()

const original = ref<ConfigEntry | null>(null)
const form = ref<ConfigEntry | null>(null)
const loadError = ref<string | null>(null)
const saving = ref(false)
const regenerating = ref(false)

/** Read-only view when the URL carries a fingerprint (another node's config). */
const isRemote = computed(() => Boolean(route.query.fingerprint))

const serverText = ref('{}')
const clientText = ref('{}')
const paramsText = ref('{}')

const dirty = computed(() => {
  if (isRemote.value) return false
  if (!original.value || !form.value) return false
  if (original.value.enabled !== form.value.enabled) return true
  // Compare against the same pretty-printed text shown in the textareas,
  // otherwise dirty is always true (compact vs 2-space stringify differ).
  if (JSON.stringify(original.value.server_config ?? {}, null, 2) !== serverText.value) return true
  if (JSON.stringify(original.value.client_config ?? {}, null, 2) !== clientText.value) return true
  if (JSON.stringify(original.value.params ?? {}, null, 2) !== paramsText.value) return true
  return false
})

/** The three JSON textareas: single source of truth for parse/format/labels. */
const TEXT_FIELDS = {
  server: { text: serverText, label: 'Server config' },
  client: { text: clientText, label: 'Client config' },
  params: { text: paramsText, label: 'Params' },
} as const
type TextFieldKey = keyof typeof TEXT_FIELDS

/** Parse a textarea's JSON, surfacing invalid input to the user. */
function parseJsonField(side: TextFieldKey): Record<string, unknown> | unknown[] | null {
  const { text, label } = TEXT_FIELDS[side]
  try {
    return JSON.parse(text.value)
  } catch (e) {
    message.error(`${label} is not valid JSON: ${(e as Error).message}`)
    return null
  }
}

function formatJson(side: TextFieldKey) {
  const { text, label } = TEXT_FIELDS[side]
  try {
    text.value = JSON.stringify(JSON.parse(text.value), null, 2)
  } catch {
    message.warning(`${label} is not valid JSON — cannot format.`)
  }
}

async function regenerate() {
  if (!original.value || !form.value) return
  const params = parseJsonField('params') as Record<string, unknown> | null
  if (!params) return
  regenerating.value = true
  try {
    const result = await templateStore.generateFromTemplate(form.value.type, params)
    serverText.value = JSON.stringify(result.server_config, null, 2)
    clientText.value = JSON.stringify(result.client_config, null, 2)
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Regenerate failed').message)
  } finally {
    regenerating.value = false
  }
}

function syncForm() {
  if (!original.value) return
  serverText.value = JSON.stringify(original.value.server_config ?? {}, null, 2)
  clientText.value = JSON.stringify(original.value.client_config, null, 2)
  paramsText.value = JSON.stringify(original.value.params ?? {}, null, 2)
}

function revert() {
  loadConfig()
}

async function save() {
  if (!original.value || !form.value) return
  // Reject invalid JSON up front instead of silently dropping the field.
  const server_config = parseJsonField('server') as Record<string, unknown> | null
  const client_config = parseJsonField('client') as Record<string, unknown> | null
  const params = parseJsonField('params') as Record<string, unknown> | null
  if (!server_config || !client_config || !params) return

  saving.value = true
  try {
    const data: Partial<ConfigEntry> = { enabled: form.value.enabled, server_config, client_config, params }

    const updated = await configStore.updateConfig(original.value.name, data)
    original.value = updated
    form.value = { ...updated }
    syncForm()
    configStore.fetchConfigs()
    configStore.fetchRemoteConfigs()
    message.success('Saved')
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Save failed').message)
  } finally {
    saving.value = false
  }
}

async function loadConfig() {
  const name = route.params.name as string
  const fingerprint = route.query.fingerprint as string | undefined
  loadError.value = null
  try {
    let cfg: ConfigEntry
    if (fingerprint) {
      const res = await http.get(`/core/remote-configs/${encodeURIComponent(fingerprint)}/${encodeURIComponent(name)}`)
      cfg = res.data as ConfigEntry
    } else {
      cfg = await configStore.fetchConfig(name)
    }
    original.value = cfg
    form.value = { ...cfg }
    syncForm()
  } catch (e: unknown) {
    original.value = null
    form.value = null
    loadError.value = extractApiError(e, 'Config not found').message
  }
}

function retryLoad() {
  loadConfig()
}

onMounted(() => {
  loadConfig()
})

// Warn when navigating away with pending (unsaved) form edits.
onBeforeRouteLeave(() => {
  if (!dirty.value) return true
  return new Promise<boolean>((resolve) => {
    dialog.warning({
      title: 'Unsaved Changes',
      content: 'You have unsaved changes. Leave without saving?',
      positiveText: 'Leave',
      negativeText: 'Stay',
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
      onMaskClick: () => resolve(false),
      onEsc: () => resolve(false),
    })
  })
})
</script>

<style scoped>
.mono-input textarea {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
}

.section {
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}
</style>
