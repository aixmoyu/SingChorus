<template>
  <div class="page">
    <div class="page-header">
      <h1>{{ form?.name ?? 'Subscription' }}</h1>
      <div class="page-header-actions" v-if="form">
        <n-button @click="router.back()">Cancel</n-button>
        <n-button type="primary" :loading="saving" @click="handleSave">Save</n-button>
      </div>
    </div>

    <n-card v-if="form">
      <form @submit.prevent="handleSave">
        <n-form :model="form" :rules="formRules" ref="formRef" :label-placement="labelPlacement" label-width="160">
          <n-form-item label="Name" path="name">
            <n-input v-model:value="form.name" placeholder="Leave empty to use path" />
          </n-form-item>
          <n-form-item label="Path" path="path">
            <n-input v-model:value="form.path" placeholder="e.g. full-access" />
          </n-form-item>
          <n-form-item label="Token">
            <n-input-group>
              <n-input :value="maskedToken" readonly />
              <n-button @click="revealed = !revealed">{{ revealed ? 'Hide' : 'Show' }}</n-button>
              <n-button @click="copyToken">Copy</n-button>
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
      <div class="form-actions">
        <n-button size="small" @click="regenerateToken" :loading="regenerating">Regenerate Token</n-button>
      </div>
    </n-card>
    <n-spin v-else-if="!loadError" />
    <n-card v-else>
      <n-result status="error" title="Failed to Load Subscription" :description="loadError">
        <template #footer>
          <n-button @click="loadSubscription">Retry</n-button>
        </template>
      </n-result>
    </n-card>

    <n-modal v-model:show="showTokenModal" title="New Token" :mask-closable="false">
      <n-card class="modal-card" closable @close="showTokenModal = false">
        <p>Use this token in the subscription URL:</p>
        <n-input-group>
          <n-input :value="newToken" readonly />
          <n-button @click="copyNewToken">Copy</n-button>
        </n-input-group>
        <n-alert type="warning" style="margin-top: var(--space-md)">
          Token is shown only once. Regenerate if lost.
        </n-alert>
      </n-card>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import { NCard, NForm, NFormItem, NInput, NInputGroup, NSelect, NSwitch, NButton, NModal, NAlert, NSpin, NResult, useMessage, useDialog } from 'naive-ui'
import { useSubscriptionStore } from '@/stores/subscription'
import { extractApiError } from '@/lib/http'
import { useFormLabelPlacement } from '@/composables/useBreakpoint'
import { useSubscriptionTemplateOptions } from '@/composables/useSubscriptionTemplateOptions'
import type { Subscription } from '@/lib/types'

const route = useRoute()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const subscriptionStore = useSubscriptionStore()
const formRef = ref()
const { labelPlacement } = useFormLabelPlacement()
const { versions, clientTemplateOptions, loadVersions, loadClientTemplates } = useSubscriptionTemplateOptions()

const original = ref<Subscription | null>(null)
const form = ref<Subscription | null>(null)
const loadError = ref<string | null>(null)
const revealed = ref(false)
const saving = ref(false)
const regenerating = ref(false)

const showTokenModal = ref(false)
const newToken = ref('')

const versionOptions = computed(() => versions.value.map((v) => ({ label: v, value: v })))

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

const maskedToken = computed(() => {
  if (!original.value?.token) return '—'
  if (revealed.value) return original.value.token
  return '••••••••••••••••••••••••••••••••••••••••••'
})

// 版本变化 → 按新版本重拉过滤后的模板列表（§13.5）。
watch(() => form.value?.singboxVersion, (v) => {
  void loadClientTemplates(v)
})

async function loadSubscription() {
  const id = route.params.id as string
  loadError.value = null
  try {
    const sub = await subscriptionStore.fetchSubscription(id)
    original.value = sub
    form.value = { ...sub }
    revealed.value = false
  } catch (e: unknown) {
    original.value = null
    form.value = null
    loadError.value = extractApiError(e, 'Subscription not found').message
  }
}

async function handleSave() {
  try {
    await formRef.value?.validate()
  } catch { return }
  if (!form.value) return

  if (!form.value.name?.trim()) form.value.name = form.value.path

  saving.value = true
  try {
    const patch: {
      name: string
      path: string
      singboxVersion: string
      overallTemplateId: string | null
      active: boolean
    } = {
      name: form.value.name,
      path: form.value.path,
      singboxVersion: form.value.singboxVersion,
      overallTemplateId: form.value.overallTemplateId,
      active: form.value.active,
    }
    const updated = await subscriptionStore.updateSubscription(form.value.id, patch)
    if (!updated) {
      message.error('Failed to update subscription: the server returned no data.')
      return
    }
    original.value = updated
    message.success('Subscription updated')
    await subscriptionStore.fetchSubscriptions()
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Failed to save').message)
  } finally {
    saving.value = false
  }
}

async function regenerateToken() {
  if (!form.value) return
  regenerating.value = true
  try {
    const updated = await subscriptionStore.updateSubscription(form.value.id, { regenerateToken: true })
    if (!updated) {
      message.error('Failed to regenerate token: the server returned no data.')
      return
    }
    original.value = updated
    form.value.token = updated.token
    newToken.value = updated.token
    showTokenModal.value = true
    message.success('Token regenerated')
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Failed to regenerate token').message)
  } finally {
    regenerating.value = false
  }
}

async function copyToken() {
  if (!original.value?.token) return
  try {
    await navigator.clipboard.writeText(original.value.token)
    message.success('Token copied')
  } catch {
    message.error('Failed to copy — clipboard unavailable (requires HTTPS or a secure context)')
  }
}

async function copyNewToken() {
  try {
    await navigator.clipboard.writeText(newToken.value)
    message.success('Token copied')
  } catch {
    message.error('Failed to copy — clipboard unavailable (requires HTTPS or a secure context)')
  }
}

onMounted(() => {
  void loadSubscription()
  void loadVersions()
})

// Warn when navigating away with pending (unsaved) form edits.
onBeforeRouteLeave(() => {
  if (!form.value || !original.value) return true
  const dirty = form.value.name !== original.value.name
    || form.value.path !== original.value.path
    || form.value.singboxVersion !== original.value.singboxVersion
    || form.value.overallTemplateId !== original.value.overallTemplateId
    || form.value.active !== original.value.active
  if (!dirty) return true
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
