/**
 * Grounding gate — integrity verification at the external-write boundary.
 *
 * Born from a client-data integrity incident: the extraction worker produced a
 * CORRECT email ("workers compensation lawyer Denver"), the orchestrator
 * re-wrote 17 drafts in its own (compacted) context and swapped in
 * "Houston" from a different record, and the send worker faithfully sent
 * the corrupted result. Every existing check passed: the objective judge
 * verifies work HAPPENED (artifact exists, send logged), the constraint
 * gate verifies POLICY (right mailbox), the confirm-first gate verifies
 * APPROVAL (batch was authorized). Nothing verified the DATA stayed
 * faithful between research and send.
 *
 * The failure class is universal, not email-specific: any load-bearing
 * value (city, name, amount, record id) that transits the model's context
 * and is RE-GENERATED on the way out can silently mutate — especially
 * after compaction. So the fix sits at the one chokepoint every tool
 * flavor passes through (wrapToolForHarness), tool-agnostic:
 *
 *   1. GROUNDING: before an irreversible external write (SEND/PUBLISH),
 *      retrieve this session's stored artifacts that mention the write's
 *      TARGET (recipient email/name/domain) and have an independent fast
 *      judge verify the outgoing payload against them. Contradiction →
 *      soft-block with the discrepancy so the model re-fetches the
 *      verbatim source and rebuilds; repeated failure → instruct it to
 *      stop and check in with the user.
 *
 *   2. DUPLICATE-TARGET speed bump: an irreversible write to a target
 *      that ALREADY received a same-shape write this session soft-blocks
 *      ONCE — the model must consciously confirm (with the user when the
 *      user didn't explicitly ask for a re-send) instead of silently
 *      re-firing a whole wave. The 2026-06-11 double-send (all 17
 *      recipients emailed twice) sails through every other gate because
 *      the batch was approved — approval is not idempotency.
 *
 * Fail-open by design: a judge error, missing sources, or an unparseable
 * payload NEVER blocks the write (this gate must not wedge legitimate
 * work). It only blocks on a CONCRETE contradiction or a concrete
 * duplicate. Env: CLEMMY_GROUNDING_GATE=off disables, =on (default)
 * gates irreversible writes.
 */
import { getRuntimeEnv } from '../../config.js';
import { hasApprovedResendConsent } from './approval-registry.js';
import { searchToolOutputs } from './eventlog.js';

// ─────────────────────────────────────────────────────────────────
// Config + pure classification
// ─────────────────────────────────────────────────────────────────

export function isGroundingGateEnabled(): boolean {
  const raw = (getRuntimeEnv('CLEMMY_GROUNDING_GATE', 'on') ?? 'on').toLowerCase();
  return raw !== 'off' && raw !== 'false' && raw !== '0';
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** Arg keys whose values identify the write's TARGET. Generic on purpose —
 *  covers composio email/CRM shapes and most custom tools. */
const TARGET_KEY_RE = /(^|_)(to|to_email|to_name|recipient|recipients|email|contact_id|record_id|lead_id|account_id|channel|phone|to_number)$/i;

/**
 * Does this call carry a resolvable recipient/TARGET FIELD? Generic on purpose —
 * anchored on the effect (a send/write needs a target), not on any tool name. A
 * top-level (or composio-wrapped `arguments`) key whose NAME is a target field and
 * whose value is present counts. Distinct from extractTargetKeys, which also mines
 * body text for emails — here we mean the WRITE'S recipient, not a stray address in
 * the body. Used to validate a send before dispatch: a target-less send can't be
 * validated and would misroute, so the caller asks for the target instead.
 */
export function argsHaveSendTarget(rawArgs: unknown): boolean {
  const hasTargetField = (obj: Record<string, unknown>): boolean => {
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined || value === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (TARGET_KEY_RE.test(key)) return true;
    }
    return false;
  };
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) return false;
  const obj = rawArgs as Record<string, unknown>;
  if (hasTargetField(obj)) return true;
  // Composio wrapper: the real args are a JSON string under `arguments`.
  if (typeof obj.arguments === 'string') {
    try {
      const inner = JSON.parse(obj.arguments) as unknown;
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) return hasTargetField(inner as Record<string, unknown>);
    } catch { /* not JSON — no nested target */ }
  }
  return false;
}

