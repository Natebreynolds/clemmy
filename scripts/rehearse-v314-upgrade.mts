#!/usr/bin/env node

/**
 * Non-destructive v3.14.0 -> current durable-store rehearsal.
 *
 * The legacy fixture is produced by executing public APIs from the exact
 * v3.14.0 release commit in a disposable checkout. The current tree is then
 * allowed to open only a copy of that home. A second, fresh process repeats
 * the store-open sequence and must be a logical no-op.
 *
 * This is deliberately not a daemon boot. Daemon reconciliation can resume
 * real work, and belongs in a later rehearsal against an explicitly supplied,
 * sanitized production snapshot. This gate covers numbered migrations,
 * critical file-backed state, identities, foreign keys, and replay carriers.
 */
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof import('better-sqlite3');

export const V314_RELEASE = Object.freeze({
  tag: 'v3.14.0',
  commit: '18c5bcc72c921da2855fedea88509c2f5e6b7237',
  tree: '0673704264723e2acb43c4c3820a1d15787b4c7d',
  packageVersion: '3.14.0',
  schemas: Object.freeze({
    harness: 20,
    memory: 32,
    workspace: 3,
    workflowTrigger: 4,
  }),
});

const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), '..');
const tempRoot = realpathSync(os.tmpdir());
const CARRIER_DIRECTORY_NAMES = new Set([
  'background-tasks',
  'batch-runs',
  'continuation-capsules',
  'durable-fanout',
  'guest-runs',
  'handoffs',
  'pending-actions',
]);
const REQUIRED_FIXTURE_IDENTITIES = Object.freeze({
  sessionId: 'upgrade-rehearsal-chat-v314',
  workflowName: 'upgrade-rehearsal-workflow',
  workspaceId: 'upgrade-rehearsal-space',
  notificationId: 'upgrade-rehearsal-notification-v314',
  executionSessionId: 'upgrade-rehearsal-execution-v314',
  boundArtifactSlot: 'upgrade-bound-artifact',
  pendingArtifactSlot: 'upgrade-pending-artifact',
});

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface V314UpgradeRehearsalOptions {
  /** Optional deterministic test root. It must resolve below the OS temp dir. */
  rehearsalRoot?: string;
  /** Keep the checkout, immutable snapshot, migrated copy, and report. */
  keep?: boolean;
}

export interface V314UpgradeRehearsalReport {
  ok: boolean;
  release: typeof V314_RELEASE;
  dependencyProof: {
    tagLockSha256: string;
    currentLockSha256: string;
    normalizedLockGraphEqual: boolean;
  };
  paths: {
    rehearsalRoot: string;
    exactTagCheckout: string;
    legacyHome: string;
    immutableSnapshot: string;
    migratedHome: string;
    report: string;
  };
  before: HomeInspection;
  firstBoot: HomeInspection;
  secondBoot: HomeInspection;
  checks: Array<{ name: string; ok: boolean; detail?: Json }>;
  limitations: string[];
}

interface SqliteInspection {
  relativePath: string;
  integrity: string[];
  foreignKeyViolations: Json[];
  userVersion: number;
  schemaVersions: number[] | null;
  tableCounts: Record<string, number>;
  tableColumns: Record<string, string[]>;
  triggers: string[];
  identities: Record<string, Json[]>;
}

interface HomeInspection {
  sqlite: Record<string, SqliteInspection>;
  protectedFiles: Record<string, string>;
  allNonSqliteFiles: Record<string, string>;
  carriers: {
    eventTypes: Record<string, number>;
    triggerEvents: Json[];
    workflowRunFiles: string[];
    carrierFiles: string[];
    notifications: Json[];
    notificationQueue: Json[];
    executions: Json[];
  };
}

function sha256Bytes(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath: string): string {
  return sha256Bytes(readFileSync(filePath));
}

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
    .join(',')}}`;
}

function assertDisposablePath(candidate: string, label: string): string {
  const absolute = path.resolve(candidate);
  const resolved = existsSync(absolute)
    ? realpathSync(absolute)
    : path.join(realpathSync(path.dirname(absolute)), path.basename(absolute));
  if (resolved === tempRoot || !resolved.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`${label} must resolve below the OS temp directory; refused ${resolved}`);
  }
  const live = path.resolve(os.homedir(), '.clementine-next');
  if (resolved === live || resolved.startsWith(`${live}${path.sep}`)) {
    throw new Error(`${label} must never address the live Clementine home; refused ${resolved}`);
  }
  return resolved;
}

function run(command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
} = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  const status = result.status ?? 1;
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${status}\n${stderr || stdout}`.trim(),
    );
  }
  return { status, stdout, stderr };
}

function isolatedChildEnv(home: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'BROWSER_USE_API_KEY',
    'BYO_MODEL_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CODEX_API_KEY',
    'CODEX_AUTH_SOURCE_FILE',
    'COMPOSIO_API_KEY',
    'DISCORD_BOT_TOKEN',
    'OPENAI_API_KEY',
    'RECALL_API_KEY',
    'SLACK_APP_TOKEN',
    'SLACK_BOT_TOKEN',
    'WEBHOOK_SECRET',
  ]) delete env[key];
  return {
    ...env,
    CLEMENTINE_HOME: assertDisposablePath(home, 'CLEMENTINE_HOME'),
    CLEMMY_TEST_ISOLATED_HOME: '1',
    CLEMMY_TEST_DISABLE_LIVE_MODELS: '1',
    CLEMMY_LOCAL_EMBEDDINGS: 'off',
    OPENAI_AGENTS_DISABLE_TRACING: '1',
    CLEMMY_AUTHORITY_SEAL_KEY: 'ab'.repeat(32),
  };
}

function normalizedLock(lock: unknown): unknown {
  const copy = structuredClone(lock) as {
    version?: unknown;
    packages?: Record<string, { version?: unknown }>;
  };
  delete copy.version;
  if (copy.packages?.['']) delete copy.packages[''].version;
  return copy;
}

