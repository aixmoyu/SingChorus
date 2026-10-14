import { defineStore } from 'pinia'
import { ref } from 'vue'
import http from '@/lib/http'

export interface CompatCheck {
  version: string | null
  range: string
  /** true = compatible, false = incompatible, null = unknown (unreachable). */
  ok: boolean | null
}

export interface CompatReport {
  core: CompatCheck
  cloud: CompatCheck
  strict: boolean
}

export interface SystemInfo {
  data_dir: string
  config_count: number
  panel_version: string
  core_version: string
  cloud_version: string | null
  compat: CompatReport
  framework: string
}

export const useInfoStore = defineStore('info', () => {
  const systemInfo = ref<SystemInfo | null>(null)

  async function fetchSystemInfo() {
    const res = await http.get('/info')
    systemInfo.value = res.data
  }

  return { systemInfo, fetchSystemInfo }
})
