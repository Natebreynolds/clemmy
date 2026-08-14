/**
 * Proof-harness provisioning: boot one real daemon per brain against an
 * ISOLATED CLEMENTINE_HOME.
 *
 * Isolation contract (BINDING): the spawned daemon's BASE_DIR and HOME are the
 * same mkdtemp — memory.db / harness.db / state and every CLI config lookup live
 * there. Only provider credentials positively required by the selected proof
 * leg are reduced to non-refreshable snapshots in isolated state; no real-home
 * CLI config (Railway, Composio, etc.) is visible.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

import type {
  BrainKind,
  BrainPlan,
  Check,
  DaemonHandle,
  DaemonStopResult,
  FusionProofMode,
  ProofModelExpectation,
  ProofModelProvider,
  TurnResult,
} from './types.js';
import { PROOF_CLIENT_COMPLETION_TIMEOUT_MS } from './timeouts.js';
import { seedIsolatedClaudeAccess } from '../lib/isolated-claude-auth.js';
import {
  inspectIsolatedCodexAccess,
  PROOF_CODEX_MIN_VALIDITY_MS,
  seedIsolatedCodexAccess,
  type IsolatedCodexSeed,
} from '../lib/isolated-codex-auth.js';
import { presentationEventFromCompletionData } from '../../src/runtime/harness/turn-outcome.js';
import {
  assertProofHomeIdentity,
  assertProofTempCapacity,
  awaitProofChildOutputDrain,
  BoundedProofLogCapture,
  captureProofHomeIdentity,
  captureProofStateIdentity,
  createProofForensicReserve,
  persistProofDaemonLogForForensics,
  PROOF_CHILD_OUTPUT_DRAIN_TIMEOUT_MS,
  PROOF_FORENSIC_RESERVE_BYTES,
  PROOF_MIN_TEMP_FREE_BYTES,
  proofCleanupFailure,
  proofCredentialFileRedactions,
  preflightProofRuntimeSafety,
  redactProofDaemonLog,
  sanitizeAndRemoveProofHome,
  sanitizeProofHomeForForensics,
  trackProofChildOutput,
  type ProofHomeCleanupResult,
  type ProofHomeIdentity,
  type ProofChildOutputTracker,
} from './runtime-safety.js';
import {
  reportedBuildFromHealthResponse,
  sha256Directory,
  verifyDaemonBuildMatchesPinnedRuntime,
  type ReportedDaemonBuild,
  type RuntimeUnderTest,
} from './runtime-under-test.js';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const DAEMON_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const REAL_HOME = os.homedir();
const REAL_CLEM_HOME = process.env.CLEMENTINE_HOME || path.join(REAL_HOME, '.clementine-next');
const DEFAULT_PROOF_BOOT_TIMEOUT_MS = 90_000;
const CODEX_PROOF_CALL_BUDGET_MS = 10 * 60_000;
const CODEX_PROOF_EXPIRY_SKEW_MS = 60_000;
const CODEX_PROOF_PROVISION_MARGIN_MS = 2 * 60_000;

function errorWithCleanup(
  primary: unknown,
  stage: string,
  cleanup: ProofHomeCleanupResult,
  additional?: unknown,
): Error {
  const parts = [primary instanceof Error ? primary.message : String(primary)];
  if (additional) parts.push(additional instanceof Error ? additional.message : String(additional));
  const cleanupError = proofCleanupFailure(stage, cleanup);
  if (cleanupError) parts.push(cleanupError);
  return new Error(parts.join('; '));
}

/** Terminate one provider-capable daemon and separate two independent facts:
 * the process is terminal (so native sanitation is safe) and its output pipes
 * drained cleanly (so the retained transcript is complete). A drain failure
 * remains a proof failure, but it must not strand credentials after the child
 * is already proven dead. */
export async function terminateProofProviderProcess(input: {
  child: ChildProcess;
  output: ProofChildOutputTracker;
  markProviderTerminated(): void;
  outputDrainTimeoutMs?: number;
}): Promise<void> {
  const child = input.child;
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
  }
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 1_500))]);
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 750))]);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error('provider process termination remains unproven after SIGKILL');
  }

  // Mark this before waiting for EOF/close. `exit` proves the provider cannot
  // mutate a freshly-built cleanup helper; pipe integrity is separate evidence.
  input.markProviderTerminated();
  await awaitProofChildOutputDrain(
    input.output,
    input.outputDrainTimeoutMs ?? PROOF_CHILD_OUTPUT_DRAIN_TIMEOUT_MS,
  );
}

/** Restart orchestration kept outside provisionDaemon so the teardown-failure
 * branch can be exercised without a live provider. Any failure—including the
 * first daemon's output drain—runs sanitation before control returns. */
export async function restartProofDaemonWithSanitation(input: {
  terminate(): Promise<void>;
  start(): Promise<void>;
  sanitize(): ProofHomeCleanupResult;
}): Promise<void> {
  let restartError: unknown;
  try {
    await input.terminate();
    await input.start();
    return;
  } catch (error) {
    restartError = error;
  }
  let drainError: unknown;
  try {
    await input.terminate();
  } catch (caught) {
    drainError = caught;
  }
  const cleanup = input.sanitize();
  throw errorWithCleanup(
    restartError,
    'restart-failure proof-home',
    cleanup,
    drainError
      ? `daemon output also failed to close during restart recovery: ${drainError instanceof Error ? drainError.message : String(drainError)}`
      : undefined,
  );
}

/** Overflow is evidence loss, not a benign truncation. Retain the bounded tail
 * and sanitize credentials even when every scenario otherwise appeared green. */
export function proofStopMustRetainHome(input: {
  requested: boolean;
  shutdownError?: string;
  logCaptureError?: string;
}): boolean {
  return input.requested || Boolean(input.shutdownError) || Boolean(input.logCaptureError);
}

/** Parse a dotenv-ish file without importing any src/ module (BASE_DIR pinning). */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function realEnvValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  return readEnvFile(path.join(REAL_CLEM_HOME, '.env'))[key];
}

function byoProviderKeyEnvKey(providerId: string): string {
  const slug = providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  return `BYO_PROVIDER_${slug}_API_KEY`;
}

function byoProviderIdsFromRegistry(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((p) => (p && typeof p === 'object' ? (p as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9._:/-]+$/.test(id) && id !== 'default');
  } catch {
    return [];
  }
}

/** Copy only non-secret model selection. Provider credentials keep using the
 * existing per-brain paths below and are never printed or reported. */
function configuredModelEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of [
    'CLAUDE_MODEL', 'OPENAI_MODEL_FAST', 'OPENAI_MODEL_PRIMARY', 'OPENAI_MODEL_DEEP',
    'OPENAI_MODEL_WORKER', 'BYO_MODEL_ID', 'BYO_BRAIN_MODEL_ID', 'BYO_MODEL_JUDGE_ID',
    'BYO_MODEL_BASE_URL', 'BYO_MODEL_PROVIDER', 'BYO_PROVIDERS', 'BYO_PROVIDERS_JSON',
    'CLEMMY_MODEL_ROLES_REGISTRY', 'CLEMMY_MODEL_ROLES', 'CLEMMY_DEBATE_JUDGE',
    'CLEMMY_DEBATE_CHECKER_MODEL', 'CLEMMY_BOUNDARY_JUDGE_CODEX_MODEL',
  ]) {
    const value = realEnvValue(key);
    if (value) env[key] = value;
  }
  if (!env.BYO_PROVIDERS && env.BYO_PROVIDERS_JSON) env.BYO_PROVIDERS = env.BYO_PROVIDERS_JSON;
  return env;
}

