import { defineStore } from 'pinia'
import { ref } from 'vue'
import http from '@/lib/http'
import type { ConfigEntry } from '@/lib/types'

/**
 * Store for configuration entry CRUD operations.
 *
 * Split out of the original god `useCoreStore` so that views which only need
 * to read/write configs (e.g. ConfigList, ConfigDetail) don't pull in deploy,
 * log, or subscription state.
 *
 * Mutations (create/enable/disable/delete) auto-sync server-side; after any
 * mutation we re-fetch both lists so sync badges and remote configs stay fresh.
 */
export const useConfigStore = defineStore('config', () => {
  const configs = ref<ConfigEntry[]>([])
  /** Configs owned by other machines (read-only, synced from cloud). */
  const remoteConfigs = ref<ConfigEntry[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function fetchConfigs(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await http.get('/core/configs')
      configs.value = res.data.configs
    } catch (e) {
      error.value = (e as { message?: string }).message || 'Failed to fetch configs'
      throw e
    } finally {
      loading.value = false
    }
  }

  async function fetchRemoteConfigs(): Promise<void> {
    try {
      const res = await http.get('/core/remote-configs')
      remoteConfigs.value = res.data.configs || []
    } catch {
      remoteConfigs.value = []
    }
  }

  async function fetchConfig(name: string): Promise<ConfigEntry> {
    const res = await http.get(`/core/configs/${encodeURIComponent(name)}`)
    return res.data
  }

  async function createConfig(data: {
    name: string
    node: string
    type: string
    server_config: Record<string, unknown>
    client_config: Record<string, unknown>
    params: Record<string, unknown>
  }): Promise<ConfigEntry> {
    const res = await http.post('/core/configs', data)
    return res.data as ConfigEntry
  }

  async function updateConfig(name: string, data: Partial<ConfigEntry>): Promise<ConfigEntry> {
    const res = await http.put(`/core/configs/${encodeURIComponent(name)}`, data)
    return res.data as ConfigEntry
  }

  async function deleteConfig(name: string): Promise<void> {
    await http.delete(`/core/configs/${encodeURIComponent(name)}`)
  }

  async function enableConfig(name: string): Promise<void> {
    await http.post(`/core/configs/${encodeURIComponent(name)}/enable`)
  }

  async function disableConfig(name: string): Promise<void> {
    await http.post(`/core/configs/${encodeURIComponent(name)}/disable`)
  }

  /** Delete a remote (other machine's) config — removes it in the cloud too. */
  async function deleteRemoteConfig(fingerprint: string, name: string): Promise<void> {
    await http.delete(`/core/remote-configs/${encodeURIComponent(fingerprint)}/${encodeURIComponent(name)}`)
  }

  return {
    configs,
    remoteConfigs,
    loading,
    error,
    fetchConfigs,
    fetchRemoteConfigs,
    fetchConfig,
    createConfig,
    updateConfig,
    deleteConfig,
    enableConfig,
    disableConfig,
    deleteRemoteConfig,
  }
})
