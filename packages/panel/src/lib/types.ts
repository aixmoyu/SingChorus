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

export interface ValidateResult {
  valid: boolean
  errors?: string[]
  warnings?: string[]
}

export interface Subscription {
  id: string
  name: string
  path: string
  overallTemplateId: string | null
  overallParams: string
  token: string
  active: boolean
  createdAt: string
  updatedAt: string
}