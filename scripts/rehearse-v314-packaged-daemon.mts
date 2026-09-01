#!/usr/bin/env node

/**
 * Release gate: boot the actual npm-packed daemon twice on one exact-v3.14
 * disposable home.  The store-only rehearsal owns legacy fixture provenance;
 * this layer proves the packaged entry performs recovery once and reopens
 * without replaying model, provider, business, or reviewed-local work.
 */
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  inspectV314RehearsalHome,
  REQUIRED_FIXTURE_IDENTITIES,
  runV314UpgradeRehearsal,
  V314_GATE_MACHINE_ID,
  type HomeInspection,
} from './rehearse-v314-upgrade.mts';
import { fingerprintRuntimeSourceFromGit } from '../src/runtime/source-fingerprint.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface PackagedV314DaemonRehearsalOptions {
  rehearsalRoot?: string;
  keep?: boolean;
}

export interface PackagedDaemonBuild {
  version: string;
  entry: string;
  packaged: boolean;
  gitSha?: string;
  gitDirty?: boolean;
  sourceFingerprint?: string;
  expectedSchemaVersion: number;
  schemaVersion: number;
}

export interface PackagedDaemonBoot {
  ordinal: 1 | 2;
  pid: number;
  ready: boolean;
  recoverySettled: boolean;
  settledPhaseSequence: number;
  notificationDeliverySettled: boolean;
  notificationDeliveryQueueLength: number;
  cleanExit: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  liveLease: PackagedDaemonLeaseObservation;
  postExitLeaseClean: boolean;
  build: PackagedDaemonBuild;
  stdoutSha256: string;
  stderrSha256: string;
}

export interface PackagedDaemonLeaseObservation {
  valid: boolean;
  expectedPid: number;
  projectedPid: number | null;
  leaseEntryCount: number;
  ownerCount: number;
  ownerPid: number | null;
  ownerToken: string | null;
  ownerStartedAt: string | null;
}

export interface WorkDelta {
  total: number;
  components: Record<string, number>;
}

export interface PackagedV314ExerciseReport {
  version: 1;
  installedRoot: string;
  oldSessionId: string;
  oldWorkflowName: string;
  oldSpaceId: string;
  coldSessionId: string;
  coldSourceUserSeq: number;
  coldTerminalSeq: number;
  workflowRunId: string;
  workflowRunStatus: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  reviewProjectionId: string;
  reviewApprovalId: string;
  advancementId: string;
  advancementStage: 'blocked';
  advancementStateRevision: number;
  advancementStateDigest: string;
  advancementBlockedCode: 'capability_acquisition_missing';
  advancementBlockedDetail: string;
  firstConvergence: {
    failures: number;
    [key: string]: Json;
  };
  secondConvergence: {
    failures: number;
    [key: string]: Json;
  };
  notificationDeliveryDigest: string;
  notificationDeliveryQueueLength: number;
  modelRequests: Array<{ model: string | null; stream: boolean; bodySha256: string }>;
}

export interface PackagedV314DaemonRehearsalReport {
  ok: boolean;
  paths: {
    rehearsalRoot: string;
    immutableSnapshot: string;
    daemonHome: string;
    tarball: string;
    packageEntry: string;
    exerciseFixture: string;
    hermeticRuntimePath: string;
    report: string;
  };
  candidate: {
    gitSha: string;
    sourceFingerprint: string;
    tarballSha256: string;
  };
  boots: PackagedDaemonBoot[];
  exercise: PackagedV314ExerciseReport;
  firstBootWorkDelta: WorkDelta;
  exerciseWorkDelta: WorkDelta;
  secondBootWorkDelta: WorkDelta;
  firstBootStateDigest: string;
  postExerciseStateDigest: string;
  secondBootStateDigest: string;
  postExerciseRawStateDigest: string;
  secondBootRawStateDigest: string;
  secondBootRawStateDiff: StateDifference;
  secondBootLogicalStateDiff: StateDifference;
  checks: Array<{ name: string; ok: boolean; detail?: Json }>;
  limitations: string[];
}

const PACKAGED_CAPABILITY_ACQUISITION_MISSING_DETAILS = new Set([
  'no live-read carrier adapters are configured',
  'no current attested read capability matched the objective',
]);

export const AUTOMATION_OPPORTUNITY_PROPOSAL_DB =
  'state/automation-opportunities/automation-opportunities.db';
export const HARNESS_DB = 'state/harness.db';

const V314_GATE_PROACTIVITY_POLICY = Object.freeze({
  enabled: false,
  updatedAt: '1970-01-01T00:00:00.000Z',
});
const DAILY_MAINTENANCE_CURSOR_KEYS = Object.freeze([
  'lastNightlyFireDay',
  'lastSkillUpdateFireDay',
  'lastBackupDay',
  'lastMemorySelfHealDay',
  'lastRelationshipBackfillDay',
  'lastMergeDay',
  'lastGoalReapDay',
  'lastTaskLedgerHygieneDay',
  'lastNotificationReapDay',
  'lastStorageHygieneDay',
  'lastCuratorReportDay',
] as const);
const CHECK_IN_SEED_IDS = Object.freeze([
  'seed-monday-kickoff',
  'seed-friday-wrap',
  'seed-blocked-execution',
  'seed-goal-drift',
  'seed-inbox-backlog',
] as const);

const CHECK_IN_SEED_TRIGGERS = Object.freeze({
  'seed-monday-kickoff': ['schedule', 'schedule', '0 9 * * 1'],
  'seed-friday-wrap': ['schedule', 'schedule', '0 16 * * 5'],
  'seed-blocked-execution': ['execution_blocked', 'blockedHours', 24],
  'seed-goal-drift': ['goal_stale', 'staleDays', 7],
  'seed-inbox-backlog': ['inbox_backed_up', 'inboxThreshold', 10],
} as const);

export function isPackagedCapabilityAcquisitionMissingDetail(value: unknown): value is string {
  return typeof value === 'string'
    && PACKAGED_CAPABILITY_ACQUISITION_MISSING_DETAILS.has(value);
}

interface WorkSnapshot {
  counters: Record<string, number>;
}

interface StateDifference {
  sqliteSchemasChanged: string[];
  sqliteTablesAdded: string[];
  sqliteTablesRemoved: string[];
  sqliteTablesChanged: string[];
  filesAdded: string[];
  filesRemoved: string[];
  filesChanged: string[];
}

const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), '..');
const tempRoot = realpathSync(os.tmpdir());
const CREDENTIAL_KEY = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION|COMPOSIO|OPENAI|ANTHROPIC|XAI|SLACK|DISCORD|WEBHOOK|API_KEY)/i;
const WORK_EVENT_TYPES = new Set([
  'tool_called',
  'tool_returned',
  'external_write',
  'external_write_succeeded',
  'external_write_failed',
  'external_write_orphaned',
  'provider_dispatch_started',
  'provider_dispatch_settled',
  'deliverable_saved',
  'sdk_tool_use_recorded',
  'worker_model_routed',
  'worker_result',
  'model_started',
]);
export const WORK_TABLES = [
  'accepted_model_batch_admissions',
  'artifact_content_verifications',
  'artifact_run_scopes',
  'artifact_source_roots',
  'durable_result_handles',
  'evidence_receipts',
  'expected_work_call_bindings',
  'graph_journal_entries',
  'graph_node_leases',
  'host_call_capability_bindings',
  'logical_call_progress_claims',
  'logical_call_settlement_crossings',
  'logical_call_settlements',
  'logical_model_result_projection_receipts',
  'logical_tool_calls',
  'obligation_transitions',
  'physical_dispatch_authority',
  'physical_dispatch_return_checkpoints',
  'physical_dispatches',
  'run_attempts',
  'settlement_claims',
  'staged_transfer_stage_receipts',
  'tool_output_invocations',
  'tool_outputs',
  'workflow_node_invocation_activations',
  'workflow_paginated_read_pages',
  'workflow_v3_call_activation_bindings',
  'write_evidence_dispatch_outcomes',
  'write_evidence_proofs',
] as const;

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

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertDisposable(candidate: string, label: string): string {
  const absolute = path.resolve(candidate);
  const resolved = existsSync(absolute)
    ? realpathSync(absolute)
    : path.join(realpathSync(path.dirname(absolute)), path.basename(absolute));
  if (resolved === tempRoot || !resolved.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`${label} must resolve below the OS temp directory; refused ${resolved}`);
  }
  const liveHome = path.resolve(os.homedir(), '.clementine-next');
  if (resolved === liveHome || resolved.startsWith(`${liveHome}${path.sep}`)) {
    throw new Error(`${label} must never address the live Clementine home; refused ${resolved}`);
  }
  return resolved;
}

function pathWithoutCheckout(rawPath = ''): string {
  return rawPath.split(path.delimiter).filter((entry) => {
    if (!entry) return false;
    const relative = path.relative(repoRoot, path.resolve(entry));
    return relative !== '' && (relative.startsWith('..') || path.isAbsolute(relative));
  }).join(path.delimiter);
}

/** Pure environment boundary shared by npm staging and packaged daemon boots. */
export function sanitizePackagedGateEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || CREDENTIAL_KEY.test(key)) continue;
    const lower = key.toLowerCase();
    if (
      key === 'NODE_OPTIONS'
      || key === 'NODE_PATH'
      || key === 'NODE_TEST_CONTEXT'
      || key === 'INIT_CWD'
      || key === 'PWD'
      || key === 'OLDPWD'
      || key.startsWith('CLEMENTINE_')
      || key.startsWith('CLEM_')
      || key.startsWith('CLEMMY_')
      || key.startsWith('MCP_')
      || lower.startsWith('npm_package_')
      || lower.startsWith('npm_lifecycle_')
      || lower === 'npm_execpath'
      || lower === 'npm_node_execpath'
      || lower === 'npm_config_local_prefix'
      || lower === 'npm_config_prefix'
    ) continue;
    env[key] = value;
  }
  env.PATH = pathWithoutCheckout(source.PATH);
  return env;
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(realpathSync(parent), realpathSync(candidate));
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const cwd = path.resolve(options.cwd ?? repoRoot);
  const env: NodeJS.ProcessEnv = { ...(options.env ?? sanitizePackagedGateEnvironment(process.env)), PWD: cwd };
  delete env.OLDPWD;
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stderr || result.stdout}`.trim());
  }
  return result.stdout ?? '';
}

function currentCandidateIdentity(): { gitSha: string; sourceFingerprint: string } {
  const gitSha = execFileSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const dirty = execFileSync('git', [
    '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=all',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  }).trim();
  if (dirty) {
    throw new Error('packaged upgrade gate requires one clean reviewed candidate commit; the worktree is dirty');
  }
  const sourceFingerprint = fingerprintRuntimeSourceFromGit({ repoRoot, gitHead: gitSha });
  const stampPath = path.join(repoRoot, 'dist/runtime/build-stamp.json');
  if (!existsSync(stampPath)) throw new Error('candidate dist/runtime/build-stamp.json is missing; run npm run build');
  const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as {
    gitSha?: unknown;
    sourceFingerprint?: unknown;
    gitDirty?: unknown;
    expectedSchemaVersion?: unknown;
    implementationManifestDigest?: unknown;
  };
  if (stamp.gitSha !== gitSha || stamp.sourceFingerprint !== sourceFingerprint || stamp.gitDirty !== false) {
    throw new Error(
      `candidate build is stale: stamp=${String(stamp.sourceFingerprint)} current=${sourceFingerprint}; run npm run build`,
    );
  }
  if (!Number.isInteger(stamp.expectedSchemaVersion) || !/^[a-f0-9]{64}$/.test(String(stamp.implementationManifestDigest ?? ''))) {
    throw new Error('candidate build stamp lacks exact schema or shipped-implementation identity');
  }
  return { gitSha, sourceFingerprint };
}

function packAndInstall(rehearsalRoot: string): { tarball: string; packageEntry: string } {
  const packRoot = path.join(rehearsalRoot, 'candidate-pack');
  const installRoot = path.join(rehearsalRoot, 'release-v314-packaged-daemon');
  const npmCache = path.join(rehearsalRoot, 'npm-cache');
  const npmHome = path.join(rehearsalRoot, 'npm-home');
  mkdirSync(packRoot, { recursive: true });
  mkdirSync(installRoot, { recursive: true });
  mkdirSync(npmCache, { recursive: true });
  mkdirSync(npmHome, { recursive: true });
  const npmEnv = {
    ...sanitizePackagedGateEnvironment(process.env),
    HOME: npmHome,
    USERPROFILE: npmHome,
    npm_config_cache: npmCache,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
  };
  const packedJson = run('npm', [
    'pack',
    '--ignore-scripts',
    '--json',
    '--pack-destination',
    packRoot,
  ], { env: npmEnv });
  const packed = JSON.parse(packedJson) as Array<{ filename?: unknown }>;
  const filename = packed[0]?.filename;
  if (typeof filename !== 'string' || !filename.endsWith('.tgz')) {
    throw new Error(`npm pack did not return one tarball: ${packedJson}`);
  }
  const tarball = path.join(packRoot, filename);
  writeFileSync(path.join(installRoot, 'package.json'), `${JSON.stringify({
    name: 'clementine-v314-packaged-daemon-gate',
    private: true,
    version: '0.0.0',
  })}\n`, { flag: 'wx' });
  run('npm', [
    'install',
    '--omit=optional',
    '--no-audit',
    '--no-fund',
    '--no-package-lock',
    tarball,
  ], { cwd: installRoot, env: npmEnv });
  const installedPackage = path.join(installRoot, 'node_modules', 'clemmy');
  const packageEntry = path.join(installedPackage, 'dist', 'index.js');
  if (!existsSync(packageEntry) || lstatSync(installedPackage).isSymbolicLink()) {
    throw new Error('npm did not install a real packed Clementine directory');
  }
  if (existsSync(path.join(installedPackage, 'src'))) {
    throw new Error('packed Clementine unexpectedly contains the source tree');
  }
  const installedRequire = createRequire(path.join(installRoot, 'package.json'));
  const sqliteEntry = installedRequire.resolve('better-sqlite3');
  if (!isWithin(sqliteEntry, installRoot) || isWithin(sqliteEntry, path.join(repoRoot, 'node_modules'))) {
    throw new Error(`packed daemon resolved better-sqlite3 outside its fresh install: ${sqliteEntry}`);
  }
  run(process.execPath, ['-e', [
    "const { createRequire } = require('node:module');",
    'const req = createRequire(process.argv[1]);',
    "const Database = req('better-sqlite3');",
    "const db = new Database(':memory:');",
    "if (db.prepare('SELECT 1 AS ok').get().ok !== 1) process.exit(7);",
    'db.close();',
  ].join(' '), path.join(installRoot, 'package.json')], { cwd: installRoot, env: npmEnv });
  return { tarball, packageEntry };
}

/** Runtime-only boundary for the installed daemon and exercise. npm staging
 * still needs the caller's toolchain PATH, but product execution gets an exact
 * empty directory owned by this disposable gate. This prevents a host `sf`,
 * `gcloud`, or other reviewed CLI from silently becoming test capability. */
export function packagedRuntimeEnvironment(
  source: NodeJS.ProcessEnv,
  home: string,
  hermeticRuntimePath: string,
): NodeJS.ProcessEnv {
  const env = sanitizePackagedGateEnvironment(source);
  // Windows treats environment keys case-insensitively. Remove every inherited
  // spelling before publishing the one authoritative PATH below, otherwise a
  // host `Path` entry can win Node's child-environment de-duplication.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') delete env[key];
  }
  return {
    ...env,
    PATH: path.resolve(hermeticRuntimePath),
    HOME: home,
    USERPROFILE: home,
    TMPDIR: os.tmpdir(),
    TZ: 'UTC',
    CLEMENTINE_HOME: home,
    CLEMMY_TEST_ISOLATED_HOME: '1',
    CLEMMY_TEST_DISABLE_LIVE_MODELS: '1',
    CLEMMY_LOCAL_EMBEDDINGS: 'off',
    CLEMMY_REFLECTION: 'off',
    CLEMMY_MEMORY_DECAY: 'off',
    CLEMMY_MEMORY_DEDUP: 'off',
    CLEMMY_AUTHORITY_SEAL_KEY: 'ab'.repeat(32),
    CLEMMY_HARNESS_CRON: 'off',
    // The normal independent lane is deliberately concurrent. The gate uses
    // its production inline fallback so daemon.loop.sleep is an authority
    // barrier after workflow recovery and automation convergence, not merely
    // after the foreground scheduler tick.
    CLEMMY_WORKFLOW_RUN_LANE: 'off',
    CLEMMY_MCP_PREWARM: 'off',
    CLEMMY_BOOT_WARMUP: 'off',
    CLEMMY_CLI_DISCOVERY_WARMUP: 'off',
    CLEMMY_PROSPECTIVE_MEMORY: 'off',
    CLEMMY_BGTASK_INTEGRITY_SWEEP: 'off',
    CLEMMY_MEMORY_BACKUP: 'off',
    CLEMMY_ENTITY_RELATIONSHIP_BACKFILL: 'off',
    CLEMMY_TASK_LEDGER_HYGIENE: 'off',
    CLEMMY_STORAGE_HYGIENE: 'off',
    MCP_AUTO_IMPORT_ENABLED: 'false',
    OPENAI_AGENTS_DISABLE_TRACING: '1',
    AUTH_MODE: 'api_key',
    WEBHOOK_ENABLED: 'false',
    DISCORD_ENABLED: 'false',
    SLACK_ENABLED: 'false',
    WEBHOOK_ALLOW_LAN: 'false',
    CLEMENTINE_MOBILE_APP_LISTENER: 'off',
  };
}

function daemonEnv(home: string, hermeticRuntimePath: string): NodeJS.ProcessEnv {
  return packagedRuntimeEnvironment(process.env, home, hermeticRuntimePath);
}

interface PackagedGateSeeds {
  utcDay: string;
  digests: Record<string, string>;
}

export interface V314FixtureMachineIdCandidate {
  present: boolean;
  regularFile: boolean;
  symbolicLink: boolean;
  byteLength: number;
  bytes?: string;
}

/** Pure fail-closed boundary used before the packaged rehearsal trusts an identity. */
export function isExactV314FixtureMachineIdCandidate(
  candidate: V314FixtureMachineIdCandidate,
): boolean {
  const expected = `${V314_GATE_MACHINE_ID}\n`;
  return candidate.present
    && candidate.regularFile
    && !candidate.symbolicLink
    && candidate.byteLength === Buffer.byteLength(expected, 'utf8')
    && candidate.bytes === expected;
}

function readExactV314FixtureMachineId(home: string): string {
  const machineIdPath = path.join(home, 'state', 'machine-id');
  const expected = `${V314_GATE_MACHINE_ID}\n`;
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(machineIdPath);
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : 'unknown';
    throw new Error(`packaged v3.14 fixture machine-id is missing or unreadable (${code})`);
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size !== Buffer.byteLength(expected, 'utf8')
  ) {
    throw new Error('packaged v3.14 fixture machine-id must be the exact bounded regular fixture file');
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(machineIdPath, 'r');
    const opened = fstatSync(descriptor);
    const bytes = readFileSync(descriptor, 'utf8');
    const unchanged = opened.dev === stat.dev && opened.ino === stat.ino;
    if (!unchanged || !isExactV314FixtureMachineIdCandidate({
      present: true,
      regularFile: opened.isFile(),
      symbolicLink: false,
      byteLength: opened.size,
      bytes,
    })) {
      throw new Error('packaged v3.14 fixture machine-id does not match the deterministic fixture identity');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function seedPackagedGateState(home: string): PackagedGateSeeds {
  const utcDay = new Date().toISOString().slice(0, 10);
  const machineIdBytes = readExactV314FixtureMachineId(home);
  const maintenanceState = Object.fromEntries(
    DAILY_MAINTENANCE_CURSOR_KEYS.map((key) => [key, utcDay]),
  );
  const seeds: Record<string, string> = {
    'state/proactivity-policy.json': `${JSON.stringify(V314_GATE_PROACTIVITY_POLICY, null, 2)}\n`,
    'state/memory-maintenance-state.json': `${JSON.stringify(maintenanceState, null, 2)}\n`,
  };
  for (const [relativePath, bytes] of Object.entries(seeds)) {
    writeFileSync(path.join(home, relativePath), bytes, { encoding: 'utf8', flag: 'wx' });
  }
  return {
    utcDay,
    digests: {
      'state/machine-id': sha256(machineIdBytes),
      ...Object.fromEntries(Object.entries(seeds).map(([name, bytes]) => [name, sha256(bytes)])),
    },
  };
}

function packagedGateSeedsPreserved(
  seeds: PackagedGateSeeds,
  ...inspections: HomeInspection[]
): boolean {
  return inspections.every((inspection) => Object.entries(seeds.digests).every(
    ([relativePath, digest]) => inspection.allNonSqliteFiles[relativePath] === digest,
  ));
}

export function isExactDaemonLeaseOwnerRecord(
  value: unknown,
  expectedPid?: number,
  expectedToken?: string,
): value is { version: 1; pid: number; token: string; startedAt: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return stable(Object.keys(record).sort()) === stable(['pid', 'startedAt', 'token', 'version'])
    && record.version === 1
    && typeof record.pid === 'number'
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && (expectedPid === undefined || record.pid === expectedPid)
    && typeof record.token === 'string'
    && record.token.length > 0
    && (expectedToken === undefined || record.token === expectedToken)
    && typeof record.startedAt === 'string'
    && Number.isFinite(Date.parse(record.startedAt));
}

function observeDaemonLease(home: string, expectedPid: number): PackagedDaemonLeaseObservation {
  const pidFile = path.join(home, 'daemon.pid');
  const leaseDir = path.join(home, 'daemon.lock');
  const projectedPid = (() => {
    if (!existsSync(pidFile)) return null;
    const raw = readFileSync(pidFile, 'utf8').trim();
    if (!/^[1-9]\d*$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  })();
  const leaseEntries = existsSync(leaseDir) ? readdirSync(leaseDir).sort() : [];
  const owners = leaseEntries.filter((name) => /^owner-[A-Za-z0-9-]+\.json$/.test(name));
  const owner = (() => {
    if (owners.length !== 1) return null;
    try {
      const token = /^owner-([A-Za-z0-9-]+)\.json$/.exec(owners[0]!)?.[1];
      const parsed = JSON.parse(readFileSync(path.join(leaseDir, owners[0]!), 'utf8')) as Record<string, unknown>;
      return token && isExactDaemonLeaseOwnerRecord(parsed, expectedPid, token)
        ? { record: parsed, token }
        : null;
    } catch {
      return null;
    }
  })();
  const ownerPid = typeof owner?.record.pid === 'number' ? owner.record.pid : null;
  const ownerToken = owner?.token ?? null;
  const ownerStartedAt = typeof owner?.record.startedAt === 'string' ? owner.record.startedAt : null;
  return {
    valid: projectedPid === expectedPid
      && leaseEntries.length === 1
      && owners.length === 1
      && ownerPid === expectedPid
      && ownerToken !== null
      && ownerStartedAt !== null,
    expectedPid,
    projectedPid,
    leaseEntryCount: leaseEntries.length,
    ownerCount: owners.length,
    ownerPid,
    ownerToken,
    ownerStartedAt,
  };
}

function daemonLeaseIsAbsent(home: string): boolean {
  return !existsSync(path.join(home, 'daemon.pid'))
    && !existsSync(path.join(home, 'daemon.lock'))
    && readdirSync(home).every((name) =>
      !/^\.daemon-owner-[A-Za-z0-9-]+\.tmp$/.test(name)
      && !/^daemon\.pid\.[1-9]\d*\.[A-Za-z0-9-]+\.tmp$/.test(name));
}

function pidIsProvablyAbsent(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
}

function retainedDaemonLeaseExactlyMatches(input: {
  home: string;
  expectedPid: number;
  expectedToken: string;
  expectedStartedAt: string;
}): boolean {
  const { home, expectedPid, expectedToken, expectedStartedAt } = input;
  if (!/^[a-f0-9-]+$/.test(expectedToken)) return false;
  const pidFile = path.join(home, 'daemon.pid');
  const leaseDir = path.join(home, 'daemon.lock');
  const ownerFile = path.join(leaseDir, `owner-${expectedToken}.json`);
  try {
    const pidStat = lstatSync(pidFile);
    const leaseStat = lstatSync(leaseDir);
    const ownerStat = lstatSync(ownerFile);
    const observed = observeDaemonLease(home, expectedPid);
    const transientOwner = readdirSync(home).some((name) =>
      /^\.daemon-owner-[A-Za-z0-9-]+\.tmp$/.test(name)
      || /^daemon\.pid\.[1-9]\d*\.[A-Za-z0-9-]+\.tmp$/.test(name));
    return pidStat.isFile() && !pidStat.isSymbolicLink()
      && leaseStat.isDirectory() && !leaseStat.isSymbolicLink()
      && ownerStat.isFile() && !ownerStat.isSymbolicLink()
      && readFileSync(pidFile, 'utf8') === `${expectedPid}\n`
      && observed.valid
      && observed.ownerToken === expectedToken
      && observed.ownerStartedAt === expectedStartedAt
      && !transientOwner;
  } catch {
    return false;
  }
}

/**
 * Establish a rehearsal-only authority to run the installed package's normal
 * stale-owner cleanup. Preparation is read-only and succeeds only while the
 * retained PID projection, owner token, and owner generation exactly match the
 * already-dead child. The returned operation revalidates that identity before
 * every invocation and is deliberately idempotent.
 */
export function prepareExitedPackagedDaemonLeaseCleanup(input: {
  home: string;
  expectedPid: number;
  expectedToken: string;
  expectedStartedAt: string;
  runInstalledDaemonStop: () => void;
}): () => { cleaned: boolean; alreadyClean: boolean } {
  const home = assertDisposable(input.home, 'packaged daemon cleanup home');
  const identity = {
    home,
    expectedPid: input.expectedPid,
    expectedToken: input.expectedToken,
    expectedStartedAt: input.expectedStartedAt,
  };
  if (!pidIsProvablyAbsent(identity.expectedPid)) {
    throw new Error(`refused packaged daemon lease cleanup while PID ${identity.expectedPid} is live or unreadable`);
  }
  if (!retainedDaemonLeaseExactlyMatches(identity)) {
    throw new Error('retained packaged daemon lease is not the exact exited owner');
  }

  return () => {
    if (!pidIsProvablyAbsent(identity.expectedPid)) {
      throw new Error(`refused packaged daemon lease cleanup while PID ${identity.expectedPid} is live or unreadable`);
    }
    const alreadyClean = daemonLeaseIsAbsent(home);
    if (!alreadyClean && !retainedDaemonLeaseExactlyMatches(identity)) {
      throw new Error('retained packaged daemon lease is not the exact exited owner');
    }
    input.runInstalledDaemonStop();
    if (!daemonLeaseIsAbsent(home)) {
      throw new Error('installed packaged daemon stop did not remove the exact stale PID/owner lease');
    }
    return {
      cleaned: !alreadyClean,
      alreadyClean,
    };
  };
}

function parseBuild(stdout: string): PackagedDaemonBuild | null {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as { build?: unknown };
      if (value.build && typeof value.build === 'object') return value.build as PackagedDaemonBuild;
    } catch {
      // Human shutdown lines and partial log chunks are intentionally ignored.
    }
  }
  return null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode) return { code: child.exitCode, signal: child.signalCode };
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`daemon ${child.pid ?? 'unknown'} did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
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
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

export function notificationDeliverySettlement(home: string): {
  settled: boolean;
  queueLength: number;
  recoveryNotificationIds: string[];
  desktopReceiptIds: string[];
  missingDesktopReceiptIds: string[];
  legacyFixturePreserved: boolean;
  setupPromptPresent: boolean;
} {
  const readArray = (relativePath: string): Array<Record<string, unknown>> => {
    const file = path.join(home, relativePath);
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((entry): entry is Record<string, unknown> =>
            entry !== null && typeof entry === 'object' && !Array.isArray(entry))
        : [];
    } catch {
      return [];
    }
  };
  const notifications = readArray('state/notifications.json');
  const notificationById = new Map(notifications.flatMap((entry) =>
    typeof entry.id === 'string' ? [[entry.id, entry] as const] : []));
  const queue = readArray('state/notification-delivery-queue.json');
  const metadata = (notification: Record<string, unknown>): Record<string, unknown> => {
    const value = notification.metadata;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  };
  const recoveryNotifications = notifications.filter((notification) => {
    const details = metadata(notification);
    const interruptedChat = notification.kind === 'system'
      && notification.title === 'A chat task was interrupted by a restart'
      && details.sessionId === REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId
      && details.reason === 'interrupted_by_restart';
    const disabledWorkflow = notification.kind === 'workflow'
      && notification.title === `Workflow not run: ${REQUIRED_FIXTURE_IDENTITIES.workflowName}`
      && details.workflow === REQUIRED_FIXTURE_IDENTITIES.workflowName;
    const cancelledApproval = notification.kind === 'system'
      && notification.title === 'Approval closed with its ended session'
      && details.sessionId === REQUIRED_FIXTURE_IDENTITIES.approvalOwnerSessionId
      && details.approvalResolution === 'cancelled_by_system';
    return interruptedChat || disabledWorkflow || cancelledApproval;
  });
  const hasTimestamp = (value: unknown): boolean =>
    typeof value === 'string' && Number.isFinite(Date.parse(value));
  const hasDesktopReceipt = (notification: Record<string, unknown>): boolean => {
    const plan = notification.deliveryPlan;
    const destinationIds = plan !== null && typeof plan === 'object' && !Array.isArray(plan)
      ? (plan as Record<string, unknown>).destinationIds
      : undefined;
    return Array.isArray(destinationIds)
      && destinationIds.length === 1
      && destinationIds[0] === 'derived-desktop'
      && Array.isArray(notification.deliveredDestinations)
      && notification.deliveredDestinations.length === 1
      && notification.deliveredDestinations[0] === 'derived-desktop'
      && hasTimestamp(notification.deliveredAt)
      && hasTimestamp(notification.deliveryPlanCompletedAt)
      && typeof notification.deliveryError !== 'string';
  };
  const recoveryNotificationIds = recoveryNotifications.flatMap((notification) =>
    typeof notification.id === 'string' ? [notification.id] : []).sort();
  const desktopReceiptIds = recoveryNotifications.flatMap((notification) =>
    typeof notification.id === 'string' && hasDesktopReceipt(notification) ? [notification.id] : []).sort();
  const missingDesktopReceiptIds = recoveryNotificationIds
    .filter((id) => !desktopReceiptIds.includes(id));
  const legacyFixture = notificationById.get(REQUIRED_FIXTURE_IDENTITIES.notificationId);
  const legacyFixturePreserved = legacyFixture?.silent === true
    && legacyFixture.deliveryPlan === undefined
    && legacyFixture.deliveredAt === undefined
    && legacyFixture.deliveredDestinations === undefined;
  const setupPromptPresent = notifications.some((notification) => {
    const details = notification.metadata;
    return notification.silent === true
      && details !== null
      && typeof details === 'object'
      && !Array.isArray(details)
      && (details as Record<string, unknown>).errorCategory === 'no_destinations';
  });
  return {
    // Since U5 the local desktop is a guaranteed delivery surface. A healthy
    // headless packaged boot therefore drains its queue after durably recording
    // one desktop receipt for each recovery notification. Merely observing an
    // empty queue is insufficient: the exact receipts below are the proof that
    // recovery notifications were delivered rather than lost.
    settled: queue.length === 0
      && recoveryNotifications.length === 4
      && desktopReceiptIds.length === recoveryNotifications.length
      && legacyFixturePreserved
      && !setupPromptPresent,
    queueLength: queue.length,
    recoveryNotificationIds,
    desktopReceiptIds,
    missingDesktopReceiptIds,
    legacyFixturePreserved,
    setupPromptPresent,
  };
}

async function bootPackagedDaemon(
  ordinal: 1 | 2,
  packageEntry: string,
  home: string,
  hermeticRuntimePath: string,
): Promise<PackagedDaemonBoot> {
  const child = spawn(process.execPath, [packageEntry, 'daemon', '--foreground'], {
    cwd: path.dirname(path.dirname(packageEntry)),
    env: daemonEnv(home, hermeticRuntimePath),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  let recoverySettled = false;
  let settledPhaseSequence = 0;
  child.stdout?.on('data', (chunk: Buffer | string) => {
    stdout = `${stdout}${String(chunk)}`.slice(-2_000_000);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${String(chunk)}`.slice(-2_000_000);
  });
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const heartbeat = message as {
      type?: unknown;
      phase?: { name?: unknown; sequence?: unknown };
    };
    if (
      heartbeat.type === 'clementine.daemon.heartbeat'
      && heartbeat.phase?.name === 'daemon.loop.sleep'
      && Number.isSafeInteger(heartbeat.phase.sequence)
    ) {
      recoverySettled = true;
      settledPhaseSequence = heartbeat.phase.sequence as number;
    }
  });
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (stdout.includes('Daemon loop started')) ready = true;
    if (ready && recoverySettled) break;
    if (child.exitCode !== null || child.signalCode) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (!ready || !recoverySettled) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    const exited = await waitForExit(child, 5_000).catch(() => ({ code: child.exitCode, signal: child.signalCode }));
    throw new Error(
      `packaged daemon boot ${ordinal} failed ${ready ? 'first-tick recovery completion' : 'readiness'} `
      + `(${exited.code}/${exited.signal})\n${stderr || stdout}`,
    );
  }
  const deliveryDeadline = Date.now() + 30_000;
  let deliverySettlement = notificationDeliverySettlement(home);
  while (!deliverySettlement.settled && Date.now() < deliveryDeadline) {
    if (child.exitCode !== null || child.signalCode) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
    deliverySettlement = notificationDeliverySettlement(home);
  }
  if (!deliverySettlement.settled) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    const exited = await waitForExit(child, 5_000).catch(() => ({ code: child.exitCode, signal: child.signalCode }));
    throw new Error(
      `packaged daemon boot ${ordinal} did not settle its durable notification-delivery queue `
      + `(${exited.code}/${exited.signal}): ${stable(deliverySettlement)}`,
    );
  }
  // daemon.loop.sleep is emitted only after the entire first tick (scheduler,
  // trigger recovery, workflow drain, automation convergence, maintenance,
  // and heartbeat persistence) has completed. It is the deterministic boot
  // recovery barrier; stdout quietness is not authority.
  const pid = child.pid ?? 0;
  const liveLease = observeDaemonLease(home, pid);
  if (!liveLease.valid) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await waitForExit(child, 5_000).catch(() => undefined);
    throw new Error(`packaged daemon boot ${ordinal} did not own exactly one valid lease: ${stable(liveLease)}`);
  }
  child.kill('SIGTERM');
  let exited: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exited = await waitForExit(child, 10_000);
  } catch (error) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await waitForExit(child, 5_000).catch(() => undefined);
    throw error;
  }
  if (liveLease.ownerToken === null || liveLease.ownerStartedAt === null) {
    throw new Error(`packaged daemon boot ${ordinal} lost its observed lease identity before cleanup`);
  }
  const cleanupExitedLease = prepareExitedPackagedDaemonLeaseCleanup({
    home,
    expectedPid: pid,
    expectedToken: liveLease.ownerToken,
    expectedStartedAt: liveLease.ownerStartedAt,
    runInstalledDaemonStop: () => {
      const installedRoot = path.dirname(path.dirname(packageEntry));
      run(process.execPath, [packageEntry, 'daemon', 'stop'], {
        cwd: installedRoot,
        env: daemonEnv(home, hermeticRuntimePath),
      });
    },
  });
  cleanupExitedLease();
  const postExitLeaseClean = daemonLeaseIsAbsent(home);
  if (!postExitLeaseClean) {
    throw new Error(`packaged daemon boot ${ordinal} left PID/owner lease artifacts after clean exit`);
  }
  const build = parseBuild(stdout);
  if (!build) throw new Error(`packaged daemon boot ${ordinal} did not self-report build identity\n${stdout}`);
  return {
    ordinal,
    pid,
    ready,
    recoverySettled,
    settledPhaseSequence,
    notificationDeliverySettled: deliverySettlement.settled,
    notificationDeliveryQueueLength: deliverySettlement.queueLength,
    cleanExit: exited.code === 0 && exited.signal === null,
    exitCode: exited.code,
    signal: exited.signal,
    liveLease,
    postExitLeaseClean,
    build,
    stdoutSha256: sha256(stdout),
    stderrSha256: sha256(stderr),
  };
}

const PACKAGED_EXERCISE_MARKER = 'CLEMENTINE_V314_PACKAGED_EXERCISE=';

function runPackagedUpgradeExercise(
  exerciseFixture: string,
  packageEntry: string,
  home: string,
  hermeticRuntimePath: string,
): PackagedV314ExerciseReport {
  const installedRoot = path.dirname(path.dirname(packageEntry));
  const stdout = run(process.execPath, [exerciseFixture, installedRoot, home], {
    cwd: installedRoot,
    env: daemonEnv(home, hermeticRuntimePath),
  });
  const markerLine = stdout.split(/\r?\n/)
    .findLast((line) => line.startsWith(PACKAGED_EXERCISE_MARKER));
  if (!markerLine) throw new Error(`packaged exercise returned no exact marker\n${stdout}`);
  const parsed = JSON.parse(markerLine.slice(PACKAGED_EXERCISE_MARKER.length)) as PackagedV314ExerciseReport;
  if (
    parsed.version !== 1
    || parsed.installedRoot !== installedRoot
    || !parsed.coldSessionId
    || !Number.isSafeInteger(parsed.coldSourceUserSeq)
    || !Number.isSafeInteger(parsed.coldTerminalSeq)
    || parsed.workflowRunStatus !== 'completed'
    || parsed.proposalRevision !== 3
    || !/^[a-f0-9]{64}$/.test(parsed.proposalDigest)
    || !parsed.reviewProjectionId
    || !parsed.reviewApprovalId
    || !parsed.advancementId
    || parsed.advancementStage !== 'blocked'
    || !Number.isSafeInteger(parsed.advancementStateRevision)
    || !/^[a-f0-9]{64}$/.test(parsed.advancementStateDigest)
    || parsed.advancementBlockedCode !== 'capability_acquisition_missing'
    || !isPackagedCapabilityAcquisitionMissingDetail(parsed.advancementBlockedDetail)
    || parsed.firstConvergence?.failures !== 0
    || parsed.secondConvergence?.failures !== 0
    || !/^[a-f0-9]{64}$/.test(parsed.notificationDeliveryDigest)
    || !Number.isSafeInteger(parsed.notificationDeliveryQueueLength)
    // U5 makes the durable local store a real desktop delivery surface, so the
    // explicit production delivery passes above must drain the ordinary loud
    // workflow notification instead of retaining a no-destination retry row.
    || parsed.notificationDeliveryQueueLength !== 0
    || !Array.isArray(parsed.modelRequests)
    || parsed.modelRequests.length < 2
    || parsed.modelRequests.some((request) =>
      request.model !== 'upgrade-fixture-model'
      || !/^[a-f0-9]{64}$/.test(request.bodySha256))
  ) {
    throw new Error(`packaged exercise returned an invalid proof: ${stable(parsed)}`);
  }
  return parsed;
}

function usageEntries(home: string): number {
  const directory = path.join(home, 'state', 'token-usage');
  if (!existsSync(directory)) return 0;
  return readdirSync(directory)
    .filter((name) => name.endsWith('.ndjson'))
    .reduce((total, name) => total + readFileSync(path.join(directory, name), 'utf8').split(/\r?\n/).filter(Boolean).length, 0);
}

function executionActivityEntries(home: string): number {
  const file = path.join(home, 'state', 'executions.json');
  if (!existsSync(file)) return 0;
  const rows = JSON.parse(readFileSync(file, 'utf8')) as Array<{ activity?: unknown }>;
  return rows.reduce((total, row) => total + (Array.isArray(row.activity) ? row.activity.length : 0), 0);
}

function workSnapshot(home: string, inspection: HomeInspection): WorkSnapshot {
  const counters: Record<string, number> = {};
  const harness = inspection.sqlite['state/harness.db'];
  for (const table of WORK_TABLES) counters[`table:${table}`] = harness?.tableCounts[table] ?? 0;
  for (const type of [...WORK_EVENT_TYPES].sort()) counters[`event:${type}`] = inspection.carriers.eventTypes[type] ?? 0;
  counters.model_usage_entries = usageEntries(home);
  // A terminal audit log under runs/<id>/events.jsonl is recovery projection,
  // not a fresh admitted body. Count canonical run records, then assert their
  // exact status/receipt bytes separately.
  counters.workflow_runs = inspection.carriers.workflowRuns.length;
  counters.workflow_trigger_events = inspection.carriers.triggerEvents.length;
  counters.execution_activity_entries = executionActivityEntries(home);
  return { counters };
}

function workDelta(before: WorkSnapshot, after: WorkSnapshot): WorkDelta {
  const keys = new Set([...Object.keys(before.counters), ...Object.keys(after.counters)]);
  const components: Record<string, number> = {};
  let total = 0;
  for (const key of [...keys].sort()) {
    const delta = (after.counters[key] ?? 0) - (before.counters[key] ?? 0);
    if (delta !== 0) components[key] = delta;
    total += Math.abs(delta);
  }
  return { total, components };
}

/** Closed logical projection for the few process/scheduler observations whose
 * value is expected to advance on a no-work restart. Every other field and
 * every other file remains byte-sensitive. */
export function normalizePackagedLogicalJson(
  relativePath: string,
  value: Record<string, Json>,
): Record<string, Json> {
  if (relativePath === 'cron/workflow-schedule-state.json') {
    const { lastEvaluatedAtMs: _workflowScanObservation, ...authority } = value;
    return authority;
  }
  if (relativePath === 'state/space-schedule-state.json') {
    const { lastEvaluatedAtMs: _spaceScanObservation, ...authority } = value;
    return authority;
  }
  if (relativePath === 'cron/daemon-state.json') {
    const {
      lastHealthyTickAt: _heartbeatObservation,
      lastCronEvaluatedAtMs: _cronScanObservation,
      ...authority
    } = value;
    return authority;
  }
  return value;
}

function nonSqliteState(
  home: string,
  inspection: HomeInspection,
  normalizeObservations: boolean,
): Record<string, string> {
  if (!normalizeObservations) return { ...inspection.allNonSqliteFiles };
  const files = { ...inspection.allNonSqliteFiles };
  for (const relativePath of Object.keys(files)) {
    if (
      relativePath === 'cron/workflow-schedule-state.json'
      || relativePath === 'state/space-schedule-state.json'
      || relativePath === 'cron/daemon-state.json'
    ) {
      const record = (() => {
      try {
        const parsed = JSON.parse(readFileSync(path.join(home, relativePath), 'utf8')) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? asJson(parsed) as Record<string, Json>
          : null;
      } catch {
        return null;
      }
      })();
      if (record) files[relativePath] = sha256(stable(normalizePackagedLogicalJson(relativePath, record)));
    }
  }
  return files;
}

function stateProjection(
  home: string,
  inspection: HomeInspection,
  normalizeObservations: boolean,
): {
  sqlite: Record<string, {
    userVersion: number;
    schemaVersions: number[] | null;
    schemaDigest: string;
    tableCounts: Record<string, number>;
    tableDigests: Record<string, string>;
  }>;
  files: Record<string, string>;
} {
  return {
    sqlite: Object.fromEntries(Object.entries(inspection.sqlite).map(([name, value]) => [name, {
      userVersion: value.userVersion,
      schemaVersions: value.schemaVersions,
      schemaDigest: value.schemaDigest,
      tableCounts: value.tableCounts,
      tableDigests: value.tableDigests,
    }])),
    files: nonSqliteState(home, inspection, normalizeObservations),
  };
}

function stateProjectionDigest(projection: ReturnType<typeof stateProjection>): string {
  return sha256(stable(projection));
}

function stateDifference(
  left: ReturnType<typeof stateProjection>,
  right: ReturnType<typeof stateProjection>,
): StateDifference {
  const difference: StateDifference = {
    sqliteSchemasChanged: [],
    sqliteTablesAdded: [],
    sqliteTablesRemoved: [],
    sqliteTablesChanged: [],
    filesAdded: [],
    filesRemoved: [],
    filesChanged: [],
  };
  for (const dbName of [...new Set([...Object.keys(left.sqlite), ...Object.keys(right.sqlite)])].sort()) {
    const before = left.sqlite[dbName];
    const after = right.sqlite[dbName];
    if (!before || !after) {
      difference.sqliteSchemasChanged.push(dbName);
      continue;
    }
    if (
      before.schemaDigest !== after.schemaDigest
      || before.userVersion !== after.userVersion
      || stable(before.schemaVersions) !== stable(after.schemaVersions)
    ) difference.sqliteSchemasChanged.push(dbName);
    for (const table of [...new Set([
      ...Object.keys(before.tableDigests),
      ...Object.keys(after.tableDigests),
    ])].sort()) {
      const identity = `${dbName}:${table}`;
      if (!(table in before.tableDigests)) difference.sqliteTablesAdded.push(identity);
      else if (!(table in after.tableDigests)) difference.sqliteTablesRemoved.push(identity);
      else if (
        before.tableDigests[table] !== after.tableDigests[table]
        || before.tableCounts[table] !== after.tableCounts[table]
      ) difference.sqliteTablesChanged.push(identity);
    }
  }
  for (const file of [...new Set([...Object.keys(left.files), ...Object.keys(right.files)])].sort()) {
    if (!(file in left.files)) difference.filesAdded.push(file);
    else if (!(file in right.files)) difference.filesRemoved.push(file);
    else if (left.files[file] !== right.files[file]) difference.filesChanged.push(file);
  }
  return difference;
}

function noStateDifference(difference: StateDifference): boolean {
  return Object.values(difference).every((entries) => entries.length === 0);
}

/** A snapshot authority barrier: the child has already reported a clean exit,
 * no singleton lease remains, and two complete logical reads agree without a
 * timing sleep. Any detached gate-owned writer therefore fails closed instead
 * of racing a favorable hash. */
function inspectQuiescentRehearsalHome(home: string, label: string): HomeInspection {
  if (!daemonLeaseIsAbsent(home)) {
    throw new Error(`${label} cannot be snapshotted while a daemon PID/owner lease survives`);
  }
  const first = inspectV314RehearsalHome(home);
  const second = inspectV314RehearsalHome(home);
  const firstProjection = stateProjection(home, first, false);
  const secondProjection = stateProjection(home, second, false);
  if (stable(firstProjection) !== stable(secondProjection)) {
    throw new Error(`${label} changed across consecutive post-exit state reads`);
  }
  return second;
}

function sqliteHealthy(inspection: HomeInspection): boolean {
  return Object.values(inspection.sqlite).every((value) =>
    value.integrity.length === 1
    && value.integrity[0] === 'ok'
    && value.foreignKeyViolations.length === 0
    && /^[a-f0-9]{64}$/.test(value.schemaDigest)
    && Object.values(value.tableDigests).every((digest) => /^[a-f0-9]{64}$/.test(digest)));
}

function schemaShape(inspection: HomeInspection): Json {
  return asJson({
    harness: inspection.sqlite['state/harness.db']?.schemaVersions?.at(-1) ?? null,
    memory: inspection.sqlite['state/memory.db']?.schemaVersions?.at(-1) ?? null,
    workspace: inspection.sqlite['state/workspaces.db']?.userVersion ?? null,
    workflowTrigger: inspection.sqlite['state/workflow-triggers.db']?.tableColumns ?? {},
  });
}

function identityRowsPreserved(
  reference: Json[] | undefined,
  actual: Json[] | undefined,
  key: string,
  immutableFields: readonly string[],
): boolean {
  const observed = new Map<string, Record<string, Json>>();
  for (const entry of actual ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, Json>;
    if (typeof row[key] === 'string' || typeof row[key] === 'number') {
      observed.set(String(row[key]), row);
    }
  }
  for (const entry of reference ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const expected = entry as Record<string, Json>;
    const current = observed.get(String(expected[key]));
    if (!current) return false;
    for (const field of immutableFields) {
      if (stable(expected[field] ?? null) !== stable(current[field] ?? null)) return false;
    }
  }
  return true;
}

function rowByIdentity(rows: Json[] | undefined, key: string, value: Json): Record<string, Json> | null {
  for (const entry of rows ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, Json>;
    if (record[key] === value) return record;
  }
  return null;
}

export function isExactV314TriggerRegistry(rows: Array<Record<string, Json>>): boolean {
  return rows.length === 1
    && rows[0]?.kind === 'system_event'
    && rows[0].event_type === 'upgrade.rehearsal.never-fired'
    && rows[0].schedule === null
    && rows[0].timezone === null;
}

function eventRows(
  inspection: HomeInspection,
  sessionId: string,
  type: string,
): Record<string, Json>[] {
  const rows = inspection.sqlite['state/harness.db']?.identities.events ?? [];
  return rows.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, Json>;
    return row.session_id === sessionId && row.type === type ? [row] : [];
  });
}

function eventData(row: Record<string, Json> | null | undefined): Record<string, Json> | null {
  if (!row || typeof row.data_json !== 'string') return null;
  try {
    const parsed = JSON.parse(row.data_json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, Json>
      : null;
  } catch {
    return null;
  }
}

function jsonRecord(value: Json): Record<string, Json> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, Json>
      : null;
  } catch {
    return null;
  }
}

function readJsonStateRecord(home: string, relativePath: string): Record<string, Json> | null {
  const file = path.join(home, relativePath);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? asJson(parsed) as Record<string, Json>
      : null;
  } catch {
    return null;
  }
}

function runForReceipt(inspection: HomeInspection, receiptId: Json): Record<string, Json> | null {
  return inspection.carriers.workflowRuns.find((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return (entry as Record<string, Json>).triggerReceiptId === receiptId;
  }) as Record<string, Json> | undefined ?? null;
}

function acceptanceForReceipt(inspection: HomeInspection, receiptId: Json): Record<string, Json> | null {
  return inspection.carriers.triggerReceiptAcceptances.find((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    return (entry as Record<string, Json>).receiptId === receiptId;
  }) as Record<string, Json> | undefined ?? null;
}

function notificationRows(
  inspection: HomeInspection,
  predicate: (notification: Record<string, Json>) => boolean,
): Record<string, Json>[] {
  return inspection.carriers.notifications.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const notification = entry as Record<string, Json>;
    return predicate(notification) ? [notification] : [];
  });
}

function preservedPreexistingFiles(
  reference: HomeInspection,
  actual: HomeInspection,
  mutablePaths: ReadonlySet<string>,
): { ok: boolean; changed: string[]; missing: string[] } {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [file, digest] of Object.entries(reference.allNonSqliteFiles)) {
    if (mutablePaths.has(file)) continue;
    if (!(file in actual.allNonSqliteFiles)) missing.push(file);
    else if (actual.allNonSqliteFiles[file] !== digest) changed.push(file);
  }
  return { ok: changed.length === 0 && missing.length === 0, changed, missing };
}

/** Shipped first-party instruction skills that setup seeds into `skills/` on
 * first boot (src/setup/builtin-skills.ts). Closed on purpose: the pin proves
 * this list equals the package's `builtin-skills/` directory. */
export const BUILTIN_SKILL_SEED_IDS = Object.freeze(['technical-content-marketing'] as const);

export type PackagedFirstBootAddedFileCategory =
  | 'recovery_projection'
  | 'deterministic_boot_seed'
  | 'scheduler_observation'
  | 'ephemeral_process_owner'
  | 'unexpected';

export interface PackagedFirstBootCausalFiles {
  /** True only after state/runs.json has passed the exact two-recovery-run
   * projection proof below. A matching pathname is never sufficient. */
  recoveredWorkflowRuns?: boolean;
  /** True only after the one-shot existing-workspace marker has passed its
   * exact shape and cross-boot stability proof below. */
  starterWorkspaceOffer?: boolean;
}

/** Closed path classifier. Classification never grants acceptance by itself:
 * each causal category has a semantic assertion below, and surviving process
 * owner artifacts always fail even though they are recognizable. */
export function classifyPackagedFirstBootAddedFile(
  relativePath: string,
  recoveryEventFiles: ReadonlySet<string> = new Set(),
  causalFiles: PackagedFirstBootCausalFiles = {},
): PackagedFirstBootAddedFileCategory {
  if (
    relativePath === 'cron/daemon-state.json'
    || relativePath === 'state/notification-delivery-queue.json'
    || recoveryEventFiles.has(relativePath)
    || (relativePath === 'state/runs.json' && causalFiles.recoveredWorkflowRuns === true)
  ) return 'recovery_projection';
  if (relativePath === 'state/space-schedule-state.json') return 'scheduler_observation';
  if (
    CHECK_IN_SEED_IDS.some((id) => relativePath === `state/check-in-templates/${id}.json`)
    || relativePath === 'vault/00-System/workflows/objective-execution-loop/SKILL.md'
    || relativePath === 'vault/00-System/workflows/objective-execution-loop/references/operating-principles.md'
    || relativePath === `memory/tool-procedures/${V314_GATE_MACHINE_ID}/.canonical-procedure-migration-v1.json`
    || BUILTIN_SKILL_SEED_IDS.some((id) => relativePath === `skills/${id}/SKILL.md`)
    || (relativePath === 'state/starter-workspace-offer.json'
      && causalFiles.starterWorkspaceOffer === true)
  ) return 'deterministic_boot_seed';
  if (
    relativePath === 'daemon.pid'
    || /^daemon\.lock\/owner-[A-Za-z0-9-]+\.json$/.test(relativePath)
    || /^\.daemon-owner-[A-Za-z0-9-]+\.tmp$/.test(relativePath)
    || /^daemon\.pid\.[1-9]\d*\.[A-Za-z0-9-]+\.tmp$/.test(relativePath)
  ) return 'ephemeral_process_owner';
  return 'unexpected';
}

function addedFilesByCategory(
  reference: HomeInspection,
  actual: HomeInspection,
  recoveryEventFiles: ReadonlySet<string>,
  causalFiles: PackagedFirstBootCausalFiles = {},
): Record<PackagedFirstBootAddedFileCategory, string[]> {
  const categories: Record<PackagedFirstBootAddedFileCategory, string[]> = {
    recovery_projection: [],
    deterministic_boot_seed: [],
    scheduler_observation: [],
    ephemeral_process_owner: [],
    unexpected: [],
  };
  for (const relativePath of Object.keys(actual.allNonSqliteFiles).sort()) {
    if (relativePath in reference.allNonSqliteFiles) continue;
    categories[classifyPackagedFirstBootAddedFile(relativePath, recoveryEventFiles, causalFiles)]
      .push(relativePath);
  }
  return categories;
}

export function validDeterministicBootSeed(home: string, relativePath: string): boolean {
  if (relativePath === 'state/starter-workspace-offer.json') {
    const record = readJsonStateRecord(home, relativePath);
    return isExactStarterWorkspaceOfferSeed(record, record, record);
  }
  const checkInId = (
    /^state\/check-in-templates\/(seed-[a-z-]+)\.json$/.exec(relativePath)?.[1]
  ) as (typeof CHECK_IN_SEED_IDS)[number] | undefined;
  if (checkInId && checkInId in CHECK_IN_SEED_TRIGGERS) {
    const record = readJsonStateRecord(home, relativePath);
    if (!record) return false;
    const [trigger, timingKey, timingValue] = CHECK_IN_SEED_TRIGGERS[checkInId];
    const { createdAt, updatedAt } = record;
    return typeof createdAt === 'string'
      && Number.isFinite(Date.parse(createdAt))
      && createdAt === updatedAt
      && record.id === checkInId
      && record.seededId === checkInId
      && record.agentSlug === 'clementine'
      && record.version === 'v1'
      && record.enabled === false
      && record.trigger === trigger
      && record[timingKey] === timingValue
      && typeof record.questionTemplate === 'string'
      && record.questionTemplate.length > 0;
  }
  if (relativePath.endsWith('/objective-execution-loop/SKILL.md')) {
    const bytes = readFileSync(path.join(home, relativePath), 'utf8');
    return /(?:^|\n)name:\s*Objective Execution Loop(?:\n|$)/.test(bytes)
      && bytes.includes('requires_approval: true');
  }
  const builtinSkill = BUILTIN_SKILL_SEED_IDS.find((id) => relativePath === `skills/${id}/SKILL.md`);
  if (builtinSkill) {
    // Exact seed semantics mirror the provisioner's own validation: bounded,
    // front-matter `name` equal to the directory, and a non-empty body.
    const bytes = readFileSync(path.join(home, relativePath), 'utf8');
    return Buffer.byteLength(bytes, 'utf8') <= 256 * 1024
      && bytes.startsWith('---\n')
      && new RegExp(`(?:^|\\n)name:\\s*${builtinSkill}(?:\\n|$)`).test(bytes)
      && bytes.split('\n---\n')[1]?.trim().length > 0;
  }
  if (relativePath.endsWith('/objective-execution-loop/references/operating-principles.md')) {
    const bytes = readFileSync(path.join(home, relativePath), 'utf8');
    return bytes.startsWith('# Objective Execution Operating Principles\n')
      && bytes.includes('Report exact evidence, blockers, and next checkpoints');
  }
  const record = readJsonStateRecord(home, relativePath);
  return record?.version === 1
    && record.machineId === V314_GATE_MACHINE_ID
    && typeof record.completedAt === 'string'
    && Number.isFinite(Date.parse(record.completedAt))
    && stable(record.report) === stable({
      aliasesScanned: 0, aliasesLinked: 0, proceduresCreated: 0, quarantinedAliases: 0,
    });
}

function validEmptySpaceScheduleObservation(state: Record<string, Json> | null): boolean {
  return typeof state?.lastEvaluatedAtMs === 'number'
    && Number.isFinite(state.lastEvaluatedAtMs)
    && state.lastEvaluatedAtMs >= 0
    && stable(state.lastRunByMinute) === stable({})
    && stable(state.lastReengageByKey) === stable({})
    && stable(state.pausedRetryBySlug) === stable({});
}

function legacyIdentitiesPreserved(reference: HomeInspection, actual: HomeInspection): boolean {
  const beforeHarness = reference.sqlite['state/harness.db']?.identities ?? {};
  const afterHarness = actual.sqlite['state/harness.db']?.identities ?? {};
  const beforeMemory = reference.sqlite['state/memory.db']?.identities ?? {};
  const afterMemory = actual.sqlite['state/memory.db']?.identities ?? {};
  const beforeWorkspace = reference.sqlite['state/workspaces.db']?.identities ?? {};
  const afterWorkspace = actual.sqlite['state/workspaces.db']?.identities ?? {};
  const beforeTrigger = reference.sqlite['state/workflow-triggers.db']?.identities ?? {};
  const afterTrigger = actual.sqlite['state/workflow-triggers.db']?.identities ?? {};
  return [
    identityRowsPreserved(beforeHarness.sessions, afterHarness.sessions, 'id', ['id', 'kind']),
    identityRowsPreserved(beforeHarness.events, afterHarness.events, 'id', [
      'id', 'session_id', 'seq', 'turn', 'role', 'type', 'data_json',
    ]),
    identityRowsPreserved(beforeHarness.pendingApprovals, afterHarness.pendingApprovals, 'approval_id', [
      'approval_id', 'session_id', 'channel', 'channel_id', 'requested_at', 'expires_at',
      'subject', 'tool', 'args_json', 'resume_key', 'presentation_json',
    ]),
    identityRowsPreserved(beforeHarness.runArtifacts, afterHarness.runArtifacts, 'id', [
      'id', 'session_id', 'run_scope_id', 'slot_key', 'kind', 'provider',
      'status', 'resource_id', 'uri',
    ]),
    identityRowsPreserved(beforeHarness.runAttempts, afterHarness.runAttempts, 'attempt_id', [
      'attempt_id', 'session_id', 'source_user_seq', 'run_id', 'started_at',
    ]),
    identityRowsPreserved(beforeHarness.dispatchLeases, afterHarness.dispatchLeases, 'scope_id', [
      'scope_id', 'session_id', 'lease_id', 'run_attempt_id', 'parent_scope_id',
      'parent_lease_id', 'activated_at',
    ]),
    identityRowsPreserved(beforeMemory.memoryEpisodes, afterMemory.memoryEpisodes, 'id', [
      'id', 'kind', 'session_id', 'call_id', 'status', 'content_hash',
    ]),
    identityRowsPreserved(beforeMemory.entities, afterMemory.entities, 'id', [
      'id', 'entity_type', 'canonical_name', 'canonical_name_lc',
    ]),
    identityRowsPreserved(beforeMemory.focus, afterMemory.focus, 'id', [
      'id', 'resource_ref', 'title', 'status', 'related_session_id',
    ]),
    identityRowsPreserved(beforeWorkspace.workspaces, afterWorkspace.workspaces, 'id', [
      'id', 'slug', 'title', 'status', 'origin_session_id',
    ]),
    identityRowsPreserved(beforeWorkspace.workspaceObservations, afterWorkspace.workspaceObservations, 'id', [
      'id', 'workspace_id', 'source_key', 'refresh_id', 'batch_id', 'status', 'is_current',
    ]),
    identityRowsPreserved(beforeTrigger.workflowTriggers, afterTrigger.workflowTriggers, 'id', [
      'id', 'workflow_name', 'kind', 'schedule', 'timezone', 'webhook_path', 'event_type',
    ]),
    identityRowsPreserved(beforeTrigger.workflowTriggerEvents, afterTrigger.workflowTriggerEvents, 'id', [
      'id', 'trigger_id', 'dedupe_key',
    ]),
  ].every(Boolean);
}

function readJsonArrayRecords(home: string, relativePath: string): Array<Record<string, Json>> {
  const file = path.join(home, relativePath);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return Array.isArray(parsed)
      ? parsed.flatMap((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
        ? [asJson(entry) as Record<string, Json>]
        : [])
      : [];
  } catch {
    return [];
  }
}

function readStrictJsonRecordArray(home: string, relativePath: string): Array<Record<string, Json>> | null {
  const file = path.join(home, relativePath);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return null;
    if (parsed.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) return null;
    return asJson(parsed) as Array<Record<string, Json>>;
  } catch {
    return null;
  }
}

function readTextStateFile(home: string, relativePath: string): string | null {
  const file = path.join(home, relativePath);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function exactObjectKeys(value: Record<string, Json>, keys: readonly string[]): boolean {
  return stable(Object.keys(value).sort()) === stable([...keys].sort());
}

function exactRecoveredWorkflowActivityRow(
  row: Record<string, Json>,
  workflowName: string,
  runId: string,
): boolean {
  const message = `Workflow "${workflowName}" is disabled — approve/enable it before it can run.`;
  if (
    !exactObjectKeys(row, [
      'id', 'sessionId', 'channel', 'source', 'title', 'input', 'status',
      'createdAt', 'updatedAt', 'completedAt', 'error', 'events',
    ])
    || row.id !== runId
    || row.sessionId !== `workflow:${runId}`
    || row.channel !== 'workflow'
    || row.source !== 'workflow'
    || row.title !== `Workflow: ${workflowName}`
    || row.input !== `Starting workflow "${workflowName}"`
    || row.status !== 'failed'
    || row.error !== message
    || !isCanonicalIso(row.createdAt)
    || !isCanonicalIso(row.updatedAt)
    || row.completedAt !== row.updatedAt
    || Date.parse(row.updatedAt) < Date.parse(row.createdAt)
    || !Array.isArray(row.events)
    || row.events.length !== 2
  ) return false;
  const received = row.events[0];
  const failed = row.events[1];
  if (
    !received || typeof received !== 'object' || Array.isArray(received)
    || !failed || typeof failed !== 'object' || Array.isArray(failed)
  ) return false;
  const receivedRow = received as Record<string, Json>;
  const failedRow = failed as Record<string, Json>;
  return exactObjectKeys(receivedRow, ['id', 'type', 'message', 'createdAt'])
    && typeof receivedRow.id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receivedRow.id)
    && receivedRow.type === 'received'
    && receivedRow.message === 'Run received.'
    && receivedRow.createdAt === row.createdAt
    && exactObjectKeys(failedRow, ['id', 'type', 'message', 'createdAt', 'data'])
    && typeof failedRow.id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(failedRow.id)
    && failedRow.id !== receivedRow.id
    && failedRow.type === 'failed'
    && failedRow.message === `Workflow failed before start: ${message}`
    && failedRow.createdAt === row.updatedAt
    && stable(failedRow.data) === stable({});
}

function exactExercisedWorkflowActivityRow(
  row: Record<string, Json>,
  workflowName: string,
  runId: string,
  outputPreview: string,
): boolean {
  if (
    !exactObjectKeys(row, [
      'id', 'sessionId', 'channel', 'source', 'title', 'input', 'status',
      'createdAt', 'updatedAt', 'completedAt', 'outputPreview', 'events',
    ])
    || row.id !== runId
    || row.sessionId !== `workflow:${runId}`
    || row.channel !== 'workflow'
    || row.source !== 'workflow'
    || row.title !== `Workflow: ${workflowName}`
    || row.input !== `Running workflow "${workflowName}"`
    || row.status !== 'completed'
    || row.outputPreview !== outputPreview
    || !isCanonicalIso(row.createdAt)
    || !isCanonicalIso(row.updatedAt)
    || row.completedAt !== row.updatedAt
    || Date.parse(row.updatedAt) < Date.parse(row.createdAt)
    || !Array.isArray(row.events)
    || row.events.length !== 2
  ) return false;
  const received = row.events[0];
  const completed = row.events[1];
  if (
    !received || typeof received !== 'object' || Array.isArray(received)
    || !completed || typeof completed !== 'object' || Array.isArray(completed)
  ) return false;
  const receivedRow = received as Record<string, Json>;
  const completedRow = completed as Record<string, Json>;
  const uuid = (value: Json): value is string => typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  return exactObjectKeys(receivedRow, ['id', 'type', 'message', 'createdAt'])
    && uuid(receivedRow.id)
    && receivedRow.type === 'received'
    && receivedRow.message === 'Run received.'
    && receivedRow.createdAt === row.createdAt
    && exactObjectKeys(completedRow, ['id', 'type', 'message', 'createdAt', 'data'])
    && uuid(completedRow.id)
    && completedRow.id !== receivedRow.id
    && completedRow.type === 'completed'
    && completedRow.message === 'Completed'
    && completedRow.createdAt === row.updatedAt
    && stable(completedRow.data) === stable({});
}

export interface RecoveredWorkflowRunProjectionExpectation {
  workflowName: string;
  recoveredRunIds: readonly string[];
  exerciseRunId: string;
  exerciseOutputPreview: string;
}

/** Prove that state/runs.json is exactly the user-facing projection of the two
 * old queued runs recovered by boot one, followed only by the one workflow
 * deliberately executed by the installed-package exercise. The second daemon
 * may not rewrite a byte or create another activity/execution row. */
export function isExactRecoveredWorkflowRunProjection(
  first: Array<Record<string, Json>>,
  postExercise: Array<Record<string, Json>>,
  second: Array<Record<string, Json>>,
  expected: RecoveredWorkflowRunProjectionExpectation,
): boolean {
  const recoveredIds = [...new Set(expected.recoveredRunIds)];
  if (
    recoveredIds.length !== 2
    || recoveredIds.some((id) => typeof id !== 'string' || id.length === 0)
    || !expected.exerciseRunId
    || recoveredIds.includes(expected.exerciseRunId)
    || first.length !== recoveredIds.length
    || postExercise.length !== recoveredIds.length + 1
    || stable(postExercise) !== stable(second)
  ) return false;
  const firstById = new Map(first.flatMap((row) =>
    typeof row.id === 'string' ? [[row.id, row] as const] : []));
  const postById = new Map(postExercise.flatMap((row) =>
    typeof row.id === 'string' ? [[row.id, row] as const] : []));
  if (firstById.size !== first.length || postById.size !== postExercise.length) return false;
  for (const runId of recoveredIds) {
    const firstRow = firstById.get(runId);
    const postRow = postById.get(runId);
    if (
      !firstRow
      || !postRow
      || !exactRecoveredWorkflowActivityRow(firstRow, expected.workflowName, runId)
      || stable(firstRow) !== stable(postRow)
    ) return false;
  }
  const exercise = postById.get(expected.exerciseRunId);
  return Boolean(exercise)
    && expected.exerciseOutputPreview.length > 0
    && exactExercisedWorkflowActivityRow(
      exercise!,
      expected.workflowName,
      expected.exerciseRunId,
      expected.exerciseOutputPreview,
    );
}

/** Exact once-ever seed emitted when the migrated home already owns a
 * workspace. Missing, additional, or differently-valued fields fail closed. */
export function isExactStarterWorkspaceOfferSeed(
  first: Record<string, Json> | null,
  postExercise: Record<string, Json> | null,
  second: Record<string, Json> | null,
): boolean {
  return first !== null
    && exactObjectKeys(first, ['offeredAt', 'reason', 'at'])
    && first.offeredAt === null
    && first.reason === 'already-has-workspaces'
    && isCanonicalIso(first.at)
    && stable(first) === stable(postExercise)
    && stable(postExercise) === stable(second);
}

export interface ApprovalResolutionAuditExpectation {
  at: string;
  sessionId: string;
  approvalId: string;
  subject: string;
  tool: string;
  resolution: string;
  resolvedBy: string;
}

export interface ExerciseApprovalRequestAuditExpectation {
  at: string;
  kind: 'automation_opportunity_review';
  sessionId: string;
  seq: number;
  turn: number;
  projectionId: string;
  proposalId: string;
  proposalRevision: number;
  proposalDigest: string;
  tool: 'automation_opportunity_review_decision';
  subject: string;
  approvalId: string;
  pendingActionId: null;
  resumeKey: string;
}

/** The archived appendAudit API must have produced one bounded, inert row.
 * This prevents a four-way equality proof over four absent/empty carriers. */
export function isExactV314WorkspaceAuditCarrier(bytes: string | null): boolean {
  if (typeof bytes !== 'string') return false;
  const lines = bytes.split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) return false;
  try {
    const parsed = JSON.parse(lines[0] ?? '') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const row = asJson(parsed) as Record<string, Json>;
    return exactObjectKeys(row, ['ts', 'method', 'path', 'outcome', 'bytes', 'note'])
      && isCanonicalIso(row.ts)
      && row.method === 'FIXTURE'
      && row.path === '/upgrade-rehearsal/v3.14'
      && row.outcome === 'ok'
      && row.bytes === 0
      && row.note === 'Bounded exact-v3.14 workspace audit carrier.';
  } catch {
    return false;
  }
}

/** Closed append proof for the global monthly audit carrier. Boot one adds
 * exactly the deliberately aged approval resolution; the installed exercise
 * then adds exactly its reviewed-project approval. No other row or prefix
 * rewrite is accepted, and boot two must be byte-idempotent. */
export function isExactApprovalResolutionAuditAppend(
  beforeBytes: string | null,
  firstBytes: string | null,
  postExerciseBytes: string | null,
  secondBytes: string | null,
  recoveredApproval: ApprovalResolutionAuditExpectation,
  exerciseRequest: ExerciseApprovalRequestAuditExpectation,
  exerciseApproval: ApprovalResolutionAuditExpectation,
): boolean {
  if (
    typeof beforeBytes !== 'string'
    || beforeBytes.length === 0
    || typeof firstBytes !== 'string'
    || typeof postExerciseBytes !== 'string'
    || typeof secondBytes !== 'string'
    || postExerciseBytes !== secondBytes
    || !isCanonicalIso(recoveredApproval.at)
    || !isCanonicalIso(exerciseRequest.at)
    || !isCanonicalIso(exerciseApproval.at)
  ) return false;
  const exactAppend = (
    prefix: string,
    next: string,
    expected: ApprovalResolutionAuditExpectation,
  ): boolean => {
    if (!next.startsWith(prefix) || next.length <= prefix.length) return false;
    const appendedLines = next.slice(prefix.length).split(/\r?\n/).filter(Boolean);
    if (appendedLines.length !== 1) return false;
    try {
      const parsed = JSON.parse(appendedLines[0] ?? '') as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      const appended = asJson(parsed) as Record<string, Json>;
      return exactObjectKeys(appended, [
        'at', 'kind', 'sessionId', 'approvalId', 'subject', 'tool',
        'resolution', 'resolvedBy',
      ]) && stable(appended) === stable({ kind: 'approval_resolved', ...expected });
    } catch {
      return false;
    }
  };
  if (!exactAppend(beforeBytes, firstBytes, recoveredApproval)) return false;
  if (!postExerciseBytes.startsWith(firstBytes) || postExerciseBytes.length <= firstBytes.length) return false;
  const exerciseRows: Array<Record<string, Json>> = [];
  try {
    for (const line of postExerciseBytes.slice(firstBytes.length).split(/\r?\n/).filter(Boolean)) {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      exerciseRows.push(asJson(parsed) as Record<string, Json>);
    }
  } catch {
    return false;
  }
  const exerciseRequestRow = exerciseRows[0];
  const exerciseResolution = exerciseRows[1];
  return exerciseRows.length === 2
    && exactObjectKeys(exerciseRequestRow!, [
      'at', 'kind', 'sessionId', 'seq', 'turn', 'projectionId', 'proposalId',
      'proposalRevision', 'proposalDigest', 'tool', 'subject', 'approvalId',
      'pendingActionId', 'resumeKey',
    ])
    && stable(exerciseRequestRow) === stable(exerciseRequest)
    && exerciseResolution?.kind === 'approval_resolved'
    && exactObjectKeys(exerciseResolution, [
      'at', 'kind', 'sessionId', 'approvalId', 'subject', 'tool',
      'resolution', 'resolvedBy',
    ])
    && stable(exerciseResolution) === stable({ kind: 'approval_resolved', ...exerciseApproval });
}

export function isExactLegacyApprovalRetirement(
  before: Array<Record<string, Json>>,
  first: Array<Record<string, Json>>,
  second: Array<Record<string, Json>>,
): boolean {
  const byId = (rows: Array<Record<string, Json>>): Map<string, Record<string, Json>> =>
    new Map(rows.flatMap((row) => typeof row.id === 'string' ? [[row.id, row] as const] : []));
  const beforeById = byId(before);
  const firstById = byId(first);
  const secondById = byId(second);
  const pendingId = 'legacy-approval-v314-pending';
  const approvedId = 'legacy-approval-v314-approved';
  const pendingBefore = beforeById.get(pendingId);
  const pendingFirst = firstById.get(pendingId);
  const approvedBefore = beforeById.get(approvedId);
  const approvedFirst = firstById.get(approvedId);
  return before.length === 2
    && first.length === 2
    && second.length === 2
    && beforeById.size === 2
    && firstById.size === 2
    && secondById.size === 2
    && pendingBefore?.status === 'pending'
    && pendingFirst?.status === 'rejected'
    && stable(pendingFirst) === stable({ ...pendingBefore, status: 'rejected' })
    && approvedBefore?.status === 'approved'
    && stable(approvedBefore) === stable(approvedFirst)
    && stable(first) === stable(second);
}

export async function runPackagedV314DaemonRehearsal(
  options: PackagedV314DaemonRehearsalOptions = {},
): Promise<PackagedV314DaemonRehearsalReport> {
  const candidate = currentCandidateIdentity();
  const rehearsalRoot = options.rehearsalRoot
    ? assertDisposable(options.rehearsalRoot, 'packaged daemon rehearsal root')
    : mkdtempSync(path.join(tempRoot, 'clem-v314-packaged-daemon-'));
  const base = await runV314UpgradeRehearsal({ rehearsalRoot, keep: true });
  const daemonHome = path.join(rehearsalRoot, 'packaged-daemon-home');
  cpSync(base.paths.immutableSnapshot, daemonHome, {
    recursive: true,
    errorOnExist: true,
    force: false,
    preserveTimestamps: true,
  });
  const gateSeeds = seedPackagedGateState(daemonHome);
  const hermeticRuntimePath = path.join(rehearsalRoot, 'hermetic-runtime-path');
  mkdirSync(hermeticRuntimePath, { recursive: false });
  if (readdirSync(hermeticRuntimePath).length !== 0) {
    throw new Error(`packaged runtime PATH must be an empty gate-owned directory: ${hermeticRuntimePath}`);
  }
  const { tarball, packageEntry } = packAndInstall(rehearsalRoot);
  const exerciseFixture = path.join(repoRoot, 'scripts', 'rehearse-v314-packaged-exercise.mjs');
  if (!existsSync(exerciseFixture)) throw new Error(`packaged exercise fixture is missing: ${exerciseFixture}`);
  const workspaceDataPath = `spaces/${REQUIRED_FIXTURE_IDENTITIES.workspaceId}/data.json`;
  const workspaceAuditPath = `spaces/${REQUIRED_FIXTURE_IDENTITIES.workspaceId}/audit.jsonl`;
  const workflowActivityPath = 'state/runs.json';
  const starterWorkspaceOfferPath = 'state/starter-workspace-offer.json';
  // Fixture construction and the immediately following recovery boot are one
  // bounded gate operation. Pin the global monthly carrier before boot so the
  // exact preexisting bytes can be proven as an immutable prefix.
  const currentAuditPath = `audit/audit-${new Date().toISOString().slice(0, 7)}.jsonl`;
  const before = inspectQuiescentRehearsalHome(daemonHome, 'pre-daemon fixture');
  const beforeLegacyApprovals = readJsonArrayRecords(daemonHome, 'state/approvals.json');
  const beforeWorkflowActivityRuns = readStrictJsonRecordArray(daemonHome, workflowActivityPath);
  const beforeStarterWorkspaceOffer = readJsonStateRecord(daemonHome, starterWorkspaceOfferPath);
  const beforeCurrentAuditBytes = readTextStateFile(daemonHome, currentAuditPath);
  const beforeWorkspaceAuditBytes = readTextStateFile(daemonHome, workspaceAuditPath);
  const beforeWork = workSnapshot(daemonHome, before);
  const firstProcess = await bootPackagedDaemon(1, packageEntry, daemonHome, hermeticRuntimePath);
  const first = inspectQuiescentRehearsalHome(daemonHome, 'first packaged boot');
  const firstLegacyApprovals = readJsonArrayRecords(daemonHome, 'state/approvals.json');
  const firstWorkflowActivityRuns = readStrictJsonRecordArray(daemonHome, workflowActivityPath);
  const firstStarterWorkspaceOffer = readJsonStateRecord(daemonHome, starterWorkspaceOfferPath);
  const firstCurrentAuditBytes = readTextStateFile(daemonHome, currentAuditPath);
  const firstWorkspaceAuditBytes = readTextStateFile(daemonHome, workspaceAuditPath);
  const firstScheduleObservation = readJsonStateRecord(daemonHome, 'cron/workflow-schedule-state.json');
  const firstSpaceScheduleObservation = readJsonStateRecord(daemonHome, 'state/space-schedule-state.json');
  const firstDaemonObservation = readJsonStateRecord(daemonHome, 'cron/daemon-state.json');
  const firstLogicalState = stateProjection(daemonHome, first, true);
  const firstWork = workSnapshot(daemonHome, first);
  const exercise = runPackagedUpgradeExercise(
    exerciseFixture,
    packageEntry,
    daemonHome,
    hermeticRuntimePath,
  );
  const postExercise = inspectQuiescentRehearsalHome(daemonHome, 'installed exercise');
  const postExerciseLegacyApprovals = readJsonArrayRecords(daemonHome, 'state/approvals.json');
  const postExerciseWorkflowActivityRuns = readStrictJsonRecordArray(daemonHome, workflowActivityPath);
  const postExerciseStarterWorkspaceOffer = readJsonStateRecord(daemonHome, starterWorkspaceOfferPath);
  const postExerciseCurrentAuditBytes = readTextStateFile(daemonHome, currentAuditPath);
  const postExerciseWorkspaceAuditBytes = readTextStateFile(daemonHome, workspaceAuditPath);
  const postExerciseScheduleObservation = readJsonStateRecord(daemonHome, 'cron/workflow-schedule-state.json');
  const postExerciseSpaceScheduleObservation = readJsonStateRecord(daemonHome, 'state/space-schedule-state.json');
  const postExerciseDaemonObservation = readJsonStateRecord(daemonHome, 'cron/daemon-state.json');
  const postExerciseRawState = stateProjection(daemonHome, postExercise, false);
  const postExerciseLogicalState = stateProjection(daemonHome, postExercise, true);
  const postExerciseWork = workSnapshot(daemonHome, postExercise);
  const secondProcess = await bootPackagedDaemon(2, packageEntry, daemonHome, hermeticRuntimePath);
  const second = inspectQuiescentRehearsalHome(daemonHome, 'second packaged boot');
  const secondLegacyApprovals = readJsonArrayRecords(daemonHome, 'state/approvals.json');
  const secondWorkflowActivityRuns = readStrictJsonRecordArray(daemonHome, workflowActivityPath);
  const secondStarterWorkspaceOffer = readJsonStateRecord(daemonHome, starterWorkspaceOfferPath);
  const secondCurrentAuditBytes = readTextStateFile(daemonHome, currentAuditPath);
  const secondWorkspaceAuditBytes = readTextStateFile(daemonHome, workspaceAuditPath);
  const secondScheduleObservation = readJsonStateRecord(daemonHome, 'cron/workflow-schedule-state.json');
  const secondSpaceScheduleObservation = readJsonStateRecord(daemonHome, 'state/space-schedule-state.json');
  const secondDaemonObservation = readJsonStateRecord(daemonHome, 'cron/daemon-state.json');
  const secondRawState = stateProjection(daemonHome, second, false);
  const secondLogicalState = stateProjection(daemonHome, second, true);
  const secondWork = workSnapshot(daemonHome, second);
  const firstBootWorkDelta = workDelta(beforeWork, firstWork);
  const exerciseWorkDelta = workDelta(firstWork, postExerciseWork);
  const secondBootWorkDelta = workDelta(postExerciseWork, secondWork);
  const firstBootStateDigest = stateProjectionDigest(firstLogicalState);
  const postExerciseStateDigest = stateProjectionDigest(postExerciseLogicalState);
  const secondBootStateDigest = stateProjectionDigest(secondLogicalState);
  const postExerciseRawStateDigest = stateProjectionDigest(postExerciseRawState);
  const secondBootRawStateDigest = stateProjectionDigest(secondRawState);
  const secondBootRawStateDiff = stateDifference(postExerciseRawState, secondRawState);
  const secondBootLogicalStateDiff = stateDifference(postExerciseLogicalState, secondLogicalState);
  const checks: PackagedV314DaemonRehearsalReport['checks'] = [];
  const add = (name: string, ok: boolean, detail?: unknown): void => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail: asJson(detail) }) });
  };
  add('exact_v314_fixture_rehearsal_is_green', base.ok, base.checks.filter((check) => !check.ok));
  add('actual_npm_tarball_entry_is_installed_without_source_or_symlink',
    existsSync(packageEntry)
      && !lstatSync(path.dirname(path.dirname(packageEntry))).isSymbolicLink()
      && !existsSync(path.join(path.dirname(path.dirname(packageEntry)), 'src')),
    { packageEntry });
  const runtimeEnvironment = packagedRuntimeEnvironment(process.env, daemonHome, hermeticRuntimePath);
  add('daemon_and_exercise_execute_with_one_empty_gate_owned_path_and_absolute_node',
    runtimeEnvironment.PATH === hermeticRuntimePath
      && readdirSync(hermeticRuntimePath).length === 0
      && path.isAbsolute(process.execPath), {
    runtimePath: runtimeEnvironment.PATH ?? null,
    runtimePathEntries: readdirSync(hermeticRuntimePath),
    node: process.execPath,
  });
  add('gate_owned_machine_policy_and_daily_maintenance_seeds_remain_exact',
    packagedGateSeedsPreserved(gateSeeds, before, first, postExercise, second), {
    utcDay: gateSeeds.utcDay,
    digests: gateSeeds.digests,
  });
  add('first_packaged_daemon_boot_reaches_ready_owns_one_lease_and_closes_cleanly',
    firstProcess.ready
      && firstProcess.cleanExit
      && firstProcess.liveLease.valid
      && firstProcess.postExitLeaseClean,
    firstProcess);
  add('second_packaged_daemon_boot_reaches_ready_owns_one_lease_and_closes_cleanly',
    secondProcess.ready
      && secondProcess.cleanExit
      && secondProcess.liveLease.valid
      && secondProcess.postExitLeaseClean,
    secondProcess);
  add('packaged_process_owner_generations_are_single_valid_and_monotonic',
    firstProcess.liveLease.ownerCount === 1
      && secondProcess.liveLease.ownerCount === 1
      && firstProcess.liveLease.ownerStartedAt !== null
      && secondProcess.liveLease.ownerStartedAt !== null
      && Date.parse(secondProcess.liveLease.ownerStartedAt) >= Date.parse(firstProcess.liveLease.ownerStartedAt), {
    first: firstProcess.liveLease,
    second: secondProcess.liveLease,
  });
  add('both_packaged_daemons_complete_one_full_recovery_tick_before_shutdown',
    firstProcess.recoverySettled
      && secondProcess.recoverySettled
      && firstProcess.notificationDeliverySettled
      && secondProcess.notificationDeliverySettled
      && firstProcess.settledPhaseSequence > 0
      && secondProcess.settledPhaseSequence > 0,
    { first: firstProcess, second: secondProcess });
  add('both_processes_self_report_one_exact_packaged_candidate',
    firstProcess.build.packaged
      && secondProcess.build.packaged
      && stable(firstProcess.build) === stable(secondProcess.build)
      && firstProcess.build.entry === packageEntry
      && firstProcess.build.gitSha === candidate.gitSha
      && firstProcess.build.sourceFingerprint === candidate.sourceFingerprint,
    { first: firstProcess.build, second: secondProcess.build, candidate });
  add('packaged_daemon_reaches_the_store_rehearsal_schema_targets',
    stable(schemaShape(first)) === stable(schemaShape(base.firstBoot))
      && stable(schemaShape(second)) === stable(schemaShape(base.firstBoot))
      && firstProcess.build.schemaVersion === firstProcess.build.expectedSchemaVersion
      && secondProcess.build.schemaVersion === secondProcess.build.expectedSchemaVersion,
    { expected: schemaShape(base.firstBoot), first: schemaShape(first), second: schemaShape(second) });
  add('both_packaged_boots_and_the_installed_exercise_leave_every_sqlite_store_healthy',
    sqliteHealthy(first) && sqliteHealthy(postExercise) && sqliteHealthy(second));
  add('legacy_conversation_memory_artifact_space_and_trigger_identities_survive',
    legacyIdentitiesPreserved(base.firstBoot, first)
      && legacyIdentitiesPreserved(base.firstBoot, postExercise)
      && legacyIdentitiesPreserved(base.firstBoot, second));
  add('workspace_data_projection_bytes_remain_exact_across_both_boots_and_exercise',
    typeof before.allNonSqliteFiles[workspaceDataPath] === 'string'
      && before.allNonSqliteFiles[workspaceDataPath] === first.allNonSqliteFiles[workspaceDataPath]
      && first.allNonSqliteFiles[workspaceDataPath] === postExercise.allNonSqliteFiles[workspaceDataPath]
      && postExercise.allNonSqliteFiles[workspaceDataPath] === second.allNonSqliteFiles[workspaceDataPath], {
    path: workspaceDataPath,
    before: before.allNonSqliteFiles[workspaceDataPath] ?? null,
    first: first.allNonSqliteFiles[workspaceDataPath] ?? null,
    postExercise: postExercise.allNonSqliteFiles[workspaceDataPath] ?? null,
    second: second.allNonSqliteFiles[workspaceDataPath] ?? null,
  });
  add('workspace_audit_bytes_remain_exact_across_both_boots_and_exercise',
    isExactV314WorkspaceAuditCarrier(beforeWorkspaceAuditBytes)
      && beforeWorkspaceAuditBytes === firstWorkspaceAuditBytes
      && firstWorkspaceAuditBytes === postExerciseWorkspaceAuditBytes
      && postExerciseWorkspaceAuditBytes === secondWorkspaceAuditBytes
      && typeof before.allNonSqliteFiles[workspaceAuditPath] === 'string'
      && before.allNonSqliteFiles[workspaceAuditPath] === first.allNonSqliteFiles[workspaceAuditPath]
      && first.allNonSqliteFiles[workspaceAuditPath] === postExercise.allNonSqliteFiles[workspaceAuditPath]
      && postExercise.allNonSqliteFiles[workspaceAuditPath] === second.allNonSqliteFiles[workspaceAuditPath],
    {
      path: workspaceAuditPath,
      digests: {
        before: before.allNonSqliteFiles[workspaceAuditPath] ?? null,
        first: first.allNonSqliteFiles[workspaceAuditPath] ?? null,
        postExercise: postExercise.allNonSqliteFiles[workspaceAuditPath] ?? null,
        second: second.allNonSqliteFiles[workspaceAuditPath] ?? null,
      },
    });
  add('legacy_approval_store_retires_only_the_exact_pending_row_once',
    isExactLegacyApprovalRetirement(beforeLegacyApprovals, firstLegacyApprovals, postExerciseLegacyApprovals)
      && stable(postExerciseLegacyApprovals) === stable(secondLegacyApprovals), {
    before: beforeLegacyApprovals,
    first: firstLegacyApprovals,
    postExercise: postExerciseLegacyApprovals,
    second: secondLegacyApprovals,
  });
  const pendingApproval = (inspection: HomeInspection): Record<string, Json> | null => {
    const rows = inspection.sqlite['state/harness.db']?.identities.pendingApprovals ?? [];
    for (const entry of rows) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const row = entry as Record<string, Json>;
      if (row.subject === 'Pending read-only fixture approval') return row;
    }
    return null;
  };
  const pendingBefore = pendingApproval(before);
  const pendingFirst = pendingApproval(first);
  const pendingSecond = pendingApproval(second);
  add('first_packaged_boot_quarantines_the_aged_ownerless_approval_once',
    pendingBefore?.status === 'pending'
      && pendingBefore.resolution === null
      && pendingBefore.consumed_at === null
      && pendingFirst?.status === 'cancelled'
      && pendingFirst.resolution === 'cancelled_by_system'
      && pendingFirst.resolver === 'reaper-dead-session'
      && typeof pendingFirst.resolved_at === 'string'
      && pendingFirst.consumed_at === null
      && stable(pendingFirst) === stable(pendingSecond),
    { before: pendingBefore, first: pendingFirst, second: pendingSecond });
  const exercisedApproval = rowByIdentity(
    postExercise.sqlite['state/harness.db']?.identities.pendingApprovals,
    'approval_id',
    exercise.reviewApprovalId,
  );
  const exerciseApprovalRequestEvents = eventRows(
    postExercise,
    exercise.coldSessionId,
    'approval_requested',
  ).filter((row) => eventData(row)?.approvalId === exercise.reviewApprovalId);
  const exerciseApprovalRequestEvent = exerciseApprovalRequestEvents.length === 1
    ? exerciseApprovalRequestEvents[0]!
    : null;
  const exerciseApprovalRequestData = eventData(exerciseApprovalRequestEvent);
  const exactExerciseApprovalRequestState = exerciseApprovalRequestEvent !== null
    && exerciseApprovalRequestData !== null
    && exactObjectKeys(exerciseApprovalRequestData, [
      'kind', 'projectionId', 'proposalId', 'proposalRevision', 'proposalDigest',
      'tool', 'subject', 'approvalId', 'pendingActionId', 'resumeKey',
    ])
    && exerciseApprovalRequestEvent.session_id === exercise.coldSessionId
    && Number.isSafeInteger(exerciseApprovalRequestEvent.seq)
    && exerciseApprovalRequestEvent.turn === 0
    && isCanonicalIso(exerciseApprovalRequestEvent.created_at)
    && exerciseApprovalRequestData.kind === 'automation_opportunity_review'
    && exerciseApprovalRequestData.projectionId === exercise.reviewProjectionId
    && exerciseApprovalRequestData.proposalId === exercise.proposalId
    && exerciseApprovalRequestData.proposalRevision === exercise.proposalRevision - 1
    && exerciseApprovalRequestData.proposalDigest === exercise.proposalDigest
    && exerciseApprovalRequestData.tool === 'automation_opportunity_review_decision'
    && exerciseApprovalRequestData.subject === 'Approve exact automation opportunity: Packaged upgrade durable project'
    && exerciseApprovalRequestData.approvalId === exercise.reviewApprovalId
    && exerciseApprovalRequestData.pendingActionId === null
    && typeof exerciseApprovalRequestData.resumeKey === 'string'
    && exerciseApprovalRequestData.resumeKey === exercisedApproval?.resume_key;
  const exerciseApprovalRequestExpectation: ExerciseApprovalRequestAuditExpectation | null =
    exactExerciseApprovalRequestState
      ? {
        at: exerciseApprovalRequestEvent!.created_at as string,
        kind: 'automation_opportunity_review',
        sessionId: exercise.coldSessionId,
        seq: exerciseApprovalRequestEvent!.seq as number,
        turn: 0,
        projectionId: exercise.reviewProjectionId,
        proposalId: exercise.proposalId,
        proposalRevision: exercise.proposalRevision - 1,
        proposalDigest: exercise.proposalDigest,
        tool: 'automation_opportunity_review_decision',
        subject: 'Approve exact automation opportunity: Packaged upgrade durable project',
        approvalId: exercise.reviewApprovalId,
        pendingActionId: null,
        resumeKey: exerciseApprovalRequestData!.resumeKey as string,
      }
      : null;
  const exactApprovalAuditAppend = typeof pendingFirst?.resolved_at === 'string'
    && typeof pendingFirst.approval_id === 'string'
    && typeof exercisedApproval?.resolved_at === 'string'
    && exerciseApprovalRequestExpectation !== null
    && currentAuditPath === `audit/audit-${pendingFirst.resolved_at.slice(0, 7)}.jsonl`
    && currentAuditPath === `audit/audit-${exercisedApproval.resolved_at.slice(0, 7)}.jsonl`
    && isExactApprovalResolutionAuditAppend(
      beforeCurrentAuditBytes,
      firstCurrentAuditBytes,
      postExerciseCurrentAuditBytes,
      secondCurrentAuditBytes,
      {
        at: pendingFirst.resolved_at,
        sessionId: REQUIRED_FIXTURE_IDENTITIES.approvalOwnerSessionId,
        approvalId: pendingFirst.approval_id,
        subject: 'Pending read-only fixture approval',
        tool: 'fixture_read',
        resolution: 'cancelled_by_system',
        resolvedBy: 'reaper-dead-session',
      },
      exerciseApprovalRequestExpectation,
      {
        at: exercisedApproval.resolved_at,
        sessionId: exercise.coldSessionId,
        approvalId: exercise.reviewApprovalId,
        subject: 'Approve exact automation opportunity: Packaged upgrade durable project',
        tool: 'automation_opportunity_review_decision',
        resolution: 'approved',
        resolvedBy: 'human.packaged-upgrade',
      },
    );
  add('global_monthly_audit_preserves_prefix_and_appends_only_the_exact_aged_approval_resolution',
    exactApprovalAuditAppend,
    {
      path: currentAuditPath,
      beforeBytes: beforeCurrentAuditBytes?.length ?? null,
      firstBytes: firstCurrentAuditBytes?.length ?? null,
      postExerciseBytes: postExerciseCurrentAuditBytes?.length ?? null,
      secondBytes: secondCurrentAuditBytes?.length ?? null,
      approvalId: pendingFirst?.approval_id ?? null,
      resolvedAt: pendingFirst?.resolved_at ?? null,
      exerciseApproval: exercisedApproval,
      exerciseApprovalRequestEvent,
    });
  const beforeAttempt = rowByIdentity(
    before.sqlite['state/harness.db']?.identities.runAttempts,
    'attempt_id',
    REQUIRED_FIXTURE_IDENTITIES.activeAttemptId,
  );
  const firstAttempt = rowByIdentity(
    first.sqlite['state/harness.db']?.identities.runAttempts,
    'attempt_id',
    REQUIRED_FIXTURE_IDENTITIES.activeAttemptId,
  );
  const secondAttempt = rowByIdentity(
    second.sqlite['state/harness.db']?.identities.runAttempts,
    'attempt_id',
    REQUIRED_FIXTURE_IDENTITIES.activeAttemptId,
  );
  add('first_packaged_boot_interrupts_the_exact_orphan_attempt_once',
    beforeAttempt?.status === 'active'
      && beforeAttempt.finished_at === null
      && beforeAttempt.session_id === REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId
      && beforeAttempt.source_user_seq === REQUIRED_FIXTURE_IDENTITIES.activeSourceUserSeq
      && beforeAttempt.run_id === REQUIRED_FIXTURE_IDENTITIES.activeRunId
      && firstAttempt?.status === 'interrupted'
      && typeof firstAttempt.finished_at === 'string'
      && stable(firstAttempt) === stable(secondAttempt),
    { before: beforeAttempt, first: firstAttempt, second: secondAttempt });
  const beforeLease = rowByIdentity(
    before.sqlite['state/harness.db']?.identities.dispatchLeases,
    'scope_id',
    REQUIRED_FIXTURE_IDENTITIES.ambiguousWriteLeaseScopeId,
  );
  const firstLease = rowByIdentity(
    first.sqlite['state/harness.db']?.identities.dispatchLeases,
    'scope_id',
    REQUIRED_FIXTURE_IDENTITIES.ambiguousWriteLeaseScopeId,
  );
  const secondLease = rowByIdentity(
    second.sqlite['state/harness.db']?.identities.dispatchLeases,
    'scope_id',
    REQUIRED_FIXTURE_IDENTITIES.ambiguousWriteLeaseScopeId,
  );
  add('first_packaged_boot_explicitly_quarantines_the_exact_old_dispatch_lease_once',
    beforeLease?.session_id === REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId
      && beforeLease.run_attempt_id === REQUIRED_FIXTURE_IDENTITIES.activeAttemptId
      && beforeLease.revoked_at === null
      && (beforeLease.revocation_reason === null || beforeLease.revocation_reason === undefined)
      && firstLease?.session_id === beforeLease.session_id
      && firstLease.run_attempt_id === beforeLease.run_attempt_id
      && firstLease.lease_id === beforeLease.lease_id
      && typeof firstLease.revoked_at === 'string'
      && firstLease.revocation_reason === 'terminal_run_attempt_at_daemon_boot'
      && stable(firstLease) === stable(secondLease),
    { before: beforeLease, first: firstLease, second: secondLease });
  const beforeWrites = eventRows(
    before,
    REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId,
    'external_write',
  );
  const firstWrites = eventRows(
    first,
    REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId,
    'external_write',
  );
  const secondWrites = eventRows(
    second,
    REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId,
    'external_write',
  );
  const firstWriteOutcomes = [
    ...eventRows(first, REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId, 'external_write_succeeded'),
    ...eventRows(first, REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId, 'external_write_failed'),
    ...eventRows(first, REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId, 'external_write_orphaned'),
  ];
  const secondWriteOutcomes = [
    ...eventRows(second, REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId, 'external_write_succeeded'),
    ...eventRows(second, REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId, 'external_write_failed'),
    ...eventRows(second, REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId, 'external_write_orphaned'),
  ];
  const firstDecisions = eventRows(
    first,
    REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId,
    'restart_recovery_decision',
  );
  const secondDecisions = eventRows(
    second,
    REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId,
    'restart_recovery_decision',
  );
  const recoveryDecision = eventData(firstDecisions[0]);
  const firstTerminals = eventRows(
    first,
    REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId,
    'conversation_completed',
  );
  const secondTerminals = eventRows(
    second,
    REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId,
    'conversation_completed',
  );
  const recoveryTerminal = eventData(firstTerminals[0]);
  add('ambiguous_old_write_is_never_inferred_safe_or_redispatched',
    beforeWrites.length === 1
      && stable(beforeWrites) === stable(firstWrites)
      && stable(firstWrites) === stable(secondWrites)
      && firstWriteOutcomes.length === 0
      && secondWriteOutcomes.length === 0
      && (first.sqlite['state/harness.db']?.tableCounts.physical_dispatches ?? 0) === 0
      && (second.sqlite['state/harness.db']?.tableCounts.physical_dispatches ?? 0) === 0,
    {
      beforeWrites,
      firstWrites,
      secondWrites,
      firstWriteOutcomes,
      secondWriteOutcomes,
      firstPhysicalDispatches: first.sqlite['state/harness.db']?.tableCounts.physical_dispatches ?? null,
      secondPhysicalDispatches: second.sqlite['state/harness.db']?.tableCounts.physical_dispatches ?? null,
    });
  add('ambiguous_old_write_gets_one_exact_manual_restart_decision_and_terminal',
    firstDecisions.length === 1
      && secondDecisions.length === 1
      && stable(firstDecisions) === stable(secondDecisions)
      && recoveryDecision?.autoResume === false
      && recoveryDecision.autoResumeSkipped === 'external_write'
      && recoveryDecision.externalWritesSinceInterrupt === 1
      && recoveryDecision.interruptedAttemptId === REQUIRED_FIXTURE_IDENTITIES.activeAttemptId
      && recoveryDecision.interruptedRunId === REQUIRED_FIXTURE_IDENTITIES.activeRunId
      && firstTerminals.length === 1
      && secondTerminals.length === 1
      && stable(firstTerminals) === stable(secondTerminals)
      && recoveryTerminal?.sourceUserSeq === REQUIRED_FIXTURE_IDENTITIES.activeSourceUserSeq
      && eventRows(first, REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId, 'run_resumed').length === 0
      && eventRows(second, REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId, 'run_resumed').length === 0,
    {
      decisions: firstDecisions,
      terminals: firstTerminals,
      recoveryDecision,
      recoveryTerminal,
    });
  const beforeTriggerEvent = before.carriers.triggerEvents.find((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const row = entry as Record<string, Json>;
    return row.state === 'pending' && row.run_id === null;
  }) as Record<string, Json> | undefined;
  const beforeEventTrigger = (
    before.sqlite['state/workflow-triggers.db']?.identities.workflowTriggers ?? []
  ).find((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const row = entry as Record<string, Json>;
    return row.workflow_name === REQUIRED_FIXTURE_IDENTITIES.workflowName
      && row.kind === 'system_event'
      && row.event_type === 'upgrade.rehearsal.never-fired';
  }) as Record<string, Json> | undefined;
  const expectedTriggerPayload = {
    fixture: true,
    id: REQUIRED_FIXTURE_IDENTITIES.triggerOccurrenceId,
    fixtureId: 'fixture-item-v314',
  };
  const beforeTriggerPayload = jsonRecord(beforeTriggerEvent?.payload_json ?? null);
  const firstTriggerEvent = rowByIdentity(
    first.carriers.triggerEvents,
    'id',
    beforeTriggerEvent?.id ?? null,
  );
  const secondTriggerEvent = rowByIdentity(
    second.carriers.triggerEvents,
    'id',
    beforeTriggerEvent?.id ?? null,
  );
  const beforeScheduleRun = runForReceipt(before, REQUIRED_FIXTURE_IDENTITIES.scheduleReceiptId);
  const beforeEventRun = runForReceipt(before, beforeTriggerEvent?.id ?? null);
  const firstScheduleRun = runForReceipt(first, REQUIRED_FIXTURE_IDENTITIES.scheduleReceiptId);
  const firstEventRun = runForReceipt(first, beforeTriggerEvent?.id ?? null);
  const secondScheduleRun = runForReceipt(second, REQUIRED_FIXTURE_IDENTITIES.scheduleReceiptId);
  const secondEventRun = runForReceipt(second, beforeTriggerEvent?.id ?? null);
  const beforeScheduleAcceptance = acceptanceForReceipt(before, REQUIRED_FIXTURE_IDENTITIES.scheduleReceiptId);
  const beforeEventAcceptance = acceptanceForReceipt(before, beforeTriggerEvent?.id ?? null);
  const firstScheduleAcceptance = acceptanceForReceipt(first, REQUIRED_FIXTURE_IDENTITIES.scheduleReceiptId);
  const firstEventAcceptance = acceptanceForReceipt(first, beforeTriggerEvent?.id ?? null);
  const secondScheduleAcceptance = acceptanceForReceipt(second, REQUIRED_FIXTURE_IDENTITIES.scheduleReceiptId);
  const secondEventAcceptance = acceptanceForReceipt(second, beforeTriggerEvent?.id ?? null);
  const exerciseWorkflowNotifications = notificationRows(postExercise, (notification) => {
    const metadata = notification.metadata;
    return notification.kind === 'workflow'
      && typeof notification.body === 'string'
      && metadata !== null
      && typeof metadata === 'object'
      && !Array.isArray(metadata)
      && (metadata as Record<string, Json>).runId === exercise.workflowRunId;
  });
  const exerciseOutputPreview = exerciseWorkflowNotifications.length === 1
    && typeof exerciseWorkflowNotifications[0]?.body === 'string'
    ? exerciseWorkflowNotifications[0].body.slice(0, 800)
    : '';
  const exactRecoveredWorkflowRuns = !(workflowActivityPath in before.allNonSqliteFiles)
    && beforeWorkflowActivityRuns === null
    && firstWorkflowActivityRuns !== null
    && postExerciseWorkflowActivityRuns !== null
    && secondWorkflowActivityRuns !== null
    && isExactRecoveredWorkflowRunProjection(
      firstWorkflowActivityRuns,
      postExerciseWorkflowActivityRuns,
      secondWorkflowActivityRuns,
      {
        workflowName: REQUIRED_FIXTURE_IDENTITIES.workflowName,
        recoveredRunIds: [
          typeof beforeScheduleRun?.id === 'string' ? beforeScheduleRun.id : '',
          typeof beforeEventRun?.id === 'string' ? beforeEventRun.id : '',
        ],
        exerciseRunId: exercise.workflowRunId,
        exerciseOutputPreview,
      },
    );
  add('state_runs_is_only_the_exact_recovered_projection_then_one_exercised_run',
    exactRecoveredWorkflowRuns,
    {
      before: beforeWorkflowActivityRuns,
      first: firstWorkflowActivityRuns,
      postExercise: postExerciseWorkflowActivityRuns,
      second: secondWorkflowActivityRuns,
      expectedRecoveredRunIds: [beforeScheduleRun?.id ?? null, beforeEventRun?.id ?? null],
      expectedExerciseRunId: exercise.workflowRunId,
      expectedExerciseOutputPreview: exerciseOutputPreview,
      exerciseWorkflowNotifications,
    });
  const exactStarterWorkspaceOffer = !(starterWorkspaceOfferPath in before.allNonSqliteFiles)
    && beforeStarterWorkspaceOffer === null
    && isExactStarterWorkspaceOfferSeed(
      firstStarterWorkspaceOffer,
      postExerciseStarterWorkspaceOffer,
      secondStarterWorkspaceOffer,
    );
  add('starter_workspace_offer_is_one_exact_existing_workspace_seed_and_boot_stable',
    exactStarterWorkspaceOffer,
    {
      before: beforeStarterWorkspaceOffer,
      first: firstStarterWorkspaceOffer,
      postExercise: postExerciseStarterWorkspaceOffer,
      second: secondStarterWorkspaceOffer,
    });
  const firstBootMutableLegacyFiles = new Set<string>([
    'cron/daemon-state.json',
    'cron/workflow-schedule-state.json',
    'state/approvals.json',
    'state/notification-delivery-queue.json',
    'state/notifications.json',
    // This is not a pathname allowlist: the only changed global audit carrier
    // is excluded after (and only after) its exact one-row append proof passes.
    ...(exactApprovalAuditAppend ? [currentAuditPath] : []),
    ...before.carriers.workflowRuns.flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const file = (entry as Record<string, Json>).file;
      return typeof file === 'string' ? [file] : [];
    }),
  ]);
  const preservedLegacyFiles = preservedPreexistingFiles(before, first, firstBootMutableLegacyFiles);
  add('first_packaged_boot_preserves_every_preexisting_non_sqlite_file_outside_named_recovery_owners',
    preservedLegacyFiles.ok,
    {
      ...preservedLegacyFiles,
      allowedMutable: [...firstBootMutableLegacyFiles].sort(),
      exactAuditAppendVerified: exactApprovalAuditAppend ? currentAuditPath : null,
    });
  const recoveryEventFiles = new Set<string>(
    [beforeScheduleRun, beforeEventRun].flatMap((run) => {
      const runId = typeof run?.id === 'string' ? run.id : '';
      return runId
        ? [`vault/00-System/workflows/${REQUIRED_FIXTURE_IDENTITIES.workflowName}/runs/${runId}/events.jsonl`]
        : [];
    }),
  );
  const expectedRecoveryAddedFiles = [
    'cron/daemon-state.json',
    'state/notification-delivery-queue.json',
    workflowActivityPath,
    ...recoveryEventFiles,
  ].filter((relativePath) => !(relativePath in before.allNonSqliteFiles)).sort();
  const firstBootAdded = addedFilesByCategory(before, first, recoveryEventFiles, {
    recoveredWorkflowRuns: exactRecoveredWorkflowRuns,
    starterWorkspaceOffer: exactStarterWorkspaceOffer,
  });
  const canonicalMigrationSeed =
    `memory/tool-procedures/${V314_GATE_MACHINE_ID}/.canonical-procedure-migration-v1.json`;
  const expectedDeterministicSeedFiles = [
    ...CHECK_IN_SEED_IDS.map((id) => `state/check-in-templates/${id}.json`),
    starterWorkspaceOfferPath,
    'vault/00-System/workflows/objective-execution-loop/SKILL.md',
    'vault/00-System/workflows/objective-execution-loop/references/operating-principles.md',
    canonicalMigrationSeed,
    ...BUILTIN_SKILL_SEED_IDS.map((id) => `skills/${id}/SKILL.md`),
  ].sort();
  add('first_packaged_boot_added_files_are_closed_causal_categories_with_exact_seed_semantics',
    firstBootAdded.unexpected.length === 0
      && firstBootAdded.ephemeral_process_owner.length === 0
      && stable(firstBootAdded.recovery_projection) === stable(expectedRecoveryAddedFiles)
      && stable(firstBootAdded.scheduler_observation) === stable(['state/space-schedule-state.json'])
      && stable(firstBootAdded.deterministic_boot_seed) === stable(expectedDeterministicSeedFiles)
      && expectedDeterministicSeedFiles.every((relativePath) =>
        validDeterministicBootSeed(daemonHome, relativePath))
      && validEmptySpaceScheduleObservation(firstSpaceScheduleObservation)
      && expectedDeterministicSeedFiles.every((relativePath) =>
        first.allNonSqliteFiles[relativePath] === postExercise.allNonSqliteFiles[relativePath]
        && postExercise.allNonSqliteFiles[relativePath] === second.allNonSqliteFiles[relativePath]), {
    categories: firstBootAdded,
    expected: {
      recovery: expectedRecoveryAddedFiles,
      deterministicSeeds: expectedDeterministicSeedFiles,
      schedulerObservation: ['state/space-schedule-state.json'],
      ephemeralProcessOwners: [],
    },
  });
  add('first_packaged_boot_recovers_the_exact_trigger_queue_crash_without_rebinding',
    before.carriers.triggerEvents.length === 1
      && beforeTriggerEvent?.state === 'pending'
      && beforeTriggerEvent.run_id === null
      && beforeTriggerEvent.deduped === 0
      && beforeTriggerEvent.attempt_count === 0
      && beforeTriggerEvent.last_attempt_at === null
      && beforeTriggerEvent.next_attempt_at === null
      && beforeTriggerEvent.last_error === null
      && beforeTriggerEvent.claim_token === null
      && beforeTriggerEvent.claim_expires_at === null
      && beforeTriggerEvent.enqueued_at === null
      && beforeTriggerEvent.trigger_id === beforeEventTrigger?.id
      && beforeTriggerEvent.dedupe_key === `fixture-${REQUIRED_FIXTURE_IDENTITIES.triggerOccurrenceId}`
      && beforeTriggerEvent.trigger_generation === beforeEventTrigger?.generation
      && stable(beforeTriggerPayload) === stable(expectedTriggerPayload)
      && beforeTriggerEvent.payload_hash === sha256(stable(expectedTriggerPayload))
      && first.carriers.triggerEvents.length === 1
      && firstTriggerEvent?.state === 'enqueued'
      && firstTriggerEvent.deduped === 0
      && firstTriggerEvent.attempt_count === 0
      && firstTriggerEvent.last_attempt_at === null
      && firstTriggerEvent.next_attempt_at === null
      && firstTriggerEvent.last_error === null
      && firstTriggerEvent.claim_token === null
      && firstTriggerEvent.claim_expires_at === null
      && typeof firstTriggerEvent.enqueued_at === 'string'
      && typeof firstTriggerEvent.updated_at === 'string'
      && firstTriggerEvent.run_id === beforeEventRun?.id
      && stable(firstTriggerEvent) === stable(secondTriggerEvent)
      && beforeScheduleAcceptance?.runId === beforeScheduleRun?.id
      && beforeEventAcceptance?.runId === beforeEventRun?.id
      && stable(beforeScheduleAcceptance) === stable(firstScheduleAcceptance)
      && stable(firstScheduleAcceptance) === stable(secondScheduleAcceptance)
      && stable(beforeEventAcceptance) === stable(firstEventAcceptance)
      && stable(firstEventAcceptance) === stable(secondEventAcceptance),
    {
      triggerEvent: { before: beforeTriggerEvent ?? null, first: firstTriggerEvent, second: secondTriggerEvent },
      scheduleAcceptance: { before: beforeScheduleAcceptance, first: firstScheduleAcceptance, second: secondScheduleAcceptance },
      eventAcceptance: { before: beforeEventAcceptance, first: firstEventAcceptance, second: secondEventAcceptance },
    });
  const disabledRun = (run: Record<string, Json> | null, beforeRun: Record<string, Json> | null): boolean =>
    run?.id === beforeRun?.id
      && run?.workflow === beforeRun?.workflow
      && run?.workflowSlug === beforeRun?.workflowSlug
      && stable(run?.inputs ?? null) === stable(beforeRun?.inputs ?? null)
      && run?.source === beforeRun?.source
      && run?.createdAt === beforeRun?.createdAt
      && run?.workflowDefinitionSnapshotDigest === beforeRun?.workflowDefinitionSnapshotDigest
      && run?.triggerReceiptId === beforeRun?.triggerReceiptId
      && run?.status === 'error'
      && typeof run?.finishedAt === 'string'
      && typeof run?.error === 'string'
      && /workflow .* is disabled/i.test(run.error);
  const runEventProjection = (inspection: HomeInspection, runId: Json): Record<string, Json> | null => {
    if (typeof runId !== 'string') return null;
    const expectedFile = `vault/00-System/workflows/${REQUIRED_FIXTURE_IDENTITIES.workflowName}/runs/${runId}/events.jsonl`;
    return (inspection.carriers.workflowRunEvents ?? []).flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const row = entry as Record<string, Json>;
      return row.file === expectedFile ? [row] : [];
    }).at(0) ?? null;
  };
  const exactDisabledRunEvent = (
    projection: Record<string, Json> | null,
    run: Record<string, Json> | null,
  ): boolean => {
    if (!projection || !Array.isArray(projection.events) || projection.events.length !== 1) return false;
    const event = projection.events[0];
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    const row = event as Record<string, Json>;
    return row.kind === 'run_failed'
      && row.error === run?.error
      && typeof row.t === 'string'
      && Number.isFinite(Date.parse(row.t));
  };
  const firstScheduleEvents = runEventProjection(first, beforeScheduleRun?.id ?? null);
  const firstEventEvents = runEventProjection(first, beforeEventRun?.id ?? null);
  const secondScheduleEvents = runEventProjection(second, beforeScheduleRun?.id ?? null);
  const secondEventEvents = runEventProjection(second, beforeEventRun?.id ?? null);
  add('first_packaged_boot_quarantines_both_old_queued_runs_once_without_body_execution',
    beforeScheduleRun?.status === 'queued'
      && beforeEventRun?.status === 'queued'
      && beforeScheduleRun.id !== beforeEventRun.id
      && disabledRun(firstScheduleRun, beforeScheduleRun)
      && disabledRun(firstEventRun, beforeEventRun)
      && exactDisabledRunEvent(firstScheduleEvents, firstScheduleRun)
      && exactDisabledRunEvent(firstEventEvents, firstEventRun)
      && stable(firstScheduleEvents) === stable(secondScheduleEvents)
      && stable(firstEventEvents) === stable(secondEventEvents)
      && stable(firstScheduleRun) === stable(secondScheduleRun)
      && stable(firstEventRun) === stable(secondEventRun),
    {
      schedule: { before: beforeScheduleRun, first: firstScheduleRun, second: secondScheduleRun },
      event: { before: beforeEventRun, first: firstEventRun, second: secondEventRun },
      eventLogs: {
        schedule: { first: firstScheduleEvents, second: secondScheduleEvents },
        event: { first: firstEventEvents, second: secondEventEvents },
      },
    });
  const interruptionNotifications = (inspection: HomeInspection): Record<string, Json>[] =>
    notificationRows(inspection, (notification) => {
      const metadata = notification.metadata;
      return notification.kind === 'system'
        && notification.title === 'A chat task was interrupted by a restart'
        && metadata !== null
        && typeof metadata === 'object'
        && !Array.isArray(metadata)
        && (metadata as Record<string, Json>).sessionId === REQUIRED_FIXTURE_IDENTITIES.activeAttemptSessionId
        && (metadata as Record<string, Json>).reason === 'interrupted_by_restart';
    });
  const workflowFailureNotifications = (inspection: HomeInspection): Record<string, Json>[] => {
    const expectedRunIds = new Set([beforeScheduleRun?.id, beforeEventRun?.id]);
    return notificationRows(inspection, (notification) => {
      const metadata = notification.metadata;
      if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
      const runId = (metadata as Record<string, Json>).runId;
      return typeof runId === 'string'
        && notification.id === `workflow-${runId}-disabled`
        && notification.kind === 'workflow'
        && notification.title === `Workflow not run: ${REQUIRED_FIXTURE_IDENTITIES.workflowName}`
        && typeof metadata === 'object'
        && expectedRunIds.has(runId)
        && stable(metadata) === stable({
          workflow: REQUIRED_FIXTURE_IDENTITIES.workflowName,
          runId,
        });
    });
  };
  const firstApproval = rowByIdentity(
    first.sqlite['state/harness.db']?.identities.pendingApprovals,
    'session_id',
    REQUIRED_FIXTURE_IDENTITIES.approvalOwnerSessionId,
  );
  const secondApproval = rowByIdentity(
    second.sqlite['state/harness.db']?.identities.pendingApprovals,
    'session_id',
    REQUIRED_FIXTURE_IDENTITIES.approvalOwnerSessionId,
  );
  const beforeApprovalOwnerSession = rowByIdentity(
    before.sqlite['state/harness.db']?.identities.sessions,
    'id',
    REQUIRED_FIXTURE_IDENTITIES.approvalOwnerSessionId,
  );
  const firstApprovalOwnerSession = rowByIdentity(
    first.sqlite['state/harness.db']?.identities.sessions,
    'id',
    REQUIRED_FIXTURE_IDENTITIES.approvalOwnerSessionId,
  );
  const secondApprovalOwnerSession = rowByIdentity(
    second.sqlite['state/harness.db']?.identities.sessions,
    'id',
    REQUIRED_FIXTURE_IDENTITIES.approvalOwnerSessionId,
  );
  const firstRepresentativeSession = rowByIdentity(
    first.sqlite['state/harness.db']?.identities.sessions,
    'id',
    REQUIRED_FIXTURE_IDENTITIES.sessionId,
  );
  const secondRepresentativeSession = rowByIdentity(
    second.sqlite['state/harness.db']?.identities.sessions,
    'id',
    REQUIRED_FIXTURE_IDENTITIES.sessionId,
  );
  const approvalQuarantineNotifications = (
    inspection: HomeInspection,
    approvalId: Json,
  ): Record<string, Json>[] => notificationRows(inspection, (notification) => {
    const metadata = notification.metadata;
    return typeof approvalId === 'string'
      && notification.id === `approval-system-cancelled-${approvalId}`
      && notification.kind === 'system'
      && notification.title === 'Approval closed with its ended session'
      && metadata !== null
      && typeof metadata === 'object'
      && !Array.isArray(metadata)
      && stable(metadata) === stable({
        approvalId,
        sessionId: REQUIRED_FIXTURE_IDENTITIES.approvalOwnerSessionId,
        subject: 'Pending read-only fixture approval',
        tool: 'fixture_read',
        approvalStatus: 'cancelled',
        approvalResolution: 'cancelled_by_system',
        recommendedAction: 'start_new_request',
      });
  });
  const firstInterruptionNotifications = interruptionNotifications(first);
  const secondInterruptionNotifications = interruptionNotifications(second);
  const firstWorkflowFailureNotifications = workflowFailureNotifications(first);
  const secondWorkflowFailureNotifications = workflowFailureNotifications(second);
  const firstApprovalNotifications = approvalQuarantineNotifications(first, firstApproval?.approval_id ?? null);
  const secondApprovalNotifications = approvalQuarantineNotifications(second, secondApproval?.approval_id ?? null);
  const interruptCleanupFailureNotifications = (inspection: HomeInspection): Record<string, Json>[] =>
    notificationRows(inspection, (notification) =>
      typeof notification.id === 'string'
      && notification.id.startsWith('interrupt-clear-failed-'));
  add('first_packaged_boot_emits_each_expected_quarantine_notification_once',
    firstInterruptionNotifications.length === 1
      && stable(firstInterruptionNotifications) === stable(secondInterruptionNotifications)
      && firstWorkflowFailureNotifications.length === 2
      && stable(firstWorkflowFailureNotifications) === stable(secondWorkflowFailureNotifications)
      && firstApproval?.status === 'cancelled'
      && firstApproval.resolution === 'cancelled_by_system'
      && stable(firstApproval) === stable(secondApproval)
      && beforeApprovalOwnerSession?.status === 'completed'
      && firstApprovalOwnerSession?.status === 'cancelled'
      && stable(firstApprovalOwnerSession) === stable(secondApprovalOwnerSession)
      && firstRepresentativeSession?.status === 'completed'
      && stable(firstRepresentativeSession) === stable(secondRepresentativeSession)
      && interruptCleanupFailureNotifications(first).length === 0
      && interruptCleanupFailureNotifications(second).length === 0
      && firstApprovalNotifications.length === 1
      && stable(firstApprovalNotifications) === stable(secondApprovalNotifications),
    {
      interruption: { first: firstInterruptionNotifications, second: secondInterruptionNotifications },
      workflow: { first: firstWorkflowFailureNotifications, second: secondWorkflowFailureNotifications },
      approval: {
        row: { first: firstApproval, second: secondApproval },
        ownerSession: {
          before: beforeApprovalOwnerSession,
          first: firstApprovalOwnerSession,
          second: secondApprovalOwnerSession,
        },
        representativeSession: { first: firstRepresentativeSession, second: secondRepresentativeSession },
        interruptCleanupFailures: {
          first: interruptCleanupFailureNotifications(first),
          second: interruptCleanupFailureNotifications(second),
        },
        notifications: { first: firstApprovalNotifications, second: secondApprovalNotifications },
      },
    });
  const workflowTriggerRows = (inspection: HomeInspection): Record<string, Json>[] =>
    (inspection.sqlite['state/workflow-triggers.db']?.identities.workflowTriggers ?? []).flatMap((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const row = entry as Record<string, Json>;
      return row.workflow_name === REQUIRED_FIXTURE_IDENTITIES.workflowName ? [row] : [];
    });
  const beforeTriggers = workflowTriggerRows(before);
  const firstTriggers = workflowTriggerRows(first);
  const secondTriggers = workflowTriggerRows(second);
  // v3.14's registry owns only webhook/system-event subscriptions. Schedule
  // occurrence authority is the separate queue+receipt proof above; inventing
  // a schedule registry row here would validate a topology the release never
  // produced.
  const exactTriggerTopology = isExactV314TriggerRegistry(beforeTriggers);
  const triggerReconciled = exactTriggerTopology
    && beforeTriggers.length === firstTriggers.length
    && firstTriggers.length === secondTriggers.length
    && beforeTriggers.every((beforeTrigger) => {
      const firstTrigger = rowByIdentity(firstTriggers, 'id', beforeTrigger.id);
      const secondTrigger = rowByIdentity(secondTriggers, 'id', beforeTrigger.id);
      return beforeTrigger.enabled === 1
        && Number.isSafeInteger(beforeTrigger.generation)
        && firstTrigger?.workflow_name === beforeTrigger.workflow_name
        && firstTrigger.kind === beforeTrigger.kind
        && firstTrigger.schedule === beforeTrigger.schedule
        && firstTrigger.timezone === beforeTrigger.timezone
        && firstTrigger.webhook_path === beforeTrigger.webhook_path
        && firstTrigger.event_type === beforeTrigger.event_type
        && firstTrigger.enabled === 0
        && firstTrigger.generation === Number(beforeTrigger.generation) + 1
        && stable(firstTrigger) === stable(secondTrigger);
    });
  add('first_packaged_boot_reconciles_the_single_event_trigger_once_while_schedule_proof_stays_separate',
    triggerReconciled,
    { before: beforeTriggers, first: firstTriggers, second: secondTriggers });
  add('first_daemon_boot_does_not_replay_model_provider_business_or_local_body_work',
    firstBootWorkDelta.total === 0, firstBootWorkDelta);
  add('installed_candidate_reads_old_conversation_space_and_workflow_then_creates_new_cold_turn_run_and_approved_project',
    exercise.oldSessionId === REQUIRED_FIXTURE_IDENTITIES.sessionId
      && exercise.oldWorkflowName === REQUIRED_FIXTURE_IDENTITIES.workflowName
      && exercise.oldSpaceId === REQUIRED_FIXTURE_IDENTITIES.workspaceId
      && exercise.workflowRunStatus === 'completed'
      && exercise.proposalRevision === 3
      && exercise.modelRequests.length >= 2
      && exerciseWorkDelta.total > 0,
    { exercise, exerciseWorkDelta });
  const postExerciseHarness = postExercise.sqlite['state/harness.db']?.identities ?? {};
  const secondHarness = second.sqlite['state/harness.db']?.identities ?? {};
  const postExerciseProposalStore =
    postExercise.sqlite[AUTOMATION_OPPORTUNITY_PROPOSAL_DB]?.identities ?? {};
  const secondProposalStore = second.sqlite[AUTOMATION_OPPORTUNITY_PROPOSAL_DB]?.identities ?? {};
  const exercisedProposal = rowByIdentity(
    postExerciseProposalStore.automationOpportunityProposals,
    'proposal_id',
    exercise.proposalId,
  );
  const secondProposal = rowByIdentity(
    secondProposalStore.automationOpportunityProposals,
    'proposal_id',
    exercise.proposalId,
  );
  const exercisedReview = rowByIdentity(
    postExerciseHarness.automationOpportunityReviews,
    'projection_id',
    exercise.reviewProjectionId,
  );
  const secondReview = rowByIdentity(
    secondHarness.automationOpportunityReviews,
    'projection_id',
    exercise.reviewProjectionId,
  );
  const exercisedAdvancement = rowByIdentity(
    postExerciseHarness.automationPilotAdvancements,
    'advancement_id',
    exercise.advancementId,
  );
  const secondAdvancement = rowByIdentity(
    secondHarness.automationPilotAdvancements,
    'advancement_id',
    exercise.advancementId,
  );
  const exercisedAdvancementState = jsonRecord(exercisedAdvancement?.state_json ?? null);
  const secondAdvancementState = jsonRecord(secondAdvancement?.state_json ?? null);
  const exercisedAdvancementBlocked = exercisedAdvancementState?.blocked;
  const blockedRecord = exercisedAdvancementBlocked
    && typeof exercisedAdvancementBlocked === 'object'
    && !Array.isArray(exercisedAdvancementBlocked)
    ? exercisedAdvancementBlocked as Record<string, Json>
    : null;
  add('approved_project_review_and_blocked_acquisition_are_an_exact_second_boot_fixed_point',
    Boolean(postExercise.sqlite[AUTOMATION_OPPORTUNITY_PROPOSAL_DB])
      && Boolean(postExercise.sqlite[HARNESS_DB])
      && exercisedProposal?.status === 'approved'
      && exercisedProposal.revision === exercise.proposalRevision
      && exercisedProposal.digest === exercise.proposalDigest
      && exercisedReview?.proposal_id === exercise.proposalId
      && exercisedReview.status === 'approved'
      && exercisedReview.approval_id === exercise.reviewApprovalId
      && exercisedReview.proposal_digest === exercise.proposalDigest
      && exercisedAdvancement?.proposal_id === exercise.proposalId
      && exercisedAdvancement.review_projection_id === exercise.reviewProjectionId
      && exercisedAdvancement.stage === exercise.advancementStage
      && exercisedAdvancement.state_revision === exercise.advancementStateRevision
      && exercisedAdvancement.state_digest === exercise.advancementStateDigest
      && exercisedAdvancement.owner_session_id === exercise.coldSessionId
      && exercisedAdvancement.source_user_seq === exercise.coldSourceUserSeq
      && exercisedAdvancementState?.reviewApprovalId === exercise.reviewApprovalId
      && exercisedAdvancementState.reviewProjectionId === exercise.reviewProjectionId
      && exercisedAdvancementState.proposalRevision === exercise.proposalRevision
      && exercisedAdvancementState.proposalDigest === exercise.proposalDigest
      && blockedRecord?.code === exercise.advancementBlockedCode
      && blockedRecord.detail === exercise.advancementBlockedDetail
      && stable(exercisedAdvancementState) === stable(secondAdvancementState)
      && stable(exercisedProposal) === stable(secondProposal)
      && stable(exercisedReview) === stable(secondReview)
      && stable(exercisedAdvancement) === stable(secondAdvancement),
    {
      postExercise: {
        proposal: exercisedProposal,
        review: exercisedReview,
        advancement: exercisedAdvancement,
      },
      second: {
        proposal: secondProposal,
        review: secondReview,
        advancement: secondAdvancement,
      },
    });
  add('second_daemon_boot_performs_zero_repeated_model_provider_business_or_local_body_work',
    secondBootWorkDelta.total === 0, secondBootWorkDelta);
  const firstScheduleWatermark = firstScheduleObservation?.lastEvaluatedAtMs;
  const postScheduleWatermark = postExerciseScheduleObservation?.lastEvaluatedAtMs;
  const secondScheduleWatermark = secondScheduleObservation?.lastEvaluatedAtMs;
  const firstSpaceScheduleWatermark = firstSpaceScheduleObservation?.lastEvaluatedAtMs;
  const postSpaceScheduleWatermark = postExerciseSpaceScheduleObservation?.lastEvaluatedAtMs;
  const secondSpaceScheduleWatermark = secondSpaceScheduleObservation?.lastEvaluatedAtMs;
  const firstHealthyAt = firstDaemonObservation?.lastHealthyTickAt;
  const postHealthyAt = postExerciseDaemonObservation?.lastHealthyTickAt;
  const secondHealthyAt = secondDaemonObservation?.lastHealthyTickAt;
  const firstCronWatermark = firstDaemonObservation?.lastCronEvaluatedAtMs;
  const postCronWatermark = postExerciseDaemonObservation?.lastCronEvaluatedAtMs;
  const secondCronWatermark = secondDaemonObservation?.lastCronEvaluatedAtMs;
  const finiteNonnegative = (value: Json | undefined): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const validIso = (value: Json | undefined): value is string =>
    typeof value === 'string' && Number.isFinite(Date.parse(value));
  add('normalized_daemon_workflow_and_space_schedule_observations_are_well_formed_and_monotonic',
    finiteNonnegative(firstScheduleWatermark)
      && finiteNonnegative(postScheduleWatermark)
      && finiteNonnegative(secondScheduleWatermark)
      && firstScheduleWatermark === postScheduleWatermark
      && secondScheduleWatermark >= postScheduleWatermark
      && finiteNonnegative(firstSpaceScheduleWatermark)
      && finiteNonnegative(postSpaceScheduleWatermark)
      && finiteNonnegative(secondSpaceScheduleWatermark)
      && firstSpaceScheduleWatermark === postSpaceScheduleWatermark
      && secondSpaceScheduleWatermark >= postSpaceScheduleWatermark
      && validEmptySpaceScheduleObservation(firstSpaceScheduleObservation)
      && validEmptySpaceScheduleObservation(postExerciseSpaceScheduleObservation)
      && validEmptySpaceScheduleObservation(secondSpaceScheduleObservation)
      && validIso(firstHealthyAt)
      && validIso(postHealthyAt)
      && validIso(secondHealthyAt)
      && firstHealthyAt === postHealthyAt
      && Date.parse(secondHealthyAt) >= Date.parse(postHealthyAt)
      && finiteNonnegative(firstCronWatermark)
      && finiteNonnegative(postCronWatermark)
      && finiteNonnegative(secondCronWatermark)
      && firstCronWatermark === postCronWatermark
      && secondCronWatermark >= postCronWatermark,
    {
      schedule: {
        workflow: {
          first: firstScheduleWatermark ?? null,
          postExercise: postScheduleWatermark ?? null,
          second: secondScheduleWatermark ?? null,
        },
        space: {
          first: firstSpaceScheduleWatermark ?? null,
          postExercise: postSpaceScheduleWatermark ?? null,
          second: secondSpaceScheduleWatermark ?? null,
        },
      },
      daemon: {
        healthy: { first: firstHealthyAt ?? null, postExercise: postHealthyAt ?? null, second: secondHealthyAt ?? null },
        cron: { first: firstCronWatermark ?? null, postExercise: postCronWatermark ?? null, second: secondCronWatermark ?? null },
      },
    });
  add('second_daemon_boot_is_durably_state_idempotent_after_the_installed_exercise',
    postExerciseStateDigest === secondBootStateDigest
      && noStateDifference(secondBootLogicalStateDiff), {
    firstBootStateDigest,
    postExerciseStateDigest,
    secondBootStateDigest,
    rawStateDigests: { postExerciseRawStateDigest, secondBootRawStateDigest },
    rawDifference: secondBootRawStateDiff,
    logicalDifference: secondBootLogicalStateDiff,
    observationNormalizations: [
      'cron/workflow-schedule-state.json:lastEvaluatedAtMs',
      'cron/daemon-state.json:lastHealthyTickAt',
      'cron/daemon-state.json:lastCronEvaluatedAtMs',
      'state/space-schedule-state.json:lastEvaluatedAtMs',
    ],
  });
  add('second_daemon_boot_does_not_duplicate_notifications_or_trigger_runs',
    postExercise.carriers.notifications.length === second.carriers.notifications.length
      && postExercise.carriers.notificationQueue.length === second.carriers.notificationQueue.length
      && postExercise.carriers.triggerEvents.length === second.carriers.triggerEvents.length
      && postExercise.carriers.workflowRunFiles.length === second.carriers.workflowRunFiles.length,
    {
      postExercise: {
        notifications: postExercise.carriers.notifications.length,
        queue: postExercise.carriers.notificationQueue.length,
        triggerEvents: postExercise.carriers.triggerEvents.length,
        workflowRuns: postExercise.carriers.workflowRunFiles.length,
      },
      second: {
        notifications: second.carriers.notifications.length,
        queue: second.carriers.notificationQueue.length,
        triggerEvents: second.carriers.triggerEvents.length,
        workflowRuns: second.carriers.workflowRunFiles.length,
      },
    });
  const finalCandidate = currentCandidateIdentity();
  add('candidate_commit_and_runtime_fingerprint_remain_exact_after_the_rehearsal',
    stable(finalCandidate) === stable(candidate), { initial: candidate, final: finalCandidate });
  const reportPath = path.join(rehearsalRoot, 'packaged-daemon-upgrade-report.json');
  const report: PackagedV314DaemonRehearsalReport = {
    ok: checks.every((check) => check.ok),
    paths: {
      rehearsalRoot,
      immutableSnapshot: base.paths.immutableSnapshot,
      daemonHome,
      tarball,
      packageEntry,
      exerciseFixture,
      hermeticRuntimePath,
      report: reportPath,
    },
    candidate: {
      ...candidate,
      tarballSha256: sha256(readFileSync(tarball)),
    },
    boots: [firstProcess, secondProcess],
    exercise,
    firstBootWorkDelta,
    exerciseWorkDelta,
    secondBootWorkDelta,
    firstBootStateDigest,
    postExerciseStateDigest,
    secondBootStateDigest,
    postExerciseRawStateDigest,
    secondBootRawStateDigest,
    secondBootRawStateDiff,
    secondBootLogicalStateDiff,
    checks,
    limitations: [
      'The legacy home is the exact-tag, public-API, sanitized representative fixture; it is not a clone of a production home with historical corruption, partial writes, or machine-specific credentials.',
      'External channels, connected-provider credentials, model warmup, MCP warmup, and CLI warmup are absent. The fixture does admit and reconcile one exact cron occurrence, but the installed exercise uses only a loopback OpenAI-compatible fixture model, so separate live-provider and live-scheduler canaries remain required.',
    ],
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  if (options.keep === false) {
    assertDisposable(rehearsalRoot, 'packaged daemon cleanup root');
    rmSync(rehearsalRoot, { recursive: true, force: true });
  }
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--rehearsal-root');
  const requestedRoot = rootIndex >= 0 ? args[rootIndex + 1] : undefined;
  if (rootIndex >= 0 && !requestedRoot) throw new Error('--rehearsal-root requires a path below the OS temp directory');
  const report = await runPackagedV314DaemonRehearsal({ rehearsalRoot: requestedRoot, keep: true });
  if (args.includes('--json')) console.log(JSON.stringify(report));
  else {
    const passed = report.checks.filter((check) => check.ok).length;
    console.log(`${report.ok ? 'PASS' : 'FAIL'} packaged v3.14 daemon recovery (${passed}/${report.checks.length} checks)`);
    for (const check of report.checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
    console.log(`Report: ${report.paths.report}`);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(scriptFile).href) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
