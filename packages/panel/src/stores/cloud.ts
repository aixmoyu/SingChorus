import { defineStore } from 'pinia'
import { ref } from 'vue'
import http from '@/lib/http'
import type { SyncStatus } from '@/lib/types'

/** One failed push from the last sync round (e.g. cloud 409 port conflict). */
export interface SyncFailure {
  name: string
  message: string
}

/**
 * Store for cloud sync visibility: tracks per-config sync status badges and
 * the push failures of the most recent sync round. Sync itself is fully
 * automatic (mutations, deploy/stop and the background tick engine) — there
 * is no manual sync action anymore.
 */
export const useCloudStore = defineStore('cloud', () => {
  const syncStatuses = ref<Record<string, SyncStatus>>({})
  const syncFailures = ref<SyncFailure[]>([])

  async function fetchSyncStatuses(): Promise<void> {
    try {
      const res = await http.get('/core/cloud/sync-status')
      syncStatuses.value = res.data.statuses || {}
      syncFailures.value = res.data.failures || []
    } catch {
      syncStatuses.value = {}
      syncFailures.value = []
    }
  }

  return { syncStatuses, syncFailures, fetchSyncStatuses }
})
