#!/usr/bin/env node
import { Command } from 'commander';
import { configCommand } from './commands/config.js';
import { deployCommand } from './commands/deploy.js';
import { cloudCommand } from './commands/cloud.js';
import { panelCommand } from './commands/panel.js';
import { subscriptionCommand } from './commands/subscription.js';
import { remoteCommand } from './commands/remote.js';
import { nodeCommand } from './commands/node.js';
import { validateCommand } from './commands/validate.js';
import { ChorusCore } from '@chorus/core';
import { setJsonOutput, isJson } from './config.js';
import { printJson, fail } from './utils.js';

const program = new Command();

program
  .name('chorusctl')
  .description('SingChorus 命令行管理工具（R-CTL-D4：脚本集成必须使用 --json 输出，人读文案格式不保证稳定）')
  .version('0.2.0')
  .option('-j, --json', 'JSON 格式输出')
  .hook('preAction', (thisCmd) => {
    const opts = thisCmd.optsWithGlobals();
    setJsonOutput(!!opts.json);
  });

program.addCommand(configCommand);
program.addCommand(deployCommand);
program.addCommand(cloudCommand);
program.addCommand(nodeCommand);
program.addCommand(remoteCommand);
program.addCommand(panelCommand);
program.addCommand(subscriptionCommand);
program.addCommand(validateCommand);

program
  .command('health')
  .description('检查本地引擎状态')
  .action(() => {
    try {
      const core = new ChorusCore();
      const configs = core.configs.listAll();
      const identity = core.getIdentity();
      const result = {
        ok: true,
        total_configs: configs.length,
        enabled_configs: configs.filter(e => e.enabled).length,
        unsynced_configs: configs.filter(e => !e.synced).length,
        fingerprint: identity.fingerprint,
        node_name: identity.name,
        initialized: core.isInitialized(),
        timestamp: new Date().toISOString(),
      };
      if (isJson()) {
        printJson(result);
      } else {
        console.log(`\x1b[32m\u2705 \u672c\u5730\u5f15\u64ce\u6b63\u5e38: ${result.total_configs} \u4e2a\u914d\u7f6e\x1b[0m`);
        console.log(`  \u542f\u7528: ${result.enabled_configs}\uff0c\u672a\u540c\u6b65: ${result.unsynced_configs}`);
        console.log(`  \u8282\u70b9: ${result.node_name} (${identity.fingerprint.slice(0, 8)})`);
        console.log(`  \u521d\u59cb\u5316: ${result.initialized ? '\u2705' : '\u26d4'}`);
      }
    } catch (err: any) {
      fail(err.message);
    }
  });

// Direct-run detection: dev runs execute src/index.ts (bun/tsx), while npx /
// npm-bin runs execute the compiled dist/index.js. Skip auto-parse when the
// module is imported by tests or other tools.
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('chorusctl')) {
  program.parse(process.argv);
}

export { program };
