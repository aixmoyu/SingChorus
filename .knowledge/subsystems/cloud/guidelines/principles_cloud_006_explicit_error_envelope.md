---
project: SingChorus
type: development-principle
id: principle-cloud-006
description: 所有错误以 {error:{code,message}} 信封返回、语义化 code 全表收口；每一个 fail-open（吊销检查、限流器缺失、审计写入）与每一个透传（500 带 err.message）都必须是注释声明的显式取舍。
base_commit: 5ab6e0b5439b72f3af60ca178147e57dc3fc31d9
principle_category: 工程
---

# 显式错误信封与 fail-open 声明制

## 原则详细描述

错误出口收敛为两处：路由内显式返回与全局 `app.onError`。PluginError（引擎族，errors.ts）统一映射 400 保留 code；其余异常返回 500 INTERNAL_ERROR 且**包含 err.message 但绝不包含堆栈**（index.ts:76-94）。跨模块消费语义成立的前提是 core 按 code 分派：5xx 退避、401 换 token、DB_UNAVAILABLE 触发退避（cloud-client.ts:183-214）。所有「弱化失败」的点位——JWT 吊销 fail-open（middleware.ts:41-55）、限流器缺失放行（subscriptions.ts:197-203）、审计写入吞错（audit.ts:28-30）、缓存写失败吞错（subscriptions.ts:80-82）——必须在代码内注释说明风险窗口与理由。

## 为什么要这样

- 管理员 API 的 actionable detail 优于不透明：D1 错误信息能直接指引修复（index.ts:78-80 注释显式声明该取舍），堆栈则属于日志而非响应。
- fail-open 不是疏漏而是被评审过的取舍：吊销检查 fail-open 的风险窗口由「签名已验 + 24h TTL」限定（middleware.ts:25-27 注释）；若静默实现，后人无法评估其安全含义。
- 唯一约束冲突必须翻译成语义化 409（如 SUB_PATH_DUPLICATE，subscriptions.ts:441-449），禁止把 sqlite 原始错误抛给调用方。

## 适用范围

- 全部路由与中间件的错误路径；新增任何 catch 块。

## 规则

- 错误信封形状固定 `{error:{code,message}}`；code 使用 SCREAMING_SNAKE 并收录进 module_design.md 错误码表。
- PluginError 用于引擎域（400 语义）；不要在路由业务里滥用 PluginError 表达非引擎错误。
- 新的 fail-open/吞错点位必须注释：为什么、风险窗口、有何兜底。
- 交付链路（/s/:path）错误信息应对终端用户白名单化（当前残余风险见 risk.md 技术债）。

## 反模式 / 禁止项

- 裸抛 sqlite/D1 原始错误文本给调用方（UNIQUE 冲突除外——也必须翻译）。
- 无注释的空 catch。
- 返回堆栈、绑定值、内部路径等实现细节。

## 修改检查清单

- [ ] 新错误码是否已入错误码表？core 侧消费语义是否明确？
- [ ] 新 catch 是否注释了取舍？
- [ ] PluginError/其他异常的分类是否正确（400 vs 500）？
