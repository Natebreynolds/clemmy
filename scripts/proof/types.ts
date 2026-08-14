/**
 * Live proof harness — shared types.
 *
 * The proof harness boots a REAL daemon per brain against an ISOLATED
 * CLEMENTINE_HOME (binding rule: destructive/memory-touching runs never see the
 * real ~/.clementine-next), drives representative autonomous scenarios over the
 * console HTTP API, and scores each run from the eventlog — completed vs
 * parked, fan-out used, narration leaks, provider-error storms, latency.
 * The scoreboard is the pre-release regression gate for "no fail" claims.
 */

export type BrainKind = 'claude' | 'codex' | 'glm';
export type FusionProofMode = 'off' | 'high' | 'all';
export type ProofModelProvider = 'claude' | 'codex' | 'byo';
export type ProofBenchmarkSample = 'prime' | 'measured';

/** Explicit identity for one member of a deliberately paired benchmark.
 * `prime`/`measured` describe protocol order only; observed cache telemetry,
 * never the label, decides whether either sample was actually cold or warm. */
export interface ProofBenchmarkMetadata {
  protocolVersion: 1;
  cohortId: string;
  sample: ProofBenchmarkSample;
  /** Stable hash of scenario names + declared workload inputs + Fusion mode.
   * Source and route identity remain separate comparison gates. */
  workloadKey: string;
}

/** Non-secret release expectation derived from the candidate install's model
 * configuration. Live scoring must prove this exact provider/model pair from
 * session-scoped telemetry; a provider-family match alone is insufficient. */
export interface ProofModelExpectation {
  modelId: string;
  provider: ProofModelProvider;
  source: 'role-binding' | 'provider-slot' | 'fusion-fallback';
}

export interface BrainPlan {
  kind: BrainKind;
  /** Extra env for the spawned daemon (brain selection + auth material). */
  env: Record<string, string>;
  /** Exact brain model the isolated leg is expected to exercise. */
  expectedBrain: ProofModelExpectation;
  /** Exact role-wide/default worker model fan-out is expected to exercise. */
  expectedWorker: ProofModelExpectation;
  /** Exact judge/checker the Fusion canary is expected to exercise. */
  expectedFusionChecker: ProofModelExpectation;
  /** Human-readable reason when the brain cannot run (missing auth ⇒ SKIP, never FAIL). */
  skipReason?: string;
}

export interface TurnResult {
  text: string;
  sessionId: string;
  wallMs: number;
  /** Exact durable user edge accepted for this turn when the drive surface
   * exposes it. The synchronous console compatibility route does not. */
  sourceUserSeq?: number;
  pendingApprovalId?: string;
  httpStatus: number;
}

/** Bounded stdout/stderr capture evidence for one isolated brain leg. The
 * forensic tail spans daemon restarts; the scenario counters describe only the
 * window since the runner's latest markLog(). */
export interface ProofLogCaptureEvidence {
  totalBytes: number;
  /** Maximum bytes exposed by the already-redacted forensic snapshot. */
  forensicMaxBytes: number;
  forensicStoredBytes: number;
  forensicDroppedBytes: number;
  /** Raw ring is bounded to final output plus one maximum-secret overlap so
   * redaction always precedes the final tail boundary. */
  forensicRawMaxBytes: number;
  forensicRawStoredBytes: number;
  forensicRawDroppedBytes: number;
  forensicRedactionOverlapBytes: number;
  scenarioMaxBytes: number;
  currentScenarioBytes: number;
  currentScenarioStoredBytes: number;
  currentScenarioDroppedBytes: number;
  scenarioDroppedBytes: number;
  overflowPeriods: number;
  overflowed: boolean;
}

export interface DaemonStopResult {
  /** The home was intentionally retained (including forced retention after a
   * shutdown failure) rather than recursively removed. */
  retainedHome: boolean;
  forensicLog: {
    status: 'not-requested' | 'persisted' | 'failed';
    path?: string;
    error?: string;
  };
  /** Verified disposition of the exact mkdtemp proof home. A green teardown
   * must prove the home is absent; retained forensics must prove every copied
   * credential path is absent without following a workload-created symlink. */
  cleanup: {
    intent: 'sanitize-and-retain' | 'remove';
    status: 'succeeded' | 'failed';
    homeExists: boolean;
    errors?: string[];
  };
  /** A bounded SIGTERM/SIGKILL completed, but process close/pipe EOF could not
   * be proven. The log may still be useful, but it is not complete evidence. */
  shutdownError?: string;
  /** Always present for provisionDaemon-produced results. Optional only so
   * small pure-test fixtures from older callers remain structurally valid. */
  logCapture?: ProofLogCaptureEvidence;
  /** Sticky fail-closed evidence: at least one boot/scenario period exceeded
   * the semantic scenario window, even if no later scenario called log(). */
  logCaptureError?: string;
}

