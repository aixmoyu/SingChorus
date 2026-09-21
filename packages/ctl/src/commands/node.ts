import { Command } from 'commander';
import { ChorusCore } from '@chorus/core';
import { isJson } from '../config.js';
import { fail, printJson, printOk } from '../utils.js';

export const nodeCommand = new Command('node')
  .description('节点身份管理（名称 / 地址是同步心跳与订阅展示的关键字段）');

nodeCommand
  .command('show')
  .description('查看本节点身份')
  .action(() => {
    const core = new ChorusCore();
    try {
      const identity = core.getIdentity();
      const cfg = core.getAppConfig();
      const result = {
        ...identity,
        initialized: core.isInitialized(),
        cloud_url: cfg.cloud_url,
        token_set: Boolean(cfg.cloud_token),
      };
      if (isJson()) {
        printJson(result);
      } else {
        console.log(`\n\x1b[36m\u8282\u70b9\u8eab\u4efd\x1b[0m`);
        console.log(`  \u6307\u7eb9: ${identity.fingerprint}`);
        console.log(`  \u540d\u79f0: ${identity.name}`);
        console.log(`  \u5730\u5740: ${identity.address || '(\u672a\u8bbe\u7f6e)'}`);
        console.log(`  \u521d\u59cb\u5316: ${core.isInitialized() ? '\u2705' : '\u26d4'}`);
        console.log(`  Cloud \u5730\u5740: ${cfg.cloud_url}`);
        console.log(`  Cloud Token: ${cfg.cloud_token ? '\u5df2\u8bbe\u7f6e' : '\u672a\u8bbe\u7f6e'}`);
      }
    } catch (err: any) {
      fail(err.message);
    }
  });

nodeCommand
  .command('set')
  .description('设置节点名称 / 地址')
  .option('-n, --name <name>', '节点名称')
  .option('-a, --address <address>', '节点对外地址（域名或 IP）')
  .action((opts: { name?: string; address?: string }) => {
    if (!opts.name && !opts.address) {
      fail('未指定任何更新内容（可用 --name / --address）');
    }
    const core = new ChorusCore();
    try {
      const updates: Record<string, string> = {};
      if (opts.name) updates.node_name = opts.name.trim();
      if (opts.address) updates.node_address = opts.address.trim();
      core.updateAppConfig(updates);
      printOk(core.getIdentity(), '节点身份已更新');
    } catch (err: any) {
      fail(err.message);
    }
  });