/**
 * Extract the identity of WHO/WHAT this write targets from the call args.
 * Returns lowercase search terms (emails, domains, names, ids). Pure.
 */
export function extractTargetKeys(rawArgs: unknown): string[] {
  const keys = new Set<string>();
  const visit = (value: unknown, keyHint?: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      // JSON-encoded nested args (composio's `arguments` field is a string)
      if ((value.startsWith('{') || value.startsWith('[')) && value.length < 50_000) {
        try { visit(JSON.parse(value)); return; } catch { /* treat as plain string */ }
      }
      for (const m of value.match(EMAIL_RE) ?? []) {
        const email = m.toLowerCase();
        keys.add(email);
        const domain = email.split('@')[1];
        // The mailbox domain identifies the org; drop generic providers.
        if (domain && !/^(gmail|outlook|hotmail|yahoo|icloud|aol|proton|me)\./.test(domain)) keys.add(domain);
      }
      if (keyHint && TARGET_KEY_RE.test(keyHint) && !value.includes('@') && value.length >= 3 && value.length <= 80) {
        keys.add(value.toLowerCase());
      }
      return;
    }
    if (Array.isArray(value)) { for (const v of value) visit(v, keyHint); return; }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, k);
    }
  };
  visit(rawArgs);
  // 'me' is the composio user_id placeholder, never a target.
  keys.delete('me');
  return [...keys];
}

/**
 * Identity keys for the DUPLICATE check — strictly who/what receives the
 * write: full email addresses, record/contact ids, phone numbers. NOT the
 * org domain and NOT display names: two different people at the same firm
 * are two legitimate sends (live false-positive: person1@site.example and
 * person2@site.example both carry target "site.example" → batch self-blocks). The
 * broader extractTargetKeys (domains, names) is for SOURCE RETRIEVAL only.
 */
const DUP_ID_KEY_RE = /(^|_)(contact_id|record_id|lead_id|account_id|to_number|phone)$/i;
export function extractDuplicateIdentityKeys(rawArgs: unknown): string[] {
  const keys = new Set<string>();
  const visit = (value: unknown, keyHint?: string): void => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      if ((value.startsWith('{') || value.startsWith('[')) && value.length < 50_000) {
        try { visit(JSON.parse(value)); return; } catch { /* plain string */ }
      }
      for (const m of value.match(EMAIL_RE) ?? []) keys.add(m.toLowerCase());
      if (keyHint && DUP_ID_KEY_RE.test(keyHint) && value.length >= 3 && value.length <= 80) keys.add(value.toLowerCase());
      return;
    }
    if (Array.isArray(value)) { for (const v of value) visit(v, keyHint); return; }
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, k);
    }
  };
  visit(rawArgs);
  keys.delete('me');
  return [...keys];
}

/** Render the outgoing payload for the judge. Clipped; pure. */
export function renderPayloadForJudge(toolName: string, rawArgs: unknown, max = 4000): string {
  let text: string;
  try { text = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs, null, 1); }
  catch { text = String(rawArgs); }
  if (text.length > max) text = `${text.slice(0, max)}\n…[clipped]`;
  return `Tool: ${toolName}\nOutgoing payload:\n${text}`;
}

export interface GroundingSource { callId: string; tool: string | null; excerpt: string; createdAt: string }

/**
 * Rank + clip the retrieved artifacts. Send-confirmations ("SUCCESS: …")
 * are evidence that a PREVIOUS send happened, not that its content was
 * correct — they'd make a repeated corruption look "grounded" (the live
 * double-send re-sent the same wrong Houston email; wave-1's confirmation
 * was in the store). Research/extraction artifacts rank first. Pure.
 */
