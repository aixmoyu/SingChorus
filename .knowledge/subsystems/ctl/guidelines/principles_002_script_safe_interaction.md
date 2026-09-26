---
project: SingChorus
type: development-principle
id: principle-ctl-002
description: CLI 的默认消费者是无人值守脚本：交互确认在非 TTY 环境必须立即失败而不是悬空等待；所有破坏性操作必须提供 -y 逃生口；参数解析错误必须立即暴露而不是静默跳过。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 工程
---

# 脚本安全交互：非 TTY 必失败、-y 逃生、严格解析

## 原则详细描述

chorusctl 的变更类操作（remove/delete 等）保留人工确认，但确认机制被设计为「脚本安全」：`confirm()` 在 stdin 非 TTY 时直接返回 false，提示文本走 stderr，由调用方决定以「需要 -y」提示失败——保证脚本集成永远不会被悬空的 stdin 提示卡住（`packages/ctl/src/utils.ts:40-53`）。同时所有变更类命令提供 `-y/--yes` 逃生口（config remove `packages/ctl/src/commands/config.ts:144-152`、remote delete `packages/ctl/src/commands/remote.ts:38-45`、subscription delete `packages/ctl/src/commands/subscription.ts:113-120`）。

## 为什么要这样

- 无人值守环境（CI/管道）中，悬空的交互提示等于进程假死，比快速失败危害大得多。
- 参数解析选择「严格失败」而非「容错跳过」：`parseParams` 对无 `=` 的条目直接报错退出，避免 CLI 吞掉用户拼错的参数（`packages/ctl/src/utils.ts:26-38`）。
- 非 TTY 快速失败与 `-y` 逃生口组合后，人工与脚本两条路径互不干扰。

## 适用范围

- packages/ctl/ 全部变更类子命令；新增破坏性操作默认适用。

## 规则

- 交互确认必须复用 `confirm()`，禁止自行读 stdin。
- `confirm()` 返回 false 且未提供 `-y` 时，必须经 `fail()` 以明确提示结束（退出码 1），提示语须包含「非交互环境请使用 -y」。
- 解析用户输入（key=value、端口、行数、--side 等）失败时立即 `fail()`，禁止静默忽略或取默认值继续（`packages/ctl/src/commands/config.ts:234-236`、`packages/ctl/src/commands/deploy.ts:84`、`packages/ctl/src/commands/validate.ts:32-34`）。
- 互斥选项在入口显式校验（如 `--active`/`--inactive`，`packages/ctl/src/commands/subscription.ts:86`）。

## 反模式 / 禁止项

- 在非 TTY 环境等待 stdin（悬空提示）。
- 用 try/catch 吞掉解析错误后按默认值继续执行破坏性操作。
- 破坏性操作无 `-y` 逃生口，导致脚本无法自动化。

## 修改检查清单

- [ ] 新增变更类命令是否同时具备 confirm 与 -y？
- [ ] 确认提示是否走 stderr？
- [ ] 参数校验失败是否立即退出（退出码 1）？
