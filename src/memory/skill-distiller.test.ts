/**
 * Run: npx tsx --test src/memory/skill-distiller.test.ts
 *
 * Capability compounding (C1 store + C2 novelty gate). The LLM distillation
 * call is not exercised here (covered by a live smoke); these lock the
 * deterministic pieces: the draft tier on disk, index rendering / quarantine,
 * the self-improvement helpers, and the novelty gate that decides whether a
 * session is even worth distilling.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-distiller-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const {
  writeDistilledSkill, loadSkill, listSkills, renderSkillsIndex,
  updateSkillFrontmatter, appendSkillPitfall, SKILLS_DIR,
} = await import('./skill-store.js');
const { assessNovelty, reinforceDraftSkills, _testOnly_sanitizeDistilledSkillOutput } = await import('./skill-distiller.js');
const { searchFactsByText } = await import('./facts.js');
import type { TraceToolCall } from '../execution/trace-to-workflow.js';

beforeEach(() => {
  rmSync(SKILLS_DIR, { recursive: true, force: true });
});

// ─── C1: draft tier ──────────────────────────────────────────────────────────

test('writeDistilledSkill writes a draft with provenance + counters', () => {
  const name = writeDistilledSkill({
    name: 'seo-brief', description: 'Audit a site and write the SEO brief.',
    body: '1. Pull metrics\n2. Write the brief', origin: { kind: 'chat', sourceId: 'goal-1' },
  });
  assert.equal(name, 'seo-brief');
  const skill = loadSkill('seo-brief')!;
  assert.equal(skill.frontmatter.tier, 'draft');
  assert.equal(skill.frontmatter.origin?.kind, 'chat');
  assert.ok(skill.frontmatter.origin?.distilledAt);
  assert.equal(skill.frontmatter.useCount, 0);
  assert.match(skill.body, /Pull metrics/);
});

test('writeDistilledSkill rejects an unsafe name', () => {
  assert.equal(writeDistilledSkill({ name: '../escape', description: 'x', body: 'y', origin: { kind: 'manual' } }), null);
});

test('renderSkillsIndex separates draft block and hides quarantined drafts', () => {
  writeDistilledSkill({ name: 'good-draft', description: 'a usable draft', body: 'do it', origin: { kind: 'chat' } });
  writeDistilledSkill({ name: 'bad-draft', description: 'a quarantined draft', body: 'do it', origin: { kind: 'chat' } });
  updateSkillFrontmatter('bad-draft', { quarantined: true });

  const index = renderSkillsIndex();
  assert.match(index, /Draft skills/, 'draft section present');
  assert.match(index, /good-draft/);
  assert.doesNotMatch(index, /bad-draft/, 'quarantined draft omitted from the index');
  // But it is still on disk for the dashboard.
  assert.ok(loadSkill('bad-draft'));
});

test('updateSkillFrontmatter promotes a draft to approved; appendSkillPitfall reuses the section', () => {
  writeDistilledSkill({ name: 'promote-me', description: 'd', body: 'steps', origin: { kind: 'chat' } });
  updateSkillFrontmatter('promote-me', { tier: 'approved', useCount: 2 });
  const promoted = loadSkill('promote-me')!;
  assert.equal(promoted.frontmatter.tier, 'approved');
  assert.equal(promoted.frontmatter.useCount, 2);

  appendSkillPitfall('promote-me', 'FAILED 2026-06-12: rate limited');
  appendSkillPitfall('promote-me', 'FAILED 2026-06-13: bad slug');
  const body = loadSkill('promote-me')!.body;
  assert.equal((body.match(/## Pitfalls/g) ?? []).length, 1, 'one pitfalls header reused');
  assert.match(body, /rate limited/);
  assert.match(body, /bad slug/);
});

// ─── C2: novelty gate ────────────────────────────────────────────────────────

function call(tool: string, args = '{}', slug?: string): TraceToolCall {
  return { tool, args, callId: `c${Math.random()}`, slug };
}

test('novelty gate: discovery + breadth + enough calls ⇒ novel', () => {
  const calls: TraceToolCall[] = [
    call('composio_search_tools', '{"q":"seo"}'),
    call('composio_execute_tool', '{"a":1}', 'DATAFORSEO_RANK'),
    call('composio_execute_tool', '{"a":2}', 'DATAFORSEO_KEYWORDS'),
    call('run_shell_command', '{"cmd":"x"}'),
    call('write_file', '{"path":"brief.md"}'),
  ];
  const a = assessNovelty(calls);
  assert.equal(a.novel, true, a.reason);
});

test('novelty gate: a routine single-family execution is NOT novel', () => {
  const calls: TraceToolCall[] = [
    call('composio_execute_tool', '{"a":1}', 'GMAIL_SEND'),
    call('composio_execute_tool', '{"a":1}', 'GMAIL_SEND'),
  ];
  assert.equal(assessNovelty(calls).novel, false);
});

test('novelty gate: trial-and-error (same slug, changed args) counts as discovery', () => {
  const calls: TraceToolCall[] = [
    call('composio_execute_tool', '{"v":"first"}', 'AIRTABLE_CREATE'),
    call('composio_execute_tool', '{"v":"second"}', 'AIRTABLE_CREATE'), // retried with change
    call('run_shell_command', '{"cmd":"a"}'),
    call('write_file', '{"p":"x"}'),
    call('read_file', '{"p":"y"}'),
  ];
  const a = assessNovelty(calls);
  assert.equal(a.hadDiscovery, true);
  assert.equal(a.novel, true, a.reason);
});

test('novelty gate: enough breadth but NO discovery ⇒ not novel', () => {
  const calls: TraceToolCall[] = [
    call('read_file', '{"p":"1"}'),
    call('write_file', '{"p":"2"}'),
    call('run_shell_command', '{"c":"3"}'),
    call('list_files', '{"p":"4"}'),
    call('read_file', '{"p":"5"}'),
  ];
  assert.equal(assessNovelty(calls).novel, false, 'no search + no retry-with-change ⇒ skip');
});

test('distilled skill sanitizer accepts fenced schema-drifted JSON', () => {
  const skill = _testOnly_sanitizeDistilledSkillOutput('```json\n' + JSON.stringify({
    title: 'Market Leader / Send Contacts!',
    summary: 'Send approved contact batches using the proven mail workflow.',
    prerequisites: 'mcp:composio, secret:GMAIL_API_KEY',
    steps: [
      'Load the approved contact batch from the workspace artifact.',
      'Validate every recipient and draft the message before sending.',
      'Send only after the existing approval gate has passed.',
    ],
    tools: [
      { slug: 'GMAIL_SEND_EMAIL', args: { to: '<email>', subject: '<subject>', body: '<body>' }, gotcha: 'Use the approved mailbox.' },
    ],
    gotchas: 'Do not send to unapproved contacts.',
  }) + '\n```');
  assert.ok(skill);
  assert.equal(skill.name, 'market-leader-send-contacts');
  assert.match(skill.description, /approved contact batches/);
  assert.deepEqual(skill.requires, ['mcp:composio', 'secret:GMAIL_API_KEY']);
  assert.match(skill.procedureMarkdown, /approved contact batch/);
  assert.equal(skill.provenTools[0].tool, 'GMAIL_SEND_EMAIL');
  assert.equal(skill.provenTools[0].notes, 'Use the approved mailbox.');
  assert.deepEqual(skill.pitfalls, ['Do not send to unapproved contacts.']);
});

// ─── C4: self-improvement ────────────────────────────────────────────────────

test('reinforce success promotes a draft to approved after 2 validated successes', () => {
  writeDistilledSkill({ name: 'rein-ok', description: 'd', body: 'steps', origin: { kind: 'chat' } });
  reinforceDraftSkills(['rein-ok'], 'success');
  assert.equal(loadSkill('rein-ok')!.frontmatter.tier, 'draft', 'one success not enough');
  assert.equal(loadSkill('rein-ok')!.frontmatter.useCount, 1);
  reinforceDraftSkills(['rein-ok'], 'success');
  assert.equal(loadSkill('rein-ok')!.frontmatter.tier, 'approved', 'promoted at 2');
});

test('reinforce failure quarantines a draft after 2 failures and appends pitfalls', () => {
  writeDistilledSkill({ name: 'rein-bad', description: 'd', body: 'steps', origin: { kind: 'chat' } });
  reinforceDraftSkills(['rein-bad'], 'failure', 'tool 500');
  assert.equal(loadSkill('rein-bad')!.frontmatter.quarantined ?? false, false, 'one failure tolerated');
  // Move B: no durable fact after a SINGLE failure (not yet proven-bad).
  assert.ok(!searchFactsByText('rein-bad', 20).some((f) => /rein-bad/.test(String(f.content))), 'no avoid-fact after one failure');
  reinforceDraftSkills(['rein-bad'], 'failure', 'bad slug');
  const s = loadSkill('rein-bad')!;
  assert.equal(s.frontmatter.quarantined, true, 'quarantined at 2');
  assert.match(s.body, /tool 500/);
  assert.match(s.body, /bad slug/);
  // Move B: quarantine (2+ failures) mints a durable, recallable 'feedback' avoid-fact
  // so the proven-bad approach doesn't repeat in an unrelated later session.
  const avoid = searchFactsByText('rein-bad', 20).find((f) => f.kind === 'feedback' && /Avoid repeating this.*rein-bad/.test(String(f.content)));
  assert.ok(avoid, 'quarantine persisted a durable avoid-fact');
});

test('Move B review fix: a TRANSIENT failure never quarantines nor mints an avoid-fact', () => {
  writeDistilledSkill({ name: 'rein-transient', description: 'd', body: 'steps', origin: { kind: 'chat' } });
  reinforceDraftSkills(['rein-transient'], 'failure', 'the upstream API timed out');
  reinforceDraftSkills(['rein-transient'], 'failure', '429 rate limited, overloaded');
  const s = loadSkill('rein-transient')!;
  assert.notEqual(s.frontmatter.quarantined, true, 'flaky-infra failures must not quarantine a valid approach');
  assert.equal(s.frontmatter.failureCount ?? 0, 0, 'transient failures do not count toward quarantine');
  assert.ok(!searchFactsByText('rein-transient', 20).some((f) => /rein-transient/.test(String(f.content))), 'no permanent avoid-fact from transient failures');
});

test('failure-learning kill-switch: CLEMMY_FAILURE_LEARNING=off mints no avoid-fact on quarantine', () => {
  const prev = process.env.CLEMMY_FAILURE_LEARNING;
  process.env.CLEMMY_FAILURE_LEARNING = 'off';
  try {
    writeDistilledSkill({ name: 'rein-off', description: 'd', body: 'steps', origin: { kind: 'chat' } });
    reinforceDraftSkills(['rein-off'], 'failure', 'e1');
    reinforceDraftSkills(['rein-off'], 'failure', 'e2');
    assert.equal(loadSkill('rein-off')!.frontmatter.quarantined, true, 'still quarantines');
    assert.ok(!searchFactsByText('rein-off', 20).some((f) => /rein-off/.test(String(f.content))), 'kill-switch → no avoid-fact');
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_FAILURE_LEARNING; else process.env.CLEMMY_FAILURE_LEARNING = prev;
  }
});

test('reinforce never demotes an APPROVED (user-blessed) skill', () => {
  writeDistilledSkill({ name: 'rein-approved', description: 'd', body: 'steps', origin: { kind: 'chat' } });
  updateSkillFrontmatter('rein-approved', { tier: 'approved' });
  reinforceDraftSkills(['rein-approved'], 'failure', 'x');
  reinforceDraftSkills(['rein-approved'], 'failure', 'y');
  const s = loadSkill('rein-approved')!;
  assert.equal(s.frontmatter.tier, 'approved', 'approved untouched');
  assert.notEqual(s.frontmatter.quarantined, true, 'approved never auto-quarantined');
});
