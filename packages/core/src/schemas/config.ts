export interface ProtocolParam {
  name: string
  type: 'string' | 'number' | 'boolean' | 'select'
  required?: boolean
  default?: string | number | boolean
  description?: string
  enum?: string[]
  placeholder?: string
  generator?: string
}

export interface TemplateSchema {
  params: ProtocolParam[]
  server_template: Record<string, unknown>
  client_template: Record<string, unknown>
}

export interface GenerateResponse {
  server_config: Record<string, unknown>
  client_config: Record<string, unknown>
}

export type SyncStatus = 'pending_upload' | 'pending_update' | 'synced' | 'unknown';

export interface ConfigEntry {
  name: string
  node: string
  type: string
  enabled: boolean
  /** 是否包含在最近一次成功的部署中；未部署的配置不会出现在用户订阅里。 */
  deployed?: boolean
  synced: boolean
  content_hash: string
  server_config: Record<string, unknown>
  client_config: Record<string, unknown>
  params: Record<string, unknown>
  created_at: string
  updated_at: string
  /** 配置所属节点的指纹；缺省视为本机创建（向后兼容旧数据）。 */
  node_fingerprint?: string
  /**
   * 生成/重生成时的本机 sing-box 版本 pin 快照（'' = 未设置）。节点切换
   * 版本后与当前 pin 不一致的配置在 UI 标记 drift（内容是旧版本语法，
   * Redeploy 前应重新生成）——设计 §13.4。仅本地元数据，不上报 cloud。
   */
  singbox_version?: string
}

export interface Subscription {
  id: string
  name: string
  path: string
  /** 订阅绑定的 sing-box 版本（cloud 端必填）：交付端 compat 校验依据（设计 §13.1）。 */
  singboxVersion: string
  overallTemplateId: string | null
  overallParams: string
  token: string
  active: boolean
  createdAt: string
  updatedAt: string
}

export interface AppConfig {
  cloud_url: string
  cloud_token: string
  /** Deploy artifacts directory (compose, entry.sh, config.json, tls/). */
  docker_dir?: string
  singbox_image: string
  /** 本机 sing-box 版本 pin；'' = 未设置（跟随 docker 模板默认 / 原镜像）。 */
  singbox_version: string
  validate_timeout_seconds: number
  prepull_singbox_image: boolean
  node_name: string
  node_address: string
}

/** 本机节点身份：指纹持久化在 data 目录，名称/地址来自 AppConfig。 */
export interface NodeIdentity {
  fingerprint: string
  name: string
  address: string
}