function roleModel(env: Record<string, string>, role: 'worker' | 'judge'): string | undefined {
  if ((env.CLEMMY_MODEL_ROLES_REGISTRY ?? 'on').toLowerCase() === 'off') return undefined;
  try {
    const rows = JSON.parse(env.CLEMMY_MODEL_ROLES ?? '') as Array<{ role?: string; modelId?: string; whenIntent?: string }>;
    return rows.find((row) => row.role === role && row.modelId?.trim() && !row.whenIntent?.trim())?.modelId?.trim();
  } catch { return undefined; }
}

function withoutBrainRoleBindings(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const rows = JSON.parse(raw) as Array<{ role?: string }>;
    return JSON.stringify(rows.filter((row) => row?.role !== 'brain'));
  } catch { return raw; }
}

function providerFor(modelId: string, env: Record<string, string>): ProofModelProvider {
  const byoIds = [env.BYO_MODEL_ID, env.BYO_BRAIN_MODEL_ID, env.BYO_MODEL_JUDGE_ID];
  try {
    const rows = JSON.parse(env.BYO_PROVIDERS ?? '[]') as Array<{ modelIds?: string[] }>;
    byoIds.push(...rows.flatMap((row) => row.modelIds ?? []));
  } catch { /* bad registry is missing ownership evidence */ }
  if (byoIds.includes(modelId)) return 'byo'; // declared ownership beats gpt-shaped ids
  if (/claude|opus|sonnet|haiku/i.test(modelId)) return 'claude';
  return /^(?:gpt|o\d)|codex/i.test(modelId) ? 'codex' : 'byo';
}

function expectation(
  env: Record<string, string>,
  modelId: string,
  source: ProofModelExpectation['source'],
): ProofModelExpectation {
  return { modelId, provider: providerFor(modelId, env), source };
}

function roleExpectations(kind: BrainKind, env: Record<string, string>): {
  brain: ProofModelExpectation;
  worker: ProofModelExpectation;
  judge: ProofModelExpectation;
} {
  const brainSlot = kind === 'claude'
    ? env.CLAUDE_MODEL || ''
    : kind === 'glm'
      ? env.BYO_BRAIN_MODEL_ID || env.BYO_MODEL_ID || ''
      : providerFor(env.OPENAI_MODEL_PRIMARY || '', env) === 'codex'
        ? env.OPENAI_MODEL_PRIMARY || ''
        : '';
  const brain = expectation(env, brainSlot, 'provider-slot');
  const workerBinding = roleModel(env, 'worker');
  // The isolated matrix preserves explicit worker/judge role bindings. Current
  // all-in semantics collapse role DEFAULTS to BYO, but still honor an explicit
  // binding to a connected provider. Keep the proof expectation aligned with
  // the binding copied into the daemon instead of expecting the BYO default
  // while the runtime correctly dispatches the bound worker elsewhere.
  const allInWorkerSlot = kind === 'glm'
    ? env.BYO_MODEL_ID || brainSlot
    : brainSlot;
  const worker = expectation(
    env,
    workerBinding || allInWorkerSlot,
    workerBinding ? 'role-binding' : 'provider-slot',
  );
  const judgeBinding = roleModel(env, 'judge');
  const judgeSlot = kind === 'glm'
    ? env.BYO_MODEL_JUDGE_ID || env.BYO_MODEL_ID || ''
    : (env.CLEMMY_DEBATE_JUDGE ?? 'claude').toLowerCase() === 'codex'
      ? (env.OPENAI_MODEL_PRIMARY || '')
      : (env.CLEMMY_DEBATE_CHECKER_MODEL || '');
  let judge = expectation(env, judgeBinding || judgeSlot, judgeBinding ? 'role-binding' : 'provider-slot');
  if (judge.provider === brain.provider && judge.modelId === brain.modelId) {
    const choice = (env.CLEMMY_DEBATE_JUDGE ?? 'claude').toLowerCase();
    if (choice === 'codex' && brain.provider !== 'codex') {
      judge = expectation(env, env.CLEMMY_BOUNDARY_JUDGE_CODEX_MODEL || '', 'fusion-fallback');
    } else if (choice !== 'codex' && brain.provider !== 'claude') {
      judge = expectation(env, env.CLEMMY_DEBATE_CHECKER_MODEL || '', 'fusion-fallback');
    }
  }
  return { brain, worker, judge };
}

/**
 * Build the per-brain env. Missing auth material ⇒ skipReason (the matrix
 * reports SKIP, never FAIL — absence of a subscription isn't a regression).
 */
export function planBrain(kind: BrainKind): BrainPlan {
  const configured = configuredModelEnv();
  // Each matrix leg pins its requested provider lane while preserving the real
  // install's exact model slots and durable worker/judge role bindings. A
  // global brain binding is deliberately removed: it would make every matrix
  // label exercise the same provider instead of the requested brain.
  const proofRoles = withoutBrainRoleBindings(configured.CLEMMY_MODEL_ROLES);
  const selectionEnv = {
    ...configured,
    ...(proofRoles ? { CLEMMY_MODEL_ROLES: proofRoles } : {}),
    MODEL_ROUTING_MODE: kind === 'glm' ? 'all_in' : 'off',
  };
  const expected = roleExpectations(kind, selectionEnv);
  if (kind === 'claude') {
    const hasClaude = existsSync(path.join(REAL_HOME, '.claude'));
    return {
      kind,
      env: {
        ...selectionEnv,
        AUTH_MODE: 'claude_oauth',
        // Fan-out requires the full agentic profile (run_worker is full-mode-only).
        CLEMMY_CLAUDE_AGENT_SDK_BRAIN: 'full',
      },
      expectedBrain: expected.brain,
      expectedWorker: expected.worker,
      expectedFusionChecker: expected.judge,
      skipReason: hasClaude ? undefined : 'no ~/.claude (Claude Code OAuth) on this machine',
    };
  }
  if (kind === 'codex') {
    const hasCodex = Boolean(inspectIsolatedCodexAccess({
      sourceClementineHome: REAL_CLEM_HOME,
    }));
    const apiKey = realEnvValue('OPENAI_API_KEY');
    if (hasCodex) {
      return {
        kind,
        env: { ...selectionEnv, AUTH_MODE: 'codex_oauth' },
        expectedBrain: expected.brain,
        expectedWorker: expected.worker,
        expectedFusionChecker: expected.judge,
      };
    }
    if (apiKey) {
      return {
        kind,
        env: { ...selectionEnv, AUTH_MODE: 'api_key', OPENAI_API_KEY: apiKey },
        expectedBrain: expected.brain,
        expectedWorker: expected.worker,
        expectedFusionChecker: expected.judge,
      };
    }
    return {
      kind,
      env: selectionEnv,
      expectedBrain: expected.brain,
      expectedWorker: expected.worker,
      expectedFusionChecker: expected.judge,
      skipReason: `no Clementine Codex access token with at least ${Math.ceil(PROOF_CODEX_MIN_VALIDITY_MS / 60_000)} minutes remaining and no OPENAI_API_KEY`,
    };
  }
  // glm — BYO all-in brain. Copy only the BYO/GLM material the real install
  // uses. The canonical single-BYO config keys are BYO_MODEL_ID /
  // BYO_MODEL_API_KEY / BYO_MODEL_BASE_URL (what a real install writes);
  // BYO_BRAIN_MODEL_ID is accepted as a legacy alias.
  const byoModel = selectionEnv.BYO_MODEL_ID ?? selectionEnv.BYO_BRAIN_MODEL_ID;
  if (!byoModel) {
    return {
      kind,
      env: selectionEnv,
      expectedBrain: expected.brain,
      expectedWorker: expected.worker,
      expectedFusionChecker: expected.judge,
      skipReason: 'no BYO_MODEL_ID (or BYO_BRAIN_MODEL_ID) configured in the real home',
    };
  }
  const env = {
    ...selectionEnv,
    BYO_MODEL_ID: byoModel,
    // Pin the legacy fallback slot to the default BYO primary. An explicit
    // durable BYO worker binding still wins independently; copying that binding
    // into this legacy slot would make both the default and named providers
    // claim the same id. This prevents a stale built-in id from spending one
    // failed worker wave without manufacturing a provider-identity collision.
    OPENAI_MODEL_WORKER: selectionEnv.BYO_MODEL_ID || byoModel,
  };
  for (const key of [
    'BYO_MODEL_API_KEY', 'ZHIPU_API_KEY', 'GLM_API_KEY', 'OPENROUTER_API_KEY',
  ]) {
    const value = realEnvValue(key);
    if (value) env[key] = value;
  }
  for (const id of byoProviderIdsFromRegistry(env.BYO_PROVIDERS)) {
    const key = byoProviderKeyEnvKey(id);
    const value = realEnvValue(key);
    if (value) env[key] = value;
  }
  return {
    kind,
    env,
    expectedBrain: expected.brain,
    expectedWorker: expected.worker,
    expectedFusionChecker: expected.judge,
  };
}

