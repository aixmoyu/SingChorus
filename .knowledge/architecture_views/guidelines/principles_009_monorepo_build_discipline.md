---
project: "SingChorus"
type: development-principle
id: principle-global-009
principle_scope: 项目级
description: "monorepo 纪律：改 core 必须先 build 再动下游（消费 dist 而非源码，CI 固化顺序）；单一根 lockfile（子包 lockfile 被禁止）；Docker 构建上下文固定仓库根 + pnpm --filter 闭包安装；生产配置文件脚本生成不手编。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 工程-构建纪律
---

# monorepo 构建顺序与仓库纪律

## 原则详细描述

- 构建顺序：panel/ctl 消费的是 `@chorus/core` 的 dist 产物而非源码，CI 以显式步骤先 build core（`.github/workflows/ci.yml:20`；`packages/core/package.json:14-18`）。
- 单一根 lockfile：子包 lockfile 被 .gitignore 明令禁止，注释称曾导致 Cloudflare 部署失败（`.gitignore:4-5`）。现存违例：`packages/core/pnpm-lock.yaml` 仍被跟踪（见 [../risk.md](../risk.md) RISK-DEBT）。
- 构建局部性：Docker 构建上下文固定为仓库根，用 `pnpm --filter` 闭包安装，保证镜像与本地产物同源（`packages/cloud/Dockerfile:2-3,15`）。
- 生产配置生成：`wrangler.prod.toml` 由 `scripts/setup-prod.mjs` 生成并 gitignore（`wrangler.prod.toml:1-4`）。

## 为什么要这样

- dist 消费模式让 core 的公共 API 边界真实生效（未导出即不可用），但代价是忘 build 会调试到旧代码——CI 顺序固化是唯一保险。
- 多 lockfile 会让不同环境解析出不同依赖树，部署平台（Cloudflare）按根 lockfile 安装时直接失败。
- 仓库根上下文 + filter 安装，使镜像内依赖与 lockfile 完全一致，且 core 的 dist 可进入镜像。

## 适用范围

- 项目级：本地开发、CI、Docker 构建、发布脚本。

## 规则

- 改 core 后本地调试下游必须先 `pnpm --filter @chorus/core build`。
- 禁止在任何子包生成 lockfile；发现被跟踪立即 `git rm --cached`。
- 新增 Dockerfile 必须以仓库根为上下文、以 `pnpm --filter <pkg>...` 安装。
- 生产环境配置一律脚本生成 + gitignore。

## 反模式 / 禁止项

- 在子包目录直接 `pnpm install` 生成 lockfile 并提交。
- 以单包目录为 Docker 构建上下文（拿不到 core dist）。
- 手编生产配置文件并提交。

## 修改检查清单

- [ ] core 变更后 dist 是否已重建再测下游？
- [ ] 是否意外生成/提交了子包 lockfile？
- [ ] 镜像构建是否仍从根上下文拿到全部闭包依赖？
