import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// Import the composed strings via orchestrator.js (the re-export path every other
// importer uses — so this also guards that the Phase-3 re-export stays intact).
import { ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_BEHAVIOR_NATIVE } from './orchestrator.js';
// The shared rubric module (Phase 3): the single source both flagship lanes consume.
import {
  CLAUDE_BRAIN_RUBRIC,
  EXTERNAL_CONTENT_TRUST_RUBRIC,
  ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN,
  ORCHESTRATOR_INSTRUCTIONS_LEAN,
  renderClemRubric,
} from './clem-rubric.js';
import { RUBRIC_INSTRUCTIONS_BY_VARIANT } from './orchestrator.js';

/**
 * PHASE 0b — prompt-assembly characterization (the engine-over-prompt regression net).
 *
 * Purpose: make ANY edit to the Codex/native orchestrator rubric a REVIEWABLE DIFF.
 * The 34KB rubric is treated as an accreted regression suite to prune surgically and
 * LAST (Phase 5). These tests pin its current bytes so a prune is a deliberate golden
 * update, never an accidental drift — and so the two flagship lanes (Codex decision-JSON
 * vs Claude native) stay in the documented relationship (they differ ONLY by the
 * decision contract; see the narrate-instead-of-call fix, commit 437e161).
 *
 * When one of these fails after an INTENTIONAL rubric change: update the GOLDEN_*
 * constants below to the printed len/sha16. That diff IS the review artifact.
 */

const sha16 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);
const TOK = (chars: number): number => Math.round(chars / 4);

