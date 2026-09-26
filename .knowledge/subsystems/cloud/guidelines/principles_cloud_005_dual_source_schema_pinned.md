---
project: SingChorus
type: development-principle
id: principle-cloud-005
description: 运行时 eager DDL（db/schema.ts）与 wrangler migrations（migrations/0001_init.sql）是同一 schema 的双源真值，二者结构等价由 CI 测试钉死；任何列变更必须三处同步（CREATE、migration、存量 ALTER）。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 工程
---

# 双源 Schema 必须测试钉死

## 原则详细描述

模块同时存在两条建库路径：fresh 库走 `wrangler d1 migrations apply`（0001_init.sql），测试/本地/兜底走运行时 `initializeDatabase` 的幂等 CREATE（schema.ts:34-52）。两条路径各自独立产出 schema，若漂移则「新库与老库行为随库历史不同」。`tests/schema-fingerprint.spec.ts:7-15`（决策 CLOUD-C3）对两者做结构快照（列集+约束+索引，列顺序归一化）并要求严格一致。存量库升级靠幂等 ALTER_TABLES 补列（schema.ts:57-63）；42063a9 是该机制的真实修复案例（旧库缺 singbox_version 列导致订阅插入 500）。

## 为什么要这样

- 迁移文件解决生产升级，eager DDL 解决「任何环境开箱即用」（schema.ts:37 注释）——两者服务不同场景，删除任何一边都会破坏另一个场景。
- SQLite 的 `ALTER TABLE ADD COLUMN` 会追加列序，因此 fingerprint 测试显式归一化列顺序（schema-fingerprint.spec.ts:13-14），避免误报。
- DDL 字符串内的 `--` 注释会随 eager 执行进入 sqlite_master，破坏 fingerprint 对比——因此规定 SQL 内禁写行内注释（schema.ts:120-121 注释）。

## 适用范围

- db/schema.ts、migrations/、以及任何引入新表/新列/新索引的变更。

## 规则

- 新列必须同时落：CREATE_TABLES、0001_init.sql、ALTER_TABLES（存量库幂等补列）。
- NOT NULL 新列必须带 DEFAULT（SQLite 限制，schema.ts:60-62 注释）。
- 改完跑 schema-fingerprint 与 schema-upgrade 两个测试。
- tag/port 等高频查询条件建镜像列 + 索引（idx_protocol_instances_tag、idx_client_configs_tag partial unique，schema.ts:194,208）。

## 反模式 / 禁止项

- 只改一边（schema.ts 或 migration）就提交。
- 在 DDL 字符串里写 `--` 注释。
- 用「删表重建」代替 ALTER 处理存量库。

## 修改检查清单

- [ ] 三处（CREATE/migration/ALTER）同步了吗？
- [ ] fingerprint 与 upgrade 测试本地通过了吗？
- [ ] 新索引有对应查询路径吗（禁止无消费的索引）？
