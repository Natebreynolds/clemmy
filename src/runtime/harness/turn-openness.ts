/**
 * TURN OPENNESS — what is genuinely unsettled about this request, resolved by
 * a separate pass BEFORE the work starts.
 *
 * Why this is its own pass, and not a prompt line (live 2026-08-07 + the
 * published evidence behind it):
 *
 *  • A model deciding "should I ask?" inside the same generation that is trying
 *    to COMPLETE the task will not ask. Asked to judge ambiguity in isolation,
 *    models are right 60-80% of the time; asked to answer an ambiguous request,
 *    they ask a question in a few percent of cases and confidently proceed in
 *    the rest. Escalating the instruction barely moves it — preference training
 *    ranks a confident answer above a question, so the behaviour is trained
 *    out. Two live runs here failed exactly that way: one ignored an explicit
 *    alignment directive, the other never triggered one.
 *  • The mirror-image mistake is a classifier over the request TEXT. That is
 *    what this replaces. A closed vocabulary of verbs and destinations cannot
 *    know that the toolkit the user just named is connected and proven — ours
 *    resolved a live, proven capability in the same turn its classifier called
 *    the request unremarkable. The decision has to see the runtime's own state.
 *
 * So the question is asked of a DIFFERENT model, cheaply, with the runtime's
 * facts in hand, and its answer is DATA the assistant then acts on in its own
 * voice. The signal is deliberately the SPREAD ACROSS READINGS — enumerate the
 * ways this request could reasonably be taken, and report only where those
 * readings would produce different results. Self-reported confidence is not
 * used: asking a model "are you unsure?" is the weakest known trigger for this,
 * losing to enumeration in every published comparison.
 *
 * TIMING is the reason it runs at preflight rather than at the write. A
 * goal-level question loses nearly all of its value once execution is under
 * way, and a question asked past the midpoint of a run measures WORSE than
 * never asking at all. The existing goal-fidelity judge sits at the
 * irreversible write — the right place to catch drift, far too late to settle
 * what the user meant.
 *
 * FAIL-OPEN, always. No verdict, a slow verdict, an unparseable verdict, or a
 * disabled feature all resolve to "nothing open" and the turn proceeds exactly
 * as it does today. This pass may make a turn better informed; it may never
 * make one fail.
 */
import { getRuntimeEnv } from '../../config.js';
import { classifyCanonicalExternalEffect } from './execution-gate.js';

export interface TurnOpenness {
  /** Dimensions on which reasonable readings DISAGREE materially. Never empty
   *  when present — a settled request resolves to null, not to an empty list. */
  open: string[];
}

/** Kill-switch only. Validated behaviour ships on by default; `off` is an
 *  operator escape hatch, never a rollout flag. */
export function turnOpennessEnabled(): boolean {
  const v = (getRuntimeEnv('CLEMMY_TURN_OPENNESS', 'on') ?? 'on').trim().toLowerCase();
  return v !== 'off' && v !== '0' && v !== 'false' && v !== 'no';
}

/** Hard ceiling on what this pass may cost a turn. It runs on the critical
 *  path before the model speaks, so a slow judge must cost the turn nothing
 *  rather than delaying the reply. */
export function turnOpennessTimeoutMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_TURN_OPENNESS_TIMEOUT_MS', '') ?? '', 10);
  return Number.isSafeInteger(raw) && raw >= 500 && raw <= 20_000 ? raw : 4_000;
}

const MAX_OPEN_DIMENSIONS = 3;
const MAX_DIMENSION_CHARS = 120;

/**
 * Is this turn worth the pass at all?
 *
 * The first cut of this gate asked only whether the runtime had resolved ANY
 * capability, and that was wrong in the way that matters: a proven capability
 * is just as likely to be a read. "What's on my calendar" resolves a proven
 * LIST carrier and is not ambiguous in any way worth a question — taxing it
 * spends latency on every ordinary turn and trains the user to tune the
 * assistant out. A suite pin caught it: ordinary chat is supposed to reach the
 * same seam and pay nothing for it.
 *
 * The honest signal is the EFFECT the resolved capabilities carry, judged by
 * the same canonical classifier every gate shares — so "is this turn about to
 * change something" cannot disagree between this pass and the boundary that
 * ultimately enforces it. Reads cost nothing; only a turn that can change the
 * world is worth settling first. No verbs, no destinations, no vocabulary to
 * maintain: the taxonomy already exists and is already the authority.
 */