// --- GOLDEN SNAPSHOT (captured 2026-06-19 @ main 0758e46) ------------------
// Update these — and only these — when a rubric edit is intentional.
const GOLDEN = {
  // 2026-06-28 (Inc A): OFFER BACKGROUND line now routes via the structured
  // `offer_background` tool → background / hold_task_for_later / now (both lanes:
  // HEAD → instructions+native; CLAUDE_BRAIN_RUBRIC_LINES → claudeBrain+lean).
  // 2026-07-08: DECISION_CONTRACT swapped from the OrchestratorDecision JSON
  // envelope to the plain-text MARKER contract (ASK:/CONTINUE:/no-marker).
  // 2026-07-09 stabilization: one beat MAXIMUM (a precise request is normally
  // alignment; a typed `[confirm-first]` turn explicitly takes precedence),
  // injected focus replaces per-turn focus_get, and completed work no longer
  // manufactures a closing question.
  // 2026-07-15 memory reliability replay: unified recall is the default agent
  // lookup; legacy vault-only recall remains available only for explicit scope.
  // 2026-07-15 recall utility loop: exact returned refs receive reinforcement
  // only after materially affecting an answer, plan, scope, or tool choice.
  // 2026-07-15 structured entity capture: both provider lanes annotate only
  // literal identities/relationships so memory writes populate grounded graph.
  // 2026-07-16 tool subtraction: plan-lifecycle tools (create_plan/list_plans/
  // update_plan_step) killed → "PLAN vs EXECUTION COHERENCE" rewritten as
  // "EXECUTION CONTINUITY"; goal_create/goal_update/goal_get merged
  // into goal_upsert (goal_list unchanged).
  // 2026-07-16 memory_mark_used subtraction: both mark-used prompt rules removed
  // from the rubric — usage credit is now attributed in code post-turn
  // (recall-auto-credit.ts), so the model owes no bookkeeping call.
  // 2026-07-16 Stage 3 reduce tier: the FAN OUT clause's "stalls after ~15"
  // concession retired — large fan-outs may return compact digests and shard
  // summaries; the rubric teaches synthesize-from-shards CONDITIONALLY (the
  // review's F8: the behavior is kill-switchable, so the prompt must not
  // promise it unconditionally).
  // 2026-07-17 turn-control/skill routing: the typed fresh-turn beat is explicit,
  // matching skills are query-scoped, and the revised wording is shorter than
  // the previous permanent rubric in every provider lane.
  // 2026-07-18 public fixture hygiene: the illustrative CRM field was replaced
  // with a neutral synthetic field name in both flagship prompt variants.
  // 2026-07-22 fan-out batch contract: "waves of up to 8" replaced with the
  // run_worker `items` batch (harness-pooled, full list in ONE call) in all
  // three fan-out clauses — the old wording contradicted the new deterministic
  // pool; the old EXECUTION WRAP hardcoded slug-verb list was replaced with
  // code-owned classification (the list was drift-prone).
  // 2026-07-22 (late): offer_background ceremony STRIPPED (subtraction) — the
  // structured offer tool is gone; the rubric teaches the same choice as ONE
  // plain prose sentence routed to dispatch_background_task / hold_task_for_later.
  // 2026-07-25: compact course-correction + durable fan-out cues route revised
  // contracts and long-horizon work through code-backed manifests. The old
  // "N>50 => author a workflow" escalation was removed; workflows are for
  // genuinely reusable/scheduled procedures.
  // 2026-07-25 (live smoke): one-shot fetch/write/deploy/verification work no
  // longer pins a durable focus merely because the request names a URL.
  // 2026-07-26 full-catalog soak: manifests track per-item worker phases only;
  // parent ranking/merge/final synthesis no longer creates phantom N-of-N work.
  // 2026-07-26 collaborative readiness: exploration no longer has a one-turn
  // timer. Execution-ready ambiguity stays bundled, while the shared rule and
  // shorter background cue reduce every flagship prompt.
  // 2026-07-26 shared workstate: Focus now covers sustained decision threads
  // and material sparse patches, replacing the longer resource-only heuristic.
  // 2026-07-26 cross-brain workstate: the lean Claude lanes receive the same
  // injected notebook and maintain it only when the conversation materially
  // changes, while lifecycle reconciliation remains runtime-owned.
  // 2026-07-26 memory-ingress subtraction: explicit store requests rely on the
  // crash-safe auto-capture seam instead of demanding a duplicate model tool
  // write; ordinary memory calls default to the small kind+content payload.
  // 2026-07-27 schema-on-demand: Claude's provider-specific rubric teaches its
  // bounded tool_search → call_tool path without leaking that transport into
  // the shared Codex/BYO rubric.
  // 2026-07-28 deterministic approval graph: every flagship lane now queues
  // the exact payload, asks once, and lets the runtime link the formal card;
  // approval resumes the exact single-call or batch executor without rebuild.
  // 2026-07-30 close-the-loop + waited-on retrieval beat (live misses): the
  // shared readiness rubric now tells the model to end a recommendation with
  // the concrete next step + one offering question (never leave the decision
  // on the table), and a retrieval the user is waiting on that needs minutes
  // of tool work gets a one-line route echo then backgrounds with
  // report-back-here instead of grinding tool calls in the chat.
  // 2026-08-01 graph-owned lane choice: full and lean brains now honor an
  // explicit now/background/hold choice and otherwise choose foreground vs
  // durable execution from the work itself. The routing permission question
  // and route-confirmation beat are gone; missing-input and approval safety stay.
  // 2026-08-01 workflow authority subtraction: an exact/unambiguous imperative
  // dispatches the named workflow immediately; only ambiguous thematic matches
  // receive an identifying clarification.
  // 2026-08-04 grounded status answers: BACKGROUND STATUS is now a SHARED
  // rubric line (both variants). It previously lived only in the legacy head,
  // so the default lean install answered "how's it going?" from chat history
  // — vague reassurance instead of read state. The line also now requires
  // concrete numbers (items done vs total, current phase, elapsed) over
  // generic comfort.
  // 2026-08-04 tool-memory loop restored to the LEAN variant (efficiency
  // audit): the default rubric had dropped all three operative instructions
  // (read the injected block, tool_choice_recall before discovery,
  // tool_choice_remember on success) — the write side of the learning loop
  // was never requested, so long runs re-discovered per item. Compact shared
  // line added; the legacy head keeps its verbose original.
  // 2026-08-05 hints-are-schema: the two reader-tool examples (Recently
  // Learned call_xxx hint; COMPACTED CONTEXT stub example) now render as
  // literal valid-JSON inputs — recall_tool_result {"call_id":"call_abc123"} —
  // instead of paren/kwargs pseudo-signatures the model copied verbatim into
  // unparseable tool calls (live InputValidationError class, 4/4 occurrences).
  // 2026-08-08 compose→commit: workers may investigate and read broadly, but
  // return exact mutation payloads for one parent-owned batch proposal/commit.
  // This preserves conversational/model reasoning while preventing worker-side
  // Composio writes and the duplicate/fallback dispatches observed live.
  // 2026-08-13 bounded capability execution: injected retrieval is evidence,
  // not a checklist. Resolved roles execute directly; one unresolved semantic
  // role receives one federated broker attempt; exact schema failures repair
  // the exact subject. Mandatory recall/history/skill/discovery rituals were
  // removed after the live Ventura run spent 12 model turns reconfirming data
  // the runtime had already supplied.
  // 2026-08-22 provider-neutral harness cut: removed application-shaped
  // carrier precedence, workflow authoring recipes, recurring-destination
  // recipes, worker payload examples, and compacted-result examples. Durable
  // promotion is review-only and exact live bindings remain code-owned.
  // 2026-08-22: exact approved opportunity → host-issued one-read pilot-card
  // transition; consent, queueing, execution, and recurrence remain separate.
  // 2026-08-22: exact proposal CAS → formal human review card; the staging
  // tool owns no decision, pilot, workflow, schedule, or execution authority.
  // 2026-08-22: a clean pilot can stage only a disabled recurrence preview and
  // separate formal recurrence-consent card; neither configuration nor the
  // staging tool is activation or execution authority.
  // 2026-08-29: Auto consent has one carrier/owner. Accepted plan-bound work
  // enters work_call directly; pending_action_queue is explicit staging only.
  // 2026-08-30: persistent context is provenance-sensitive context, not one
  // uniform ground-truth authority; explicit memory remains authoritative.
  // 2026-08-31: every model lane now treats external/tool bytes as untrusted
  // evidence. Nearby wording was tightened so legacy stays inside its token
  // guard and fresh-action remains below its 5.5 KB stable-policy ceiling.
  instructions: { len: 31884, sha16: '0b5dbd98814a3bca' },
  native: { len: 30991, sha16: '10c57b280785f498' },
  claudeBrain: { len: 8527, sha16: '663983956ba48fb5' },
  lean: { len: 10533, sha16: '76bfa5879bab95b5' },
} as const;