async function tcpProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port });
    const settle = (ok: boolean) => { try { sock.destroy(); } catch { /* closed */ } resolve(ok); };
    sock.once('connect', () => settle(true));
    sock.once('error', () => settle(false));
    setTimeout(() => settle(false), 1000);
  });
}

export interface ProvisionOptions {
  /** Keep the temp home on stop (forensics). Failed scenarios set this. */
  keepHome?: boolean;
  bootTimeoutMs?: number;
  /** Default off. Dedicated live Fusion canaries opt into the mode under test. */
  fusionMode?: FusionProofMode;
  /** True only when at least one selected scenario proves an exact worker
   * route. Cross-family worker auth is not copied for brain-only scenarios. */
  requireWorkerProvider?: boolean;
  /** Test/diagnostic override. Production uses the conservative derived floor. */
  codexAccessMinValidityMs?: number;
  /** Provider-neutral test/diagnostic override for access-only subscription
   * snapshots. The legacy Codex-specific override remains supported. */
  subscriptionAccessMinValidityMs?: number;
  /** Test-only preflight injection. Production compiles and executes the
   * mutation-free native safety selftest before creating a proof home. */
  runtimeSafetyPreflight?: () => void;
  /** Absolute dist/index.js of the runtime under test. Default: this repo's
   * dist — byte-for-byte today's behavior. A pinned baseline leg (git
   * worktree built at its own tag, scripts/proof/runtime-under-test.ts)
   * passes its own entry so ONE measurement stack drives TWO runtimes. */
  daemonEntry?: string;
  /** Exact pinned runtime identity expected to answer the health request.
   * Omitted for the ordinary current-tree proof path. */
  expectedRuntime?: RuntimeUnderTest;
}

export interface ProofProviderRequirements {
  codex: boolean;
  claude: boolean;
}

/** Exact credential families the selected leg can dispatch. The brain is
 * always live; worker and checker routes count only when the matrix explicitly
 * selected those behaviors. API-key Codex plans do not need an OAuth snapshot. */
export function proofProviderRequirements(
  plan: BrainPlan,
  opts: Pick<ProvisionOptions, 'fusionMode' | 'requireWorkerProvider'> = {},
): ProofProviderRequirements {
  const providers = new Set<ProofModelProvider>([plan.expectedBrain.provider]);
  if (opts.requireWorkerProvider) providers.add(plan.expectedWorker.provider);
  if (opts.fusionMode && opts.fusionMode !== 'off') {
    providers.add(plan.expectedFusionChecker.provider);
  }
  return {
    codex: providers.has('codex') && plan.env.AUTH_MODE !== 'api_key',
    claude: providers.has('claude'),
  };
}

export interface ProofModelAccessSeeds {
  requirements: ProofProviderRequirements;
  codex: IsolatedCodexSeed | null;
  claude: ReturnType<typeof seedIsolatedClaudeAccess>;
}

export function proofModelAccessValidityError(
  access: ProofModelAccessSeeds,
  options: { nowMs?: number; requiredValidityMs: number },
): string | null {
  const nowMs = options.nowMs ?? Date.now();
  const requiredValidityMs = Math.max(0, options.requiredValidityMs);
  const requiredUntil = nowMs + requiredValidityMs;
  const checks: Array<{
    required: boolean;
    provider: 'Codex' | 'Claude';
    seed: IsolatedCodexSeed | ReturnType<typeof seedIsolatedClaudeAccess>;
  }> = [
    { required: access.requirements.codex, provider: 'Codex', seed: access.codex },
    { required: access.requirements.claude, provider: 'Claude', seed: access.claude },
  ];
  for (const check of checks) {
    if (!check.required) continue;
    if (!check.seed?.expiresAt) {
      return `${check.provider} proof access has no verifiable expiration and cannot authorize another paid call`;
    }
    const expiresAt = Date.parse(check.seed.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      return `${check.provider} proof access carries an invalid expiration and cannot authorize another paid call`;
    }
    if (expiresAt <= requiredUntil) {
      return `${check.provider} proof access expires at ${check.seed.expiresAt}, before the next call's ${Math.ceil(requiredValidityMs / 60_000)} minute safety window`;
    }
  }
  return null;
}

export function assertProofModelAccessValidity(
  access: ProofModelAccessSeeds,
  requiredValidityMs: number,
  nowMs = Date.now(),
): void {
  const error = proofModelAccessValidityError(access, { nowMs, requiredValidityMs });
  if (error) throw new Error(`Live proof refused to start or continue: ${error}`);
}

/** Seed only the subscription families that this exact proof leg can call. */
export function seedProofModelAccess(
  home: string,
  plan: BrainPlan,
  opts: ProvisionOptions = {},
): ProofModelAccessSeeds {
  const requirements = proofProviderRequirements(plan, opts);
  // Default 20m already covers a 90s boot + the runtime's 10m per-call budget
  // + expiry skew. Preserve that floor, and grow it for a custom long boot.
  const accessMinValidityMs = opts.subscriptionAccessMinValidityMs
    ?? opts.codexAccessMinValidityMs
    ?? Math.max(
      PROOF_CODEX_MIN_VALIDITY_MS,
      (opts.bootTimeoutMs ?? DEFAULT_PROOF_BOOT_TIMEOUT_MS)
        + CODEX_PROOF_CALL_BUDGET_MS
        + CODEX_PROOF_EXPIRY_SKEW_MS
        + CODEX_PROOF_PROVISION_MARGIN_MS,
    );
  return {
    requirements,
    codex: requirements.codex
      ? seedIsolatedCodexAccess({
          targetHome: home,
          sourceClementineHome: REAL_CLEM_HOME,
          minValidityMs: accessMinValidityMs,
        })
      : null,
    claude: requirements.claude
      ? seedIsolatedClaudeAccess({
          targetHome: home,
          sourceClementineHome: REAL_CLEM_HOME,
          userHome: REAL_HOME,
          minValidityMs: accessMinValidityMs,
        })
      : null,
  };
}

/** Runtime policy pins that make every live proof leg comparable. Exported so
 * the self-test can catch an accidental re-enable before any model quota is
 * spent. */
export function proofRuntimeOverrides(fusionMode: FusionProofMode = 'off'): Record<string, string> {
  return {
    // A provider proof must fail on its selected brain, never look green
    // because a recovery lane silently served the turn.
    CLEMMY_BRAIN_FALLOVER: 'off',
    CLEMMY_AUTH_FALLOVER: 'off',
    CLEMMY_CLAUDE_OVERLOAD_FALLBACK: 'off',
    CLEMMY_LEGACY_RESPOND_FALLBACK: 'off',
    CLEMMY_ROUTE_POLICY: 'off',
    // The release matrix defaults Fusion off. A dedicated cross-model canary
    // may opt in explicitly while unrelated judge/fallover seams stay frozen.
    CLEMMY_DEBATE_MODE: fusionMode,
    CLEMMY_FUSION_STRATEGY: 'verify',
    CLEMMY_JUDGE_CROSS_FAMILY: 'off',
  };
}

