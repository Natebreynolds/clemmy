/**
 * Run: npx tsx --test src/memory/skill-choice-store.test.ts
 *
 * Proven-standard memory (2026-07-31): skill selection was re-derived by
 * lexical retrieval on EVERY turn, so an unlucky phrasing silently lost the
 * user's own standard and every run paid a discovery round trip.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-skill-choice-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const {
  getSkillChoice,
  invalidateSkillChoice,
  matchSkillChoices,
  reapDeadSkillChoices,
  rememberSkillChoice,
  renderProvenSkillForPrompt,
  skillIntentSlugError,
  DEAD_SKILL_MEMO_AGE_MS,
} = await import('./skill-choice-store.js');
const { SKILLS_DIR } = await import('./skill-store.js');
const { captureProvenSkill, deriveSkillClassKey } = await import('./skill-choice-capture.js');

function installSkill(name: string, description: string): void {
  const dir = path.join(SKILLS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${description}`, '---', '', '# Body', ''].join('\n'),
    'utf-8',
  );
}

test('a proven pairing accrues evidence and binds on a later request', () => {
  rememberSkillChoice({ intent: 'outbound-email', skill: 'brand-outbound' });
  rememberSkillChoice({ intent: 'outbound-email', skill: 'brand-outbound' });
  const record = getSkillChoice('outbound-email');
  assert.equal(record?.skill, 'brand-outbound');
  assert.equal(record?.successCount, 2, 'evidence accrues rather than overwriting');

  const [match] = matchSkillChoices('draft the outbound emails for these accounts');
  assert.equal(match?.record.skill, 'brand-outbound', 'plural phrasing still binds the class');

  const rendered = renderProvenSkillForPrompt('draft the outbound emails for these accounts');
  assert.match(rendered, /brand-outbound/);
  assert.match(rendered, /worked 2 previous runs/);
  assert.match(rendered, /say which standard you are using/, 'the standard is named to the user, not silently applied');
  assert.match(rendered, /If it does not fit/, 'the memo informs, it never overrides');
});

test('a multi-word class never binds on a single shared word', () => {
  assert.deepEqual(
    matchSkillChoices('what is my email address'),
    [],
    '"email" alone must not impose the outbound standard',
  );
  assert.equal(renderProvenSkillForPrompt('what is my email address'), '');
});

test('switching the skill for a known class resets the ledger', () => {
  rememberSkillChoice({ intent: 'weekly-report', skill: 'old-report' });
  rememberSkillChoice({ intent: 'weekly-report', skill: 'old-report' });
  rememberSkillChoice({ intent: 'weekly-report', skill: 'new-report' });
  const record = getSkillChoice('weekly-report');
  assert.equal(record?.skill, 'new-report');
  assert.equal(record?.successCount, 1, 'a different standard must prove itself on its own record');
});

test('invalidation retires the binding but keeps the history inspectable', () => {
  rememberSkillChoice({ intent: 'deck-build', skill: 'deck-skill' });
  assert.equal(invalidateSkillChoice('deck-build', 'user said it was wrong'), true);
  const record = getSkillChoice('deck-build');
  assert.equal(record?.skill, null, 'the binding is retired');
  assert.equal(record?.invalidatedReason, 'user said it was wrong', 'the reason survives');
  assert.equal(record?.successCount, 1, 'history is never deleted');
  assert.deepEqual(matchSkillChoices('build the deck'), [], 'a retired standard cannot bind');
  assert.equal(invalidateSkillChoice('deck-build', 'again'), false, 'retiring twice is a no-op');
});

test('sentence slugs are refused at write — they never match twice and become clutter', () => {
  const longIntent = 'please-can-you-get-a-mid-year-audit-email-ready-for-all-two-hundred-and-sixty-six-of-my-accounts';
  assert.ok(skillIntentSlugError(longIntent), 'a sentence is not a task class');
  assert.throws(() => rememberSkillChoice({ intent: longIntent, skill: 'x' }), /task class/);
  assert.ok(skillIntentSlugError('outbound-email') === null, 'a real class slug is accepted');
});

test('never-proven memos age out through the canonical retire path', () => {
  rememberSkillChoice({ intent: 'stale-class', skill: 'ghost-skill' });
  // Force the ledger to "written but never proven".
  const record = getSkillChoice('stale-class')!;
  writeFileSync(
    record.filePath,
    JSON.stringify({ ...record, successCount: 0, createdAt: new Date(Date.now() - DEAD_SKILL_MEMO_AGE_MS - 1000).toISOString() }),
    'utf-8',
  );
  assert.equal(reapDeadSkillChoices(), 1);
  assert.equal(getSkillChoice('stale-class')?.skill, null);
  assert.match(String(getSkillChoice('stale-class')?.invalidatedReason), /never proven/);
});

test('the class key is derived from shared vocabulary, and capture stays conservative', () => {
  installSkill('brand-outbound', 'Brand-enforced outbound email. Shapes a template or draft into an on-brand prospect email.');
  const request = 'these 266 we need to get a mid year audit email ready for them in my drafts, lets get 50 ready please';

  const key = deriveSkillClassKey(request, 'brand-outbound');
  assert.ok(key, 'a class key is derived from the request/skill overlap');
  assert.ok(!key!.includes(' '), 'the key is a slug');
  assert.ok(key!.length <= 80 && key!.split('-').length <= 3, `the key stays a class, got "${key}"`);
  assert.equal(deriveSkillClassKey(request, 'not-installed'), null, 'a skill that was never a candidate yields no class');

  // Conservative capture: needs exactly one loaded skill AND a working run.
  assert.equal(captureProvenSkill({ request, loadedSkillNames: ['brand-outbound'], workingRun: false }), null);
  assert.equal(captureProvenSkill({ request, loadedSkillNames: ['brand-outbound', 'other'], workingRun: true }), null,
    'two loaded skills give no evidence about which governed');

  const captured = captureProvenSkill({ request, loadedSkillNames: ['brand-outbound'], workingRun: true });
  assert.equal(captured, key);
  assert.equal(getSkillChoice(key!)?.skill, 'brand-outbound', 'a working run becomes a proven standard');
});

test('cleanup', () => { rmSync(TMP_HOME, { recursive: true, force: true }); });
