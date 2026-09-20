<template>
  <div class="login-page">
    <div class="login-hero">
      <div class="hero-content">
        <svg class="hero-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="1.5" />
          <path d="M8 12l3 3 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <h1 class="hero-title">ChorusPanel</h1>
        <p class="hero-subtitle">Chorus management dashboard</p>
      </div>
    </div>
    <div class="login-main">
      <div class="auth-card">
        <h2 v-if="auth.firstRun" class="auth-title">Set Admin Password</h2>
        <h2 v-else class="auth-title">Log In</h2>
        <n-alert v-if="auth.firstRun" type="info" class="auth-alert">First run — please set an admin password.</n-alert>
        <template v-if="auth.firstRun">
          <form @submit.prevent="handleSetup" class="auth-form">
            <n-form-item label="New Password" name="new-password">
              <n-input
                ref="passwordInputRef"
                v-model:value="password"
                type="password"
                show-password-on="click"
                name="new-password"
                autocomplete="new-password"
                placeholder="Enter new admin password"
                :input-props="{ autofocus: true }"
              />
            </n-form-item>
            <n-button type="primary" block :loading="loading" attr-type="submit" size="large">Set Password &amp; Login</n-button>
          </form>
        </template>
        <template v-else>
          <form @submit.prevent="handleLogin" class="auth-form">
            <n-form-item label="Password" name="password">
              <n-input
                ref="passwordInputRef"
                v-model:value="password"
                type="password"
                show-password-on="click"
                name="password"
                autocomplete="current-password"
                placeholder="Enter admin password"
                :input-props="{ autofocus: true }"
              />
            </n-form-item>
            <n-button type="primary" block :loading="loading" attr-type="submit" size="large">Login</n-button>
          </form>
        </template>
        <n-alert v-if="error" type="error" class="auth-error-alert">{{ error }}</n-alert>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, nextTick, type Ref } from 'vue'
import { useRouter } from 'vue-router'
import { NFormItem, NInput, NButton, NAlert } from 'naive-ui'
import { useAuthStore } from '@/stores/auth'
import { extractApiError } from '@/lib/http'

const router = useRouter()
const auth = useAuthStore()
const password = ref('')
const loading = ref(false)
const error = ref('')
const passwordInputRef = ref<{ focus: () => void } | null>(null) as Ref<{ focus: () => void } | null>

onMounted(async () => {
  // Always re-verify against the server — a stale store (e.g. isAuthenticated
  // set by a setup/login call whose cookie the browser then dropped) used to
  // bounce straight back to /setup and form an infinite login↔setup loop.
  await auth.checkStatus()
  if (auth.isAuthenticated) {
    router.push({ name: auth.initialized ? 'dashboard' : 'setup' })
    return
  }
  // Autofocus the password field for desktop speed.
  await nextTick()
  passwordInputRef.value?.focus()
})

async function handleSetup() {
  if (!password.value) { error.value = 'Password is required.'; return }
  loading.value = true
  error.value = ''
  try {
    await auth.setup(password.value)
    router.push({ name: 'setup' })
  } catch (e: unknown) {
    error.value = extractApiError(e, 'Setup failed').message
  } finally {
    loading.value = false
  }
}

async function handleLogin() {
  if (!password.value) { error.value = 'Password is required.'; return }
  loading.value = true
  error.value = ''
  try {
    await auth.login(password.value)
    router.push({ name: 'dashboard' })
  } catch (e: unknown) {
    error.value = extractApiError(e, 'Login failed').message
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-page {
  display: flex;
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
}

.login-hero {
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

.hero-icon {
  color: var(--color-on-primary);
  display: block;
  margin-bottom: var(--space-md);
  margin-inline: auto;
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
  margin-bottom: 0;
}

.login-main {
  flex: 1;
  background: var(--color-canvas);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-xxl);
}

.auth-card {
  width: 100%;
  max-width: 400px;
}

.auth-title {
  font-size: var(--font-heading-2-size);
  font-weight: var(--font-heading-2-weight);
  letter-spacing: var(--font-heading-2-tracking);
  color: var(--color-ink);
  margin: 0 0 var(--space-lg);
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-md);
}

.auth-alert {
  margin-bottom: var(--space-md);
}

.auth-error-alert {
  margin-top: var(--space-md);
}

@media (max-width: 768px) {
  .login-page {
    flex-direction: column;
    overflow-y: auto;
  }

  .login-hero {
    flex: none;
    padding: var(--space-xl) var(--space-md);
    min-height: auto;
  }

  .hero-title {
    font-size: var(--font-heading-1-size);
    letter-spacing: var(--font-heading-1-tracking);
  }

  .login-main {
    flex: 1;
    padding: var(--space-lg) var(--space-md);
  }
}

@media (max-width: 480px) {
  .hero-title {
    font-size: var(--font-heading-2-size);
    letter-spacing: var(--font-heading-2-tracking);
  }

  .hero-icon {
    width: 36px;
    height: 36px;
  }
}
</style>
