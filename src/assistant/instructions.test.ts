/**
 * Run: npx tsx --test src/assistant/instructions.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderChannelDirective, renderActionDisciplineDirective, hasScopedLanguage, EXECUTE_DIRECTIVE, AGENT_CREATION_DIRECTIVE } from './instructions.js';

test('EXECUTE_DIRECTIVE: tells the model to act in-turn + preview-as-sample, and stays artifact-agnostic', () => {
  // The two code-backed rules must be present.
  assert.match(EXECUTE_DIRECTIVE, /ACT IN THE SAME TURN/i);
  assert.match(EXECUTE_DIRECTIVE, /promises work but produces no artifact is a failure/i);
  assert.match(EXECUTE_DIRECTIVE, /PREVIEW|representative SAMPLE/i);
  // Anti-taxonomy guard: the owner explicitly rejected baking a domain/verb
  // taxonomy (draft-vs-send / email-specific) into the engine — preview/execute
  // is the SAME machinery for any artifact. Keep this directive taxonomy-free so
  // the email framing can't creep back in.
  assert.doesNotMatch(EXECUTE_DIRECTIVE, /\bdraft(s|ing)?\b/i);
  assert.doesNotMatch(EXECUTE_DIRECTIVE, /\bsend(s|ing)?\b/i);
  assert.doesNotMatch(EXECUTE_DIRECTIVE, /\b(reversible|irreversible)\b/i);
  assert.doesNotMatch(EXECUTE_DIRECTIVE, /\bemail/i);
});

test('AGENT_CREATION_DIRECTIVE: keeps agents, workflows, and runs separate and proposal-first', () => {
  assert.match(AGENT_CREATION_DIRECTIVE, /Agent = reusable capability\/role/);
  assert.match(AGENT_CREATION_DIRECTIVE, /Workflow = repeatable process/);
  assert.match(AGENT_CREATION_DIRECTIVE, /Run = one execution/);
  assert.match(AGENT_CREATION_DIRECTIVE, /agent_propose/);
  assert.match(AGENT_CREATION_DIRECTIVE, /Do NOT silently create\/enable persistent agents/);
});

test('discord: requests tight conversational replies under ~500 chars', () => {
  const d = renderChannelDirective('discord');
  assert.match(d, /Discord/);
  assert.match(d, /under ~500 characters/);
});

test('discord: deliverables go to disk via write_file, not pasted into chat', () => {
  // Prevents a regression where the agent reads the "under 500 chars"
  // rule as universal and refuses to produce an HTML/audit/report
  // artifact the user explicitly asked for.
  const d = renderChannelDirective('discord');
  assert.match(d, /deliverables/i);
  assert.match(d, /write_file/);
  assert.match(d, /saved to/);
});

test('discord: explicitly forbids the "cannot create files" hallucination', () => {
  const d = renderChannelDirective('discord');
  assert.match(d, /NEVER decline/);
  assert.match(d, /write_file is always available/);
});

test('discord: warns against markdown headers', () => {
  const d = renderChannelDirective('discord');
  assert.match(d, /Avoid markdown headers/);
});

test('discord: tells the model to chunk long conversational responses', () => {
  const d = renderChannelDirective('discord');
  assert.match(d, /split into 2–3 short turns/);
});

test('discord-prefixed channels also match (e.g. discord:dm:123)', () => {
  const d = renderChannelDirective('discord:dm:1234567890');
  assert.match(d, /Discord/);
});

test('cli: allows markdown and matches user tone', () => {
  const c = renderChannelDirective('cli');
  assert.match(c, /CLI/);
  assert.match(c, /Markdown renders cleanly/);
});

test('chat: matches CLI guidance', () => {
  const c = renderChannelDirective('chat');
  assert.match(c, /Markdown renders cleanly/);
});

test('webhook: clean structured replies', () => {
  const w = renderChannelDirective('webhook');
  assert.match(w, /clean structured replies/);
});

test('api: matches webhook guidance', () => {
  const w = renderChannelDirective('api');
  assert.match(w, /clean structured replies/);
});

test('agent (autonomy): emits nothing — autonomy-v2 owns shape', () => {
  assert.equal(renderChannelDirective('agent'), '');
});

test('unknown / undefined channel: emits nothing', () => {
  assert.equal(renderChannelDirective(undefined), '');
  assert.equal(renderChannelDirective(''), '');
  assert.equal(renderChannelDirective('mystery'), '');
});

test('case-insensitive match', () => {
  assert.match(renderChannelDirective('DISCORD'), /Discord/);
  assert.match(renderChannelDirective('Discord'), /Discord/);
});

// ── P3 unified scope gate ──────────────────────────────────────────

test('hasScopedLanguage detects possessive/relative markers, ignores plain reads', () => {
  assert.ok(hasScopedLanguage('show my priority-account accounts'));
  assert.ok(hasScopedLanguage('pull the usual sheet'));
  assert.ok(hasScopedLanguage('do it like last time'));
  assert.ok(!hasScopedLanguage('list all accounts in the org'));
  assert.ok(!hasScopedLanguage('what is the weather today'));
});

test('P3 flag off: scoped lookup gets NO directive (today behavior preserved)', () => {
  delete process.env.UNIFIED_SCOPE_GATE;
  const out = renderActionDisciplineDirective('lookup', 'show my priority-account accounts');
  assert.ok(!out.includes('RESOLVE SCOPE'), 'lookup stays bare under flag-off');
});

test('P3 flag on: scoped lookup GETS the scope directive', () => {
  process.env.UNIFIED_SCOPE_GATE = 'on';
  const out = renderActionDisciplineDirective('lookup', 'show my priority-account accounts');
  assert.ok(out.includes('RESOLVE SCOPE'), 'scoped lookup now resolves scope before querying');
  delete process.env.UNIFIED_SCOPE_GATE;
});

test('P3 flag on: non-scoped lookup stays token-free (no waste on plain reads)', () => {
  process.env.UNIFIED_SCOPE_GATE = 'on';
  const out = renderActionDisciplineDirective('lookup', 'list all accounts in the org');
  assert.ok(!out.includes('RESOLVE SCOPE'), 'plain read gets no directive');
  delete process.env.UNIFIED_SCOPE_GATE;
});

test('P3: action intent always gets the directive regardless of flag/message', () => {
  delete process.env.UNIFIED_SCOPE_GATE;
  const out = renderActionDisciplineDirective('action', 'whatever');
  assert.ok(out.includes('RESOLVE SCOPE'));
});
