/**
 * Provider-neutral no-progress reduction for one accepted task.
 *
 * This module deliberately knows nothing about tool names, providers, query
 * text, result prose, or model call ids. Callers project only host-owned
 * authority/evidence identities into a snapshot. Changing a search phrase,
 * planning draft, carrier, or physical call id therefore cannot manufacture
 * progress.
 *
 * The reducer does not execute a stop or render user-facing prose. It returns
 * one typed terminal disposition for the host's common post-frame reducer.
 * Existing clarification/terminal tool arbitration should run first; this is
 * the backstop that prevents another model request when those paths found
 * nothing actionable.
 */

import { createHash } from 'node:crypto';

export const NO_PROGRESS_GOVERNOR_VERSION = 2 as const;
export const NO_PROGRESS_RETRY_BUDGET = 1 as const;
/**
 * Distinct host-validated repair consequences one attempt sequence may move
 * through before the host stops it. Re-entering ANY prior consequence key
 * still terminates immediately (that is the loop floor); this budget only
 * bounds genuine convergence. Live 2026-09-01: a system authoring turn fixed
 * four different plan_task complaints in a row (evidence-string pattern,
 * missing write binding, bindings coverage, topology dependency) and was
 * terminalized at the third because the budget was 2 — a converging turn
 * killed for making progress.
 */
export const NO_PROGRESS_STAGE_TRANSITION_BUDGET = 6 as const;

export type NoProgressRecovery =
  | 'repair_model'
  | 'retry_host'
  | 'ask_user'
  | 'stop_factual'
  | 'reconcile';

export type NoProgressEffectState = 'not_started' | 'known_terminal' | 'unknown';

export interface NoProgressUserInput {
  readonly question: string;
  readonly choices: readonly string[];
  readonly purpose: 'clarification';
}

/**
 * One host-validated consequence. The key is derived only from these bounded
 * structural fields; model call ids, arguments, query wording, provider prose,
 * and result bytes cannot mint a new stage.
 */
export interface NoProgressConsequence {
  readonly key: string;
  readonly stage: string;
  readonly recovery: NoProgressRecovery;
  readonly effectState: NoProgressEffectState;
  /** Callable names are routing metadata. They are sealed into the key but are
   * never interpreted as evidence or authority. */
  readonly recoveryToolNames: readonly string[];
  readonly userInput?: NoProgressUserInput;
}

const CONSEQUENCE_KEY_RE = /^[a-f0-9]{64}$/;
const CONSEQUENCE_STAGE_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,191}$/;
const RECOVERY_ACTIONS = new Set<NoProgressRecovery>([
  'repair_model',
  'retry_host',
  'ask_user',
  'stop_factual',
  'reconcile',
]);
const EFFECT_STATES = new Set<NoProgressEffectState>([
  'not_started',
  'known_terminal',
  'unknown',
]);

function normalizedBoundedText(value: string, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`NoProgressGovernor requires a string ${label}.`);
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) throw new Error(`NoProgressGovernor requires a non-empty ${label}.`);
  if (normalized.length > max) throw new Error(`NoProgressGovernor ${label} exceeds ${max} characters.`);
  return normalized;
}

/** Upper bound on the distinct carriers one recovery surface may name. */
export const NO_PROGRESS_RECOVERY_TOOL_NAME_CAP = 8;

function normalizedRecoveryToolNames(values: readonly string[] | undefined): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  if (!Array.isArray(values) || values.length > NO_PROGRESS_RECOVERY_TOOL_NAME_CAP) {
    throw new Error('NoProgressGovernor recovery tool names must be an array of at most 8 entries.');
  }
  return Object.freeze([...new Set(values.map((value) => (
    normalizedBoundedText(value, 'recovery tool name', 256)
  )))].sort());
}

