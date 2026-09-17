import { Command } from 'commander';
import { ChorusCore } from '@chorus/core';
import { loadCtlConfig } from '../config.js';
import { printCloudStatus } from '../utils.js';

export const cloudCommand = new Command('cloud')
  .description('云端操作');

cloudCommand
  .command('status')
  .description('查看云端连接状态')
  .action(async () => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      await core.cloud.getProtocols();
      printCloudStatus({ connected: true }, cfg);
    } catch (err: any) {
      printCloudStatus({ connected: false, message: err.message }, cfg);
      process.exit(1);
    }
  });

cloudCommand
  .command('sync')
  .description('手动同步配置到云端')
  .action(async () => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      const result = await core.syncAllToCloud();
      if (cfg.jsonOutput) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`\x1b[32m\u2705 \u540c\u6b65\u5b8c\u6210: ${result.synced} \u540c\u6b65${result.skipped ? `, ${result.skipped} \u8df3\u8fc7` : ''}\x1b[0m`);
      }
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

cloudCommand
  .command('setup')
  .description('配置 Cloud 连接信息')
  .option('-u, --url <url>', 'Cloud 服务地址', 'http://localhost:8787')
  .option('-t, --token <token>', 'Cloud Token')
  .action((opts: { url?: string; token?: string }) => {
    const core = new ChorusCore();
    const updates: Record<string, string> = {};
    if (opts.url) updates.cloud_url = opts.url.replace(/\/+$/, '');
    if (opts.token) updates.cloud_token = opts.token;
    try {
      core.updateAppConfig(updates);
    } catch (err: any) {
      // R-CTL-D4: 与其他命令一致支持 --json 输出契约（顺带闭合 NEW-CTL-001
      // 的未捕获堆栈）。
      const cfg = loadCtlConfig();
      if (cfg.jsonOutput) {
        console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
      } else {
        console.error(`\x1b[31m错误: ${err.message}\x1b[0m`);
      }
      process.exit(1);
    }
    const cfg = loadCtlConfig();
    const appCfg = core.getAppConfig();
    if (cfg.jsonOutput) {
      // 不回显 token 明文，只报是否已设置。
      console.log(JSON.stringify({ ok: true, cloud_url: appCfg.cloud_url, token_set: Boolean(appCfg.cloud_token) }, null, 2));
    } else {
      console.log(`\x1b[32m\u2705 \u914d\u7f6e\u5df2\u4fdd\u5b58\x1b[0m`);
      console.log(`  Cloud \u5730\u5740: ${appCfg.cloud_url}`);
      console.log(`  Cloud Token: ${appCfg.cloud_token ? '\u5df2\u8bbe\u7f6e' : '\u672a\u8bbe\u7f6e'}`);
    }
  });
