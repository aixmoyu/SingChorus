<template>
  <div class="page">
    <div class="page-header">
      <h1>System Settings</h1>
    </div>

    <n-card title="System Information">
      <n-descriptions v-if="info" bordered :column="1" label-placement="left">
        <n-descriptions-item label="Data Directory">{{ info.data_dir }}</n-descriptions-item>
        <n-descriptions-item label="Config Count">{{ info.config_count }}</n-descriptions-item>
        <n-descriptions-item label="Panel Version">{{ info.panel_version }}</n-descriptions-item>
        <n-descriptions-item label="Framework">{{ info.framework }}</n-descriptions-item>
      </n-descriptions>
      <n-spin v-else />
    </n-card>

    <n-card title="Node Identity">
      <n-form :model="nodeForm" :label-placement="labelPlacement" label-width="140">
        <n-form-item label="Node Name">
          <n-input v-model:value="nodeForm.nodeName" placeholder="e.g. tokyo-01" />
        </n-form-item>
        <n-form-item label="Node Address">
          <n-input v-model:value="nodeForm.nodeAddress" placeholder="Domain or IP" />
        </n-form-item>
        <div class="form-actions">
          <n-button type="primary" @click="saveNode" :loading="savingNode">Save Node Identity</n-button>
        </div>
      </n-form>
    </n-card>

    <n-card title="sing-box">
      <n-form :label-placement="labelPlacement" label-width="140">
        <n-form-item label="Version">
          <n-select
            v-model:value="singboxVersionValue"
            :options="versionOptions"
            filterable
            tag
            clearable
            placeholder="Follow docker template default"
          />
          <template #feedback>
            Pin the sing-box version for this node. Templates incompatible with the pinned version are hidden; the docker image is pinned to v{{ singboxVersionValue || '(default)' }} on the next deploy.
          </template>
        </n-form-item>
        <div class="form-actions">
          <n-button type="primary" @click="saveSingbox" :loading="savingSingbox">Save Version</n-button>
        </div>
      </n-form>
    </n-card>

    <n-card title="Cloud Settings">
      <n-form :model="form" :label-placement="labelPlacement" label-width="140">
        <n-form-item label="Cloud URL">
          <CloudUrlInput v-model:value="form.coreUrl" placeholder="cloud.example.com…" />
        </n-form-item>
        <n-form-item label="Cloud Token">
          <n-input v-model:value="form.coreToken" type="password" show-password-on="click" placeholder="Cloud API token" />
        </n-form-item>
        <div class="form-actions">
          <n-button @click="testConnection" :loading="testing">Test Connection</n-button>
          <n-button type="primary" @click="saveCloud" :loading="savingCloud">Save</n-button>
        </div>
        <n-alert v-if="testResult !== null" :type="testResult ? 'success' : 'error'" style="margin-top: var(--space-md)">
          {{ testResult ? 'Connection successful' : 'Connection failed' }}
        </n-alert>
      </n-form>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, computed, onMounted } from 'vue'
import { NCard, NDescriptions, NDescriptionsItem, NSpin, NForm, NFormItem, NInput, NButton, NAlert, NSelect, useMessage, useDialog } from 'naive-ui'
import { useInfoStore } from '@/stores/info'
import { useSettingsStore } from '@/stores/settings'
import { useSubscriptionStore } from '@/stores/subscription'
import http from '@/lib/http'
import CloudUrlInput from '@/components/CloudUrlInput.vue'
import { extractApiError } from '@/lib/http'
import { useFormLabelPlacement } from '@/composables/useBreakpoint'

const infoStore = useInfoStore()
const settings = useSettingsStore()
const subscriptionStore = useSubscriptionStore()
const message = useMessage()
const dialog = useDialog()
const { labelPlacement } = useFormLabelPlacement()

const info = computed(() => infoStore.systemInfo)

const form = reactive({ coreUrl: '', coreToken: '' })
const nodeForm = reactive({ nodeName: '', nodeAddress: '' })
const testing = ref(false)
const savingNode = ref(false)
const savingCloud = ref(false)
const testResult = ref<boolean | null>(null)

