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

    <n-card title="Cloud Settings">
      <n-form :model="form" :label-placement="labelPlacement" label-width="140">
        <n-form-item label="Cloud URL">
          <n-input v-model:value="form.coreUrl" placeholder="https://cloud.example.com…" />
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
import { NCard, NDescriptions, NDescriptionsItem, NSpin, NForm, NFormItem, NInput, NButton, NAlert, useMessage } from 'naive-ui'
import { useInfoStore } from '@/stores/info'
import { useSettingsStore } from '@/stores/settings'
import { extractApiError } from '@/lib/http'
import { useFormLabelPlacement } from '@/composables/useBreakpoint'

const infoStore = useInfoStore()
const settings = useSettingsStore()
const message = useMessage()
const { labelPlacement } = useFormLabelPlacement()

const info = computed(() => infoStore.systemInfo)

const form = reactive({ coreUrl: '', coreToken: '' })
const nodeForm = reactive({ nodeName: '', nodeAddress: '' })
const testing = ref(false)
const savingNode = ref(false)
const savingCloud = ref(false)
const testResult = ref<boolean | null>(null)

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
  infoStore.fetchSystemInfo().catch(() => { /* system info is best-effort */ })
})
</script>
