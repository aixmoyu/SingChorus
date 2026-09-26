### SOP: Review Module Artifacts

<guideline>

- **对抗式（try-to-refute），非顺从**：每个验证 Subagent 的默认立场是「这条结论是错的或无证据支撑的」，必须主动找反证（实际代码与产物断言矛盾的证据），而非顺向确认。找不到反证才判通过。
- **独立 context**：验证 Subagent 必须使用独立 context，**不继承生成阶段记忆**——这是避免继承生成盲区、保证验证客观性的关键。
- **只验证、不修改产物**：修正由主 agent 执行；验证 Subagent 只输出通过/失败 + 反证证据。

</guideline>

<instruct>

### 对抗式验证

所有模块产物落盘后，主 agent 对 `subsystems/<module_id>/` 全量产物发起验证。

- 加载 `references/validation-template.md` 获取验证委托提示词模板，注入变量后经 Agent 工具委托（scope = `subsystems/<module_id>/` 模块产物）。
- 验证 Subagent 的验证范围：
  1. **证据真实性**：产物中每条 `path/to/file:line` 是否真实指向所述代码？打开核对，不符即失败（附实际代码片段）。
  2. **结论越界检测**：结论是否超出代码事实（臆测填充、用经验补未体现的实现细节）？任何无证据支撑的断言即失败。
  3. **base_commit 一致性**：frontmatter 是否含 `base_commit` 且与当前基准一致？
  4. **跨文档一致性**（模块产物与全局主文档对齐）：
     - 模块 ID 与 `architecture_views` 主文档一致
     - 模块依赖与 `boundaries.md` 声明的上下游对齐
     - 分层信息与 `architecture_views` 的分层视图一致

### 修复并复验

- 对检出问题的产物，主 agent **必须**修正后方可结束，不得带错收尾。
- **严重问题**（证据造假或臆测填充项）须重写该条结论，不得修补式粉饰——重读代码重写。
- 修正后对受影响条目复验一轮，直至无未解决事实冲突或全部转为 `[待确认]` 由用户裁决。

</instruct>

<constraint>

- NEVER 让生成阶段的 Subagent 兼任验证角色——验证须独立 context、对抗式立场，否则继承盲区使验证失效。
- NEVER 以 README/wiki 等文档为事实来源——文档可能过时，结论一律以代码/配置为准。

</constraint>

<patch>

- 用户跳过本阶段时，必须在收尾报告中声明"未经独立验证"以明示风险。
- 检出证据造假或臆测填充的结论立即作废，重读代码重写，不得修补式粉饰。

</patch>
