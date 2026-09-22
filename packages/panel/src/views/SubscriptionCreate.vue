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
import { NCard, NForm, NFormItem, NInput, NInputGroup, NSelect, NSwitch, NButton, NModal, NAlert, useMessage } from 'naive-ui'
import { useSubscriptionStore } from '@/stores/subscription'
import { extractApiError } from '@/lib/http'
import { useFormLabelPlacement } from '@/composables/useBreakpoint'
import { useSubscriptionTemplateOptions } from '@/composables/useSubscriptionTemplateOptions'

const router = useRouter()
const message = useMessage()
const subscriptionStore = useSubscriptionStore()
const formRef = ref()
const { labelPlacement } = useFormLabelPlacement()
const { versions, clientTemplateOptions, loadVersions, loadClientTemplates } = useSubscriptionTemplateOptions()

const form = ref({
  name: '',
  path: '',
  token: '',
  singboxVersion: null as string | null,
  overallTemplateId: null as string | null,
  active: true,
})

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

  submitting.value = true
  try {
    const payload: {
      name: string
      path: string
      singboxVersion: string
      overallTemplateId?: string
      active: boolean
      token?: string
    } = {
      name: form.value.name,
      path: form.value.path,
      singboxVersion: form.value.singboxVersion!,
      overallTemplateId: form.value.overallTemplateId ?? undefined,
      active: form.value.active,
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
