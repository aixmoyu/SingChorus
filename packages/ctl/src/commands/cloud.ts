import { Command } from 'commander';
import { ChorusCore, CloudClient } from '@chorus/core';
import { isJson } from '../config.js';
import { fail, printJson, printCloudStatus, printSyncStatuses, printOk } from '../utils.js';

export const cloudCommand = new Command('cloud')
  .description('云端操作');

cloudCommand
  .command('status')
  .description('查看云端连接状态')
  .action(async () => {
    const core = new ChorusCore();
    try {
      await core.cloud.getProtocols(true);
      printCloudStatus({ connected: true });
    } catch (err: any) {
      printCloudStatus({ connected: false, message: err.message });
      process.exit(1);
    }
  });

cloudCommand
  .command('sync')
  .description('手动双向同步（心跳 + 推送 + 对账删除 + 拉取远端）')
  .action(async () => {
    const core = new ChorusCore();
    try {
      const result = await core.syncAllToCloud();
      if (isJson()) {
        printJson(result);
      } else {
        console.log(`\x1b[32m\u2705 \u540c\u6b65\u5b8c\u6210: \u63a8\u9001 ${result.synced}\uff0c\u8df3\u8fc7 ${result.skipped}\uff0c\u62c9\u53d6 ${result.pulled}\uff0c\u6e05\u7406 ${result.deleted}\x1b[0m`);
        if (result.failures.length > 0) {
          console.error('\x1b[31m\u90e8\u5206\u914d\u7f6e\u63a8\u9001\u5931\u8d25:\x1b[0m');
          for (const f of result.failures) {
            console.error(`  ${f.name}: ${f.message}`);
          }
          process.exit(1);
        }
      }
    } catch (err: any) {
      fail(err.message);
    }
  });

cloudCommand
  .command('sync-status')
  .description('查看每个配置的同步状态与最近失败原因')
  .action(async () => {
    const core = new ChorusCore();
    try {
      const statuses = await core.getAllSyncStatuses();
      printSyncStatuses(statuses);
    } catch (err: any) {
      fail(err.message);
    }
  });

cloudCommand
  .command('test')
  .description('探测候选 Cloud 连接（不保存，仅测试）')
  .option('-u, --url <url>', 'Cloud 服务地址', 'http://localhost:8787')
  .option('-t, --token <token>', 'Cloud Token')
  .action(async (opts: { url: string; token?: string }) => {
    if (!opts.token) fail('需要 --token 提供待测试的 Cloud Token');
    const probe = new CloudClient({
      cloud_url: opts.url.replace(/\/+$/, ''),
      cloud_token: opts.token,
    });
    try {
      // noRetry: 预探测场景重试只会拉长等待，与 panel test-candidate 一致。
      await probe.getProtocols(true);
      printOk({ reachable: true }, `Cloud ${opts.url} 可达`);
    } catch (err: any) {
      if (isJson()) {
        printJson({ reachable: false, error: err.message });
      } else {
        console.error(`\x1b[31m\u26d4 Cloud \u4e0d\u53ef\u8fbe: ${err.message}\x1b[0m`);
      }
      process.exit(1);
    }
  });

cloudCommand
  .command('setup')
  .description('配置 Cloud 连接信息')
  .option('-u, --url <url>', 'Cloud 服务地址', 'http://localhost:8787')
  .option('-t, --token <token>', 'Cloud Token')
  .action(async (opts: { url?: string; token?: string }) => {
    const core = new ChorusCore();
    const updates: Record<string, string> = {};
    if (opts.url) updates.cloud_url = opts.url.replace(/\/+$/, '');
    if (opts.token) updates.cloud_token = opts.token;
    if (Object.keys(updates).length === 0) {
      fail('未指定任何更新内容（可用 --url / --token）');
    }
    try {
      core.updateAppConfig(updates);
    } catch (err: any) {
      fail(err.message);
    }

    const appCfg = core.getAppConfig();
    if (isJson()) {
      // 不回显 token 明文，只报是否已设置。
      printJson({ ok: true, cloud_url: appCfg.cloud_url, token_set: Boolean(appCfg.cloud_token) });
    } else {
      console.log(`\x1b[32m\u2705 \u914d\u7f6e\u5df2\u4fdd\u5b58\x1b[0m`);
      console.log(`  Cloud \u5730\u5740: ${appCfg.cloud_url}`);
      console.log(`  Cloud Token: ${appCfg.cloud_token ? '\u5df2\u8bbe\u7f6e' : '\u672a\u8bbe\u7f6e'}`);
    }

    // 保存后立即探测一次（只读操作），让用户当场知道凭据是否可用；
    // 失败不影响已保存的配置，仅以退出码提示。
    try {
      await core.cloud.getProtocols(true);
      if (isJson()) printJson({ probe: 'reachable' });
      else console.log(`\x1b[32m\u2705 \u8fde\u63a5\u6d4b\u8bd5\u6210\u529f\x1b[0m`);
    } catch (err: any) {
      if (isJson()) printJson({ probe: 'unreachable', error: err.message });
      else console.error(`\x1b[31m\u26d4 \u8fde\u63a5\u6d4b\u8bd5\u5931\u8d25: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });
