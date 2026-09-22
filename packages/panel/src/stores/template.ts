import { defineStore } from 'pinia'
import { ref } from 'vue'
import http from '@/lib/http'
import type { TemplateInfo, TemplateSchema, GenerateResponse } from '@/lib/types'

/** Best-effort coercion of an unknown `params` value into the typed shape. */
function tryParseParams(v: unknown): TemplateSchema['params'] {
  if (Array.isArray(v)) return v as TemplateSchema['params']
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v)
      if (Array.isArray(p)) return p as TemplateSchema['params']
    } catch {
      /* ignore — caller will fall back to [] */
    }
  }
  return []
}

/** Cloud `category` (unified templates table) → panel `role`. */
const CATEGORY_TO_ROLE: Record<string, TemplateInfo['role']> = {
  protocol: 'protocol',
  server: 'server',
  client: 'client',
  docker: 'docker',
  'overall-server': 'server',
  'overall-client': 'client',
  'overall-docker': 'docker',
}

/**
 * Normalise a raw template object from the cloud API into the typed shape.
 *
 * The cloud service returns `serverTemplate` / `clientTemplate` in camelCase
 * (mirroring the TS source) but the panel expects snake_case keys. We accept
 * both so that a backend rename doesn't silently break the UI.
 *
 * DEP-PANEL-002: exported so tests can lock this dual-naming compatibility
 * matrix (cloud contract drift protection).
 */
export function normalizeTemplate(t: Record<string, unknown>): TemplateInfo {
  const rawSchema = (t.schema as Record<string, unknown>) || {}
  const category = String(t.category ?? t.role ?? '')
  const compat = (t.singbox_compat ?? t.singboxCompat) as string | undefined
  return {
    id: String(t.id ?? ''),
    type: (t.type as string) || (t.id as string) || '',
    name: t.name as string,
    version: t.version as string,
    role: CATEGORY_TO_ROLE[category] ?? 'protocol',
    singbox_compat: compat || undefined,
    schema: {
      params: tryParseParams(t.params) || tryParseParams(rawSchema.params) || [],
      server_template:
        (rawSchema.server_template as Record<string, unknown>) ||
        (rawSchema.serverTemplate as Record<string, unknown>) ||
        {},
      client_template:
        (rawSchema.client_template as Record<string, unknown>) ||
        (rawSchema.clientTemplate as Record<string, unknown>) ||
        {},
    },
    created_at: t.created_at as string,
    updated_at: t.updated_at as string,
  }
}

/** DEP-PANEL-002: exported for the compatibility-matrix unit test. */
export function normalizeGenerateResponse(data: Record<string, unknown>): GenerateResponse {
  return {
    server_config:
      (data.serverConfig as Record<string, unknown>) ||
      (data.server_config as Record<string, unknown>) ||
      {},
    client_config:
      (data.clientConfig as Record<string, unknown>) ||
      (data.client_config as Record<string, unknown>) ||
      {},
  }
}

/**
 * Store for protocol/client templates and config generation.
 * Owns the `templates` list and the `generateFromTemplate` action.
 */
export const useTemplateStore = defineStore('template', () => {
  const templates = ref<TemplateInfo[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** 被节点 sing-box 版本过滤隐藏的模板数（0 或未启用版本时无意义）。 */
  const filteredCount = ref(0)

  async function fetchTemplates(role?: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await http.get('/core/cloud/templates', { params: role ? { role } : {} })
      const raw = res.data.templates || []
      templates.value = raw.map(normalizeTemplate)
      filteredCount.value = Number(res.data.filtered_count ?? 0)
    } catch (e) {
      const msg =
        (e as { response?: { data?: { message?: string } }; message?: string }).response?.data
          ?.message ||
        (e as { message?: string }).message ||
        'Failed to fetch templates'
      console.error('fetchTemplates error:', msg)
      error.value = msg
    } finally {
      loading.value = false
    }
  }

  async function generateFromTemplate(
    type: string,
    params: Record<string, unknown>,
  ): Promise<GenerateResponse> {
    const res = await http.post('/core/cloud/generate', { type, params })
    return normalizeGenerateResponse(res.data)
  }

  return { templates, loading, error, filteredCount, fetchTemplates, generateFromTemplate }
})
