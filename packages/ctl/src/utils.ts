import readline from 'readline';
import { isJson } from './config.js';

export function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

export function fmtBool(v: boolean): string {
  return v ? '\u2705' : '\u26d4';
}

/**
 * 统一错误出口：JSON 模式输出 { ok: false, error } 契约（R-CTL-D4），
 * 人读模式输出红色错误文案，随后以退出码 1 结束进程。
 */
export function fail(message: string, detail?: unknown): never {
  if (isJson()) {
    const extra = detail === undefined ? {} : { detail };
    console.log(JSON.stringify({ ok: false, error: message, ...extra }, null, 2));
  } else {
    console.error(`\x1b[31m\u9519\u8bef: ${message}\x1b[0m`);
  }
  process.exit(1);
}

/**
 * 解析 `key=value` 形式的参数列表；无 '=' 的条目直接报错而不是静默跳过，
 * 避免 CLI 吞掉用户拼错的参数。
 */
export function parseParams(tokens: string[]): Record<string, string> {
  const dict: Record<string, string> = {};
  for (const t of tokens) {
    const eqIdx = t.indexOf('=');
    if (eqIdx <= 0) fail(`无效参数 '${t}'，期望 key=value 形式`);
    dict[t.slice(0, eqIdx)] = t.slice(eqIdx + 1);
  }
  return dict;
}

/**
 * 交互式确认。非 TTY（脚本/管道）环境下返回 false，由调用方决定
 * 是否以「需要 -y」的提示失败 —— 这保证脚本集成永远不会被悬空的
 * stdin 提示卡住。
 */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => {
    rl.question(question, (ans) => resolve(ans));
  });
  rl.close();
  return /^\s*y(es)?\s*$/i.test(answer);
}

/** 变更类命令的统一成功输出：JSON 模式回显结果对象，人读模式输出绿色文案。 */
export function printOk(data: unknown, message: string) {
  if (isJson()) printJson(data);
  else console.log(`\x1b[32m\u2705 ${message}\x1b[0m`);
}

interface ConfigEntry {
  name: string
  type?: string
  node?: string
  enabled?: boolean
  deployed?: boolean
  synced?: boolean
  created_at?: string
  updated_at?: string
  params?: Record<string, unknown>
  server_config?: Record<string, unknown>
  client_config?: Record<string, unknown>
}

export function printConfigs(configs: ConfigEntry[]) {
  if (isJson()) { printJson(configs); return; }
  const rows = configs.map(c => ({
    Name: c.name,
    Type: c.type || '',
    Node: c.node || '',
    Status: fmtBool(!!c.enabled),
    Deployed: fmtBool(!!c.deployed),
    Sync: c.synced ? '\u2705' : '\u23f3',
  }));
  console.table(rows);
}

export function printConfigDetail(config: ConfigEntry) {
  if (isJson()) { printJson(config); return; }
  console.log(`\n\x1b[36m\u914d\u7f6e: ${config.name}\x1b[0m`);
  console.log(`  \u7c7b\u578b: ${config.type || ''}`);
  console.log(`  \u8282\u70b9: ${config.node || ''}`);
  console.log(`  \u72b6\u6001: ${fmtBool(!!config.enabled)}`);
  console.log(`  \u90e8\u7f72: ${fmtBool(!!config.deployed)}`);
  console.log(`  \u540c\u6b65: ${config.synced ? '\u2705' : '\u23f3'}`);
  console.log(`  \u521b\u5efa: ${config.created_at || ''}`);
  console.log(`  \u66f4\u65b0: ${config.updated_at || ''}`);
  if (config.params && Object.keys(config.params).length > 0) {
    console.log('\n  \x1b[1m\u53c2\u6570:\x1b[0m');
    for (const [k, v] of Object.entries(config.params)) {
      console.log(`    ${k}: ${v}`);
    }
  }
}

interface TemplateInfo {
  name?: string
  version?: string
  type?: string
  schema?: { params?: Array<{ name: string; type?: string; required?: boolean; description?: string }> }
}