function normalizedUserInput(
  value: NoProgressUserInput | undefined,
  recovery: NoProgressRecovery,
): NoProgressUserInput | undefined {
  if (recovery !== 'ask_user') {
    if (value !== undefined) {
      throw new Error('NoProgressGovernor user input belongs only to ask_user recovery.');
    }
    return undefined;
  }
  if (!value || !Array.isArray(value.choices)) {
    throw new Error('NoProgressGovernor ask_user recovery requires exact user input.');
  }
  const question = normalizedBoundedText(value.question, 'exact user input question', 500);
  if (value.choices.length > 5) {
    throw new Error('NoProgressGovernor exact user input has more than 5 choices.');
  }
  const choices = Object.freeze([...new Set(value.choices.map((choice) => (
    normalizedBoundedText(choice, 'exact user input choice', 256)
  )))]) as readonly string[];
  if (value.purpose !== undefined && value.purpose !== 'clarification') {
    throw new Error('NoProgressGovernor exact user input purpose must be clarification.');
  }
  return Object.freeze({ question, choices, purpose: 'clarification' as const });
}

function consequenceDigest(input: {
  stage: string;
  recovery: NoProgressRecovery;
  effectState: NoProgressEffectState;
  recoveryToolNames: readonly string[];
  userInput?: NoProgressUserInput;
}): string {
  return createHash('sha256').update(JSON.stringify({
    version: 1,
    stage: input.stage,
    recovery: input.recovery,
    effectState: input.effectState,
    recoveryToolNames: input.recoveryToolNames,
    // Purpose is fixed to clarification by the host. Omitting it from the
    // digest preserves V2 checkpoints written before that invariant became an
    // explicit field; it cannot vary and therefore cannot mint a stage.
    userInput: input.userInput
      ? { question: input.userInput.question, choices: input.userInput.choices }
      : null,
  }), 'utf8').digest('hex');
}

export function createNoProgressConsequence(input: {
  stage: string;
  recovery: NoProgressRecovery;
  effectState: NoProgressEffectState;
  recoveryToolNames?: readonly string[];
  userInput?: NoProgressUserInput;
}): NoProgressConsequence {
  const stage = normalizedBoundedText(input.stage, 'consequence stage', 192);
  if (!CONSEQUENCE_STAGE_RE.test(stage)) {
    throw new Error('NoProgressGovernor consequence stage is not a stable token.');
  }
  if (!RECOVERY_ACTIONS.has(input.recovery)) {
    throw new Error('NoProgressGovernor consequence has an unknown recovery action.');
  }
  if (!EFFECT_STATES.has(input.effectState)) {
    throw new Error('NoProgressGovernor consequence has an unknown effect state.');
  }
  if (input.recovery === 'reconcile' && input.effectState !== 'unknown') {
    throw new Error('NoProgressGovernor reconciliation requires an unknown effect state.');
  }
  if (input.effectState === 'unknown' && input.recovery !== 'reconcile') {
    throw new Error('NoProgressGovernor unknown effect state requires reconciliation.');
  }
  const recoveryToolNames = normalizedRecoveryToolNames(input.recoveryToolNames);
  const userInput = normalizedUserInput(input.userInput, input.recovery);
  const key = consequenceDigest({
    stage,
    recovery: input.recovery,
    effectState: input.effectState,
    recoveryToolNames,
    ...(userInput ? { userInput } : {}),
  });
  return Object.freeze({
    key,
    stage,
    recovery: input.recovery,
    effectState: input.effectState,
    recoveryToolNames,
    ...(userInput ? { userInput } : {}),
  });
}

function parseNoProgressConsequence(value: unknown): NoProgressConsequence | null {
  const candidate = record(value);
  if (!candidate || typeof candidate.key !== 'string' || !CONSEQUENCE_KEY_RE.test(candidate.key)) {
    return null;
  }
  try {
    const parsed = createNoProgressConsequence({
      stage: candidate.stage as string,
      recovery: candidate.recovery as NoProgressRecovery,
      effectState: candidate.effectState as NoProgressEffectState,
      recoveryToolNames: candidate.recoveryToolNames as readonly string[],
      ...(candidate.userInput !== undefined
        ? { userInput: candidate.userInput as unknown as NoProgressUserInput }
        : {}),
    });
    return parsed.key === candidate.key ? parsed : null;
  } catch {
    return null;
  }
}

