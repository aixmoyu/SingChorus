<template>
  <div class="page">
    <div class="page-header">
      <h1>Create Subscription</h1>
      <div class="page-header-actions">
        <n-button @click="router.back()">Cancel</n-button>
        <n-button type="primary" :loading="submitting" @click="handleSubmit">Create</n-button>
      </div>
    </div>

    <n-card>
      <form @submit.prevent="handleSubmit">
        <n-form :model="form" :rules="formRules" ref="formRef" :label-placement="labelPlacement" label-width="160">
          <n-form-item label="Subscription Type" path="type">
            <n-radio-group v-model:value="form.type">
              <n-radio value="singbox">sing-box 配置（JSON）</n-radio>
              <n-radio value="url">分享链接（vless:// 等 URI 列表）</n-radio>
            </n-radio-group>
          </n-form-item>
          <n-form-item label="Name" path="name">
            <n-input v-model:value="form.name" placeholder="Leave empty to use path" />
          </n-form-item>
          <n-form-item label="Path" path="path">
            <n-input v-model:value="form.path" placeholder="e.g. full-access" />
          </n-form-item>
          <n-form-item label="Token" path="token">
            <n-input-group>
              <n-input v-model:value="form.token" placeholder="Leave empty to auto-generate" />
              <n-button @click="generateToken">Generate</n-button>
            </n-input-group>
          </n-form-item>
          <template v-if="form.type === 'singbox'">
            <n-form-item label="sing-box Version" path="singboxVersion">
              <n-select
                v-model:value="form.singboxVersion"
                :options="versionOptions"
                filterable
                tag
                placeholder="Select the consumer sing-box version"
              />
            </n-form-item>
            <n-form-item label="Overall Template">
              <n-select
                v-model:value="form.overallTemplateId"
                :options="clientTemplateOptions"
                clearable
                placeholder="Select client overall template (optional)"
              />
            </n-form-item>
            <n-form-item
              label="Custom Route Rules"
              :show-require-mark="false"
              :validation-status="routeRulesError ? 'error' : undefined"
            >
              <n-input
                v-model:value="routeRulesText"
                type="textarea"
                :rows="4"
                class="mono-input"
                aria-label="Custom route rules JSON"
                placeholder='[{"domain": ["example.com"], "outbound": "direct"}]'
              />
              <template #feedback>
                {{ routeRulesError || 'Optional — a JSON array of sing-box route rules spliced into this subscription\'s client config at delivery time. Empty = none. Only applied when the overall-client template provides a route_rules splice point (e.g. client-default-ts); not applied to url-type subscriptions.' }}
              </template>
            </n-form-item>
          </template>
          <n-form-item label="Active">
            <n-switch v-model:value="form.active" />
          </n-form-item>
        </n-form>
      </form>
    </n-card>

    <n-modal v-model:show="showTokenModal" title="Subscription Token" :mask-closable="false">
      <n-card class="modal-card" closable @close="done">
        <p>Use this token in the subscription URL:</p>
        <n-input-group>
          <n-input :value="createdToken" readonly />
          <n-button @click="copyToken">Copy</n-button>
        </n-input-group>
        <n-alert type="warning" style="margin-top: var(--space-md)">
          Token is shown only once. Regenerate if lost.
        </n-alert>
        <template #footer>
          <div class="form-actions">
            <n-button type="primary" @click="done">Got it</n-button>
          </div>
        </template>
      </n-card>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NCard, NForm, NFormItem, NInput, NInputGroup, NSelect, NSwitch, NRadio, NRadioGroup, NButton, NModal, NAlert, useMessage } from 'naive-ui'
import { useSubscriptionStore } from '@/stores/subscription'
import { extractApiError } from '@/lib/http'
import { useFormLabelPlacement } from '@/composables/useBreakpoint'
import { useSubscriptionTemplateOptions } from '@/composables/useSubscriptionTemplateOptions'
import type { SubscriptionType } from '@/lib/types'

const router = useRouter()
const message = useMessage()
const subscriptionStore = useSubscriptionStore()
const formRef = ref()
const { labelPlacement } = useFormLabelPlacement()
const { versions, clientTemplateOptions, loadVersions, loadClientTemplates } = useSubscriptionTemplateOptions()

