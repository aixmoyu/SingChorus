---
project: SingChorus
type: risk
description: core 模块（packages/core）范围内的架构风险：跨进程锁互斥缺口（P0）、同步 API 阻塞事件循环、云端单点依赖与双进程数据目录一致性等。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
---

# 模块架构风险分析

> 故障域限定于 packages/core 的 code_mapping；跨模块风险仅记录与本模块边界（boundaries.md）相关项。全局级条目见 `architecture_views/risk.md`（RISK-STAB-001 即本文件 RISK-CORE-001 的全局视图）。

## 模块内稳定性与并发风险

|风险 ID|场景|触发条件|影响范围（本模块内）|概率|严重度|优先级|当前缓解|建议缓解|状态|
|-|-|-|-|-|-|-|-|-|-|
|RISK-CORE-001|部署跨进程锁互斥失效：`withDeployLock` 用 `withFileLockSync(path, () => undefined, {timeoutMs:0})` 抢锁，该 helper 在自身 finally 即释放锁（lock.ts:81-85），随后 `await op()` 实际**无锁运行**；且外层 finally `releaseDeployLock` 无条件 unlink（docker-manager.ts:383-387），若他进程此刻新建锁会被误删，令其互斥连带失效|panel 与 ctl 两进程并发 deploy/stop/restart|并发部署交错写 docker-compose.yml/entry.sh/config.json、交错 compose 命令、互相删除对方锁文件|低（需双进程同时操作）|高|P0|进程内 opQueue+409 有效（docker-manager.ts:99-109）；陈旧锁回收可兜底崩溃场景|改为「抢锁后持锁执行 op、退出时释放一次」的持锁 async 形态；release 前校验锁文件归属 PID|open（代码现状）|
|RISK-CORE-002|锁等待以 sleepSync（Atomics.wait/忙等）阻塞 Node 事件循环，store 默认等待上限 5s、轮询 20ms|panel 进程内任一 store 写与其他进程持锁竞争|panel server 全部请求停顿至多 5s（每笔竞争写）；ctl 场景无碍|中（双进程并存且写频繁时）|中|P1|默认超时 5s 封顶（lock.ts:15-17）；store 竞争转译 busy 错误（store.ts:181-186）|store 写路径异步化或缩短等待；至少把 5s 上限降为可配置|open|
|RISK-CORE-003|陈旧锁抢占的 rename 竞态窗口：两个等待方同时判定 stale 并 rename，输家在 unlink `.stale.<pid>` 时可能删到赢家新建的诊断文件；`tryAcquire` 递归重试无深度限制|锁持有者崩溃 + 多等待方并发抢占|偶发 ENOENT（被 catch 吞）、诊断文件丢失；无死锁（mtime 判定收敛）|低|低|P3|rename-then-recreate 保证唯一赢家创建（lock.ts:48-54）；异常全部 catch 后重试|锁文件名带 PID 归属校验后再删|open（可接受）|
|RISK-CORE-004|deploying 标志与 opQueue 均为进程内存态：进程重启即清空；`withDeploying` 的 409 依赖布尔标志，与 enqueue 的排队语义叠加时 stop/restart 不经过 deploying 检查（仅 deploy 走 withDeploying）|进程重启瞬间恰有部署在跑；stop/restart 与 deploy 并发靠 opQueue 串行兜底|状态短暂失真（deploying 丢失）；restart 与 deploy 仍互斥（同队列）|低|低|P3|opQueue 串行保证不交错（docker-manager.ts:99-109）；docker ps 观测修正状态|保持现状；多实例需求出现时重评（ADR-008 备注）|accepted|

## 跨模块依赖风险

