---
project: SingChorus
type: development-principle
id: principle-core-003
description: 跨进程共享资源一律过 O_EXCL 文件锁；数据目录写用「等待至超时」语义，部署操作用「fail-fast 映射 409」语义，两种调用方语义显式分离。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 跨进程互斥的语义分层

## 原则详细描述

panel 与 ctl 是共享 `~/.singchorus` 的两个独立进程，写竞争会产生 last-writer-wins 与工件交错（lock.ts:3-12 注释）。锁原语：`openSync(path,'wx')` 独占创建裁决唯一赢家 + mtime>10s 陈旧回收 + 20ms 轮询至 5s 超时（lock.ts:15-17,37-57,68-80）。两种语义：store 侧 `locked()` 等待到底、超时转译 busy 错误（store.ts:177-187）；docker 侧 `timeoutMs:0` 单次抢锁、LockTimeoutError 映射 `DeployInProgressError` 409（docker-manager.ts:117-130），与进程内 opQueue 的 409 同语义（:19-25,105-109）。

## 为什么要这样

同步 fs API（store）没有 async 锁可用，只能同步轮询；等待语义让短临界区自然排队。部署是秒-分钟级重操作，等待无意义，快速明确拒绝（409）优于静默排队（ADR-008）。陈旧回收保证持锁者崩溃不永久卡死。

## 适用范围

- 一切跨进程共享资源：数据目录（data/.lock）、部署目录（docker/.deploy.lock）。

## 规则

- 共享资源写临界区必须持锁；锁文件写 PID 供诊断（lock.ts:40）。
- 新调用方先声明语义：等待（store 型）还是 fail-fast（docker 型）。
- 进程内并发另用 opQueue 串行（docker-manager.ts:99-109）；文件锁管跨进程，两层职责不混。

## 反模式 / 禁止项

- 用「检查存在再创建」替代 'wx' 独占创建（非原子）。
- 删除锁文件前不校验归属（现状 P0 缺口见 risk.md RISK-CORE-001：withFileLockSync 内部 finally 先释放、外层再无条件 unlink，docker-manager.ts:121,127-129,383-387——修复时以「持锁执行 op」形态重构，本原则不允许新增同型代码）。
- 锁内执行长事务（部署整链）而不评估陈旧回收阈值。

## 修改检查清单

- [ ] 锁的获取与释放严格配对（获取成功至释放之间锁一直被持有）
- [ ] 超时语义与调用方契约匹配（等待 / 409）
- [ ] 评估 sleepSync 阻塞事件循环时长（PERF-CORE-001）
