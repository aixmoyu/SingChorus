---
project: SingChorus
type: development-principle
id: principle-panel-001  # scope=module (panel)
description: panel 服务端对 @chorus/core 的访问必须经 core-provider 单例提供者收敛：配置快照不变即复用实例，配置变更即重建并重绑同步服务，禁止在路由文件内自行实例化 ChorusCore 或自派生云端 URL。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 核心实例单例提供者与快照失效

## 原则详细描述

panel 所有需要 ChorusCore 的代码一律通过 `getCore()` 获取；提供者内部以「配置快照」（cloudUrl/cloudToken/singboxVersion/singboxImage 四元组）为缓存键，快照未变复用单例，任一变化即销毁重建并重绑 SyncService。云端 URL 的解析（含默认回退与空值语义）也只存在于提供者一处（`resolveCloudUrl`）。这是对历史的修复：此前 routes/core.ts、routes/info.ts、routes/settings.ts 各自实例化 ChorusCore 并以硬编码 `CLOUD_WORKER_URL` 兜底，配置变更后各文件失效时机不一，产生行为漂移。

## 为什么要这样

- **一致性**：core 实例携带云端连接与版本 pin；多处实例化意味着同一进程内可能同时存在指向不同云端的实例，同步结果不可预测。
- **失效时机可控**：快照比对 + 显式 `invalidateCore()` 把「配置变更 → 实例重建」收敛为单一语义，设置保存与初始化提交都只调这一个开关。
- **可观测性统一**：core 日志经 `logger.child({ component: 'core' })` 并入 pino、请求 ID 注入，只在提供者装配一次（core-provider.ts:92-96）。

## 适用范围

- packages/panel/server/ 全部路由与未来新增服务端模块。
- 不适用于 @chorus/core 内部（它不知道 panel 的存在）与 ctl（独立进程，自管实例）。

## 规则

- 路由文件禁止 `new ChorusCore(...)`；取实例只用 `getCore()`（packages/panel/server/core-provider.ts:74-103）。
- 云端 URL 判定只用 `resolveCloudUrl()`；空字符串是唯一「未设置」标记，legacy sentinel 已在读时迁移（core-provider.ts:27-33；config.ts:92-98）。
- 修改连接类设置后必须 `invalidateCore()`（settings.ts:50,63；init.ts:100）。
- singbox 版本/镜像快照必须读自 core store（与 ctl 共享单一事实源），不得复制进 panel config（core-provider.ts:43-50）。
- 变更本地状态后经 `triggerSync()` 触发同步，未配置 cloud_token 时静默跳过（core-provider.ts:131-135）。

## 反模式 / 禁止项

- 在路由内 `loadConfig()` 后自行拼云端 URL 或默认端口。
- 绕过提供者长期持有 ChorusCore 引用（跨越配置变更后即为陈旧实例）。
- 为「省一次重建」在快照比对中忽略某字段（如版本 pin）——校验器镜像会与版本失配。
- 深读 `core.store` 内部结构（core-D1 债务仅剩 core-provider.ts:50 一处，不得新增）。

## 修改检查清单

- [ ] 新路由是否经 getCore() 而非自行实例化？
- [ ] 是否需要在变更后 triggerSync / invalidateCore？
- [ ] 快照四元组是否需要因新配置项而扩展？
- [ ] core 日志是否仍并入 pino（component: core）且带请求 ID？
