<template>
  <div class="page">
    <div class="page-header">
      <h1>Configurations</h1>
      <div class="page-header-actions">
        <n-button type="primary" @click="$router.push({ name: 'config-create' })">Create Config</n-button>
      </div>
    </div>

    <template v-if="configStore.loading">
      <n-spin size="large" style="margin: var(--space-xl) auto; display: block" />
    </template>
    <template v-else-if="configStore.configs.length === 0">
      <n-empty description="No configurations yet. Create one to get started.">
        <template #extra>
          <n-button type="primary" size="small" @click="$router.push({ name: 'config-create' })">Create Config</n-button>
        </template>
      </n-empty>
    </template>
    <template v-else>
      <n-alert v-if="cloudStore.syncFailures.length" type="warning" closable class="sync-failures-alert">
        <template #header>Some configs failed to sync to the cloud</template>
        <ul class="sync-failure-list">
          <li v-for="f in cloudStore.syncFailures" :key="f.name">
            <n-text code>{{ f.name }}</n-text>: {{ f.message }}
          </li>
        </ul>
      </n-alert>
      <div class="table-scroll">
        <n-data-table :columns="columns" :data="configStore.configs" :bordered="true" :row-key="(r: ConfigEntry) => r.name" :pagination="pagination" />
      </div>
    </template>

    <template v-if="configStore.remoteConfigs.length > 0">
      <div class="page-header remote-header">
        <h2>Other Nodes</h2>
        <n-text depth="3" class="remote-hint">Synced from other machines — read-only locally</n-text>
      </div>
      <div class="table-scroll">
        <n-data-table :columns="remoteColumns" :data="configStore.remoteConfigs" :bordered="true" :row-key="(r: ConfigEntry) => r.node_fingerprint + ':' + r.name" :pagination="pagination" />
      </div>
    </template>

    <n-modal v-model:show="showDeleteModal">
      <n-card :title="isRemoteDelete ? 'Remove Remote Configuration?' : 'Delete Configuration?'" closable @close="showDeleteModal = false" class="modal-card">
        <n-text v-if="isRemoteDelete">Remove config <n-text type="primary" code>{{ deleteTarget?.name }}</n-text> from the cloud? It will disappear from all nodes synced to the cloud.</n-text>
        <n-text v-else>Are you sure you want to delete config <n-text type="primary" code>{{ deleteTarget?.name }}</n-text>? This action cannot be undone.</n-text>
        <template #footer>
          <div class="form-actions">
            <n-button @click="showDeleteModal = false">Cancel</n-button>
            <n-button type="error" :loading="deleting" @click="confirmDelete">{{ isRemoteDelete ? 'Remove' : 'Delete' }}</n-button>
          </div>
        </template>
      </n-card>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { h, ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NDataTable, NButton, NSpace, NTag, NModal, NCard, NText, NEmpty, NAlert, useMessage } from 'naive-ui'
import { useConfigStore } from '@/stores/config'
import { useCloudStore } from '@/stores/cloud'
import { extractApiError } from '@/lib/http'
import { syncStatusColor, syncStatusLabel } from '@/lib/sync-status'
import type { ConfigEntry, SyncStatus } from '@/lib/types'

const message = useMessage()
const router = useRouter()
const configStore = useConfigStore()
const cloudStore = useCloudStore()

const showDeleteModal = ref(false)
const deleting = ref(false)
const deleteTarget = ref<ConfigEntry | null>(null)

const isRemoteDelete = computed(() => Boolean(deleteTarget.value?.node_fingerprint))
const pagination = { pageSize: 10 }

