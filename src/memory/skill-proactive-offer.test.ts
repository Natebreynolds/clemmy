import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-learned-offer-'));
process.env.CLEMENTINE_HOME = home;
mkdirSync(path.join(home, 'state'), { recursive: true });
const { createSession, listSessions } = await import('../runtime/harness/eventlog.js');
const { writeDistilledSkill } = await import('./skill-store.js');
const { evaluateLearningCandidate, issueManualSkillDraftRequestReceipt } = await import('./learning-receipt.js');
const { publishLearnedSkillOffer } = await import('./skill-proactive-offer.js');
const { dismissProactiveOffer } = await import('../runtime/proactive-offers.js');

test('a verified learned skill offers discussion in its owned origin without another model or session', () => {
  const session = createSession({ kind: 'chat', userId: 'owner' });
  const learningReceipt = evaluateLearningCandidate({ target: 'skill', authority: 'goal_validation', sessionId: session.id, sourceId: 'goal-fixture', terminalSuccess: true, independentValidation: true }).receipt!;
  writeDistilledSkill({ name: 'fixture-review', description: 'Prepare a research brief', body: 'Review sources and write the brief', origin: { kind: 'chat', sourceId: 'goal-fixture' }, learningReceipt });
  const offer = publishLearnedSkillOffer('fixture-review')!;
  assert.equal(offer.kind, 'skill');
  assert.equal(offer.originSessionId, session.id);
  assert.equal(offer.conversationId, null);
  assert.equal(listSessions().length, 1);
  assert.ok(offer.evidenceRefs.includes('skill:fixture-review'));
  dismissProactiveOffer(offer.id, offer.revision, 'owner');
  assert.equal(publishLearnedSkillOffer('fixture-review')!.status, 'dismissed');
});

test('unverified drafts and missing skills do not generate inferred offers', () => {
  writeDistilledSkill({ name: 'legacy-fixture', description: 'Unverified procedure', body: 'Do work', origin: { kind: 'chat' } });
  assert.equal(publishLearnedSkillOffer('legacy-fixture'), null);
  assert.equal(publishLearnedSkillOffer('missing-fixture'), null);
});

test('a requested manual draft offers review without claiming successful or verified execution', () => {
  const session = createSession({ kind: 'chat', userId: 'manual-owner' });
  const learningReceipt = issueManualSkillDraftRequestReceipt({ sessionId: session.id,
    sourceId: 'exact-manual-consent-event', explicitUserRequest: true })!;
  writeDistilledSkill({ name: 'requested-review', description: 'Preserve a controlled procedure', body: 'Review this draft.',
    origin: { kind: 'manual', sourceId: learningReceipt.sourceId }, learningReceipt });
  const offer = publishLearnedSkillOffer('requested-review')!;
  assert.ok(offer);
  assert.match(offer.summary, /draft procedure you requested/);
  assert.match(offer.whyNow, /unreviewed/);
  assert.doesNotMatch(`${offer.summary} ${offer.whyNow}`, /successful work|completed work|verified learning receipt/);
  assert.ok(offer.evidenceRefs.includes('learning-source:exact-manual-consent-event'));
});
