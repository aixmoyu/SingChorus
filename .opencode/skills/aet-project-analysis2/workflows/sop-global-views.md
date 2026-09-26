### SOP: Global Views

<guideline>

- **先图后读**：在任何深度探索之前先看图谱导航（God Nodes / Top Communities / Surprising Connections / Top Files），再决定细看哪里。
- **密度约束**：Subagent 输出严格 `Key: Value` 或简短陈述，一行一事，代码引用带 `[file:line]`，单 Subagent 引用代码不超 10 行。
- **Gap Backfill 是落盘前置门**：缺项必补读，不补完不落盘，填不上标 `[待确认: 提示问题]` 回传主 agent。
- **汇总合成纯逻辑**：四份返回值回传后，主 agent 合并候选清单时不读文件——读文件已由 Subagent 完成。

</guideline>

<instruct>

### 并行探索并落盘四视图

四个 Subagent 并行执行，按维度切分（非按输出文档）。每个引擎契约：定向探索 → 读 `<skills path>/assets/global/<视图>.md` 对齐模板 → 落盘 `<output-dir>/architecture_views/<view>.md`（frontmatter 必须含 `base_commit`）→ 回传「探索发现 + 设计决策痕迹 + 原则 + 风险」四类候选，各附证据 `path/to/file:line`。

| 引擎 | 视图文件 | 探索动作（核心问题） |
|------|----------|----------------------|
| 逻辑 Logical | `logical_view.md` | 扫包/目录结构、识别核心抽象与接口、分析依赖方向，回答"系统由哪些核心模块组成，各自承担什么职责" |
| 开发 Development | `development_view.md` | 检查 pom.xml / package.json / Cargo.toml 等依赖配置、分析分层、识别规范违例，回答"代码怎么组织和编译" |
| 进程 Process | `process_view.md` | 搜索并发原语（async/await、线程池、锁）、分析消息队列消费逻辑、追踪调用走向，回答"运行时线程与进程如何协作" |
| 部署+风险 Deployment & Risk | `deployment_view.md` | 查找 Dockerfile / K8s YAML / Terraform / 数据库连接配置；检索硬编码凭证、缺异常捕获、无熔断降级等反模式，回答"系统部署在哪里，存在哪些架构风险" |

加载 `references/subagent-explore-template.md` 获取委托提示词模板，注入维度变量后经 Agent 工具逐维度套用（委托的 Subagent 须具备 write 权限）。

**Gap Backfill**：每个 Subagent 落盘前自检视图模板各节是否填齐——识别出的缺项**必须回去补读对应代码再落笔**，严禁缺项留空或臆测填充；填不上者标 `[待确认: 提示问题]` 并回传主 agent。**不补完不落盘**。

### 汇总合成全局 scenario + ADR + 原则 + risk

四份返回值回传后，主 agent 执行：

1. **汇总候选清单**（纯逻辑，不读文件）：
   - 合并四份「探索主要发现」→ 场景候选 `[SC]`
   - 合并四份「提炼原则」并跨源去重、统一分类 → 原则候选 `[G]`。原则提炼遵循四条抽象规则：
     - **Code First**：每条原则必须有代码/架构/模块文档证据，无证据不上榜。
     - **先合并共性**：跨多个模块反复出现的规则，优先合并为项目级原则，而非重复罗列。
     - **区分 scope**：仅适用单模块→模块原则；适用一类模块→类原则；贯穿全项目→项目原则；在 `principles-template.md` 的 `principle_scope` 字段标注。
     - **防过度泛化**：不得把"某模块的习惯"直接升级为全局标准，需有跨模块共性证据支撑。
   - 从四份「设计决策痕迹」识别并去重**已发生的架构决策** → ADR 候选 `[A]`
   - 合并四份「风险」条目 → 风险候选 `[R]`
2. 仍有不懂的继续探索代码仓库，补充候选后再合成（Gap Backfill：候选清单缺证据项必须回去补读代码，不得空缺推进）。
3. **生成文档（无须委托 Subagent）**：
   - **scenario_view.md**：输入 `[SC]` + 四视图路径与要点；读 `<skills path>/assets/global/scenario_view.md`，产出 3-6 个核心场景 + 追溯矩阵（须引用四视图）。
   - **guidelines**：输入 `[G]`；读 `<skills path>/assets/global/guidelines/principles-template.md`，逐条产出原则。
   - **ADRs**：输入 `[A]`；读 `<skills path>/assets/global/adrs/architecture_adr_00x.md`，为每个决策产出 ADR（≥2 候选方案）。
   - **risk.md**：输入 `[R]`；读 `<skills path>/assets/global/risk.md`，产出风险条目。

</instruct>

<constraint>

- NEVER 在缺项未补读代码前落盘视图——Gap Backfill 是落盘前置门，缺项留空即等同臆测。
- NEVER 用经验推断填补代码未体现的实现细节——虚构证据会使知识库在下次 `base_commit` 漂移时静默失真。
- 汇总合成阶段不得再委托 Subagent 读文件——Subagent 探索的返回值已是唯一素材源。

</constraint>

<patch>

- ALWAYS 为每个产物 frontmatter 填入当前 `base_commit`，确保结论可回溯到具体提交。
- 证据颗粒度优先文件夹路径（如 `src/domain/user/`），避免逐文件罗列膨胀 `code_mapping`。
- 每份视图落盘后须通过其模板末节的 self-check 清单。

</patch>
