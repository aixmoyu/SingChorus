<template>
  <div class="setup-page">
    <div class="setup-hero">
      <div class="hero-content">
        <h1 class="hero-title">ChorusPanel</h1>
        <p class="hero-subtitle">Initial setup — identify this machine and connect it to your cloud</p>
      </div>
    </div>
    <div class="setup-main">
      <div class="setup-card">
        <n-steps :current="step" size="small" class="setup-steps">
          <n-step title="Admin Password" />
          <n-step title="Node Identity" />
          <n-step title="Cloud Connection" />
        </n-steps>

        <!-- Step 1: password (only on true first run) -->
        <template v-if="step === 1">
          <div v-if="!auth.firstRun" class="step-body">
            <n-alert type="info">Admin password is already set. Continue to node identity.</n-alert>
            <div class="form-actions">
              <n-button type="primary" @click="step = 2">Next</n-button>
            </div>
          </div>
          <div v-else class="step-body">
            <n-form-item label="Admin Password">
              <n-input
                v-model:value="password"
                type="password"
                show-password-on="click"
                placeholder="At least 8 chars, 3 of: lower/upper/digit/symbol"
              />
            </n-form-item>
            <n-alert v-if="passwordError" type="error" class="step-alert">{{ passwordError }}</n-alert>
            <div class="form-actions">
              <n-button type="primary" :loading="settingPassword" @click="setPassword">Set Password &amp; Continue</n-button>
            </div>
          </div>
        </template>

        <!-- Step 2: node identity -->
        <template v-if="step === 2">
          <div class="step-body">
            <n-form :label-placement="labelPlacement" label-width="140">
              <n-form-item label="Node Name">
                <n-input v-model:value="nodeName" placeholder="e.g. tokyo-01" />
              </n-form-item>
              <n-form-item label="Node Address">
                <n-input v-model:value="nodeAddress" placeholder="Domain or IP, e.g. node1.example.com" />
              </n-form-item>
              <n-form-item label="Fingerprint">
                <n-input :value="fingerprint" disabled />
                <template #feedback>Machine fingerprint — generated locally, used to identify this node</template>
              </n-form-item>
            </n-form>
            <div class="form-actions">
              <n-button @click="step = 1">Back</n-button>
              <n-button type="primary" :disabled="!nodeName.trim()" @click="step = 3">Next</n-button>
            </div>
          </div>
        </template>

        <!-- Step 3: cloud connection -->
        <template v-if="step === 3">
          <div class="step-body">
            <form @submit.prevent="finish">
              <n-form :label-placement="labelPlacement" label-width="140">
                <n-form-item label="Cloud URL">
                  <CloudUrlInput v-model:value="cloudUrl" placeholder="cloud.example.com" />
                </n-form-item>
                <n-form-item label="Cloud Token">
                  <n-input v-model:value="cloudToken" type="password" show-password-on="click" placeholder="Cloud API token" />
                </n-form-item>
              </n-form>
              <div class="form-actions">
                <n-button @click="step = 2">Back</n-button>
                <n-button @click="testCloud" :loading="testing">Test Connection</n-button>
                <n-button type="primary" attr-type="submit" :loading="finishing" :disabled="!cloudUrl.trim() || !cloudToken.trim()">
                  Finish Setup
                </n-button>
              </div>
            </form>
            <n-alert v-if="testResult === true" type="success" class="step-alert">Connection successful</n-alert>
            <n-alert v-if="testResult === false" type="error" class="step-alert">Connection failed: {{ testError }}</n-alert>
            <n-alert v-if="finishError" type="error" class="step-alert">{{ finishError }}</n-alert>
          </div>
        </template>

        <!-- Done -->
        <template v-if="step === 4">
          <n-result status="success" title="Setup Complete" description="This node is registered with the cloud. Configs will sync automatically.">
            <template #footer>
              <n-button type="primary" @click="goDashboard">Go to Dashboard</n-button>
            </template>
          </n-result>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  NSteps, NStep, NForm, NFormItem, NInput, NButton, NAlert, NResult,
} from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { useInitStore } from '@/stores/init'
import CloudUrlInput from '@/components/CloudUrlInput.vue'
import { extractApiError } from '@/lib/http'
import { useFormLabelPlacement } from '@/composables/useBreakpoint'

