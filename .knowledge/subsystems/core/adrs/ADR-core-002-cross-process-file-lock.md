---
project: "SingChorus"
type: adr
id: ADR-core-002
description: panel/ctl 双进程共享数据目录与部署目录，采用 O_EXCL 独占创建 + mtime 陈旧回收的文件锁；store 走等待语义，docker 走 fail-fast 409 语义。锁的 async 持有形态存在 P0 缺口（RISK-CORE-001）另册跟踪。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
status: accepted
title: "跨进程互斥选型：O_EXCL 文件锁 + 陈旧回收 + 双语义调用方"
date: 2026-09-24
code_refs:
  - packages/core/src/services/lock.ts:15-86
  - packages/core/src/services/store.ts:177-187
  - packages/core/src/services/docker-manager.ts:117-130

---

# ADR-core-002: 跨进程互斥选型（core-R2/core-R4）

## 状态

accepted（锁原语 accepted；docker 持锁形态的互斥缺口以 RISK-CORE-001 (P0) 跟踪）

## 1. 背景

**业务背景**：panel server 与 ctl 是两个独立进程，共享 `~/.singchorus/data` 与 `~/.singchorus/docker`，可能同时写配置或同时驱动 docker compose。
**技术背景**：store 的持久化 API 是同步 fs；Node 单进程内另有事件循环并发需要进程内队列。
**核心问题**：跨进程互斥用什么机制，等待语义与拒绝语义如何分配？

**约束条件**：

- store API 为同步（调用方遍布门面），锁等待只能同步实现
- 持锁进程可能崩溃，锁不得永久卡死
- 部署操作秒-分钟级，前端 30s 超时会诱发重复触发

## 2. 决策驱动因素

1. **崩溃安全**（高）：持锁者死亡后锁必须可回收。
2. **跨平台原子性**（高）：不依赖平台特定 flock。
3. **语义明确**（中）：竞争失败要可解释（busy / 409）。
4. **零依赖**（中）：不引第三方锁库（与 ADR-core-001 一致）。

## 3. 候选方案

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|无锁，容忍 last-writer-wins|最简单|配置半更新、compose 工件交错|数据损坏|
|Option B|O_EXCL 独占创建 + mtime 陈旧回收 + 同步轮询（采纳）|跨平台原子；崩溃自愈；零依赖|等待阻塞事件循环；async 持锁形态易错|sleepSync 至多 5s 停顿；RISK-CORE-001|
|Option C|proper-lockfile/flock 等第三方|成熟 API|违反零依赖纪律；flock 平台差异|供应链|

### Option B 详述

`openSync(path,'wx')` 仅唯一赢家成功并写入 PID（lock.ts:37-42）；发现 EEXIST 后 stat mtime，超 10s 判陈旧，rename-then-recreate 抢占（:43-54）；等待方 20ms 轮询至默认 5s 超时抛 `LockTimeoutError`（:15-17,68-80）。调用方语义二分：store `locked()` 等待到底转译 busy（store.ts:177-187）；docker `timeoutMs:0` 单次尝试映射 `DeployInProgressError` 409（docker-manager.ts:121-126），与进程内 opQueue 409 同构（ADR-008）。

## 4. 决策结果

**选择方案**：**Option B**
**选择理由**：驱动因素 1（陈旧回收）、2（wx 原子跨平台）、4（零依赖）全部满足；等待/拒绝双语义让两种调用方各得其所。Option A 不可接受，Option C 与零依赖冲突。

### 4.1 实施要点

- 数据目录锁 `data/.lock`、部署锁 `docker/.deploy.lock`（store.ts:17、docker-manager.ts:85-89）。
- 等待上限 5s 封顶事件循环阻塞（PERF-CORE-001 有册跟踪）。
- 已知缺口：`withDeployLock` 以 `withFileLockSync(path,()=>undefined,{timeoutMs:0})` 抢锁后，helper 自身 finally 已释放，`await op()` 无锁运行且外层无条件 unlink（docker-manager.ts:121,127-129,383-387 + lock.ts:81-85）——修复方向为「持锁执行 async op」形态，见 risk.md RISK-CORE-001。

## 备注

- sleepSync 的 Atomics.wait 不可用时退化忙等（lock.ts:29-34），仅影响极端运行时。
