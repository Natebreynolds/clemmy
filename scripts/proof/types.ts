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
  pendingApprovalId?: string;
  httpStatus: number;
}

/** Handle to a provisioned daemon + the drive surface scenarios use. */
export interface DaemonHandle {
  home: string;
  port: number;
  secret: string;
  baseUrl: string;
  chat(message: string, sessionId: string, timeoutMs?: number): Promise<TurnResult>;
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
  /** keepHome=true preserves the temp home for forensics (failed runs). */
  stop(opts?: { keepHome?: boolean }): Promise<void>;
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
  error?: string;
}

export interface ScenarioDef {
  name: string;
  /** One line shown in the scoreboard. */
  summary: string;
  /** Require session-scoped provider identity and zero fallover for this run. */
  routeExpectation?: 'exact-brain' | 'exact-workflow-step';
  /** This scenario deliberately dispatches the configured worker role. */
  workerRouteExpectation?: boolean;
  run(daemon: DaemonHandle): Promise<Omit<ScenarioOutcome, 'brain' | 'scenario' | 'status'> & { checks: Check[] }>;
}

export interface ProofReport {
  startedAt: string;
  finishedAt: string;
  gitHead: string;
  sourceClean: boolean;
  fusionMode: FusionProofMode;
  outcomes: ScenarioOutcome[];
  failures: number;
}
