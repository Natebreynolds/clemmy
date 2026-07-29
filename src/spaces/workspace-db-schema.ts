import type Database from 'better-sqlite3';

export const WORKSPACE_SCHEMA_VERSION = 3;

export const WORKSPACE_TABLES = [
  'workspaces',
  'workspace_files',
  'workspace_revisions',
  'workspace_data_sources',
  'workspace_actions',
  'workspace_datasets',
  'workspace_dataset_observations',
  'workspace_dataset_source_retirements',
  'workspace_state_events',
  'workspace_memory_scope',
  'workspace_embeddings',
] as const;

export type WorkspaceTableName = (typeof WORKSPACE_TABLES)[number];

/**
 * Relational index and temporal dataset ledger for file-backed Spaces.
 *
 * The existing spaces/<slug>/ directory remains the source of truth for served
 * HTML, runner scripts, and snapshots. SQLite owns append-only dataset history
 * while data.json remains its backwards-compatible current projection. Every
 * autonomous run can attach workspace_id and retrieve only the files, data,
 * actions, state events, memory, and embeddings for that epic.
 */
export const WORKSPACE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  title              TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
  root_dir           TEXT NOT NULL,
  view_entry         TEXT NOT NULL DEFAULT 'view/index.html',
  origin_session_id  TEXT,
  focus_id           INTEGER,
  recipe_json        TEXT,
  metadata_json      TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  last_opened_at     TEXT,
  last_refreshed_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspaces_status_updated
  ON workspaces(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_files (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rel_path      TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('view','asset','runner','data','note','audit','manifest','snapshot','other')),
  content_hash  TEXT NOT NULL,
  bytes         INTEGER NOT NULL DEFAULT 0,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(workspace_id, rel_path)
);

CREATE INDEX IF NOT EXISTS idx_workspace_files_workspace_kind
  ON workspace_files(workspace_id, kind);

