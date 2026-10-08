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
          <n-step title="sing-box Version" />
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
              <n-form-item label="Previous Fingerprint">
                <n-input v-model:value="previousFingerprint" placeholder="Optional — e.g. a1b2c3d4e5f6…" clearable />
                <template #feedback>
                  Reinstall recovery: paste the fingerprint recorded before the OS reinstall.
                  The cloud will rebind the old node's configs to this machine so they sync back.
                </template>
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
              <n-button type="primary" :disabled="!cloudUrl.trim() || !cloudToken.trim()" @click="step = 4">Next</n-button>
            </div>
            <n-alert v-if="testResult === true" type="success" class="step-alert">Connection successful</n-alert>
            <n-alert v-if="testResult === false" type="error" class="step-alert">Connection failed: {{ testError }}</n-alert>
          </div>
        </template>

        <!-- Step 4: sing-box version -->
        <template v-if="step === 4">
          <div class="step-body">
            <form @submit.prevent="finish">
              <n-form :label-placement="labelPlacement" label-width="140">
                <n-form-item label="sing-box Version">
                  <n-select
                    v-model:value="singboxVersion"
                    :options="versionOptions"
                    :loading="versionsLoading"
                    placeholder="Select the sing-box version this node runs"
                    filterable
                  />
                  <template #feedback>
                    Protocol templates are filtered and validated against this version — same as deploy and subscriptions.
                  </template>
                </n-form-item>
              </n-form>
              <div class="form-actions">
                <n-button @click="step = 3">Back</n-button>
                <n-button @click="loadVersions" :loading="versionsLoading">Refresh</n-button>
                <n-button type="primary" attr-type="submit" :loading="finishing" :disabled="!singboxVersion">
                  Finish Setup
                </n-button>
              </div>
            </form>
            <n-alert v-if="versionsError" type="error" class="step-alert">
              Failed to load version catalog: {{ versionsError }}
            </n-alert>
            <n-alert v-if="finishError" type="error" class="step-alert">{{ finishError }}</n-alert>
          </div>
        </template>

        <!-- Done -->
        <template v-if="step === 5">
          <n-result status="success" title="Setup Complete" description="This node is registered with the cloud. Configs will sync automatically.">
            <template #footer>
              <n-button type="primary" @click="goDashboard">Go to Dashboard</n-button>
            </template>
          </n-result>
          <n-alert v-if="restoredInfo" type="success" class="step-alert">
            {{ restoredInfo.rebound
              ? `Old node rebound — ${restoredInfo.restored} config(s) restored from the cloud. Re-deploy them to bring subscriptions back online.`
              : 'Fingerprint restored — configs will sync from the cloud automatically.' }}
          </n-alert>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  NSteps, NStep, NForm, NFormItem, NInput, NButton, NAlert, NResult, NSelect,
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
const previousFingerprint = ref('')

const cloudUrl = ref('')
const cloudToken = ref('')
const testing = ref(false)
const testResult = ref<boolean | null>(null)
const testError = ref('')
const finishing = ref(false)
const finishError = ref('')
const restoredInfo = ref<{ rebound: boolean; restored: number } | null>(null)

const singboxVersion = ref('')
const versionOptions = ref<Array<{ label: string; value: string }>>([])
const versionsLoading = ref(false)
const versionsError = ref('')

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
    // Preselect the current pin when re-running the wizard.
    singboxVersion.value = init.singboxVersion
  } catch { /* wizard still usable with defaults */ }
  if (!auth.firstRun) step.value = 2
})

// Entering the version step needs the catalog from the candidate cloud
// settings entered in step 3 — fetch lazily so the probe uses fresh input.
watch(step, (s) => {
  if (s === 4 && versionOptions.value.length === 0) void loadVersions()
})

async function loadVersions() {
  versionsLoading.value = true
  versionsError.value = ''
  try {
    const versions = await init.fetchCandidateVersions(cloudUrl.value.trim(), cloudToken.value.trim())
    versionOptions.value = versions.map((v) => ({ label: v, value: v }))
    if (versions.length === 0) {
      versionsError.value = 'the cloud returned an empty version catalog'
    } else if (singboxVersion.value && !versions.includes(singboxVersion.value)) {
      // Current pin no longer offered — force an explicit re-selection.
      singboxVersion.value = ''
    }
  } catch (e: unknown) {
    versionsError.value = extractApiError(e, 'Failed to load versions').message
  } finally {
    versionsLoading.value = false
  }
}

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
    const res = await init.completeInit({
      node_name: nodeName.value.trim(),
      node_address: nodeAddress.value.trim(),
      cloud_url: cloudUrl.value.trim(),
      cloud_token: cloudToken.value.trim(),
      singbox_version: singboxVersion.value,
      ...(previousFingerprint.value.trim() ? { previous_fingerprint: previousFingerprint.value.trim() } : {}),
    })
    restoredInfo.value = previousFingerprint.value.trim()
      ? { rebound: res.rebound === true, restored: res.restored ?? 0 }
      : null
    auth.initialized = true
    step.value = 5
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
