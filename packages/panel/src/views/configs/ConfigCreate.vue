<template>
  <div class="page">
    <div class="page-header">
      <h1>Create Configuration</h1>
    </div>

    <n-steps :current="step" size="small">
      <n-step title="Select Template" />
      <n-step title="Fill Parameters" />
      <n-step title="Preview & Submit" />
    </n-steps>

    <template v-if="step === 1">
      <n-card title="Select a Protocol Template">
        <n-alert
          v-if="templateStore.filteredCount > 0"
          type="info"
          style="margin-bottom: var(--space-md)"
        >
          {{ templateStore.filteredCount }} template(s) hidden — incompatible with the pinned sing-box version. Adjust it in Settings.
        </n-alert>
        <n-grid :cols="3" :x-gap="12" :y-gap="12" :xs="1" :s="2" :m="3" responsive="screen">
          <n-gi v-for="t in protocolTemplates" :key="t.id">
            <n-card
              hoverable
              role="button"
              tabindex="0"
              class="template-card"
              :aria-label="`Select template ${t.name}`"
              @click="selectTemplate(t)"
              @keydown.enter.prevent="selectTemplate(t)"
              @keydown.space.prevent="selectTemplate(t)"
            >
              <n-h4>{{ t.name }}</n-h4>
              <n-text depth="3">{{ t.type }} — v{{ t.version }}</n-text>
              <div v-if="t.singbox_compat" class="compat-row">
                <n-tag size="small" :bordered="false">sing-box {{ t.singbox_compat }}</n-tag>
              </div>
            </n-card>
          </n-gi>
        </n-grid>
      </n-card>
    </template>

    <template v-if="step === 2">
      <n-card title="Fill Parameters">
        <form @submit.prevent="goPreview">
          <n-form ref="formRef" :model="formParams" :label-placement="labelPlacement" label-width="140">
            <n-form-item
              v-for="p in editableParams"
              :key="p.name"
              :label="paramLabel(p)"
              :show-require-mark="false"
              :validation-status="paramErrors[p.name] ? 'error' : undefined"
              :feedback="paramErrors[p.name] || undefined"
            >
              <template v-if="p.type === 'boolean'">
                <n-switch :value="formParams[p.name] as boolean" @update:value="(v: boolean) => { formParams[p.name] = v; delete paramErrors[p.name] }" />
              </template>
              <template v-else-if="p.enum && p.enum.length">
                <n-select :value="formParams[p.name] as string" @update:value="(v: string) => { formParams[p.name] = v; delete paramErrors[p.name] }" :options="p.enum.map((e: string) => ({ label: e, value: e }))" :placeholder="inputPlaceholder(p)" />
              </template>
              <template v-else-if="p.type === 'number'">
                <n-input-number :value="(formParams[p.name] as number | null) ?? null" @update:value="(v: number | null) => { formParams[p.name] = v ?? ''; delete paramErrors[p.name] }" :placeholder="inputPlaceholder(p)" clearable />
              </template>
              <template v-else>
                <n-input
                  :value="formParams[p.name] as string"
                  @update:value="(v: string) => { formParams[p.name] = v; delete paramErrors[p.name] }"
                  :placeholder="inputPlaceholder(p)"
                />
              </template>
            </n-form-item>
          </n-form>
          <div class="form-actions">
            <n-button @click="step = 1">Back</n-button>
            <n-button type="primary" attr-type="submit" :loading="generating">Next</n-button>
          </div>
        </form>
      </n-card>
    </template>

    <template v-if="step === 3">
      <n-card title="Preview Configuration">
        <n-form :model="{}" :label-placement="labelPlacement" label-width="140">
          <n-form-item label="Config Name">
            <n-input :value="configName" disabled />
            <template #feedback>Derived from the generated tag</template>
          </n-form-item>
        </n-form>
        <n-h5>Server Config</n-h5>
        <n-code :code="JSON.stringify(preview.server_config, null, 2)" language="json" />
        <n-h5 style="margin-top: var(--space-md)">Client Config</n-h5>
        <n-code :code="JSON.stringify(preview.client_config, null, 2)" language="json" />
        <div class="form-actions" style="margin-top: var(--space-md)">
          <n-button @click="step = 2">Back</n-button>
          <n-button type="primary" :loading="submitting" @click="handleSubmit">Create</n-button>
        </div>
      </n-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useMessage } from 'naive-ui'
import { NSteps, NStep, NCard, NGrid, NGi, NH4, NH5, NText, NForm, NFormItem, NInput, NInputNumber, NSelect, NSwitch, NButton, NCode, NTag, NAlert } from 'naive-ui'
import http, { extractApiError } from '@/lib/http'
import { useConfigStore } from '@/stores/config'
import { useTemplateStore } from '@/stores/template'
import { useFormLabelPlacement } from '@/composables/useBreakpoint'
import type { TemplateInfo, GenerateResponse } from '@/lib/types'

const router = useRouter()
const message = useMessage()
const configStore = useConfigStore()
const templateStore = useTemplateStore()
const { labelPlacement } = useFormLabelPlacement()

