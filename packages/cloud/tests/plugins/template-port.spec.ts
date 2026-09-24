import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginRegistry, resetRegistryCache } from '../../src/engine/registry';
import serverTemplate from '../../src/templates/server/default/template.json';
import clientTemplate from '../../src/templates/client/default/template.json';

function makeMockDB(templateRows: any[]): D1Database {
  return {
    prepare: vi.fn().mockImplementation((sql: string) => {
      const rows = sql.includes('FROM templates') ? templateRows : [];
      return {
        all: vi.fn().mockResolvedValue({ results: rows }),
        first: vi.fn().mockResolvedValue(rows[0] ?? null),
        run: vi.fn().mockResolvedValue({ success: true }),
        bind: vi.fn().mockReturnThis(),
      };
    }),
    exec: vi.fn().mockResolvedValue(undefined),
    batch: vi.fn().mockResolvedValue([{ results: templateRows }]),
    dump: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
  } as any as D1Database;
}

const mkRow = (id: string, category: string, template: any) => ({
  id,
  category,
  name: id,
  version: '1.0.0',
  server_template: null,
  client_template: null,
  template_content: JSON.stringify(template),
  config: JSON.stringify({ params: [] }),
  entry_script: null,
  params: '[]',
  description: null,
  created_at: '2026-01-01',
  updated_at: '2026-01-01',
});

// 断言一律从 import 的模板源对象推导（钉机制不钉数据）：模板内容随迭代演进，
// 演进时这些测试应零修改通过。占位符替换约定：'{{ proxy_tags }}' → 实例 tag 列表。
const T = (t: any) => t as any;
const withProxyTags = (sel: any, tags: string[]) =>
  sel.outbounds.flatMap((o: string) => (o.includes('proxy_tags') ? tags : [o]));
// 模板里裸字符串占位元素（如 "{{ protocols }}"）被 splice 成生成的出站条目
const splicedEntryCount = (tpl: any) => tpl.outbounds.filter((o: any) => typeof o === 'string').length;

describe('template port verification', () => {
  beforeEach(() => {
    resetRegistryCache(); // shared module cache must not leak across mock DBs
  });

  it('renderServerOverall splices protocols into minimal server template', async () => {
    const db = makeMockDB([mkRow('server-default', 'overall-server', serverTemplate)]);
    const reg = new PluginRegistry(db);
    await reg.loadAll();
    const instances = [
      { id: 'i1', serverConfig: { type: 'hysteria2', listen: 8443 }, clientConfig: {} },
      { id: 'i2', serverConfig: { type: 'vless', listen: 443 }, clientConfig: {} },
    ];
    const result: any = await reg.renderServerOverall(instances, 'server-default', {});
    expect(result.log).toEqual(T(serverTemplate).log);
    // one inbound per instance, in order
    expect(result.inbounds).toHaveLength(instances.length);
    expect(result.inbounds[0].type).toBe(instances[0].serverConfig.type);
    // untouched template sections preserved verbatim
    expect(result.outbounds).toEqual(T(serverTemplate).outbounds);
    expect(result.route).toBeDefined();
    expect(result.route.final).toBe(T(serverTemplate).route.final);
    expect(result.route.auto_detect_interface).toBe(true);
    expect(result.dns.final).toBe(T(serverTemplate).dns.final);
    // remote rule-set definitions preserved from the template
    expect(result.route.rule_set).toEqual(T(serverTemplate).route.rule_set);
    // no leftover placeholder tokens
    const json = JSON.stringify(result);
    expect(json).not.toContain('{{');
  });

  it('renderClientOverall splices proxy_tags into selectors and protocols into outbounds', async () => {
    const db = makeMockDB([mkRow('client-default', 'overall-client', clientTemplate)]);
    const reg = new PluginRegistry(db);
    await reg.loadAll();
    const instances = [
      { id: 'i1', serverConfig: {}, clientConfig: { tag: 'proxy-a', type: 'hysteria2', server: '1.1.1.1' } },
      { id: 'i2', serverConfig: {}, clientConfig: { tag: 'proxy-b', type: 'vless', server: '2.2.2.2' } },
    ];
    const result: any = await reg.renderClientOverall(instances, 'client-default', {});
    const tags = instances.map((i) => i.clientConfig.tag);

    // outbounds: template static entries + one generated outbound per instance
    // （模板里的裸占位元素被替换为生成的出站条目）
    expect(result.outbounds).toHaveLength(
      T(clientTemplate).outbounds.length - splicedEntryCount(T(clientTemplate)) + instances.length,
    );

    // every selector in the template gets the instance tags spliced in
    const proxyTpl = T(clientTemplate).outbounds.find((o: any) => o.tag === 'proxy');
    const proxySel = result.outbounds.find((o: any) => o.tag === 'proxy');
    expect(proxySel.outbounds).toEqual(withProxyTags(proxyTpl, tags));

    // secondary selectors (e.g. grouping selectors) get tags after their template entries
    const groupTpl = T(clientTemplate).outbounds.find((o: any) => o.type === 'selector' && o.tag !== 'proxy');
    const groupSel = result.outbounds.find((o: any) => o.tag === groupTpl.tag);
    expect(groupSel.outbounds).toEqual(withProxyTags(groupTpl, tags));

    // auto urltest: the instance tags only
    const auto = result.outbounds.find((o: any) => o.tag === 'auto');
    expect(auto.type).toBe('urltest');
    expect(auto.outbounds).toEqual(tags);

    // generated outbounds are appended last, in instance order
    expect(result.outbounds.at(-1).tag).toBe(tags[tags.length - 1]);
    expect(result.outbounds.at(-2).tag).toBe(tags[tags.length - 2]);

    // tun inbound preserved verbatim from the template
    const tun = result.inbounds.find((o: any) => o.type === 'tun');
    expect(tun).toEqual(T(clientTemplate).inbounds.find((i: any) => i.type === 'tun'));

    // dns + route preserved verbatim from the template
    expect(result.dns.final).toBe(T(clientTemplate).dns.final);
    expect(result.route.final).toBe(T(clientTemplate).route.final);
    expect(result.route.default_domain_resolver).toBe(T(clientTemplate).route.default_domain_resolver);
    // rule_set must be preserved verbatim from the template — comparing
    // against the source template (instead of a hardcoded count) keeps this
    // assertion valid as rule-sets are added/removed in template edits.
    expect(result.route.rule_set).toEqual(T(clientTemplate).route.rule_set);

    // no leftover placeholder tokens
    const json = JSON.stringify(result);
    expect(json).not.toContain('{{');
    expect(json).not.toContain('<PROXY_TAGS>');
    expect(json).not.toContain('<GENERATED');
  });

  it('renderClientOverall handles zero instances (empty tags/protocols)', async () => {
    const db = makeMockDB([mkRow('client-default', 'overall-client', clientTemplate)]);
    const reg = new PluginRegistry(db);
    await reg.loadAll();
    const result: any = await reg.renderClientOverall([], 'client-default', {});
    const proxyTpl = T(clientTemplate).outbounds.find((o: any) => o.tag === 'proxy');
    const proxySel = result.outbounds.find((o: any) => o.tag === 'proxy');
    expect(proxySel.outbounds).toEqual(withProxyTags(proxyTpl, []));
    expect(result.outbounds).toHaveLength(T(clientTemplate).outbounds.length - splicedEntryCount(T(clientTemplate)));
    const json = JSON.stringify(result);
    expect(json).not.toContain('{{');
  });
});
