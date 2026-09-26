---
project: "SingChorus"
type: risk
description: "SingChorus（sing-box 节点管理 + 订阅交付系统）全局架构风险：跨进程并发正确性、多 isolate 缓存一致性、订阅 token 与 docker.sock 安全面、工程门禁缺失与技术债。"
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
---

# 架构风险分析

> 证据均回溯至 `path/to/file:line`（base_commit 见 frontmatter）。`[待确认]` 项无法从代码得出，需运维/部署侧补充信息裁决。

## 稳定性与并发风险

|风险 ID|场景|触发条件|影响范围|概率|严重度|优先级|当前缓解|建议缓解|状态|
|-|-|-|-|-|-|-|-|-|-|
|RISK-STAB-001|panel 与 ctl 并发部署时部署锁互斥失效|部署期间另一进程进入部署段|同一节点并发 docker 操作、锁文件被误删|中|高|P0|注释声称 noop fn 返回后锁仍持有，但 `withFileLockSync` 内部 finally 已释放；外层 `releaseDeployLock` 无条件 unlink 可能删掉他进程锁|重构 `acquireDeployLock` 使锁作用域真正覆盖 `await op()`；unlink 前校验锁内容身份|开放（`packages/core/src/services/docker-manager.ts:112-130,383-387`；`packages/core/src/services/lock.ts:81-85`）|
|RISK-STAB-002|双进程争锁期间 panel 整站无响应|文件锁竞争等待（最长 5s）+ store 全同步 fs I/O|panel HTTP 请求阻塞|中|中|P1|`Atomics.wait`+20ms 轮询、5s 超时上限|迁 AsyncWorker 锁或降低锁粒度；store I/O 异步化评估|开放（`packages/core/src/services/lock.ts:26-35,68-86`）|
|RISK-STAB-003|多 isolate 部署下缓存/限流各自独立，陈旧窗口不可控|Workers 多 isolate 并存（isolate 级 configsCache 300s、交付写限频 5min、模板缓存 30s）|短窗交付旧模板/旧配置；限流计数失真|中|中|P1|缓存 TTL 短、stale 兜底 24h 有 active/token 哈希校验|引入 Durable Objects 或 D1 版本号失效广播|开放（`packages/cloud/src/routes/subscriptions.ts:15-33,53-54`；`packages/cloud/src/engine/registry.ts:125-151`）[待确认: 生产 Workers isolate 数/形态（wrangler.prod.toml 由脚本生成不在仓库）]|
|RISK-STAB-004|部署时长超前端超时，用户见 ECONNABORTED 而服务端仍在执行|渲染 25s + docker 60s + 健康 30s > axios 30s|体验受损 + 重复触发部署请求|高|低|P2|opQueue 串行 + 409 拒绝并发|前端改长轮询/任务查询接口；或压缩健康检查窗口|开放（`packages/panel/src/lib/http.ts:21`；`packages/core/src/services/docker-manager.ts:9-10`）|
|RISK-STAB-005|进程内状态重启易失（登录限流表、同步退避进度、内存限流计数）|panel/cloud 进程重启|重启窗口内限流清零、退避重新爬坡|高|低|P3|注释自认可接受（单管理员场景）|如转多用户需外置限流存储|开放（`packages/panel/server/routes/auth.ts:8-16`；`packages/cloud/src/node/rate-limiter.ts:1-8`）|

## 性能瓶颈风险

|瓶颈 ID|位置|当前指标|阈值|触发条件|影响|突破方案|预计工作量|
|-|-|-|-|-|-|-|-|
|RISK-PERF-001|`Atomics.wait` 同步轮询 + 同步 fs 全量 I/O（store）|单次锁等待最长 5s|—|多进程高频写竞争|事件循环阻塞、请求排队|异步化 store 或独立状态服务|中（`packages/core/src/services/lock.ts:26-35`；`packages/core/src/services/store.ts:172-187`）|
|RISK-PERF-002|多节点拉取共享 25s 时间预算|节点数×25s 串行 → 并行共享 25s|REQUEST_BUDGET_MS=25s|受管节点数量增长|单节点分得预算递减、大批量下对账不完整|分批拉取或云端批量端点|小（`packages/core/src/core.ts:273-301,24-33`）|
|RISK-PERF-003|D1 调用计入 Workers 免费版 50 subrequest/请求预算|memoize 每 isolate 一次缓解|50 subrequest|单请求内 D1 调用过多|Workers 免费计划下请求失败|付费计划或读路径缓存加深|小（`packages/cloud/src/db/schema.ts:9-12`）[待确认: 生产是否为 Workers 免费计划]|

## 数据一致性风险