|风险 ID|依赖方向|依赖对象|失效/漂移场景|影响|当前保障|改进方案|
|-|-|-|-|-|-|-|
|RISK-CORE-D1|本模块→panel 前端|REQUEST_BUDGET_MS=25s vs 前端 axios 30s（core-D2 契约）|core 调大预算超过 30s，或前端调小低于 25s|不可达云端以 opaque timeout 呈现而非结构化错误信封|双向注释锚点（cloud-client.ts:49-59、panel/src/lib/http.ts:18-25）；常量从包根导出|契约测试断言两常量关系|
|RISK-CORE-D2|panel→本模块|SyncService 驱动契约：tick ≥30s、变更须 trigger（core-D3）；panel server 4 个路由文件共 10 处 `triggerSync()` 调用点（grep 实证）|宿主漏调 trigger 或 tick 间隔过密|变更丢失至下个 tick / 云端列表配额被烧|契约写死在 sync-service.ts:12-17 注释；成功作废退避定时器防冗余（:100-105）|以类型/运行时断言固化间隔下限|
|RISK-CORE-D3|panel→本模块|panel 绕过门面直读 store：`new LocalStore()` 读 app_config（core-provider.ts:50）|store 内部布局/语义变更需双点维护；绕过点自带独立缓存语义|重构 store 时 panel 读路径静默漂移|仅只读使用；core.ts:366-372 已留门面化注释（core-D1）|为 app_config 读取提供门面方法并迁移 panel|
|RISK-CORE-D4|本模块→cloud|REST 契约（端点/字段名/错误码）；getClients「失败≠空云」语义（cloud-client.ts:390-399）|cloud 升级破坏字段或旧 cloud 缺 /api/render/deploy|上传/拉取/部署报 CLOUD_* 502 或 CLOUD_ENDPOINT_MISSING|renderDeploy 字段双命名兼容（:342-345,380-386）；契约测试 contract-core.spec.ts|字段收敛后移除双命名包袱|
|RISK-CORE-D5|ctl→本模块|ctl 直接 import CloudClient/ChorusCore（commands/cloud.ts:2 等）|ctl 与 panel 版本错配共享同一数据目录|锁/缓存语义跨版本不一致|数据目录布局稳定（store.ts:9-17）；版本 pin 由 core 注入而非请求体（core.ts:427 注释）|发布说明标注 core 升级需同时升级两宿主|

## 模块内性能瓶颈风险

|瓶颈 ID|位置（本模块内）|当前指标|阈值|触发条件|影响|突破方案|预计工作量|
|-|-|-|-|-|-|-|-|
|PERF-CORE-001|lock.ts:26-35,79 sleepSync 忙等/阻塞|单次等待≤5s（DEFAULT_TIMEOUT_MS）|事件循环停顿 5s|双进程写竞争|panel 全请求停顿|异步化锁或缩短超时|中|
|PERF-CORE-002|store.ts:233-245 listConfigs 全目录扫描|每失效后 O(文件数) 次读+解析|—|签名失效（任一进程写入）|配置数百级以下无感；损坏文件触发自愈路径更慢|维持 mtime 签名（已做）；无需|—|
|PERF-CORE-003|validator.ts:133-137 串行校验队列|单次 docker run ≤ validate_timeout（默认 30s）|队列积压=并发校验数|突发多配置校验|排队等待线性增长（有意防御，core-P1）|已按设计收敛为串行；无需|—|
|PERF-CORE-004|core.ts:273-301 拉取共享 25s 预算|整轮拉取 ≤25s|25s（core-P3）|某节点慢/不可达占满预算|同轮其余节点拉取被截断（保留本地缓存）|已按设计并行化；监测 warn 日志频率|—|
|PERF-CORE-005|docker-manager.ts:222-240 健康轮询 3s/次 ≤30s|部署调用挂起至多 30s+compose up 时间|HEALTH_CHECK_TIMEOUT=30|容器起不来|前端 30s 超时先到，用户重复点击（由 409 吸收）|无需（ADR-008 语义已覆盖）|—|

## 模块内数据一致性风险