function verifyReleaseCheckout(checkout: string): {
  tagLockSha256: string;
  currentLockSha256: string;
  normalizedLockGraphEqual: boolean;
} {
  const commit = run('git', ['rev-parse', `${V314_RELEASE.commit}^{commit}`]).stdout.trim();
  const tree = run('git', ['rev-parse', `${V314_RELEASE.commit}^{tree}`]).stdout.trim();
  if (commit !== V314_RELEASE.commit || tree !== V314_RELEASE.tree) {
    throw new Error(`v3.14.0 provenance mismatch: commit=${commit} tree=${tree}`);
  }
  const tagPackagePath = path.join(checkout, 'package.json');
  const tagLockPath = path.join(checkout, 'package-lock.json');
  const currentLockPath = path.join(repoRoot, 'package-lock.json');
  const tagPackage = JSON.parse(readFileSync(tagPackagePath, 'utf8')) as { version?: string };
  if (tagPackage.version !== V314_RELEASE.packageVersion) {
    throw new Error(`archived package version is ${String(tagPackage.version)}, expected ${V314_RELEASE.packageVersion}`);
  }
  const tagLock = JSON.parse(readFileSync(tagLockPath, 'utf8')) as unknown;
  const currentLock = JSON.parse(readFileSync(currentLockPath, 'utf8')) as unknown;
  const normalizedLockGraphEqual = stable(normalizedLock(tagLock)) === stable(normalizedLock(currentLock));
  if (!normalizedLockGraphEqual) {
    throw new Error(
      'The installed dependency graph no longer matches v3.14.0; refusing to call current node_modules an exact-tag execution dependency set.',
    );
  }
  return {
    tagLockSha256: sha256File(tagLockPath),
    currentLockSha256: sha256File(currentLockPath),
    normalizedLockGraphEqual,
  };
}

function checkoutExactRelease(checkout: string, archivePath: string): void {
  mkdirSync(checkout, { recursive: true });
  run('git', [
    'archive',
    '--format=tar',
    `--output=${archivePath}`,
    V314_RELEASE.commit,
  ]);
  run('tar', ['-xf', archivePath, '-C', checkout]);
  const nodeModules = path.join(repoRoot, 'node_modules');
  if (!existsSync(nodeModules)) throw new Error('node_modules is missing; run npm ci before the rehearsal');
  symlinkSync(nodeModules, path.join(checkout, 'node_modules'), 'dir');
}

async function importFrom(root: string, relativePath: string): Promise<Record<string, unknown>> {
  return import(pathToFileURL(path.join(root, relativePath)).href) as Promise<Record<string, unknown>>;
}