const router = useRouter()
const auth = useAuthStore()
const init = useInitStore()
const { labelPlacement } = useFormLabelPlacement()

const step = ref(1)

const password = ref('')
const passwordError = ref('')
const settingPassword = ref(false)

const nodeName = ref('')
const nodeAddress = ref('')
const fingerprint = ref('')

const cloudUrl = ref('')
const cloudToken = ref('')
const testing = ref(false)
const testResult = ref<boolean | null>(null)
const testError = ref('')
const finishing = ref(false)
const finishError = ref('')

onMounted(async () => {
  // Fresh server truth, never the store's optimistic state: this page issues
  // authenticated calls (/api/init) on mount, so a stale isAuthenticated
  // (session cookie dropped/expired) must send the user to login instead of
  // letting every call 401 into the interceptor.
  await auth.checkStatus()
  if (!auth.isAuthenticated) {
    router.push({ name: 'login' })
    return
  }
  // Load existing identity values (e.g. when re-running setup after login).
  try {
    await init.fetchInit()
    fingerprint.value = init.fingerprint
    nodeName.value = init.nodeName
    nodeAddress.value = init.nodeAddress
    cloudUrl.value = init.cloudUrl
  } catch { /* wizard still usable with defaults */ }
  if (!auth.firstRun) step.value = 2
})

async function setPassword() {
  passwordError.value = ''
  if (!password.value) {
    passwordError.value = 'Password is required.'
    return
  }
  settingPassword.value = true
  try {
    await auth.setup(password.value)
    try {
      await init.fetchInit()
      fingerprint.value = init.fingerprint
    } catch { /* fingerprint loads on next step */ }
    step.value = 2
  } catch (e: unknown) {
    passwordError.value = extractApiError(e, 'Setup failed').message
  } finally {
    settingPassword.value = false
  }
}

async function testCloud() {
  testing.value = true
  testResult.value = null
  testError.value = ''
  try {
    testResult.value = await init.testCloud(cloudUrl.value.trim(), cloudToken.value.trim())
  } catch (e: unknown) {
    testResult.value = false
    testError.value = extractApiError(e, 'Test failed').message
  } finally {
    testing.value = false
  }
}

async function finish() {
  finishing.value = true
  finishError.value = ''
  try {
    await init.completeInit({
      node_name: nodeName.value.trim(),
      node_address: nodeAddress.value.trim(),
      cloud_url: cloudUrl.value.trim(),
      cloud_token: cloudToken.value.trim(),
    })
    auth.initialized = true
    step.value = 4
  } catch (e: unknown) {
    finishError.value = extractApiError(e, 'Setup failed').message
  } finally {
    finishing.value = false
  }
}

function goDashboard() {
  router.push({ name: 'dashboard' })
}
</script>

<style scoped>
.setup-page {
  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
}

.setup-hero {
  flex: 1;
  background: var(--color-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-xxl);
}

.hero-content {
  text-align: center;
}

.hero-title {
  font-size: var(--font-display-1-size);
  font-weight: var(--font-display-1-weight);
  letter-spacing: var(--font-display-1-tracking);
  color: var(--color-on-primary);
  margin: 0;
  line-height: 1;
}

.hero-subtitle {
  font-size: var(--font-body-md-size);
  color: var(--color-on-primary);
  opacity: 0.7;
  margin-top: var(--space-sm);
}

.setup-main {
  flex: 1;
  background: var(--color-canvas);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-xl);
}

.setup-card {
  width: 100%;
  max-width: 480px;
  background: var(--color-canvas);
}

.setup-steps {
  margin-bottom: var(--space-xl);
}

.step-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.step-alert {
  margin-top: var(--space-sm);
}

@media (max-width: 768px) {
  .setup-page {
    flex-direction: column;
  }

  .setup-hero {
    flex: none;
    padding: var(--space-xl) var(--space-md);
  }

  .setup-main {
    padding: var(--space-lg) var(--space-md);
  }
}
</style>
