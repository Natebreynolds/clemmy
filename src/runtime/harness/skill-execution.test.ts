/**
 * Run: npx tsx --test src/runtime/harness/skill-execution.test.ts
 *
 * Shared Layer-2 plumbing for "run skills as designed": gather the skills a
 * session loaded (un-clipped, envelope stripped), the cheap read-gate, and the
 * tool-call evidence summary. All helpers FAIL-OPEN. Temp CLEMENTINE_HOME.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-skill-exec-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { resetEventLog, createSession, appendEvent, writeToolOutput } = await import('./eventlog.js');
const { gatherSessionSkills, sessionReadAnySkill, summarizeToolCallsForJudge, extractInvokedScripts } = await import('./skill-execution.js');

function skillRead(sessionId: string, callId: string, name: string): void {
  appendEvent({ sessionId, turn: 0, role: 'agent', type: 'tool_called', data: { tool: 'skill_read', callId, arguments: JSON.stringify({ name }) } });
}

test('gatherSessionSkills returns un-clipped bodies with the skill_read envelope stripped', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  skillRead(sess.id, 'call_s1', 'redesign-skill');
  const fullReturn = [
    '# redesign-skill', '', 'Skill location on disk: /x', '', 'Tool name mapping…',
    '', '=== HOW TO RUN THIS SKILL ===', 'This skill is a PROCEDURE…',
    '', '---', 'Step 1: generate hero imagery.\nStep 2: build the site.\nStep 3: deploy.',
  ].join('\n');
  writeToolOutput({ sessionId: sess.id, callId: 'call_s1', tool: 'skill_read', output: fullReturn });

  const skills = gatherSessionSkills(sess.id);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'redesign-skill');
  assert.match(skills[0].body, /generate hero imagery/);
  assert.doesNotMatch(skills[0].body, /HOW TO RUN THIS SKILL/, 'envelope must be stripped');
  assert.doesNotMatch(skills[0].body, /Tool name mapping/, 'crib must be stripped');
});

test('gatherSessionSkills keeps a body that itself contains --- dividers (first-divider strip)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  skillRead(sess.id, 'c1', 'multi-section');
  const body = 'Phase 1: do X.\n\n---\n\nPhase 2: do Y.\n\n---\n\nPhase 3: deploy.';
  writeToolOutput({ sessionId: sess.id, callId: 'c1', tool: 'skill_read', output: `# multi-section\n\nmanifest\n\ncrib\n\n=== HOW TO RUN THIS SKILL ===\nx\n\n---\n${body}` });
  const skills = gatherSessionSkills(sess.id);
  assert.equal(skills.length, 1);
  assert.match(skills[0].body, /Phase 1/);
  assert.match(skills[0].body, /Phase 3: deploy/, 'later phases (after inner --- dividers) must be kept');
});

test('gatherSessionSkills dedupes repeated reads of the same skill', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  skillRead(sess.id, 'c1', 'taste-skill');
  writeToolOutput({ sessionId: sess.id, callId: 'c1', tool: 'skill_read', output: '#taste\n---\nbody A' });
  skillRead(sess.id, 'c2', 'taste-skill');
  writeToolOutput({ sessionId: sess.id, callId: 'c2', tool: 'skill_read', output: '#taste\n---\nbody B' });
  assert.equal(gatherSessionSkills(sess.id).length, 1);
});

test('sessionReadAnySkill: true when a skill was read, false otherwise', () => {
  resetEventLog();
  const a = createSession({ kind: 'chat' });
  skillRead(a.id, 'c1', 'x');
  assert.equal(sessionReadAnySkill(a.id), true);

  const b = createSession({ kind: 'chat' });
  appendEvent({ sessionId: b.id, turn: 0, role: 'agent', type: 'tool_called', data: { tool: 'read_file', callId: 'c2', arguments: '{}' } });
  assert.equal(sessionReadAnySkill(b.id), false);
});

test('summarizeToolCallsForJudge surfaces composio slugs + counts (so the judge sees what fired)', () => {
  resetEventLog();
  const s = createSession({ kind: 'chat' });
  appendEvent({ sessionId: s.id, turn: 0, role: 'agent', type: 'tool_called', data: { tool: 'run_shell_command', callId: 'c1', arguments: '{}' } });
  appendEvent({ sessionId: s.id, turn: 0, role: 'agent', type: 'tool_called', data: { tool: 'composio_execute_tool', callId: 'c2', arguments: JSON.stringify({ tool_slug: 'AIRTABLE_LIST_RECORDS' }) } });
  const sum = summarizeToolCallsForJudge(s.id);
  assert.match(sum, /run_shell_command×1/);
  assert.match(sum, /composio:AIRTABLE_LIST_RECORDS×1/);
});

// 2026-06-15: make a skill's prescribed scripts VISIBLE to the judge, so "the
// skill says run generate-html.js and it never ran" becomes checkable. General
// to any script-backed skill (.js/.py/.sh, npm run …), not HTML-specific.
test('extractInvokedScripts pulls executed script basenames across interpreters', () => {
  assert.deepEqual(extractInvokedScripts('node src/generate-html.js --out index.html'), ['generate-html.js']);
  assert.deepEqual(extractInvokedScripts('cd /x && python3 scripts/ingest.py'), ['ingest.py']);
  assert.deepEqual(extractInvokedScripts('./build.sh && node validate-html.js'), ['build.sh', 'validate-html.js']);
  assert.deepEqual(extractInvokedScripts('npm run audit'), ['npm:audit']);
  assert.deepEqual(extractInvokedScripts('ls -la && cat foo.txt'), []);   // nothing executed
  assert.deepEqual(extractInvokedScripts('echo "node fake.js"'), []);     // a quoted echo is not a run — correctly ignored
});

test('summarizeToolCallsForJudge names the script a shell call ran (so the judge sees generate-html.js fired or did NOT)', () => {
  resetEventLog();
  const s = createSession({ kind: 'chat' });
  appendEvent({ sessionId: s.id, turn: 0, role: 'agent', type: 'tool_called', data: { tool: 'run_shell_command', callId: 'g1', arguments: JSON.stringify({ command: 'node src/generate-html.js' }) } });
  appendEvent({ sessionId: s.id, turn: 0, role: 'agent', type: 'tool_called', data: { tool: 'run_shell_command', callId: 'v1', arguments: JSON.stringify({ command: 'node src/validate-html.js index.html' }) } });
  appendEvent({ sessionId: s.id, turn: 0, role: 'agent', type: 'tool_called', data: { tool: 'run_shell_command', callId: 'x1', arguments: JSON.stringify({ command: 'ls -la' }) } });
  const sum = summarizeToolCallsForJudge(s.id);
  assert.match(sum, /run_shell_command\(generate-html\.js\)×1/);
  assert.match(sum, /run_shell_command\(validate-html\.js\)×1/);
  assert.match(sum, /run_shell_command×1/);   // the bare `ls` keeps the generic key
});

test('all helpers FAIL-OPEN on an unknown/bad session', () => {
  assert.deepEqual(gatherSessionSkills('nope-not-a-session'), []);
  assert.equal(sessionReadAnySkill('nope-not-a-session'), false);
  // summarize returns a string (possibly the "no tool calls" sentinel) and never throws.
  assert.equal(typeof summarizeToolCallsForJudge('nope-not-a-session'), 'string');
});
