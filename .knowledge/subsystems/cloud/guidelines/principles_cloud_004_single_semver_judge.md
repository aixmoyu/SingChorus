---
project: SingChorus
type: development-principle
id: principle-cloud-004
description: sing-box 版本兼容的 semver 判定逻辑全仓库只存在于 cloud 的 engine/compat.ts——panel 只消费 cloud 的过滤结果；判定分为四道防线，写路径拦截非法声明、读路径对脏数据放行。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 兼容判定单点 + 四道防线

## 原则详细描述

版本绑定闭环（全局 ADR-007 的模块级细化）由四个层次组成，全部以 compat.ts 的 `isCompatSatisfied` 为唯一判定实现：

1. **列表服务端过滤**：`/api/protocols`、`/api/templates` 接受 `?singbox_version=`，服务端滤掉不兼容项并返回 `filtered_count`（protocols.ts:33-36、templates.ts:65-68）——Deploy 页下拉天然只剩兼容项。
2. **写路径预校验**：订阅 create/update 时以「更新后的最终值」校验模板存在性 + compat（validateOverallCompat，subscriptions.ts:341-364,420-422,463-470，设计 §13.7）——不让管理员创建注定交付 400 的订阅。
3. **交付端强制校验**：订阅绑定版本为唯一事实来源（`?version=` 已废弃，subscriptions.ts:152-155），overall 模板不匹配 400、协议不兼容实例排除并经 `X-Sbx-Skipped-Instances` 头披露、全部排除才 400（subscriptions.ts:244-291,321-326）。
4. **渲染冲突清单**：`/api/render`、`/api/render/deploy` 一次性列出全部冲突模板返回 400（render.ts:33-59,141-152），版本不在 docker 模板 enum 报 `SBX_VERSION_NOT_OFFERED`（render.ts:154-173）。

## 为什么要这样

- 判定逻辑若在 panel/cloud 两端各写一份必然漂移；「panel/panel-server 只消费 cloud 的过滤结果，杜绝两端漂移」是设计原则 4 的原文（compat.ts:3-7 注释）。
- 脏数据放行是显式语义：写路径已用 `SBX_BAD_RANGE` 拦截非法范围（protocols.ts:52-54），读路径再遇到非法 range 属于历史脏数据，过滤会造成静默丢配置，放行（不过滤）更安全（compat.ts:35 注释）。
- `NULL/''/'*' = 兼容任意版本` 同样是显式声明而非隐式失败（compat.ts:29-33）。
- 单坏配置不挂整个订阅：实例级排除而非报错，交付端是最终防线（subscriptions.ts:269-271 注释）。

## 适用范围

- 所有涉及 singbox_compat/singbox_version 的读写路径；panel 的版本选择 UI 数据源。

## 规则

- 新增 compat 消费点必须调用 compat.ts 函数，禁止本地重写 satisfies 逻辑。
- 版本字符串必须过 `isValidSingboxVersion`（docker-tag 安全形状，拒绝 `+build`，compat.ts:14-21）。
- 交付端只认订阅绑定版本字段；请求传参版本一律废弃。

## 反模式 / 禁止项

- 在 panel/panel-server 复制 semver 判定。
- 交付端对不兼容实例直接 500/400（单实例级）。
- 用 truthy 判断对待 compat 空值（`''` 与 `'*'` 与 NULL 等价是规定语义）。

## 修改检查清单

- [ ] 判定是否仍单点于 engine/compat.ts？
- [ ] 四道防线中受影响的层次是否联动更新？
- [ ] 版本格式校验（SINGBOX_VERSION_RE）是否应用于新入口？
