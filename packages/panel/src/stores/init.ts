import { defineStore } from 'pinia'
import { ref } from 'vue'
import http from '@/lib/http'

/**
 * First-run initialization wizard state: node identity (name/address,
 * fingerprint display) and cloud connection, completed after the admin
 * password is set via the auth store.
 */
export const useInitStore = defineStore('init', () => {
  const initialized = ref(false)
  const fingerprint = ref('')
  const nodeName = ref('')
  const nodeAddress = ref('')
  const cloudUrl = ref('')
  const cloudTokenSet = ref(false)

  async function fetchInit() {
    const res = await http.get('/init')
    initialized.value = res.data.initialized
    fingerprint.value = res.data.fingerprint
    nodeName.value = res.data.node_name
    nodeAddress.value = res.data.node_address
    cloudUrl.value = res.data.cloud_url
    cloudTokenSet.value = Boolean(res.data.cloud_token)
  }

  async function completeInit(data: {
    node_name: string
    node_address: string
    cloud_url: string
    cloud_token: string
    cloud_required?: boolean
  }): Promise<{ initialized: boolean; cloud_ok: boolean; cloud_error?: string }> {
    const res = await http.post('/init', data)
    initialized.value = true
    return res.data
  }

  async function testCloud(url: string, token: string): Promise<boolean> {
    // Test against the candidate settings before saving: save first (server
    // probes them), then restore the previous values on failure.
    const res = await http.post('/settings/test-candidate', { cloud_url: url, cloud_token: token })
    return res.data.reachable as boolean
  }

  return { initialized, fingerprint, nodeName, nodeAddress, cloudUrl, cloudTokenSet, fetchInit, completeInit, testCloud }
})
