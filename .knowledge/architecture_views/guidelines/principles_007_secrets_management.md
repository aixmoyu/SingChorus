---
project: "SingChorus"
type: development-principle
id: principle-global-007
principle_scope: 项目级
description: "机密不进仓库：仓库内配置只放非机密占位值；真实密钥按运行时形态分治（wrangler secret / 首启自动生成持久化 / 本地配置文件），且生成后重启不变。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 安全-机密管理
---

# 机密不进仓库且自动生成持久化

## 原则详细描述

三种运行时形态各自落实同一规则：

- Workers：wrangler.toml 仅放占位值供 CI/本地，真实密钥走 `wrangler secret`（`packages/cloud/wrangler.toml:27-33`；`scripts/setup-prod.mjs:165-168`）。
- cloud Node 形态：首启自动生成 AUTH_TOKEN/JWT_SECRET 并以 0600 持久化到 `/data/secrets.json`，重启/重建不变，warn 提示改用 env（`packages/cloud/src/node/entry.ts:33-37,46-85`）。
- panel：JWT_SECRET 存 `~/.singchorus/panel/config.json`（`packages/panel/server/config.ts:42-72`）。

生产配置文件 `wrangler.prod.toml` 由脚本生成并 gitignore，不手编（`wrangler.prod.toml:1-4`）。现存违例（dev 占位密钥复用风险、.prod.vars 明文、token 打印）登记于 [../risk.md](../risk.md) RISK-SEC-004/005。

## 为什么要这样

- 占位值一旦被复制到生产（无技术拦截时很容易发生），整个认证体系形同虚设。
- 自动生成 + 持久化让「开箱即用」与「密钥稳定」兼得：不持久化则每次重启使所有已发 JWT 失效。
- 0600 权限限定机密文件读取面。

## 适用范围

- 项目级：所有包的配置与部署脚本。

## 规则

- 新增机密必须指定三形态之一的存放位置，且禁止以默认值写入仓库内配置。
- 自动生成的机密必须持久化并有权限约束（0600）。
- 部署脚本应对已知占位值做生产环境拒绝校验（当前缺口，见 risk）。

## 反模式 / 禁止项

- 把真实密钥写进 wrangler.toml / docker-compose.yml / 源码常量。
- 每次启动重新随机化密钥。
- 日志/终端打印完整 token。

## 修改检查清单

- [ ] 新配置项是否区分占位值与真实密钥通道？
- [ ] 生成逻辑是否幂等（重启不换值）？
- [ ] 是否有打印/落盘泄敏检查？
