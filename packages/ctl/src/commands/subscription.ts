import { Command } from 'commander';
import { ChorusCore } from '@chorus/core';
import { isJson } from '../config.js';
import { fail, printJson, printSubscription, printOk, confirm, fmtBool } from '../utils.js';

export const subscriptionCommand = new Command('subscription')
  .description('订阅管理（云端 CRUD）');

subscriptionCommand
  .command('list')
  .description('列出所有订阅')
  .action(async () => {
    const core = new ChorusCore();
    try {
      const subs = await core.listSubscriptions();
      if (isJson()) {
        printJson(subs);
      } else {
        const rows = subs.map((s: any) => ({
          ID: s.id,
          Name: s.name,
          Path: s.path,
          Type: s.type === 'url' ? 'url' : 'singbox',
          Active: fmtBool(s.active),
        }));
        if (rows.length === 0) {
          console.log('没有订阅');
        } else {
          console.table(rows);
        }
      }
    } catch (err: any) {
      fail(err.message);
    }
  });

subscriptionCommand
  .command('show <id>')
  .description('查看订阅详情')
  .action(async (id: string) => {
    const core = new ChorusCore();
    try {
      const sub = await core.getSubscription(id);
      if (!sub) fail('订阅未找到');
      printSubscription(sub);
    } catch (err: any) {
      fail(err.message);
    }
  });

subscriptionCommand
  .command('create')
  .description('创建订阅（token 不传时由云端安全随机生成）')
  .option('-t, --type <type>', '交付类型：singbox（sing-box JSON，默认）或 url（分享链接列表）')
  .option('--singbox-version <ver>', '订阅绑定的 sing-box 版本（X.Y.Z；singbox 型必填，url 型不适用）')
  .option('-n, --name <name>', '订阅名称')
  .option('-p, --path <path>', '订阅路径（默认自动生成）')
  .option('--token <token>', '自定义访问 token')
  .option('--template <id>', '整体模板 ID（仅 singbox 型）')
  .option('--inactive', '创建为停用状态')
  .action(async (opts: { type?: string; singboxVersion?: string; name?: string; path?: string; token?: string; template?: string; inactive?: boolean }) => {
    const type = opts.type ?? 'singbox';
    if (type !== 'singbox' && type !== 'url') fail(`未知类型 '${type}'（可选：singbox / url）`);
    if (type === 'singbox' && !opts.singboxVersion) {
      fail('singbox 型订阅必须指定 --singbox-version <ver>（X.Y.Z）');
    }
    if (type === 'url' && (opts.singboxVersion || opts.template)) {
      fail('url 型订阅不绑定 sing-box 版本 / overall 模板，请去掉 --singbox-version / --template');
    }
    const core = new ChorusCore();
    try {
      const data: Record<string, unknown> = { type };
      if (opts.singboxVersion) data.singboxVersion = opts.singboxVersion;
      if (opts.name) data.name = opts.name;
      if (opts.path) data.path = opts.path;
      if (opts.token) data.token = opts.token;
      if (opts.template) data.overallTemplateId = opts.template;
      if (opts.inactive) data.active = false;
      const sub = await core.createSubscription(data);
      printOk(sub, `订阅 '${sub.name}' 已创建: /s/${sub.path}`);
    } catch (err: any) {
      fail(err.message);
    }
  });

subscriptionCommand
  .command('update <id>')
  .description('更新订阅（名称 / 路径 / 版本 / 模板 / 启停 / 重置 token）')
  .option('-n, --name <name>', '订阅名称')
  .option('-p, --path <path>', '订阅路径')
  .option('--singbox-version <ver>', '订阅绑定的 sing-box 版本（X.Y.Z）')
  .option('--template <id>', '整体模板 ID（传 none 清空，恢复默认合并）')
  .option('--active', '启用订阅')
  .option('--inactive', '停用订阅')
  .option('--regenerate-token', '重置访问 token（旧链接立即失效）')
  .action(async (id: string, opts: { name?: string; path?: string; singboxVersion?: string; template?: string; active?: boolean; inactive?: boolean; regenerateToken?: boolean }) => {
    if (opts.active && opts.inactive) fail('--active 与 --inactive 不能同时指定');
    const core = new ChorusCore();
    try {
      const data: Record<string, unknown> = {};
      if (opts.name) data.name = opts.name;
      if (opts.path) data.path = opts.path;
      if (opts.singboxVersion) data.singboxVersion = opts.singboxVersion;
      if (opts.template) data.overallTemplateId = opts.template === 'none' ? null : opts.template;
      if (opts.active) data.active = true;
      if (opts.inactive) data.active = false;
      if (opts.regenerateToken) data.regenerateToken = true;
      if (Object.keys(data).length === 0) {
        fail('未指定任何更新内容（可用 --name / --path / --singbox-version / --template / --active / --inactive / --regenerate-token）');
      }
      const sub = await core.updateSubscription(id, data);
      printOk(sub, `订阅 '${sub.name}' 已更新`);
      if (opts.regenerateToken && !isJson()) {
        console.log(`  新订阅 URL: /s/${sub.path}?token=${(sub.token || '').slice(0, 8)}...`);
      }
    } catch (err: any) {
      fail(err.message);
    }
  });

subscriptionCommand
  .command('delete <id>')
  .description('删除订阅')
  .option('-y, --yes', '跳过确认')
  .action(async (id: string, opts: { yes?: boolean }) => {
    const core = new ChorusCore();
    try {
      if (!opts.yes) {
        const ok = await confirm(`确认删除订阅 '${id}'? (y/N) `);
        if (!ok) fail('已取消。非交互环境请使用 -y 跳过确认');
      }
      await core.deleteSubscription(id);
      printOk({ deleted: id }, `订阅 '${id}' 已删除`);
    } catch (err: any) {
      fail(err.message);
    }
  });
