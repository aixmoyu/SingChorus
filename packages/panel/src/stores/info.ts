import { defineStore } from 'pinia'
import { ref } from 'vue'
import http from '@/lib/http'

export interface SystemInfo {
  data_dir: string
  config_count: number
  panel_version: string
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