async function seedV314Fixture(checkout: string, home: string): Promise<void> {
  assertDisposablePath(checkout, 'exact-tag checkout');
  assertDisposablePath(home, 'legacy fixture home');
  mkdirSync(home, { recursive: true });

  const eventlog = await importFrom(checkout, 'src/runtime/harness/eventlog.ts') as {
    createSession(input: Record<string, unknown>): unknown;
    appendEvent(input: Record<string, unknown>): { seq: number };
    updateSession(id: string, patch: Record<string, unknown>): unknown;
    closeEventLog(): void;
  };
  eventlog.createSession({
    id: REQUIRED_FIXTURE_IDENTITIES.sessionId,
    kind: 'chat',
    channel: 'upgrade-rehearsal',
    userId: 'fixture-user-v314',
    title: 'v3.14 upgrade conversation',
    objective: 'Preserve durable user state across the release boundary.',
    metadata: { fixture: 'v3.14.0', durable: true },
  });
  const userEvent = eventlog.appendEvent({
    sessionId: REQUIRED_FIXTURE_IDENTITIES.sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Keep this exact upgrade rehearsal conversation.', synthetic: false },
  });
  eventlog.appendEvent({
    sessionId: REQUIRED_FIXTURE_IDENTITIES.sessionId,
    turn: 1,
    role: 'assistant',
    type: 'conversation_step',
    data: { text: 'The representative v3.14 state has been recorded.', sourceUserSeq: userEvent.seq },
  });
  eventlog.updateSession(REQUIRED_FIXTURE_IDENTITIES.sessionId, {
    status: 'completed',
    tokensUsed: 37,
  });

  const approvalRegistry = await importFrom(checkout, 'src/runtime/harness/approval-registry.ts') as {
    register(input: Record<string, unknown>): { approvalId: string };
    resolve(id: string, resolution: string, resolver: string): unknown;
  };
  const pendingApproval = approvalRegistry.register({
    sessionId: REQUIRED_FIXTURE_IDENTITIES.sessionId,
    channel: 'upgrade-rehearsal',
    subject: 'Pending read-only fixture approval',
    tool: 'fixture_read',
    args: { fixture: true, effect: 'read' },
  });
  const resolvedApproval = approvalRegistry.register({
    sessionId: REQUIRED_FIXTURE_IDENTITIES.sessionId,
    channel: 'upgrade-rehearsal',
    subject: 'Resolved fixture approval',
    tool: 'fixture_read',
    args: { fixture: true, generation: 2 },
  });
  approvalRegistry.resolve(resolvedApproval.approvalId, 'approved', 'upgrade-rehearsal');
  eventlog.appendEvent({
    sessionId: REQUIRED_FIXTURE_IDENTITIES.sessionId,
    turn: 1,
    role: 'assistant',
    type: 'approval_requested',
    data: { approvalId: pendingApproval.approvalId, subject: 'Pending read-only fixture approval' },
  });

  const artifacts = await importFrom(checkout, 'src/runtime/harness/artifact-ledger.ts') as {
    claimArtifactSlot(sessionId: string, intent: Record<string, unknown>, sourceCallId?: string, runScopeId?: string): unknown;
    bindArtifactSlot(sessionId: string, slot: string, resource: Record<string, unknown>, sourceCallId?: string, runScopeId?: string): unknown;
  };
  artifacts.claimArtifactSlot(REQUIRED_FIXTURE_IDENTITIES.sessionId, {
    kind: 'file',
    provider: 'fixture-local',
    slotKey: REQUIRED_FIXTURE_IDENTITIES.boundArtifactSlot,
    title: 'Bound v3.14 artifact',
    createShape: 'upgrade-rehearsal:file:v1',
  }, 'fixture-call-bound', 'fixture-run-scope-v314');
  artifacts.bindArtifactSlot(
    REQUIRED_FIXTURE_IDENTITIES.sessionId,
    REQUIRED_FIXTURE_IDENTITIES.boundArtifactSlot,
    { resourceId: 'fixture-resource-v314', uri: 'file:///tmp/fixture-v314.txt', title: 'Bound v3.14 artifact' },
    'fixture-call-bound',
    'fixture-run-scope-v314',
  );
  artifacts.claimArtifactSlot(REQUIRED_FIXTURE_IDENTITIES.sessionId, {
    kind: 'resource',
    provider: 'fixture-local',
    slotKey: REQUIRED_FIXTURE_IDENTITIES.pendingArtifactSlot,
    title: 'Pending v3.14 artifact',
    createShape: 'upgrade-rehearsal:resource:v1',
  }, 'fixture-call-pending', 'fixture-run-scope-v314');

  const temporal = await importFrom(checkout, 'src/memory/temporal-memory.ts') as {
    recordMemoryEpisode(input: Record<string, unknown>): { id: string };
  };
  const episode = temporal.recordMemoryEpisode({
    kind: 'user_turn',
    subtype: 'upgrade_rehearsal',
    title: 'v3.14 durable memory fixture',
    sourceApp: 'upgrade-rehearsal',
    sessionId: REQUIRED_FIXTURE_IDENTITIES.sessionId,
    callId: 'fixture-memory-call-v314',
    occurredAt: '2026-08-07T22:41:08.000Z',
    content: 'The fixture owner prefers durable, replay-safe state migrations.',
    metadata: { release: 'v3.14.0' },
  });
  const entityIdentity = await importFrom(checkout, 'src/memory/entity-identity.ts') as {
    upsertEntity(input: Record<string, unknown>): number;
  };
  entityIdentity.upsertEntity({
    type: 'person',
    name: 'Upgrade Fixture Person',
    aliases: ['Fixture Person'],
    identifiers: [{ scheme: 'email', value: 'fixture.person@example.invalid', confidence: 1 }],
    confidence: 1,
    evidenceEpisodeId: episode.id,
    sourceUri: 'fixture://v3.14.0/memory',
    sourceKind: 'user_turn',
  });
  const focus = await importFrom(checkout, 'src/memory/focus.ts') as {
    createFocus(input: Record<string, unknown>): unknown;
  };
  focus.createFocus({
    resourceRef: 'fixture://v3.14.0/upgrade',
    title: 'Upgrade rehearsal focus',
    summary: 'Preserve this active focus through current memory migrations.',
    resourceKind: 'upgrade_fixture',
    relatedSessionId: REQUIRED_FIXTURE_IDENTITIES.sessionId,
  });

  const workflowStore = await importFrom(checkout, 'src/memory/workflow-store.ts') as {
    writeWorkflow(name: string, definition: Record<string, unknown>): unknown;
  };
  workflowStore.writeWorkflow(REQUIRED_FIXTURE_IDENTITIES.workflowName, {
    name: REQUIRED_FIXTURE_IDENTITIES.workflowName,
    description: 'A disabled-at-runtime fixture with durable schedule and event declarations.',
    enabled: true,
    whenToUse: 'Only inside the disposable v3.14 upgrade rehearsal.',
    trigger: {
      schedule: '0 0 1 1 *',
      timezone: 'UTC',
      manual: true,
      events: [{
        type: 'upgrade.rehearsal.never-fired',
        filter: { fixture: true },
        dedupeKey: 'fixture-{{payload.id}}',
      }],
    },
    allowedTools: [],
    steps: [{
      id: 'read-fixture',
      prompt: 'Read only the supplied fixture input and return it unchanged.',
      sideEffect: 'read',
      allowedTools: [],
    }],
    inputs: { fixtureId: { type: 'string', required: true } },
    synthesis: { prompt: 'Return the preserved fixture identity.' },
    origin: 'user',
  });
  const triggerEngine = await importFrom(checkout, 'src/execution/workflow-trigger-engine.ts') as {
    syncWorkflowTriggerRegistry(): unknown;
    closeWorkflowTriggerDbForTest(): void;
  };
  triggerEngine.syncWorkflowTriggerRegistry();
  const workflowState = await importFrom(checkout, 'src/execution/workflow-run-state.ts') as {
    setWorkflowStateValues(name: string, patch: Record<string, unknown>): unknown;
  };
  workflowState.setWorkflowStateValues(REQUIRED_FIXTURE_IDENTITIES.workflowName, {
    checkpoint: 'v3.14.0',
    lastFixtureId: 'fixture-item-v314',
  });

  const executionStoreModule = await importFrom(checkout, 'src/execution/store.ts') as {
    ExecutionStore: new () => { create(input: Record<string, unknown>): { id: string } };
  };
  const executionStore = new executionStoreModule.ExecutionStore();
  executionStore.create({
    sessionId: REQUIRED_FIXTURE_IDENTITIES.executionSessionId,
    userId: 'fixture-user-v314',
    channel: 'upgrade-rehearsal',
    title: 'Dormant v3.14 execution record',
    objective: 'Remain durable without being advanced by schema migration.',
    reason: 'upgrade rehearsal fixture',
    startedFromMessage: 'Create a durable but non-auto-advancing execution fixture.',
    confidence: 1,
    reasons: ['migration coverage'],
    autoAdvance: false,
  });

  const spaceStoreModule = await importFrom(checkout, 'src/spaces/store.ts') as {
    spaceStore: { save(input: Record<string, unknown>): unknown };
  };
  spaceStoreModule.spaceStore.save({
    id: REQUIRED_FIXTURE_IDENTITIES.workspaceId,
    title: 'v3.14 Upgrade Rehearsal Space',
    status: 'active',
    contract: {
      objective: 'Keep this visual surface and its dataset intact.',
      successCriteria: ['One current dataset observation survives migration.'],
      invariants: ['The Space never becomes execution authority.'],
    },
    dataSources: [],
    actions: [],
    originSessionId: REQUIRED_FIXTURE_IDENTITIES.sessionId,
    recipe: 'upgrade-rehearsal-v314',
  });
  const workspaceDb = await importFrom(checkout, 'src/spaces/workspace-db.ts') as {
    commitWorkspaceObservationBatch(input: Record<string, unknown>): unknown;
    closeWorkspaceDb(): void;
  };
  workspaceDb.commitWorkspaceObservationBatch({
    workspaceId: REQUIRED_FIXTURE_IDENTITIES.workspaceId,
    batchId: 'upgrade-batch-v314',
    observations: [{
      sourceKey: 'fixture-document',
      refreshId: 'upgrade-refresh-v314',
      cause: 'upgrade_rehearsal',
      status: 'ok',
      projectionMode: 'document',
      data: { release: 'v3.14.0', rows: [{ id: 'fixture-row-v314', preserved: true }] },
      provenance: { adapter: 'upgrade-rehearsal', sourceVersion: 'v3.14.0' },
      observedAt: '2026-08-07T22:41:08.000Z',
    }],
  });

  const approvalStoreModule = await importFrom(checkout, 'src/runtime/approval-store.ts') as {
    ApprovalStore: new () => { add(item: Record<string, unknown>): void };
  };
  const legacyApprovalStore = new approvalStoreModule.ApprovalStore();
  legacyApprovalStore.add({
    id: 'legacy-approval-v314-pending',
    sessionId: REQUIRED_FIXTURE_IDENTITIES.sessionId,
    agentName: 'Clementine',
    toolName: 'fixture_read',
    userId: 'fixture-user-v314',
    channel: 'upgrade-rehearsal',
    createdAt: '2026-08-07T22:41:08.000Z',
    status: 'pending',
    state: JSON.stringify({ fixture: true, release: 'v3.14.0' }),
  });
  legacyApprovalStore.add({
    id: 'legacy-approval-v314-approved',
    sessionId: REQUIRED_FIXTURE_IDENTITIES.sessionId,
    agentName: 'Clementine',
    toolName: 'fixture_read',
    userId: 'fixture-user-v314',
    channel: 'upgrade-rehearsal',
    createdAt: '2026-08-07T22:42:08.000Z',
    status: 'approved',
    state: JSON.stringify({ fixture: true, release: 'v3.14.0', resolved: true }),
  });

  const notifications = await importFrom(checkout, 'src/runtime/notifications.ts') as {
    addNotification(item: Record<string, unknown>): void;
  };
  notifications.addNotification({
    id: REQUIRED_FIXTURE_IDENTITIES.notificationId,
    kind: 'system',
    title: 'v3.14 migration fixture',
    body: 'This silent notification must not be replayed or duplicated by a store boot.',
    createdAt: '2026-08-07T22:43:08.000Z',
    read: false,
    silent: true,
    metadata: { release: 'v3.14.0', fixture: true },
  });

  mkdirSync(path.join(home, 'mcp'), { recursive: true });
  mkdirSync(path.join(home, 'state'), { recursive: true });
  writeFileSync(path.join(home, '.env'), [
    'ASSISTANT_NAME=Clementine',
    'OWNER_NAME=Upgrade Fixture',
    'LOCAL_MCP_ENABLED=false',
    '',
  ].join('\n'));
  writeFileSync(path.join(home, 'mcp', 'servers.json'), JSON.stringify({ servers: {} }, null, 2));
  writeFileSync(path.join(home, 'state', 'user-profile.json'), JSON.stringify({
    version: 1,
    displayName: 'Upgrade Fixture',
    timezone: 'UTC',
    preferences: { durableMigrations: true },
  }, null, 2));

  workspaceDb.closeWorkspaceDb();
  triggerEngine.closeWorkflowTriggerDbForTest();
  const memoryDb = await importFrom(checkout, 'src/memory/db.ts') as { closeMemoryDb(): void };
  memoryDb.closeMemoryDb();
  eventlog.closeEventLog();
}

