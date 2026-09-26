---
project: SingChorus
type: risk
description: chorus-cloud 模块内风险：双源 schema 漂移、JWT 吊销 fail-open、订阅 token 明文、缓存一致性窗口、交付链路规模上限与工程接线缺失。全局级风险见 architecture_views/risk.md。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
---

# 模块架构风险分析

> 故障域限定 packages/cloud/ code_mapping；跨模块仅记录边界依赖（见 boundaries.md）。

## 模块内稳定性与并发风险

|风险 ID|场景|触发条件|影响范围（本模块内）|概率|严重度|优先级|当前缓解|建议缓解|状态|
|-|-|-|-|-|-|-|-|-|-|
|RC-01|多 isolate 缓存不一致窗口|Workers 多实例部署，模板写失效只作用于处理请求的那个 isolate|其余 isolate 渲染旧模板最长 30s|中|低|P3|30s TTL 兜底（registry.ts:149-151）；/rerender 强刷本 isolate|可接受；关键变更走 /rerender 并等待 TTL|开放|
|RC-02|configsCache 300s 内新同步配置不可见|panel 刚推送 client_configs，订阅交付命中 isolate 缓存|新节点最长 5min 不出现在订阅|中|低|P3|与 panel 5min 全同步节奏对齐（subscriptions.ts:19-23 注释）|可接受|开放|
|RC-03|交付缓存写节流导致 stale 版本落后|订阅变更后 5min 内发生 D1 宕机|stale 路径交付旧配置（最长 5min 差量）|低|中|P2|变更路径显式 DELETE 缓存（subscriptions.ts:511-515,530-534）；token 哈希校验|已覆盖主路径；active 变更亦有 403+删缓存|缓解中|
|RC-04|batch 中途失败的部分可见性（Node）|SqliteD1.batch 用 better-sqlite3 事务，异常即整体回滚|无部分提交风险（事务语义 1:1）|低|低|P4|d1-sqlite.ts:108-119|—|关闭（有保障）|

## 跨模块依赖风险

<!-- 与 boundaries.md 上下游表对应。 -->

|风险 ID|依赖方向|依赖对象|失效/漂移场景|影响|当前保障|改进方案|
|-|-|-|-|-|-|-|
|RC-05|上游→本模块|panel（core CloudClient）|cloud 新增/收紧端点契约，panel 旧版本语义错位（如 filtered_count、X-Sbx-Skipped-Instances 未消费）|UI 显示不全或遗漏排除提示；不阻塞|契约测试 tests/contract-core.spec.ts；core 对未知字段容错（cloud-client.ts:384-386 旧响应缺字段按缺省）|重大契约变更走版本化端点|
|RC-06|本模块→下游|D1（Workers）|D1 宕机|管理面全 503；交付面三级降级后仍 503|CLOUD-A2 显式语义 + stale 缓存（subscriptions.ts:36-46）|无（云服务固有）；监控 DB_UNAVAILABLE 频次|
|RC-07|本模块→下游|semver npm 包|范围解析行为变化（升级大版本）|兼容判定单点全量受影响|锁定 ^7.6.0（package.json:37）；行为被 tests/compat.spec.ts 钉住|升级时跑全量 compat 契约测试|
|RC-08|上游→本模块|订阅消费端（未知客户端群）|客户端缓存/重试行为放大交付流量|D1 subrequest 预算被挤占|限流绑定可选 + isolate 缓存|生产环境绑定 SUBSCRIPTION_RATE_LIMITER|

## 模块内性能瓶颈风险

|瓶颈 ID|位置（本模块内）|当前指标|阈值|触发条件|影响|突破方案|预计工作量|
|-|-|-|-|-|-|-|-|
|RP-01|交付链路全量实例查询|SELECT * 全部 active 实例（subscriptions.ts:211-213）|D1 单查询行数/响应体|舰队实例数增长|交付延迟与响应体线性增长；无分页|按 tag/订阅分组过滤或分页|中|
|RP-02|client_configs 交付上限 40|LIMIT 40 硬编码（subscriptions.ts:122）|40 行|deployed+enabled 配置 > 40|**静默截断**——超出部分不进订阅|提高上限并加告警，或按订阅筛选|小|
|RP-03|deploy 串行渲染|逐实例 await renderProtocolInstance（deploy.ts:55-69）|每请求 subrequest 预算|单节点实例多 + 模板缓存冷|首请求慢；预算吃紧|模板已 30s 缓存，收益有限；可并行化渲染|小|
|RP-04|50 subrequest 预算|免费版 Workers 上限（schema.ts:5-9 注释）|50/请求|缓存全冷的重型请求（tag 检查等）|历史事故：DDL 每请求重跑挤爆预算致 500|initPromise memo + 三层缓存（已实施）|已偿还|

## 模块内数据一致性风险