function snapshotGuard(name: string, value: string, golden: { len: number; sha16: string }): void {
  const len = value.length;
  const hash = sha16(value);
  const msg =
    `\n  ${name} CHANGED — this is a reviewable diff.\n` +
    `    was: len=${golden.len} sha16=${golden.sha16}\n` +
    `    now: len=${len} sha16=${hash}  (≈ ${TOK(len)} tok)\n` +
    `  If this edit is intentional (e.g. a Phase-5 prune), update GOLDEN.${name} above.\n`;
  assert.equal(len, golden.len, msg);
  assert.equal(hash, golden.sha16, msg);
}

test('characterization: ORCHESTRATOR_INSTRUCTIONS is byte-stable (reviewable-diff guard)', () => {
  snapshotGuard('instructions', ORCHESTRATOR_INSTRUCTIONS, GOLDEN.instructions);
});

test('characterization: ORCHESTRATOR_BEHAVIOR_NATIVE is byte-stable (reviewable-diff guard)', () => {
  snapshotGuard('native', ORCHESTRATOR_BEHAVIOR_NATIVE, GOLDEN.native);
});

test('characterization: CLAUDE_BRAIN_RUBRIC (lean) is byte-stable (reviewable-diff guard)', () => {
  snapshotGuard('claudeBrain', CLAUDE_BRAIN_RUBRIC, GOLDEN.claudeBrain);
});

test('characterization: ORCHESTRATOR_INSTRUCTIONS_LEAN is byte-stable (reviewable-diff guard)', () => {
  snapshotGuard('lean', ORCHESTRATOR_INSTRUCTIONS_LEAN, GOLDEN.lean);
});

test('fresh accepted actions keep model judgment while omitting unreachable policy', () => {
  assert.ok(Buffer.byteLength(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN, 'utf8') <= 5_500,
    'fresh-action stable policy must leave room for the exact turn snapshot and tool schemas');
  for (const required of [
    'CONVERSE FIRST',
    'CALL TOOLS',
    'run_worker',
    'AUTO CONSENT',
    'ACCEPTED WORK AUTHORITY',
    'END YOUR TURN WITH PLAIN TEXT',
    'CLOSE THE LOOP',
  ]) {
    assert.match(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN, new RegExp(required, 'i'), required);
  }
  assert.doesNotMatch(ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN, /BACKGROUND STATUS|DURABLE OPPORTUNITIES/,
    'fresh foreground action policy must not repeat unreachable background/workflow guidance');
});