export function rankSources(
  rows: Array<{ callId: string; tool: string | null; output: string; createdAt: string }>,
  opts: { limit?: number; clipChars?: number } = {},
): GroundingSource[] {
  const limit = opts.limit ?? 4;
  const clip = opts.clipChars ?? 5000;
  const isConfirmation = (o: string) => /^\s*SUCCESS:/.test(o);
  const ranked = [...rows].sort((a, b) => Number(isConfirmation(a.output)) - Number(isConfirmation(b.output)));
  return ranked.slice(0, limit).map((r) => ({
    callId: r.callId,
    tool: r.tool,
    createdAt: r.createdAt,
    excerpt: r.output.length > clip ? `${r.output.slice(0, clip)}\n…[clipped]` : r.output,
  }));
}

export function buildGroundingPrompt(payload: string, sources: GroundingSource[]): string {
  return [
    'You are a data-integrity judge. An agent is about to perform an IRREVERSIBLE external write (e.g. send an email, publish a post).',
    'Verify the outgoing payload against the source artifacts the agent itself gathered for this SAME target earlier in the session.',
    '',
    'Check ONLY load-bearing facts about the target: identity (name/company), geography (city/region), practice or industry claims, specific numbers, and claims of the form "I looked at X about you".',
    'Generic template language, greetings, links, and the agent\'s own product pitch need no support.',
    'A prior send-confirmation (a line like "SUCCESS: … subject …") proves a send HAPPENED — it is NOT evidence its content was correct. Prefer research/extraction artifacts.',
    'If two sources CONTRADICT each other about a load-bearing fact for this target, the payload is NOT grounded — it must be reconciled before an irreversible send.',
    'Mark grounded=false ONLY for a concrete contradiction or a load-bearing claim about the target that the sources actively contradict. Missing/irrelevant sources or unverifiable-but-plausible content → grounded=true (fail open).',
    '',
    payload,
    '',
    '=== Source artifacts for this target (newest first, research before confirmations) ===',
    ...sources.map((s) => `--- ${s.callId} (${s.tool ?? 'unknown'}, ${s.createdAt}) ---\n${s.excerpt}`),
    '',
    'Respond with exactly one verdict line.',
  ].join('\n');
}

export interface GroundingVerdict {
  grounded: boolean;
  /** One sentence: the contradiction found, or why it passed. */
  reason: string;
}

export type GroundingJudgeFn = (payload: string, sources: GroundingSource[]) => Promise<GroundingVerdict>;

/** Parse the judge's ONE-LINE plain-text verdict — "GROUNDED: <why>" /
 *  "UNGROUNDED: <contradiction>" — into the verdict shape. Returns null on a
 *  no-marker response (caller records 'invalid' + throws → fail-open). Reason is
 *  clamped in code, never validated. Exported so the parser is unit-testable with
 *  fake finalOutput strings. */
export function parseGroundingVerdict(finalOutput: unknown): GroundingVerdict | null {
  const raw = String(finalOutput ?? '').trim();
  const match = /^\s*(GROUNDED|UNGROUNDED)\s*:?\s*(.*)$/im.exec(raw);
  if (!match) return null;
  return { grounded: match[1].toUpperCase() === 'GROUNDED', reason: (match[2] || '').slice(0, 400) };
}

// Test injection seam — brackets.ts integration tests stub the judge.
let judgeOverride: GroundingJudgeFn | null = null;
export function _setGroundingJudgeForTests(fn: GroundingJudgeFn | null): void { judgeOverride = fn; }

/** Real judge: one fast-model call, structured output, throws on infra error
 *  (caller converts to fail-open). Dynamic imports keep brackets.ts free of
 *  an SDK dependency at module load. */
