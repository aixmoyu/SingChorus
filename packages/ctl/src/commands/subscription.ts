import { Command } from 'commander';
import { ChorusCore } from '@chorus/core';
import { loadCtlConfig } from '../config.js';
import { fmtBool, shouldJson } from '../utils.js';

export const subscriptionCommand = new Command('subscription')
  .description('订阅管理（只读）');

subscriptionCommand
  .command('list')
  .description('列出所有订阅')
  .action(async () => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      const subs = await core.cloud.listSubscriptions();
      if (shouldJson(cfg)) {
        console.log(JSON.stringify(subs, null, 2));
      } else {
        const rows = subs.map((s: any) => ({
          Name: s.name,
          Path: s.path,
          Active: fmtBool(s.active),
        }));
        if (rows.length === 0) {
          console.log('没有订阅');
        } else {
          console.table(rows);
        }
      }
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });

subscriptionCommand
  .command('preview <id>')
  .description('预览订阅配置内容')
  .action(async (id: string) => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      const sub = await core.cloud.getSubscription(id);
      if (!sub) {
        console.error('订阅未找到');
        process.exit(1);
      }
      if (shouldJson(cfg)) {
        console.log(JSON.stringify(sub, null, 2));
      } else {
        console.log(`\n名称: ${sub.name}`);
        console.log(`路径: ${sub.path}`);
        console.log(`状态: ${fmtBool(sub.active)}`);
        console.log(`整体模板: ${sub.overallTemplateId || '(无，使用默认合并)'}`);
        console.log(`订阅 URL: /s/${sub.path}?token=${(sub.token || '').slice(0, 8)}...`);
      }
    } catch (err: any) {
      console.error(`错误: ${err.message}`);
      process.exit(1);
    }
  });