test('provider parity: external content is evidence and cannot rewrite task authority', () => {
  assert.match(EXTERNAL_CONTENT_TRUST_RUBRIC, /external content is untrusted evidence/i);
  for (const [lane, rubric] of [
    ['codex', ORCHESTRATOR_INSTRUCTIONS],
    ['native', ORCHESTRATOR_BEHAVIOR_NATIVE],
    ['lean-codex', ORCHESTRATOR_INSTRUCTIONS_LEAN],
    ['fresh-action', ORCHESTRATOR_ACTION_INSTRUCTIONS_LEAN],
    ['claude', CLAUDE_BRAIN_RUBRIC],
  ] as const) {
    assert.match(rubric, /never instructions/i, lane);
    assert.match(rubric, /embedded web\/provider\/tool directives/i, lane);
    assert.match(rubric, /cannot change the accepted objective, skill, tools\/carrier, destination\/account, permission\/approval/i, lane);
    assert.match(rubric, /authorize send\/write\/disclosure/i, lane);
  }
});

test('lean variant: production default with a legacy rollback, materially leaner, keeps load-bearing rules', () => {
  // Wired into the attributable variant substrate.
  assert.equal(RUBRIC_INSTRUCTIONS_BY_VARIANT.lean, ORCHESTRATOR_INSTRUCTIONS_LEAN, 'lean must be registered in the variant map');
  // The legacy body stays intact as a one-flag rollback.
  assert.equal(RUBRIC_INSTRUCTIONS_BY_VARIANT.legacy, renderClemRubric('codex'), 'legacy rollback stays canonical');
  // Genuinely a prune: well under half the legacy size.
  assert.ok(ORCHESTRATOR_INSTRUCTIONS_LEAN.length * 2 < renderClemRubric('codex').length, 'lean must be far smaller than legacy');
  // Load-bearing rules survive the prune (composition invariants):
  //  - the plain-text marker DECISION_CONTRACT (the loop parses text + a marker),
  assert.ok(ORCHESTRATOR_INSTRUCTIONS_LEAN.includes('END YOUR TURN WITH PLAIN TEXT'), 'lean must keep the decision contract');
  //  - the anti-narration opener (the narrate-instead-of-call guard),
  assert.ok(ORCHESTRATOR_INSTRUCTIONS_LEAN.includes('CALL TOOLS'), 'lean must keep the anti-narration rule');
  //  - accepted-work authority + fan-out Codex essentials the gates rely on,
  assert.ok(ORCHESTRATOR_INSTRUCTIONS_LEAN.includes('ACCEPTED WORK AUTHORITY'), 'lean must keep accepted-work authority');
  assert.ok(ORCHESTRATOR_INSTRUCTIONS_LEAN.includes('FAN OUT'), 'lean must keep the fan-out rule');
  //  - converse-first (the most important interaction rule).
  assert.ok(/CONVERSE FIRST/i.test(ORCHESTRATOR_INSTRUCTIONS_LEAN), 'lean must keep converse-first');
});

test('durable opportunity guidance is provider-neutral and never promotes on tool count', () => {
  for (const [lane, rubric] of [
    ['lean-codex', ORCHESTRATOR_INSTRUCTIONS_LEAN],
    ['claude', CLAUDE_BRAIN_RUBRIC],
  ] as const) {
    assert.match(rubric, /DURABLE OPPORTUNITIES/i, lane);
    assert.match(rubric, /ordinary work stays in this loop regardless of tool count/i, lane);
    assert.match(rubric, /automation_opportunity_propose/i, lane);
    assert.match(rubric, /automation_opportunity_review_request/i, lane);
    assert.match(rubric, /formal human decision card only; the model cannot decide it/i, lane);
    assert.match(rubric, /creates no workflow, pilot, schedule, Space, or execution authority/i, lane);
    assert.doesNotMatch(
      rubric,
      /50 CRM tasks|30 drafts|25 URL scrapes|composioSlug|SERP\/keyword/i,
      lane,
    );
  }
});

