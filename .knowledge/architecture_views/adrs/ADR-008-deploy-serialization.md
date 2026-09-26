---
project: "SingChorus"
type: adr
id: ADR-global-008
description: "部署操作在 panel 进程内以 opQueue 串行化：同一时间仅一个部署任务，并发请求返回 409 DeployInProgressError，子进程 60s 超时兜底。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "部署操作进程内串行化（opQueue + 409）"
date: 2026-09-17
code_refs:
  - packages/core/src/services/docker-manager.ts:10
  - packages/core/src/services/docker-manager.ts:19-25
  - packages/core/src/services/docker-manager.ts:78-79
---

# ADR-008: 部署操作进程内串行化

## 状态

accepted

## 1. 背景

**业务背景**：部署 = 云端渲染 + 生成制品 + docker 容器替换 + 健康检查，秒级到分钟级的重操作；用户可能因前端超时（30s）而重复点击触发并发部署。
**技术背景**：同一节点的容器替换不具备并发安全性（半替换状态）；跨进程部署锁存在实现缺口（RISK-STAB-001）。
**核心问题**：并发的部署请求如何处理——排队、拒绝，还是放任并发？

**约束条件**：

- 单管理员使用场景（panel 设计假设），吞吐要求低
- 前端 axios 30s 超时可能早于部署完成，重复触发是常态而非异常

## 2. 决策驱动因素

1. **节点状态安全**（高）：容器替换必须互斥，半替换不可接受。
2. **请求语义明确**（高）：并发触发必须快速得到明确反馈（409），而非静默排队造成「不知道点了多少次」。
3. **实现简单**（中）：单实例进程内队列即可满足吞吐。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|无锁并发部署|实现最简|半替换竞态、docker 状态损坏|节点故障|
|Option B|opQueue 串行 + 409 拒绝（采纳）|互斥简单可靠；反馈明确|重复点击需用户等待重试|跨进程不互斥（见备注）|
|Option C|持久化任务队列（DB）|可审计、可重启续跑|单管理员场景过度设计|引入新状态机|

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：单实例假设下进程内队列即满足因素 1/2；409 `DeployInProgressError` 与 60s execFile 超时（`docker-manager.ts:10,19-25,78-79`）构成明确契约。Option C 在多实例需求出现前不引入。

### 4.1 实施要点

- 队列为进程内存态，重启即清空（可接受，见 risk RISK-STAB-005）
- 与跨进程文件锁分层：进程内 opQueue 管并发请求，文件锁（principles_005）管 panel/ctl 双进程——后者当前存在缺口（RISK-STAB-001，P0）

## 备注

- 前端 30s 超时与部署总预算冲突：用户可能见 ECONNABORTED 后重试，409 使重试无害化 → [../risk.md](../risk.md) RISK-STAB-004。
