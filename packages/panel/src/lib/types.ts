import type {
  ProtocolParam as CoreProtocolParam,
  ConfigEntry as CoreConfigEntry,
  SyncStatus,
  GenerateResponse,
} from '@chorus/core'

export type { SyncStatus, GenerateResponse }

export type ProtocolParam = Omit<CoreProtocolParam, 'type' | 'default'> & {
  type: string
  default?: string | number | boolean | null
}

export type ConfigEntry = Omit<CoreConfigEntry, 'content_hash'> & {
  content_hash?: string
  /** 云端拉取的远端配置：所属节点指纹。本机配置为 undefined。 */
  node_fingerprint?: string
}

export interface TemplateSchema {
  params: ProtocolParam[]
  server_template: Record<string, unknown>
  client_template: Record<string, unknown>
}

export interface TemplateInfo {
  id: string
  type: string
  name: string
  version: string
  role: string
  /** 模板声明的 sing-box 兼容范围（如 ">=1.12.0"）；undefined = 兼容任意版本。 */
  singbox_compat?: string
  schema: TemplateSchema
  created_at: string
  updated_at: string
}

export interface CloudStatus {
  status: string
  message?: string
}

export interface DeployStatus {
  status: string
  message?: string
  pid?: number
  started_at?: string
}

// 订阅交付类型：'singbox' = sing-box JSON 配置；'url' = 分享链接列表
// （vless:// hysteria2:// 等，text/plain 交付）。
export type SubscriptionType = 'singbox' | 'url'

export interface Subscription {
  id: string
  name: string
  path: string
  /** 交付类型（见 SubscriptionType）。url 型不绑定 sing-box 版本与 overall 模板。 */
  type: SubscriptionType
  /** singbox 型必填（交付端 compat 校验依据，设计 §13.1）；url 型恒为 ''。 */
  singboxVersion: string
  overallTemplateId: string | null
  overallParams: string
  token: string
  active: boolean
  createdAt: string
  updatedAt: string
}