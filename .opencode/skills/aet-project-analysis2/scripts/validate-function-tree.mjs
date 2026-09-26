#!/usr/bin/env node
/**
 * validate-function-tree - 检测 function_tree.yml 是否符合 aet-project-analysis-min 模板
 *
 * 模板: .opencode/skills/aet-project-analysis-min/assets/modules/function_tree.yml
 * 规则(模板注释 + sop-module-analysis.md 硬约束):
 *   R1 顶层须为节点列表,每个节点有 id 与 type (module:/tree: 包装或自由键 → 失败)
 *   R2 type ∈ {directory, function, function_point, function_spec, function_constraint}
 *   R3 directory 的 children 只能含 directory 与 function
 *   R4 叶子必须是 function 及以下; directory 不能作叶子 (无 children/空 children 的 directory → 失败)
 *   R5 function 的 children 只能含 function_point / function_spec / function_constraint
 *   R6 function_point / function_spec / function_constraint 必须是叶子 (带 children → 失败)
 *   R7 每个节点必须有 id
 *
 * 用法:
 *   node validate-function-tree.mjs <file|dir> [<file|dir> ...] [--strict] [--format text|json] [--selftest]
 *
 * 退出码: 全 PASS → 0; 任一 FAIL → 1; 用法错误 → 2
 *
 * 零依赖: 仅用 node 内置 fs/path。YAML 子集由内嵌最小解析器处理(不引 js-yaml)。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// 最小 YAML 子集解析器
// 覆盖这些文件实际用到的语法: 行/尾注释、block sequence、block mapping、
// flow sequence(["a","b"])、单/双/无引号标量、空值、嵌套 node_context。
// 不支持: 锚点/别名、| > 折叠块、复杂键、多文档 ---。
// 输出: { roots: Node[], shape: 'list'|'map'|'empty', topKeys?, topLine? }
// 每个 Node: { id, type, children: Node[]|null, __line }
// ─────────────────────────────────────────────────────────────────────────────

// 剥离行内 # 尾注释, 但不破坏引号内的 #。
function stripComment(line) {
  let out = '';
  let inS = false; // 单引号
  let inD = false; // 双引号
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    if (ch === '#' && !inS && !inD) {
      // # 前须是空白或行首才算注释
      if (i === 0 || /\s/.test(line[i - 1])) break;
    }
    out += ch;
  }
  return out;
}

function indentWidth(line) {
  const m = line.match(/^[ \t]*/);
  return (m ? m[0] : '').replace(/\t/g, ' ').length;
}

// 解析 flow 标量: [ "a", "b" ] → ["a","b"]; [] → []; "x" → "x"; bare → string; 空 → null
function parseFlowScalar(raw) {
  const s = raw.trim();
  if (s === '') return null;
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevelCommas(inner).map(parseScalarToken);
  }
  return parseScalarToken(s);
}

function splitTopLevelCommas(s) {
  const out = [];
  let cur = '';
  let inS = false, inD = false, depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inD) { inS = !inS; cur += ch; continue; }
    if (ch === '"' && !inS) { inD = !inD; cur += ch; continue; }
    if (!inS && !inD && ch === '[') { depth++; cur += ch; continue; }
    if (!inS && !inD && ch === ']') { depth--; cur += ch; continue; }
    if (!inS && !inD && ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((p) => p.trim()).filter((p) => p !== '');
}

function parseScalarToken(tok) {
  const t = tok.trim();
  if (t === '') return null;
  if (t === '[]') return [];
  if (t === '{}') return {};
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t; // 无引号标量当字符串(校验不关心类型)
}

// 收集多行 flow list: 从 startIdx 起, 累积含 [ 到含 ] 的行, 返回 {value, consumed}
function collectMultiLineFlow(lines, startIdx) {
  let acc = lines[startIdx].body.trim();
  let idx = startIdx + 1;
  while (idx < lines.length && !acc.includes(']')) {
    acc += ' ' + lines[idx].body.trim();
    idx++;
    if (idx > lines.length) break;
  }
  return { value: parseFlowScalar(acc), nextIdx: idx };
}

