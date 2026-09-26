### SOP: Module Analysis

<guideline>

- **划分是主观决定，代码给不了正确答案**：生成 2-3 种粒度方案，按「推荐 X，因为 Y」格式提问（先给主 agent 推荐与依据，再列备选），由用户选定。
- **按深度差异化投入，非等量分析**：依据 S1 视图的依赖关系与模块职责给每个选定模块定级，决定落盘深度。
- **扁平分析**：若 Modules.md 中存在子模块，对所有模块扁平分析，不嵌套剖析子模块。
- **Gap Backfill 是落盘前置门**：Subagent 落盘前自检 6 类模板各节，缺项回去补读代码再落笔，不补完不落盘。
- **返回值契约（与全局阶段统一）**：每个模块 Subagent 不只回传文件路径，须同时回传「本模块探索发现 + 设计决策痕迹 + 提炼原则 + 风险」四类候选（各附证据 `path/to/file:line`），供全局功能树合并复用。

</guideline>

<instruct>

### 生成模块划分方案并建骨架

1. 基于图谱社区、先验知识与全局视图结论，结合少量代码探索，生成 2-3 种模块划分方案（考虑划分粒度差异、是否引入二级子域），按「**推荐方案 X，因为 Y**」格式提问（先给主 agent 推荐与依据，再列备选），由用户选定。
2. 基于选定方案确定模块划分（优先按文件夹边界），在 `<output-dir>/subsystems/<module_id>/{guidelines,adrs}/` 建立骨架，下发种子数据。

**完成标准**：模块划分经用户确认，每个 `<module_id>/{guidelines,adrs}/` 骨架存在并下发种子数据。

### 模块选择（多选门）

划分方案确认后，**不得直接对全部模块并行分析**——先让用户选定本次要分析的模块集合。

1. 基于已确认的划分方案，给每个模块**编号**并列出清单：`[1] <module_id> — <一句话职责> [优先级]`（优先级由下表分级得出）。
2. 按「**推荐 X，因为 Y**」格式先给主 agent 推荐范围（如「推荐先分析 High 优先级 3 个模块，因为它们被多数模块依赖且含核心业务逻辑」），再用 `AskUserQuestion`（`multiSelect: true`）让用户勾选需要分析的模块，并提供「全部分析」选项。
3. 用户选定后，仅对选定模块进入并行分析；未选模块跳过剖析（仅保留骨架）。

**优先级分级**（用于编号清单的推荐依据与后续落盘深度）：

| 优先级 | 判定标准 | 分析深度 |
|--------|----------|----------|
| High | 被多数模块依赖 / 含核心业务逻辑 / 高频修改 | 完整：6 类产物全节填齐，所有公共接口逐签名核对 |
| Medium | 中等依赖 / 专门领域逻辑 | 标准：完整公共接口 + 关键流程，省略次要内部函数与算法细节 |
| Low | 工具类 / 配置 / 极少修改 | 简化：主要接口契约 + 依赖关系 + risk，省略 module_design 内部实现详节 |

**完成标准**：用户已通过多选门选定模块集合（「全部」或编号子集）；未选模块不剖析。

### 并行分析选定模块

每个模块一个 Subagent，模板读取与落盘均在 Subagent 内完成（须 write 权限）。

- **探索范围**：以本模块 `code_mapping` 为主，跨模块依赖仅核对接口契约。
- **落盘文件**（6 类，带 `base_commit`，模板见 `<skills path>/assets/modules/`）：`function_tree.yml`、`boundaries.md`、`module_design.md`、`risk.md`、`guidelines/*.md`、`adrs/*.md`。
- **功能树对齐模板**（硬约束）：落盘 `function_tree.yml` 前**必须先读 `<skills path>/assets/modules/function_tree.yml` 模板**，严格套用其结构——`directory → function → function_point / function_spec / function_constraint`，**叶子节点必须是 `function`**（不得以 `directory` 结尾）。`function` 是**业务功能**（"verb + noun" 命名，如「管理订单」「处理退款」），**严禁**以 class / Function / Method / signature / visibility 等代码级概念作为节点类型或节点名。`function` 下按需挂 `function_point`（本功能点专属 spec/constraint）、`function_spec`（对整个 function 生效）、`function_constraint`（对整个 function 生效）。
- **Gap Backfill**：Subagent 落盘前自检 6 类模板各节，缺项回去补读对应代码再落笔，填不上者标 `[待确认]` 回传；**不补完不落盘**。功能树自检须额外核对：有无 directory 误当叶子、有无 class/method 节点——不符回去重构再落盘。
- **返回值契约**：回传「本模块探索发现 + 设计决策痕迹 + 提炼原则 + 风险」四类候选（各附证据 `path/to/file:line`），供全局功能树合并复用。

### 全局功能树合并（业务视角）

合并产物**仍是 function tree**（不是 domain tree）——命名、结构、语义均与 `assets/modules/function_tree.yml` 模板一致，仅多了跨模块合并字段。

#### 判定业务去重

汇总 N 份模块功能树与挂钩清单，基于统一语言重叠、调用/事件关系、数据/状态共享及语义等价合并同类业务功能。反例（如通用校验、同名独立策略）严禁合并，标 `[待确认]`。

**完成标准**：每条合并均能说明合并依据；不得合并项标注 `[待确认]` 并列明理由。

#### 落盘全局功能树并回写

1. 落盘 `<output-dir>/architecture_views/function_tree.yml`（**文件名必须是 `function_tree.yml`，不得改成 domain_tree.yml**）。
2. 全局 function tree **必须套用 `assets/modules/function_tree.yml` 模板**的同一结构：`directory → function → function_point / function_spec / function_constraint`，叶子节点必须是 `function`，业务命名；**严禁**以 class/Method/signature 等代码级概念组织节点。合并后的 `function` 节点在模板字段之上额外携带 `module_refs`（参与实现的模块列表）。
3. `type: function` 节点配置 `module_refs`（参与实现的模块列表）、`node_context.code_mapping`（聚合折叠路径）及 `depends_on`。
4. 回写受影响模块的 `boundaries.md` 与 `function_tree.yml`。

**完成标准**：`function_tree.yml` 落盘且**结构符合模板**（叶子为 function、无 class/method 节点）；`function` 节点 `module_refs` + `node_context.code_mapping` + `depends_on` 三字段齐备；受影响模块的 `boundaries.md` 与 `function_tree.yml` 已同步回写。

</instruct>

<constraint>

- NEVER 在未确认划分方案前并行启动任何模块 Subagent——划分确认是后续分析的硬闸门。
- NEVER 用经验推断填补代码未体现的实现细节——虚构证据会使知识库在下次 `base_commit` 漂移时静默失真。
- 模块 `/components` 均为平级分析（扁平，不嵌套剖析子模块）；无绝对路径。

</constraint>

<patch>

- ALWAYS 为每个模块产物 frontmatter 填入当前 `base_commit`。
- 证据颗粒度优先文件夹路径，避免逐文件罗列膨胀 `code_mapping`。
- 模块数 > 8 时，展示优先级分级结论由用户确认范围（全量 or 先高优先级），未选模块不剖析。

</patch>
