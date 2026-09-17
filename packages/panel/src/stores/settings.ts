import { defineStore } from 'pinia'
import { ref } from 'vue'
import http from '@/lib/http'

export const useSettingsStore = defineStore('settings', () => {
  const coreUrl = ref('')
  const coreToken = ref('')
  const nodeName = ref('')
  const nodeAddress = ref('')
  const effectiveCloudUrl = ref('')

  async function fetchSettings() {
    const res = await http.get('/settings')
    coreUrl.value = res.data.core_url
    coreToken.value = res.data.core_token
    nodeName.value = res.data.node_name || ''
    nodeAddress.value = res.data.node_address || ''
    effectiveCloudUrl.value = res.data.effective_cloud_url || ''
  }

  async function saveSettings(url?: string, token?: string, nodeNameValue?: string, nodeAddressValue?: string) {
    const res = await http.post('/settings', {
      core_url: url,
      core_token: token,
      node_name: nodeNameValue,
      node_address: nodeAddressValue,
    })
    coreUrl.value = res.data.core_url
    coreToken.value = res.data.core_token
    nodeName.value = res.data.node_name || ''
    nodeAddress.value = res.data.node_address || ''
    effectiveCloudUrl.value = res.data.effective_cloud_url || ''
  }

  async function testConnection() {
    const res = await http.post('/settings/test')
    return res.data.reachable as boolean
  }

  /** Probe candidate cloud settings without persisting them. */
  async function testCandidate(url: string, token: string) {
    const res = await http.post('/settings/test-candidate', { cloud_url: url, cloud_token: token })
    return res.data.reachable as boolean
  }

  return { coreUrl, coreToken, nodeName, nodeAddress, effectiveCloudUrl, fetchSettings, saveSettings, testConnection, testCandidate }
})