// 主入口: 把文本解析成节点树(顶层若是 list) 或标记为 map/empty。
function buildTree(text) {
  const lines = tokenize(text);
  if (lines.length === 0) return { roots: [], shape: 'empty' };

  const ctx = { lines, i: 0 };
  const firstBody = lines[0].body;
  if (firstBody.startsWith('- ')) {
    return { roots: parseSequence(ctx, lines[0].indent), shape: 'list' };
  }
  // 顶层 mapping: 提取顶层 key 名(供 R1 报错指认)
  const baseIndent = lines[0].indent;
  const topKeys = [];
  while (ctx.i < lines.length && lines[ctx.i].indent === baseIndent) {
    const m = lines[ctx.i].body.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*:/);
    if (m) topKeys.push(m[1]);
    ctx.i++;
  }
  return { roots: [], shape: 'map', topKeys, topLine: lines[0].line };
}

// 预处理: 剥注释 + 去空行 + 记 {indent, body, line}
function tokenize(text) {
  const out = [];
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i++) {
    const stripped = stripComment(raw[i]);
    if (stripped.trim() === '') continue;
    const indent = indentWidth(stripped);
    out.push({ indent, body: stripped.slice(indent).replace(/\s+$/, ''), line: i + 1 });
  }
  return out;
}

// 解析一个 sequence: 当前位置起, 所有 indent == baseIndent 且 body 以 "- " 开头的项。
// 共享 ctx.i 推进。返回 Node[]。
function parseSequence(ctx, baseIndent) {
  const nodes = [];
  while (ctx.i < ctx.lines.length && ctx.lines[ctx.i].indent === baseIndent && ctx.lines[ctx.i].body.startsWith('- ')) {
    nodes.push(parseSeqItem(ctx, baseIndent));
  }
  return nodes;
}

function parseSeqItem(ctx, baseIndent) {
  const cur = ctx.lines[ctx.i];
  const node = { id: undefined, type: undefined, children: null, __line: cur.line };
  const afterDash = cur.body.slice(2); // "- " 之后

  ctx.i++;
  // inline 第一个属性: "- id: '1'"
  if (afterDash.trim() !== '') {
    const m = afterDash.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/);
    if (m) {
      applyProp(node, m[1], m[2].trim(), ctx, cur.indent);
    } else {
      node.__scalar = afterDash.trim();
    }
  }
  // 收集本 item 的后续属性行 (indent > baseIndent)
  while (ctx.i < ctx.lines.length) {
    const nxt = ctx.lines[ctx.i];
    if (nxt.indent <= baseIndent) break;
    // 子序列项? "- id: ..." (其 indent == baseIndent+2 或 baseIndent+4)
    // 这些项归 children, 在 children: 的处理中已消费; 这里遇到独立 seq 项不该出现
    // 在 item 属性区(无前置 children: key)。防御: 跳过避免死循环。
    const nBody = nxt.body;
    const km = nBody.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:(.*)$/);
    if (!km) {
      // 可能是 children 的序列项(同层 seq, indent == baseIndent+2 但前一个 key 是 children:)
      // 或多行 flow 的延续 — 都在 applyProp 里处理; 此处 break 防御
      break;
    }
    ctx.i++;
    applyProp(node, km[1], km[2].trim(), ctx, nxt.indent);
  }
  return node;
}

// 把一个 key:value 应用到 node。value 可能是 inline / 空值(后接 block map 或 seq) / flow list。
// 若 key=children 且 value 为空, 子序列项的 indent 可能 == key 的 indent(本文件约定)或更深;
// 在 applyProp 内扫描后续行收集子节点。
function applyProp(node, key, valRaw, ctx, keyIndent) {
  if (key === 'id') node.id = parseFlowScalar(valRaw);
  else if (key === 'type') node.type = parseFlowScalar(valRaw);
  else if (key === 'children') {
    const v = valRaw && valRaw.trim();
    if (v) {
      // flow 形式 children: [...] — 这些文件几乎不用
      if (v.startsWith('[')) {
        node.children = parseFlowScalar(v);
      } else {
        node.children = v; // 异常值, 留作非数组
      }
    } else {
      // children: 空值 — 子序列项可能在 key 同缩进(本文件约定)或更深
      // 向后看: 找第一个 "- " 行, 其 indent 为 childSeqIndent; 收集该层所有 seq 项
      node.children = collectChildSequence(ctx, keyIndent);
    }
  }
  // 其他字段(name/description/depends_on/node_context/spec/constraint/input/process/output/...)
  // 校验不关心, 但需消费其后续行(尤其 node_context 的嵌套 mapping 与 keywords/code_mapping 的子序列),
  // 否则后续行会被误当成 item 属性。
  else if (valRaw.trim() === '') {
    skipBlockValue(ctx, keyIndent);
  }
  // inline 非空值: 一行搞定, 无需消费更多行
}

