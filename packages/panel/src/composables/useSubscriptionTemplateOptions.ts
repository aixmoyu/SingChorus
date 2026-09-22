import { ref } from 'vue'
import http from '@/lib/http'

export interface TemplateOption {
  label: string
  value: string
  compat?: string
}

/**
 * 订阅表单共用（Create/Detail，设计 §13.5）：sing-box 版本目录 +
 * 按「订阅绑定版本」过滤的 overall-client 模板选项（服务端过滤经
 * ?singbox_version= 覆盖本机版本注入）。
 */
export function useSubscriptionTemplateOptions() {
  const versions = ref<string[]>([])
  const clientTemplateOptions = ref<TemplateOption[]>([])

  async function loadVersions(): Promise<void> {
    try {
      const res = await http.get('/core/cloud/singbox-versions')
      versions.value = res.data.versions ?? []
    } catch { /* silent — dropdown falls back to manual input */ }
  }

  async function loadClientTemplates(version?: string | null): Promise<void> {
    try {
      const params: Record<string, string> = { role: 'client' }
      if (version) params.singbox_version = version
      const res = await http.get('/core/cloud/templates', { params })
      clientTemplateOptions.value = (res.data.templates ?? []).map(
        (t: { name: string; id: string; singbox_compat?: string }) => ({
          label: t.singbox_compat ? `${t.name} · sing-box ${t.singbox_compat}` : t.name,
          value: t.id,
          compat: t.singbox_compat,
        }),
      )
    } catch { /* silent */ }
  }

  return { versions, clientTemplateOptions, loadVersions, loadClientTemplates }
}