/** Handle to a provisioned daemon + the drive surface scenarios use. */
export interface DaemonHandle {
  home: string;
  port: number;
  secret: string;
  baseUrl: string;
  chat(message: string, sessionId: string, timeoutMs?: number): Promise<TurnResult>;
  /** Drive the durable 202/SSE chat ingress, then read only the exact accepted
   * source's typed terminal from the isolated harness database. */
  acceptedChat(message: string, sessionId: string, timeoutMs?: number): Promise<TurnResult>;
  approve(approvalId: string, decision: 'approve' | 'reject'): Promise<number>;
  /** Authenticated JSON request against the daemon's console API. */
  request(method: string, apiPath: string, body?: unknown): Promise<{ status: number; json: unknown }>;
  /** Daemon stdout+stderr since the last markLog() (whole boot log before the first mark). */
  log(): string;
  /** Advance the log window — the runner calls this between scenarios so one
   *  early provider-back-pressure burst can't fail every later storm check. */
  markLog(): void;
  /** Restart the real daemon against the SAME isolated home, port, and auth
   *  sandbox. Used to prove durable recovery instead of simulating it in-process. */
  restart(): Promise<void>;
  /** Positive per-boot runtime identity checks, including restart boots. */
  runtimeChecks?(): Check[];
  /** keepHome=true preserves the temp home for forensics (failed runs). The
   * result is report evidence: a requested retained log may never fail only as
   * a console warning. */
  stop(opts?: { keepHome?: boolean }): Promise<DaemonStopResult>;
}

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface TurnLatency {
  wallMs: number;
  /** Time from turn_started to the first observable model action (tool call or
   *  turn end) inside the eventlog. Null when the events don't allow it. */
  ttftMs: number | null;
}

/** Exact model-route expectation for one durable session owned by a scenario.
 * Multi-session horizon proofs use this so a cold acquisition cannot hide
 * behind route evidence from a later learned/replay session. */
export interface ScenarioRouteSession {
  sessionId: string;
  expectedModelTurns: number;
}

export type ScenarioStatus = 'PASS' | 'FAIL' | 'SKIP';

export interface ScenarioOutcome {
  scenario: string;
  brain: BrainKind;
  status: ScenarioStatus;
  checks: Check[];
  latency: TurnLatency[];
  sessionId?: string;
  /** Raw metric snapshot for the report (turns, tool calls, tokens, …). */
  metrics?: Record<string, unknown>;
  /** Optional per-session route proof. When present, runner scoring validates
   * every entry instead of collapsing a multi-session scenario to sessionId. */
  routeSessions?: ScenarioRouteSession[];
  error?: string;
}

export interface ScenarioDef {
  name: string;
  /** One line shown in the scoreboard. */
  summary: string;
  /** Require session-scoped provider identity and zero fallover for this run. */
  routeExpectation?: 'exact-brain' | 'exact-workflow-step';
  /** Number of turns expected to invoke the brain model. Defaults to the
   * scenario's latency sample count. Set this when latency also records
   * deterministic fast-path turns that deliberately make no model call. */
  expectedModelTurns?: number;
  /** This scenario deliberately dispatches the configured worker role. */
  workerRouteExpectation?: boolean;
  /** Stable, non-secret inputs that materially change benchmark work. Runtime
   * output, timestamps, session ids, and model responses never belong here. */
  benchmarkWorkload?: Readonly<Record<string, string | number | boolean | null>>;
  run(
    daemon: DaemonHandle,
    context?: { brain: BrainKind },
  ): Promise<Omit<ScenarioOutcome, 'brain' | 'scenario' | 'status'> & { checks: Check[] }>;
}

export interface ProofReport {
  startedAt: string;
  finishedAt: string;
  gitHead: string;
  /** Finish-time HEAD. Optional on archived reports predating stability proof. */
  gitHeadEnd?: string;
  /** SHA-256 of HEAD plus the scoped tracked diff and untracked source bytes. */
  sourceFingerprint: string;
  /** Finish-time fingerprint. Optional so archived v1 reports remain readable. */
  sourceFingerprintEnd?: string;
  /** False when source changed, or could not be re-fingerprinted, during proof. */
  sourceStable?: boolean;
  sourceClean: boolean;
  /** Identity of the daemon artifact under test. For ordinary candidate runs
   * this equals sourceFingerprint; pinned baselines use their attested dist. */
  runtimeFingerprint?: string;
  runtimeGitSha?: string;
  runtimeLabel?: string;
  fusionMode: FusionProofMode;
  benchmark?: ProofBenchmarkMetadata;
  /** Report-wide evidence checks which do not belong to one brain/scenario. */
  reportChecks?: Check[];
  outcomes: ScenarioOutcome[];
  failures: number;
}
