---
project: "SingChorus"
type: adr
id: ADR-global-003
description: "sing-box 模板渲染与 semver 兼容性判定只存在于 cloud（判定逻辑单点），节点部署失败显式报错、不做本地模板回退，杜绝两端判定漂移。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "渲染与 semver 兼容判定云端单点，部署无本地回退"
date: 2026-09-17
code_refs:
  - packages/cloud/src/engine/compat.ts:5-7
  - packages/core/src/core.ts:421-427
  - packages/core/src/services/docker-manager.ts:69-72
---

# ADR-003: 渲染与兼容判定云端单点，无本地回退

## 状态

accepted

## 1. 背景

**业务背景**：sing-box 各版本模板语法/协议支持差异大，同一份模板在不同版本节点上可能生成不可用配置。
**技术背景**：core（节点侧）与 cloud（云端）都能触达模板数据；若两端各自实现版本判定，升级节奏不同必然漂移。
**核心问题**：部署时云端渲染失败，是回退到本地旧模板继续部署，还是显式失败？

**约束条件**：

- 判定结果直接决定生成的 sing-box 配置可用性
- 本地存储的模板可能是过期缓存

## 2. 决策驱动因素

1. **判定一致性**（高）：「semver 匹配逻辑只存在于 cloud……杜绝两端漂移」（`engine/compat.ts:5-7` 设计原则注释）。
2. **错误配置代价**（高）：部署一个用错版本模板渲染的节点 = 线上代理故障。
3. **可用性**（中）：云端不可用时部署不可用，是可接受的降级（部署是低频管理操作）。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|本地模板回退|云端宕机仍可部署|判定逻辑双份；旧模板×新版本=坏配置|静默部署错误配置|
|Option B|云端单点 fail loudly（采纳）|判定单一真值；错误显式|云端不可用即无法部署|部署强依赖云可达|
|Option C|本地全量镜像渲染引擎|无云依赖|引擎双份维护、版本同步负担|判定漂移|

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：部署是低频管理操作，可用性损失可接受（驱动因素 3）；而错误配置的代价不可逆（因素 2）。注释原文「No local fallback: if the cloud can't render, deploy fails loudly」（`core.ts:421-427`）。

### 4.1 实施要点

- docker-manager 部署前置步骤强制走云端渲染（`docker-manager.ts:69-72`）
- 失败路径抛结构化错误进 panel UI（principles_003）
- 版本兼容闭包由 ADR-007 的强绑定校验加固

## 备注

- 同型决策：Tag 创建后不可变（commit f91b98f → `packages/core/src/errors.ts:14` ERRORS.CFG_TAG_IMMUTABLE），同为「防漂移优先于灵活」取向。
