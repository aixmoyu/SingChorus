---

project: SingChorus

type: module-design

description: ctl 是 chorusctl CLI 的薄适配层（轻宿主）：Commander 注册 8 个命令组 + 内联 health，零业务逻辑，全部能力经 ChorusCore 门面进程内复用 core；自有状态仅 --json 进程内存开关。本文档按 Low 优先级简化，省略内部实现详节。

base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9

---

# 模块设计：ctl（chorusctl CLI）

## 模块定位与核心职责

- **一句话定义**：SingChorus 的命令行管理前端——把 core 门面能力适配为 40 个子命令，向脚本提供 `--json` 稳定契约、向人提供彩色文案（`packages/ctl/src/index.ts:15-34`）。
- **核心业务/技术能力**：命令解析（commander）、双模式输出、脚本安全交互（非 TTY 拒绝悬空）、panel 子进程启动（`packages/ctl/src/commands/panel.ts:94-114`）。

## 内部架构与分层设计

- **分层模式**：两层薄适配——Commander 注册层（index.ts）→ 命令组适配层（commands/*.ts）→ 直接调用 ChorusCore 门面；无领域层/持久层。
- **核心组件与分工**：

|组件/类名|职责描述|依赖|关键文件|
|-|-|-|-|
|`program`|CLI 装配点：全局 `--json` 选项 + preAction 钩子设内存态 + 8 命令组注册 + 内联 health|commander、commands/*|`packages/ctl/src/index.ts:15-34,36-65`|
|`configCommand` 等 8 组|各业务域子命令适配：参数校验 → core 调用 → print 输出|ChorusCore|`packages/ctl/src/commands/*.ts`|
|`resolvePanelServer`|panel 入口解析（已装包 → monorepo 回退 → npx 提示）|fs/path/child_process|`packages/ctl/src/commands/panel.ts:39-92`|
|`utils.ts` print*/fail/confirm/parseParams|跨切面输出与交互|config.ts|`packages/ctl/src/utils.ts`|
|`config.ts`|`jsonOutput` 进程内存态开关（get/set）|无|`packages/ctl/src/config.ts:6-14`|

```mermaid
graph TD
    subgraph ctl (@chorus/ctl)
        IDX["index.ts program + health + --json preAction"]
        CMD["commands/ 8 命令组"]
        UTL["utils.ts 双模式输出/confirm/parseParams"]
    end
    subgraph core (@chorus/core, 进程内)
        FC["ChorusCore 门面<br/>configs / cloud / deploy / validate"]
        LOCK["store 文件锁 ~/.singchorus/data/.lock"]
    end
    IDX --> CMD --> UTL
    CMD --> FC
    FC --> LOCK
```

## 核心领域模型与状态机

- **自有实体**：无。仅输出视图用的轻量接口（ConfigEntry/TemplateInfo/CloudStatus 字段子集，`packages/ctl/src/utils.ts:61-73,106-111,140-143`）。
- **状态转换逻辑**：不适用（无状态机）；唯一状态是 `jsonOutput` 布尔开关，preAction 每次调用前置位（`packages/ctl/src/index.ts:22-25`）。

## 关键工作流与算法实现

- **脚本调用流程（R-CTL-D4 主链路）**：
  1. `chorusctl <cmd> --json` → preAction `setJsonOutput(true)`（`packages/ctl/src/index.ts:22-25`）
  2. 命令组 action：`new ChorusCore()`（每命令新实例，无共享状态）→ 调 core API
  3. 成功 `printJson(result)`；失败 `fail()` 输出 `{ok:false,error}` 并 `process.exit(1)`（`packages/ctl/src/utils.ts:16-24`）

## 设计模式

|模式|应用位置|解决的问题|关键文件|说明|
|-|-|-|-|-|
|Facade 复用|每命令 `new ChorusCore()`|CLI 零业务逻辑，全部委托 core 门面|`packages/ctl/src/commands/config.ts:9-11`|轻宿主案例：logger/getRequestId 均省略（`packages/core/src/core.ts:12-22,43-51`）|
|模板化双模式输出|utils.ts print* 家族|同一数据按 isJson() 分流 JSON/人读|`packages/ctl/src/utils.ts:75-209`|新增输出形态只需加一个 print* 函数|

## 数据设计

- **核心数据模型**：不适用——ctl 无自有持久化数据；`jsonOutput` 为进程内存态且明确不落盘（历史版本曾持久化到 `~/.singchorus/ctl/config.json`，已移除该副作用，`packages/ctl/src/config.ts:1-5`）。
- **存储与持久化设计**：不适用。共享数据目录 `~/.singchorus/data` 的读写全部经 core，锁亦由 core 承担。

## 接口契约

### 外部接口（CLI → 脚本/人）

|名称|描述|请求方式|请求参数|返回参数|错误码|
|-|-|-|-|-|-|
|chorusctl 40 子命令|8 命令组：config(12)/deploy(5)/cloud(5)/node(4)/remote(3)/panel(1)/subscription(5)/validate(4) + 内联 health(1)|子进程 CLI|见 `chorusctl <cmd> --help`|JSON 模式=结果对象；人读=表格/彩色文案|统一 `{ok:false, error[, detail]}` + 退出码 1（`packages/ctl/src/utils.ts:16-24`）|
|`--json` 全局选项|切换机器可读输出|CLI flag|无|无|无|
|退出码约定|0=成功；1=业务失败/冲突/探测不可达/校验 invalid|—|—|—|冲突示例：check-tag 占用、check-port 冲突、cloud status 不可达（`packages/ctl/src/commands/config.ts:211,244`、`packages/ctl/src/commands/cloud.ts:19`）|