CREATE TABLE IF NOT EXISTS workspace_revisions (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_id            TEXT REFERENCES workspace_files(id) ON DELETE SET NULL,
  version            INTEGER NOT NULL,
  snapshot_path      TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  bytes              INTEGER NOT NULL DEFAULT 0,
  author_session_id  TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_revisions_workspace_created
  ON workspace_revisions(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS workspace_data_sources (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  runner         TEXT,
  composio_slug  TEXT,
  args_json      TEXT NOT NULL DEFAULT '{}',
  schedule       TEXT,
  timezone       TEXT,
  last_status    TEXT,
  last_error     TEXT,
  last_run_at    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  CHECK (runner IS NOT NULL OR composio_slug IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_workspace_data_sources_workspace
  ON workspace_data_sources(workspace_id);

CREATE TABLE IF NOT EXISTS workspace_actions (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  runner              TEXT,
  composio_slug       TEXT,
  args_template_json  TEXT NOT NULL DEFAULT '{}',
  side_effect         TEXT NOT NULL DEFAULT 'write' CHECK (side_effect IN ('read','write','send')),
  approval_policy     TEXT NOT NULL DEFAULT 'required' CHECK (approval_policy IN ('auto','required','forbidden')),
  last_run_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (runner IS NOT NULL OR composio_slug IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_workspace_actions_workspace
  ON workspace_actions(workspace_id);

CREATE TABLE IF NOT EXISTS workspace_datasets (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id      TEXT REFERENCES workspace_data_sources(id) ON DELETE SET NULL,
  source_key     TEXT NOT NULL,
  doc_json       TEXT NOT NULL DEFAULT '{}',
  content_hash   TEXT NOT NULL,
  bytes          INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','stale')),
  error          TEXT,
  refreshed_at   TEXT NOT NULL,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_datasets_workspace_refreshed
  ON workspace_datasets(workspace_id, refreshed_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_datasets_source_hash
  ON workspace_datasets(workspace_id, source_key, content_hash);

CREATE TABLE IF NOT EXISTS workspace_dataset_observations (
  id                       TEXT PRIMARY KEY,
  workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_key               TEXT NOT NULL,
  refresh_id               TEXT NOT NULL,
  batch_id                 TEXT NOT NULL,
  batch_index              INTEGER NOT NULL DEFAULT 0,
  cause                    TEXT NOT NULL,
  projection_mode          TEXT NOT NULL DEFAULT 'source'
                           CHECK (projection_mode IN ('source','document')),
  dataset_id               TEXT REFERENCES workspace_datasets(id) ON DELETE SET NULL,
  content_hash             TEXT,
  previous_observation_id  TEXT REFERENCES workspace_dataset_observations(id) ON DELETE SET NULL,
  previous_dataset_id      TEXT REFERENCES workspace_datasets(id) ON DELETE SET NULL,
  status                   TEXT NOT NULL
                           CHECK (status IN ('ok','error','awaiting_approval')),
  changed                  INTEGER CHECK (changed IS NULL OR changed IN (0,1)),
  is_current               INTEGER NOT NULL DEFAULT 0 CHECK (is_current IN (0,1)),
  provenance_json          TEXT NOT NULL DEFAULT '{}',
  error                    TEXT,
  commit_hash              TEXT NOT NULL,
  observed_at              TEXT NOT NULL,
  created_at               TEXT NOT NULL,
  UNIQUE(workspace_id, source_key, refresh_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_dataset_observations_current
  ON workspace_dataset_observations(workspace_id, source_key)
  WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_workspace_dataset_observations_source_observed
  ON workspace_dataset_observations(workspace_id, source_key, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_dataset_observations_workspace_observed
  ON workspace_dataset_observations(workspace_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_dataset_observations_batch
  ON workspace_dataset_observations(batch_id, batch_index);

CREATE TABLE IF NOT EXISTS workspace_dataset_source_retirements (
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_key       TEXT NOT NULL,
  projection_mode  TEXT NOT NULL DEFAULT 'source'
                   CHECK (projection_mode IN ('source','document')),
  retired_after_rowid INTEGER NOT NULL DEFAULT 0,
  retired_at       TEXT NOT NULL,
  PRIMARY KEY(workspace_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_dataset_source_retirements_workspace
  ON workspace_dataset_source_retirements(workspace_id, retired_at DESC);

CREATE TABLE IF NOT EXISTS workspace_state_events (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  run_id        TEXT,
  session_id    TEXT,
  event_type    TEXT NOT NULL,
  actor         TEXT,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  UNIQUE(workspace_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_workspace_state_events_workspace_created
  ON workspace_state_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_state_events_run
  ON workspace_state_events(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_state_events_session
  ON workspace_state_events(session_id) WHERE session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_memory_scope (
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fact_id       INTEGER,
  entity_id     INTEGER,
  resource_id   INTEGER,
  scope         TEXT NOT NULL CHECK (scope IN ('local','shared','global')),
  created_at    TEXT NOT NULL,
  CHECK (fact_id IS NOT NULL OR entity_id IS NOT NULL OR resource_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_workspace_memory_scope_workspace
  ON workspace_memory_scope(workspace_id, scope);
CREATE INDEX IF NOT EXISTS idx_workspace_memory_scope_fact
  ON workspace_memory_scope(fact_id) WHERE fact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_memory_scope_entity
  ON workspace_memory_scope(entity_id) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workspace_memory_scope_resource
  ON workspace_memory_scope(resource_id) WHERE resource_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_embeddings (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_type   TEXT NOT NULL,
  object_id     TEXT NOT NULL,
  model         TEXT NOT NULL,
  dim           INTEGER NOT NULL,
  vector        BLOB NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE(workspace_id, object_type, object_id, model)
);

CREATE INDEX IF NOT EXISTS idx_workspace_embeddings_object
  ON workspace_embeddings(workspace_id, object_type, object_id);
`;

/**
 * Apply the persisted Workspace DB schema in place.
 *
 * SQLite's user_version is the migration ledger so this adds no second schema
 * subsystem. Version 2 turns the previously-unused workspace_datasets table
 * into a content-addressed blob store and adds one append-only observations
 * table. Version 3 adds durable source-retirement tombstones so a deleted or
 * renamed source cannot be resurrected from a stale data.json projection.
 * The file-backed Workspace remains compatible throughout.
 */
export function ensureWorkspaceSchema(db: Database.Database): void {
  const version = Number(db.pragma('user_version', { simple: true }) ?? 0);
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`invalid Workspace schema version: ${String(version)}`);
  }
  if (version > WORKSPACE_SCHEMA_VERSION) {
    throw new Error(
      `Workspace DB schema ${version} is newer than supported version ${WORKSPACE_SCHEMA_VERSION}`,
    );
  }

  const hasWorkspaces = hasTable(db, 'workspaces');
  if (!hasWorkspaces) {
    const create = db.transaction(() => {
      db.exec(WORKSPACE_SCHEMA_SQL);
      setUserVersion(db, WORKSPACE_SCHEMA_VERSION);
    });
    create.immediate();
    return;
  }

  const migrate = db.transaction(() => {
    if (hasTable(db, 'workspace_datasets')) {
      addColumnIfMissing(db, 'workspace_datasets', 'source_key', 'TEXT');
      addColumnIfMissing(db, 'workspace_datasets', 'bytes', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'workspace_datasets', 'first_seen_at', 'TEXT');
      addColumnIfMissing(db, 'workspace_datasets', 'last_seen_at', 'TEXT');

      db.exec(`
        UPDATE workspace_datasets
        SET source_key = CASE
          WHEN source_key IS NOT NULL AND trim(source_key) <> '' THEN source_key
          WHEN source_id IS NOT NULL AND instr(source_id, ':source:') > 0
            THEN substr(source_id, instr(source_id, ':source:') + length(':source:'))
          WHEN source_id IS NOT NULL AND trim(source_id) <> '' THEN source_id
          ELSE 'legacy:' || substr(id, 1, 48)
        END
        WHERE source_key IS NULL OR trim(source_key) = '';

        UPDATE workspace_datasets
        SET bytes = length(CAST(doc_json AS BLOB))
        WHERE bytes IS NULL OR bytes = 0;

        UPDATE workspace_datasets
        SET first_seen_at = refreshed_at
        WHERE first_seen_at IS NULL OR trim(first_seen_at) = '';

        UPDATE workspace_datasets
        SET last_seen_at = refreshed_at
        WHERE last_seen_at IS NULL OR trim(last_seen_at) = '';
      `);
    }

    // CREATE IF NOT EXISTS fills in every table/index missing from partial or
    // legacy installs after the additive dataset columns above are available.
    db.exec(WORKSPACE_SCHEMA_SQL);
    setUserVersion(db, WORKSPACE_SCHEMA_VERSION);
  });
  migrate.immediate();
}

function hasTable(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table));
}

function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  declaration: string,
): void {
  const columns = db.pragma(`table_info(${quoteSqlIdentifier(table)})`) as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(
    `ALTER TABLE ${quoteSqlIdentifier(table)} ADD COLUMN ${quoteSqlIdentifier(column)} ${declaration}`,
  );
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function setUserVersion(db: Database.Database, version: number): void {
  db.pragma(`user_version = ${version}`);
}
