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

nodeCommand
  .command('import')
  .description('导入既有指纹（重装恢复：让云端继续识别本节点为原节点）')
  .argument('<fingerprint>', '重装前记录的节点指纹（8-128 位字母/数字/_/-）')
  .action((fingerprint: string) => {
    const core = new ChorusCore();
    try {
      const fp = core.importFingerprint(fingerprint);
      printOk({ fingerprint: fp }, '指纹已导入，节点身份恢复为原节点');
    } catch (err: any) {
      fail(err.message);
    }
  });

nodeCommand
  .command('restore')
  .description('从云端拉回本节点的全部配置（重装恢复；本地同名配置保留不动）')
  .action(async () => {
    const core = new ChorusCore();
    if (!core.isInitialized()) {
      fail('节点尚未初始化（缺少 node_name 或 cloud_token），请先完成初始化');
    }
    try {
      const result = await core.restoreFromCloud();
      if (isJson()) {
        printJson(result);
      } else {
        console.log(`\n\x1b[32m\u2705 \u6062\u590d\u5b8c\u6210\x1b[0m`);
        console.log(`  \u4ece\u4e91\u7aef\u62c9\u56de: ${result.restored.length} \u4e2a\u914d\u7f6e`);
        if (result.restored.length) console.log(`    ${result.restored.join(', ')}`);
        if (result.skipped.length) {
          console.log(`  \u8df3\u8fc7\uff08\u672c\u5730\u5df2\u5b58\u5728\u6216\u5bfc\u5165\u5931\u8d25\uff09: ${result.skipped.length} \u4e2a`);
          console.log(`    ${result.skipped.join(', ')}`);
        }
        console.log('  \u63d0\u793a: \u6062\u590d\u7684\u914d\u7f6e\u9700\u91cd\u65b0\u90e8\u7f72\u540e\u624d\u4f1a\u91cd\u65b0\u51fa\u73b0\u5728\u8ba2\u9605\u4e2d');
      }
    } catch (err: any) {
      fail(err.message);
    }
  });
