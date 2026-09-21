import { Command } from 'commander';
import { ChorusCore } from '@chorus/core';
import { isJson } from '../config.js';
import { fail, printJson, printDeployStatus, printOk } from '../utils.js';

export const deployCommand = new Command('deploy')
  .description('管理 Docker 部署');

/**
 * 部署状态变化（deploy/stop）后尽力同步一次：订阅端立即反映 deployed
 * 集合的变化（与 panel 的 triggerSync 行为对齐）。云端不可达时只警告，
 * 不让同步失败掩盖部署本身的成功。
 */
async function syncAfterDeployChange(core: ChorusCore) {
  try {
    await core.syncAllToCloud();
  } catch (err: any) {
    const msg = `部署状态已变更，但同步到云端失败（定时同步会重试）: ${err.message}`;
    if (isJson()) printJson({ warning: msg });
    else console.error(`\x1b[33m\u26a0 ${msg}\x1b[0m`);
  }
}

deployCommand
  .command('up')
  .description('部署/更新节点（渲染云端模板并启动容器）')
  .action(async () => {
    const core = new ChorusCore();
    try {
      await core.deploy();
      printOk({ status: 'deployed' }, '部署完成');
      await syncAfterDeployChange(core);
    } catch (err: any) {
      fail(err.message);
    }
  });

deployCommand
  .command('down')
  .description('停止容器')
  .action(async () => {
    const core = new ChorusCore();
    try {
      await core.stopDeploy();
      printOk({ status: 'stopped' }, '已停止');
      await syncAfterDeployChange(core);
    } catch (err: any) {
      fail(err.message);
    }
  });

deployCommand
  .command('restart')
  .description('重启容器')
  .action(async () => {
    const core = new ChorusCore();
    try {
      await core.restartDeploy();
      printOk({ status: 'restarted' }, '已重启');
    } catch (err: any) {
      fail(err.message);
    }
  });

deployCommand
  .command('status')
  .description('查看部署状态')
  .action(async () => {
    const core = new ChorusCore();
    try {
      printDeployStatus({ status: await core.deployStatus() });
    } catch (err: any) {
      fail(err.message);
    }
  });

deployCommand
  .command('logs')
  .description('查看运行日志')
  .option('-t, --tail <lines>', '显示行数', '50')
  .action(async (opts: { tail: string }) => {
    const core = new ChorusCore();
    const tail = parseInt(opts.tail, 10) || 50;
    if (tail <= 0) fail(`无效行数 '${opts.tail}'，需要正整数`);
    try {
      const logsText = await core.deployLogs(tail);
      if (isJson()) printJson({ logs: logsText });
      else console.log(logsText);
    } catch (err: any) {
      fail(err.message);
    }
  });