async function migrateCurrentStores(home: string): Promise<Json> {
  assertDisposablePath(home, 'migrated fixture home');
  const eventlog = await importFrom(repoRoot, 'src/runtime/harness/eventlog.ts') as {
    openEventLog(): { prepare(sql: string): { get(...args: unknown[]): unknown } };
    closeEventLog(): void;
  };
  eventlog.openEventLog();

  const memory = await importFrom(repoRoot, 'src/memory/db.ts') as {
    MEMORY_SCHEMA_VERSION: number;
    openMemoryDb(): unknown;
    closeMemoryDb(): void;
  };
  memory.openMemoryDb();

  const workspace = await importFrom(repoRoot, 'src/spaces/workspace-db.ts') as {
    openWorkspaceDb(): unknown;
    closeWorkspaceDb(): void;
  };
  workspace.openWorkspaceDb();

  const triggerSchema = await importFrom(repoRoot, 'src/execution/workflow-trigger-registry.ts') as {
    WORKFLOW_TRIGGER_SCHEMA_VERSION: number;
    ensureWorkflowTriggerSchema(db: import('better-sqlite3').Database): void;
  };
  const triggerPath = path.join(home, 'state', 'workflow-triggers.db');
  const triggerDb = new Database(triggerPath);
  triggerDb.pragma('foreign_keys = ON');
  triggerSchema.ensureWorkflowTriggerSchema(triggerDb);
  triggerDb.close();

  const harnessSchema = await importFrom(repoRoot, 'src/runtime/harness/schema-version.ts') as {
    HARNESS_SCHEMA_VERSION: number;
  };
  const workspaceSchema = await importFrom(repoRoot, 'src/spaces/workspace-db-schema.ts') as {
    WORKSPACE_SCHEMA_VERSION: number;
  };

  workspace.closeWorkspaceDb();
  memory.closeMemoryDb();
  eventlog.closeEventLog();
  return asJson({
    harness: harnessSchema.HARNESS_SCHEMA_VERSION,
    memory: memory.MEMORY_SCHEMA_VERSION,
    workspace: workspaceSchema.WORKSPACE_SCHEMA_VERSION,
    workflowTrigger: triggerSchema.WORKFLOW_TRIGGER_SCHEMA_VERSION,
  });
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) visit(full);
      else if (info.isFile()) out.push(path.relative(root, full));
    }
  };
  visit(root);
  return out;
}

