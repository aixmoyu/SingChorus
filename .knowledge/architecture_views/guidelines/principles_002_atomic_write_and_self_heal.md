---
project: "SingChorus"
type: development-principle
id: principle-global-002
principle_scope: 模块级（core）
description: "core 的本地文件持久化一律「同目录临时文件 + rename」原子写；损坏文件改名隔离保留现场而非静默丢弃；多进程缓存以目录 mtime 签名失效。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 可靠性-持久化
---

# 原子写与损坏自愈

## 原则详细描述

LocalStore 写路径采用 temp+rename 原子替换（`packages/core/src/services/store.ts:40-45`），docker-manager 的部署制品同样同目录 temp+rename 并保留 5 份备份（`packages/core/src/services/docker-manager.ts:50-66,8`）。解析失败的 JSON 不删除而是改名隔离、保留现场（`store.ts:70-85`），历史快照可自愈。缓存失效用目录 mtime 签名而非内存标志，跨进程安全（`store.ts:90-105`）。enabled/disabled 双份残留的修复也走「单次 rename 迁移 + repairLegacyDuplicates 兼容旧数据」（`store.ts:154-210`）。

## 为什么要这样

- rename 在同一目录内是原子操作，杜绝进程崩溃/断电留下的半写文件（同时规避 EXDEV 跨设备问题）。
- 隔离而非删除损坏文件，为排障保留现场，且不阻塞服务启动。
- mtime 签名使 ctl / panel 双进程（见 principles_005）无需共享内存即可感知彼此的写入。

## 适用范围

- 模块级：`packages/core/` 内所有本地文件落盘（store、部署制品、锁文件之外的元数据）。

## 规则

- 新增任何文件写必须 temp+rename，禁止直接 truncate+write 目标文件。
- 解析失败的数据文件：改名隔离 + 告警日志 + 回退到快照/空态。
- 制品类文件保留有界备份（如 5 份）。

## 反模式 / 禁止项

- 直接覆盖写 JSON 配置。
- 损坏时 `catch` 后静默删除重建（丢失排障现场）。
- 用内存变量做跨进程缓存失效。

## 修改检查清单

- [ ] 新写路径是否 temp+rename？
- [ ] 损坏分支是否保留现场并可见（日志/UI）？
- [ ] 是否考虑双进程并发（锁语义见 principles_005）？
