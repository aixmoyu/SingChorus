---
project: SingChorus
type: risk
description: panel 模块内风险：单文件配置的并发/损坏域、内存态限流与单进程假设、DooD 权限面、明文 HTTP 暴露、core 门面绕行债。全局级风险见 architecture_views/risk.md（不重复登记）。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
---

# 模块架构风险分析（panel）

> 故障域限定于 packages/panel 代码；跨模块风险仅记录与本模块边界相关的依赖项。

## 模块内稳定性与并发风险

|风险 ID|场景|触发条件|影响范围（本模块内）|概率|严重度|优先级|当前缓解|建议缓解|状态|
|-|-|-|-|-|-|-|-|-|-|
|RISK-PANEL-001|config.json 读改写交错覆盖|两个请求的 bcrypt await 期间并发写配置（setup/change-password）|密码哈希/token_version 被旧快照覆盖→会话全失效或口令回滚|低|高|高|进程级写互斥队列 runConfigExclusive（config.ts:167-182）；锁内重查 first-run（auth.ts:67-72）|维持现状；引入多实例前必须替换为文件锁|已缓解|
|RISK-PANEL-002|登录限流态重启即清零|服务重启/容器重建后攻击者计数归零|暴力破解窗口重置|中|低|低|接受：单管理员本地面板（routes/auth.ts:8-16 注释明示）；15min 锁定+强口令策略兜底|如需持久化可移入 config.json 或 sqlite|接受|
|RISK-PANEL-003|限流按代理 IP 计数（限流失效）|反向代理后未设 CHORUS_PANEL_TRUST_PROXY，req.ip 全为代理地址|所有用户共享同一限流桶→单点可锁死全员|中|中|中|文档化：compose 注释提示设置（docker-compose.yml:32-33；env.ts:34-43）|部署文档强制项；误设 true 则可被 X-Forwarded-For 伪造|已缓解（文档层面）|
|RISK-PANEL-004|同步定时器与请求并发触发 tick 重入|30s tick 与 triggerSync 同时进入 SyncService|重复推送/竞态（执行体在 core 侧）|低|中|中|core 侧 SyncService 自带 backoff/dispose（core-provider.ts:98-101）；tick 未配置即跳过（core-provider.ts:124）|观察 core 侧幂等性；[待确认: SyncService.tick 重入语义]|观察|
|RISK-PANEL-005|面板明文 HTTP 直接暴露公网|容器默认 0.0.0.0:8088 且无内置 TLS（docker-compose.yml:24-27；Dockerfile:39-41）；口令明文过网|管理面被窃听/爆破面扩大|中|高|高|compose 注释提示 CORS/反代（docker-compose.yml:29-33）；强口令策略+限流+SameSite/originCheck 兜底（app.ts:28-56）|部署文档强制反代终结 TLS 或绑定 127.0.0.1|部分缓解|

## 跨模块依赖风险

|风险 ID|依赖方向|依赖对象|失效/漂移场景|影响|当前保障|改进方案|
|-|-|-|-|-|-|-|
|DEP-PANEL-001|本模块→下游|@chorus/core 门面契约|core 方法签名/错误形状变更（如 statusCode/code 字段）|全部 core 路由 500 化|toCoreError 宽松抽取（helpers.ts:7-14）；workspace:* 锁同仓版本；supertest 路由测试 13 个文件|契约测试覆盖 core 错误形状|
|DEP-PANEL-002|本模块→下游|core LocalStore 直读（绕门面）|core store 内部结构（app config 字段）变更|getCore 快照失真→校验器镜像错误|单一调用点 core-provider.ts:50，core.ts:366-370 已承认债务并提供 getRemoteConfig 门面|singbox 版本读取同样门面化|
|DEP-PANEL-003|本模块→下游|Cloud Worker（经 core）|云端不可达/409 PORT_CONFLICT 等|模板/订阅/同步不可用；配置卡 pending|check-tag 降级本地判定并回传 detail（configs.ts:88-95）；sync-status 暴露 lastFailures（cloud.ts:89-94）；30s tick 重试|已按可降级设计|
|DEP-PANEL-004|本模块→下游|宿主 docker daemon（sock）|daemon 重启/sock 权限丢失|部署域全部 503|错误码 DOCKER_UNAVAILABLE + 前端长超时（deploy.ts:49-99）|已明确降级边界|
|DEP-PANEL-005|本模块→下游|zod v4 与 cloud zod v3 双大版本|两侧 schema 语义漂移（如 SINGBOX_VERSION_RE）|面板与云端校验不一致|刻意松耦合无共享包（package.json:53 vs packages/cloud/package.json:36）；正则以注释互镜像（settings.ts:26-27）|共享常量包或契约测试|