// --- sing-box version pin ---
const singboxVersionValue = ref<string | null>(null)
const savedSingboxVersion = ref<string | null>(null)
const savingSingbox = ref(false)
const catalogVersions = ref<string[]>([])

/** 版本下拉候选：来自 cloud 版本目录端点（设计 §13.3）。 */
const versionOptions = computed(() => catalogVersions.value.map((v) => ({ label: v, value: v })))

/** Persist the sing-box version pin only. Returns false (and shows the error) on failure. */
async function saveSingbox(): Promise<boolean> {
  const version = singboxVersionValue.value || ''
  if (version && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    message.error('Invalid version format — use X.Y.Z (optional -prerelease).')
    return false
  }
  savingSingbox.value = true
  try {
    await settings.saveSettings(undefined, undefined, undefined, undefined, version)
    // 版本变更影响面提示（设计 §13.5）：绑定旧版本的订阅将开始交付 400，
    // 需要到订阅页同步修改绑定版本。
    const previous = savedSingboxVersion.value
    savedSingboxVersion.value = version || null
    message.success('sing-box version saved — takes effect on the next deploy')
    if (version && previous && previous !== version) {
      const affected = subscriptionStore.subscriptions.filter(
        (s) => s.active && s.singboxVersion && s.singboxVersion !== version,
      )
      if (affected.length > 0) {
        dialog.warning({
          title: 'Subscriptions Bound to the Old Version',
          content:
            `${affected.length} subscription(s) are pinned to a different sing-box version and will fail delivery until updated: ` +
            affected.map((s) => `${s.name || s.path} (${s.singboxVersion})`).join(', ') +
            '. Update their pinned version in Subscriptions.',
          positiveText: 'OK',
        })
      }
    }
    return true
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Save failed').message)
    return false
  } finally { savingSingbox.value = false }
}

/** Probe the candidate cloud values in the form without persisting them. */
async function testConnection() {
  if (!form.coreUrl.trim() || !form.coreToken.trim()) {
    testResult.value = false
    message.warning('Enter both Cloud URL and Cloud Token before testing.')
    return
  }
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await settings.testCandidate(form.coreUrl, form.coreToken)
  } catch { testResult.value = false }
  finally { testing.value = false }
}

/** Persist node identity only. Returns false (and shows the error) on failure. */
async function saveNode(): Promise<boolean> {
  savingNode.value = true
  try {
    await settings.saveSettings(undefined, undefined, nodeForm.nodeName, nodeForm.nodeAddress)
    message.success('Node identity saved')
    return true
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Save failed').message)
    return false
  } finally { savingNode.value = false }
}

/** Persist cloud settings only. Returns false (and shows the error) on failure. */
async function saveCloud(): Promise<boolean> {
  savingCloud.value = true
  try {
    await settings.saveSettings(form.coreUrl, form.coreToken)
    message.success('Cloud settings saved')
    return true
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Save failed').message)
    return false
  } finally { savingCloud.value = false }
}

onMounted(async () => {
  try {
    await settings.fetchSettings()
  } catch { /* form stays empty — user can fill values manually */ }
  form.coreUrl = settings.coreUrl
  form.coreToken = settings.coreToken
  nodeForm.nodeName = settings.nodeName
  nodeForm.nodeAddress = settings.nodeAddress
  singboxVersionValue.value = settings.singboxVersion || null
  savedSingboxVersion.value = settings.singboxVersion || null
  infoStore.fetchSystemInfo().catch(() => { /* system info is best-effort */ })
  // 版本下拉候选来自 cloud 版本目录（§13.3）；未配置 cloud 时保持为空。
  http.get('/core/cloud/singbox-versions')
    .then((res) => { catalogVersions.value = res.data.versions ?? [] })
    .catch(() => { /* selector stays empty */ })
  // 订阅列表用于版本变更影响面提示（§13.5）；best-effort。
  subscriptionStore.fetchSubscriptions().catch(() => { /* non-blocking */ })
})
</script>