const columns = [
  { title: 'Name', key: 'name', sorter: (a: ConfigEntry, b: ConfigEntry) => a.name.localeCompare(b.name) },
  { title: 'Type', key: 'type', sorter: (a: ConfigEntry, b: ConfigEntry) => a.type.localeCompare(b.type) },
  {
    title: 'Sync',
    key: 'sync',
    render: (row: ConfigEntry) => {
      const status: SyncStatus = cloudStore.syncStatuses[row.name] || 'unknown'
      return h(NTag, { type: syncStatusColor[status], size: 'small' }, { default: () => syncStatusLabel[status] })
    },
  },
  {
    title: 'Deployed',
    key: 'deployed',
    render: (row: ConfigEntry) =>
      h(NTag, { type: row.deployed ? 'success' : 'default', size: 'small' }, { default: () => (row.deployed ? 'Yes' : 'No') }),
  },
  {
    title: 'Enabled',
    key: 'enabled',
    render: (row: ConfigEntry) => h(NTag, { type: row.enabled ? 'success' : 'default', size: 'small' }, { default: () => row.enabled ? 'Yes' : 'No' }),
  },
  {
    title: 'Actions',
    key: 'actions',
    render: (row: ConfigEntry) =>
      h(NSpace, { size: 'small' }, {
        default: () => [
          h(NButton, { size: 'small', onClick: () => router.push({ name: 'config-detail', params: { name: row.name } }) }, { default: () => 'Detail' }),
          h(NButton, { size: 'small', type: row.enabled ? 'warning' : 'success', onClick: () => toggleEnable(row) }, { default: () => row.enabled ? 'Disable' : 'Enable' }),
          h(NButton, { size: 'small', type: 'error', onClick: () => promptDelete(row) }, { default: () => 'Delete' }),
        ],
      }),
  },
]

const remoteColumns = [
  { title: 'Name', key: 'name', sorter: (a: ConfigEntry, b: ConfigEntry) => a.name.localeCompare(b.name) },
  { title: 'Type', key: 'type' },
  { title: 'Node Fingerprint', key: 'node_fingerprint', render: (row: ConfigEntry) => row.node_fingerprint?.slice(0, 12) + '…' },
  {
    title: 'Enabled',
    key: 'enabled',
    render: (row: ConfigEntry) => h(NTag, { type: row.enabled ? 'success' : 'default', size: 'small' }, { default: () => row.enabled ? 'Yes' : 'No' }),
  },
  { title: 'Updated', key: 'updated_at' },
  {
    title: 'Actions',
    key: 'actions',
    render: (row: ConfigEntry) =>
      h(NSpace, { size: 'small' }, {
        default: () => [
          h(NButton, { size: 'small', onClick: () => viewRemote(row) }, { default: () => 'View' }),
          h(NButton, { size: 'small', type: 'error', onClick: () => promptDelete(row) }, { default: () => 'Delete' }),
        ],
      }),
  },
]

async function toggleEnable(row: ConfigEntry) {
  try {
    if (row.enabled) { await configStore.disableConfig(row.name) } else { await configStore.enableConfig(row.name) }
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Toggle failed').message)
    return
  }
  // Mutations auto-sync server-side; refresh both lists and sync badges.
  await Promise.all([
    configStore.fetchConfigs(),
    configStore.fetchRemoteConfigs(),
    cloudStore.fetchSyncStatuses(),
  ])
}

function viewRemote(row: ConfigEntry) {
  router.push({ name: 'config-detail', params: { name: row.name }, query: { fingerprint: row.node_fingerprint } })
}

function promptDelete(row: ConfigEntry) {
  deleteTarget.value = row
  showDeleteModal.value = true
}

async function confirmDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    if (deleteTarget.value.node_fingerprint) {
      await configStore.deleteRemoteConfig(deleteTarget.value.node_fingerprint, deleteTarget.value.name)
    } else {
      await configStore.deleteConfig(deleteTarget.value.name)
    }
    await Promise.all([
      configStore.fetchConfigs(),
      configStore.fetchRemoteConfigs(),
      cloudStore.fetchSyncStatuses(),
    ])
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Delete failed').message)
  } finally {
    deleting.value = false
    showDeleteModal.value = false
    deleteTarget.value = null
  }
}

onMounted(async () => {
  try {
    await configStore.fetchConfigs()
  } catch (e: unknown) {
    message.error(extractApiError(e, 'Failed to fetch configs').message)
  }
  // Read-only refresh on load. Pushing to the cloud is the background sync
  // engine's job — viewing a page should not trigger sync runs.
  configStore.fetchRemoteConfigs()
  cloudStore.fetchSyncStatuses()
})
</script>

<style scoped>
.sync-failures-alert {
  margin-bottom: var(--space-md);
}

.sync-failure-list {
  margin: 0;
  padding-left: 1.2em;
}

.table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.remote-header {
  margin-top: var(--space-xl);
}

.remote-hint {
  font-size: var(--font-body-sm-size);
}
</style>
