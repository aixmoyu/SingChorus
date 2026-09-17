<template>
  <div class="page">
    <div class="page-header">
      <h1>Subscriptions</h1>
      <div class="page-header-actions">
        <n-button type="primary" @click="$router.push({ name: 'subscription-create' })">Create Subscription</n-button>
      </div>
    </div>

    <template v-if="subscriptionStore.loading">
      <n-spin size="large" style="margin: var(--space-xl) auto; display: block" />
    </template>
    <template v-else-if="subscriptions.length === 0">
      <n-empty description="No subscriptions yet. Create one to get started.">
        <template #extra>
          <n-button type="primary" size="small" @click="$router.push({ name: 'subscription-create' })">Create Subscription</n-button>
        </template>
      </n-empty>
    </template>
    <template v-else>
      <div class="table-scroll">
        <n-data-table :columns="columns" :data="subscriptions" :bordered="true" size="small" :pagination="pagination" :row-key="(r: Subscription) => r.id" />
      </div>
    </template>

    <n-modal v-model:show="showDeleteModal">
      <n-card title="Delete Subscription?" closable @close="showDeleteModal = false" class="modal-card">
        <n-text>Are you sure you want to delete subscription <n-text type="primary" code>{{ deleteTarget?.name }}</n-text>? This action cannot be undone.</n-text>
        <template #footer>
          <div class="form-actions">
            <n-button @click="showDeleteModal = false">Cancel</n-button>
            <n-button type="error" :loading="deleting" @click="confirmDelete">Delete</n-button>
          </div>
        </template>
      </n-card>
    </n-modal>

    <n-modal v-model:show="showLinkModal">
      <n-card title="Subscription Link" closable @close="showLinkModal = false" class="modal-card modal-card--wide">
        <n-text>Subscription <n-text type="primary" code>{{ linkTarget?.name }}</n-text>:</n-text>
        <n-input-group style="margin-top: var(--space-sm)">
          <n-input :value="fullLink" readonly />
          <n-button type="primary" @click="copyLink">Copy Link</n-button>
        </n-input-group>
      </n-card>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, h } from 'vue'
import { useRouter } from 'vue-router'
import {
  NDataTable, NButton, NSpace, NModal, NCard, NText, NEmpty, NSwitch, NInput, NInputGroup, NSpin, useMessage,
} from 'naive-ui'
import { useSubscriptionStore } from '@/stores/subscription'
import { useSettingsStore } from '@/stores/settings'
import { extractApiError } from '@/lib/http'
import type { Subscription } from '@/lib/types'

const router = useRouter()
const message = useMessage()
const subscriptionStore = useSubscriptionStore()
const settingsStore = useSettingsStore()

const subscriptions = computed(() => subscriptionStore.subscriptions)

const pagination = { pageSize: 10 }

const showDeleteModal = ref(false)
const deleting = ref(false)
const deleteTarget = ref<Subscription | null>(null)

const showLinkModal = ref(false)
const linkTarget = ref<Subscription | null>(null)

const columns = [
  { title: 'Name', key: 'name' },
  { title: 'Path', key: 'path' },
  {
    title: 'Active', key: 'active',
    render: (row: Subscription) => h(NSwitch, {
      value: row.active,
      loading: toggling.value.has(row.id),
      'onUpdate:value': () => toggleActive(row),
    }),
  },
  {
    title: 'Actions', key: 'actions',
    render: (row: Subscription) =>
      h(NSpace, { size: 'small' }, {
        default: () => [
          h(NButton, { size: 'small', onClick: () => router.push({ name: 'subscription-detail', params: { id: row.id } }) }, { default: () => 'Detail' }),
          h(NButton, { size: 'small', onClick: () => promptLink(row) }, { default: () => 'Link' }),
          h(NButton, { size: 'small', type: 'error', onClick: () => promptDelete(row) }, { default: () => 'Delete' }),
        ],
      }),
  },
]

const toggling = ref<Set<string>>(new Set())

async function toggleActive(sub: Subscription) {
  if (toggling.value.has(sub.id)) return
  toggling.value = new Set(toggling.value).add(sub.id)
  try {
    await subscriptionStore.updateSubscription(sub.id, { active: !sub.active })
    await subscriptionStore.fetchSubscriptions()
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Failed to toggle active').message)
  } finally {
    const next = new Set(toggling.value)
    next.delete(sub.id)
    toggling.value = next
  }
}

function promptDelete(sub: Subscription) {
  deleteTarget.value = sub
  showDeleteModal.value = true
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    await subscriptionStore.deleteSubscription(deleteTarget.value.id)
    message.success(`Deleted subscription '${deleteTarget.value.name}'`)
    await subscriptionStore.fetchSubscriptions()
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Failed to delete').message)
  } finally {
    deleting.value = false
    showDeleteModal.value = false
    deleteTarget.value = null
  }
}

const fullLink = computed(() => {
  const sub = linkTarget.value
  if (!sub) return ''
  const base = (settingsStore.effectiveCloudUrl || '').replace(/\/+$/, '')
  if (!base || !sub.path || !sub.token) return ''
  return `${base}/s/${encodeURIComponent(sub.path)}?token=${encodeURIComponent(sub.token)}`
})

function promptLink(sub: Subscription) {
  linkTarget.value = sub
  showLinkModal.value = true
}

async function copyLink() {
  if (!fullLink.value) {
    message.error('Subscription link is unavailable (cloud URL not configured)')
    return
  }
  try {
    await navigator.clipboard.writeText(fullLink.value)
    message.success('Subscription link copied')
  } catch {
    message.error('Failed to copy — clipboard unavailable (requires HTTPS or a secure context)')
  }
}

onMounted(() => {
  subscriptionStore.fetchSubscriptions()
  settingsStore.fetchSettings().catch(() => { /* silent — link modal degrades gracefully */ })
})
</script>

<style scoped>
.table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}
</style>
