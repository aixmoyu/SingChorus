---
project: "SingChorus"
type: development-principle
id: principle-global-008
principle_scope: 项目级
description: "跨模块超时/预算是显式契约：REQUEST_BUDGET_MS=25s 被 panel 前端 axios 30s 锚定（30s > 25s），修改任一处必须同步三处锚点；后端总预算必须小于前端超时。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 可靠性-超时契约
---

# 跨模块超时与预算常量锚定

## 原则详细描述

core 出站 HTTP 单次 10s、总预算 25s（`REQUEST_BUDGET_MS`，`packages/core/src/services/cloud-client.ts:48-59`），该值被 panel 前端 axios 30s 超时锚定，代码注释标明三处锚点需同改（`packages/panel/src/lib/http.ts:18-21`）。前端超时必须大于后端重试总预算，让云不可达呈现结构化错误（DB_UNAVAILABLE 等）而非 axios 超时。相关决策痕迹 core-D2；部署链路的 60s/30s 预算与前端 30s 的冲突作为风险登记（[../risk.md](../risk.md) RISK-STAB-004）。

## 为什么要这样

- 后端预算 > 前端超时时，用户先看到无意义的 ECONNABORTED，服务端却仍在执行，诱发重复提交。
- 预算常量分散在三处（core、panel 前端、部署链路），没有锚定注释就会被单独修改而静默破坏契约。
- 结构化超时错误是排障关键信号：知道是「云端慢」而非「前端网络抖」。

## 适用范围

- 项目级：core↔cloud 出站调用、panel 前端↔panel BFF、任何新增长耗时链路。

## 规则

- 新增长耗时链路必须声明「后端总预算 N s < 前端超时 M s」并在两端注释互指锚点。
- 超时必须转化为项目稳定错误码，不得裸抛 axios 异常给 UI。
- 重试退避总和（[1,4,16,64]s 等）必须计入总预算。

## 反模式 / 禁止项

- 只改一端超时不检查另一端。
- 前端超时 ≤ 后端预算。
- 用无限重试掩盖预算耗尽。

## 修改检查清单

- [ ] 是否 grep 了所有锚点注释（REQUEST_BUDGET_MS）？
- [ ] 重试退避总和是否仍在预算内？
- [ ] 超时路径是否产出结构化错误？
