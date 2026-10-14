import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PluginRegistry, resetRegistryCache } from '../../src/engine/registry';
import serverTemplate from '../../src/templates/server/default/template.json';
import clientTemplate from '../../src/templates/client/default/template.json';
import clientTsTemplate from '../../src/templates/client/default-ts/template.json';

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

  // {{ route_rules }} splice point: per-instance custom rules are spread into
  // route.rules (array semantics → no comma handling needed); absent/empty
  // rules remove the placeholder element entirely.
  it('renderClientOverall splices route_rules into route.rules and drops the placeholder when empty', async () => {
    const db = makeMockDB([mkRow('client-default-ts', 'overall-client', clientTsTemplate)]);
    const reg = new PluginRegistry(db);
    await reg.loadAll();

    // No rules: the placeholder element disappears from route.rules.
    const bare: any = await reg.renderClientOverall(
      [{ id: 'i1', serverConfig: {}, clientConfig: { tag: 'proxy-a' } }],
      'client-default-ts',
      {},
    );
    const templateRuleCount = T(clientTsTemplate).route.rules.length - 1; // minus the placeholder element
    expect(bare.route.rules).toHaveLength(templateRuleCount);
    expect(JSON.stringify(bare)).not.toContain('route_rules');

    // With rules: spread in at the placeholder position, before template rules.
    const rule = { domain: ['example.com'], outbound: 'direct' };
    const rule2 = { domain_suffix: ['.example.org'], outbound: 'proxy' };
    const withRules: any = await reg.renderClientOverall(
      [
        { id: 'i1', serverConfig: {}, clientConfig: { tag: 'proxy-a' }, routeRules: [rule] },
        { id: 'i2', serverConfig: {}, clientConfig: { tag: 'proxy-b' }, routeRules: [rule2] },
      ],
      'client-default-ts',
      {},
    );
    expect(withRules.route.rules).toHaveLength(templateRuleCount + 2);
    expect(withRules.route.rules).toContainEqual(rule);
    expect(withRules.route.rules).toContainEqual(rule2);
    expect(withRules.route.rules[0]).toEqual(rule);
    expect(withRules.route.rules[1]).toEqual(rule2);
    // template rules preserved after the spliced ones
    expect(withRules.route.rules.slice(2)).toEqual(T(clientTsTemplate).route.rules.slice(1));
  });

  // B3 可观测性：实例携带自定义规则但模板没有 {{ route_rules }} 拼接点 →
  // 规则被静默丢弃前必须打 warn；模板有拼接点 → 不告警。
  it('renderClientOverall warns when custom rules hit a template without a route_rules splice point', async () => {
    const instances = [{ id: 'i1', serverConfig: {}, clientConfig: { tag: 'proxy-a' }, routeRules: [{ domain: ['example.com'], outbound: 'direct' }] }];
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // client-default 模板没有 route_rules 拼接点（内置种子中仅 default-ts 有）
    const db = makeMockDB([mkRow('client-default', 'overall-client', clientTemplate)]);
    const reg = new PluginRegistry(db, logger as any);
    await reg.loadAll();
    await reg.renderClientOverall(instances, 'client-default', {});
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('route_rules');

    // 有拼接点的模板：规则正常拼入，不告警
    resetRegistryCache();
    const logger2 = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const db2 = makeMockDB([mkRow('client-default-ts', 'overall-client', clientTsTemplate)]);
    const reg2 = new PluginRegistry(db2, logger2 as any);
    await reg2.loadAll();
    await reg2.renderClientOverall(instances, 'client-default-ts', {});
    expect(logger2.warn).not.toHaveBeenCalled();
  });
});