const step = ref(1)
const selectedTemplate = ref<TemplateInfo | null>(null)
const formParams = reactive<Record<string, unknown>>({})
const paramErrors = reactive<Record<string, string>>({})
const preview = ref<GenerateResponse>({ server_config: {}, client_config: {} })
const submitting = ref(false)
const generating = ref(false)

/** Prefilled from node identity (set during initialization). */
const nodeAddress = ref('')
/** Tag of the rendered config — also used as the config name. */
const generatedTag = ref('')

const protocolTemplates = computed(() => templateStore.templates.filter(t => t.role === 'protocol'))
// All params are editable — generator-backed ones (port, tag, password) show
// as optional inputs; leaving them empty lets the cloud fill generated values.
const editableParams = computed(() => selectedTemplate.value?.schema?.params || [])

/** Label: strip parenthetical suffixes the template descriptions carry
 * (e.g. "Config tag (auto-generated if left empty)" → "Config tag"). */
function paramLabel(p: { name: string; description?: string }): string {
  const base = p.description || p.name
  return base.replace(/\s*\([^)]*\)\s*$/, '')
}

/** In-box placeholder: required fields give no hint; everything else is
 * optional. Defaults and generated values are decided in the cloud, so no
 * concrete values or examples are shown. */
function inputPlaceholder(p: { name: string; required?: boolean }): string {
  return p.required ? '' : 'Optional'
}

const configName = computed(() => generatedTag.value || (preview.value.client_config?.tag as string) || '')

function selectTemplate(t: TemplateInfo) {
  selectedTemplate.value = t
  generatedTag.value = ''
  for (const p of t.schema.params) {
    // Optional params start empty — server-side validation fills in defaults
    // when the value is absent. Only required params without a generator
    // (e.g. `domain`) demand explicit user input.
    if (p.name === 'domain' && nodeAddress.value && !p.generator) {
      formParams[p.name] = nodeAddress.value
      continue
    }
    formParams[p.name] = p.type === 'boolean' ? false : ''
  }
  paramErrorsclearAll()
  step.value = 2
}

function paramErrorsclearAll() {
  for (const key of Object.keys(paramErrors)) delete paramErrors[key]
}

async function goPreview() {
  if (!selectedTemplate.value) return

  // Client-side required check with inline field errors, before the round trip.
  for (const key of Object.keys(paramErrors)) delete paramErrors[key]
  let invalid = false
  for (const p of selectedTemplate.value.schema.params) {
    if (!p.required || p.generator) continue
    const v = formParams[p.name]
    if (v === '' || v === null || v === undefined) {
      paramErrors[p.name] = 'This field is required.'
      invalid = true
    }
  }
  if (invalid) return

  generating.value = true
  try {
    // Drop empty params — the cloud fills in defaults/generators for absent values.
    const params: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(formParams)) {
      if (v === '' || v === null || v === undefined) continue
      params[k] = v
    }
    preview.value = await templateStore.generateFromTemplate(selectedTemplate.value.type, params)
    generatedTag.value = String(preview.value.client_config?.tag || '')

    // Port conflict guard: reject before advancing if another config on this
    // machine already uses the generated port — the user stays on step 2.
    const port = Number(preview.value.server_config?.listen_port ?? preview.value.client_config?.server_port)
    if (Number.isInteger(port) && port > 0) {
      const check = await http.post('/core/configs/check-port', { port })
      if (check.data.available === false) {
        message.error(`Port ${port} is already used by config '${check.data.conflictWith}'. Please go back and regenerate.`)
        return
      }
    }

    step.value = 3
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Generation failed').message)
  } finally {
    generating.value = false
  }
}

async function handleSubmit() {
  if (!configName.value || !selectedTemplate.value) return
  submitting.value = true
  try {
    // Verify tag uniqueness (local + cloud) before committing.
    const check = await http.post('/core/configs/check-tag', { tag: configName.value })
    if (check.data.available === false) {
      message.error(`Tag '${configName.value}' is already in use (${check.data.source || 'cloud'}). Please go back and change it.`)
      return
    }
    // Cloud was unreachable during the check — only local uniqueness was
    // verified, so a tag owned by another node would only surface on sync.
    if (check.data.source === 'local_only') {
      message.warning(
        `Cloud unreachable — only local uniqueness was verified${check.data.detail ? ` (${check.data.detail})` : ''}. If another node already uses this tag, the conflict will surface when syncing.`,
        { duration: 8000 },
      )
    }

    await configStore.createConfig({
      name: configName.value,
      node: 'default',
      type: selectedTemplate.value.type,
      server_config: preview.value.server_config,
      client_config: preview.value.client_config,
      params: { ...formParams, tag: configName.value },
    })
    router.push({ name: 'configs' })
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Create failed').message)
  } finally {
    submitting.value = false
  }
}

onMounted(async () => {
  templateStore.fetchTemplates('protocol')
  // Prefill the `domain` param with this node's configured address.
  try {
    const res = await http.get('/core/configs/prefill')
    nodeAddress.value = res.data.node_address || ''
  } catch { /* prefill unavailable — field stays editable */ }
})
</script>

<style scoped>
.template-card {
  cursor: pointer;
  touch-action: manipulation;
}

.template-card:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.compat-row {
  margin-top: var(--space-sm);
}
</style>