function isSqliteSidecar(relativePath: string): boolean {
  return /\.db(?:-wal|-shm)?$/.test(relativePath);
}

function hashFiles(home: string, protectedOnly: boolean): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const relativePath of walkFiles(home)) {
    if (isSqliteSidecar(relativePath)) continue;
    if (protectedOnly && relativePath.startsWith(`state${path.sep}pre-migration-backups${path.sep}`)) continue;
    entries[relativePath.split(path.sep).join('/')] = sha256File(path.join(home, relativePath));
  }
  return entries;
}

function tableExists(db: import('better-sqlite3').Database, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?",
  ).get(table));
}

function rows(
  db: import('better-sqlite3').Database,
  sql: string,
  ...args: unknown[]
): Json[] {
  return asJson(db.prepare(sql).all(...args)) as Json[];
}

function inspectSqlite(home: string, relativePath: string): SqliteInspection {
  const fullPath = path.join(home, relativePath);
  const db = new Database(fullPath, { readonly: true, fileMustExist: true });
  try {
    db.pragma('foreign_keys = ON');
    const tableNames = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all() as Array<{ name: string }>).map((row) => row.name);
    const tableCounts: Record<string, number> = {};
    const tableColumns: Record<string, string[]> = {};
    for (const name of tableNames) {
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`unsafe SQLite table name ${name}`);
      try {
        tableCounts[name] = Number((db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number }).count);
      } catch {
        // Some virtual-table shadow implementations do not permit a normal
        // count. Their owning virtual table and schema bytes remain inspected.
        tableCounts[name] = -1;
      }
      tableColumns[name] = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>)
        .map((column) => column.name)
        .sort();
    }
    const schemaVersions = tableExists(db, 'schema_version')
      ? (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>).map((row) => row.version)
      : null;
    const identities: Record<string, Json[]> = {};
    if (tableExists(db, 'sessions')) {
      identities.sessions = rows(db, 'SELECT id, kind, status, tokens_used FROM sessions ORDER BY id');
    }
    if (tableExists(db, 'events')) {
      identities.events = rows(db, 'SELECT id, session_id, seq, turn, role, type FROM events ORDER BY session_id, seq');
    }
    if (tableExists(db, 'pending_approvals')) {
      identities.pendingApprovals = rows(
        db,
        'SELECT approval_id, session_id, subject, tool, status, resolution, consumed_at FROM pending_approvals ORDER BY approval_id',
      );
    }
    if (tableExists(db, 'run_artifacts')) {
      identities.runArtifacts = rows(
        db,
        'SELECT id, session_id, run_scope_id, slot_key, kind, provider, status, resource_id, uri FROM run_artifacts ORDER BY slot_key',
      );
    }
    if (tableExists(db, 'memory_episodes')) {
      identities.memoryEpisodes = rows(
        db,
        'SELECT id, kind, session_id, call_id, status, content_hash FROM memory_episodes ORDER BY id',
      );
    }
    if (tableExists(db, 'entities')) {
      identities.entities = rows(
        db,
        'SELECT id, entity_type, canonical_name, canonical_name_lc FROM entities ORDER BY id',
      );
    }
    if (tableExists(db, 'current_focus')) {
      identities.focus = rows(db, 'SELECT id, resource_ref, title, status, related_session_id FROM current_focus ORDER BY id');
    }
    if (tableExists(db, 'workspaces')) {
      identities.workspaces = rows(db, 'SELECT id, slug, title, status, origin_session_id FROM workspaces ORDER BY id');
    }
    if (tableExists(db, 'workspace_dataset_observations')) {
      identities.workspaceObservations = rows(
        db,
        'SELECT id, workspace_id, source_key, refresh_id, batch_id, status, is_current FROM workspace_dataset_observations ORDER BY id',
      );
    }
    if (tableExists(db, 'workflow_triggers')) {
      identities.workflowTriggers = rows(
        db,
        'SELECT id, workflow_name, kind, schedule, timezone, webhook_path, event_type, enabled, generation FROM workflow_triggers ORDER BY id',
      );
    }
    if (tableExists(db, 'workflow_trigger_events')) {
      identities.workflowTriggerEvents = rows(
        db,
        'SELECT id, trigger_id, dedupe_key, run_id, state, attempt_count FROM workflow_trigger_events ORDER BY id',
      );
    }
    return {
      relativePath: relativePath.split(path.sep).join('/'),
      integrity: (db.pragma('integrity_check') as Array<{ integrity_check: string }>).map((row) => row.integrity_check),
      foreignKeyViolations: asJson(db.pragma('foreign_key_check')) as Json[],
      userVersion: Number(db.pragma('user_version', { simple: true }) ?? 0),
      schemaVersions,
      tableCounts,
      tableColumns,
      triggers: (db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
      ).all() as Array<{ name: string }>).map((row) => row.name),
      identities,
    };
  } finally {
    db.close();
  }
}

