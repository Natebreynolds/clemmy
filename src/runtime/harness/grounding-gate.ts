/**
 * Grounding gate — integrity verification at the external-write boundary.
 *
 * Born from the 2026-06-11 Eley incident: the extraction worker produced a
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
 * are two legitimate sends (live false-positive: person1@x.com and
 * person2@x.com both carry target "x.com" → batch self-blocks). The
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
    'Respond with the structured verdict.',
  ].join('\n');
}

export interface GroundingVerdict {
  grounded: boolean;
  /** One sentence: the contradiction found, or why it passed. */
  reason: string;
}

export type GroundingJudgeFn = (payload: string, sources: GroundingSource[]) => Promise<GroundingVerdict>;

// Test injection seam — brackets.ts integration tests stub the judge.
let judgeOverride: GroundingJudgeFn | null = null;
export function _setGroundingJudgeForTests(fn: GroundingJudgeFn | null): void { judgeOverride = fn; }

/** Real judge: one fast-model call, structured output, throws on infra error
 *  (caller converts to fail-open). Dynamic imports keep brackets.ts free of
 *  an SDK dependency at module load. */
async function runGroundingJudge(payload: string, sources: GroundingSource[]): Promise<GroundingVerdict> {
  const [{ Agent, Runner }, { z }, { MODELS }, { normalizeZodForCodexStrict }, { resolveBoundaryJudge }] = await Promise.all([
    import('@openai/agents'),
    import('zod'),
    import('../../config.js'),
    import('../schema-normalizer.js'),
    import('./debate-model.js'),
  ]);
  const VerdictSchema = z.object({
    grounded: z.boolean().describe('False ONLY on a concrete contradiction between the payload and the target\'s source artifacts (or between the sources themselves) on a load-bearing fact.'),
    reason: z.string().describe('One short sentence: the specific contradiction, or why the payload is consistent.'),
  });
  const agent = new Agent({
    name: 'GroundingJudge',
    instructions: 'Verify outgoing external-write payloads against the session\'s own source artifacts. Output only the structured verdict.',
    // Cross-family boundary judge (a Codex/GLM brain is not graded by its own
    // family); falls open to MODELS.fast when no different family is available.
    model: resolveBoundaryJudge().model ?? MODELS.fast,
    outputType: normalizeZodForCodexStrict(VerdictSchema) as typeof VerdictSchema,
    tools: [],
  });
  const runner = new Runner({ workflowName: 'clementine-grounding-judge' });
  const result = await runner.run(agent, buildGroundingPrompt(payload, sources), { maxTurns: 1 });
  const parsed = VerdictSchema.safeParse(result.finalOutput);
  if (!parsed.success) throw new Error('grounding judge output did not parse');
  return parsed.data;
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
const duplicateWarned = new Set<string>();
export function _resetDuplicateStateForTests(): void { duplicateWarned.clear(); }

export interface DuplicateCheckInput {
  sessionId: string;
  shapeKey: string | undefined;
  targets: string[];
  /** Prior external_write events' (shapeKey, targets) for this session. */
  priorWrites: Array<{ shapeKey?: string; targets?: string[] }>;
}

/** Pure: does this write hit a (shape, target) pair already written this
 *  session, and has the model not yet been warned about it? */
export function detectDuplicateTarget(input: DuplicateCheckInput): { duplicate: boolean; target?: string; warnedKey?: string } {
  if (!input.shapeKey || input.targets.length === 0) return { duplicate: false };
  for (const target of input.targets) {
    const hit = input.priorWrites.some((w) => w.shapeKey === input.shapeKey && (w.targets ?? []).includes(target));
    if (!hit) continue;
    const warnedKey = `${input.sessionId}::${input.shapeKey}::${target}`;
    if (duplicateWarned.has(warnedKey)) return { duplicate: false };
    return { duplicate: true, target, warnedKey };
  }
  return { duplicate: false };
}

export function markDuplicateWarned(warnedKey: string): void { duplicateWarned.add(warnedKey); }

export class DuplicateExternalWriteError extends Error {
  public readonly toolName: string;
  public readonly target: string;
  constructor(opts: { toolName: string; shapeKey: string | undefined; target: string }) {
    super(
      `DUPLICATE_EXTERNAL_WRITE: this session already performed a ${opts.shapeKey ?? opts.toolName} write to ${opts.target}. ` +
        'An approved batch is NOT standing permission to contact the same target twice. ' +
        'If the user explicitly asked for a re-send, retry this call once and it will go through. ' +
        'Otherwise STOP and confirm with the user (ask_user_question) before re-contacting — include who already received what.',
    );
    this.name = 'DuplicateExternalWriteError';
    this.toolName = opts.toolName;
    this.target = opts.target;
  }
}