// 消费一个 block value(在 key: 空值后): 后续所有 indent > keyIndent 的行属于此值,
// 直到回到 <= keyIndent。node_context / depends_on(多行) / keywords / code_mapping 都靠它跳过。
function skipBlockValue(ctx, keyIndent) {
  while (ctx.i < ctx.lines.length && ctx.lines[ctx.i].indent > keyIndent) {
    ctx.i++;
  }
}

// 在 children: (空值, indent=keyIndent) 之后收集子序列。
// 子序列项的 indent 可能 == keyIndent(本文件约定: children 与其子项同缩进)或 == keyIndent+2(更常见? 这些文件用同缩进)。
// 两者都兼容: 取紧随其后的第一个 "- " 行的 indent 作为 childSeqIndent, 收集该层。
function collectChildSequence(ctx, keyIndent) {
  // 回退 ctx.i 到 children: 行之后(此时 ctx.i 已在 children: 之后的下一行, 由 applyProp 调用方语义)
  // 注: applyProp 在 children 分支不消费后续行, 故 ctx.i 仍指向 children: 的下一行。
  if (ctx.i >= ctx.lines.length) return null;
  // 下一行若 indent == keyIndent 或更深, 且 body 以 "- " 开头 → 子序列
  const nxt = ctx.lines[ctx.i];
  if (!nxt.body.startsWith('- ')) {
    // 无子序列(children: 后无 seq 项) → 空叶子/占位
    return null;
  }
  const childSeqIndent = nxt.indent;
  // 校验: childSeqIndent 必须 >= keyIndent(同缩进或更深)
  if (childSeqIndent < keyIndent) return null;
  return parseSequence(ctx, childSeqIndent);
}

// ─────────────────────────────────────────────────────────────────────────────
// 校验
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_TYPES = new Set(['directory', 'function', 'function_point', 'function_spec', 'function_constraint']);
const FN_LEAF_TYPES = new Set(['function_point', 'function_spec', 'function_constraint']);

function validateTree(parsed) {
  const errors = [];
  if (parsed.shape === 'empty') {
    return { errors, warnings: [], pass: true };
  }
  if (parsed.shape === 'map') {
    const ks = (parsed.topKeys || []).join(', ');
    errors.push({
      rule: 'R1',
      line: parsed.topLine,
      msg: `顶层是 mapping(${ks}),不是节点列表 — 应以 "- id:" 起首的节点列表组织(疑似代码 dump / module: tree: 包装)`,
    });
    return { errors, warnings: [], pass: false };
  }
  walk(parsed.roots, null, errors);
  return { errors, warnings: [], pass: errors.length === 0 };
}

