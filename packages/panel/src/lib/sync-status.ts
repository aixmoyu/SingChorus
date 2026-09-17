import type { SyncStatus } from './types'

/** Naive UI tag type per sync status — shared by Dashboard and ConfigList. */
export const syncStatusColor: Record<SyncStatus, 'success' | 'warning' | 'error' | 'default'> = {
  synced: 'success',
  pending_upload: 'warning',
  pending_update: 'error',
  unknown: 'default',
}

/** Human-readable label per sync status — shared by Dashboard and ConfigList. */
export const syncStatusLabel: Record<SyncStatus, string> = {
  synced: 'Synced',
  pending_upload: 'Pending Upload',
  pending_update: 'Pending Update',
  unknown: 'Unknown',
}
