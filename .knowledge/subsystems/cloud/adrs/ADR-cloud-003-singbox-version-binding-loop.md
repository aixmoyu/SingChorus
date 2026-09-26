---
project: SingChorus
type: adr
id: ADR-cloud-003
description: sing-box 版本兼容闭环——订阅创建即绑定必填版本，semver 判定逻辑全仓库单点存于 cloud，交付端强制校验为最终防线，写路径预校验前置拦截注定失败的组合。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "ADR-cloud-003: sing-box 版本绑定闭环与判定单点"
date: 2026-09-24
code_refs:
  - packages/cloud/src/engine/compat.ts
  - packages/cloud/src/routes/subscriptions.ts
  - packages/cloud/src/routes/render.ts
  - packages/cloud/src/routes/protocols.ts
  - packages/cloud/src/routes/templates.ts
  - packages/cloud/src/db/schema.ts
---

# ADR-cloud-003: sing-box 版本绑定闭环与判定单点

## 状态

accepted（细化全局 ADR-007；相关提交 e28b164、ea0a861、42063a9）

## 1. 背景

**业务背景**：sing-box 迭代快，协议/整体模板各有兼容窗口；订阅消费端运行固定版本，模板随意组合会生成起不来的配置。
**技术背景**：panel 与 cloud 两端都可能做版本过滤；早期交付端点接受 `?version=` 传参，消费端可绕过绑定。
**核心问题**：版本兼容的判定与执行应放在哪一层，如何保证订阅创建、模板编辑、交付三条时间线上组合始终有效？

**约束条件**：

- 版本字符串需可进 docker 镜像 tag（拒绝 `+build`）
- 旧行为兼容：compat 为 NULL 等价任意版本
- 单个坏协议不能挂掉整个订阅

## 2. 决策驱动因素

1. **防漂移**（高）：两端各自实现 semver 判定必然漂移。
2. **提前失败**（高）：管理员不应能保存注定交付 400/500 的订阅。
3. **终端韧性**（中）：交付端是最后防线，须容单点坏配置。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|panel/cloud 各自过滤（客户端判定）|实现分散无协调|双实现漂移；旧 panel 绕过|配置损坏直达终端|
|Option B|交付端单一强制校验|单点执行|创建失败反馈滞后到交付时|管理员发现问题时已上线|
|Option C|绑定版本 + 判定单点(cloud) + 四道防线|提前失败+最终防线+判定唯一|实现面较宽|维护四层一致性成本|

### Option C：绑定闭环（已实施，e28b164→ea0a861 逐步闭环）

- 数据层：subscriptions.singbox_version NOT NULL（schema.ts:118-127）；存量库 ALTER 补列（42063a9）。
- 判定层：compat.ts 唯一实现；「panel/panel-server 只消费 cloud 的过滤结果，杜绝两端漂移」（compat.ts:3-7）。
- 防线 1 列表过滤（protocols.ts:33-36、templates.ts:65-68）；防线 2 预校验 validateOverallCompat（subscriptions.ts:341-364，设计 §13.7）；防线 3 交付强制+实例排除（subscriptions.ts:244-291，§13.1/§13.2）；防线 4 render 冲突清单+enum 目录检查（render.ts:33-59,130-173）。
- 版本目录：GET /api/singbox-versions 聚合 docker 模板 enum（templates.ts:71-105，§13.3）。

## 4. 决策结果

**选择方案**：**Option C**
**选择理由**：驱动因素逐条满足——判定单点防漂移；预校验提前失败；交付端排除策略保证单坏配置不挂订阅（「排除而非报错」，subscriptions.ts:269-271）；`?version=` 传参废弃、绑定即事实来源（subscriptions.ts:152-155）。

### 4.1 实施要点

- 交付缓存随版本/模板/参数/token 变更失效（修复 v1「不同 version 共享缓存行」隐性 bug，subscriptions.ts:508-510）。
- 被排除实例数经 `X-Sbx-Skipped-Instances` 头与日志披露，不污染配置 body（subscriptions.ts:287-291,321-326）。
- 版本格式校验 `SINGBOX_VERSION_RE` 兼做镜像 tag 注入面收窄（compat.ts:14-21）。

## 备注

- 读路径脏 range 放行（不过滤）是显式语义：写路径已拦截非法声明，读到的脏数据过滤反而静默丢配置（compat.ts:35）。
- 相关原则：principles_cloud_004。