function readJsonArray(filePath: string): Json[] {
  if (!existsSync(filePath)) return [];
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  return Array.isArray(parsed) ? asJson(parsed) as Json[] : [];
}

function inspectCarriers(home: string, sqlite: Record<string, SqliteInspection>): HomeInspection['carriers'] {
  const harness = sqlite['state/harness.db'];
  const trigger = sqlite['state/workflow-triggers.db'];
  const eventTypes: Record<string, number> = {};
  if (harness) {
    for (const item of harness.identities.events ?? []) {
      const type = (item as { type?: unknown }).type;
      if (typeof type === 'string') eventTypes[type] = (eventTypes[type] ?? 0) + 1;
    }
  }
  const workflowRunFiles: string[] = [];
  const carrierFiles: string[] = [];
  for (const relativePath of walkFiles(home)) {
    const posixPath = relativePath.split(path.sep).join('/');
    const segments = posixPath.split('/');
    if (segments.includes('runs')) workflowRunFiles.push(posixPath);
    if (segments.some((segment) => CARRIER_DIRECTORY_NAMES.has(segment))) carrierFiles.push(posixPath);
  }
  const executions = readJsonArray(path.join(home, 'state', 'executions.json'))
    .map((entry) => {
      const item = entry as { id?: unknown; sessionId?: unknown; status?: unknown; autoAdvance?: unknown };
      return asJson({ id: item.id, sessionId: item.sessionId, status: item.status, autoAdvance: item.autoAdvance });
    });
  return {
    eventTypes,
    triggerEvents: trigger?.identities.workflowTriggerEvents ?? [],
    workflowRunFiles: workflowRunFiles.sort(),
    carrierFiles: carrierFiles.sort(),
    notifications: readJsonArray(path.join(home, 'state', 'notifications.json')),
    notificationQueue: readJsonArray(path.join(home, 'state', 'notification-delivery-queue.json')),
    executions,
  };
}

function inspectHome(homeInput: string): HomeInspection {
  const home = assertDisposablePath(homeInput, 'inspection home');
  const sqlite: Record<string, SqliteInspection> = {};
  for (const relativePath of walkFiles(home).filter((entry) => entry.endsWith('.db'))) {
    const key = relativePath.split(path.sep).join('/');
    sqlite[key] = inspectSqlite(home, relativePath);
  }
  return {
    sqlite,
    protectedFiles: hashFiles(home, true),
    allNonSqliteFiles: hashFiles(home, false),
    carriers: inspectCarriers(home, sqlite),
  };
}

function contiguous(values: number[], through: number): boolean {
  return values.length === through && values.every((value, index) => value === index + 1);
}

function checkFilePreservation(before: Record<string, string>, after: Record<string, string>): {
  ok: boolean;
  changed: string[];
  missing: string[];
} {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [name, digest] of Object.entries(before)) {
    if (!(name in after)) missing.push(name);
    else if (after[name] !== digest) changed.push(name);
  }
  return { ok: changed.length === 0 && missing.length === 0, changed, missing };
}

function hasIdentity(rowsInput: Json[] | undefined, key: string, value: string): boolean {
  return (rowsInput ?? []).some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return (entry as Record<string, Json>)[key] === value;
  });
}