/** Process-level isolation shared by the daemon and every shell it spawns.
 * ZDOTDIR prevents a login shell from sourcing the real user's dotfiles and
 * replacing the proof PATH or re-exposing authenticated CLI configuration. */
export function proofProcessIsolationEnv(
  home: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const base = {
    HOME: home,
    ZDOTDIR: home,
    // HOME/ZDOTDIR isolate filesystem credentials, but macOS Keychain remains
    // global to the logged-in user. Reuse the runtime's existing hard stop so
    // a BYO-only proof cannot probe—or block on—the real Claude Code keychain.
    // Claude proof legs use the short-lived credential explicitly seeded into
    // this disposable home, so they retain exactly the access they requested.
    CLEMMY_TEST_ISOLATED_HOME: '1',
  };
  if (platform !== 'win32') return base;
  const parsed = path.win32.parse(home);
  return {
    ...base,
    USERPROFILE: home,
    HOMEDRIVE: parsed.root.replace(/[\\/]$/, ''),
    HOMEPATH: home.slice(Math.max(0, parsed.root.length - 1)),
  };
}

function createProofRailwayShim(home: string): string {
  const bin = path.join(home, 'proof-bin');
  mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, process.platform === 'win32' ? 'railway.cmd' : 'railway');
  const body = process.platform === 'win32'
    ? '@echo off\r\necho Unauthorized. Run railway login to authenticate. 1>&2\r\nexit /b 1\r\n'
    : '#!/bin/sh\nprintf "%s\\n" "Unauthorized. Run railway login to authenticate." >&2\nexit 1\n';
  writeFileSync(shim, body, { encoding: 'utf-8', mode: 0o700 });
  try { chmodSync(shim, 0o700); } catch { /* best-effort on Windows */ }
  return bin;
}

/** Toolkits whose proof-only CLI defaults are explicitly operator-authorized
 * inside the disposable home. This is deliberately the same durable store
 * production Connect writes — never an environment-variable bypass. */
export const PROOF_COMPOSIO_DEFAULT_ACCOUNT_TOOLKITS = [
  'proof',
  'proofapp',
  'gmail',
  'instagram',
  'googlesheets',
] as const;

export function seedProofComposioDefaultAccountAuthorities(home: string): string {
  const stateDir = path.join(home, 'state');
  const file = path.join(stateDir, 'composio-cli-default-accounts.json');
  const grantedAt = new Date().toISOString();
  const grants = Object.fromEntries(
    PROOF_COMPOSIO_DEFAULT_ACCOUNT_TOOLKITS.map((toolkit) => [
      toolkit,
      {
        kind: 'composio_cli_default_account',
        toolkit,
        label: `isolated-proof ${toolkit} default`,
        grantId: `proof-cli-default-${toolkit}`,
        grantedAt,
        grantedBy: 'proof-harness',
      },
    ]),
  );
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ version: 1, grants }, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  try { chmodSync(file, 0o600); } catch { /* best-effort on Windows */ }
  return file;
}

/** A local-only Composio lane for capability recovery proofs. It begins
 * unauthenticated. Creating $HOME/proof-composio-connected makes `whoami` and
 * `execute` succeed. Every execute keeps the legacy slug-only log and also
 * appends `{slug,payload}` JSONL to a proof-local payload log. The
 * latter is deliberately written by the provider shim, not inferred from
 * harness telemetry, so an exact-once proof can compare the bytes that actually
 * crossed the last local dispatch boundary without reaching a real account. */