|风险 ID|场景|一致性级别|当前保障|潜在问题|概率|影响|改进方案|
|-|-|-|-|-|-|-|-|
|RISK-DATA-001|本地↔云端节点配置对账|最终一致|content_hash 对账 + (fingerprint,name) 幂等 upsert + 空库守卫|并行拉取预算内未完成的节点本轮漂移|低|中|对账报告显式列出未覆盖节点|（`packages/core/src/core.ts:170-303,246-258`；`packages/cloud/src/routes/clients.ts:200-238`）|
|RISK-DATA-002|schema 双源真值漂移（migrations/0001_init.sql vs src/db/schema.ts 内联 CREATE_TABLES，同 9 张表各自维护）|—|`tests/schema-fingerprint.spec.ts` 钉住一致|新增列只改一处导致旧库升级报错（42063a9 即此类修复）|中|高|以 migrations 为唯一源生成 schema 或指纹测试扩为门禁|（`packages/cloud/migrations/0001_init.sql:4-111`；`packages/cloud/src/db/schema.ts:70-179`）|
|RISK-DATA-003|isolate/进程缓存与 D1 主数据陈旧|最终一致|TTL 30s/300s + stale 兜底校验|多实例下失效不同步|中|低-中|RISK-STAB-003 同源，统一治理|（`packages/cloud/src/routes/subscriptions.ts:15-33`；`packages/cloud/src/engine/registry.ts:125-151`）|

**失败场景分析**

```
正常路径：本地写 store → triggerSync → 推送 D1 → 客户端拉取 configsCache/D1
异常路径：D1 宕机 → 交付走 sub_delivery_cache stale(24h) → 仍失败 503 DB_UNAVAILABLE → core 退避重试
        ：重装后本地空库 → 跳过删除对账 → 防清空云端唯一副本
        ：拉取部分节点超时 → 共享预算耗尽 → 本轮跳过、下轮退避重试
```

## 可用性风险

|风险 ID|故障域|组件|当前可用性|目标可用性|SPOF|冗余策略|故障恢复策略|RTO / RPO|
|-|-|-|-|-|-|-|-|-|
|RISK-AVAIL-001|D1 / SQLite 不可用|cloud 交付面|三级降级（缓存→stale→503）|交付面接近 100%|是（管理面不降级）|stale 缓存 24h|退避重试（[1,4,16,64]s）|RTO=缓存 TTL 内 / RPO=24h 陈旧窗（`packages/cloud/src/routes/subscriptions.ts:15-54`；`packages/cloud/src/index.ts:45-56`；`packages/core/src/services/cloud-client.ts:34-59`）|
|RISK-AVAIL-002|自托管单实例无备份/DR|panel、cloud(Node)、`~/.singchorus` 数据、SQLite|单点|—|是（无自动备份、deploy:prod 迁移+部署一步完成、无金丝雀）|无|手动恢复|RTO/RPO 未定义 [待确认: 备份频率/保留策略]（`packages/cloud/docker-compose.yml:13`；根 package.json scripts）|
|RISK-AVAIL-003|sing-box 容器异常|sing-box（DooD 容器）|健康检查后落盘 meta|—|节点级|无自动重启策略证据|手动重部署|未定义|

## 安全风险

|风险 ID|威胁|攻击面|OWASP 类别|当前防护|漏洞等级|利用难度|改进措施|
|-|-|-|-|-|-|-|-|
|RISK-SEC-001|订阅 token 明文存储/明文 query 传输/`!==` 非常量时间比对|订阅 URL、D1 行、日志与分享面|A02 加密失效|缓存侧仅存哈希； UNIQUE 明文列；明文比对|高|中|哈希存储、常量时间比对、路径式 token、日志脱敏|（`packages/cloud/src/db/schema.ts:129`；`packages/cloud/src/routes/subscriptions.ts:158,184,75`）|
|RISK-SEC-002|docker.sock 挂载 ≈ 宿主 root 权限 + panel 0.0.0.0 明文 HTTP|panel 容器逃逸→宿主接管|A05 安全配置错误|非 privileged、DooD 而非 DinD|严重|中|TLS 反代、网络分段、sock 代理（如 docker-socket-proxy）|（`packages/panel/docker-compose.yml:13-14,37`；`packages/panel/Dockerfile:6-9,39-41`）|
|RISK-SEC-003|JWT 吊销检查 D1 宕机 fail-open（合法签名但查无记录放行）|被吊销 token 继续使用（≤24h JWT 有效期）|A07 认证失效|注释明示取舍；签名校验仍执行|中|中|宕机时 fail-closed 或本地吊销黑名单缓存|（`packages/cloud/src/auth/middleware.ts:41-55`）|
|RISK-SEC-004|dev 占位密钥（wrangler.toml AUTH_TOKEN/JWT_SECRET）复用到生产无技术拦截|生产 cloud|A07 认证失效|setup-prod 提示走 secret；无强制|高|低|部署脚本校验禁止占位值上产|（`packages/cloud/wrangler.toml:25-33`；`scripts/setup-prod.mjs:165-168`）|
|RISK-SEC-005|`.prod.vars` 明文落盘 + AUTH_TOKEN 打印终端/回显|运维工作站|A02/A09|—|中|低|改 secret 引用、关闭回显|（`scripts/setup-prod.mjs:170-178,218,260-261`）|
|RISK-SEC-006|Workers 形态限流未绑定（默认裸奔）；Node 限流可选、内存态、异常 fail-open|订阅/认证端点滥用|A04 不安全设计|Node 形态 MemoryRateLimiter|中|低|Workers 绑定 rate limiting binding 或 DO 限流|（`packages/cloud/src/node/rate-limiter.ts:2-7`；`packages/cloud/src/routes/subscriptions.ts:198-202`）|
|RISK-SEC-007|错误脱敏策略不一致：cloud 500 直通 err.message，panel 生产 5xx 脱敏|内部实现信息泄露|A05|panel 侧已脱敏|低|低|统一错误映射层|（`packages/cloud/src/index.ts:76-93`；`packages/panel/server/app.ts:143-150`）|

