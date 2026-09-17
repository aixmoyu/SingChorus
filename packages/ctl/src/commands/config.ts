import { Command } from 'commander';
import { ChorusCore } from '@chorus/core';
import { loadCtlConfig } from '../config.js';
import { printConfigs, printConfigDetail, printTemplates } from '../utils.js';

export const configCommand = new Command('config')
  .description('管理本地配置');

configCommand
  .command('list')
  .description('列出所有配置')
  .action(() => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      const configs = core.configs.listAll();
      printConfigs(configs, cfg);
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

configCommand
  .command('add')
  .description('添加新配置')
  .argument('<type>', '协议类型')
  .argument('[params...]', '参数 key=value')
  .option('-n, --name <name>', '配置名称')
  .option('--node <node>', '节点名称', 'default')
  .action(async (type: string, params: string[], opts: { name?: string; node: string }) => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      const templates = await core.cloud.getTemplates();
      const tmpl = templates.find((t: any) => t.type === type || t.name === type);
      if (!tmpl) {
        console.error(`\x1b[31m\u672a\u77e5\u534f\u8bae\u7c7b\u578b: ${type}\x1b[0m`);
        console.error('可用类型:');
        for (const t of templates) {
          console.error(`  ${t.type} (${t.name})`);
        }
        process.exit(1);
      }

      const paramDict: Record<string, string> = {};
      for (const p of params) {
        const eqIdx = p.indexOf('=');
        if (eqIdx > 0) {
          paramDict[p.slice(0, eqIdx)] = p.slice(eqIdx + 1);
        } else {
          console.warn(`\x1b[33m\u8df3\u8fc7\u65e0\u6548\u53c2\u6570: ${p}\x1b[0m`);
        }
      }

      const cfgName = opts.name || paramDict['tag'] || type;
      const result = await core.cloud.generateConfig(type, paramDict);
      const entry = core.createConfig({
        name: cfgName,
        node: opts.node,
        type,
        server_config: result.server_config,
        client_config: result.client_config,
        params: { ...paramDict },
      });

      if (cfg.jsonOutput) {
        console.log(JSON.stringify(entry, null, 2));
      } else {
        console.log(`\x1b[32m\u2705 \u914d\u7f6e '${cfgName}' \u5df2\u521b\u5efa\x1b[0m`);
      }
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

configCommand
  .command('remove')
  .description('删除配置')
  .argument('<name>', '配置名称')
  .option('-y, --yes', '跳过确认')
  .action((name: string, opts: { yes?: boolean }) => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    if (!opts.yes) {
      console.log(`确认删除配置 '${name}'? 使用 -y 强制删除`);
      process.exit(0);
    }
    try {
      core.configs.delete(name);
      if (cfg.jsonOutput) {
        console.log(JSON.stringify({ deleted: true, name }));
      } else {
        console.log(`\x1b[32m\u2705 \u914d\u7f6e '${name}' \u5df2\u5220\u9664\x1b[0m`);
      }
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

configCommand
  .command('show')
  .description('查看配置详情')
  .argument('<name>', '配置名称')
  .action((name: string) => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      const config = core.configs.get(name);
      printConfigDetail(config, cfg);
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

configCommand
  .command('enable')
  .description('启用配置')
  .argument('<name>', '配置名称')
  .action((name: string) => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      core.configs.enable(name);
      if (cfg.jsonOutput) {
        console.log(JSON.stringify({ enabled: true, name }));
      } else {
        console.log(`\x1b[32m\u2705 \u914d\u7f6e '${name}' \u5df2\u542f\u7528\x1b[0m`);
      }
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

configCommand
  .command('disable')
  .description('禁用配置')
  .argument('<name>', '配置名称')
  .action((name: string) => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      core.configs.disable(name);
      if (cfg.jsonOutput) {
        console.log(JSON.stringify({ disabled: true, name }));
      } else {
        console.log(`\x1b[32m\u2705 \u914d\u7f6e '${name}' \u5df2\u7981\u7528\x1b[0m`);
      }
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

configCommand
  .command('templates')
  .description('列出可用协议模板')
  .action(async () => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      const tmpls = await core.cloud.getTemplates();
      printTemplates(tmpls, cfg);
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });
