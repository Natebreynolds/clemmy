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
import { spawn, spawnSync } from 'node:child_process';
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

/**
 * Deterministic install identity owned by the disposable v3.14 fixture.
 * Seed it before importing any exact-tag module because legacy tool-choice
 * paths may otherwise create a random identity as a read-side effect.
 */
export const V314_GATE_MACHINE_ID = 'upgrade-rehearsal-machine-v314';

/**
 * The v3.16 release pins schema 69's model-result projection receipt to
 * lineage and digest metadata only. The projected result stays in the
 * accepted model history; the migration must not create a second payload
 * store under a differently named column.
 */
export const SCHEMA_V69_MODEL_RESULT_PROJECTION_RECEIPT_COLUMNS = Object.freeze([
  'accepted_task_id',
  'batch_id',
  'batch_ordinal',
  'call_id',
  'call_namespace',
  'protocol_version',
  'receipt_id',
  'recorded_at',
  'result_class',
  'result_item_bytes',
  'result_item_sha256',
  'session_id',
  'settlement_event_id',
  'settlement_identity_kind',
  'settlement_logical_tool_call_id',
  'settlement_observer_call_id',
  'settlement_semantic_digest',
  'source_event_id',
  'source_user_seq',
  'tool_name',
] as const);

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
export const REQUIRED_FIXTURE_IDENTITIES = Object.freeze({
  sessionId: 'upgrade-rehearsal-chat-v314',
  approvalOwnerSessionId: 'upgrade-rehearsal-approval-owner-v314',
  workflowName: 'upgrade-rehearsal-workflow',
  workspaceId: 'upgrade-rehearsal-space',
  notificationId: 'upgrade-rehearsal-notification-v314',
  executionSessionId: 'upgrade-rehearsal-execution-v314',
  boundArtifactSlot: 'upgrade-bound-artifact',
  pendingArtifactSlot: 'upgrade-pending-artifact',
  activeAttemptSessionId: 'upgrade-rehearsal-active-chat-v314',
  activeAttemptId: 'attempt:upgrade-rehearsal-active-v314',
  activeRunId: 'upgrade-rehearsal-active-v314',
  // v3.14 harness event sequence is database-global: the completed fixture
  // chat owns seq 1/2, so this accepted source is deterministically seq 3.
  activeSourceUserSeq: 3,
  triggerOccurrenceId: 'upgrade-trigger-occurrence-v314',
  scheduleOccurrenceAtMs: Date.UTC(2026, 0, 1, 0, 0, 0),
  scheduleReceiptId: 'workflow-schedule:v1:upgrade-rehearsal-workflow:1767225600000',
  ambiguousWriteCallId: 'upgrade-ambiguous-write-v314',
  ambiguousWriteTarget: 'upgrade.ambiguous@example.invalid',
  ambiguousWriteLeaseScopeId: 'upgrade-ambiguous-write-scope-v314',
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
  currentSchemas: {
    harness: number;
    memory: number;
    workspace: number;
    workflowTrigger: number;
  };
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

export interface SqliteInspection {
  relativePath: string;
  integrity: string[];
  foreignKeyViolations: Json[];
  userVersion: number;
  schemaVersions: number[] | null;
  tableCounts: Record<string, number>;
  /** Content digest for every queryable logical table, with row order
   * canonicalized. Unlike the SQLite file bytes this is stable across WAL
   * checkpoints and page-layout changes, but it still detects any row edit. */
  tableDigests: Record<string, string>;
  /** Canonical digest of every non-internal sqlite_master object definition. */
  schemaDigest: string;
  tableColumns: Record<string, string[]>;
  tableForeignKeys: Record<string, Json[]>;
  triggers: string[];
  identities: Record<string, Json[]>;
}

export interface HomeInspection {
  sqlite: Record<string, SqliteInspection>;
  protectedFiles: Record<string, string>;
  allNonSqliteFiles: Record<string, string>;
  carriers: {
    eventTypes: Record<string, number>;
    triggerEvents: Json[];
    workflowRunFiles: string[];
    workflowRuns: Json[];
    triggerReceiptAcceptances: Json[];
    workflowRunEvents: Json[];
    workflowScheduleState: Json | null;
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

/**
 * The rehearsal executes archived source against the already-installed
 * package records in current node_modules. Root package metadata describes
 * how that identical tree was requested; it is not an installed dependency.
 * Compare every non-root lock record byte-for-byte so a promoted direct
 * dependency is allowed only when the exact package was already present in
 * the v3.14 installation graph.
 */
export function normalizedInstalledPackageGraph(lock: unknown): unknown {
  const copy = structuredClone(lock) as {
    name?: unknown;
    version?: unknown;
    packages?: Record<string, unknown>;
  };
  delete copy.name;
  delete copy.version;
  if (copy.packages) delete copy.packages[''];
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
  const normalizedLockGraphEqual = stable(normalizedInstalledPackageGraph(tagLock))
    === stable(normalizedInstalledPackageGraph(currentLock));
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
  const stateDir = path.join(home, 'state');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'machine-id'), `${V314_GATE_MACHINE_ID}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });

  const eventlog = await importFrom(checkout, 'src/runtime/harness/eventlog.ts') as {
    createSession(input: Record<string, unknown>): unknown;
    appendEvent(input: Record<string, unknown>): { seq: number };
    updateSession(id: string, patch: Record<string, unknown>): unknown;
    beginRunAttempt(sessionId: string, input: { runId: string; attemptId: string }): {
      sessionId: string;
      attemptId: string;
      runId: string | null;
    };
    bindRunAttemptSourceUserEvent(
      attempt: { sessionId: string; attemptId: string },
      sourceUserSeq: number,
    ): void;
    openEventLog(): import('better-sqlite3').Database;
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

  // Give the deliberately aged approval its own dead owner. The current
  // reaper is expected to cancel that session while quarantining the card; it
  // must not rewrite the representative completed conversation exercised by
  // the packaged candidate.
  eventlog.createSession({
    id: REQUIRED_FIXTURE_IDENTITIES.approvalOwnerSessionId,
    kind: 'chat',
    channel: 'upgrade-rehearsal',
    userId: 'fixture-user-v314',
    title: 'v3.14 dead approval owner',
    objective: 'Prove one aged ownerless approval is quarantined exactly once.',
    metadata: { fixture: 'v3.14.0', approvalOwner: true },
  });
  eventlog.updateSession(REQUIRED_FIXTURE_IDENTITIES.approvalOwnerSessionId, {
    status: 'completed',
    tokensUsed: 0,
  });

  // Leave one exact v3.14 foreground owner active. A store-only migration must
  // preserve it byte-for-byte; the packaged daemon boot owns the distinct
  // recovery decision and must interrupt it once without inventing work.
  eventlog.createSession({
    id: REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId,
    kind: 'chat',
    channel: 'upgrade-rehearsal',
    userId: 'fixture-user-v314',
    title: 'v3.14 interrupted-at-upgrade conversation',
    objective: 'Prove daemon boot retires an owner from the dead process.',
    metadata: { fixture: 'v3.14.0', activeAttempt: true },
  });
  const activeSource = eventlog.appendEvent({
    sessionId: REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'This exact owner was active when the old process stopped.', synthetic: false },
  });
  const activeAttempt = eventlog.beginRunAttempt(REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId, {
    runId: REQUIRED_FIXTURE_IDENTITIES.activeRunId,
    attemptId: REQUIRED_FIXTURE_IDENTITIES.activeAttemptId,
  });
  eventlog.bindRunAttemptSourceUserEvent(activeAttempt, activeSource.seq);
  const restartRecovery = await importFrom(checkout, 'src/runtime/harness/restart-recovery.ts') as {
    markRunInFlight(sessionId: string, on: boolean): void;
  };
  restartRecovery.markRunInFlight(REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId, true);

  const approvalRegistry = await importFrom(checkout, 'src/runtime/harness/approval-registry.ts') as {
    register(input: Record<string, unknown>): { approvalId: string };
    resolve(id: string, resolution: string, resolver: string): unknown;
  };
  const pendingApproval = approvalRegistry.register({
    sessionId: REQUIRED_FIXTURE_IDENTITIES.approvalOwnerSessionId,
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
  // Make the unresolved card an old, ownerless approval deliberately. Current
  // boot must quarantine it once by policy, independent of test duration; a
  // wall-clock-fresh row would turn the 90-second reaper floor into a flaky
  // accidental proof. Its TTL remains far in the future so the asserted owner
  // is specifically the dead-session reaper rather than generic expiry.
  eventlog.openEventLog().prepare(`
    UPDATE pending_approvals
       SET requested_at = ?, expires_at = ?
     WHERE approval_id = ?
  `).run('2026-08-07T22:40:00.000Z', '2099-01-01T00:00:00.000Z', pendingApproval.approvalId);
  eventlog.appendEvent({
    sessionId: REQUIRED_FIXTURE_IDENTITIES.approvalOwnerSessionId,
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
  const scheduler = await importFrom(checkout, 'src/execution/workflow-scheduler.ts') as {
    processWorkflowSchedules(now: Date): Promise<{
      fired: string[];
      held: string[];
      deferred: string[];
      deduped: string[];
    }>;
  };
  const scheduled = await scheduler.processWorkflowSchedules(
    new Date(REQUIRED_FIXTURE_IDENTITIES.scheduleOccurrenceAtMs),
  );
  if (
    scheduled.fired.length !== 1
    || scheduled.fired[0] !== REQUIRED_FIXTURE_IDENTITIES.workflowName
    || scheduled.held.length !== 0
    || scheduled.deferred.length !== 0
  ) {
    throw new Error(`exact v3.14 schedule occurrence was not durably admitted: ${stable(scheduled)}`);
  }
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
  // Seed one real v3.14 data-plane audit carrier through the archived public
  // API.  An absent audit file made the packaged four-phase equality check
  // vacuous: all four inspections could agree that no carrier existed.  The
  // row is deliberately bounded and inert; its only job is to prove that an
  // existing append-only workspace audit survives migration, daemon recovery,
  // the installed-package exercise, and the second boot byte-for-byte.
  const workspaceDataStore = await importFrom(checkout, 'src/spaces/data-store.ts') as {
    appendAudit(slug: string, entry: Record<string, unknown>): void;
  };
  workspaceDataStore.appendAudit(REQUIRED_FIXTURE_IDENTITIES.workspaceId, {
    method: 'FIXTURE',
    path: '/upgrade-rehearsal/v3.14',
    outcome: 'ok',
    bytes: 0,
    note: 'Bounded exact-v3.14 workspace audit carrier.',
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
  // v3.14 and current Clementine both store a direct server-name map here.
  // The Claude-compatible `{ mcpServers: ... }` wrapper belongs only to the
  // optional import source; a blank first-party registry is exactly `{}`.
  writeFileSync(path.join(home, 'mcp', 'servers.json'), JSON.stringify({}, null, 2));
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

/** Exact-tag child entry used by the parent to cut the process after the run
 * queue has durably accepted an event occurrence but before the v3.14 SQLite
 * trigger receipt transaction commits. The parent must SIGKILL this process;
 * reaching the return is a failed rehearsal, not a successful seed. */
async function seedV314TriggerQueueCrash(checkout: string, home: string): Promise<void> {
  assertDisposablePath(checkout, 'exact-tag checkout');
  assertDisposablePath(home, 'legacy fixture home');
  const triggerEngine = await importFrom(checkout, 'src/execution/workflow-trigger-engine.ts') as {
    fireWorkflowSystemEvent(eventType: string, payload: unknown): unknown;
  };
  triggerEngine.fireWorkflowSystemEvent('upgrade.rehearsal.never-fired', {
    fixture: true,
    id: REQUIRED_FIXTURE_IDENTITIES.triggerOccurrenceId,
    fixtureId: 'fixture-item-v314',
  });
  throw new Error('v3.14 trigger crash boundary was released instead of terminating the process');
}

/** Exact-tag child entry for a real post-reservation provider crossing. The
 * wrapped v3.14 adapter appends its external_write reservation, validates the
 * durable lease, enters the supplied provider body, and then waits forever.
 * The parent SIGKILL is therefore after physical dispatch began and before any
 * returned/failed/orphaned outcome could settle the reservation. */
async function seedV314AmbiguousWriteDispatch(checkout: string, home: string): Promise<void> {
  assertDisposablePath(checkout, 'exact-tag checkout');
  assertDisposablePath(home, 'legacy fixture home');
  const ready = process.env.CLEMENTINE_TEST_V314_WRITE_PROVIDER_READY;
  if (!ready) throw new Error('v3.14 ambiguous-write child requires a provider-ready marker');
  const dispatchLease = await importFrom(checkout, 'src/runtime/harness/dispatch-lease.ts') as {
    activateDispatchLease(input: {
      sessionId: string;
      scopeId: string;
      runAttemptId: string;
    }): unknown;
  };
  const brackets = await importFrom(checkout, 'src/runtime/harness/brackets.ts') as {
    ToolCallsCounter: new (limit: number) => unknown;
    wrapToolForHarness<T>(tool: T, options?: { timeoutMs?: number }): T;
    withHarnessRunContext<T>(context: Record<string, unknown>, work: () => T | Promise<T>): T | Promise<T>;
  };
  Object.assign(process.env, {
    HARNESS_TOOL_BRACKETS: 'on',
    CLEMMY_EXECUTION_GATE: 'off',
    CLEMMY_CONFIRM_FIRST: 'off',
    CLEMMY_GROUNDING_GATE: 'off',
    CLEMMY_GOAL_FIDELITY_GATE: 'off',
    CLEMMY_OUTPUT_GROUNDING_GATE: 'off',
    CLEMMY_DESTINATION_GATE: 'off',
  });
  const lease = dispatchLease.activateDispatchLease({
    sessionId: REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId,
    scopeId: REQUIRED_FIXTURE_IDENTITIES.ambiguousWriteLeaseScopeId,
    runAttemptId: REQUIRED_FIXTURE_IDENTITIES.activeAttemptId,
  });
  const tool = brackets.wrapToolForHarness({
    name: 'composio_execute_tool',
    invoke: async () => {
      writeFileSync(ready, `${process.pid}\n`, { flag: 'wx' });
      await new Promise<never>(() => undefined);
    },
  }, { timeoutMs: 10 * 60_000 }) as {
    invoke(runContext: unknown, input: string, details: unknown): Promise<unknown>;
  };
  await brackets.withHarnessRunContext({
    sessionId: REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId,
    sourceUserSeq: REQUIRED_FIXTURE_IDENTITIES.activeSourceUserSeq,
    behaviorScopeId: REQUIRED_FIXTURE_IDENTITIES.ambiguousWriteLeaseScopeId,
    counter: new brackets.ToolCallsCounter(10),
    dispatchLease: lease,
    runAttemptId: REQUIRED_FIXTURE_IDENTITIES.activeAttemptId,
  }, () => tool.invoke(null, JSON.stringify({
    tool_slug: 'AIRTABLE_CREATE_RECORD',
    arguments: {
      email: REQUIRED_FIXTURE_IDENTITIES.ambiguousWriteTarget,
      value: 'opaque-v314',
    },
  }), { toolCall: { callId: REQUIRED_FIXTURE_IDENTITIES.ambiguousWriteCallId } }));
  throw new Error('v3.14 ambiguous-write provider boundary returned instead of being terminated');
}

async function createV314AmbiguousWriteDispatchCarrier(input: {
  checkout: string;
  home: string;
  rehearsalRoot: string;
}): Promise<void> {
  const ready = path.join(input.rehearsalRoot, 'v314-write-provider-crossed.ready');
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    scriptFile,
    '--internal-seed-v314-ambiguous-write-dispatch',
    input.checkout,
    input.home,
  ], {
    cwd: input.checkout,
    env: {
      ...isolatedChildEnv(input.home),
      CLEMENTINE_TEST_V314_WRITE_PROVIDER_READY: ready,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
  const deadline = Date.now() + 30_000;
  while (!existsSync(ready) && Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(ready)) {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
    throw new Error(
      `exact v3.14 write did not cross the real wrapped provider boundary\n${stderr || stdout}`,
    );
  }
  child.kill('SIGKILL');
  const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const cleanup = (): void => {
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    if (child.exitCode !== null || child.signalCode) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('exit', onExit);
    child.once('error', onError);
  });
  if (exited.signal !== 'SIGKILL') {
    throw new Error(
      `exact v3.14 ambiguous-write child exited without SIGKILL (${exited.code}/${exited.signal})\n${stderr || stdout}`,
    );
  }
}

async function disableV314WorkflowAfterQueueCrash(checkout: string, home: string): Promise<void> {
  assertDisposablePath(checkout, 'exact-tag checkout');
  assertDisposablePath(home, 'legacy fixture home');
  const workflows = await importFrom(checkout, 'src/memory/workflow-store.ts') as {
    readWorkflow(name: string): { data: Record<string, unknown> } | null;
    writeWorkflow(name: string, definition: Record<string, unknown>): unknown;
  };
  const current = workflows.readWorkflow(REQUIRED_FIXTURE_IDENTITIES.workflowName);
  if (!current) throw new Error('exact v3.14 workflow disappeared after trigger queue acceptance');
  workflows.writeWorkflow(REQUIRED_FIXTURE_IDENTITIES.workflowName, {
    ...current.data,
    enabled: false,
    description: 'A preserved v3.14 workflow disabled after an ambiguous trigger queue crash.',
  });
}

async function createV314TriggerQueueCrashCarrier(input: {
  checkout: string;
  home: string;
  rehearsalRoot: string;
}): Promise<void> {
  const ready = path.join(input.rehearsalRoot, 'v314-trigger-after-queue.ready');
  const release = path.join(input.rehearsalRoot, 'v314-trigger-after-queue.release');
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    scriptFile,
    '--internal-seed-v314-trigger-queue-crash',
    input.checkout,
    input.home,
  ], {
    cwd: input.checkout,
    env: {
      ...isolatedChildEnv(input.home),
      CLEMENTINE_TEST_TRIGGER_AFTER_QUEUE_READY: ready,
      CLEMENTINE_TEST_TRIGGER_AFTER_QUEUE_RELEASE: release,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
  const deadline = Date.now() + 30_000;
  while (!existsSync(ready) && Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(ready)) {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
    throw new Error(
      `exact v3.14 trigger did not reach the durable queue/pre-receipt crash boundary\n${stderr || stdout}`,
    );
  }
  child.kill('SIGKILL');
  const exited = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    if (child.exitCode !== null || child.signalCode) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    child.once('exit', onExit);
    child.once('error', onError);
  });
  if (exited.signal !== 'SIGKILL') {
    throw new Error(
      `exact v3.14 trigger crash child exited without SIGKILL (${exited.code}/${exited.signal})\n${stderr || stdout}`,
    );
  }
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
    const tableDigests: Record<string, string> = {};
    const tableColumns: Record<string, string[]> = {};
    const tableForeignKeys: Record<string, Json[]> = {};
    for (const name of tableNames) {
      if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`unsafe SQLite table name ${name}`);
      try {
        tableCounts[name] = Number((db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get() as { count: number }).count);
      } catch {
        // Some virtual-table shadow implementations do not permit a normal
        // count. Their owning virtual table and schema bytes remain inspected.
        tableCounts[name] = -1;
      }
      try {
        const logicalRows = asJson(db.prepare(`SELECT * FROM "${name}"`).all()) as Json[];
        logicalRows.sort((left, right) => stable(left).localeCompare(stable(right)));
        tableDigests[name] = sha256Bytes(stable(logicalRows));
      } catch (error) {
        // A release proof may not silently skip a table. The non-digest value
        // makes the health/readiness gate fail with the exact table identity.
        tableDigests[name] = `unreadable:${error instanceof Error ? error.message : String(error)}`;
      }
      tableColumns[name] = (db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>)
        .map((column) => column.name)
        .sort();
      tableForeignKeys[name] = asJson(
        db.prepare(`PRAGMA foreign_key_list("${name}")`).all(),
      ) as Json[];
    }
    const schemaVersions = tableExists(db, 'schema_version')
      ? (db.prepare('SELECT version FROM schema_version ORDER BY version').all() as Array<{ version: number }>).map((row) => row.version)
      : null;
    const schemaObjects = rows(
      db,
      `SELECT type, name, tbl_name, sql
         FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    );
    const identities: Record<string, Json[]> = {};
    if (tableExists(db, 'sessions')) {
      identities.sessions = rows(db, 'SELECT id, kind, status, tokens_used FROM sessions ORDER BY id');
    }
    if (tableExists(db, 'events')) {
      identities.events = rows(
        db,
        'SELECT id, session_id, seq, turn, role, type, data_json, created_at FROM events ORDER BY session_id, seq',
      );
    }
    if (tableExists(db, 'pending_approvals')) {
      identities.pendingApprovals = rows(
        db,
        'SELECT * FROM pending_approvals ORDER BY approval_id',
      );
    }
    if (tableExists(db, 'run_artifacts')) {
      identities.runArtifacts = rows(
        db,
        'SELECT id, session_id, run_scope_id, slot_key, kind, provider, status, resource_id, uri FROM run_artifacts ORDER BY slot_key',
      );
    }
    if (tableExists(db, 'run_attempts')) {
      identities.runAttempts = rows(
        db,
        'SELECT attempt_id, session_id, source_user_seq, run_id, started_at, finished_at, status FROM run_attempts ORDER BY attempt_id',
      );
    }
    if (tableExists(db, 'run_dispatch_leases')) {
      identities.dispatchLeases = rows(
        db,
        'SELECT * FROM run_dispatch_leases ORDER BY scope_id',
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
        `SELECT id, trigger_id, fired_at, dedupe_key, payload_hash, payload_json,
                run_id, deduped, state, attempt_count, last_attempt_at,
                next_attempt_at, last_error, claim_token, claim_expires_at,
                enqueued_at, trigger_generation, updated_at
           FROM workflow_trigger_events
          ORDER BY id`,
      );
    }
    if (tableExists(db, 'automation_opportunity_proposals')) {
      identities.automationOpportunityProposals = rows(
        db,
        `SELECT proposal_id, status, revision, digest, opportunity_json,
                created_at, updated_at, reviewed_at, decided_at
           FROM automation_opportunity_proposals
          ORDER BY proposal_id`,
      );
    }
    if (tableExists(db, 'automation_opportunity_review_projections')) {
      identities.automationOpportunityReviews = rows(
        db,
        `SELECT projection_id, proposal_id, proposal_revision_at_request,
                proposal_digest, reviewed_revision, owner_session_id,
                request_source_user_seq, approval_id, approval_args_digest, status,
                refusal_code, refusal_detail
           FROM automation_opportunity_review_projections
          ORDER BY projection_id`,
      );
    }
    if (tableExists(db, 'automation_pilot_advancements')) {
      identities.automationPilotAdvancements = rows(
        db,
        `SELECT advancement_id, review_projection_id, proposal_id,
                proposal_revision, proposal_digest, owner_session_id,
                source_user_seq, stage, state_revision, state_digest, state_json
           FROM automation_pilot_advancements
          ORDER BY advancement_id`,
      );
    }
    return {
      relativePath: relativePath.split(path.sep).join('/'),
      integrity: (db.pragma('integrity_check') as Array<{ integrity_check: string }>).map((row) => row.integrity_check),
      foreignKeyViolations: asJson(db.pragma('foreign_key_check')) as Json[],
      userVersion: Number(db.pragma('user_version', { simple: true }) ?? 0),
      schemaVersions,
      tableCounts,
      tableDigests,
      schemaDigest: sha256Bytes(stable(schemaObjects)),
      tableColumns,
      tableForeignKeys,
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

function readJsonRecord(filePath: string): Record<string, Json> | null {
  if (!existsSync(filePath)) return null;
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? asJson(parsed) as Record<string, Json>
    : null;
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
  const workflowRuns: Json[] = [];
  const triggerReceiptAcceptances: Json[] = [];
  const workflowRunEvents: Json[] = [];
  const carrierFiles: string[] = [];
  let workflowScheduleState: Json | null = null;
  for (const relativePath of walkFiles(home)) {
    const posixPath = relativePath.split(path.sep).join('/');
    const segments = posixPath.split('/');
    if (segments.includes('runs')) workflowRunFiles.push(posixPath);
    if (segments.some((segment) => CARRIER_DIRECTORY_NAMES.has(segment))) carrierFiles.push(posixPath);
    const fullPath = path.join(home, relativePath);
    if (posixPath.endsWith('/events.jsonl') && segments.includes('runs')) {
      const events = readFileSync(fullPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
        try {
          return asJson(JSON.parse(line));
        } catch {
          return asJson({ malformed: true, lineSha256: sha256Bytes(line) });
        }
      });
      workflowRunEvents.push(asJson({ file: posixPath, events }));
    }
    if (path.basename(relativePath) === 'workflow-schedule-state.json') {
      const schedule = readJsonRecord(fullPath);
      if (schedule) {
        // The observation watermark advances on every scheduler tick; it is
        // not occurrence authority. Every actual occurrence/dedupe/pending
        // field remains in the logical projection and must stay exact.
        const { lastEvaluatedAtMs: _observationWatermark, ...authority } = schedule;
        workflowScheduleState = asJson(authority);
      }
    }
    if (!posixPath.endsWith('.json')) continue;
    const record = readJsonRecord(fullPath);
    if (!record) continue;
    if (segments.includes('.trigger-receipts')) {
      triggerReceiptAcceptances.push(asJson({
        file: posixPath,
        version: record.version ?? null,
        receiptId: record.receiptId ?? null,
        runId: record.runId ?? null,
        compiledContractHash: record.compiledContractHash ?? null,
        sha256: sha256File(fullPath),
      }));
      continue;
    }
    if (path.basename(path.dirname(relativePath)) === 'runs') {
      workflowRuns.push(asJson({
        file: posixPath,
        id: record.id ?? null,
        workflow: record.workflow ?? null,
        workflowSlug: record.workflowSlug ?? null,
        inputs: record.inputs ?? null,
        source: record.source ?? null,
        createdAt: record.createdAt ?? null,
        workflowDefinitionSnapshotDigest: record.workflowDefinitionSnapshot === undefined
          ? null
          : sha256Bytes(stable(record.workflowDefinitionSnapshot)),
        status: record.status ?? null,
        triggerReceiptId: record.triggerReceiptId ?? null,
        startedAt: record.startedAt ?? null,
        finishedAt: record.finishedAt ?? null,
        error: record.error ?? null,
        sha256: sha256File(fullPath),
      }));
    }
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
    workflowRuns: workflowRuns.sort((left, right) => stable(left).localeCompare(stable(right))),
    triggerReceiptAcceptances: triggerReceiptAcceptances
      .sort((left, right) => stable(left).localeCompare(stable(right))),
    workflowRunEvents: workflowRunEvents
      .sort((left, right) => stable(left).localeCompare(stable(right))),
    workflowScheduleState,
    carrierFiles: carrierFiles.sort(),
    notifications: readJsonArray(path.join(home, 'state', 'notifications.json')),
    notificationQueue: readJsonArray(path.join(home, 'state', 'notification-delivery-queue.json')),
    executions,
  };
}

export function inspectV314RehearsalHome(homeInput: string): HomeInspection {
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
  const workflowTriggerV4ShapeInstalled = (inspection: SqliteInspection | undefined): boolean => {
    const triggers = new Set(inspection?.tableColumns.workflow_triggers ?? []);
    const events = new Set(inspection?.tableColumns.workflow_trigger_events ?? []);
    return [
      'id', 'workflow_name', 'kind', 'enabled', 'generation',
    ].every((column) => triggers.has(column))
      && [
        'id', 'trigger_id', 'dedupe_key', 'payload_hash', 'payload_json',
        'run_id', 'state', 'attempt_count', 'claim_token', 'claim_expires_at',
        'trigger_generation', 'enqueued_at',
      ].every((column) => events.has(column));
  };

  add('exact_v314_schema_start',
    beforeHarness?.schemaVersions?.at(-1) === V314_RELEASE.schemas.harness
      && beforeMemory?.schemaVersions?.at(-1) === V314_RELEASE.schemas.memory
      && beforeWorkspace?.userVersion === V314_RELEASE.schemas.workspace
      && V314_RELEASE.schemas.workflowTrigger === 4
      && workflowTriggerV4ShapeInstalled(beforeTrigger),
    {
      harness: beforeHarness?.schemaVersions?.at(-1) ?? null,
      memory: beforeMemory?.schemaVersions?.at(-1) ?? null,
      workspace: beforeWorkspace?.userVersion ?? null,
      workflowTrigger: {
        contractVersion: V314_RELEASE.schemas.workflowTrigger,
        userVersion: beforeTrigger?.userVersion ?? null,
        schemaDigest: beforeTrigger?.schemaDigest ?? null,
      },
    });
  add('current_schema_targets_reached',
    firstHarness?.schemaVersions?.at(-1) === currentSchemas.harness
      && firstMemory?.schemaVersions?.at(-1) === currentSchemas.memory
      && firstWorkspace?.userVersion === currentSchemas.workspace
      && currentSchemas.workflowTrigger === V314_RELEASE.schemas.workflowTrigger
      && workflowTriggerV4ShapeInstalled(firstTrigger)
      && firstTrigger?.schemaDigest === beforeTrigger?.schemaDigest,
    {
      expected: currentSchemas,
      actual: {
        harness: firstHarness?.schemaVersions?.at(-1) ?? null,
        memory: firstMemory?.schemaVersions?.at(-1) ?? null,
        workspace: firstWorkspace?.userVersion ?? null,
        workflowTrigger: {
          contractVersion: currentSchemas.workflowTrigger,
          userVersion: firstTrigger?.userVersion ?? null,
          schemaDigest: firstTrigger?.schemaDigest ?? null,
        },
      },
    });
  const projectionReceiptTable = 'logical_model_result_projection_receipts';
  const projectionReceiptTriggers = [
    'trg_logical_model_result_projection_exact_lineage',
    'trg_logical_model_result_projection_exact_settlement',
    'trg_logical_model_result_projection_immutable',
    'trg_logical_model_result_projection_delete_immutable',
  ] as const;
  const firstHarnessTriggers = new Set(firstHarness?.triggers ?? []);
  add('schema_v69_model_result_projection_receipts_are_metadata_only_and_not_invented',
    currentSchemas.harness >= 69
      && firstHarness?.schemaVersions?.includes(69) === true
      && !Object.prototype.hasOwnProperty.call(beforeHarness?.tableCounts ?? {}, projectionReceiptTable)
      && stable(firstHarness?.tableColumns[projectionReceiptTable] ?? [])
        === stable(SCHEMA_V69_MODEL_RESULT_PROJECTION_RECEIPT_COLUMNS)
      && firstHarness?.tableCounts[projectionReceiptTable] === 0
      && second.sqlite['state/harness.db']?.tableCounts[projectionReceiptTable] === 0
      && projectionReceiptTriggers.every((trigger) => firstHarnessTriggers.has(trigger)), {
        targetHarnessSchema: currentSchemas.harness,
        beforeTablePresent: Object.prototype.hasOwnProperty.call(
          beforeHarness?.tableCounts ?? {},
          projectionReceiptTable,
        ),
        firstColumns: firstHarness?.tableColumns[projectionReceiptTable] ?? [],
        expectedColumns: SCHEMA_V69_MODEL_RESULT_PROJECTION_RECEIPT_COLUMNS,
        firstCount: firstHarness?.tableCounts[projectionReceiptTable] ?? null,
        secondCount: second.sqlite['state/harness.db']?.tableCounts[projectionReceiptTable] ?? null,
        requiredTriggers: projectionReceiptTriggers,
      });
  const amendmentForeignKeys = (firstHarness?.tableForeignKeys.expected_work_universe_amendments ?? [])
    .map((row) => row as Record<string, Json>);
  const amendmentForeignKeyGroups = new Map<number, string[]>();
  for (const row of amendmentForeignKeys) {
    const id = Number(row.id);
    const seq = Number(row.seq);
    const group = amendmentForeignKeyGroups.get(id) ?? [];
    group[seq] = `${String(row.from)}:${String(row.table)}.${String(row.to)}:${String(row.on_delete)}`;
    amendmentForeignKeyGroups.set(id, group);
  }
  const amendmentCascadeShape = [...amendmentForeignKeyGroups.values()]
    .map((group) => group.join('|'))
    .sort();
  const expectedAmendmentCascadeShape = [
    'session_id:accepted_task_work_contracts.session_id:CASCADE'
      + '|source_user_seq:accepted_task_work_contracts.source_user_seq:CASCADE'
      + '|contract_id:accepted_task_work_contracts.contract_id:CASCADE',
    'session_id:events.session_id:CASCADE|amendment_event_id:events.id:CASCADE',
    'session_id:sessions.id:CASCADE',
  ].sort();
  add('schema_v70_amendments_have_exact_retention_cascade_and_keep_standalone_immutability',
    currentSchemas.harness === 74
      && firstHarness?.schemaVersions?.includes(70) === true
      && stable(amendmentCascadeShape) === stable(expectedAmendmentCascadeShape)
      && firstHarnessTriggers.has('trg_expected_work_universe_amendment_update_immutable')
      && firstHarnessTriggers.has('trg_expected_work_universe_amendment_delete_immutable'), {
        targetHarnessSchema: currentSchemas.harness,
        actualForeignKeys: amendmentCascadeShape,
        expectedForeignKeys: expectedAmendmentCascadeShape,
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
      hasColumns('run_dispatch_leases', [
        'source_user_seq', 'accepted_task_id', 'logical_tool_call_id', 'revocation_reason',
      ])
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
    unreadableTables: Object.entries(inspection.tableDigests)
      .filter(([, digest]) => !/^[a-f0-9]{64}$/.test(digest))
      .map(([table]) => table),
  }));
  add('all_sqlite_integrity_and_foreign_keys_clean',
    dbHealth.every((entry) => entry.integrity.length === 1
      && entry.integrity[0] === 'ok'
      && entry.foreignKeyViolations === 0
      && entry.unreadableTables.length === 0), dbHealth);
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
  const activeAttemptPreserved = (firstHarness?.identities.runAttempts ?? []).some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const row = entry as Record<string, Json>;
    return row.attempt_id === REQUIRED_FIXTURE_IDENTITIES.activeAttemptId
      && row.session_id === REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId
      && row.source_user_seq === REQUIRED_FIXTURE_IDENTITIES.activeSourceUserSeq
      && row.run_id === REQUIRED_FIXTURE_IDENTITIES.activeRunId
      && row.status === 'active'
      && row.finished_at === null;
  });
  const ambiguousWritePreserved = (firstHarness?.identities.events ?? []).some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const row = entry as Record<string, Json>;
    if (
      row.session_id !== REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId
      || row.type !== 'external_write'
      || typeof row.data_json !== 'string'
    ) return false;
    try {
      const data = JSON.parse(row.data_json) as Record<string, unknown>;
      return data.callId === REQUIRED_FIXTURE_IDENTITIES.ambiguousWriteCallId
        && data.canonicalCallId === REQUIRED_FIXTURE_IDENTITIES.ambiguousWriteCallId
        && Array.isArray(data.targets)
        && data.targets.length === 1
        && data.targets[0] === REQUIRED_FIXTURE_IDENTITIES.ambiguousWriteTarget;
    } catch {
      return false;
    }
  });
  const ambiguousDispatchLeasePreserved = (firstHarness?.identities.dispatchLeases ?? []).some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const row = entry as Record<string, Json>;
    return row.scope_id === REQUIRED_FIXTURE_IDENTITIES.ambiguousWriteLeaseScopeId
      && row.session_id === REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId
      && row.run_attempt_id === REQUIRED_FIXTURE_IDENTITIES.activeAttemptId
      && typeof row.lease_id === 'string'
      && row.revoked_at === null;
  });
  const pendingTriggerCrashCut = (first.carriers.triggerEvents ?? []).some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const row = entry as Record<string, Json>;
    return row.state === 'pending'
      && row.run_id === null
      && row.attempt_count === 0;
  });
  const pendingTrigger = (first.carriers.triggerEvents ?? []).find((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return (entry as Record<string, Json>).state === 'pending';
  }) as Record<string, Json> | undefined;
  const runForReceipt = (receiptId: Json): Record<string, Json> | undefined => (
    first.carriers.workflowRuns.find((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      return (entry as Record<string, Json>).triggerReceiptId === receiptId;
    }) as Record<string, Json> | undefined
  );
  const acceptanceForReceipt = (receiptId: Json): Record<string, Json> | undefined => (
    first.carriers.triggerReceiptAcceptances.find((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      return (entry as Record<string, Json>).receiptId === receiptId;
    }) as Record<string, Json> | undefined
  );
  const scheduledRun = runForReceipt(REQUIRED_FIXTURE_IDENTITIES.scheduleReceiptId);
  const scheduledAcceptance = acceptanceForReceipt(REQUIRED_FIXTURE_IDENTITIES.scheduleReceiptId);
  const eventRun = runForReceipt(pendingTrigger?.id ?? null);
  const eventAcceptance = acceptanceForReceipt(pendingTrigger?.id ?? null);
  add('fixture_preserves_active_attempt_schedule_occurrence_and_exact_trigger_queue_crash_cut',
    (first.carriers.eventTypes.tool_called ?? 0) === 0
      && (first.carriers.eventTypes.async_work_dispatched ?? 0) === 0
      && (first.carriers.eventTypes.external_write ?? 0) === 1
      && activeAttemptPreserved
      && ambiguousWritePreserved
      && ambiguousDispatchLeasePreserved
      && pendingTriggerCrashCut
      && first.carriers.triggerEvents.length === 1
      && first.carriers.workflowRuns.length === 2
      && scheduledRun?.status === 'queued'
      && scheduledAcceptance?.runId === scheduledRun.id
      && eventRun?.status === 'queued'
      && eventAcceptance?.runId === eventRun.id
      && eventRun.id !== scheduledRun.id
      && first.carriers.notificationQueue.length === 0, {
        runAttempts: firstHarness?.identities.runAttempts ?? [],
        dispatchLeases: firstHarness?.identities.dispatchLeases ?? [],
        carriers: first.carriers,
      });
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
  await createV314AmbiguousWriteDispatchCarrier({
    checkout: exactTagCheckout,
    home: legacyHome,
    rehearsalRoot,
  });
  await createV314TriggerQueueCrashCarrier({
    checkout: exactTagCheckout,
    home: legacyHome,
    rehearsalRoot,
  });
  run(tsxBin, [scriptFile, '--internal-disable-v314-workflow-after-crash', exactTagCheckout, legacyHome], {
    cwd: exactTagCheckout,
    env: isolatedChildEnv(legacyHome),
  });
  const before = inspectV314RehearsalHome(legacyHome);

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
  const firstBoot = inspectV314RehearsalHome(migratedHome);

  const secondResult = run(tsxBin, [scriptFile, '--internal-migrate-current', migratedHome], {
    env: isolatedChildEnv(migratedHome),
  });
  const secondSchemas = parseInternalJson(secondResult.stdout, 'second current store boot');
  if (stable(currentSchemas) !== stable(secondSchemas)) {
    throw new Error(`current schema constants changed between boots: ${stable(currentSchemas)} != ${stable(secondSchemas)}`);
  }
  const secondBoot = inspectV314RehearsalHome(migratedHome);
  const checks = buildChecks(before, firstBoot, secondBoot, currentSchemas);
  const report: V314UpgradeRehearsalReport = {
    ok: checks.every((check) => check.ok),
    release: V314_RELEASE,
    currentSchemas,
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
  if (args[0] === '--internal-seed-v314-trigger-queue-crash') {
    const checkout = args[1];
    const home = args[2];
    if (!checkout || !home) throw new Error('internal trigger crash seed requires checkout and home');
    await seedV314TriggerQueueCrash(checkout, home);
    return;
  }
  if (args[0] === '--internal-seed-v314-ambiguous-write-dispatch') {
    const checkout = args[1];
    const home = args[2];
    if (!checkout || !home) throw new Error('internal ambiguous-write seed requires checkout and home');
    await seedV314AmbiguousWriteDispatch(checkout, home);
    return;
  }
  if (args[0] === '--internal-disable-v314-workflow-after-crash') {
    const checkout = args[1];
    const home = args[2];
    if (!checkout || !home) throw new Error('internal v3.14 workflow disable requires checkout and home');
    await disableV314WorkflowAfterQueueCrash(checkout, home);
    console.log(JSON.stringify({ disabled: true }));
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