function buildChecks(
  before: HomeInspection,
  first: HomeInspection,
  second: HomeInspection,
  currentSchemas: { harness: number; memory: number; workspace: number; workflowTrigger: number },
): Array<{ name: string; ok: boolean; detail?: Json }> {
  const checks: Array<{ name: string; ok: boolean; detail?: Json }> = [];
  const add = (name: string, ok: boolean, detail?: unknown): void => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail: asJson(detail) }) });
  };
  const beforeHarness = before.sqlite['state/harness.db'];
  const beforeMemory = before.sqlite['state/memory.db'];
  const beforeWorkspace = before.sqlite['state/workspaces.db'];
  const beforeTrigger = before.sqlite['state/workflow-triggers.db'];
  const firstHarness = first.sqlite['state/harness.db'];
  const firstMemory = first.sqlite['state/memory.db'];
  const firstWorkspace = first.sqlite['state/workspaces.db'];
  const firstTrigger = first.sqlite['state/workflow-triggers.db'];

  add('exact_v314_schema_start',
    beforeHarness?.schemaVersions?.at(-1) === V314_RELEASE.schemas.harness
      && beforeMemory?.schemaVersions?.at(-1) === V314_RELEASE.schemas.memory
      && beforeWorkspace?.userVersion === V314_RELEASE.schemas.workspace,
    {
      harness: beforeHarness?.schemaVersions?.at(-1) ?? null,
      memory: beforeMemory?.schemaVersions?.at(-1) ?? null,
      workspace: beforeWorkspace?.userVersion ?? null,
      triggerColumns: beforeTrigger ? Object.keys(beforeTrigger.tableCounts) : [],
    });
  add('current_schema_targets_reached',
    firstHarness?.schemaVersions?.at(-1) === currentSchemas.harness
      && firstMemory?.schemaVersions?.at(-1) === currentSchemas.memory
      && firstWorkspace?.userVersion === currentSchemas.workspace,
    {
      expected: currentSchemas,
      actual: {
        harness: firstHarness?.schemaVersions?.at(-1) ?? null,
        memory: firstMemory?.schemaVersions?.at(-1) ?? null,
        workspace: firstWorkspace?.userVersion ?? null,
      },
    });
  add('schema_ledgers_contiguous',
    Boolean(firstHarness?.schemaVersions && contiguous(firstHarness.schemaVersions, currentSchemas.harness))
      && Boolean(firstMemory?.schemaVersions && contiguous(firstMemory.schemaVersions, currentSchemas.memory)),
    {
      harnessRows: firstHarness?.schemaVersions?.length ?? 0,
      memoryRows: firstMemory?.schemaVersions?.length ?? 0,
    });
  const hasColumns = (table: string, required: string[]): boolean => {
    const columns = new Set(firstHarness?.tableColumns[table] ?? []);
    return required.every((column) => columns.has(column));
  };
  const harnessTriggers = new Set(firstHarness?.triggers ?? []);
  add('harness_current_call_lease_and_terminal_shape_installed',
    currentSchemas.harness < 53 || (
      hasColumns('run_dispatch_leases', ['source_user_seq', 'accepted_task_id', 'logical_tool_call_id'])
      && hasColumns('physical_dispatches', ['lease_scope_id', 'lease_id'])
      && hasColumns('logical_call_settlements', ['crossing_authority_version'])
      && hasColumns('logical_call_settlement_crossings', ['terminal_state', 'execution_site'])
      && harnessTriggers.has('trg_physical_dispatch_lease_owner')
      && harnessTriggers.has('trg_logical_settlement_crossing_update_immutable')
      && harnessTriggers.has('trg_logical_settlement_crossing_delete_immutable')
    ), {
      target: currentSchemas.harness,
      leaseColumns: firstHarness?.tableColumns.run_dispatch_leases ?? [],
      physicalColumns: firstHarness?.tableColumns.physical_dispatches ?? [],
      settlementColumns: firstHarness?.tableColumns.logical_call_settlements ?? [],
      crossingColumns: firstHarness?.tableColumns.logical_call_settlement_crossings ?? [],
      triggers: firstHarness?.triggers ?? [],
    });
  const dbHealth = Object.values(first.sqlite).map((inspection) => ({
    path: inspection.relativePath,
    integrity: inspection.integrity,
    foreignKeyViolations: inspection.foreignKeyViolations.length,
  }));
  add('all_sqlite_integrity_and_foreign_keys_clean',
    dbHealth.every((entry) => entry.integrity.length === 1
      && entry.integrity[0] === 'ok'
      && entry.foreignKeyViolations === 0), dbHealth);
  add('second_store_boot_is_logically_idempotent', stable(first) === stable(second), {
    firstDigest: sha256Bytes(stable(first)),
    secondDigest: sha256Bytes(stable(second)),
  });
  const preservation = checkFilePreservation(before.protectedFiles, first.protectedFiles);
  add('all_legacy_non_sqlite_bytes_preserved', preservation.ok, preservation);
  add('no_work_or_notification_replay_on_first_boot',
    stable(before.carriers) === stable(first.carriers), {
      beforeDigest: sha256Bytes(stable(before.carriers)),
      firstDigest: sha256Bytes(stable(first.carriers)),
    });
  add('no_work_or_notification_replay_on_second_boot',
    stable(first.carriers) === stable(second.carriers), {
      firstDigest: sha256Bytes(stable(first.carriers)),
      secondDigest: sha256Bytes(stable(second.carriers)),
    });
  add('conversation_identity_preserved',
    hasIdentity(firstHarness?.identities.sessions, 'id', REQUIRED_FIXTURE_IDENTITIES.sessionId),
    firstHarness?.identities.sessions ?? []);
  add('memory_and_entity_identities_preserved',
    (firstMemory?.identities.memoryEpisodes?.length ?? 0) >= 1
      && hasIdentity(firstMemory?.identities.entities, 'canonical_name', 'Upgrade Fixture Person'), {
      episodes: firstMemory?.identities.memoryEpisodes ?? [],
      entities: firstMemory?.identities.entities ?? [],
    });
  add('approval_and_artifact_identities_preserved',
    (firstHarness?.identities.pendingApprovals?.length ?? 0) === 2
      && hasIdentity(firstHarness?.identities.runArtifacts, 'slot_key', REQUIRED_FIXTURE_IDENTITIES.boundArtifactSlot)
      && hasIdentity(firstHarness?.identities.runArtifacts, 'slot_key', REQUIRED_FIXTURE_IDENTITIES.pendingArtifactSlot), {
      approvals: firstHarness?.identities.pendingApprovals ?? [],
      artifacts: firstHarness?.identities.runArtifacts ?? [],
    });
  add('workflow_trigger_and_space_identities_preserved',
    hasIdentity(firstTrigger?.identities.workflowTriggers, 'workflow_name', REQUIRED_FIXTURE_IDENTITIES.workflowName)
      && hasIdentity(firstWorkspace?.identities.workspaces, 'id', REQUIRED_FIXTURE_IDENTITIES.workspaceId)
      && (firstWorkspace?.identities.workspaceObservations?.length ?? 0) === 1, {
      triggers: firstTrigger?.identities.workflowTriggers ?? [],
      spaces: firstWorkspace?.identities.workspaces ?? [],
      observations: firstWorkspace?.identities.workspaceObservations ?? [],
    });
  add('workspace_v4_v5_projection_tables_exist_empty',
    firstWorkspace?.tableCounts.workspace_workflow_bindings === 0
      && firstWorkspace?.tableCounts.workspace_run_projections === 0
      && firstWorkspace?.tableCounts.workspace_run_partitions === 0
      && firstWorkspace?.tableCounts.workspace_canonical_entity_projection_heads === 0,
    firstWorkspace?.tableCounts ?? {});
  add('memory_pre_migration_snapshot_preserved',
    Object.keys(first.sqlite).some((name) =>
      name.startsWith('state/pre-migration-backups/') && name.endsWith('.db')
    ), Object.keys(first.sqlite).filter((name) => name.startsWith('state/pre-migration-backups/')));
  add('fixture_has_no_dispatch_or_run_carriers',
    (first.carriers.eventTypes.tool_called ?? 0) === 0
      && (first.carriers.eventTypes.async_work_dispatched ?? 0) === 0
      && first.carriers.triggerEvents.length === 0
      && first.carriers.workflowRunFiles.length === 0
      && first.carriers.notificationQueue.length === 0, first.carriers);
  return checks;
}