export function createProofComposioShim(home: string): string {
  const bin = path.join(home, 'proof-bin');
  mkdirSync(bin, { recursive: true });
  const shim = path.join(bin, 'composio-proof.cjs');
  const body = [
    '#!/usr/bin/env node',
    "'use strict';",
    "const crypto = require('node:crypto');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const home = process.env.HOME || process.env.USERPROFILE;",
    "if (!home) { console.error('proof home missing'); process.exit(1); }",
    "const argv = process.argv.slice(2);",
    "const [command, slug, flag, payload = ''] = argv;",
    "const state = path.join(home, 'proof-composio-connected');",
    "const taskFeedStatePath = path.join(home, 'proof-task-feed-state.json');",
    "const sheetsStatePath = path.join(home, 'proof-googlesheets-state.json');",
    "const sheetsReceiptLog = path.join(home, 'proof-googlesheets-receipts.log');",
    "const sheetsOperationLog = path.join(home, 'proof-googlesheets-operations.log');",
    "const sheetHeaders = ['fingerprint','source_receipt_id','purchased_on','merchant','amount','currency','tax','category','category_scope','source_uri','captured_at','evidence_note'];",
    "const appendKeys = ['includeValuesInResponse','insertDataOption','majorDimension','range','spreadsheetId','valueInputOption','values'];",
    "const readKeys = ['range','spreadsheet_id'];",
    "const plainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));",
    "const exactKeys = (value, expected) => plainObject(value) && Object.keys(value).sort().join('\\n') === [...expected].sort().join('\\n');",
    "const readJson = (file, fallback) => { try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); return plainObject(parsed) ? parsed : fallback; } catch { return fallback; } };",
    "const writeJsonAtomic = (file, value) => { const temp = file + '.tmp-' + process.pid; fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\\n', 'utf8'); fs.renameSync(temp, file); };",
    "const parsePayload = () => { try { const parsed = JSON.parse(payload); if (!plainObject(parsed)) throw new Error('payload must be an object'); return parsed; } catch (error) { console.error('invalid JSON payload: ' + (error && error.message ? error.message : String(error))); process.exit(2); } };",
    "const sheetKey = (spreadsheetId, range) => spreadsheetId + '\\n' + range;",
    "const appendSheetOperation = (record) => fs.appendFileSync(sheetsOperationLog, JSON.stringify(record) + '\\n', 'utf8');",
    "if (command === '--version') { console.log('composio-proof 1.0'); process.exit(0); }",
    "if (command === 'whoami') {",
    "  if (fs.existsSync(state)) { console.log('proof-user'); process.exit(0); }",
    "  console.error('Not authenticated.'); process.exit(1);",
    "}",
    "if (command === 'search') {",
    "  if (!fs.existsSync(state)) { console.error('401 Unauthorized.'); process.exit(1); }",
    "  const query = String(slug || '').trim();",
    "  const toolkitIndex = argv.indexOf('--toolkits');",
    "  const limitIndex = argv.indexOf('--limit');",
    "  const toolkitSlug = toolkitIndex >= 0 ? String(argv[toolkitIndex + 1] || '').toLowerCase() : '';",
    "  const requestedLimit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : 25;",
    "  fs.appendFileSync(path.join(home, 'proof-composio-searches.log'), JSON.stringify({ query, toolkitSlug: toolkitSlug || null, limit: Number.isFinite(requestedLimit) ? requestedLimit : null }) + '\\n', 'utf8');",
    "  const eligible = (!toolkitSlug || toolkitSlug === 'proof') && /proof|release|queue|task|item/i.test(query);",
    "  const schemaDir = path.join(home, '.composio', 'tool_definitions');",
    "  const schemaPath = path.join(schemaDir, 'PROOF_LIST_TASKS.json');",
    "  const primary = eligible && requestedLimit !== 0 ? ['PROOF_LIST_TASKS'] : [];",
    "  if (primary.length) { fs.mkdirSync(schemaDir, { recursive: true }); writeJsonAtomic(schemaPath, { version: 'proof-v1', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }); }",
    "  console.log(JSON.stringify({ results: [{ use_case: query, toolkits: ['proof'], primary_tool_slugs: primary, related_tool_slugs: [] }], tool_schemas: { primary: primary.length ? { PROOF_LIST_TASKS: '~/.composio/tool_definitions/PROOF_LIST_TASKS.json' } : {}, related_tools_path_format: '~/.composio/tool_definitions/<TOOL_SLUG>.json' }, connected_toolkits: ['proof'], next_steps: { guidance: primary.length ? 'Execute the selected action with its schema.' : 'Refine the search query.', steps: primary.length ? [{ tool_slug: 'PROOF_LIST_TASKS', arguments: {} }] : [] } }));",
    "  process.exit(0);",
    "}",
    "if (command === 'execute') {",
    "  if (!fs.existsSync(state)) { console.error('401 Unauthorized.'); process.exit(1); }",
    "  if (!slug || flag !== '-d') { console.error('invalid proof execute arguments'); process.exit(1); }",
    "  fs.appendFileSync(path.join(home, 'proof-composio-dispatches.log'), slug + '\\n', 'utf8');",
    "  fs.appendFileSync(path.join(home, 'proof-composio-payloads.log'), JSON.stringify({ slug, payload }) + '\\n', 'utf8');",
    "  if (slug === 'PROOF_TASKS_LIST') {",
    "    const args = parsePayload();",
    "    if (!exactKeys(args, ['scope']) || args.scope !== 'isolated-proof') {",
    "      console.error('invalid proof task-list payload: use exactly {\"scope\":\"isolated-proof\"}');",
    "      process.exit(2);",
    "    }",
    "    console.log(JSON.stringify({ successful: true, data: { tasks: [{ id: 'proof-task-1', title: 'Review the Clementine release proof', status: 'open' }], count: 1, generated_at: '2026-07-29T00:00:00.000Z' } }));",
    "    process.exit(0);",
    "  }",
    "  if (slug === 'PROOF_LIST_TASKS') {",
    "    const args = parsePayload();",
    "    if (!exactKeys(args, [])) {",
    "      console.error('invalid proof release task-list payload: use exactly {}');",
    "      process.exit(2);",
    "    }",
    "    const feed = readJson(taskFeedStatePath, { revision: 1, id: 'proof-release-1', title: 'Review the Clementine 4 release proof', status: 'open' });",
    "    fs.appendFileSync(path.join(home, 'proof-composio-successes.log'), JSON.stringify({ slug, payload }) + '\\n', 'utf8');",
    "    console.log(JSON.stringify({ successful: true, data: { sourceMarker: 'PROOF_RELEASE_QUEUE:LOCAL_ONLY', revision: Number(feed.revision) || 1, items: [{ id: String(feed.id || 'proof-release-1'), title: String(feed.title || 'Review the Clementine 4 release proof'), status: String(feed.status || 'open') }], total: 1 } }));",
    "    process.exit(0);",
    "  }",
    "  if (slug === 'PROOF_SOCIAL_GET_CONTENT_PLAN') {",
    "    console.log(JSON.stringify({ successful: true, data: [{ sourceMarker: 'SOCIAL_SOURCE:PROOF_ONLY', brand: 'Juniper Vale Coffee', handle: '@junipervale', campaign: 'Rainy Day Roast', offer: 'Complimentary oat-milk upgrade on August 14', hashtag: '#RainyDayRoast' }] }));",
    "    process.exit(0);",
    "  }",
    "  if (slug === 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND') {",
    "    const args = parsePayload();",
    "    const validRows = Array.isArray(args.values) && args.values.length === 1 && Array.isArray(args.values[0]) && args.values[0].length === sheetHeaders.length;",
    "    if (!exactKeys(args, appendKeys) || typeof args.spreadsheetId !== 'string' || !args.spreadsheetId || typeof args.range !== 'string' || !args.range || args.valueInputOption !== 'RAW' || args.majorDimension !== 'ROWS' || args.insertDataOption !== 'INSERT_ROWS' || args.includeValuesInResponse !== true || !validRows) {",
    "      console.error('invalid Sheets append payload: use the exact camelCase keys spreadsheetId, range, valueInputOption, majorDimension, insertDataOption, includeValuesInResponse, values; values must contain exactly one 12-cell row');",
    "      process.exit(2);",
    "    }",
    "    const sheetsState = readJson(sheetsStatePath, { version: 1, sheets: {} });",
    "    if (!plainObject(sheetsState.sheets)) sheetsState.sheets = {};",
    "    const key = sheetKey(args.spreadsheetId, args.range);",
    "    const prior = plainObject(sheetsState.sheets[key]) && Array.isArray(sheetsState.sheets[key].rows) ? sheetsState.sheets[key] : { spreadsheetId: args.spreadsheetId, range: args.range, rows: [sheetHeaders] };",
    "    const row = args.values[0].map((cell) => cell == null ? '' : String(cell));",
    "    prior.rows.push(row);",
    "    sheetsState.sheets[key] = prior;",
    "    writeJsonAtomic(sheetsStatePath, sheetsState);",
    "    const ordinal = prior.rows.length - 1;",
    "    const receiptId = 'proof-sheets-' + crypto.createHash('sha256').update(JSON.stringify({ spreadsheetId: args.spreadsheetId, range: args.range, row, ordinal })).digest('hex').slice(0, 20);",
    "    const receipt = { id: receiptId, slug, spreadsheetId: args.spreadsheetId, range: args.range, rowCount: 1, fingerprint: row[0] || null, ordinal };",
    "    fs.appendFileSync(sheetsReceiptLog, JSON.stringify(receipt) + '\\n', 'utf8');",
    "    appendSheetOperation({ operation: 'append', ...receipt });",
    "    console.log(JSON.stringify({ successful: true, data: { spreadsheetId: args.spreadsheetId, tableRange: args.range, proofReceipt: receipt, updates: { spreadsheetId: args.spreadsheetId, updatedRange: args.range, updatedRows: 1, updatedColumns: row.length, updatedCells: row.length, updatedData: { range: args.range, majorDimension: 'ROWS', values: [row] } } } }));",
    "    process.exit(0);",
    "  }",
    "  if (slug === 'GOOGLESHEETS_VALUES_GET') {",
    "    const args = parsePayload();",
    "    if (!exactKeys(args, readKeys) || typeof args.spreadsheet_id !== 'string' || !args.spreadsheet_id || typeof args.range !== 'string' || !args.range) {",
    "      console.error('invalid Sheets read payload: use exactly spreadsheet_id and range');",
    "      process.exit(2);",
    "    }",
    "    const sheetsState = readJson(sheetsStatePath, { version: 1, sheets: {} });",
    "    const key = sheetKey(args.spreadsheet_id, args.range);",
    "    const stored = plainObject(sheetsState.sheets) && plainObject(sheetsState.sheets[key]) && Array.isArray(sheetsState.sheets[key].rows) ? sheetsState.sheets[key].rows : [sheetHeaders];",
    "    const rows = stored.map((row) => Array.isArray(row) ? row.map((cell) => cell == null ? '' : String(cell)) : []);",
    "    appendSheetOperation({ operation: 'read', slug, spreadsheetId: args.spreadsheet_id, range: args.range, rowCount: rows.length });",
    "    console.log(JSON.stringify({ successful: true, data: { spreadsheetId: args.spreadsheet_id, range: args.range, majorDimension: 'ROWS', values: rows } }));",
    "    process.exit(0);",
    "  }",
    "  console.log(JSON.stringify({ successful: true, data: { proof: true, receipt: 'proof-cli-1' } }));",
    "  process.exit(0);",
    "}",
    "console.error('unsupported proof composio command');",
    'process.exit(1);',
    '',
  ].join('\n');
  writeFileSync(shim, body, { encoding: 'utf-8', mode: 0o700 });
  try { chmodSync(shim, 0o700); } catch { /* best-effort on Windows */ }
  return shim;
}

