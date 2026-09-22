import { Command } from 'commander';
import { ChorusCore, deriveSingboxImage } from '@chorus/core';
import { isJson } from '../config.js';
import { fail, parseParams, printConfigs, printConfigDetail, printTemplates, printJson, printOk, confirm } from '../utils.js';

export const configCommand = new Command('config')
  .description('管理本地配置');

function getCore(): ChorusCore {
  return new ChorusCore();
}

/** 与 cloud/panel 一致的版本格式约束（'' = 未设置）。 */
const SINGBOX_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

configCommand
  .command('get [key]')
  .description('查看应用配置（当前仅支持 key: singbox_version）')
  .action((key?: string) => {
    if (key !== undefined && key !== 'singbox_version') {
      fail(`不支持的配置项 '${key}'（当前仅支持: singbox_version）`);
    }
    const core = getCore();
    const cfg = core.getAppConfig();
    const version = cfg.singbox_version || '';
    if (isJson()) {
      printJson({ singbox_version: version, singbox_image: deriveSingboxImage(version, cfg.singbox_image) });
      return;
    }
    if (version) {
      console.log(`singbox_version: ${version}`);
      console.log(`singbox_image:   ${deriveSingboxImage(version, cfg.singbox_image)}`);
    } else {
      console.log('singbox_version: （未设置 — 跟随 docker 模板默认）');
    }
  });

configCommand
  .command('set <key> <value>')
  .description('设置应用配置（当前仅支持 key: singbox_version，空串清除）')
  .action((key: string, value: string) => {
    if (key !== 'singbox_version') {
      fail(`不支持的配置项 '${key}'（当前仅支持: singbox_version）`);
    }
    if (value && !SINGBOX_VERSION_RE.test(value)) {
      fail(`无效版本 '${value}'，需要 X.Y.Z 格式（可带 -prerelease），例如 1.12.9`);
    }
    const core = getCore();
    core.updateAppConfig({ singbox_version: value });
    if (isJson()) {
      printJson({ singbox_version: value, cleared: value === '' });
      return;
    }
    if (value) console.log(`\x1b[32m\u2705 singbox_version 已设为 ${value}，下次部署生效\x1b[0m`);
    else console.log('\x1b[32m\u2705 singbox_version 已清除（跟随 docker 模板默认）\x1b[0m');
  });

configCommand
  .command('list')
  .description('列出所有配置')
  .action(() => {
    const core = getCore();
    try {
      printConfigs(core.configs.listAll());
    } catch (err: any) {
      fail(err.message);
    }
  });

configCommand
  .command('add')
  .description('添加新配置（通过云端模板渲染）')
  .argument('<type>', '协议类型')
  .argument('[params...]', '参数 key=value')
  .option('-n, --name <name>', '配置名称（默认取 tag 参数或协议类型）')
  .option('--node <node>', '节点名称', 'default')
  .option('--disabled', '创建后保持禁用')
  .action(async (type: string, params: string[], opts: { name?: string; node: string; disabled?: boolean }) => {
    const core = getCore();
    try {
      const templates = await core.cloud.getTemplates();
      const tmpl = templates.find((t: any) => t.type === type || t.name === type);
      if (!tmpl) {
        const available = templates.map((t: any) => `  ${t.type} (${t.name})`).join('\n');
        fail(`未知协议类型: ${type}`, `可用类型:\n${available}`);
      }

      const paramDict = parseParams(params);
      const cfgName = opts.name || paramDict['tag'] || type;
      const result = await core.generateConfig(type, paramDict);
      core.createConfig({
        name: cfgName,
        node: opts.node,
        type,
        server_config: result.server_config,
        client_config: result.client_config,
        params: { ...paramDict },
      });
      if (opts.disabled) core.configs.disable(cfgName);

      printOk(core.configs.get(cfgName), `配置 '${cfgName}' 已创建${opts.disabled ? '（禁用状态）' : ''}`);
    } catch (err: any) {
      fail(err.message);
    }
  });

configCommand
  .command('update <name>')
  .description('更新配置（节点 / 参数；参数变更后重新渲染配置内容）')
  .option('--node <node>', '迁移到其他节点名称')
  .option('--param <pairs...>', '参数覆盖 key=value（与现有参数合并）')
  .action(async (name: string, opts: { node?: string; param?: string[] }) => {
    const core = getCore();
    try {
      const existing = core.configs.get(name);
      const data: Record<string, unknown> = {};
      let params = existing.params || {};

      if (opts.node) data.node = opts.node;

      if (opts.param && opts.param.length > 0) {
        params = { ...params, ...parseParams(opts.param) };
        data.params = params;
        // 参数变化后配置内容已过期：走云端重新渲染 server/client config，
        // 与 panel 的 create/update 语义保持一致（内容与参数不脱节）。
        const result = await core.generateConfig(existing.type, params);
        data.server_config = result.server_config;
        data.client_config = result.client_config;
      }

      if (Object.keys(data).length === 0) {
        fail('未指定任何更新内容（可用 --node / --param）');
      }
      const entry = core.configs.update(name, data as Parameters<typeof core.configs.update>[1]);
      printOk(entry, `配置 '${name}' 已更新`);
    } catch (err: any) {
      fail(err.message);
    }
  });

