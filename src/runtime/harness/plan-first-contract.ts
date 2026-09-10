/**
 * Plan mode's missing half: the plan comes FIRST, and reading what the owner
 * handed you is not the work.
 *
 * THE FAILURE THIS EXISTS FOR. Live 2026-09-10, `sess-desktop-a6a6a20d`. The
 * owner opened a Plan run with a research brief and a Google Doc link. Clem
 * read the doc 95 seconds in — correctly — and then spent the next six minutes
 * DOING the research: seven live Firecrawl searches, 23 tool_searches, 22
 * re-reads of her own results, 65% of the turn on discovery. She hit the
 * per-turn ceiling and never called draft_plan or publish_plan even once. The
 * owner stopped it and said what he had expected: read the doc I gave you, then
 * tell me what you're going to fan out to do, and don't start until I say go.
 *
 * Plan mode's only ceiling was EXTERNAL CONSEQUENCE — every read was allowed,
 * deliberately, because two earlier incidents collapsed when a planning turn was
 * refused a read it needed (see accepted-task-mode.ts). Correct, and incomplete:
 * nothing ever required the plan itself, so a planning turn could spend its
 * whole budget executing the work it was supposed to be proposing.
 *
 * THE LINE THIS DRAWS. A target the owner named in their own request is an
 * INPUT — reading it is mandatory, unmetered, and never a plan step. Everything
 * else a planning turn reaches for is the WORK, and the work belongs in the plan
 * for review. A small allowance survives for genuine scoping (the planner that
 * needs `sf org list --json` to know which org to plan against), because the
 * cure for over-refusing a planner is not under-refusing it.
 *
 * Deliberately NOT how this works: no tool-name list, no domain list, no ban on
 * reads, and no hard stop. The refusal names its repair — publish the plan, or
 * ask the owner the question you actually need answered — so a planning turn can
 * always move. "Step 1: read the document you gave me" is not a plan, and this
 * boundary is what stops a turn from having to offer one.
 */
import { listEvents } from './eventlog.js';

/**
 * External reads a planning turn may spend on scoping before the plan is due.
 * Not a budget on thinking — a bound on doing the work instead of proposing it.
 */
export const PLAN_SCOPING_READ_ALLOWANCE = 3;

/** Tokens that identify a THING rather than a phrase: URLs and long opaque ids. */
function identifyingTokens(value: string): string[] {
  const out: string[] = [];
  for (const match of value.matchAll(/https?:\/\/[^\s"'\\)]+/g)) out.push(match[0]);
  for (const match of value.matchAll(/[A-Za-z0-9_-]{16,}/g)) out.push(match[0]);
  return out;
}

/**
 * Did the owner name this target themselves? Reading your own brief, the doc you
 * linked, the sheet you pointed at — that is the request being read, not
 * research being performed, and no plan step should ever describe it.
 */
export function readsAnOwnerNamedInput(argumentsJson: string, requestText: string): boolean {
  if (!argumentsJson.trim() || !requestText.trim()) return false;
  const request = requestText.toLowerCase();
  for (const token of identifyingTokens(argumentsJson)) {
    const needle = token.toLowerCase();
    // A URL matches on its stable identifying middle, so a doc id the owner
    // pasted still matches when the call carries it without ?tab= or /edit.
    const core = needle.replace(/^https?:\/\//, '').split(/[?#]/)[0]!.replace(/\/(edit|view)$/, '');
    if (core.length >= 12 && request.includes(core)) return true;
    if (needle.length >= 16 && request.includes(needle)) return true;
  }
  return false;
}

function publishedAPlan(sessionId: string, sourceUserSeq: number): boolean {
  try {
    return listEvents(sessionId, { types: ['plan_revision_published'] })
      .some((row) => row.data.sourceUserSeq === sourceUserSeq);
  } catch {
    // Unreadable history must never invent a constraint on a turn that may
    // already have done the right thing.
    return true;
  }
}

/** External reads this planning source has already settled. */
export function externalReadsSoFar(sessionId: string, sourceUserSeq: number): number {
  try {
    return listEvents(sessionId, { types: ['read_receipt'] })
      .filter((row) => {
        const record = row.data.record;
        if (!record || typeof record !== 'object') return false;
        const source = (record as { source?: { sourceUserSeq?: unknown } }).source;
        return source?.sourceUserSeq === sourceUserSeq;
      })
      .length;
  } catch {
    return 0;
  }
}

/**
 * Refuse the WORK inside a planning turn, once its scoping allowance is spent
 * and no plan has been offered. Returns undefined for everything else: owner
 * inputs, host-local calls, turns that already published, and the allowance.
 */
export function planFirstWorkRefusal(input: {
  sessionId: string;
  sourceUserSeq: number;
  toolName: string;
  argumentsJson: string;
  requestText: string;
  /** True when the call actually crosses to a third party. */
  externalRead: boolean;
}): string | undefined {
  if (!input.externalRead) return undefined;
  if (readsAnOwnerNamedInput(input.argumentsJson, input.requestText)) return undefined;
  if (publishedAPlan(input.sessionId, input.sourceUserSeq)) return undefined;
  if (externalReadsSoFar(input.sessionId, input.sourceUserSeq) < PLAN_SCOPING_READ_ALLOWANCE) return undefined;
  return `PLAN_FIRST: this planning turn has spent its scoping reads, so ${input.toolName} is the WORK, not the plan. `
    + 'Publish the plan now with publish_plan: what you learned from the inputs the user gave you, the steps you '
    + 'intend to fan out, what each one produces, and the order. Reading what the user already handed you is never '
    + 'a plan step. If a fact you genuinely cannot plan without is missing, ask the user that exact question instead '
    + 'of gathering it — the user says when to execute.';
}
