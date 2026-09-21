import { Command } from 'commander';
import { ChorusCore } from '@chorus/core';
import { isJson } from '../config.js';
import { fail, printJson, printRemoteConfigs, printOk, confirm } from '../utils.js';

export const remoteCommand = new Command('remote')
  .description('远端配置（其他节点的配置，只读镜像）');

remoteCommand
  .command('list')
  .description('列出远端配置')
  .action(() => {
    const core = new ChorusCore();
    try {
      printRemoteConfigs(core.listRemoteConfigs());
    } catch (err: any) {
      fail(err.message);
    }
  });

remoteCommand
  .command('show <fingerprint> <name>')
  .description('查看单条远端配置')
  .action((fingerprint: string, name: string) => {
    const core = new ChorusCore();
    try {
      const entry = core.getRemoteConfig(fingerprint, name);
      if (!entry) fail('远端配置不存在（可能尚未同步，先执行 cloud sync）');
      printJson(entry);
    } catch (err: any) {
      fail(err.message);
    }
  });

remoteCommand
  .command('delete <fingerprint> <name>')
  .description('删除远端配置（本地镜像 + 云端条目）')
  .option('-y, --yes', '跳过确认')
  .action(async (fingerprint: string, name: string, opts: { yes?: boolean }) => {
    const core = new ChorusCore();
    try {
      if (!opts.yes) {
        const ok = await confirm(`确认删除远端配置 '${name}' (节点 ${fingerprint.slice(0, 8)})? (y/N) `);
        if (!ok) fail('已取消。非交互环境请使用 -y 跳过确认');
      }
      await core.deleteRemoteConfig(fingerprint, name);
      printOk({ deleted: name }, `远端配置 '${name}' 已删除`);
    } catch (err: any) {
      fail(err.message);
    }
  });