export function turnOpennessWarranted(
  entries: ReadonlyArray<{ kind: string; identifier: string }>,
  classify: (identifier: string) => { mutating: boolean } = defaultClassify,
): boolean {
  for (const entry of entries) {
    if (!entry.identifier) continue;
    try {
      if (classify(entry.identifier).mutating) return true;
    } catch { /* an unclassifiable capability is not evidence of a write */ }
  }
  return false;
}

function defaultClassify(identifier: string): { mutating: boolean } {
  // The classifier reads a DISPATCH, not a bare slug — it unwraps the carrier
  // to find the action. Handed a naked identifier it answers "not external, not
  // mutating" for absolutely everything, which would have turned this whole
  // pass into a silent no-op that still passed its own stubbed tests. Ask it
  // the same question the tool boundary asks, in the same shape.
  //
  // Statically imported, deliberately: a lazy `require` here is invisible in an
  // ESM module — it throws, the caller's guard swallows it, and every capability
  // reports read-only forever. That failure is indistinguishable from "nothing
  // to ask about", which is precisely the kind of silence this whole wave exists
  // to eliminate.
  return classifyCanonicalExternalEffect('composio_execute_tool', { tool_slug: identifier });
}

/**
 * Parse the one-line verdict. Plain text with two markers and a regex — the
 * same treatment the other boundary judges use, after structured output flaked
 * live on a safety path. There is nothing here that can fail on presentation.
 */
export function parseOpennessVerdict(raw: unknown): TurnOpenness | null {
  const text = typeof raw === 'string' ? raw : String(raw ?? '');
  const line = text.split('\n').map((l) => l.trim()).find((l) => /^(SETTLED|OPEN)\s*:/i.test(l));
  if (!line) return null;
  if (/^SETTLED/i.test(line)) return null;
  const body = line.replace(/^OPEN\s*:/i, '').trim();
  if (!body) return null;
  const open = body
    .split('|')
    .map((part) => part.trim().replace(/^[-•*\d.)\s]+/, '').trim())
    .filter((part) => part.length >= 3)
    .map((part) => (part.length > MAX_DIMENSION_CHARS ? `${part.slice(0, MAX_DIMENSION_CHARS)}…` : part))
    .slice(0, MAX_OPEN_DIMENSIONS);
  return open.length > 0 ? { open } : null;
}

export interface TurnOpennessInput {
  message: string;
  /** The runtime's resolved facts for this ask — connections, proven tools,
   *  prior failures. This is what a text-only classifier cannot see. */
  capabilityBlock?: string;
  /** What the session already knows, so a settled question is never re-opened. */
  memoryBlock?: string;
  /**
   * Unknowns the runtime is CERTAIN about without asking a model — today, a
   * named destination kind whose specific instance was never stated.
   *
   * These are listed first and survive a judge failure, because they are not
   * inferences. The live case this exists for (2026-08-07): "pull 5 stale
   * accounts in salesforce and help me draft some emails" with two Outlook
   * accounts connected. The preflight typed the destination instance as
   * unstated before a single tool ran; the run then spent its entire length
   * reading a playbook, querying Salesforce and enriching accounts, and every
   * draft failed at the last step with "you have 2 outlook accounts connected,
   * so I need to know WHICH account to use". The question that ended the run
   * was knowable at its first instant, and no model call was needed to know it.
   */
  deterministicOpen?: readonly string[];
}

function buildOpennessPrompt(input: TurnOpennessInput): string {
  const parts = [
    'REQUEST (verbatim, from the user to their assistant):',
    input.message.trim().slice(0, 4_000),
  ];
  if (input.capabilityBlock?.trim()) {
    parts.push('', 'WHAT THE ASSISTANT CAN ALREADY DO FOR THIS (runtime-resolved, not guesswork):',
      input.capabilityBlock.trim().slice(0, 2_000));
  }
  if (input.memoryBlock?.trim()) {
    parts.push('', 'WHAT THE ASSISTANT ALREADY REMEMBERS (do not treat anything settled here as open):',
      input.memoryBlock.trim().slice(0, 2_000));
  }
  return parts.join('\n');
}