function walk(nodes, parentType, errors) {
  for (const n of nodes) {
    // R7: id
    if (n.id === undefined || n.id === null || n.id === '') {
      errors.push({ rule: 'R7', line: n.__line, msg: `节点缺少 id${n.type ? `(type=${n.type})` : '(无 type)'}` });
    }
    // R2: type 白名单
    if (n.type === undefined || n.type === null || n.type === '') {
      errors.push({ rule: 'R2', line: n.__line, msg: `节点缺少 type${n.id ? `(id=${n.id})` : ''}` });
    } else if (!ALLOWED_TYPES.has(n.type)) {
      errors.push({
        rule: 'R2',
        line: n.__line,
        msg: `非法 type="${n.type}"${n.id ? `(id=${n.id})` : ''} — 仅允许 directory/function/function_point/function_spec/function_constraint(疑似 class/method/signature 等代码级概念)`,
      });
    }
    const hasChildren = Array.isArray(n.children) && n.children.length > 0;
    // R6: function_point/spec/constraint 必须叶子
    if (FN_LEAF_TYPES.has(n.type) && hasChildren) {
      errors.push({ rule: 'R6', line: n.__line, msg: `${n.type}(id=${n.id}) 必须是叶子,不能有 children` });
    }
    // R4: directory 不能作叶子
    if (n.type === 'directory' && !hasChildren) {
      errors.push({ rule: 'R4', line: n.__line, msg: `directory(id=${n.id}) 不能作叶子节点 — 叶子必须是 function 及以下` });
    }
    // R3/R5: 父子类型约束
    if (parentType === 'directory' && n.type && !['directory', 'function'].includes(n.type)) {
      errors.push({ rule: 'R3', line: n.__line, msg: `directory 下出现非法子类型 type="${n.type}"(id=${n.id}) — directory 下只能有 directory/function` });
    }
    if (parentType === 'function' && n.type && !FN_LEAF_TYPES.has(n.type)) {
      errors.push({ rule: 'R5', line: n.__line, msg: `function 下出现非法子类型 type="${n.type}"(id=${n.id}) — function 下只能有 function_point/function_spec/function_constraint` });
    }
    if (hasChildren) walk(n.children, n.type, errors);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.DS_Store']);

function collectYml(input) {
  const st = statSync(input);
  if (st.isDirectory()) {
    const out = [];
    for (const name of readdirSync(input)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(input, name);
      const sub = statSync(full);
      if (sub.isDirectory()) out.push(...collectYml(full));
      else if (/\.(ya?ml)$/i.test(name)) out.push(full);
    }
    return out;
  }
  return [input];
}

function parseArgs(argv) {
  const out = { inputs: [], strict: false, format: 'text', selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') out.strict = true;
    else if (a === '--format') { const v = argv[++i]; if (v === 'text' || v === 'json') out.format = v; }
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--json') out.format = 'json';
    else if (a.startsWith('--')) { /* 未知 flag 忽略 */ }
    else out.inputs.push(a);
  }
  return out;
}

function usage() {
  return [
    '用法: node validate-function-tree.mjs <file|dir> [<file|dir> ...] [options]',
    '',
    '选项:',
    '  --strict    警告也按错误计(影响退出码)',
    '  --format X  text (默认) | json',
    '  --selftest  内置用例自测后退出',
    '',
    '退出码: 全 PASS=0; 任一 FAIL=1; 用法错误=2',
  ].join('\n');
}

function validateFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (e) {
    return { path, error: `读取失败: ${e.message}`, errors: [], warnings: [], pass: false };
  }
  let parsed;
  try {
    parsed = buildTree(text);
  } catch (e) {
    return { path, error: `YAML 解析失败: ${e.message}`, errors: [], warnings: [], pass: false };
  }
  const r = validateTree(parsed);
  return { path, error: null, errors: r.errors, warnings: r.warnings, pass: r.pass };
}

// ─────────────────────────────────────────────────────────────────────────────
// selftest
// ─────────────────────────────────────────────────────────────────────────────

function selftest() {
  const cases = [
    {
      name: '合规范例(模板形态, children 同缩进)',
      yaml: `- id: '1'
  type: directory
  name: 订单
  children:
  - id: '10'
    type: function
    name: 处理退款
    depends_on: []
    node_context:
      keywords: ["refund"]
      code_mapping: ["src/order/"]
    children:
    - id: '101'
      type: function_point
      name: 退款校验
      input: 退款请求
      process: 校验金额
      output: 通过/拒绝
`,
      expect: 'pass',
    },
    {
      name: '合规范例(children 深缩进 + 多行 code_mapping)',
      yaml: `- id: '1'
  type: directory
  name: x
  children:
    - id: '10'
      type: function
      name: f
      depends_on: ["101"]
      node_context:
        keywords:
          - a
          - b
        code_mapping:
          - "src/x/"
      children:
        - id: '101'
          type: function_spec
          name: spec1
`,
      expect: 'pass',
    },
    {
      name: 'R1 顶层 mapping(module:/tree: 包装)',
      yaml: `module: workflow
base_commit: abc
tree:
  - name: EventBus
    type: class
    file: src/core/event_bus.ts
`,
      expect: 'fail',
    },
    {
      name: 'R2 非法 type=class',
      yaml: `- id: '1'
  type: directory
  name: x
  children:
  - id: '10'
    type: class
    name: EventBus
    file: src/x.ts
`,
      expect: 'fail',
    },
    {
      name: 'R3 directory 下出现 function_point',
      yaml: `- id: '1'
  type: directory
  name: x
  children:
  - id: '10'
    type: function_point
    name: 点
`,
      expect: 'fail',
    },
    {
      name: 'R4 directory 作叶子',
      yaml: `- id: '1'
  type: directory
  name: 孤域
`,
      expect: 'fail',
    },
    {
      name: 'R5 function 下出现 directory',
      yaml: `- id: '1'
  type: directory
  name: x
  children:
  - id: '10'
    type: function
    name: f
    children:
    - id: '101'
      type: directory
      name: 不应出现
`,
      expect: 'fail',
    },
    {
      name: 'R6 function_point 带 children',
      yaml: `- id: '1'
  type: directory
  name: x
  children:
  - id: '10'
    type: function
    name: f
    children:
    - id: '101'
      type: function_point
      name: 点
      children:
      - id: '10101'
        type: function_point
        name: 嵌套
`,
      expect: 'fail',
    },
    {
      name: 'R7 节点缺 id(代码 dump - name only)',
      yaml: `- id: '1'
  type: directory
  name: x
  children:
  - name: EventBus
    type: class
    file: src/x.ts
`,
      expect: 'fail',
    },
    {
      name: '裸叶子 function(无 children, 合法)',
      yaml: `- id: '1'
  type: directory
  name: x
  children:
  - id: '10'
    type: function
    name: f
    depends_on: []
`,
      expect: 'pass',
    },
    {
      name: '顶层空文件(合法)',
      yaml: `\n\n`,
      expect: 'pass',
    },
  ];

  let fails = 0;
  for (const c of cases) {
    let parsed;
    let err = null;
    try { parsed = buildTree(c.yaml); } catch (e) { err = e.message; }
    if (err) {
      console.error(`  ✗ ${c.name}: 解析抛异常 ${err}`);
      fails++;
      continue;
    }
    const r = validateTree(parsed);
    const actual = r.pass ? 'pass' : 'fail';
    if (actual !== c.expect) {
      console.error(`  ✗ ${c.name}: 期望 ${c.expect}, 实际 ${actual}; errors=${JSON.stringify(r.errors)}`);
      fails++;
    } else {
      console.log(`  ✓ ${c.name}`);
    }
  }
  if (fails) {
    console.error(`\nselftest FAIL: ${fails} 例不符`);
    return 1;
  }
  console.log('\nselftest OK');
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) return selftest();

  if (args.inputs.length === 0) {
    process.stderr.write(usage() + '\n');
    return 2;
  }

  const files = [];
  for (const inp of args.inputs) {
    if (!existsSync(inp)) {
      process.stderr.write(`输入不存在: ${inp}\n`);
      return 2;
    }
    files.push(...collectYml(resolve(inp)));
  }
  const uniq = [...new Set(files)];
  if (uniq.length === 0) {
    process.stderr.write('未找到任何 .yml/.yaml 文件\n');
    return 2;
  }

  const results = uniq.map(validateFile);
  const passed = results.filter((r) => r.pass && !r.error).length;
  const failed = results.length - passed;

  if (args.format === 'json') {
    console.log(JSON.stringify({ results, summary: { total: results.length, passed, failed } }, null, 2));
  } else {
    for (const r of results) {
      if (r.error) {
        console.log(`FAIL  ${r.path}`);
        console.log(`      ${r.error}`);
        continue;
      }
      if (r.pass) {
        console.log(`PASS  ${r.path}`);
      } else {
        console.log(`FAIL  ${r.path}`);
        for (const e of r.errors) {
          console.log(`      ${r.path}:${e.line}  [${e.rule}] ${e.msg}`);
        }
      }
    }
    console.log(`\n${results.length} files, ${passed} passed, ${failed} failed`);
  }

  return failed > 0 ? 1 : 0;
}

const code = main();
process.exit(code);
