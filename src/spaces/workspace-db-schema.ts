export const WORKSPACE_SCHEMA_VERSION = 1;

export const WORKSPACE_TABLES = [
  'workspaces',
  'workspace_files',
  'workspace_revisions',
  'workspace_data_sources',
  'workspace_actions',
  'workspace_datasets',
  'workspace_state_events',
  'workspace_memory_scope',
  'workspace_embeddings',
] as const;

export type WorkspaceTableName = (typeof WORKSPACE_TABLES)[number];

/**
 * Relational index for file-backed Spaces.
 *
 * The existing spaces/<slug>/ directory remains the source of truth for served
 * HTML, runner scripts, and snapshots. This schema is the queryable isolation
 * layer: every autonomous run can attach workspace_id and retrieve only the
 * files, data, actions, state events, memory, and embeddings for that epic.
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
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id     TEXT REFERENCES workspace_data_sources(id) ON DELETE SET NULL,
  doc_json      TEXT NOT NULL DEFAULT '{}',
  content_hash  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','stale')),
  error         TEXT,
  refreshed_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workspace_datasets_workspace_refreshed
  ON workspace_datasets(workspace_id, refreshed_at DESC);

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
