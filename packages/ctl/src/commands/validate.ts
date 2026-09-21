import { Command } from 'commander';
import { readFileSync } from 'fs';
import { ChorusCore } from '@chorus/core';
import { fail, printJson } from '../utils.js';

export const validateCommand = new Command('validate')
  .description('sing-box 配置校验');

function report(result: { valid: boolean; errors: string[] }) {
  printJson(result);
  if (!result.valid) process.exit(1);
}

validateCommand
  .command('config <file>')
  .description('校验一个 JSON 配置文件')
  .action(async (file: string) => {
    const core = new ChorusCore();
    try {
      const config = JSON.parse(readFileSync(file, 'utf-8'));
      report(await core.validate(config));
    } catch (err: any) {
      fail(err.message);
    }
  });

validateCommand
  .command('entry <name>')
  .description('校验已保存配置的 server/client 侧内容')
  .option('--side <side>', '校验侧: server 或 client', 'server')
  .action(async (name: string, opts: { side: string }) => {
    if (opts.side !== 'server' && opts.side !== 'client') {
      fail(`无效 --side '${opts.side}'，可选 server 或 client`);
    }
    const core = new ChorusCore();
    try {
      const entry = core.configs.get(name);
      const config = opts.side === 'client' ? entry.client_config : entry.server_config;
      report(await core.validate(config));
    } catch (err: any) {
      fail(err.message);
    }
  });

validateCommand
  .command('merged')
  .description('校验启用配置合并后的服务端配置')
  .action(async () => {
    const core = new ChorusCore();
    try {
      const config = await core.generateServerConfig();
      report(await core.validate(config));
    } catch (err: any) {
      fail(err.message);
    }
  });

validateCommand
  .command('subscription')
  .description('校验启用配置合并后的订阅配置')
  .action(async () => {
    const core = new ChorusCore();
    try {
      const config = await core.generateSubscription();
      report(await core.validate(config));
    } catch (err: any) {
      fail(err.message);
    }
  });
