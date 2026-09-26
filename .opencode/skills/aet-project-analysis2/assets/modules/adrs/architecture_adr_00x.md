---
project: [Project Name]
type: adr
id: ADR-order-001  # ADR-<module_id>-<nnn>
description: [2-3 句话：本 ADR 的最终决策结果摘要]
base_commit: e7a3f1c92b4d5860a1f3c8e7b2d4a6f9c0e1b3d5
status: accepted  # proposed(仅 adr 起步)/accepted/deprecated/superseded
title: "[ADR 标题]"
date: YYYY-MM-DD
code_refs:
  - [源码路径，追溯用]

---

# ADR-001: [决策标题]

## 状态

[proposed / accepted / deprecated / superseded by ADR-XXX]

## 1. 背景

<!-- guideline: 描述触发此决策的具体业务/技术背景，以及需要解决的核心问题。避免模糊描述，要有数字和具体场景。 -->

**业务背景**：[描述触发决策的业务场景]
**技术背景**：[描述当前的技术现状和约束]
**核心问题**：[用一个明确的问题句式描述需要决策的内容]

> 例：在订单高峰期（预估 TPS 5000），如何保证订单创建的数据一致性，同时将 P99 延迟控制在 200ms 以内？

**约束条件**：

- [约束 1]：[说明]
- [约束 2]：[说明]

## 2. 决策驱动因素（Decision Drivers）

<!-- guideline: 列出影响决策的关键因素，按重要性排序。 -->

1. **[因素 1]**（重要性：高）：[说明]
2. **[因素 2]**（重要性：中）：[说明]
3. **[因素 N]**（重要性：低）：[说明]

## 3. 候选方案（Considered Options）

<!-- guideline: 列出所有被认真考虑的方案（不少于 2 个），每个方案必须有优缺点分析。 -->

|方案|简述|优点|缺点|风险|
|-|-|-|-|-|
|Option A|[]|[]|[]|[]|
|Option B|[]|[]|[]|[]|
|Option C|[]|[]|[]|[]|

### Option A：[方案名称详述]

[展开描述方案 A 的实现思路]

### Option B：[方案名称详述]

[展开描述方案 B 的实现思路]

## 4. 决策结果（Decision Outcome）

**选择方案**：**Option [X]**
**选择理由**：[解释为何选择此方案，对照决策驱动因素逐条说明]

### 4.1 实施要点

- [关键实施步骤 1]
- [关键实施步骤 2]

## 备注

[任何额外上下文、参考链接、讨论记录等]