interface AcceptedChatSourceRow {
  seq: number;
  turn: number;
  data_json: string;
}

interface AcceptedChatTerminalRow {
  seq: number;
  data_json: string;
}

function parsedEventData(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function exactAcceptedChatSource(
  db: Database.Database,
  sessionId: string,
  clientRequestId: string,
  runId: string,
): AcceptedChatSourceRow | null {
  const matches = (db.prepare(`
    SELECT seq, turn, data_json
    FROM events
    WHERE session_id = ?
      AND type = 'user_input_received'
      AND role = 'user'
    ORDER BY seq ASC
  `).all(sessionId) as AcceptedChatSourceRow[]).filter((row) => {
    const data = parsedEventData(row.data_json);
    return data?.synthetic !== true
      && data?.clientRequestId === clientRequestId
      && data?.requestId === clientRequestId
      && data?.runId === runId;
  });
  if (matches.length > 1) {
    throw new Error(
      `accepted chat request ${clientRequestId} owns multiple user sources in ${sessionId}: ${matches.map((row) => row.seq).join(',')}`,
    );
  }
  return matches[0] ?? null;
}

function exactAcceptedChatTerminal(
  db: Database.Database,
  sessionId: string,
  source: AcceptedChatSourceRow,
): { text: string; pendingApprovalId?: string } | null {
  const rows = db.prepare(`
    SELECT seq, data_json
    FROM events
    WHERE session_id = ?
      AND type = 'conversation_completed'
      AND seq > ?
    ORDER BY seq ASC
  `).all(sessionId, source.seq) as AcceptedChatTerminalRow[];
  const exact: Array<{ seq: number; text: string; pendingApprovalId?: string }> = [];
  for (const row of rows) {
    const data = parsedEventData(row.data_json);
    if (!data) continue;
    const presentationData = data.presentation && typeof data.presentation === 'object' && !Array.isArray(data.presentation)
      ? data.presentation as Record<string, unknown>
      : null;
    const identityData = presentationData?.identity && typeof presentationData.identity === 'object' && !Array.isArray(presentationData.identity)
      ? presentationData.identity as Record<string, unknown>
      : null;
    const claimsSource = data.sourceUserSeq === source.seq
      || data.terminalKey === `turn:${source.seq}`
      || identityData?.sourceUserSeq === source.seq;
    if (!claimsSource) continue;

    const presentation = presentationEventFromCompletionData(data);
    if (!presentation) {
      throw new Error(`accepted chat terminal ${sessionId}:${row.seq} is not a typed conversation completion`);
    }
    if (
      presentation.identity.sessionId !== sessionId
      || presentation.identity.sourceUserSeq !== source.seq
      || presentation.identity.turn !== source.turn
    ) {
      throw new Error(`accepted chat terminal ${sessionId}:${row.seq} contradicts source ${source.seq}`);
    }
    exact.push({
      seq: row.seq,
      text: presentation.text,
      ...(presentation.approvalId ? { pendingApprovalId: presentation.approvalId } : {}),
    });
  }
  if (exact.length > 1) {
    throw new Error(
      `accepted chat source ${sessionId}:${source.seq} has ambiguous typed terminals: ${exact.map((row) => row.seq).join(',')}`,
    );
  }
  return exact[0] ?? null;
}

export interface AcceptedHarnessChatRequestOptions {
  home: string;
  baseUrl: string;
  headers: Record<string, string>;
  message: string;
  sessionId: string;
  timeoutMs?: number;
}

/**
 * Drive the durable desktop ingress used by the real UI. Its HTTP response is
 * only an acceptance receipt, so completion comes exclusively from the typed
 * terminal owned by the request's exact durable user edge. No latest-message,
 * model-route, tool-result, or text-shape inference is allowed here.
 */
export async function requestAcceptedHarnessChat(
  options: AcceptedHarnessChatRequestOptions,
): Promise<TurnResult> {
  assertProofTempCapacity(options.home);
  const timeoutMs = options.timeoutMs ?? PROOF_CLIENT_COMPLETION_TIMEOUT_MS;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const clientRequestId = `proof-${randomBytes(16).toString('hex')}`;
  const remainingMs = (): number => Math.max(1, deadline - Date.now());
  const { Agent } = await import('undici');
  const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
  let status: number;
  let responseBody: Record<string, unknown>;
  try {
    const response = await fetch(`${options.baseUrl}/api/harness/chat`, {
      method: 'POST',
      headers: options.headers,
      body: JSON.stringify({
        input: options.message,
        sessionId: options.sessionId,
        clientRequestId,
      }),
      signal: AbortSignal.timeout(remainingMs()),
      // @ts-expect-error dispatcher is a Node-fetch (undici) extension
      dispatcher,
    });
    status = response.status;
    const decoded = await response.json().catch(() => ({})) as unknown;
    responseBody = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : {};
  } finally {
    await dispatcher.close();
  }

  if (status !== 202) {
    throw new Error(
      `durable harness chat was not accepted (HTTP ${status}): ${JSON.stringify(responseBody).slice(0, 500)}`,
    );
  }
  const responseSessionId = typeof responseBody.sessionId === 'string' ? responseBody.sessionId : '';
  const responseRequestId = typeof responseBody.clientRequestId === 'string' ? responseBody.clientRequestId : '';
  const responseRunId = typeof responseBody.runId === 'string' ? responseBody.runId : '';
  if (responseSessionId !== options.sessionId) {
    throw new Error(`durable harness chat accepted unexpected session ${responseSessionId || '(missing)'}`);
  }
  if (responseRequestId !== clientRequestId || !responseRunId) {
    throw new Error('durable harness chat acceptance receipt is missing its exact request/run identity');
  }

  const dbPath = path.join(options.home, 'state', 'harness.db');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    let source: AcceptedChatSourceRow | null = null;
    while (Date.now() < deadline) {
      source ??= exactAcceptedChatSource(
        db,
        responseSessionId,
        clientRequestId,
        responseRunId,
      );
      if (source) {
        const terminal = exactAcceptedChatTerminal(db, responseSessionId, source);
        if (terminal) {
          return {
            text: terminal.text,
            sessionId: responseSessionId,
            sourceUserSeq: source.seq,
            pendingApprovalId: terminal.pendingApprovalId,
            wallMs: Date.now() - started,
            httpStatus: status,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, remainingMs())));
    }
  } finally {
    db.close();
  }
  throw new Error(
    `durable harness chat timed out after ${timeoutMs}ms waiting for the exact typed terminal (${responseSessionId}, request ${clientRequestId})`,
  );
}

