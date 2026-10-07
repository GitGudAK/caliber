// Append-only. Each entry runs once, in order, inside a transaction.
export const migrations: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'init',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        watch_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX assets_project ON assets(project_id, kind);

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        progress REAL NOT NULL DEFAULT 0,
        steps TEXT NOT NULL DEFAULT '[]',
        input TEXT NOT NULL DEFAULT 'null',
        result TEXT NOT NULL DEFAULT 'null',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX jobs_project ON jobs(project_id, created_at);
    `,
  },
  {
    id: 2,
    name: 'presets_and_request_cache',
    sql: `
      ALTER TABLE projects ADD COLUMN scene TEXT NOT NULL DEFAULT '{"presetId":null,"placement":null}';

      CREATE TABLE world_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        template_id TEXT,
        files TEXT NOT NULL,
        semantics TEXT NOT NULL DEFAULT '{}',
        default_placement TEXT NOT NULL,
        prompts TEXT NOT NULL DEFAULT '{}',
        provenance TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE provider_requests (
        hash TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        request TEXT NOT NULL,
        status TEXT NOT NULL,
        provider_ref TEXT,
        response TEXT NOT NULL DEFAULT 'null',
        outputs TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
]
