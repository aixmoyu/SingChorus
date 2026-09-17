<template>
  <div class="page">
    <div class="page-header">
      <h1>Dashboard</h1>
    </div>

    <div class="stat-grid">
      <div class="feature-card">
        <span class="stat-label">Total Configs</span>
        <n-statistic :value="stats.total" />
      </div>
      <div class="feature-card">
        <span class="stat-label">Enabled</span>
        <n-statistic :value="stats.enabled" />
      </div>
      <div class="feature-card">
        <span class="stat-label">Synced</span>
        <n-statistic :value="stats.synced" />
      </div>
      <div class="feature-card">
        <span class="stat-label">Deploy Status</span>
        <div class="stat-tag-wrap">
          <n-tag :type="deployTagType" size="medium" round>{{ deployStatusText }}</n-tag>
        </div>
      </div>
    </div>

    <n-alert v-if="cloudStore.syncFailures.length" type="warning" closable class="sync-failures-alert">
      <template #header>Some configs failed to sync to the cloud</template>
      <ul class="sync-failure-list">
        <li v-for="f in cloudStore.syncFailures" :key="f.name">
          <n-text code>{{ f.name }}</n-text>: {{ f.message }}
        </li>
      </ul>
    </n-alert>

    <n-card title="Recent Configurations" class="recent-card">
      <template #header-extra>
        <n-button size="small" quaternary @click="$router.push({ name: 'configs' })">View all</n-button>
      </template>
      <template v-if="configStore.loading">
        <n-spin size="medium" style="margin: var(--space-md) auto; display: block" />
      </template>
      <template v-else-if="recentConfigs.length === 0">
        <n-empty description="No configurations yet. Create one to get started.">
          <template #extra>
            <n-button type="primary" size="small" @click="$router.push({ name: 'config-create' })">Create Config</n-button>
          </template>
        </n-empty>
      </template>
      <template v-else>
        <div class="table-scroll">
          <n-data-table :columns="recentColumns" :data="recentConfigs" :bordered="false" size="small" />
        </div>
      </template>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { h, computed, onMounted } from 'vue'
import { NCard, NStatistic, NTag, NDataTable, NEmpty, NButton, NAlert, NText, useMessage } from 'naive-ui'
import { useConfigStore } from '@/stores/config'
import { useCloudStore } from '@/stores/cloud'
import { useDeployStore } from '@/stores/deploy'
import { extractApiError } from '@/lib/http'
import { syncStatusColor, syncStatusLabel } from '@/lib/sync-status'
import type { ConfigEntry, SyncStatus } from '@/lib/types'

const configStore = useConfigStore()
const cloudStore = useCloudStore()
const deployStore = useDeployStore()
const message = useMessage()

const stats = computed(() => {
  const statuses = Object.values(cloudStore.syncStatuses)
  return {
    total: configStore.configs.length,
    enabled: configStore.configs.filter((c: ConfigEntry) => c.enabled).length,
    synced: statuses.filter((s) => s === 'synced').length,
  }
})

const deployTagType = computed(() => {
  if (!deployStore.deployStatus) return 'default' as const
  return deployStore.deployStatus.status === 'running' ? 'success' : 'warning'
})

const deployStatusText = computed(() => deployStore.deployStatus?.status || 'unknown')

const recentConfigs = computed(() => configStore.configs.slice(0, 10))

const recentColumns = [
  { title: 'Name', key: 'name' },
  { title: 'Type', key: 'type' },
  {
    title: 'Sync',
    key: 'sync',
    render: (row: ConfigEntry) => {
      const status: SyncStatus = cloudStore.syncStatuses[row.name] || 'unknown'
      return h(NTag, { type: syncStatusColor[status], size: 'small' }, { default: () => syncStatusLabel[status] })
    },
  },
  {
    title: 'Enabled',
    key: 'enabled',
    render: (row: ConfigEntry) => h(NTag, { type: row.enabled ? 'success' : 'default', size: 'small' }, { default: () => row.enabled ? 'Yes' : 'No' }),
  },
  { title: 'Updated', key: 'updated_at' },
]

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
  try { await deployStore.fetchDeployStatus() } catch { /* core may be unreachable */ }
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

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-md);
}

.feature-card {
  background: var(--color-canvas);
  border-radius: var(--rounded-lg);
  padding: var(--space-lg);
  box-shadow: var(--shadow-level-1);
  display: flex;
  flex-direction: column;
  gap: var(--space-sm);
}

.stat-label {
  font-size: var(--font-eyebrow-size);
  font-weight: var(--font-eyebrow-weight);
  color: var(--color-ink-muted);
  letter-spacing: var(--font-eyebrow-tracking);
  text-transform: uppercase;
}

.stat-tag-wrap {
  display: flex;
  align-items: center;
  min-height: 32px;
}

.recent-card {
  margin-top: 0;
}

.table-scroll {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

@media (max-width: 768px) {
  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 480px) {
  .stat-grid {
    grid-template-columns: 1fr;
  }
}
</style>