export type AuthorityProgressKind =
  | 'operation'
  | 'account'
  | 'target'
  | 'evidence'
  | 'effect';

export const AUTHORITY_PROGRESS_KINDS: readonly AuthorityProgressKind[] = [
  'operation',
  'account',
  'target',
  'evidence',
  'effect',
] as const;

/**
 * Opaque host-issued identities grouped by the authority fact they establish.
 * Values may be exact ids or canonical digests, but never model-authored text.
 */
export type AuthorityProgressSnapshot = Readonly<
  Record<AuthorityProgressKind, readonly string[]>
>;

/**
 * Only pre-effect attempts whose purpose is to find/admit missing work are
 * metered. Real task work is observed so its evidence can reset the budget,
 * but a long-running workflow is never stopped merely for having many steps.
 */
export type NoProgressAttemptClass =
  | 'authority_acquisition'
  | 'dependency_lookup'
  | 'plan_admission'
  | 'zero_crossing_repair'
  | 'task_work'
  | 'terminal_projection';

export interface NoProgressGovernorState {
  readonly version: typeof NO_PROGRESS_GOVERNOR_VERSION;
  /** Opaque accepted-task identity, normally a canonical digest. */
  readonly taskKey: string;
  readonly authority: AuthorityProgressSnapshot;
  /** Consecutive metered attempts since the last exact authority gain. */
  readonly noProgressAttempts: number;
  /** One clean model-led recovery is allowed after each genuine gain. */
  readonly retriesRemaining: 0 | typeof NO_PROGRESS_RETRY_BUDGET;
  /** Host-validated consequence stages seen since the last authority gain.
   * Re-entering any prior key is a cycle, even when another stage intervened. */
  readonly seenConsequenceKeys: readonly string[];
  readonly lastConsequence: NoProgressConsequence | null;
  /** Integer in [0, NO_PROGRESS_STAGE_TRANSITION_BUDGET]; restore validates the bound. */
  readonly stageTransitionsRemaining: number;
  readonly observations: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export interface NoProgressAskArguments {
  readonly question: string;
  readonly options: readonly string[] | null;
  readonly purpose: 'clarification';
}

export function canonicalNoProgressAskArguments(
  input: NoProgressUserInput,
): NoProgressAskArguments {
  const exact = normalizedUserInput(input, 'ask_user');
  if (!exact) throw new Error('NoProgressGovernor exact user input is unavailable.');
  return Object.freeze({
    question: exact.question,
    options: exact.choices.length > 0 ? exact.choices : null,
    purpose: exact.purpose,
  });
}

/** Exact authority comparison for the one ask_user_question call. Additional
 * fields, reordered/substituted options, approval purpose, and normalized-but-
 * different wording are all different asks and must remain pre-dispatch. */
export function isCanonicalNoProgressAskArguments(
  value: unknown,
  input: NoProgressUserInput,
): boolean {
  const candidate = record(value);
  if (!candidate) return false;
  const keys = Object.keys(candidate).sort();
  if (keys.join('\u0000') !== ['options', 'purpose', 'question'].join('\u0000')) return false;
  const exact = canonicalNoProgressAskArguments(input);
  if (candidate.question !== exact.question || candidate.purpose !== exact.purpose) return false;
  if (exact.options === null) return candidate.options === null;
  return Array.isArray(candidate.options)
    && candidate.options.length === exact.options.length
    && candidate.options.every((option, index) => option === exact.options![index]);
}

export interface ObserveNoProgressInput {
  readonly taskKey: string;
  readonly attemptClass: NoProgressAttemptClass;
  readonly authority: AuthorityProgressSnapshot;
  readonly consequence?: NoProgressConsequence;
}

export type NoProgressContinueReason =
  | 'authority_progress'
  | 'unmetered_attempt'
  | 'retry_available'
  | 'consequence_progress'
  | 'user_input_required';

export interface NoProgressContinueDecision {
  readonly action: 'continue';
  readonly reason: NoProgressContinueReason;
  readonly gained: readonly AuthorityProgressKind[];
  readonly state: NoProgressGovernorState;
}

export interface NoProgressTerminalDecision {
  readonly action: 'terminalize';
  readonly reason: 'control_no_progress_exhausted';
  readonly gained: readonly [];
  /** The common host terminal reducer owns publication; the model does not get
   * another discovery/planning turn after this decision. */
  readonly owner: 'host_terminal_reducer';
  readonly requiredProjection: 'factual_internal_failure';
  readonly publicResumable: false;
  readonly blockedAttemptClass: Exclude<
    NoProgressAttemptClass,
    'task_work' | 'terminal_projection'
  >;
  readonly consequentialEffectState: Exclude<NoProgressEffectState, 'unknown'>;
  readonly resumeOn: readonly ['authority_progress', 'user_input'];
  readonly state: NoProgressGovernorState;
}

export interface NoProgressRecoverDecision {
  readonly action: 'recover';
  readonly reason: 'host_recovery_available';
  readonly gained: readonly [];
  readonly owner: 'host_recovery_state';
  readonly state: NoProgressGovernorState;
}

export interface NoProgressReconcileDecision {
  readonly action: 'reconcile';
  readonly reason: 'effect_reconciliation_required';
  readonly gained: readonly [];
  readonly owner: 'reconciliation';
  readonly state: NoProgressGovernorState;
}

export type NoProgressDecision =
  | NoProgressContinueDecision
  | NoProgressTerminalDecision
  | NoProgressRecoverDecision
  | NoProgressReconcileDecision;

const METERED_ATTEMPTS = new Set<NoProgressAttemptClass>([
  'authority_acquisition',
  'dependency_lookup',
  'plan_admission',
  'zero_crossing_repair',
]);

const ATTEMPT_CLASSES = new Set<NoProgressAttemptClass>([
  ...METERED_ATTEMPTS,
  'task_work',
  'terminal_projection',
]);

function normalizedTaskKey(value: string): string {
  const key = value.trim();
  if (!key) throw new Error('NoProgressGovernor requires an accepted-task key.');
  if (key.length > 512) throw new Error('NoProgressGovernor task key exceeds 512 characters.');
  return key;
}

function normalizedAuthorityToken(value: string, kind: AuthorityProgressKind): string {
  if (typeof value !== 'string') {
    throw new Error(`NoProgressGovernor requires a string ${kind} authority token.`);
  }
  const token = value.trim();
  if (!token) throw new Error(`NoProgressGovernor requires a non-empty ${kind} authority token.`);
  if (token.length > 2048) {
    throw new Error(`NoProgressGovernor ${kind} authority token exceeds 2048 characters.`);
  }
  return token;
}

/** Canonical set projection: source ordering and duplicate rows are not work. */
export function normalizeAuthorityProgressSnapshot(
  snapshot: AuthorityProgressSnapshot,
): AuthorityProgressSnapshot {
  const normalized = {} as Record<AuthorityProgressKind, readonly string[]>;
  for (const kind of AUTHORITY_PROGRESS_KINDS) {
    if (!Array.isArray(snapshot[kind])) {
      throw new Error(`NoProgressGovernor requires an array for ${kind} authority.`);
    }
    normalized[kind] = Object.freeze([...new Set(
      snapshot[kind].map((token) => normalizedAuthorityToken(token, kind)),
    )].sort());
  }
  return Object.freeze(normalized);
}

function mergeAuthority(
  prior: AuthorityProgressSnapshot,
  current: AuthorityProgressSnapshot,
): { authority: AuthorityProgressSnapshot; gained: AuthorityProgressKind[] } {
  const merged = {} as Record<AuthorityProgressKind, readonly string[]>;
  const gained: AuthorityProgressKind[] = [];
  for (const kind of AUTHORITY_PROGRESS_KINDS) {
    const known = new Set(prior[kind]);
    const additions = current[kind].filter((token) => !known.has(token));
    if (additions.length > 0) gained.push(kind);
    merged[kind] = Object.freeze([...new Set([...prior[kind], ...current[kind]])].sort());
  }
  return { authority: Object.freeze(merged), gained };
}

export function initializeNoProgressGovernor(input: {
  taskKey: string;
  authority: AuthorityProgressSnapshot;
}): NoProgressGovernorState {
  return Object.freeze({
    version: NO_PROGRESS_GOVERNOR_VERSION,
    taskKey: normalizedTaskKey(input.taskKey),
    authority: normalizeAuthorityProgressSnapshot(input.authority),
    noProgressAttempts: 0,
    retriesRemaining: NO_PROGRESS_RETRY_BUDGET,
    seenConsequenceKeys: Object.freeze([]),
    lastConsequence: null,
    stageTransitionsRemaining: NO_PROGRESS_STAGE_TRANSITION_BUDGET,
    observations: 0,
  });
}

/**
 * Validate a serialized host checkpoint before it can restore a retry budget.
 * In particular, arbitrary paused-state JSON cannot turn an already-spent
 * retry back into a clean retry.
 */
export function parseNoProgressGovernorState(value: unknown): NoProgressGovernorState | null {
  const candidate = record(value);
  if (!candidate || (candidate.version !== 1 && candidate.version !== NO_PROGRESS_GOVERNOR_VERSION)) {
    return null;
  }
  if (
    !Number.isSafeInteger(candidate.noProgressAttempts)
    || Number(candidate.noProgressAttempts) < 0
    || !Number.isSafeInteger(candidate.observations)
    || Number(candidate.observations) < 0
    || (candidate.retriesRemaining !== 0
      && candidate.retriesRemaining !== NO_PROGRESS_RETRY_BUDGET)
  ) return null;
  const noProgressAttempts = Number(candidate.noProgressAttempts);
  const observations = Number(candidate.observations);
  if (observations < noProgressAttempts) return null;
  if (
    (candidate.retriesRemaining === NO_PROGRESS_RETRY_BUDGET && noProgressAttempts !== 0)
    || (candidate.retriesRemaining === 0 && noProgressAttempts === 0)
  ) return null;
  try {
    if (candidate.version === 1) {
      // V1 knew only the single retry bit. Preserve that spent budget without
      // inventing unseen stages: an old paused turn may resume, but it cannot
      // gain the new acyclic transition budget merely by omitting V2 fields.
      return Object.freeze({
        version: NO_PROGRESS_GOVERNOR_VERSION,
        taskKey: normalizedTaskKey(candidate.taskKey as string),
        authority: normalizeAuthorityProgressSnapshot(
          candidate.authority as AuthorityProgressSnapshot,
        ),
        noProgressAttempts,
        retriesRemaining: candidate.retriesRemaining,
        seenConsequenceKeys: Object.freeze([]),
        lastConsequence: null,
        stageTransitionsRemaining: 0,
        observations,
      }) satisfies NoProgressGovernorState;
    }
    if (
      !Array.isArray(candidate.seenConsequenceKeys)
      || candidate.seenConsequenceKeys.length > NO_PROGRESS_STAGE_TRANSITION_BUDGET + 1
      || !Number.isSafeInteger(candidate.stageTransitionsRemaining)
      || Number(candidate.stageTransitionsRemaining) < 0
      || Number(candidate.stageTransitionsRemaining) > NO_PROGRESS_STAGE_TRANSITION_BUDGET
    ) return null;
    const seenConsequenceKeys = Object.freeze([...new Set(
      candidate.seenConsequenceKeys.map((key) => {
        if (typeof key !== 'string' || !CONSEQUENCE_KEY_RE.test(key)) {
          throw new Error('invalid consequence key');
        }
        return key;
      }),
    )]);
    if (seenConsequenceKeys.length !== candidate.seenConsequenceKeys.length) return null;
    const lastConsequence = candidate.lastConsequence === null
      ? null
      : parseNoProgressConsequence(candidate.lastConsequence);
    if (
      (lastConsequence === null && seenConsequenceKeys.length !== 0)
      || (lastConsequence !== null && !seenConsequenceKeys.includes(lastConsequence.key))
      || (candidate.retriesRemaining === NO_PROGRESS_RETRY_BUDGET
        && (seenConsequenceKeys.length !== 0
          || Number(candidate.stageTransitionsRemaining) !== NO_PROGRESS_STAGE_TRANSITION_BUDGET))
    ) return null;
    const state = Object.freeze({
      version: NO_PROGRESS_GOVERNOR_VERSION,
      taskKey: normalizedTaskKey(candidate.taskKey as string),
      authority: normalizeAuthorityProgressSnapshot(
        candidate.authority as AuthorityProgressSnapshot,
      ),
      noProgressAttempts,
      retriesRemaining: candidate.retriesRemaining,
      seenConsequenceKeys,
      lastConsequence,
      stageTransitionsRemaining: Number(candidate.stageTransitionsRemaining),
      observations,
    }) satisfies NoProgressGovernorState;
    return state;
  } catch {
    return null;
  }
}

/**
 * Reduce one fully paired host frame.
 *
 * A new exact token in any authority dimension resets the one-retry budget.
 * A metered frame with no new token spends that retry. The next such frame
 * terminalizes without another model call. Unmetered task work never spends
 * the budget, though evidence/effect tokens it earns still reset it.
 */
export function observeNoProgress(
  state: NoProgressGovernorState,
  input: ObserveNoProgressInput,
): NoProgressDecision {
  if (state.version !== NO_PROGRESS_GOVERNOR_VERSION) {
    throw new Error(`Unsupported NoProgressGovernor version: ${String(state.version)}.`);
  }
  const taskKey = normalizedTaskKey(input.taskKey);
  if (taskKey !== state.taskKey) {
    throw new Error('NoProgressGovernor observation belongs to a different accepted task.');
  }
  if (!ATTEMPT_CLASSES.has(input.attemptClass)) {
    throw new Error(`NoProgressGovernor received an unknown attempt class: ${String(input.attemptClass)}.`);
  }
  const current = normalizeAuthorityProgressSnapshot(input.authority);
  const { authority, gained } = mergeAuthority(state.authority, current);
  const observations = state.observations + 1;
  const consequence = input.consequence === undefined
    ? undefined
    : parseNoProgressConsequence(input.consequence);
  if (input.consequence !== undefined && !consequence) {
    throw new Error('NoProgressGovernor received an invalid host consequence.');
  }

  if (consequence?.recovery === 'reconcile' || consequence?.effectState === 'unknown') {
    const next = Object.freeze({
      ...state,
      authority,
      observations,
    }) satisfies NoProgressGovernorState;
    return Object.freeze({
      action: 'reconcile',
      reason: 'effect_reconciliation_required',
      gained: Object.freeze([]) as readonly [],
      owner: 'reconciliation',
      state: next,
    });
  }

  if (gained.length > 0) {
    const next = Object.freeze({
      ...state,
      authority,
      noProgressAttempts: 0,
      retriesRemaining: NO_PROGRESS_RETRY_BUDGET,
      seenConsequenceKeys: Object.freeze([]),
      lastConsequence: null,
      stageTransitionsRemaining: NO_PROGRESS_STAGE_TRANSITION_BUDGET,
      observations,
    }) satisfies NoProgressGovernorState;
    return Object.freeze({
      action: 'continue',
      reason: 'authority_progress',
      gained: Object.freeze(gained),
      state: next,
    });
  }

  if (!METERED_ATTEMPTS.has(input.attemptClass)) {
    const next = Object.freeze({
      ...state,
      authority,
      observations,
    }) satisfies NoProgressGovernorState;
    return Object.freeze({
      action: 'continue',
      reason: 'unmetered_attempt',
      gained: Object.freeze([]) as readonly AuthorityProgressKind[],
      state: next,
    });
  }

  const noProgressAttempts = state.noProgressAttempts + 1;
  const terminal = (
    next: NoProgressGovernorState,
    effectState: Exclude<NoProgressEffectState, 'unknown'> = 'not_started',
  ): NoProgressTerminalDecision => Object.freeze({
    action: 'terminalize',
    reason: 'control_no_progress_exhausted',
    gained: Object.freeze([]) as readonly [],
    owner: 'host_terminal_reducer',
    requiredProjection: 'factual_internal_failure',
    publicResumable: false,
    blockedAttemptClass: input.attemptClass as NoProgressTerminalDecision['blockedAttemptClass'],
    consequentialEffectState: effectState,
    resumeOn: Object.freeze(['authority_progress', 'user_input']) as readonly [
      'authority_progress',
      'user_input',
    ],
    state: next,
  });

  if (consequence) {
    if (state.seenConsequenceKeys.includes(consequence.key)) {
      return terminal(Object.freeze({
        ...state,
        authority,
        noProgressAttempts,
        retriesRemaining: 0 as const,
        observations,
      }) satisfies NoProgressGovernorState, consequence.effectState);
    }

    const firstConsequence = state.lastConsequence === null;
    // An untyped lookup may have spent the clean retry before a later tool
    // returns the first host-validated repair consequence. Treat that first
    // typed stage as bounded structural progress: otherwise a harmless result
    // lookup can prevent the model from ever seeing the exact schema or
    // admission error it must repair. Repeating this consequence still
    // terminates above, and later distinct stages remain capped by the
    // transition budget. V1 checkpoints restore that budget as zero and
    // therefore cannot gain new continuation authority after upgrade.
    if (state.stageTransitionsRemaining === 0) {
      return terminal(Object.freeze({
        ...state,
        authority,
        noProgressAttempts,
        retriesRemaining: 0 as const,
        observations,
      }) satisfies NoProgressGovernorState, consequence.effectState);
    }

    const seenConsequenceKeys = Object.freeze([
      ...state.seenConsequenceKeys,
      consequence.key,
    ]);
    const stageTransitionsRemaining = firstConsequence
      ? (state.retriesRemaining === 0
        ? Math.max(0, state.stageTransitionsRemaining - 1)
        : state.stageTransitionsRemaining)
      : Math.max(0, state.stageTransitionsRemaining - 1);
    const next = Object.freeze({
      ...state,
      authority,
      noProgressAttempts,
      retriesRemaining: 0 as const,
      seenConsequenceKeys,
      lastConsequence: consequence,
      stageTransitionsRemaining,
      observations,
    }) satisfies NoProgressGovernorState;
    if (consequence.recovery === 'retry_host') {
      return Object.freeze({
        action: 'recover',
        reason: 'host_recovery_available',
        gained: Object.freeze([]) as readonly [],
        owner: 'host_recovery_state',
        state: next,
      });
    }
    return Object.freeze({
      action: 'continue',
      reason: consequence.recovery === 'ask_user'
        ? 'user_input_required'
        : firstConsequence && state.retriesRemaining > 0
          ? 'retry_available'
          : 'consequence_progress',
      gained: Object.freeze([]) as readonly AuthorityProgressKind[],
      state: next,
    });
  }

  if (state.retriesRemaining > 0) {
    const next = Object.freeze({
      ...state,
      authority,
      noProgressAttempts,
      retriesRemaining: 0 as const,
      observations,
    }) satisfies NoProgressGovernorState;
    return Object.freeze({
      action: 'continue',
      reason: 'retry_available',
      gained: Object.freeze([]) as readonly AuthorityProgressKind[],
      state: next,
    });
  }

  const next = Object.freeze({
    ...state,
    authority,
    noProgressAttempts,
    retriesRemaining: 0 as const,
    observations,
  }) satisfies NoProgressGovernorState;
  return terminal(next);
}