configCommand
  .command('remove <name>')
  .description('删除配置')
  .option('-y, --yes', '跳过确认')
  .action(async (name: string, opts: { yes?: boolean }) => {
    const core = getCore();
    try {
      core.configs.get(name); // 不存在时报 CFG_NOT_FOUND，而不是误报删除成功
      if (!opts.yes) {
        const ok = await confirm(`确认删除配置 '${name}'? (y/N) `);
        if (!ok) fail(`已取消。非交互环境请使用 -y 跳过确认`);
      }
      core.configs.delete(name);
      printOk({ deleted: name }, `配置 '${name}' 已删除`);
    } catch (err: any) {
      fail(err.message);
    }
  });

configCommand
  .command('show <name>')
  .description('查看配置详情')
  .action((name: string) => {
    const core = getCore();
    try {
      printConfigDetail(core.configs.get(name));
    } catch (err: any) {
      fail(err.message);
    }
  });

configCommand
  .command('enable <name>')
  .description('启用配置')
  .action((name: string) => {
    const core = getCore();
    try {
      core.configs.enable(name);
      printOk(core.configs.get(name), `配置 '${name}' 已启用`);
    } catch (err: any) {
      fail(err.message);
    }
  });

configCommand
  .command('disable <name>')
  .description('禁用配置')
  .action((name: string) => {
    const core = getCore();
    try {
      core.configs.disable(name);
      printOk(core.configs.get(name), `配置 '${name}' 已禁用`);
    } catch (err: any) {
      fail(err.message);
    }
  });

configCommand
  .command('check-tag <tag>')
  .description('检查 tag 是否可用（本地 + 云端全节点）')
  .action(async (tag: string) => {
    const core = getCore();
    try {
      const tagOf = (e: { client_config?: { tag?: unknown } }) => String(e.client_config?.tag ?? '');
      const localConflict =
        core.configs.listAll().some((e) => tagOf(e) === tag) ||
        core.listRemoteConfigs().some((e) => tagOf(e) === tag);
      if (localConflict) {
        if (isJson()) printJson({ tag, available: false, source: 'local' });
        else console.error(`\x1b[31m\u26d4 tag '${tag}' \u5df2\u88ab\u672c\u5730\u914d\u7f6e\u5360\u7528\x1b[0m`);
        process.exit(1);
      }
      const available = await core.cloud.checkTagAvailable(tag);
      if (isJson()) printJson({ tag, available });
      else if (available) console.log(`\x1b[32m\u2705 tag '${tag}' \u53ef\u7528\x1b[0m`);
      else {
        console.error(`\x1b[31m\u26d4 tag '${tag}' \u5df2\u88ab\u4e91\u7aef\u5176\u4ed6\u8282\u70b9\u5360\u7528\x1b[0m`);
        process.exit(1);
      }
    } catch (err: any) {
      // 云端不可达时降级为仅本地检查（与 panel check-tag 语义一致），
      // 但要显式说明远端检查被跳过，避免给出误导性的「可用」结论。
      if (isJson()) printJson({ tag, available: true, source: 'local_only', detail: err.message });
      else console.log(`\x1b[33m\u26a0 \u4e91\u7aef\u4e0d\u53ef\u8fbe\uff0c\u4ec5\u672c\u5730\u68c0\u67e5: tag '${tag}' \u53ef\u7528\uff08${err.message}\uff09\x1b[0m`);
    }
  });

configCommand
  .command('check-port <port>')
  .description('检查本机监听端口是否与已有配置冲突')
  .action((port: string) => {
    const core = getCore();
    const p = Number(port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) {
      fail(`无效端口 '${port}'，需要 1-65535 的整数`);
    }
    const conflict = core.configs.listAll().find((e) => {
      const lp = Number(e.server_config?.listen_port ?? e.client_config?.server_port);
      return Number.isInteger(lp) && lp === p;
    });
    if (isJson()) printJson({ port: p, available: !conflict, conflictWith: conflict?.name ?? null });
    else if (!conflict) console.log(`\x1b[32m\u2705 \u7aef\u53e3 ${p} \u53ef\u7528\x1b[0m`);
    else console.error(`\x1b[31m\u26d4 \u7aef\u53e3 ${p} \u4e0e\u914d\u7f6e '${conflict.name}' \u51b2\u7a81\x1b[0m`);
    if (conflict) process.exit(1);
  });

configCommand
  .command('templates')
  .description('列出可用协议模板')
  .action(async () => {
    const core = getCore();
    try {
      printTemplates(await core.cloud.getTemplates());
    } catch (err: any) {
      fail(err.message);
    }
  });