function parseInternalJson(stdout: string, label: string): Record<string, number> {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error(`${label} returned no JSON`);
  return JSON.parse(line) as Record<string, number>;
}

export async function runV314UpgradeRehearsal(
  options: V314UpgradeRehearsalOptions = {},
): Promise<V314UpgradeRehearsalReport> {
  const rehearsalRoot = options.rehearsalRoot
    ? assertDisposablePath(options.rehearsalRoot, 'rehearsal root')
    : mkdtempSync(path.join(tempRoot, 'clem-v314-upgrade-'));
  if (options.rehearsalRoot) {
    if (existsSync(rehearsalRoot) && readdirSync(rehearsalRoot).length > 0) {
      throw new Error(`rehearsal root must be empty: ${rehearsalRoot}`);
    }
    mkdirSync(rehearsalRoot, { recursive: true });
  }
  const exactTagCheckout = path.join(rehearsalRoot, 'exact-v3.14.0');
  const archivePath = path.join(rehearsalRoot, 'v3.14.0.tar');
  const legacyHome = path.join(rehearsalRoot, 'legacy-home');
  const immutableSnapshot = path.join(rehearsalRoot, 'snapshot-v3.14.0');
  const migratedHome = path.join(rehearsalRoot, 'migrated-home');
  const reportPath = path.join(rehearsalRoot, 'upgrade-report.json');

  checkoutExactRelease(exactTagCheckout, archivePath);
  const dependencyProof = verifyReleaseCheckout(exactTagCheckout);
  mkdirSync(legacyHome, { recursive: true });

  const tsxBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
  run(tsxBin, [scriptFile, '--internal-seed-v314', exactTagCheckout, legacyHome], {
    cwd: exactTagCheckout,
    env: isolatedChildEnv(legacyHome),
  });
  const before = inspectHome(legacyHome);

  cpSync(legacyHome, immutableSnapshot, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  cpSync(immutableSnapshot, migratedHome, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });

  const firstResult = run(tsxBin, [scriptFile, '--internal-migrate-current', migratedHome], {
    env: isolatedChildEnv(migratedHome),
  });
  const currentSchemas = parseInternalJson(firstResult.stdout, 'first current store boot') as {
    harness: number;
    memory: number;
    workspace: number;
    workflowTrigger: number;
  };
  const firstBoot = inspectHome(migratedHome);

  const secondResult = run(tsxBin, [scriptFile, '--internal-migrate-current', migratedHome], {
    env: isolatedChildEnv(migratedHome),
  });
  const secondSchemas = parseInternalJson(secondResult.stdout, 'second current store boot');
  if (stable(currentSchemas) !== stable(secondSchemas)) {
    throw new Error(`current schema constants changed between boots: ${stable(currentSchemas)} != ${stable(secondSchemas)}`);
  }
  const secondBoot = inspectHome(migratedHome);
  const checks = buildChecks(before, firstBoot, secondBoot, currentSchemas);
  const report: V314UpgradeRehearsalReport = {
    ok: checks.every((check) => check.ok),
    release: V314_RELEASE,
    dependencyProof,
    paths: {
      rehearsalRoot,
      exactTagCheckout,
      legacyHome,
      immutableSnapshot,
      migratedHome,
      report: reportPath,
    },
    before,
    firstBoot,
    secondBoot,
    checks,
    limitations: [
      'This is a two-process schema/store boot, not a daemon boot; it does not run recovery workers, timers, providers, notification delivery, or workflow dispatch.',
      'The fixture covers public v3.14 APIs and representative healthy rows. A sanitized production-home clone is still required to exercise historical corruption, partial writes, and machine-specific credentials.',
      'The exact v3.14 source tree is used with the repository node_modules only after proving the lock graphs are identical modulo root package-version metadata.',
    ],
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  if (options.keep === false) {
    // Library callers may explicitly clean up after consuming the report. The
    // CLI keeps the immutable snapshot by default so rollback evidence remains
    // recoverable and inspectable.
    assertDisposablePath(rehearsalRoot, 'cleanup root');
    rmSync(rehearsalRoot, { recursive: true, force: true });
  }
  return report;
}

function printHumanReport(report: V314UpgradeRehearsalReport): void {
  const passed = report.checks.filter((check) => check.ok).length;
  console.log(`${report.ok ? 'PASS' : 'FAIL'} v3.14.0 -> current upgrade rehearsal (${passed}/${report.checks.length} checks)`);
  for (const check of report.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
  console.log(`Immutable v3.14.0 snapshot: ${report.paths.immutableSnapshot}`);
  console.log(`Migrated copy: ${report.paths.migratedHome}`);
  console.log(`Full report: ${report.paths.report}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '--internal-seed-v314') {
    const checkout = args[1];
    const home = args[2];
    if (!checkout || !home) throw new Error('internal seed requires checkout and home');
    await seedV314Fixture(checkout, home);
    console.log(JSON.stringify({ seeded: true }));
    return;
  }
  if (args[0] === '--internal-migrate-current') {
    const home = args[1];
    if (!home) throw new Error('internal migration requires home');
    console.log(JSON.stringify(await migrateCurrentStores(home)));
    return;
  }
  const rootFlagIndex = args.indexOf('--rehearsal-root');
  const requestedRoot = rootFlagIndex >= 0 ? args[rootFlagIndex + 1] : undefined;
  if (rootFlagIndex >= 0 && !requestedRoot) throw new Error('--rehearsal-root requires a path below the OS temp directory');
  const report = await runV314UpgradeRehearsal({ rehearsalRoot: requestedRoot, keep: true });
  if (args.includes('--json')) console.log(JSON.stringify(report));
  else printHumanReport(report);
  if (!report.ok) process.exitCode = 1;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptFile);
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