## 模块内性能瓶颈风险

|瓶颈 ID|位置（本模块内）|当前指标|阈值|触发条件|影响|突破方案|预计工作量|
|-|-|-|-|-|-|-|-|
|PERF-PANEL-001|check-tag 云端全量比对|同步阻塞请求|前端 30s 超时|云端慢响应|创建表单卡顿（有降级路径）|configs.ts:88-95 已降级 local_only|已完成|
|PERF-PANEL-002|core 路由单文件膨胀→已拆分|-|-|历史问题|可维护性|按 configs/cloud/deploy 三域拆分（routes/core.ts:9-11 注释）|已完成|

## 模块内数据一致性风险

|风险 ID|场景|一致性级别|当前保障|潜在问题|概率|影响|改进方案|
|-|-|-|-|-|-|-|-|
|CONS-PANEL-001|带外编辑 config.json 后写覆盖|单文件最终一致|写前 mtime 复验，检测到带外编辑则重读新基线再合并（config.ts:139-156）|TTL 500ms 窗口内连续带外编辑仍可能漏检|低|低|可接受（单管理员场景）|
|CONS-PANEL-002|配置已推送失败但 UI 无从解释|本地与云端最终一致|sync-status 返回 lastFailures 逐配置明细（cloud.ts:85-98）|失败仅存在于上一轮快照|中|低|已修复（徽标可解释）|
|CONS-PANEL-003|panel config 与 core app config 双写漂移|跨文件最终一致|设置保存/初始化时镜像写入并 invalidateCore（settings.ts:48-64；init.ts:93-109）|非事务：两文件写入之间崩溃|低|中|写序已把 panel config 放前；可加启动时对账|

**失败场景分析模板**

```
正常路径：路由写 panel config → invalidateCore → getCore 快照重建 → mirror 写 core app config
异常路径：镜像写 core app config 前崩溃 → 两文件不一致 → 下次设置保存时自愈（全量镜像写）
```

## 模块可用性风险

|风险 ID|故障域（本模块内）|组件|当前可用性|目标可用性|SPOF|冗余策略|故障恢复策略|RTO / RPO|
|-|-|-|-|-|-|-|-|-|
|AVAIL-PANEL-001|panel 进程|Express 单进程|-（单节点自托管）|尽力|是|无（设计即单实例）|docker restart: unless-stopped（docker-compose.yml:23）|秒级 / 0|
|AVAIL-PANEL-002|config.json 损坏（半写/盘故障）|配置文件|-|-|是（单文件）|无副本|原子写防半写（config.ts:121-126）；损坏文件改名隔离 `.corrupt-<ts>` 后重建默认配置（config.ts:107-115），密码与云设置需重新初始化|手动 / 丢失管理员凭证|
|AVAIL-PANEL-003|docker.sock 挂载失败|容器部署|-|-|是（部署域）|无|DEPLOY/日志域报 503，其余功能不受影响（deploy.ts 各 catch）|检查挂载|

## 模块内技术债务

|区域（本模块）|债务类型|原因|严重度|偿还建议|
|-|-|-|-|-|
|core-provider.ts:50 直读 LocalStore|设计债|singbox 版本/镜像尚无门面方法|中等|core 提供 getAppConfig 门面读取（getRemoteConfig 已示范，core.ts:366-370）|
|routes/auth.ts 遗留小写错误码|代码债|与后建大写蛇形码并存（unauthorized/wrong_password vs VALIDATION_ERROR）|轻微|统一时前端同步改映射（http.ts:59-84 已兼容两种形状）|
|api 5xx 消息生产脱敏依赖 isProduction 常量|代码债|NODE_ENV 构建期固化，测试/预发语义模糊|轻微|维持；需要时引入运行时开关|
|info.ts 版本号硬编码 '0.2.0'|代码债|与 package.json 双写（info.ts:26）|轻微|构建期注入；测试已去硬编码（commit 5ab6e0b 主题）|
|部署域 5xx→400/503 状态映射散落|代码债|e.status===500 分支在 4 处重复（deploy.ts:38,74,85）|轻微|收敛进 toCoreError 映射表|