const form = ref({
  type: 'singbox' as SubscriptionType,
  name: '',
  path: '',
  token: '',
  singboxVersion: null as string | null,
  overallTemplateId: null as string | null,
  active: true,
})

/** Optional subscription-level route rules (JSON array of sing-box route rule objects). */
const routeRulesText = ref('[]')
const routeRulesError = ref('')

/** Parse the textarea into a rules array; null when invalid (error already shown). */
function parseRouteRules(): unknown[] | null {
  routeRulesError.value = ''
  const text = routeRulesText.value.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed) || parsed.some((r) => r === null || typeof r !== 'object' || Array.isArray(r))) {
      routeRulesError.value = 'Route rules must be a JSON array of rule objects.'
      return null
    }
    return parsed
  } catch (e) {
    routeRulesError.value = `Route rules is not valid JSON: ${(e as Error).message}`
    return null
  }
}

const formRules = {
  path: [
    { required: true, message: 'Path is required', trigger: 'blur' },
    { pattern: /^[a-z0-9-]+$/, message: 'Only lowercase letters, numbers, and hyphens', trigger: 'blur' },
    { min: 2, max: 64, message: '2-64 characters', trigger: 'blur' },
  ],
  singboxVersion: [
    { required: true, message: 'sing-box version is required', trigger: 'blur' },
    { pattern: /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/, message: 'Expected X.Y.Z[-suffix]', trigger: 'blur' },
  ],
}

const versionOptions = computed(() => versions.value.map((v) => ({ label: v, value: v })))

// 订阅绑定版本决定可选模板：版本变化即按该版本重新拉取过滤后的列表（§13.5）。
watch(() => form.value.singboxVersion, (v) => {
  void loadClientTemplates(v)
})

// 仅 singbox 型需要版本/模板信息；url 型交付纯文本分享链接，两者均不涉及。
watch(() => form.value.type, (t) => {
  if (t === 'singbox') void loadVersions()
})

const submitting = ref(false)
const showTokenModal = ref(false)
const createdToken = ref('')

function generateToken() {
  // Cryptographically secure random token (32 hex chars = 128 bits of entropy).
  // `Math.random()` is not CSPRNG-safe and is unsafe for auth tokens.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  form.value.token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function handleSubmit() {
  try {
    await formRef.value?.validate()
  } catch { return }

  if (!form.value.name?.trim()) form.value.name = form.value.path

  // 解析失败时已在 textarea 下提示，直接留在表单页。
  const routeRules = form.value.type === 'singbox' ? parseRouteRules() : null
  if (form.value.type === 'singbox' && routeRules === null) return

  submitting.value = true
  try {
    const payload: {
      name: string
      path: string
      type: SubscriptionType
      singboxVersion?: string
      overallTemplateId?: string
      routeRules?: unknown[]
      active: boolean
      token?: string
    } = {
      name: form.value.name,
      path: form.value.path,
      type: form.value.type,
      active: form.value.active,
    }
    // url 型不绑定版本/模板/规则——字段根本不进 payload（云端也会拒绝）。
    if (form.value.type === 'singbox') {
      payload.singboxVersion = form.value.singboxVersion!
      if (form.value.overallTemplateId) payload.overallTemplateId = form.value.overallTemplateId
      if (routeRules && routeRules.length > 0) payload.routeRules = routeRules
    }
    if (form.value.token) payload.token = form.value.token
    const created = await subscriptionStore.createSubscription(payload)
    if (!created) {
      message.error('创建订阅失败：服务器未返回数据')
      return
    }
    message.success('Subscription created')
    createdToken.value = created.token
    showTokenModal.value = true
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Failed to create subscription').message)
  } finally {
    submitting.value = false
  }
}

async function copyToken() {
  try {
    await navigator.clipboard.writeText(createdToken.value)
    message.success('Token copied')
  } catch {
    message.error('Failed to copy — clipboard unavailable (requires HTTPS or a secure context)')
  }
}

function done() {
  showTokenModal.value = false
  router.push({ name: 'subscriptions' })
}

onMounted(() => {
  void loadVersions()
})
</script>

<style scoped>
.mono-input textarea {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
}
</style>