test('approved opportunity guidance requests pilot and recurrence cards without collapsing consent boundaries', () => {
  for (const [lane, rubric] of [
    ['codex', ORCHESTRATOR_INSTRUCTIONS],
    ['native', ORCHESTRATOR_BEHAVIOR_NATIVE],
  ] as const) {
    assert.match(rubric, /automation_read_pilot_acquisition_list/i, lane);
    assert.match(rubric, /automation_read_pilot_request/i, lane);
    assert.match(rubric, /automation_opportunity_review_request/i, lane);
    assert.match(rubric, /exact revision and digest/i, lane);
    assert.match(rubric, /exact proposal CAS, typed result mapping, exact Workspace revision\/digest when applicable, and chosen host-issued opaque reference/i, lane);
    assert.match(rubric, /creates only a formal pilot approval card/i, lane);
    assert.match(rubric, /cannot approve, queue, run, schedule, or infer recurrence/i, lane);
    assert.match(rubric, /automation_recurrence_request/i, lane);
    assert.match(rubric, /disabled preview and a separate formal recurrence-consent card/i, lane);
    assert.match(rubric, /workflow configuration never means active consent/i, lane);
    assert.match(rubric, /cannot approve, activate, queue, run, write externally, or send/i, lane);
  }
});

test('runtime rubrics contain framework contracts, never customer-shaped provider recipes', () => {
  const forbidden =
    /restaurant|attorney|lawyer|salesforce|outlook|slack|gmail|asana|apify|dataforseo|google.?sheets?|netlify|airtable|supabase|browsermcp|serp|GOOGLESHEETS_|composioSlug|sf data|sf cli|50 CRM tasks|25 URL scrapes/i;
  for (const [lane, rubric] of [
    ['codex', ORCHESTRATOR_INSTRUCTIONS],
    ['native', ORCHESTRATOR_BEHAVIOR_NATIVE],
    ['lean-codex', ORCHESTRATOR_INSTRUCTIONS_LEAN],
    ['claude', CLAUDE_BRAIN_RUBRIC],
  ] as const) {
    assert.doesNotMatch(rubric, forbidden, lane);
    assert.match(rubric, /exact (?:persisted invocation plan|host-frozen binding|current capability contracts|capability and schema)/i, lane);
    assert.match(rubric, /account.*resource identity|resource identity.*account/i, lane);
  }
});

// --- Phase 3: ONE shared rubric source feeds every lane ---------------------
test('shared source: renderClemRubric feeds all three lanes from clem-rubric', () => {
  // The Phase-3 invariant: both flagship lanes (and the lean chat brain) draw from
  // the SAME module. If a lane ever forks its own copy, this breaks.
  assert.equal(renderClemRubric('codex'), ORCHESTRATOR_INSTRUCTIONS, 'codex lane = the re-exported instructions');
  assert.equal(renderClemRubric('native'), ORCHESTRATOR_BEHAVIOR_NATIVE, 'native lane = the re-exported native rubric');
  assert.equal(renderClemRubric('claude_brain'), CLAUDE_BRAIN_RUBRIC, 'claude chat brain = the lean rubric');
  // and the lean brain rubric is genuinely lean vs the 34KB Codex one.
  assert.ok(CLAUDE_BRAIN_RUBRIC.length * 3 < ORCHESTRATOR_INSTRUCTIONS.length, 'claude brain rubric must stay far leaner than the Codex rubric');
});

