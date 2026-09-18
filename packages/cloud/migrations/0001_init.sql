-- 初始 schema（完整、幂等）。项目未上线，无历史迁移——所有表和索引在此一次建齐，
-- 与 src/db/schema.ts 的 eager DDL 保持一致（tests/schema-fingerprint.spec.ts 钉死两者）。

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT,
  fingerprint TEXT,
  address TEXT,
  last_seen TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  server_overall_id TEXT DEFAULT NULL,
  docker_overall_id TEXT DEFAULT NULL,
  server_params TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1.0.0',
  server_template TEXT,
  client_template TEXT,
  template_content TEXT,
  config TEXT,
  entry_script TEXT,
  params TEXT NOT NULL DEFAULT '[]',
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- tag 镜像 params.tag，tags/check 走索引查询
CREATE TABLE IF NOT EXISTS protocol_instances (
  id TEXT PRIMARY KEY,
  protocol_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  server_config TEXT DEFAULT NULL,
  client_config TEXT DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  tag TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (protocol_id) REFERENCES templates(id),
  FOREIGN KEY (node_id) REFERENCES nodes(id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  overall_template_id TEXT DEFAULT NULL,
  overall_params TEXT NOT NULL DEFAULT '{}',
  token TEXT NOT NULL UNIQUE,
  active TEXT NOT NULL DEFAULT '1',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (overall_template_id) REFERENCES templates(id)
);

-- panel 同步上来的客户端配置；tag 镜像 config.tag
CREATE TABLE IF NOT EXISTS client_configs (
  fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  protocol_type TEXT NOT NULL,
  content_hash TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  deployed INTEGER NOT NULL DEFAULT 0,
  port INTEGER,
  tag TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (fingerprint, name)
);

-- 订阅投递缓存（D1 故障时 stale 兜底）
CREATE TABLE IF NOT EXISTS sub_delivery_cache (
  path TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'admin',
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  subscription_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  resource_id TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
CREATE INDEX IF NOT EXISTS idx_protocol_instances_node_id ON protocol_instances(node_id);
CREATE INDEX IF NOT EXISTS idx_protocol_instances_protocol_id ON protocol_instances(protocol_id);
CREATE INDEX IF NOT EXISTS idx_protocol_instances_tag ON protocol_instances(tag);
CREATE INDEX IF NOT EXISTS idx_subscriptions_path ON subscriptions(path);
CREATE INDEX IF NOT EXISTS idx_subscriptions_token ON subscriptions(token);
CREATE INDEX IF NOT EXISTS idx_tokens_subject ON tokens(subject);
CREATE INDEX IF NOT EXISTS idx_tokens_hash ON tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_tokens_type ON tokens(type);
CREATE INDEX IF NOT EXISTS idx_users_token ON users(token);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_fingerprint ON nodes(fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_client_configs_fingerprint ON client_configs(fingerprint);
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_configs_tag ON client_configs(tag) WHERE tag != '';