/** Swappable for tests — keeps the model call out of the deterministic pins. */
type OpennessJudge = (input: TurnOpennessInput) => Promise<TurnOpenness | null>;
let judgeOverride: OpennessJudge | null = null;
export function _setOpennessJudgeForTests(fn: OpennessJudge | null): void {
  judgeOverride = fn;
}

async function runOpennessJudge(input: TurnOpennessInput): Promise<TurnOpenness | null> {
  const [{ Agent, Runner }, { resolveBoundaryJudge }, { withJudgeTimeout }] = await Promise.all([
    import('@openai/agents'),
    import('./debate-model.js'),
    import('./judge-family.js'),
  ]);
  // Cross-family by construction: a model is a poor judge of its own
  // interpretation, and self-preference bias is measured, not theoretical.
  const routing = resolveBoundaryJudge();
  const agent = new Agent({
    name: 'TurnOpennessJudge',
    instructions: [
      'Decide what is genuinely UNSETTLED about a request before an assistant acts on it.',
      'Silently consider 2-4 distinct readings a careful assistant could act on.',
      'A dimension is OPEN only if those readings would produce MATERIALLY DIFFERENT RESULTS —',
      'which specific account/base/list/records, the time window, the destination, the output format,',
      'or something named but not bound to a real thing.',
      'A dimension is NOT open if the request states it, if the facts above answer it,',
      'if memory already settled it, or if the assistant could simply look it up.',
      'Style, wording, and reasonable defaults are NEVER open.',
      'Reply with EXACTLY ONE LINE and nothing else, one of:',
      '"SETTLED: <short reason>" — the readings agree on everything that changes the result. Prefer this; when in doubt, SETTLED.',
      '"OPEN: <dimension> | <dimension>" — at most 3, each a short noun phrase naming what is undecided, most consequential first.',
    ].join(' '),
    model: routing.model ?? routing.modelId,
    modelSettings: { reasoning: { effort: 'low' } },
    tools: [],
  });
  const work = (async () => {
    const runner = new Runner({ workflowName: 'clementine-turn-openness' });
    const result = await runner.run(agent, buildOpennessPrompt(input), { maxTurns: 1 });
    return parseOpennessVerdict((result as { finalOutput?: unknown }).finalOutput);
  })();
  return (await withJudgeTimeout(work, turnOpennessTimeoutMs())) ?? null;
}

/**
 * Resolve what is open about this turn. Returns null whenever the request is
 * settled OR anything at all goes wrong — the caller cannot distinguish the
 * two, and must not need to.
 */
export async function resolveTurnOpenness(input: TurnOpennessInput): Promise<TurnOpenness | null> {
  if (!turnOpennessEnabled()) return null;
  if (!input.message?.trim()) return null;
  const certain = (input.deterministicOpen ?? [])
    .map((dimension) => dimension.trim())
    .filter((dimension) => dimension.length >= 3);
  let judged: TurnOpenness | null = null;
  try {
    judged = await (judgeOverride ?? runOpennessJudge)(input);
  } catch {
    judged = null;
  }
  // Certain unknowns lead and survive a dead judge: they were never inferences,
  // so a model outage must not be able to swallow them.
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const dimension of [...certain, ...(judged?.open ?? [])]) {
    const key = dimension.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(dimension);
    if (merged.length >= MAX_OPEN_DIMENSIONS) break;
  }
  return merged.length > 0 ? { open: merged } : null;
}

/**
 * Render as DATA plus a floor. The dimensions are facts about the request; what
 * to SAY about them is the assistant's own business — this never scripts a
 * sentence, and the assistant may still judge a dimension not worth raising.
 */
export function renderTurnOpennessForContext(openness: TurnOpenness | null): string {
  if (!openness || openness.open.length === 0) return '';
  return [
    '[open — a separate check found these unsettled in the request; they are not resolved by your context]',
    ...openness.open.map((dimension) => `• ${dimension}`),
    'Floor: acting on the wrong reading of any of these produces the wrong result, and the cost lands on the '
    + 'user, not on you. Settle them BEFORE you commit to work — ask_user_question is loaded and is the normal '
    + 'way to do that. If part of the task is unblocked, do that part first, then ask once about what is still '
    + 'open, with concrete options and your recommendation first. Do not raise a dimension your own context '
    + 'already answers, and never ask after the fact — a question that arrives with the finished work is a report.',
  ].join('\n');
}