test('provider parity: focus context is injected, never a mandatory per-turn tool ritual', () => {
  for (const [lane, rubric] of [
    ['standard', ORCHESTRATOR_INSTRUCTIONS],
    ['claude', CLAUDE_BRAIN_RUBRIC],
  ] as const) {
    assert.doesNotMatch(rubric, /focus_get`? at the START of every turn|non-negotiable for chat\/Discord/i, lane);
    assert.match(rubric, /Current Focus(?: block)? is (?:already )?injected/i, lane);
    assert.match(rubric, /focus_get[^.\n]*(?:only when (?:the user )?explicitly|only for explicit)/i, lane);
  }
});

test('provider parity: resolved capabilities execute directly and discovery is one role-scoped repair path', () => {
  for (const [lane, rubric] of [
    ['standard', ORCHESTRATOR_INSTRUCTIONS],
    ['claude', CLAUDE_BRAIN_RUBRIC],
  ] as const) {
    assert.match(rubric, /bounded retrieval result, not a checklist/i, lane);
    assert.match(rubric, /(?:resolved exact capability and schema|injected packet resolves an exact capability and schema)[^.]*invoke it directly/i, lane);
    assert.match(rubric, /(?:single runtime discovery broker once[^.]*semantic role|unresolved semantic role[^.]*single runtime discovery broker once)/i, lane);
    assert.match(rubric, /exact call fails schema validation[^.]*exact subject once/i, lane);
    assert.match(rubric, /skill candidates? (?:is|are) advisory/i, lane);
    assert.doesNotMatch(
      rubric,
      /call `tool_choice_recall\(intent\)` BEFORE any discovery|fire all per-intent `tool_choice_recall`/i,
      lane,
    );
  }
  assert.match(
    CLAUDE_BRAIN_RUBRIC,
    /verified success is remembered automatically/i,
    'lean/claude learning is a write path, not a model ritual',
  );
  assert.doesNotMatch(
    CLAUDE_BRAIN_RUBRIC,
    /On the first successful previously unknown path, call `tool_choice_remember`/i,
  );
});

test('provider parity: accepted work_call authority never manufactures a second execution owner', () => {
  for (const [lane, rubric] of [
    ['standard', ORCHESTRATOR_INSTRUCTIONS],
    ['lean-codex', ORCHESTRATOR_INSTRUCTIONS_LEAN],
  ] as const) {
    assert.match(rubric, /accepted (?:action|external work).*work_call|accepted work[^.]*work_call/i, lane);
    assert.match(rubric, /host-frozen/i, lane);
    assert.doesNotMatch(rubric, /before (?:a|any) MUTATING external write[^\n]*execution_create FIRST/i, lane);
    assert.doesNotMatch(rubric, /before (?:the parent dispatches|a batch of)[^\n]*execution_create/i, lane);
  }
});

test('interaction contract: exploration is model-led while execution-ready ambiguity stays bundled', () => {
  for (const rubric of [ORCHESTRATOR_INSTRUCTIONS, CLAUDE_BRAIN_RUBRIC]) {
    assert.match(rubric, /exploration is not execution/i);
    assert.match(rubric, /stay conversational for as many useful turns as needed/i);
    assert.match(rubric, /Act when the request is precise or the user clearly commits/i);
    assert.match(rubric, /ask one plain question bundling it/i);
    assert.match(rubric, /\[confirm-first\].*fresh-turn beat/is);
    assert.doesNotMatch(rubric, /at most ONE (?:steering|consultative) beat/i);
    assert.doesNotMatch(rubric, /The moment the user answers, EXECUTE/i);
    assert.doesNotMatch(rubric, /END your reply with ONE concrete offer/i);
  }
});

test('background execution contract: the graph chooses the lane without a routing permission beat', () => {
  for (const [lane, rubric] of [
    ['legacy', ORCHESTRATOR_INSTRUCTIONS],
    ['lean-codex', ORCHESTRATOR_INSTRUCTIONS_LEAN],
    ['claude', CLAUDE_BRAIN_RUBRIC],
  ] as const) {
    assert.match(rubric, /honor explicit now\/background\/hold/i, lane);
    assert.match(rubric, /choose from workload/i, lane);
    assert.match(rubric, /Never ask which lane/i, lane);
    assert.match(rubric, /materially missing input.*external-write approval/is, lane);
    assert.match(rubric, /approval graph remains authoritative/i, lane);
    assert.doesNotMatch(rubric, /ask naturally once|ASK in ONE plain sentence whether to run it in the background/i, lane);
  }
});

test('workflow execution contract: exact existing-workflow authority is distinct from authoring and effect approval', () => {
  for (const [lane, rubric] of [
    ['codex', ORCHESTRATOR_INSTRUCTIONS],
    ['native', ORCHESTRATOR_BEHAVIOR_NATIVE],
  ] as const) {
    assert.match(rubric, /already-authorized workflow.*exact imperative is sufficient.*workflow_run.*same turn/is, lane);
    assert.match(rubric, /workflow's own effect approvals remain authoritative/i, lane);
    assert.match(rubric, /merely similar topic is not (?:execution )?authority/i, lane);
    assert.match(rubric, /ambiguous reference gets one identifying question/i, lane);
    assert.match(rubric, /automation_opportunity_propose.*review artifact/i, lane);
    assert.doesNotMatch(rubric, /Run it now\?/i, lane);
  }
});

test('memory contract: explicit stores are captured once and ordinary model writes stay small', () => {
  for (const [lane, rubric] of [
    ['standard', ORCHESTRATOR_INSTRUCTIONS],
    ['claude', CLAUDE_BRAIN_RUBRIC],
  ] as const) {
    assert.match(rubric, /explicit (?:store|["“]remember this["”])[^.\n]*auto-captured/i, lane);
    assert.match(rubric, /without (?:duplicating|a duplicate)/i, lane);
    assert.match(rubric, /kind \+ content/i, lane);
    assert.match(rubric, /omit (?:graph annotations|them) for codewords/i, lane);
  }
});

// --- The two-lane invariant (Codex vs Claude native) -----------------------
// INSTRUCTIONS = HEAD + DECISION_CONTRACT + TAIL ; NATIVE = HEAD + TAIL.
// They must differ ONLY by the decision-JSON contract block — the documented
// fix for the narrate-instead-of-call failure. If this breaks, the Claude SDK
// lane has drifted from the Codex lane (or vice-versa) in behavior, not just
// the contract — exactly the regression Phase 3 (one shared rubric source) and
// the narrate-fix guard against.

// The rubric is `array.join('\n\n')`, so splitting on the separator yields the
// original blocks exactly — robust to any char-level boundary arithmetic.
function blockPrefixLen(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function blockSuffixLen(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

test('two-lane invariant: native = instructions MINUS the decision-JSON contract', () => {
  const instr = ORCHESTRATOR_INSTRUCTIONS.split('\n\n');
  const native = ORCHESTRATOR_BEHAVIOR_NATIVE.split('\n\n');
  const bp = blockPrefixLen(instr, native);
  const bs = blockSuffixLen(instr, native);
  // The blocks present in INSTRUCTIONS but absent from NATIVE = the decision contract.
  const contractBlocks = instr.slice(bp, instr.length - bs);
  const nativeMiddle = native.slice(bp, native.length - bs);
  assert.equal(nativeMiddle.length, 0, 'native must have NOTHING between the shared HEAD and TAIL');
  assert.ok(contractBlocks.length > 0, 'native must be strictly smaller (it omits the contract)');
  // Order-independent: assert the delta CONTAINS the decision-contract markers,
  // not that they sit at a specific index (a reordered contract array must still pass).
  assert.ok(
    contractBlocks.some((b) => b.startsWith('END YOUR TURN WITH PLAIN TEXT')),
    `the delta must contain the decision-contract opener; got: ${JSON.stringify(contractBlocks.map((b) => b.slice(0, 32)))}`,
  );
  assert.ok(
    contractBlocks.some((b) => b.startsWith('One OPTIONAL marker')),
    'the delta must contain the marker-contract line',
  );
  // Reconstruct: HEAD blocks + TAIL blocks (contract removed) === native, block-for-block.
  assert.deepEqual(
    [...instr.slice(0, bp), ...instr.slice(instr.length - bs)],
    native,
    'instructions minus the decision-contract blocks must equal the native rubric',
  );
});

test('two-lane invariant: the decision-JSON contract NEVER leaks into the native lane', () => {
  // The narrate-instead-of-call root cause: the native (Claude SDK) lane was fed
  // the decision-JSON contract and copied it as text. It must stay absent.
  for (const marker of ['END YOUR TURN WITH PLAIN TEXT', 'ASK: <question>', 'CONTINUE: <note>']) {
    assert.ok(
      !ORCHESTRATOR_BEHAVIOR_NATIVE.includes(marker),
      `native rubric must not contain decision-contract marker ${JSON.stringify(marker)}`,
    );
  }
  // ...but the Codex lane MUST carry it (the loop parses the marker + text).
  assert.ok(ORCHESTRATOR_INSTRUCTIONS.includes('END YOUR TURN WITH PLAIN TEXT'));
});

// --- Token-budget guard ----------------------------------------------------
// Catches accidental bloat. 2026-08-22 provider-neutral baseline: ≈ 7,594 tok. A drift
// of >5% in either direction is a prompt-size regression worth a look.
test('budget guard: rubric token estimate stays within 5% of the Phase-0 baseline', () => {
  const BASELINE_TOK = 7594;
  const actual = TOK(ORCHESTRATOR_INSTRUCTIONS.length);
  const drift = Math.abs(actual - BASELINE_TOK) / BASELINE_TOK;
  assert.ok(
    drift <= 0.05,
    `rubric is ${actual} tok vs baseline ${BASELINE_TOK} (${(drift * 100).toFixed(1)}% drift). ` +
      'If intentional, update BASELINE_TOK; otherwise the prompt grew unexpectedly.',
  );
});