export function printTemplates(templates: TemplateInfo[]) {
  if (isJson()) { printJson(templates); return; }
  for (const t of templates) {
    console.log(`\n\x1b[36m${t.name || ''}\x1b[0m (v${t.version || 1})`);
    console.log(`  \u7c7b\u578b: ${t.type || ''}`);
    const params = t.schema?.params || [];
    if (params.length > 0) {
      console.log('  \x1b[1m\u53c2\u6570:\x1b[0m');
      for (const p of params) {
        const req = p.required ? ' *' : '';
        const desc = p.description ? ` - ${p.description}` : '';
        console.log(`    \u2022 ${p.name}\x1b[31m${req}\x1b[0m (${p.type || 'string'})${desc}`);
      }
    }
  }
}

export function printDeployStatus(status: { status?: string; container_name?: string }) {
  if (isJson()) { printJson(status); return; }
  const s = status.status || 'unknown';
  const icon = s === 'running' ? '\u2705' : '\u26d4';
  console.log(`\n\u90e8\u7f72\u72b6\u6001: ${icon} \x1b[1m${s}\x1b[0m`);
  if (status.container_name) {
    console.log(`  \u5bb9\u5668: ${status.container_name}`);
  }
}

interface CloudStatus {
  connected: boolean
  message?: string
}

export function printCloudStatus(status: CloudStatus) {
  if (isJson()) { printJson(status); return; }
  const icon = status.connected ? '\u2705' : '\u26d4';
  console.log(`\n\u4e91\u7aef\u72b6\u6001: ${icon} ${status.connected ? '\u5df2\u8fde\u63a5' : '\u672a\u8fde\u63a5'}`);
  if (status.message) {
    console.log(`  \u6d88\u606f: ${status.message}`);
  }
}

interface RemoteConfigEntry {
  name: string
  node?: string
  type?: string
  enabled?: boolean
  node_fingerprint?: string
  updated_at?: string
}

export function printRemoteConfigs(configs: RemoteConfigEntry[]) {
  if (isJson()) { printJson(configs); return; }
  if (configs.length === 0) {
    console.log('\u6ca1\u6709\u8fdc\u7aef\u914d\u7f6e');
    return;
  }
  const rows = configs.map(c => ({
    Name: c.name,
    Type: c.type || '',
    Node: c.node || c.node_fingerprint || '',
    Status: fmtBool(!!c.enabled),
    Updated: c.updated_at || '',
  }));
  console.table(rows);
}

export function printSyncStatuses(statuses: Record<string, string>, failures?: Array<{ name: string; message: string }>) {
  if (isJson()) { printJson({ statuses, failures: failures || [] }); return; }
  const rows = Object.entries(statuses).map(([name, status]) => ({ Name: name, Status: status }));
  if (rows.length === 0) {
    console.log('\u6ca1\u6709\u914d\u7f6e');
  } else {
    console.table(rows);
  }
  if (failures && failures.length > 0) {
    console.error('\n\x1b[31m\u6700\u8fd1\u540c\u6b65\u5931\u8d25:\x1b[0m');
    for (const f of failures) {
      console.error(`  ${f.name}: ${f.message}`);
    }
  }
}

export function printSubscription(sub: {
  id?: string; name?: string; path?: string; active?: boolean;
  singboxVersion?: string;
  overallTemplateId?: string | null; token?: string; createdAt?: string; updatedAt?: string;
}) {
  if (isJson()) { printJson(sub); return; }
  console.log(`\n\u8ba2\u9605: ${sub.name || ''}`);
  console.log(`  \u8def\u5f84: ${sub.path || ''}`);
  console.log(`  \u72b6\u6001: ${fmtBool(!!sub.active)}`);
  console.log(`  sing-box \u7248\u672c: ${sub.singboxVersion || '(\u672a\u7ed1\u5b9a)'}`);
  console.log(`  \u6574\u4f53\u6a21\u677f: ${sub.overallTemplateId || '(\u65e0\uff0c\u4f7f\u7528\u9ed8\u8ba4\u5408\u5e76)'}`);
  console.log(`  \u521b\u5efa: ${sub.createdAt || ''}`);
  console.log(`  \u66f4\u65b0: ${sub.updatedAt || ''}`);
  console.log(`  \u8ba2\u9605 URL: /s/${sub.path || ''}?token=${(sub.token || '').slice(0, 8)}...`);
}
