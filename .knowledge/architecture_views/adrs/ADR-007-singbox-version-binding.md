---
project: "SingChorus"
type: adr
id: ADR-global-007
description: "sing-box 版本兼容采用强绑定闭环：模板声明兼容版本 → 订阅必填 singbox_version → 交付端强制校验 → 创建/更新预校验 → 部署 meta 落盘 drift 提示，四处联动防失效配置下发。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "sing-box 版本强绑定闭环（模板×订阅×交付×部署）"
date: 2026-09-22
code_refs:
  - packages/cloud/src/routes/subscriptions.ts:244-286
  - packages/cloud/src/routes/subscriptions.ts:341-364
  - packages/core/src/services/docker-manager.ts:287-292
---

# ADR-007: sing-box 版本强绑定闭环

## 状态

accepted（四个连续提交：8fba08a / e28b164 / ea0a861，2026-09-22；42063a9 修复旧库缺列，2026-09-24）

## 1. 背景

**业务背景**：sing-box 版本迭代快，模板语法与协议支持随版本变化；订阅客户端使用的 sing-box 版本若与模板不匹配，生成的配置直接不可用。
**技术背景**：semver 兼容判定已收敛在 cloud 引擎单点（ADR-003，`engine/compat.ts`），但判定结果此前未强制贯穿订阅与交付链路。
**核心问题**：模板兼容性信息在「模板定义—订阅选择—交付渲染—节点部署」四个环节如何强制传递，才能保证客户端拿到的配置必然与其 sing-box 版本兼容？

**约束条件**：

- 交付端无法控制客户端实际运行的 sing-box 版本，只能在订阅元数据层约束
- 兼容版本清单随 sing-box 发版演进（42063a9 即移除 1.15.0 选项）

## 2. 决策驱动因素

1. **失效配置零下发**（高）：交付不兼容配置 = 客户端代理直接故障。
2. **错误前移**（高）：不兼容组合应在创建/更新订阅时被拒绝，而非等到客户端拉取失败。
3. **可排障**（中）：部署 meta 落盘版本指纹，节点侧 drift 可追溯。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|弱提示：UI 警告不拦截|实现成本低|警告被忽略，坏配置照发|线上故障|
|Option B|强绑定闭环（采纳）|四环节强制；错误前移|功能耦合度高；清单维护成本|过严阻断合法组合|

### Option A：弱提示

仅模板处标注兼容版本，交付端不校验。放弃——驱动因素 1 无法满足。

### Option B：强绑定闭环（采纳）

- 模板声明 singbox_compat，compat 引擎据此过滤（`subscriptions.ts:244-286`）
- 订阅必填 singbox_version，创建/更新时预校验（`subscriptions.ts:341-364`）
- 交付端强制校验版本匹配后才渲染（e28b164）
- 部署成功 meta 落盘版本指纹，不匹配时给 drift 提示（`docker-manager.ts:287-292`）

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：驱动因素 1、2 只有强制闭环能满足；「过严」风险由 compat 引擎的版本清单可维护性对冲（单点可更新，42063a9 证明闭环可运维）。

### 4.1 实施要点

- 版本清单变更需同步 migrations（旧库缺列问题 → [../risk.md](../risk.md) RISK-DATA-002）
- 预校验失败返回结构化错误（principles_003）

## 备注

- 与 ADR-003 构成同一设计取向：兼容判定单点 + 全链路强制传递。
