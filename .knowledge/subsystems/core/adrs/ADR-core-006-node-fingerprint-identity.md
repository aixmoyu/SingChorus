---
project: "SingChorus"
type: adr
id: ADR-core-006
description: 节点身份采用「首次生成 32-hex 随机指纹 + 数据目录持久化 + CHORUS_FINGERPRINT/显式导入回收 + 锁内生成」；云端归属变更走显式 rebind 接口。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "节点指纹身份：随机生成、环境回收、锁内唯一"
date: 2026-09-24
code_refs:
  - packages/core/src/services/store.ts:57-61,289-346
  - packages/core/src/services/cloud-client.ts:483-503
  - packages/core/src/core.ts:96-104

---

# ADR-core-006: 节点指纹身份管理

## 状态

accepted

## 1. 背景

**业务背景**：云端按指纹命名空间归属各节点配置（core-D1/CLOUD-D1 移除单段端点后，cloud-client.ts:401-406）；节点重装系统后须找回旧身份，否则旧配置成为孤儿。
**技术背景**：panel 与 ctl 双进程共享数据目录，可能同时首次生成指纹；指纹要经 URL 与文件名往返。
**核心问题**：指纹如何生成、如何防双进程分歧、重装后如何回收？

**约束条件**：

- 双进程并发首启不得生成两个不同指纹
- 指纹须能安全用于 URL 路径段与云端键
- 回收入口有两个时机：env 预置与命令显式导入

## 2. 决策驱动因素

1. **身份稳定**（高）：指纹终身不变、跨进程一致。
2. **重装可恢复**（高）：旧云端配置能找回。
3. **安全键入**（中）：可作路径/URL 键。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|机器硬件特征派生（mac/hostname）|天然稳定|虚拟化/容器下不稳；泄露硬件信息|碰撞与隐私|
|Option B|首次随机生成 32-hex 持久化 + env/导入回收 + 锁内生成（采纳）|无硬件依赖；格式自控；双进程安全|数据目录丢失即失联（由回收机制兜底）|误配 env 致两机同指纹（见 CONS-CORE-005）|
|Option C|人工指定每机指纹|可运维|易错、易重|人为碰撞|

### Option B 详述

`getFingerprint()`：env `CHORUS_FINGERPRINT` 合法（`^[A-Za-z0-9_-]{8,128}$`，store.ts:59-61）即回收并锁内覆写持久化（:298-311）；否则读存量；无则**锁内**二次检查后生成 `randomBytes(16).hex` 原子写并 chmod 0600（:312-323）。`importFingerprint` 显式导入（重装找回），非法格式抛 `INVALID_FINGERPRINT` 422（:330-346）。身份三元组 `NodeIdentity` 由指纹 + AppConfig 名称/地址组成（core.ts:96-104）。云端侧归属迁移由显式 `rebindNode(from,to)` 完成，返回迁移配置数（cloud-client.ts:483-503）。

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：身份稳定（因素 1）靠持久化+锁内生成双保险；重装恢复（因素 2）有 env 与导入两条回收路径直通云端旧身份；安全键入（因素 3）由字符集白名单保证。Option A 在容器化部署下不可靠，Option C 把碰撞风险交给人。

### 4.1 实施要点

- 生成/覆写必须在 `withFileLockSync` 内（防双进程分歧，store.ts:304-305,314 注释）。
- 文件 0600 权限（:308,320,343）。
- 指纹变更后云端归属需显式 rebind，core 不自动迁移（避免误搬他机配置）。

## 备注

- 误把他人指纹设为 env 会使两机云端身份冲突——列入 risk.md CONS-CORE-005，修复方向为 rebind 前预检占用。