|风险 ID|场景|一致性级别|当前保障|潜在问题|概率|影响|改进方案|
|-|-|-|-|-|-|-|-|
|CONS-CORE-001|RISK-CORE-001 并发部署交错写制品|单机最终一致（部署域被破坏）|进程内 opQueue（单进程内有效）|compose/config/entry 半更新组合；健康检查可能对错误组合通过|低|高（节点服务异常）|修复持锁形态（同 RISK-CORE-001）|
|CONS-CORE-002|上传成功但 markSynced 前进程崩溃|至多一次冗余重传|content_hash 服务端幂等比对（core.ts:236-237）|下轮重传同内容（无害）|低|低|无需|
|CONS-CORE-003|restoreFromCloud 端口冲突条目被 skip|部分恢复+明细返回|逐条 try/catch，restored/skipped 明细（core.ts:316-335）|用户须人工处理 skipped 清单|中|低|UI 突出 skipped 原因|
|CONS-CORE-004|部署备份 copyFileSync 非原子（docker-manager.ts:165-173）|备份文件可能半写|崩溃窗口极小（本机 copy）|回滚源损坏（rename 原子写的 config.json 本体不受影响）|极低|中|备份改 atomicWrite|
|CONS-CORE-005|CHORUS_FINGERPRINT 指向旧身份但云端仍记旧指纹归属他机|身份漂移|rebindNode 显式迁移接口（cloud-client.ts:483-503）；指纹格式校验|两机同指纹互相覆盖云端条目|低（需人工误配）|高|rebind 流程文档化+预检占用|

**失败场景分析模板**

```
正常路径：本地写（锁内原子写）→ trigger → 五步同步 → 云端一致（synced）
异常路径 1：云端不可达 → getClients 抛错 → 本轮中止 → SyncService 五级退避 [5s..900s] → 恢复后补同步
异常路径 2：部署中崩溃 → 制品因原子写完整但 compose 未起 → 状态观测 stopped → 用户重新 deploy
异常路径 3：双进程并发部署 → 进程内互斥各自有效、跨进程锁失效（RISK-CORE-001）→ 制品可能交错 → 需人工重新部署收敛
```

## 模块可用性风险

|风险 ID|故障域（本模块内）|组件|当前可用性|目标可用性|SPOF|冗余策略|故障恢复策略|RTO / RPO|
|-|-|-|-|-|-|-|-|-|
|AVAIL-CORE-001|cloud 不可达|CloudClient 全部能力（渲染/同步/订阅）|依赖 cloud SLA|—|是（设计选择，ADR-003 fail-loudly）|本地 CRUD/读缓存仍可用；25s 预算+退避重试|SyncService 指数退避；部署响亮失败|RTO=云端恢复 / RPO=0（本地未丢）|
|AVAIL-CORE-002|docker daemon 不可用|DockerManager/Validator|—|—|是|状态显式报 unavailable（core-A3）；校验跳过放行|daemon 恢复后自愈|即时观测 / —|
|AVAIL-CORE-003|数据目录文件损坏|LocalStore|—|—|否（有自愈）|.history ≤20 快照 + 隔离保留现场|启动自愈或读取时恢复|RPO≤20 次变更 / 恢复毫秒级|
|AVAIL-CORE-004|锁文件残留死锁|lock|—|—|否|mtime>10s 陈旧回收（lock.ts:47-54）|自动抢占|≤10s|

## 模块内技术债务

|区域（本模块）|债务类型|原因|严重度|偿还建议|
|-|-|-|-|-|
|`packages/core/pnpm-lock.yaml` 被跟踪（git ls-files 实证），违反 `.gitignore:5`（`packages/*/pnpm-lock.yaml`）|代码债/流程债|早期误提交后未 `git rm --cached`|中等|`git rm --cached packages/core/pnpm-lock.yaml`，根 lockfile 唯一|
|panel 绕过门面 `new LocalStore()`（core-provider.ts:50；core.ts:366-372 承认）|设计债|为读 singbox pin 走捷径|中等|门面补 getAppConfig 读路径并迁移（core-D1 已开 headroom）|
|core.ts 门面约 500 行，含同步算法与 toRemoteEntry 转换|代码债|门面+算法同居|轻微|同步算法可拆独立 service（保持导出不变）|
|renderDeploy 响应 camelCase/snake_case 双命名兼容（cloud-client.ts:342-345,380-386）|代码债|兼容旧 cloud|轻微|约定最低 cloud 版本后移除|
|docker-manager.ts:112-130,383-387 部署锁实现（RISK-CORE-001）|设计债|锁原语与 async 持锁形态错配|严重|重构持锁 async helper（P0）|
