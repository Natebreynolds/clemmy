/**
 * Run: npx tsx --test src/runtime/harness/goal-fidelity-gate.test.ts
 *
 * Goal-fidelity gate — does an irreversible write advance the run's STATED
 * GOAL and honor the loaded SKILL's defining requirement? Sibling to the
 * grounding gate (payload-vs-source); this is payload-vs-GOAL+SKILL.
 *
 * The classes it catches (design §7): the emails-without-per-firm-research run
 * (byte-identical opening across distinct firms while the skill requires
 * per-firm research), and the lunar-audit renderer-skip (data gathered, the
 * skill's producer script never ran). Plus fail-open everywhere.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-goalfid-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetEventLog, createSession, appendEvent, writeToolOutput } = await import('./eventlog.js');
const {
  isGoalFidelityGateEnabled,
  isGoalAlignmentGateEnabled,
  gatherGoalText,
  extractMessageBody,
  personalizationRegion,
  detectBatchUniformity,
  buildGoalFidelityPrompt,
  summarizeGoalFidelityState,
  evaluateGoalFidelity,
  GoalFidelityCheckFailedError,
  _setGoalFidelityJudgeForTests,
  _resetGoalFidelityStateForTests,
} = await import('./goal-fidelity-gate.js');

test.after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─── seeding helpers (mirror the event/tool-output shapes the gate reads) ──

let skillSeq = 0;
function seedSkill(sessionId: string, name: string, body: string): void {
  const callId = `skill_${++skillSeq}`;
  appendEvent({ sessionId, turn: 0, role: 'orchestrator', type: 'tool_called', data: { tool: 'skill_read', callId, arguments: JSON.stringify({ name }) } });
  // skill_read returns envelope\n---\nbody; the gate strips at the FIRST '\n---\n'.
  writeToolOutput({ sessionId, callId, tool: 'skill_read', output: `SKILL: ${name}\n(manifest + crib + contract)\n---\n${body}` });
}

function seedGoal(sessionId: string, text: string): void {
  appendEvent({ sessionId, turn: 0, role: 'user', type: 'user_input_received', data: { text } });
}

let sendSeq = 0;
function seedSend(sessionId: string, slug: string, toEmail: string, body: string): void {
  const callId = `send_${++sendSeq}`;
  appendEvent({
    sessionId, turn: 0, role: 'orchestrator', type: 'tool_called',
    data: { tool: 'composio_execute_tool', callId, arguments: JSON.stringify({ tool_slug: slug, arguments: JSON.stringify({ to_email: toEmail, subject: 's', body }) }) },
  });
}

function sendArgs(slug: string, toEmail: string, body: string): unknown {
  return { tool_slug: slug, arguments: JSON.stringify({ to_email: toEmail, subject: 's', body }) };
}

const SEND = 'OUTLOOK_OUTLOOK_SEND_EMAIL';
const GENERIC_OPENING = 'Our agency helps law firms dominate local search. We deliver SEO, paid media, and conversion-focused websites that turn searchers into signed clients. I would love to show you what we can do.';

// ─── pure: extractMessageBody / personalizationRegion ─────────────────────

test('extractMessageBody: pulls the body out of composio nested JSON args', () => {
  const body = extractMessageBody(sendArgs(SEND, 'a@firm.com', 'This is the outreach message body that is reasonably long.'));
  assert.match(body, /outreach message body/);
});

test('personalizationRegion: strips the salutation, normalizes, and equal openings collapse to the same region', () => {
  const a = personalizationRegion(`Dear Mr. Eley,\n\n${GENERIC_OPENING}`);
  const b = personalizationRegion(`Hi Jane,\n\n${GENERIC_OPENING}`);
  assert.ok(a.length >= 40, 'region survives the salutation strip');
  assert.equal(a, b, 'identical body after distinct salutations → identical region (the personalization-skip signal)');
  const c = personalizationRegion('Hello — I read your recent appellate win in the Tribune and your new workers-comp practice page; it prompted this note about your local search footprint specifically.');
  assert.notEqual(a, c, 'a genuinely researched opening yields a different region');
});

test('personalizationRegion: a too-thin body yields no region (no false uniformity signal)', () => {
  assert.equal(personalizationRegion('thanks!'), '');
});

// ─── pure: detectBatchUniformity ──────────────────────────────────────────

test('detectBatchUniformity: identical region across DISTINCT targets is uniform; same target is excluded', () => {
  const region = personalizationRegion(GENERIC_OPENING);
  const uni = detectBatchUniformity({
    currentTarget: 'c@firm-c.com',
    currentRegion: region,
    priorSends: [
      { target: 'a@firm-a.com', region },
      { target: 'b@firm-b.com', region },
      { target: 'c@firm-c.com', region }, // same target as current — must NOT count (that's a duplicate, not a skip)
    ],
  });
  assert.equal(uni.uniform, true);
  assert.deepEqual([...uni.peerTargets].sort(), ['a@firm-a.com', 'b@firm-b.com']);
});

test('detectBatchUniformity: distinct regions are not uniform; empty region never uniform', () => {
  assert.equal(detectBatchUniformity({ currentTarget: 'x@a.com', currentRegion: 'aaaa', priorSends: [{ target: 'y@b.com', region: 'bbbb' }] }).uniform, false);
  assert.equal(detectBatchUniformity({ currentTarget: 'x@a.com', currentRegion: '', priorSends: [{ target: 'y@b.com', region: '' }] }).uniform, false);
});

// ─── pure: gatherGoalText + prompt assembly ───────────────────────────────

test('gatherGoalText: composes from user_input_received events', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Email each firm a personalized note referencing our per-firm SEO research.');
  assert.match(gatherGoalText(sess.id), /per-firm SEO research/);
});

test('gatherGoalText: prefers the BLESSED contract over re-derivation; falls back to events when no contract (Step 3)', async () => {
  resetEventLog();
  const { surfacePlan, approvePlanProposal } = await import('../../agents/plan-proposals.js');
  const sess = createSession({ kind: 'chat' });
  // A misleading raw message that re-derivation WOULD pick up…
  seedGoal(sess.id, 'idk just do whatever you think is best');
  // …but the user then blessed a SPECIFIC plan. The gate must judge against THAT.
  const proposal = surfacePlan({
    plan: {
      objective: 'Send a personalized outreach email to EACH of the 8 firms — one per firm.',
      steps: [{ n: 1, action: 'send the emails', rationale: 'the ask', verification: null }],
      successCriteria: ['8 emails sent', 'each references a firm-specific finding'],
      stages: null, risks: [], estimatedComplexity: 'moderate', recommendsTrackedExecution: false,
      needsUserInput: [], appliedInstructions: [], externalSends: null,
    } as never,
    originatingRequest: 'send the 8 outreach emails',
    sessionId: sess.id,
  });
  approvePlanProposal(proposal.id);

  const text = gatherGoalText(sess.id);
  assert.match(text, /personalized outreach email to EACH of the 8 firms/, 'uses the blessed objective');
  assert.match(text, /each references a firm-specific finding/, 'includes the blessed success criteria');
  assert.doesNotMatch(text, /just do whatever you think is best/, 'NOT the re-derived raw message');

  // Branch B: a session with NO contract still re-derives from events (unchanged).
  const sess2 = createSession({ kind: 'chat' });
  seedGoal(sess2.id, 'Pull my unread emails and summarize them.');
  assert.match(gatherGoalText(sess2.id), /unread emails/, 'goal-less session re-derives from events');
});

test('buildGoalFidelityPrompt: includes goal, skill, evidence, payload, and the fail-open rubric', () => {
  const p = buildGoalFidelityPrompt({
    goal: 'Email a personalized note',
    skills: [{ name: 'scorpion-outbound', body: 'Research each firm before writing.' }],
    payload: 'Tool: composio_execute_tool\nOutgoing payload:\n{...}',
    evidence: 'This action\'s opening paragraph is BYTE-IDENTICAL to 2 prior same-shape send(s)...',
  });
  assert.match(p, /Email a personalized note/);
  assert.match(p, /scorpion-outbound/);
  assert.match(p, /BYTE-IDENTICAL/);
  assert.match(p, /FAIL OPEN/);
  assert.match(p, /DEFINING requirement/);
});

test('summarizeGoalFidelityState: no goal is visible and does not call the judge', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const summary = summarizeGoalFidelityState(sess.id);
  assert.equal(summary.hasGoal, false);
  assert.equal(summary.mode, 'no_goal');
  assert.ok(summary.issues.some((issue) => /no recoverable user goal/.test(issue)));
});

test('summarizeGoalFidelityState: exposes loaded skills and batch-uniformity evidence', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Email each firm a personalized outreach note that references per-firm research.');
  seedSkill(sess.id, 'scorpion-outbound', 'Research each firm before writing; never reuse a generic opening across firms.');
  seedSend(sess.id, SEND, 'a@firm-a.com', GENERIC_OPENING);
  seedSend(sess.id, SEND, 'b@firm-b.com', GENERIC_OPENING);

  const summary = summarizeGoalFidelityState(sess.id, 'composio_execute_tool', sendArgs(SEND, 'c@firm-c.com', GENERIC_OPENING));
  assert.equal(summary.hasGoal, true);
  assert.equal(summary.mode, 'skill_judge_ready');
  assert.equal(summary.skills[0].name, 'scorpion-outbound');
  assert.equal(summary.evidence?.uniform, true);
  assert.deepEqual(summary.evidence?.uniformPeerTargets.sort(), ['a@firm-a.com', 'b@firm-b.com']);
  assert.match(summary.evidence?.text ?? '', /BYTE-IDENTICAL/);
});

test('summarizeGoalFidelityState: renderer shortfall is inspectable before the gate blocks', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Run the lunar local audit and publish the report.');
  seedSkill(sess.id, 'lunar-local-audit', 'After gathering data, run scripts/generate-html.js to produce the report.');

  const summary = summarizeGoalFidelityState(sess.id, 'composio_execute_tool', sendArgs('NETLIFY_DEPLOY_SITE_PUBLISH', 'ignored@x.com', 'publish'));
  assert.equal(summary.mode, 'renderer_block_risk');
  assert.equal(summary.skills[0].rendererShortfall?.skill, 'lunar-local-audit');
  assert.deepEqual(summary.skills[0].rendererShortfall?.prescribed, ['generate-html.js']);
  assert.ok(summary.issues.some((issue) => /generate-html\.js/.test(issue)));
});

// ─── §7.1 emails class: batch-identical opening blocks; researched allows ──

test('evaluateGoalFidelity: byte-identical opening across distinct firms (skill requires per-firm research) → block; a distinct researched opening → allow', async () => {
  resetEventLog();
  _resetGoalFidelityStateForTests();
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Email each firm a personalized outreach note that references our specific per-firm SEO research.');
  seedSkill(sess.id, 'scorpion-outbound', '## Per-firm research (REQUIRED)\nBefore writing ANY email, research that specific firm and weave at least one firm-specific finding into the opening. Never reuse a generic opening across firms.');
  // Two prior sends with a byte-identical generic opening to DISTINCT firms.
  seedSend(sess.id, SEND, 'a@firm-a.com', GENERIC_OPENING);
  seedSend(sess.id, SEND, 'b@firm-b.com', GENERIC_OPENING);

  let lastEvidence = '';
  _setGoalFidelityJudgeForTests(async (input) => {
    lastEvidence = input.evidence;
    return input.evidence.includes('BYTE-IDENTICAL')
      ? { fulfills: false, gap: 'the opening is identical across firms — the skill\'s per-firm research step was skipped' }
      : { fulfills: true, gap: 'opening is firm-specific' };
  });
  try {
    // The 3rd identical send to a NEW distinct firm — the per-item step was skipped.
    const blocked = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', sendArgs(SEND, 'c@firm-c.com', GENERIC_OPENING));
    assert.equal(blocked.action, 'block');
    assert.equal(blocked.mode, 'judge');
    assert.equal(blocked.failureCount, 1);
    assert.match(blocked.reason, /per-firm research/);
    assert.match(lastEvidence, /BYTE-IDENTICAL/, 'the batch-uniformity evidence reached the judge');

    // A genuinely researched, distinct opening to another firm → not uniform → allow.
    const allowed = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', sendArgs(SEND, 'd@firm-d.com',
      'I read your recent appellate win covered in the Birmingham Tribune and noticed your new workers-comp page is not ranking for "Birmingham workers comp lawyer" — that specific gap is why I am reaching out.'));
    assert.equal(allowed.action, 'allow');
    assert.equal(lastEvidence, '(none)', 'a distinct opening produces no uniformity evidence');
  } finally {
    _setGoalFidelityJudgeForTests(null);
  }
});

test('evaluateGoalFidelity: judge OUTAGE during a uniform send-BURST fails CLOSED (park for approval), but a solo send fails OPEN', async () => {
  resetEventLog();
  _resetGoalFidelityStateForTests();
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Email each firm a personalized outreach note referencing our per-firm SEO research.');
  seedSkill(sess.id, 'scorpion-outbound', 'Research each firm before writing; never reuse a generic opening across firms.');
  // Two prior byte-identical sends to DISTINCT firms → a burst is in flight.
  seedSend(sess.id, SEND, 'a@firm-a.com', GENERIC_OPENING);
  seedSend(sess.id, SEND, 'b@firm-b.com', GENERIC_OPENING);
  // The judge is DOWN (throws) — the exact condition of the 45-email runaway.
  _setGoalFidelityJudgeForTests(async () => { throw new Error('judge unavailable (overloaded)'); });
  try {
    const burst = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', sendArgs(SEND, 'c@firm-c.com', GENERIC_OPENING));
    assert.equal(burst.action, 'block', 'judge down + burst → fail CLOSED, do not send unchecked');
    assert.equal(burst.blockKind, 'present_for_approval', 'park for approval, not a counted failure');
    assert.equal(burst.failureCount, undefined, 'a judge outage is not a fidelity violation to escalate');
  } finally {
    _setGoalFidelityJudgeForTests(null);
  }

  // Kill-switch honored: a solo send (no priors) with the judge down still fails OPEN — the gate must never wedge a legitimate one-off.
  resetEventLog();
  _resetGoalFidelityStateForTests();
  const solo = createSession({ kind: 'chat' });
  seedGoal(solo.id, 'Send a note to my contact.');
  seedSkill(solo.id, 'scorpion-outbound', 'Research the firm before writing.');
  _setGoalFidelityJudgeForTests(async () => { throw new Error('judge unavailable'); });
  try {
    const oneOff = await evaluateGoalFidelity(solo.id, 'composio_execute_tool', sendArgs(SEND, 'only@firm.com', GENERIC_OPENING));
    assert.equal(oneOff.action, 'allow', 'no burst → judge outage still fails open (no wedge on one-offs)');
  } finally {
    _setGoalFidelityJudgeForTests(null);
  }
});

test('evaluateGoalFidelity: a draft-only-skill block is present_for_approval — blocks WITHOUT counting a failure (no escalation)', async () => {
  resetEventLog();
  _resetGoalFidelityStateForTests();
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Send the 8 prospect emails from the Scorpion mailbox.');
  seedSkill(sess.id, 'scorpion-outbound', 'This skill does not send email. Present for approval: show To, Subject, Body and ask "Approve, or want changes?". Never claim the email was sent.');
  _setGoalFidelityJudgeForTests(async () => ({
    fulfills: false,
    gap: 'the skill drafts and presents; show the draft for approval before sending',
    blockKind: 'present_for_approval' as const,
  }));
  try {
    const r1 = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', sendArgs(SEND, 'caroline@tobininjurylaw.com', 'Caroline, ...'));
    assert.equal(r1.action, 'block', 'still blocks the silent send');
    assert.equal(r1.blockKind, 'present_for_approval');
    assert.equal(r1.failureCount, undefined, 'a present-for-approval block is NOT counted as a fidelity failure');
    // A second identical block must STILL not escalate (no bumpFailure).
    const r2 = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', sendArgs(SEND, 'caroline@tobininjurylaw.com', 'Caroline, ...'));
    assert.equal(r2.failureCount, undefined, 'still no escalation on repeat — it is an inform, not a failure');
  } finally {
    _setGoalFidelityJudgeForTests(null);
  }
});

test('GoalFidelityCheckFailedError: present_for_approval message says present-and-ask, NOT rebuild-and-retry', () => {
  const present = new GoalFidelityCheckFailedError({
    toolName: 'composio_execute_tool', reason: 'draft-only skill', targets: ['x@y.com'], failureCount: 0, blockKind: 'present_for_approval',
  });
  assert.match(present.message, /PRESENT the drafted/i);
  assert.match(present.message, /Good to send\?/i);
  assert.doesNotMatch(present.message, /rebuild the payload/i);
  assert.doesNotMatch(present.message, /producer script/i);
  assert.equal(present.blockKind, 'present_for_approval');

  // 'other' (or absent) keeps the existing rebuild/retry recovery.
  const other = new GoalFidelityCheckFailedError({
    toolName: 'composio_execute_tool', reason: 'per-firm research skipped', targets: ['x@y.com'], failureCount: 1, blockKind: 'other',
  });
  assert.match(other.message, /rebuild the payload|producer script/i);
  assert.doesNotMatch(other.message, /Good to send\?/i);
});

// ─── §7.2 renderer class: deterministic block, judge never called ──────────

test('evaluateGoalFidelity: a loaded skill whose producer script never ran blocks deterministically (judge not consulted)', async () => {
  resetEventLog();
  _resetGoalFidelityStateForTests();
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Run the lunar local audit for Revill Law and publish the report.');
  seedSkill(sess.id, 'lunar-local-audit', '## Render\nAfter gathering the data, run scripts/generate-html.js to produce the report, then publish dist/index.html.');
  // NOTE: no run_shell_command invoked generate-html.js this session.

  let judged = false;
  _setGoalFidelityJudgeForTests(async () => { judged = true; return { fulfills: true, gap: 'x' }; });
  try {
    const blocked = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', sendArgs('NETLIFY_DEPLOY_SITE_PUBLISH', 'ignored@x.com', 'publish'));
    assert.equal(blocked.action, 'block');
    assert.equal(blocked.mode, 'renderer');
    assert.equal(blocked.skill, 'lunar-local-audit');
    assert.match(blocked.reason, /generate-html\.js/);
    assert.equal(judged, false, 'renderer floor is deterministic — the judge is never called');
  } finally {
    _setGoalFidelityJudgeForTests(null);
  }
});

// ─── §7.3 goal-scope class: payload exceeds the goal → judge blocks ────────

test('evaluateGoalFidelity: payload contradicts a goal scope constraint → block naming the extra content', async () => {
  resetEventLog();
  _resetGoalFidelityStateForTests();
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Send Brooke ONLY the status update. Do NOT include her internal account owner or any other internal CRM field.');
  seedSkill(sess.id, 'crm-send', 'Send exactly what the user requested; never append internal CRM fields the user did not ask for.');

  _setGoalFidelityJudgeForTests(async (input) => input.payload.includes('Account owner')
    ? { fulfills: false, gap: 'the payload includes the internal account owner field the goal said to exclude' }
    : { fulfills: true, gap: 'scope matches the goal' });
  try {
    const blocked = await evaluateGoalFidelity(sess.id, 'composio_execute_tool',
      sendArgs(SEND, 'brooke@client.com', 'Your status is updated. Account owner: Jordan Lee. Internal tier: Gold.'));
    assert.equal(blocked.action, 'block');
    assert.equal(blocked.mode, 'judge');
    assert.match(blocked.reason, /account owner/);
    const err = new GoalFidelityCheckFailedError({ toolName: 'composio_execute_tool', reason: blocked.reason, gap: blocked.gap, targets: blocked.targets, failureCount: blocked.failureCount! });
    assert.match(err.message, /account owner/);
    assert.match(err.message, /Recover/);
  } finally {
    _setGoalFidelityJudgeForTests(null);
  }
});

// ─── §7.4 fail-open paths ──────────────────────────────────────────────────

test('evaluateGoalFidelity: no skill but a GOAL → now JUDGED (2026-06-22 alignment widening; legacy silent-skip is flag-off, see T4)', async () => {
  resetEventLog();
  _resetGoalFidelityStateForTests();
  const prev = process.env.CLEMMY_GOAL_ALIGNMENT_GATE;
  delete process.env.CLEMMY_GOAL_ALIGNMENT_GATE; // default on
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Email this firm a note.');
  let judged = false;
  _setGoalFidelityJudgeForTests(async () => { judged = true; return { fulfills: true, gap: 'aligns', blockKind: 'other' }; });
  try {
    const r = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', sendArgs(SEND, 'a@firm.com', GENERIC_OPENING));
    assert.equal(r.action, 'allow');
    assert.equal(r.mode, 'judge', 'a goal with no skill now routes to the goal-alignment judge (was a silent skip before)');
    assert.equal(judged, true, 'the widening: the judge RAN where it used to short-circuit');
  } finally {
    _setGoalFidelityJudgeForTests(null);
    if (prev === undefined) delete process.env.CLEMMY_GOAL_ALIGNMENT_GATE; else process.env.CLEMMY_GOAL_ALIGNMENT_GATE = prev;
  }
});

test('evaluateGoalFidelity: no user goal → allow, judge never called', async () => {
  resetEventLog();
  _resetGoalFidelityStateForTests();
  const sess = createSession({ kind: 'chat' });
  seedSkill(sess.id, 'scorpion-outbound', '## Per-firm research (REQUIRED)\nResearch each firm before writing.');
  let judged = false;
  _setGoalFidelityJudgeForTests(async () => { judged = true; return { fulfills: false, gap: 'x' }; });
  try {
    const r = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', sendArgs(SEND, 'a@firm.com', GENERIC_OPENING));
    assert.equal(r.action, 'allow');
    assert.equal(judged, false, 'no goal → nothing to verify against → no judge call');
  } finally {
    _setGoalFidelityJudgeForTests(null);
  }
});

test('evaluateGoalFidelity: judge infra error fails open', async () => {
  resetEventLog();
  _resetGoalFidelityStateForTests();
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Email each firm a personalized note referencing per-firm research.');
  seedSkill(sess.id, 'scorpion-outbound', '## Per-firm research (REQUIRED)\nResearch each firm before writing.');
  _setGoalFidelityJudgeForTests(async () => { throw new Error('model down'); });
  try {
    const r = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', sendArgs(SEND, 'a@firm.com', GENERIC_OPENING));
    assert.equal(r.action, 'allow');
    assert.match(r.reason, /fail open/);
  } finally {
    _setGoalFidelityJudgeForTests(null);
  }
});

// ─── §7.5 no-regression ────────────────────────────────────────────────────

test('evaluateGoalFidelity: a faithful personalized send (no identical priors) → allow', async () => {
  resetEventLog();
  _resetGoalFidelityStateForTests();
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Email each firm a personalized note referencing per-firm research.');
  seedSkill(sess.id, 'scorpion-outbound', '## Per-firm research (REQUIRED)\nResearch each firm before writing.');
  _setGoalFidelityJudgeForTests(async (input) => input.evidence.includes('BYTE-IDENTICAL')
    ? { fulfills: false, gap: 'generic' }
    : { fulfills: true, gap: 'opening is firm-specific' });
  try {
    const r = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', sendArgs(SEND, 'unique@firm.com',
      'Your firm\'s new mass-tort page targets terms with strong volume but no backlinks yet — that exact gap is why I reached out today.'));
    assert.equal(r.action, 'allow');
  } finally {
    _setGoalFidelityJudgeForTests(null);
  }
});

test('evaluateGoalFidelity: a legitimately-templated announcement (identical body, but goal+skill do NOT require per-item personalization) → allow (uniformity alone never blocks)', async () => {
  resetEventLog();
  _resetGoalFidelityStateForTests();
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Send the SAME office-closure announcement to every staff member, verbatim.');
  seedSkill(sess.id, 'staff-announcement', 'Send the identical announcement text to everyone on the list. Do not personalize.');
  const ANNOUNCE = 'The office will be closed Monday for the holiday. All deadlines move to Tuesday. Please plan accordingly and reach out to your manager with questions.';
  seedSend(sess.id, SEND, 'staff1@co.com', ANNOUNCE);
  seedSend(sess.id, SEND, 'staff2@co.com', ANNOUNCE);
  let sawIdenticalEvidence = false;
  // The judge is told the body is identical across staff — but the goal+skill
  // explicitly WANT that, so a faithful judge passes. Uniformity is evidence,
  // not a verdict.
  _setGoalFidelityJudgeForTests(async (input) => {
    if (input.evidence.includes('BYTE-IDENTICAL')) sawIdenticalEvidence = true;
    return { fulfills: true, gap: 'the goal asks for an identical announcement; templating is intended' };
  });
  try {
    const r = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', sendArgs(SEND, 'staff3@co.com', ANNOUNCE));
    assert.equal(r.action, 'allow');
    assert.equal(sawIdenticalEvidence, true, 'uniformity was detected and surfaced — but the judge, not the signal, decides');
  } finally {
    _setGoalFidelityJudgeForTests(null);
  }
});

// ─── §7.6 escalation ────────────────────────────────────────────────────────

test('evaluateGoalFidelity: a second consecutive block for the same target escalates to ask-the-user wording', async () => {
  resetEventLog();
  _resetGoalFidelityStateForTests();
  const sess = createSession({ kind: 'chat' });
  seedGoal(sess.id, 'Email each firm a personalized note referencing per-firm research.');
  seedSkill(sess.id, 'scorpion-outbound', '## Per-firm research (REQUIRED)\nResearch each firm before writing.');
  _setGoalFidelityJudgeForTests(async () => ({ fulfills: false, gap: 'opening is generic — per-firm research skipped' }));
  try {
    const args = sendArgs(SEND, 'same@firm.com', GENERIC_OPENING);
    const first = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', args);
    assert.equal(first.failureCount, 1);
    const firstErr = new GoalFidelityCheckFailedError({ toolName: 'composio_execute_tool', reason: first.reason, gap: first.gap, targets: first.targets, failureCount: first.failureCount! });
    assert.doesNotMatch(firstErr.message, /ask_user_question/, 'first failure reroutes, does not escalate');

    const second = await evaluateGoalFidelity(sess.id, 'composio_execute_tool', args);
    assert.equal(second.failureCount, 2);
    const secondErr = new GoalFidelityCheckFailedError({ toolName: 'composio_execute_tool', reason: second.reason, gap: second.gap, targets: second.targets, failureCount: second.failureCount! });
    assert.match(secondErr.message, /ask_user_question/, 'repeated failure instructs a user check-in');
    assert.match(secondErr.message, /STOP/);
  } finally {
    _setGoalFidelityJudgeForTests(null);
  }
});

// ─── §7.7 kill-switch ─────────────────────────────────────────────────────

test('isGoalFidelityGateEnabled: default on; CLEMMY_GOAL_FIDELITY_GATE=off disables', () => {
  const prev = process.env.CLEMMY_GOAL_FIDELITY_GATE;
  try {
    delete process.env.CLEMMY_GOAL_FIDELITY_GATE;
    assert.equal(isGoalFidelityGateEnabled(), true, 'default on');
    process.env.CLEMMY_GOAL_FIDELITY_GATE = 'off';
    assert.equal(isGoalFidelityGateEnabled(), false, 'off is the kill-switch');
    process.env.CLEMMY_GOAL_FIDELITY_GATE = 'on';
    assert.equal(isGoalFidelityGateEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_GOAL_FIDELITY_GATE;
    else process.env.CLEMMY_GOAL_FIDELITY_GATE = prev;
  }
});

// ── Goal-ALIGNMENT widening (2026-06-22): judge ad-hoc skill-less irreversible
// writes against the GOAL so a YOLO send is goal-vetted before it fires. The gap
// was the skill-conditioning short-circuit (skills.length===0 → allow, no judge).
const ALIGN = 'CLEMMY_GOAL_ALIGNMENT_GATE';
function withAlign<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> | T {
  const prev = process.env[ALIGN];
  if (value === undefined) delete process.env[ALIGN]; else process.env[ALIGN] = value;
  const restore = () => { if (prev === undefined) delete process.env[ALIGN]; else process.env[ALIGN] = prev; };
  try { const r = fn(); return r instanceof Promise ? r.finally(restore) : (restore(), r); }
  catch (e) { restore(); throw e; }
}

test('goal-alignment flag: default on, kill-switchable', () => {
  withAlign(undefined, () => assert.equal(isGoalAlignmentGateEnabled(), true, 'default on'));
  withAlign('off', () => assert.equal(isGoalAlignmentGateEnabled(), false));
  withAlign('0', () => assert.equal(isGoalAlignmentGateEnabled(), false));
});

test('T1 skill-less ALIGNED: a recovered goal with NO skill PASSES via the judge (the keystone gap)', async () => {
  await withAlign('on', async () => {
    _resetGoalFidelityStateForTests();
    const sess = createSession({ kind: 'chat' });
    seedGoal(sess.id, 'Email a short organic-search summary for Rubenstein Law to nathan@breakthroughcoaching.ai.');
    let called = 0;
    _setGoalFidelityJudgeForTests(async () => { called++; return { fulfills: true, gap: 'aligns with the goal', blockKind: 'other' }; });
    const r = await evaluateGoalFidelity(sess.id, SEND, sendArgs(SEND, 'nathan@breakthroughcoaching.ai', 'Summary: organic traffic up 25% QoQ; recommend X.'));
    _setGoalFidelityJudgeForTests(null);
    assert.equal(r.action, 'allow');
    assert.equal(r.mode, 'judge', 'the judge RAN (not the old skill-less short-circuit)');
    assert.equal(called, 1, 'judge invoked exactly once');
  });
});

test('T2 skill-less MISALIGNED: ADVISORY — informs, does NOT hard-block the send (north-star: inform, rarely block)', async () => {
  await withAlign('on', async () => {
    _resetGoalFidelityStateForTests();
    const sess = createSession({ kind: 'chat' });
    seedGoal(sess.id, 'Email a summary to nathan@breakthroughcoaching.ai.');
    _setGoalFidelityJudgeForTests(async () => ({ fulfills: false, gap: 'recipient boss@rival.com contradicts the goal', blockKind: 'other' }));
    const r = await evaluateGoalFidelity(sess.id, SEND, sendArgs(SEND, 'boss@rival.com', 'off-goal'));
    _setGoalFidelityJudgeForTests(null);
    assert.equal(r.action, 'allow', 'a skill-less goal-alignment miss does NOT hard-block — it informs (advisory)');
    assert.equal(r.mode, 'advisory');
    assert.match(r.gap ?? '', /contradicts the goal/, 'the gap is recorded for the review surface');
  });
});

test('T3 NO goal → allow, judge NEVER called (gate never invents a goal)', async () => {
  await withAlign('on', async () => {
    _resetGoalFidelityStateForTests();
    const sess = createSession({ kind: 'chat' });
    let called = 0;
    _setGoalFidelityJudgeForTests(async () => { called++; return { fulfills: false, gap: 'x', blockKind: 'other' }; });
    const r = await evaluateGoalFidelity(sess.id, SEND, sendArgs(SEND, 'a@b.com', 'hi'));
    _setGoalFidelityJudgeForTests(null);
    assert.equal(r.action, 'allow');
    assert.equal(r.mode, 'allow', 'short-circuit, not the judge');
    assert.equal(called, 0, 'no goal → never invoke the judge');
  });
});

test('T4 FLAG OFF: a skill-less send skips the judge (byte-identical legacy)', async () => {
  await withAlign('off', async () => {
    _resetGoalFidelityStateForTests();
    const sess = createSession({ kind: 'chat' });
    seedGoal(sess.id, 'Email a summary to nathan@breakthroughcoaching.ai.');
    let called = 0;
    _setGoalFidelityJudgeForTests(async () => { called++; return { fulfills: false, gap: 'x', blockKind: 'other' }; });
    const r = await evaluateGoalFidelity(sess.id, SEND, sendArgs(SEND, 'a@b.com', 'hi'));
    _setGoalFidelityJudgeForTests(null);
    assert.equal(r.action, 'allow');
    assert.equal(r.mode, 'allow');
    assert.equal(called, 0, 'flag off → skill-less short-circuit, judge never called');
  });
});

test('T5 FAIL-OPEN: a skill-less judge error allows (never hard-stall)', async () => {
  await withAlign('on', async () => {
    _resetGoalFidelityStateForTests();
    const sess = createSession({ kind: 'chat' });
    seedGoal(sess.id, 'Email a summary to nathan@breakthroughcoaching.ai.');
    _setGoalFidelityJudgeForTests(async () => { throw new Error('judge infra down'); });
    const r = await evaluateGoalFidelity(sess.id, SEND, sendArgs(SEND, 'a@b.com', 'hi'));
    _setGoalFidelityJudgeForTests(null);
    assert.equal(r.action, 'allow', 'fail-open, not a hard stall');
  });
});

test('T6 UNCHANGED with a skill loaded: a misaligned per-firm send still BLOCKS', async () => {
  await withAlign('on', async () => {
    _resetGoalFidelityStateForTests();
    const sess = createSession({ kind: 'chat' });
    seedGoal(sess.id, 'Email each firm a personalized note referencing our per-firm SEO research.');
    seedSkill(sess.id, 'scorpion-outbound', '## Per-firm research (REQUIRED)\nResearch each firm before writing; never reuse a generic opening across firms.');
    _setGoalFidelityJudgeForTests(async () => ({ fulfills: false, gap: 'generic opening reused across distinct firms', blockKind: 'other' }));
    const r = await evaluateGoalFidelity(sess.id, SEND, sendArgs(SEND, 'a@firm.com', GENERIC_OPENING));
    _setGoalFidelityJudgeForTests(null);
    assert.equal(r.action, 'block', 'skill-loaded behavior is unchanged by the widening');
  });
});

test('T7 skill-less ADVISORY never escalates: repeated misses stay advisory (never blocks, no failureCount)', async () => {
  await withAlign('on', async () => {
    _resetGoalFidelityStateForTests();
    const sess = createSession({ kind: 'chat' });
    seedGoal(sess.id, 'Email a summary to nathan@breakthroughcoaching.ai.');
    _setGoalFidelityJudgeForTests(async () => ({ fulfills: false, gap: 'off-goal recipient', blockKind: 'other' }));
    const r1 = await evaluateGoalFidelity(sess.id, SEND, sendArgs(SEND, 'boss@rival.com', 'x'));
    const r2 = await evaluateGoalFidelity(sess.id, SEND, sendArgs(SEND, 'boss@rival.com', 'x'));
    _setGoalFidelityJudgeForTests(null);
    assert.equal(r1.mode, 'advisory');
    assert.equal(r2.mode, 'advisory');
    assert.equal(r2.action, 'allow', 'advisory informs every time — it never escalates to a hard block');
  });
});

test('T8 prompt: skill-less includes (no skill loaded) + the goal-alignment rubric + FAIL OPEN', () => {
  const p = buildGoalFidelityPrompt({ goal: 'Email a summary to nathan@breakthroughcoaching.ai', skills: [], payload: 'send to nathan@breakthroughcoaching.ai', evidence: '(none)' });
  assert.match(p, /\(no skill loaded\)/);
  assert.match(p, /judge ONLY goal-alignment/);
  assert.match(p, /FAIL OPEN/);
});
