import { Command } from 'commander';
import { ChorusCore } from '@chorus/core';
import { loadCtlConfig } from '../config.js';
import { printDeployStatus } from '../utils.js';

export const deployCommand = new Command('deploy')
  .description('管理 Docker 部署');

deployCommand
  .command('up')
  .description('部署/更新节点')
  .action(async () => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      await core.deploy();
      if (cfg.jsonOutput) {
        console.log(JSON.stringify({ status: 'deployed' }));
      } else {
        console.log(`\x1b[32m\u2705 \u90e8\u7f72\u5b8c\u6210\x1b[0m`);
      }
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

deployCommand
  .command('down')
  .description('停止容器')
  .action(async () => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      await core.stopDeploy();
      if (cfg.jsonOutput) {
        console.log(JSON.stringify({ status: 'stopped' }));
      } else {
        console.log(`\x1b[32m\u2705 \u5df2\u505c\u6b62\x1b[0m`);
      }
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

deployCommand
  .command('restart')
  .description('重启容器')
  .action(async () => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      await core.restartDeploy();
      if (cfg.jsonOutput) {
        console.log(JSON.stringify({ status: 'restarted' }));
      } else {
        console.log(`\x1b[32m\u2705 \u5df2\u91cd\u542f\x1b[0m`);
      }
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

deployCommand
  .command('status')
  .description('查看部署状态')
  .action(async () => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    try {
      const s = await core.deployStatus();
      printDeployStatus({ status: s }, cfg);
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });

deployCommand
  .command('logs')
  .description('查看运行日志')
  .option('-t, --tail <lines>', '显示行数', '50')
  .action(async (opts: { tail: string }) => {
    const core = new ChorusCore();
    const cfg = loadCtlConfig();
    const tail = parseInt(opts.tail, 10) || 50;
    try {
      const logsText = await core.deployLogs(tail);
      if (cfg.jsonOutput) {
        console.log(JSON.stringify({ logs: logsText }));
      } else {
        console.log(logsText);
      }
    } catch (err: any) {
      console.error(`\x1b[31m\u9519\u8bef: ${err.message}\x1b[0m`);
      process.exit(1);
    }
  });