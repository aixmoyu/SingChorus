<template>
  <div class="page">
    <div class="page-header">
      <h1>Validate</h1>
    </div>

    <n-tabs type="card" v-model:value="activeTab">
      <n-tab-pane name="entry" tab="Entry Validation">
        <n-card>
          <form @submit.prevent="runEntryValidate">
            <n-form :label-placement="labelPlacement" label-width="120">
              <n-form-item label="Config Name">
                <n-input v-model:value="entryName" placeholder="config name" />
              </n-form-item>
              <n-form-item label="Side">
                <n-select v-model:value="entrySide" :options="sideOptions" />
              </n-form-item>
              <div class="form-actions">
                <n-button type="primary" attr-type="submit">Validate Entry</n-button>
              </div>
            </n-form>
          </form>
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="merged" tab="Merged Validation">
        <n-card>
          <div class="section">
            <n-text>Validate the merged configuration applied to the deployment.</n-text>
            <div class="form-actions">
              <n-button type="primary" @click="runMergedValidate">Validate Merged Config</n-button>
            </div>
          </div>
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="subscription" tab="Subscription Validation">
        <n-card>
          <div class="section">
            <n-text>Validate subscription output (one URL per line).</n-text>
            <div class="form-actions">
              <n-button type="primary" @click="runSubscriptionValidate">Validate Subscription</n-button>
            </div>
          </div>
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="generic" tab="Generic JSON">
        <n-card>
          <form @submit.prevent="runGenericValidate">
            <n-form :label-placement="labelPlacement" label-width="120">
              <n-form-item label="Config JSON">
                <n-input v-model:value="genericJson" type="textarea" :rows="8" class="mono-input" placeholder="Paste JSON config here" />
              </n-form-item>
              <n-form-item label="Label">
                <n-input v-model:value="genericLabel" placeholder="optional label" />
              </n-form-item>
              <div class="form-actions">
                <n-button type="primary" attr-type="submit">Validate</n-button>
              </div>
            </n-form>
          </form>
        </n-card>
      </n-tab-pane>
    </n-tabs>

    <n-modal v-model:show="showResult" title="Validation Result">
      <n-card class="modal-card" closable @close="showResult = false">
        <n-tag :type="result?.valid ? 'success' : 'error'" size="medium">{{ result?.valid ? 'Valid' : 'Invalid' }}</n-tag>
        <template v-if="result?.errors?.length">
          <n-h5 style="margin-top: var(--space-md)">Errors</n-h5>
          <n-ul><n-li v-for="(e, i) in result?.errors" :key="`err-${i}`">{{ e }}</n-li></n-ul>
        </template>
        <template v-if="result?.warnings?.length">
          <n-h5>Warnings</n-h5>
          <n-ul><n-li v-for="(w, i) in result?.warnings" :key="`warn-${i}`">{{ w }}</n-li></n-ul>
        </template>
      </n-card>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { NTabs, NTabPane, NCard, NForm, NFormItem, NInput, NSelect, NButton, NModal, NTag, NH5, NUl, NLi, NText } from 'naive-ui'
import { useValidationStore } from '@/stores/validation'
import { extractApiError } from '@/lib/http'
import { useFormLabelPlacement } from '@/composables/useBreakpoint'
import type { ValidateResult } from '@/lib/types'

const message = useMessage()
const validationStore = useValidationStore()
const activeTab = ref('entry')
const entryName = ref('')
const entrySide = ref<'server' | 'client'>('server')
const genericJson = ref('')
const genericLabel = ref('')
const showResult = ref(false)
const result = ref<ValidateResult | null>(null)
const { labelPlacement } = useFormLabelPlacement()

const sideOptions = [
  { label: 'Server', value: 'server' },
  { label: 'Client', value: 'client' },
]

async function runEntryValidate() {
  try {
    result.value = await validationStore.validateEntry(entryName.value, entrySide.value)
    showResult.value = true
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Validation failed').message)
  }
}
async function runMergedValidate() {
  try {
    result.value = await validationStore.validateMerged()
    showResult.value = true
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Validation failed').message)
  }
}
async function runSubscriptionValidate() {
  try {
    result.value = await validationStore.validateSubscription()
    showResult.value = true
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Validation failed').message)
  }
}
async function runGenericValidate() {
  try {
    const config = JSON.parse(genericJson.value)
    result.value = await validationStore.validateConfig(config, genericLabel.value)
    showResult.value = true
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Invalid JSON').message)
  }
}
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