async function runGroundingJudge(payload: string, sources: GroundingSource[]): Promise<GroundingVerdict> {
  const [{ Agent, Runner }, { resolveBoundaryJudge, resolveBoundaryJudgeHedge }, { withJudgeHedge, recordJudgeMetric }] = await Promise.all([
    import('@openai/agents'),
    import('./debate-model.js'),
    import('./judge-family.js'),
  ]);
  // PLAIN-TEXT verdict, parsed deterministically — same treatment the batch
  // certify (2e10714e) and goal-fidelity (2538d916) judges got after structured
  // output flaked live on the safety path (schema validation rejecting VALID
  // verdicts → judge "unavailable"). One line, two markers, a regex: nothing
  // left to fail on presentation.
  //
  // HEDGED (judge-family.ts): a slow/dead primary is raced by a cheap judge
  // from the other flagship family after the hedge delay — a real verdict at
  // ~hedge-delay+seconds instead of a 25s advisory downgrade.
  const routing = resolveBoundaryJudge();
  const hedgeRouting = resolveBoundaryJudgeHedge(routing);
  type Routing = typeof routing;
  const mkAgent = (r: Routing) =>
    new Agent({
      name: 'GroundingJudge',
      instructions: [
        'Verify an outgoing external-write payload against the session\'s own source artifacts.',
        'Reply with EXACTLY ONE LINE and nothing else, one of:',
        '"GROUNDED: <one short sentence why the payload is consistent>" — use this unless there is a CONCRETE contradiction between the payload and the target\'s source artifacts (or between the sources themselves) on a load-bearing fact;',
        '"UNGROUNDED: <the specific contradiction found>" — a load-bearing fact in the payload contradicts the sources.',
      ].join(' '),
      // Cross-family boundary judge (a Codex/GLM brain is not graded by its own
      // family); falls open to the brain-family-safe cheap id (routing.modelId, never
      // a repurposed BYO fast slot) when no different family is available.
      model: r.model ?? r.modelId,
      modelSettings: { reasoning: { effort: 'low' } },
      tools: [],
    });
  const startedAt = Date.now();
  const record = (outcome: 'passed' | 'blocked' | 'timeout' | 'invalid' | 'error', r: Routing = routing) => {
    recordJudgeMetric({
      lane: 'grounding',
      outcome,
      durationMs: Date.now() - startedAt,
      modelId: r.modelId,
      judgeFamily: r.judgeFamily,
      brainFamily: r.brainFamily,
      selfJudge: r.selfJudge,
    });
  };
  class InvalidVerdict extends Error {}
  const prompt = buildGroundingPrompt(payload, sources);
  const attempt = (r: Routing) => async (): Promise<GroundingVerdict> => {
    const runner = new Runner({ workflowName: 'clementine-grounding-judge' });
    const result = await runner.run(mkAgent(r), prompt, { maxTurns: 1 });
    const raw = String((result as { finalOutput?: unknown }).finalOutput ?? '').trim();
    const verdict = parseGroundingVerdict(raw);
    if (!verdict) throw new InvalidVerdict(`grounding judge returned no GROUNDED/UNGROUNDED verdict (got: ${raw.slice(0, 120)})`);
    return verdict;
  };
  const raced = await withJudgeHedge(attempt(routing), hedgeRouting ? attempt(hedgeRouting) : null);
  if (raced.value) {
    const winner = raced.winner === 'hedge' && hedgeRouting ? hedgeRouting : routing;
    record(raced.value.grounded ? 'passed' : 'blocked', winner);
    return raced.value;
  }
  if (raced.errors.length === 0) {
    record('timeout');
    throw new Error('grounding judge timed out');
  }
  const invalid = raced.errors.find((e) => e instanceof InvalidVerdict);
  if (invalid) {
    record('invalid');
    throw invalid;
  }
  record('error');
  throw raced.errors[0] instanceof Error ? raced.errors[0] : new Error(String(raced.errors[0]));
}

