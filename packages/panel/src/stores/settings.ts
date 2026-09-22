import { defineStore } from 'pinia'
import { ref } from 'vue'
import http from '@/lib/http'

export const useSettingsStore = defineStore('settings', () => {
  const coreUrl = ref('')
  const coreToken = ref('')
  const nodeName = ref('')
  const nodeAddress = ref('')
  const effectiveCloudUrl = ref('')
  /** 本机 sing-box 版本 pin；'' = 未设置（跟随 docker 模板默认）。 */
  const singboxVersion = ref('')

  async function fetchSettings() {
    const res = await http.get('/settings')
    coreUrl.value = res.data.core_url
    coreToken.value = res.data.core_token
    nodeName.value = res.data.node_name || ''
    nodeAddress.value = res.data.node_address || ''
    effectiveCloudUrl.value = res.data.effective_cloud_url || ''
    singboxVersion.value = res.data.singbox_version || ''
  }

  async function saveSettings(
    url?: string,
    token?: string,
    nodeNameValue?: string,
    nodeAddressValue?: string,
    singboxVersionValue?: string,
  ) {
    const res = await http.post('/settings', {
      core_url: url,
      core_token: token,
      node_name: nodeNameValue,
      node_address: nodeAddressValue,
      // 仅在显式传入时携带，避免旧调用方意外清空版本。
      ...(singboxVersionValue !== undefined ? { singbox_version: singboxVersionValue } : {}),
    })
    coreUrl.value = res.data.core_url
    coreToken.value = res.data.core_token
    nodeName.value = res.data.node_name || ''
    nodeAddress.value = res.data.node_address || ''
    effectiveCloudUrl.value = res.data.effective_cloud_url || ''
    if (singboxVersionValue !== undefined) singboxVersion.value = singboxVersionValue
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

  return { coreUrl, coreToken, nodeName, nodeAddress, effectiveCloudUrl, singboxVersion, fetchSettings, saveSettings, testConnection, testCandidate }
})