## 容量与扩展性风险

|资源/瓶颈点|当前容量|当前利用率|短期预测|长期预测|扩容阈值|突破/扩容方案|
|-|-|-|-|-|-|-|
|Workers subrequest 预算（免费版 50/请求）|memoize 缓解|低|节点/模板增长|请求内 D1 调用逼近上限|≈40|付费计划/读缓存加深（`packages/cloud/src/db/schema.ts:9-12`）[待确认: 生产计划]|
|多 isolate 一致性|单 isolate 假设|—|流量增长触发多 isolate|缓存失效不同步（RISK-STAB-003）|第二 isolate 出现即触发|DO/D1 版本广播|
|panel 单实例（文件锁+内存限流+进程内队列）|单管理员 VPS|—|用户增长|架构性上限|多实例需求出现时|外置锁/队列/限流|

## 技术债务

|区域|债务类型|原因|严重度|偿还建议|
|-|-|-|-|-|
|chorus-cloud 工具链未接线|测试债/工程债|包内无 typecheck/build/lint 脚本，根命令全部跳过 cloud；strict tsconfig 存在但未接线，CI 从未对 cloud 源跑 tsc|严重|补 scripts + 接入 CI（`packages/cloud/package.json:6-22`）|
|根 lint 空转|工程债|无任何包定义 lint、全仓无 eslint/prettier 配置|中等|引入统一 lint 配置（根 package.json:15）|
|`packages/core/pnpm-lock.yaml` 被 git 跟踪|工程债|初始提交 5b27269 引入；.gitignore:5 明令禁止（曾致 Cloudflare 部署失败）但跟踪文件不受 ignore 约束|中等|`git rm --cached` 移除|
|依赖版本漂移|代码债|zod 双大版本（cloud ^3.24 vs panel ^4.4.3）、vitest 三版本；契约 schema 两包独立定义无共享|中等|对齐版本或抽共享 schema 包（`packages/cloud/package.json:36`；`packages/panel/package.json:53`）|
|subscriptions.ts 单文件 500+ 行|代码债|交付/缓存/compat 过滤/CRUD 混合，路由与用例编排耦合|中等|拆分 route/use-case/cache 层（`packages/cloud/src/routes/subscriptions.ts:156-522`）|
|panel 绕过门面直读 store|设计债|core-provider 直接 `new LocalStore()`，core 注释承认演进中债务|中等|收敛经 ChorusCore 门面（`packages/panel/server/core-provider.ts:50`；`packages/core/src/core.ts:366-370`）|
|ctl 测试近空|测试债|仅 utils.spec.ts，`--passWithNoTests` 兜底，8 个 CLI 命令零覆盖|中等|补命令级契约测试（`packages/ctl/package.json:27`）|
|日志级别字段双名|配置债|Workers `LOG_LEVEL` ↔ Node `CHORUS_CLOUD_LOG_LEVEL` 靠注释维系|轻微|统一常量模块并加测试（`packages/cloud/wrangler.toml:23-26`；`packages/cloud/src/node/entry.ts:37-41`）|
|依赖方向无构建期强制|设计债|全仓无 dependency-cruiser/eslint boundaries，包间单向依赖仅约定|轻微|引入 boundary lint（logical_view 依赖图）|

## 风险治理优先级摘要

- **P0**：RISK-STAB-001（部署锁互斥失效——实现与注释不符）
- **P1**：RISK-STAB-002、RISK-STAB-003、RISK-SEC-001/002/004、RISK-DATA-002
- **P2/P3**：其余体验、容量与债务项

> [待确认] 清单（需部署/运维侧输入）：生产 Workers isolate 形态与计划类型；staging 环境存在性；生产实例清单与 GHCR 通道启用情况；备份频率/保留策略。
