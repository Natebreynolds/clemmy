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

export interface BrainPlan {
  kind: BrainKind;
  /** Extra env for the spawned daemon (brain selection + auth material). */
  env: Record<string, string>;
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
  /** Everything the daemon printed so far (stdout+stderr). */
  log(): string;
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
  run(daemon: DaemonHandle): Promise<Omit<ScenarioOutcome, 'brain' | 'scenario' | 'status'> & { checks: Check[] }>;
}

export interface ProofReport {
  startedAt: string;
  finishedAt: string;
  gitHead: string;
  outcomes: ScenarioOutcome[];
  failures: number;
}
