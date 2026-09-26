---
project: "SingChorus"
type: development-principle
id: principle-global-005
principle_scope: 模块级（core）
description: "panel-server 与 ctl 双进程共享 ~/.singchorus 时，跨进程写互斥一律采用「O_EXCL 独占创建锁文件 + mtime 陈旧回收 + Atomics.wait 同步轮询」，锁内写入身份/指纹，所有 store 写操作经 store.locked() 串行。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 并发-跨进程互斥
---

# 跨进程共享状态独占互斥

## 原则详细描述

core 的文件锁实现：以 `O_EXCL` 创建锁文件保证原子抢占（`packages/core/src/services/lock.ts:37-57`），持有者写入身份/指纹防双进程分叉（`packages/core/src/services/store.ts:314-322`），崩溃残留锁用 mtime 陈旧阈值（10s）回收，等待方以 `Atomics.wait` 同步轮询（20ms 间隔、5s 超时）（`lock.ts:4-17,68-86`）。所有 store 写操作统一经 `store.locked()` 入口串行（`store.ts:172-187`）。已知实现缺口（部署锁作用域、sleepSync 阻塞）登记于 [../risk.md](../risk.md) RISK-STAB-001/002。

## 为什么要这样

- 无 MQ、无守护进程的自托管形态下，文件锁是唯一可用的跨进程原语。
- 锁内写身份使陈旧回收不会误删活跃持有者的锁，也为排障提供归属证据。
- 统一 locked() 入口避免「某处忘了加锁」这类并发缺陷。

## 适用范围

- 模块级：`packages/core/` 提供锁原语；panel 与 ctl 是消费方。所有新增的共享目录写操作必须复用该原语。

## 规则

- 共享数据的一切写操作必须经 locked() 或显式 acquire/release 配对。
- 锁文件必须写持有者身份；回收逻辑必须带 mtime 阈值。
- 等待必须有超时上限并转化为显式错误（见 principles_003）。

## 反模式 / 禁止项

- 直接读写共享文件而绕过锁。
- 无条件 unlink 锁文件（可能删除他人锁——RISK-STAB-001 教训）。
- 无超时的无限等待。

## 修改检查清单

- [ ] 新写路径是否走 locked()？
- [ ] 锁作用域是否完整覆盖临界区（对照 RISK-STAB-001）？
- [ ] 崩溃残留锁能否在阈值内被回收？
