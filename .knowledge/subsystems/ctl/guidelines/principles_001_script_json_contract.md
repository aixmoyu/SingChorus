---
project: SingChorus
type: development-principle
id: principle-ctl-001
description: ctl 的机器可读输出是一等契约：脚本集成必须走 --json；JSON 形态（含错误形态 {ok:false,error}）视作稳定接口，人读文案（中文 + ANSI 颜色）随时可改、不作任何消费依据。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 架构
---

# 脚本集成必须走 --json 契约（R-CTL-D4）

## 原则详细描述

chorusctl 的每条命令同时服务两类消费者：脚本（CI/定时任务）与人类操作员。二者的输出通道被显式分离——`--json` 全局开关经 preAction 置进程内存态（`packages/ctl/src/index.ts:21-25`、`packages/ctl/src/config.ts:6-14`），JSON 模式输出 `JSON.stringify(data, null, 2)`（`packages/ctl/src/utils.ts:4-6`），人读模式输出中文彩色文案/表格。契约的稳定边界只划在 JSON 侧：程序级 description 明示「脚本集成必须使用 --json 输出，人读文案格式不保证稳定」（`packages/ctl/src/index.ts:19`）。

## 为什么要这样

- 脚本解析彩色文案/中文表格必然脆断；把稳定性承诺限定在 JSON 侧，文案才能自由迭代而不破坏下游。
- 错误同样契约化：`fail()` 在 JSON 模式输出 `{ok:false, error[, detail]}` 并以退出码 1 结束（`packages/ctl/src/utils.ts:16-24`），脚本只需判 `ok` 字段与退出码。
- `--json` 是单次调用语义的进程内存态、不落盘——历史版本曾持久化到 `~/.singchorus/ctl/config.json`，因产生跨调用副作用已被移除（`packages/ctl/src/config.ts:1-5`）。

## 适用范围

- packages/ctl/ 全部命令（含内联 health）；新增任何子命令默认适用。

## 规则

- 每个命令的所有输出路径必须双模式：`isJson()` 分支 + printJson / print* 家族（`packages/ctl/src/utils.ts:75-209`）。
- 失败一律经 `fail()`，禁止裸 console.error 后以 0 退出。
- JSON 输出不得回显 token 明文：只允许 `token_set` 布尔或前 8 位截断（`packages/ctl/src/commands/cloud.ts:106-107`、`packages/ctl/src/utils.ts:208`）。
- 非致命警告以 `warning` 字段进入 JSON 输出，不改变退出码（`packages/ctl/src/commands/deploy.ts:18-21`）。

## 反模式 / 禁止项

- 在 JSON 模式混入人读装饰（颜色码/表格线）。
- 以「文案看起来稳定」为由让人读模式被脚本消费。
- 将 --json 状态持久化或跨调用生效。

## 修改检查清单

- [ ] 改动输出结构时，是否只动了人读分支而 JSON 分支保持兼容？
- [ ] 新命令是否同时实现了 JSON 与人读两分支？
- [ ] 是否新增了任何明文敏感信息输出？