export async function provisionDaemon(plan: BrainPlan, opts: ProvisionOptions = {}): Promise<DaemonHandle> {
  // This must precede dist inspection, mkdtemp, credential snapshots, and every
  // provider-capable spawn. Unsupported platforms/helper execution fail with
  // zero disposable credential footprint.
  (opts.runtimeSafetyPreflight ?? preflightProofRuntimeSafety)();
  const daemonEntry = opts.daemonEntry ?? DAEMON_ENTRY;
  if (opts.daemonEntry && !opts.expectedRuntime) {
    throw new Error('a custom daemonEntry requires expectedRuntime identity and artifact attestation');
  }
  if (opts.expectedRuntime && path.resolve(daemonEntry) !== path.resolve(opts.expectedRuntime.daemonEntry)) {
    throw new Error(`daemonEntry ${daemonEntry} does not match expectedRuntime ${opts.expectedRuntime.daemonEntry}`);
  }
  if (!existsSync(daemonEntry)) {
    throw new Error(`dist/index.js missing — run \`npm run build\` first (${daemonEntry})`);
  }
  const artifactRoot = opts.expectedRuntime ? path.join(opts.expectedRuntime.treeRoot, 'dist') : undefined;
  const tempRoot = os.tmpdir();
  let providerLifecycle: 'never-spawned' | 'active' | 'terminated' = 'never-spawned';
  const nativeCleanupOperations = {
    assertProviderTerminated: (): void => {
      if (providerLifecycle === 'active') {
        throw new Error(
          'live-proof native filesystem mutation refused because provider termination is unproven',
        );
      }
    },
  };
  // Admit enough free space to allocate the forensic reserve and still leave
  // the full runtime safety floor available at the first action boundary.
  assertProofTempCapacity(tempRoot, {
    requiredBytes: PROOF_MIN_TEMP_FREE_BYTES + PROOF_FORENSIC_RESERVE_BYTES,
  });
  const home = mkdtempSync(path.join(tempRoot, `clemmy-proof-${plan.kind}-`));
  let proofHomeIdentity: ProofHomeIdentity;
  try {
    proofHomeIdentity = captureProofHomeIdentity(home);
  } catch (error) {
    const cleanup = sanitizeAndRemoveProofHome(home, { operations: nativeCleanupOperations });
    throw errorWithCleanup(error, 'proof-home identity capture', cleanup);
  }

  let proofBin: string;
  let proofComposioShim: string;
  let modelAccess: ProofModelAccessSeeds;
  let daemonLog: BoundedProofLogCapture;
  try {
    // Allocate fixed output rings before copying credentials or spawning. An
    // allocation failure therefore flows through the same pre-spawn cleanup.
    daemonLog = new BoundedProofLogCapture();
    // Isolation assertion: the temp home starts with NO state.
    if (existsSync(path.join(home, 'state'))) throw new Error('temp home unexpectedly pre-populated');

    // Allocate and fsync recoverable log headroom before any access material
    // is copied or any provider-capable process is spawned.
    createProofForensicReserve(home);

    // Seed ONLY the provider access snapshots this exact leg can dispatch.
    // Deliberately NOT the secrets vault: it carries Composio/API keys, and the
    // sandbox must stay physically unable to reach external services. Databases,
    // memory and every other state file start EMPTY: that's the isolation contract.
    mkdirSync(path.join(home, 'state'), { recursive: true });
    seedProofComposioDefaultAccountAuthorities(home);
    modelAccess = seedProofModelAccess(home, plan, opts);
    if (modelAccess.requirements.codex && !modelAccess.codex) {
      throw new Error(
        'no Codex access token with enough remaining lifetime is available for the isolated proof; refresh the real daemon sign-in, then reprovision',
      );
    }
    if (modelAccess.requirements.claude && !modelAccess.claude) {
      throw new Error('no currently-valid Claude subscription access token is available for the isolated proof');
    }
    proofBin = createProofRailwayShim(home);
    proofComposioShim = createProofComposioShim(home);
    proofHomeIdentity = captureProofStateIdentity(proofHomeIdentity);
  } catch (error) {
    // Any pre-spawn failure (including a partial credential/shim write) must
    // not orphan access material in a disposable directory the runner never
    // receives a handle for and therefore cannot stop later.
    const cleanup = sanitizeAndRemoveProofHome(home, {
      identity: proofHomeIdentity,
      operations: nativeCleanupOperations,
    });
    throw errorWithCleanup(error, 'pre-spawn proof-home', cleanup);
  }
  const port = 9600 + Math.floor(Math.random() * 300);
  const secret = randomBytes(16).toString('hex');

  const daemonEnv: NodeJS.ProcessEnv = {
    PATH: `${proofBin}${path.delimiter}${process.env.PATH ?? ''}`,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TERM: process.env.TERM ?? 'xterm-256color',
    ...proofProcessIsolationEnv(home),
    COMPOSIO_CLI_PATH: proofComposioShim,
    CLEMENTINE_HOME: home,
    WEBHOOK_PORT: String(port),
    WEBHOOK_SECRET: secret,
    WEBHOOK_ENABLED: 'true',
    // Exercise production runtime branches. Isolation comes from the disposable
    // CLEMENTINE_HOME and missing connected-app secrets, not from test-only
    // behavior that can hide telemetry or swap persistence implementations.
    NODE_ENV: 'production',
    DISCORD_ENABLED: 'false',
    SLACK_ENABLED: 'false',
    ...plan.env,
    ...proofRuntimeOverrides(opts.fusionMode),
  };
  const proofLogSecrets = [
    secret,
    // Capture access-only file credentials before the first spawn. A failed
    // restart sanitizes those files immediately, while stop() persists the log
    // later from this immutable in-memory redaction set.
    ...proofCredentialFileRedactions(home),
    ...Object.entries(daemonEnv)
      .filter(([key, value]) => value && /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION)/i.test(key))
      .map(([, value]) => String(value)),
  ];
  try {
    // Prove the fixed overlap covers every exact credential before the first
    // provider-capable spawn. A later snapshot may never discover this only
    // after it has already retained a boundary fragment.
    daemonLog.assertForensicRedactionCoverage(proofLogSecrets);
  } catch (error) {
    const cleanup = sanitizeAndRemoveProofHome(home, {
      identity: proofHomeIdentity,
      operations: nativeCleanupOperations,
    });
    throw errorWithCleanup(error, 'proof log redaction coverage', cleanup);
  }
  const safeRecentLog = (): string => redactProofDaemonLog(
    daemonLog.forensicLog(proofLogSecrets),
    proofLogSecrets,
  ).slice(-2000);
  const assertProviderBoundary = (timeoutMs: number): void => {
    assertProofHomeIdentity(proofHomeIdentity);
    assertProofTempCapacity(home);
    assertProofModelAccessValidity(
      modelAccess,
      Math.max(CODEX_PROOF_CALL_BUDGET_MS, timeoutMs) + CODEX_PROOF_EXPIRY_SKEW_MS,
    );
  };

  interface SpawnedProofDaemon {
    child: ChildProcess;
    output: ProofChildOutputTracker;
  }
  let proc: SpawnedProofDaemon;
  const spawnDaemon = (): SpawnedProofDaemon => {
    assertProofHomeIdentity(proofHomeIdentity);
    nativeCleanupOperations.assertProviderTerminated();
    daemonLog.append(`\n[proof] spawning daemon at ${new Date().toISOString()}\n`);
    providerLifecycle = 'active';
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [daemonEntry, 'service'], {
        cwd: home,
        env: daemonEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      providerLifecycle = 'terminated';
      throw error;
    }
    const output = trackProofChildOutput(child, (chunk) => daemonLog.append(chunk));
    return { child, output };
  };
  const terminateDaemon = async (): Promise<void> => {
    if (!proc) return;
    const current = proc;
    await terminateProofProviderProcess({
      child: current.child,
      output: current.output,
      markProviderTerminated: () => { providerLifecycle = 'terminated'; },
    });
  };
  const waitForReady = async (): Promise<void> => {
    const deadline = Date.now() + (opts.bootTimeoutMs ?? DEFAULT_PROOF_BOOT_TIMEOUT_MS);
    while (Date.now() < deadline) {
      assertProofHomeIdentity(proofHomeIdentity);
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
        const reason = proc.child.exitCode !== null
          ? `code ${proc.child.exitCode}`
          : `signal ${proc.child.signalCode}`;
        throw new Error(`daemon exited during boot (${reason})\n${safeRecentLog()}`);
      }
      if (await tcpProbe(port)) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(10_000) });
          if (res.ok) return;
        } catch { /* still warming */ }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`daemon not ready within boot timeout\n${safeRecentLog()}`);
  };

  const runtimeIdentityChecks: Check[] = [];
  let certifiedBoot = 0;
  const certifyExpectedRuntime = async (artifactSha256BeforeSpawn: string | undefined): Promise<void> => {
    if (!opts.expectedRuntime) return;
    if (!artifactRoot || !artifactSha256BeforeSpawn) {
      throw new Error('pinned runtime artifact identity was unavailable before spawn');
    }
    let reportedBuild: ReportedDaemonBuild | undefined;
    const response = await fetch(`http://127.0.0.1:${port}/api/console/health`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(10_000),
    });
    reportedBuild = reportedBuildFromHealthResponse({
      status: response.status,
      bodyText: await response.text(),
    });
    const observedArtifactSha256 = sha256Directory(artifactRoot);
    if (artifactSha256BeforeSpawn !== observedArtifactSha256) {
      throw new Error(
        `pinned daemon artifact changed during boot (before ${artifactSha256BeforeSpawn}, after ${observedArtifactSha256})`,
      );
    }
    const identityCheck = verifyDaemonBuildMatchesPinnedRuntime({
      runtime: opts.expectedRuntime,
      reportedBuild,
      observedArtifactSha256,
    });
    certifiedBoot += 1;
    const recordedCheck = { ...identityCheck, name: `${identityCheck.name} (boot ${certifiedBoot})` };
    runtimeIdentityChecks.push(recordedCheck);
    if (!recordedCheck.pass) {
      throw new Error(`${recordedCheck.name}: ${recordedCheck.detail ?? 'identity mismatch'}`);
    }
  };

  try {
    const artifactSha256BeforeSpawn = artifactRoot ? sha256Directory(artifactRoot) : undefined;
    proc = spawnDaemon();
    await waitForReady();
    await certifyExpectedRuntime(artifactSha256BeforeSpawn);
  } catch (error) {
    let drainError: unknown;
    try {
      await terminateDaemon();
    } catch (caught) {
      drainError = caught;
    }
    const cleanup = sanitizeAndRemoveProofHome(home, {
      identity: proofHomeIdentity,
      operations: nativeCleanupOperations,
    });
    const failure = errorWithCleanup(
      error,
      'boot-failure proof-home',
      cleanup,
      drainError
        ? `daemon teardown also failed: ${drainError instanceof Error ? drainError.message : String(drainError)}`
        : undefined,
    );
    daemonLog.clear();
    throw failure;
  }

  const baseUrl = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };

  const chat = async (
    message: string,
    sessionId: string,
    timeoutMs = PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
  ): Promise<TurnResult> => {
    assertProviderBoundary(timeoutMs);
    const started = Date.now();
    // Node fetch (undici) kills any response whose HEADERS take >300s by
    // default — a real workspace-build/long-agent turn legitimately runs past
    // that, and the scenario died with a bare "fetch failed" (workspace-build,
    // 2026-07-03). Disable the per-phase timeouts; our AbortSignal owns the
    // wall clock.
    const { Agent } = await import('undici');
    const res = await fetch(`${baseUrl}/api/console/home/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message, sessionId }),
      signal: AbortSignal.timeout(timeoutMs),
      // @ts-expect-error dispatcher is a Node-fetch (undici) extension
      dispatcher: new Agent({ headersTimeout: 0, bodyTimeout: 0 }),
    });
    const wallMs = Date.now() - started;
    const body = (await res.json().catch(() => ({}))) as { text?: string; sessionId?: string; pendingApprovalId?: string };
    return {
      text: body.text ?? '',
      sessionId: body.sessionId ?? sessionId,
      pendingApprovalId: body.pendingApprovalId,
      wallMs,
      httpStatus: res.status,
    };
  };

  const acceptedChat = async (
    message: string,
    sessionId: string,
    timeoutMs = PROOF_CLIENT_COMPLETION_TIMEOUT_MS,
  ): Promise<TurnResult> => {
    assertProviderBoundary(timeoutMs);
    return requestAcceptedHarnessChat({
      home,
      baseUrl,
      headers,
      message,
      sessionId,
      timeoutMs,
    });
  };

  const approve = async (approvalId: string, decision: 'approve' | 'reject'): Promise<number> => {
    assertProviderBoundary(PROOF_CLIENT_COMPLETION_TIMEOUT_MS);
    const res = await fetch(`${baseUrl}/api/console/harness-approvals/${encodeURIComponent(approvalId)}/${decision}`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(60_000),
    });
    return res.status;
  };

  const request = async (method: string, apiPath: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
    assertProviderBoundary(60_000);
    const res = await fetch(`${baseUrl}${apiPath}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const restart = async (): Promise<void> => {
    // Do not terminate a healthy isolated daemon and begin another paid model
    // turn when the volume can no longer safely persist its evidence.
    assertProviderBoundary(PROOF_CLIENT_COMPLETION_TIMEOUT_MS);
    await restartProofDaemonWithSanitation({
      terminate: terminateDaemon,
      start: async () => {
        const artifactSha256BeforeSpawn = artifactRoot ? sha256Directory(artifactRoot) : undefined;
        proc = spawnDaemon();
        await waitForReady();
        await certifyExpectedRuntime(artifactSha256BeforeSpawn);
      },
      // This also covers failure while draining the *old* daemon. The runner
      // may never regain a usable handle, so sanitize before returning.
      sanitize: () => sanitizeProofHomeForForensics(home, {
        identity: proofHomeIdentity,
        operations: nativeCleanupOperations,
      }),
    });
  };

  const stop = async (stopOpts?: { keepHome?: boolean }): Promise<DaemonStopResult> => {
    try {
      let shutdownError: string | undefined;
      try {
        await terminateDaemon();
      } catch (error) {
        shutdownError = error instanceof Error ? error.message : String(error);
      }
      const logCapture = daemonLog.stats();
      const logCaptureError = daemonLog.overflowError();
      // Teardown uncertainty or semantic log loss is itself a failed run and
      // therefore forces sanitized retention even after green scenarios.
      const keepHome = proofStopMustRetainHome({
        requested: Boolean(opts.keepHome || stopOpts?.keepHome),
        shutdownError,
        logCaptureError,
      });
      if (keepHome) {
        let logPath: string | undefined;
        let logPersistenceError: string | undefined;
        try {
          logPath = persistProofDaemonLogForForensics({
            home,
            log: daemonLog.forensicLog(proofLogSecrets),
            exactSecrets: proofLogSecrets,
            identity: proofHomeIdentity,
            operations: nativeCleanupOperations,
          });
        } catch (error) {
          logPersistenceError = error instanceof Error ? error.message : String(error);
        }
        const cleanup = sanitizeProofHomeForForensics(home, {
          identity: proofHomeIdentity,
          operations: nativeCleanupOperations,
        });
        if (logPersistenceError) {
          console.warn(`[proof] could not persist retained daemon log for ${home}: ${logPersistenceError}`);
        }
        return {
          retainedHome: true,
          forensicLog: logPersistenceError
            ? { status: 'failed', error: logPersistenceError }
            : { status: 'persisted', path: logPath },
          cleanup,
          logCapture,
          ...(shutdownError ? { shutdownError } : {}),
          ...(logCaptureError ? { logCaptureError } : {}),
        };
      }

      const cleanup = sanitizeAndRemoveProofHome(home, {
        identity: proofHomeIdentity,
        operations: nativeCleanupOperations,
      });
      return {
        retainedHome: false,
        forensicLog: { status: 'not-requested' },
        cleanup,
        logCapture,
      };
    } finally {
      daemonLog.clear();
    }
  };

  // log() is scoped to the CURRENT bounded scenario window. markLog() drops the
  // prior semantic window while the smaller forensic tail spans all restarts.
  const log = (): string => daemonLog.scenarioLog();
  const markLog = (): void => { daemonLog.markScenario(); };
  const runtimeChecks = (): Check[] => runtimeIdentityChecks.map((check) => ({ ...check }));
  return {
    home,
    port,
    secret,
    baseUrl,
    chat,
    acceptedChat,
    approve,
    request,
    log,
    markLog,
    restart,
    stop,
    runtimeChecks,
  };
}
