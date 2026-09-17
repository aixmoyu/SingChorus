import type { CtlConfig } from './config.js';

export function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

export function fmtBool(v: boolean): string {
  return v ? '\u2705' : '\u26d4';
}

export function shouldJson(cfg: CtlConfig): boolean {
  return cfg.jsonOutput;
}

interface ConfigEntry {
  name: string
  type?: string
  node?: string
  enabled?: boolean
  synced?: boolean
  created_at?: string
  updated_at?: string
  params?: Record<string, unknown>
  server_config?: Record<string, unknown>
  client_config?: Record<string, unknown>
}

export function printConfigs(configs: ConfigEntry[], cfg: CtlConfig) {
  if (shouldJson(cfg)) { printJson(configs); return; }
  const rows = configs.map(c => ({
    Name: c.name,
    Type: c.type || '',
    Node: c.node || '',
    Status: fmtBool(!!c.enabled),
    Sync: c.synced ? '\u2705' : '\u23f3',
  }));
  console.table(rows);
}

export function printConfigDetail(config: ConfigEntry, cfg: CtlConfig) {
  if (shouldJson(cfg)) { printJson(config); return; }
  console.log(`\n\x1b[36m\u914d\u7f6e: ${config.name}\x1b[0m`);
  console.log(`  \u7c7b\u578b: ${config.type || ''}`);
  console.log(`  \u8282\u70b9: ${config.node || ''}`);
  console.log(`  \u72b6\u6001: ${fmtBool(!!config.enabled)}`);
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

export function printTemplates(templates: TemplateInfo[], cfg: CtlConfig) {
  if (shouldJson(cfg)) { printJson(templates); return; }
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

interface DeployStatus {
  status?: string
  container_name?: string
}

export function printDeployStatus(status: DeployStatus, cfg: CtlConfig) {
  if (shouldJson(cfg)) { printJson(status); return; }
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

export function printCloudStatus(status: CloudStatus, cfg: CtlConfig) {
  if (shouldJson(cfg)) { printJson(status); return; }
  const icon = status.connected ? '\u2705' : '\u26d4';
  console.log(`\n\u4e91\u7aef\u72b6\u6001: ${icon} ${status.connected ? '\u5df2\u8fde\u63a5' : '\u672a\u8fde\u63a5'}`);
  if (status.message) {
    console.log(`  \u6d88\u606f: ${status.message}`);
  }
}
