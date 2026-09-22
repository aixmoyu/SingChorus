import { defineStore } from 'pinia'
import { ref } from 'vue'
import http from '@/lib/http'
import type { DeployStatus } from '@/lib/types'

/** 上次成功部署的元信息（core 写入 docker 目录的 deploy-meta.json）。 */
export interface DeployMeta {
  singboxVersion?: string
  singboxImage?: string
  deployedAt?: string
}

/**
 * Store for deploy lifecycle (deploy / stop / restart) and container logs.
 * Polling is intentionally kept in the view layer (`Deploy.vue`) so that the
 * store stays free of timers and can be unit-tested in isolation.
 */
export const useDeployStore = defineStore('deploy', () => {
  const deployStatus = ref<DeployStatus | null>(null)
  const logs = ref<string[]>([])
  const loading = ref(false)
  /** 上次成功部署的元信息；null = 旧部署无记录（unknown）。 */
  const deployMeta = ref<DeployMeta | null>(null)

  async function fetchDeployStatus(): Promise<void> {
    const res = await http.get('/core/deploy/status')
    deployStatus.value = res.data
  }

  async function fetchDeployMeta(): Promise<void> {
    const res = await http.get('/core/deploy/meta')
    deployMeta.value = res.data.meta ?? null
  }

  async function deploy(params: { serverOverallId?: string } = {}): Promise<void> {
    loading.value = true
    try {
      // Deploy includes image pull + health-check polling (up to ~2 min),
      // so it needs a longer timeout than the http client default.
      await http.post('/core/deploy', params, { timeout: 150_000 })
    } finally {
      loading.value = false
    }
  }

  async function stopDeploy(): Promise<void> {
    await http.post('/core/deploy/stop', null, { timeout: 90_000 })
  }

  async function restartDeploy(): Promise<void> {
    await http.post('/core/deploy/restart', null, { timeout: 90_000 })
  }

  async function fetchLogs(tail = 100): Promise<void> {
    const res = await http.get('/core/logs', { params: { tail } })
    logs.value = res.data.lines || []
  }

  return {
    deployStatus,
    logs,
    loading,
    deployMeta,
    fetchDeployStatus,
    fetchDeployMeta,
    deploy,
    stopDeploy,
    restartDeploy,
    fetchLogs,
  }
})