|风险 ID|场景|一致性级别|当前保障|潜在问题|概率|影响|改进方案|
|-|-|-|-|-|-|-|-|
|RD-01|migrations/ 与 schema.ts 双源漂移|结构等价|schema-fingerprint 测试钉死（CLOUD-C3，tests/schema-fingerprint.spec.ts:7-15）；42063a9 即漂移修复案例|新库与老库结构分叉、行为随库历史不同|低（有测试）|高|已钉住；新增列必须双写并补 ALTER（schema-upgrade.spec.ts）|
|RD-02|instance 快照与模板定义漂移|快照语义（有意）|/rerender 维护端点（CLOUD-C1，protocol-instances.ts:153-204）|管理员改模板后误以为存量实例已更新|中|中|UI 引导改模板后触发 /rerender|
|RD-03|FK 不可用环境的引用完整性|应用层兜底|PRAGMA foreign_keys 尽力开启（schema.ts:35）；删除前引用检查（protocols.ts:128-140）；节点删除级联 batch（nodes.ts:215-222）|D1 若不支持 FK，悬挂引用需全部靠应用层前置检查——漏一处即产生孤儿行|低|中|补齐删路径引用检查清单化|
|RD-04|sub_delivery_cache 与订阅行短暂不一致|最终一致|变更即删缓存；stale 读校验 active+token 哈希|D1 宕机窗口内删缓存操作本身失败（catch 吞错）→ stale 服务已停用订阅|低|中|serveStaleDelivery 已校验 active 列（subscriptions.ts:94），残余窗口极小|
|RD-05|审计日志丢失|尽力而为|catch 吞错（audit.ts:28-30）|安全审计不完整（登录失败等留有 stdout 日志兜底）|低|低|接受或改缓冲队列|

**失败场景分析**（RD-01 典型）：

```
正常路径：fresh DB → migrations apply（或 eager DDL）→ 两者结构一致 → 行为一致
异常路径：只改 schema.ts 未改 0001_init.sql → 新库（eager DDL）与迁移库列集不同
        → fingerprint 测试 FAIL 拦截于 CI；若测试未跑（无 lint/typecheck 接线，见 RT-01）→ 生产分叉
```

## 模块可用性风险

|风险 ID|故障域（本模块内）|组件|当前可用性|目标可用性|SPOF|冗余策略|故障恢复策略|RTO / RPO|
|-|-|-|-|-|-|-|-|-|
|RA-01|管理面|D1 读写|依赖 D1 SLA|—|是（单 D1 库）|无|显式 503 + init 失败重试（schema.ts:14-17）；core 5xx 退避|随 D1 恢复 / RPO=0|
|RA-02|交付面|D1 + 两级缓存|D1 宕机仍可 stale 交付|高|sub_delivery_cache 与 D1 同库——库级故障时 stale 亦不可读|仅 isolate configsCache 内存层幸存|503 DB_UNAVAILABLE|至 D1 恢复 / RPO≤24h|
|RA-03|Node/VPS 部署|单 SQLite 文件（WAL）|主机存活即可用|—|是（单文件单进程）|无（自托管由用户决定备份）|busy_timeout=5000（entry.ts:92）；优雅停机 checkpoint|用户自定 / [待确认: 官方备份指引是否存在]|
|RA-04|限流器|内存 Map（Node）/未绑定（Workers）|n/a|—|否|键空间受界（订阅 id，rate-limiter.ts:6-7）|重启清零即恢复|—|

## 模块内技术债务

|区域（本模块）|债务类型|原因|严重度|偿还建议|
|-|-|-|-|-|
|package.json scripts（package.json:6-22）|工程债|无 typecheck/lint/build 校验脚本（仅 esbuild 打 Node 包）；CI 只有双套件 vitest|严重|补 `typecheck`（tsc --noEmit）与 lint 接线，接入 CI|
|zod ^3.24（cloud package.json:36）vs panel ^4.4.3（panel package.json:53）|代码债|双大版本并存，schema 语义差异（error.issues 结构等）需两侧各自维护|中等|统一大版本或封装共享 schema 包（注意 cloud 零本地依赖 core 的约束）|
|wrangler.toml:31-33 dev 占位密钥|配置债|AUTH_TOKEN/JWT_SECRET 占位值随仓入库（注释声明仅 CI/本地；生产走 wrangler secret，wrangler.toml:19-21）|中等|保持生产 config 生成路径唯一（setup-prod.mjs）并在部署文档强调禁止复用|
|subscriptions token 明文（schema.ts:129；subscriptions.ts:158,184）|安全债|订阅 token 数据库明文 + URL query 传输；与 tokens 表哈希纪律不一致（交付缓存已只存哈希）|中等|至少改为存哈希比对；评估 URL token 迁移路径（消费端兼容性约束）|
|500 直通 err.message（index.ts:88-93；OVERALL_RENDER_FAILED 亦透传 e.message，subscriptions.ts:309）|安全债|管理员 API 有意透传（注释声明），但交付端点同样可能命中，内部错误细节可达终端用户|中等|交付链路错误信息白名单化|
|JWT 吊销 fail-open（middleware.ts:45-55）|安全债（显式取舍）|D1 宕机期间无法确认吊销状态；签名验证 + 24h TTL 限定窗口|中等|文档化风险窗口；可选短 TTL + refresh 补偿|
|src/services/crypto.ts 仅 4 行空接口（crypto.ts:1-4）|代码债|残留占位|轻微|删除或落实|
|路由内手写 SQL 无 Repository 层|设计债（有意）|体量小、SQL 面窄；换存储需全路由改动|轻微|维持；若表数量增长再评估|