### 内部接口（ctl → core 消费面）

|名称|描述|调用方|提供方|请求参数|返回参数|
|-|-|-|-|-|-|
|`ChorusCore`（进程内）|唯一业务门面，全部 8 组命令共用|commands/*.ts|@chorus/core|—|—|
|`core.configs.{listAll,get,create,update,delete,enable,disable}`|本地配置 CRUD/启停|config.ts|core ConfigManager|见 `packages/core/src/core.ts:70`|ConfigEntry|
|`core.cloud.{getTemplates,getProtocols,checkTagAvailable}`|云端模板/协议/查重|config.ts、cloud.ts|core CloudClient|—|模板数组/布尔|
|`core.{generateConfig,generateServerConfig,generateSubscription,validate}`|渲染与校验|config.ts、validate.ts|core|type+params / config|server+client config / {valid,errors}|
|`core.{deploy,stopDeploy,restartDeploy,deployStatus,deployLogs}`|Docker 生命周期|deploy.ts|core DockerManager|tail 等|状态/日志文本|
|`core.{syncAllToCloud,getAllSyncStatuses,restoreFromCloud}`|同步/恢复|cloud.ts、node.ts、deploy.ts|core|—|{synced,skipped,pulled,deleted,failures} 等|
|`core.{getIdentity,importFingerprint,isInitialized,getAppConfig,updateAppConfig}`|节点身份与应用配置|index.ts、node.ts、cloud.ts、config.ts|core|Partial\<AppConfig\>|NodeIdentity/AppConfig|
|`core.{listRemoteConfigs,getRemoteConfig,deleteRemoteConfig}`|远端只读镜像|remote.ts、config.ts|core|fingerprint+name|ConfigEntry|null|
|`core.{list,get,create,update,delete}Subscription`|订阅 CRUD|subscription.ts|core|增量 data|Subscription|
|`deriveSingboxImage` / `CloudClient`（命名导出）|镜像推导 / 临时探测客户端|config.ts:2、cloud.ts:67|core|—|—|

### 配置接口

|名称|描述|类型|默认值|取值范围|
|-|-|-|-|-|
|--port / --host（panel start）|面板监听|CLI option|8088 / 127.0.0.1|注入 env CHORUS_PANEL_PORT/HOST（`packages/ctl/src/commands/panel.ts:107-109`）|
|--url（cloud test/setup）|Cloud 服务地址|CLI option|http://localhost:8787|尾部斜杠被剥离（`packages/ctl/src/commands/cloud.ts:63,93`）|

### 错误码与异常定义

|错误码|协议层状态|含义|触发场景|处理建议|
|-|-|-|-|-|
|`{ok:false,error}`|退出码 1|统一 JSON 错误形态|所有命令失败路径（`packages/ctl/src/utils.ts:17-23`）|脚本判 ok 字段而非文案|
|CFG_NOT_FOUND|core AppError 404|配置不存在|remove/show 前置预检（`packages/ctl/src/commands/config.ts:148`）|修正配置名|
|warning 字段|退出码 0|非致命警告（如同步失败）|deploy 后同步失败（`packages/ctl/src/commands/deploy.ts:18-21`）|依赖定时同步重试|

## 开发指南

### 洞察

- Key: 每命令 action 内 `new ChorusCore()`，实例不跨命令共享——core 构造成本即每次调用成本。
- Key: 直跑检测：仅当 `process.argv[1]` 以 index.ts/index.js/chorusctl 结尾才 parse，保证被测试/工具 import 无副作用（`packages/ctl/src/index.ts:67-74`）。

### 扩展指南

- 新增子命令：1) 在对应 `commands/<域>.ts` 追加 `.command()`；2) action 内 `new ChorusCore()` 调用既有 core API（core 无对应能力则先在 core 扩展，ctl 不写业务逻辑）；3) 输出一律走 `isJson()` 分支 + utils.ts print*；4) 变更类操作加 `-y` + `confirm()`；5) 失败走 `fail()`，禁止裸 console.error 后静默返回 0。

### 风格与约定

- Key: 错误处理统一 try/catch → `fail(err.message)`；预检类拒绝（check-tag/check-port/validate invalid）用 `process.exit(1)` 并保持正常输出格式。
- Key: 人读文案用中文 + ANSI 颜色码；JSON 契约字段用英文 snake_case。

### 设计哲学

- Key: 轻宿主（thin host）——core 可注入 logger/getRequestId，CLI 全部省略（`packages/core/src/core.ts:12-22`）。
- Key: 脚本优先——非 TTY 交互自动降级失败、`--json` 单次调用内存态、token 不回显明文。

### 修改检查清单

- [ ] 新命令是否同时支持 `--json` 与人读两种输出？
- [ ] 失败路径是否统一走 `fail()`（JSON 契约 `{ok:false,error}` + 退出码 1）？
- [ ] 变更类命令是否提供 `-y` 且非 TTY 下不会悬空？
- [ ] JSON 输出是否泄漏 token 明文？
- [ ] 对 core 新增调用是否已 `pnpm --filter @chorus/core build`（ctl 消费 dist）？
- [ ] 与 panel 语义是否一致（update 重渲染、check-tag 降级声明、test 探测 noRetry）？