// ─────────────────────────────────────────────────────────────────
// Gate evaluation (called from brackets.ts for irreversible writes)
// ─────────────────────────────────────────────────────────────────

/** Per-(session,target) consecutive grounding failures — after 2, the
 *  block message escalates to "stop and ask the user". In-memory: a
 *  daemon restart resets the count, which only makes the gate gentler. */
const failureCounts = new Map<string, number>();
export function _resetGroundingStateForTests(): void { failureCounts.clear(); }

export interface GroundingGateResult {
  action: 'allow' | 'block';
  reason: string;
  /** Target keys extracted from the payload (telemetry). */
  targets: string[];
  /** Source call ids consulted (telemetry). */
  sourceCallIds: string[];
  /** Consecutive failures for this target including this one. */
  failureCount?: number;
}

/**
 * Evaluate grounding for an irreversible external write. Fail-open at
 * every step: no targets / no sources / judge error → allow.
 */
export async function evaluateGrounding(
  sessionId: string,
  toolName: string,
  rawArgs: unknown,
): Promise<GroundingGateResult> {
  const targets = extractTargetKeys(rawArgs);
  if (targets.length === 0) {
    return { action: 'allow', reason: 'no target identity extractable — gate stays out of the way', targets, sourceCallIds: [] };
  }
  let sources: GroundingSource[] = [];
  try {
    sources = rankSources(searchToolOutputs(sessionId, targets, { limit: 12 }));
  } catch {
    return { action: 'allow', reason: 'source retrieval failed — fail open', targets, sourceCallIds: [] };
  }
  if (sources.length === 0) {
    return { action: 'allow', reason: 'no session artifacts mention this target — nothing to verify against', targets, sourceCallIds: [] };
  }
  const payload = renderPayloadForJudge(toolName, rawArgs);
  let verdict: GroundingVerdict;
  try {
    verdict = await (judgeOverride ?? runGroundingJudge)(payload, sources);
  } catch {
    return { action: 'allow', reason: 'grounding judge unavailable — fail open', targets, sourceCallIds: sources.map((s) => s.callId) };
  }
  const targetKey = `${sessionId}::${targets[0]}`;
  if (verdict.grounded) {
    failureCounts.delete(targetKey);
    return { action: 'allow', reason: verdict.reason, targets, sourceCallIds: sources.map((s) => s.callId) };
  }
  const failures = (failureCounts.get(targetKey) ?? 0) + 1;
  failureCounts.set(targetKey, failures);
  return {
    action: 'block',
    reason: verdict.reason,
    targets,
    sourceCallIds: sources.map((s) => s.callId),
    failureCount: failures,
  };
}

/**
 * Thrown for a grounding failure. Surfaced to the model as a SOFT tool
 * error (same path as MissingExecutionWrapError) so it can recover —
 * re-fetch the verbatim source, rebuild the payload — instead of the run
 * aborting. After repeated failures it instructs an explicit user
 * check-in, per the operator contract: validate, loop until valid, and
 * when it still doesn't look right, come back to the user.
 */
export class GroundingCheckFailedError extends Error {
  public readonly toolName: string;
  public readonly targets: string[];
  public readonly failureCount: number;
  constructor(opts: { toolName: string; reason: string; targets: string[]; sourceCallIds: string[]; failureCount: number }) {
    const escalate = opts.failureCount >= 2;
    super(
      `GROUNDING_CHECK_FAILED: this irreversible ${opts.toolName} payload contradicts the session's own source artifacts for this target. ` +
        `Judge: ${opts.reason} ` +
        `Sources consulted: ${opts.sourceCallIds.slice(0, 4).join(', ')}. ` +
        (escalate
          ? 'This target has now failed grounding repeatedly — STOP. Do NOT retry the send. Use ask_user_question to show the user the discrepancy and let them decide.'
          : 'Recover: recall_tool_result the source artifacts above (or re-read the record), rebuild the payload from the VERBATIM source — do not retype from memory — then retry. If the sources themselves conflict, reconcile or ask the user before sending.'),
    );
    this.name = 'GroundingCheckFailedError';
    this.toolName = opts.toolName;
    this.targets = opts.targets;
    this.failureCount = opts.failureCount;
  }
}

