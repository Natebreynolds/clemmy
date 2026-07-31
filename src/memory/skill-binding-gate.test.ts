/**
 * Run: npx tsx --test src/memory/skill-binding-gate.test.ts
 *
 * Binding load (2026-07-31): fifty follow-up emails went out without the
 * standard that governs them, because retrieval only ever SUGGESTED it. At
 * bulk scale a soft default has to actually hold.
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-skill-binding-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

const { skillBindingHold } = await import('./skill-binding-gate.js');
const { rememberSkillChoice, invalidateSkillChoice } = await import('./skill-choice-store.js');
const { createSession, resetEventLog } = await import('../runtime/harness/eventlog.js');

test('a proven standard holds bulk irreversible work until it is loaded', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  rememberSkillChoice({ intent: 'outbound-email', skill: 'brand-outbound' });

  const hold = skillBindingHold({
    sessionId: sess.id,
    objective: 'send outbound follow-up emails to fifty unreplied contacts',
    bulkIrreversible: true,
    itemCount: 50,
  });
  assert.ok(hold, 'the proven standard holds the batch');
  assert.equal(hold!.skill, 'brand-outbound');
  assert.match(hold!.message, /skill_read\("brand-outbound"\)/, 'names the EXACT call — escapable from the text alone');
  assert.match(hold!.message, /50 items/, 'names the scale that justifies holding');
  assert.match(hold!.message, /clears once the skill is read/, 'states how to get past it — never a dead end');
  assert.match(hold!.message, /does not apply here/, 'an honest override path exists');
});

test('reads are never held, and non-bulk work is never held', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  rememberSkillChoice({ intent: 'outbound-email', skill: 'brand-outbound' });
  const objective = 'send outbound follow-up emails to fifty unreplied contacts';

  assert.equal(
    skillBindingHold({ sessionId: sess.id, objective, bulkIrreversible: false, itemCount: 50 }),
    null,
    'only bulk irreversible work is held',
  );
});

test('a RETIRED standard is a suggestion, never a hold', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  // Retire the pairing: only a standard that currently holds authority may bind.
  // (Retrieval noise cannot bind either — it never writes a memo at all.)
  invalidateSkillChoice('outbound-email', 'owner said it no longer applies');
  assert.equal(
    skillBindingHold({
      sessionId: sess.id,
      objective: 'send outbound follow-up emails to fifty unreplied contacts',
      bulkIrreversible: true,
      itemCount: 50,
    }),
    null,
    'a retired pairing has no authority to bind',
  );
});

test('an unrelated batch is never held by an unrelated standard', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  rememberSkillChoice({ intent: 'outbound-email', skill: 'brand-outbound' });
  assert.equal(
    skillBindingHold({
      sessionId: sess.id,
      objective: 'refresh the salesforce prospect tracker rows',
      bulkIrreversible: true,
      itemCount: 40,
    }),
    null,
    'a standard governs its class only',
  );
});

test('cleanup', () => { rmSync(TMP_HOME, { recursive: true, force: true }); });
