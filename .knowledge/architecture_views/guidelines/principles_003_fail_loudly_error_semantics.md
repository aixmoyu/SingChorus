---
project: "SingChorus"
type: development-principle
id: principle-global-003
principle_scope: 项目级
description: "失败必须显式化：云端不可达不得伪装成「空数据」，错误语义即跨模块契约（如 503 DB_UNAVAILABLE 触发 core 退避），观测失败与业务状态分离，部署渲染失败宁可 fail loudly 也不静默回退。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 可靠性-错误处理
---

# 失败显式化与错误语义即契约

## 原则详细描述

跨 core 与 cloud 反复出现同一规则：

- `getClients` 拉取失败时中止本轮同步，而不是当成「云端为空」继续删除对账（`packages/core/src/core.ts:201-207`）；每配置失败单独上报 UI（`packages/core/src/services/sync-service.ts:27-29`）。
- cloud 在 D1 不可用时显式返回 503 `DB_UNAVAILABLE`（`packages/cloud/src/index.ts:45-56`，CLOUD-A2），core 据此结构化错误退避重试（`packages/core/src/services/cloud-client.ts:34`）。
- 部署时云端模板渲染失败直接失败，无本地回退（`packages/core/src/core.ts:421-427`：「No local fallback: if the cloud can't render, deploy fails loudly」）。
- 观测失败与业务状态分离：docker 守护进程不可用报 `unavailable` 而非误报 `stopped`（`packages/core/src/services/docker-manager.ts:344-370`）。

## 为什么要这样

- 「失败当空」会触发删除对账清空数据，是最危险的静默数据丢失路径。
- 结构化错误码让调用方（core/前端）可以按语义重试或提示，而不是解析字符串。
- 本地回退会掩盖云端渲染引擎的 semver 判定单点（ADR-003），产生配置漂移。

## 适用范围

- 项目级：core 的同步/部署链路、cloud 的错误响应、panel 的错误透出。

## 规则

- 拉取/读取失败禁止映射为空集合继续业务流。
- 跨模块错误必须用稳定错误码（ERRORS 常量，如 `packages/core/src/errors.ts`）而非自由文本。
- 不可观测 ≠ 不健康：探活失败与业务失败使用不同状态值。

## 反模式 / 禁止项

- `catch` 后返回 `[]`/`{}` 继续流程。
- 新增本地模板渲染回退路径。
- 把基础设施故障（DB 不可用）返回 200 + 空体。

## 修改检查清单

- [ ] 新错误路径是否有稳定错误码并被消费方识别？
- [ ] 同步链路的失败是否会误触发删除对账？
- [ ] 状态语义是否区分 unavailable / stopped / failed？