// ─────────────────────────────────────────────────────────────────
// Duplicate-target speed bump
// ─────────────────────────────────────────────────────────────────

/** (session,shape,target) combos already warned once — the second attempt
 *  passes (conscious re-send after the model surfaced it / got user
 *  confirmation). A speed bump, not a wall. */
// A duplicate irreversible send to a (shape, target) already written THIS session
// is a HARD WALL, not a speed bump. The old "retry once and it passes" behavior let
// a model re-run a stale send it picked up from conversation context — the
// 2026-06-29 incident sent 3 client emails TWICE. The only way past this is the user
// EXPLICITLY re-confirming a fresh send; the model can never self-bypass by retrying.
// Stateless: a (shape, target) already in priorWrites is always a duplicate.
export function _resetDuplicateStateForTests(): void { /* stateless now — kept for test-import compatibility */ }

export interface DuplicateCheckInput {
  sessionId: string;
  shapeKey: string | undefined;
  targets: string[];
  /** Prior external_write events' (shapeKey, targets[, at]) for this session. */
  priorWrites: Array<{ shapeKey?: string; targets?: string[]; at?: string }>;
}

/** Pure + STATELESS: does this write hit a (shape, target) pair already written this
 *  session? Every hit is a HARD duplicate — there is no warn-then-pass. */
export function detectDuplicateTarget(input: DuplicateCheckInput): { duplicate: boolean; target?: string; priorAt?: string } {
  if (!input.shapeKey || input.targets.length === 0) return { duplicate: false };
  for (const target of input.targets) {
    const prior = input.priorWrites.find((w) => w.shapeKey === input.shapeKey && (w.targets ?? []).includes(target));
    if (prior) return { duplicate: true, target, priorAt: prior.at };
  }
  return { duplicate: false };
}

/**
 * S2 (gate audit 2026-07-23): the wall's own error text always promised
 * "if the user explicitly asked to send a SECOND time, confirm first" — but
 * nothing honored that confirmation: under strict posture the user could
 * approve the re-send card and the wall refused anyway. A FRESH human
 * approval naming this target, resolved AFTER the prior send, is the consent
 * artifact — effect-anchored, no text matching of user turns. Fail-closed:
 * registry unreadable or no matching row → the wall stands.
 */
export function duplicateResendConsented(sessionId: string, target: string | undefined, priorAt: string | undefined): boolean {
  if (!target) return false;
  return hasApprovedResendConsent(sessionId, target, priorAt);
}

export class DuplicateExternalWriteError extends Error {
  public readonly toolName: string;
  public readonly target: string;
  constructor(opts: { toolName: string; shapeKey: string | undefined; target: string }) {
    super(
      `DUPLICATE_EXTERNAL_WRITE (REFUSED): this session ALREADY sent a ${opts.shapeKey ?? opts.toolName} to ${opts.target}, and that send SUCCEEDED. ` +
        'This duplicate is REFUSED to prevent a double-send — retrying will be refused again, so do NOT retry. ' +
        'An approved batch is NOT standing permission to contact the same target twice, and a prior turn that errored AFTER sending was NOT a failed send. ' +
        'If the user EXPLICITLY wants this target contacted a SECOND time, request the send so a fresh approval card is raised — a card the user approves AFTER the prior send authorizes the resend and this wall will honor it. Otherwise STOP and tell the user exactly what already went out.',
    );
    this.name = 'DuplicateExternalWriteError';
    this.toolName = opts.toolName;
    this.target = opts.target;
  }
}
