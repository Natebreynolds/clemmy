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
const { gatherSessionSkills, sessionReadAnySkill, summarizeToolCallsForJudge, extractInvokedScripts, skillExecutionShortfall } = await import('./skill-execution.js');

function skillRead(sessionId: string, callId: string, name: string): void {
  appendEvent({ sessionId, turn: 0, role: 'agent', type: 'tool_called', data: { tool: 'skill_read', callId, arguments: JSON.stringify({ name }) } });
}
function shellRun(sessionId: string, command: string): void {
  appendEvent({ sessionId, turn: 0, role: 'agent', type: 'tool_called', data: { tool: 'run_shell_command', callId: `c-${Math.abs(command.length)}-${command.slice(0, 4)}`, arguments: JSON.stringify({ command }) } });
}
/** Seed a loaded skill whose body prescribes the given src/ scripts. */
function loadScriptSkill(sessionId: string, callId: string, name: string, scripts: string[]): void {
  skillRead(sessionId, callId, name);
  const body = `Act 2 — build:\n${scripts.map((s, i) => `${i + 1}. Run \`src/${s}\` to produce the artifact.`).join('\n')}\nValidation is **Mandatory**.`;
  writeToolOutput({ sessionId, callId, tool: 'skill_read', output: `# ${name}\n\nmanifest\n\ncrib\n\n=== HOW TO RUN THIS SKILL ===\nx\n\n---\n${body}` });
}

test('skillExecutionShortfall: a script-backed skill with ZERO prescribed scripts run → shortfall (hand-rolled deliverable)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  loadScriptSkill(sess.id, 'c1', 'lunar-audit', ['aggregate.js', 'generate-html.js', 'validate-html.js']);
  // She hand-rolled via an inline node heredoc + plain shell — no prescribed script ran.
  shellRun(sess.id, "node - <<'NODE'\nconst fs=require('fs'); fs.writeFileSync('out.html','<html>');\nNODE");
  shellRun(sess.id, 'netlify deploy --dir=out --prod');
  const gap = skillExecutionShortfall(sess.id);
  assert.ok(gap, 'a skill whose bundled scripts never ran is flagged');
  assert.equal(gap!.skill, 'lunar-audit');
  // The required set is the RENDERER (generate-html.js), not every prescribed script.
  assert.ok(gap!.prescribed.includes('generate-html.js'), 'the renderer is named as required');
});

test('skillExecutionShortfall: running the RENDERER clears the gate (followed)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  loadScriptSkill(sess.id, 'c1', 'lunar-audit', ['aggregate.js', 'generate-html.js', 'validate-html.js']);
  shellRun(sess.id, 'node src/generate-html.js > out.html');
  assert.equal(skillExecutionShortfall(sess.id), null, 'ran the renderer → not a shortfall');
});

test('skillExecutionShortfall: running ONLY the validator (require) does NOT clear — the renderer must run (the lunar gaming)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  loadScriptSkill(sess.id, 'c1', 'lunar-audit', ['aggregate.js', 'generate-html.js', 'validate-html.js']);
  // Hand-rolled HTML, then validated it via require — but never ran the renderer.
  shellRun(sess.id, "node - <<'NODE'\nconst v=require('./src/validate-html'); console.log(v('<html>'));\nNODE");
  const gap = skillExecutionShortfall(sess.id);
  assert.ok(gap, 'validating a hand-roll is NOT executing the skill — still a shortfall');
  assert.ok(gap!.prescribed.includes('generate-html.js'), 'the renderer is still required');
});

test('skillExecutionShortfall: require()-ing the renderer clears the gate (library-style use)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  loadScriptSkill(sess.id, 'c1', 'lunar-audit', ['aggregate.js', 'generate-html.js', 'validate-html.js']);
  shellRun(sess.id, "node -e \"const {generateHtml}=require('./src/generate-html'); require('fs').writeFileSync('o.html', generateHtml(d).html)\"");
  assert.equal(skillExecutionShortfall(sess.id), null, 'require-ing + using the renderer counts as executed');
});

test('skillExecutionShortfall: require(path.join(base,"src/generate-html.js")) clears the gate (no false-positive)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  loadScriptSkill(sess.id, 'c1', 'lunar-audit', ['aggregate.js', 'generate-html.js', 'validate-html.js']);
  // The real lunar-audit form: build the path with path.join, not a string literal.
  shellRun(sess.id, "node - <<'NODE'\nconst path=require('path'); const base='/x/skills/lunar';\nconst generateHtml=require(path.join(base,'src/generate-html.js'));\nrequire('fs').writeFileSync('o.html', generateHtml(d).html);\nNODE");
  assert.equal(skillExecutionShortfall(sess.id), null, 'path.join-constructed require of the renderer must NOT false-bounce');
});

test('skillExecutionShortfall: a pure-reference skill (no bundled scripts) is never gated', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  skillRead(sess.id, 'c1', 'voice-guide');
  writeToolOutput({ sessionId: sess.id, callId: 'c1', tool: 'skill_read', output: '# voice-guide\n\nm\n\nc\n\n=== HOW TO RUN THIS SKILL ===\nx\n\n---\nWrite in a warm, concise voice. No em dashes.' });
  assert.equal(skillExecutionShortfall(sess.id), null, 'no prescribed scripts → nothing to enforce');
});

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
