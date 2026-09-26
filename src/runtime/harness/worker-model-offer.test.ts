/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/worker-model-offer.test.ts
 *
 * "Use <model> for <kind of work> from now on?" is asked once per
 * conversation, saves only when the owner taps Save, and a replay shows the
 * owner's answer instead of an open offer.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-worker-model-offer-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-worker-model-offer\n', 'utf8');

const eventlog = await import('./eventlog.js');
const offers = await import('./worker-model-offer.js');
const presentation = await import('./public-presentation.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

afterEach(() => offers._setWorkerModelOfferSaveForTests(null));

let serial = 0;
function session(): string {
  return eventlog.createSession({ id: `worker-model-offer-${++serial}`, kind: 'chat' }).id;
}

const OFFER = { intent: 'outbound email writing', modelId: 'flagship-writer', modelName: 'Flagship Writer' };

test('an offer is recorded once per conversation for the same kind of work and model', () => {
  const sessionId = session();
  const first = offers.recordWorkerModelOffer({ sessionId, sourceUserSeq: 7, offer: OFFER });
  const again = offers.recordWorkerModelOffer({ sessionId, sourceUserSeq: 9, offer: { ...OFFER, intent: 'Outbound Email Writing' } });
  assert.ok(first?.startsWith('wmo-'));
  assert.equal(again, first);
  assert.equal(eventlog.listEvents(sessionId, { types: ['worker_model_offer'] }).length, 1);
});

test('Save writes the rule through the settings owner and closes the offer; a second answer changes nothing', async () => {
  const sessionId = session();
  const offerId = offers.recordWorkerModelOffer({ sessionId, offer: OFFER })!;
  const saved: Array<{ intent: string; modelId: string }> = [];
  offers._setWorkerModelOfferSaveForTests(async (rule) => { saved.push(rule); });
  const result = await offers.resolveWorkerModelOffer({ sessionId, offerId, action: 'save' });
  assert.deepEqual(result, { ok: true, action: 'save', alreadyResolved: false });
  assert.deepEqual(saved, [{ intent: 'outbound email writing', modelId: 'flagship-writer' }]);
  const repeat = await offers.resolveWorkerModelOffer({ sessionId, offerId, action: 'dismiss' });
  assert.deepEqual(repeat, { ok: true, action: 'save', alreadyResolved: true });
  assert.equal(saved.length, 1);
});

test('Just this once saves nothing', async () => {
  const sessionId = session();
  const offerId = offers.recordWorkerModelOffer({ sessionId, offer: OFFER })!;
  let writes = 0;
  offers._setWorkerModelOfferSaveForTests(async () => { writes += 1; });
  const result = await offers.resolveWorkerModelOffer({ sessionId, offerId, action: 'dismiss' });
  assert.equal(result.ok && result.action, 'dismiss');
  assert.equal(writes, 0);
});

test('a failed save leaves the offer open', async () => {
  const sessionId = session();
  const offerId = offers.recordWorkerModelOffer({ sessionId, offer: OFFER })!;
  offers._setWorkerModelOfferSaveForTests(async () => { throw new Error('flagship-writer is not connected'); });
  const result = await offers.resolveWorkerModelOffer({ sessionId, offerId, action: 'save' });
  assert.equal(result.ok, false);
  assert.equal(offers.workerModelOfferResolution(sessionId, offerId), null);
});

test('an offer id from another conversation is not found', async () => {
  const offerId = offers.recordWorkerModelOffer({ sessionId: session(), offer: OFFER })!;
  const result = await offers.resolveWorkerModelOffer({ sessionId: session(), offerId, action: 'save' });
  assert.equal(result.ok, false);
});

test('the public projection carries the offer and, once answered, the answer', async () => {
  const sessionId = session();
  const offerId = offers.recordWorkerModelOffer({ sessionId, offer: OFFER })!;
  const project = () => {
    const row = eventlog.listEvents(sessionId, { types: ['worker_model_offer'] })[0]!;
    return presentation.projectHarnessEventForPublic(row)?.data as Record<string, unknown> | undefined;
  };
  assert.deepEqual(project(), { offerId, intent: OFFER.intent, modelId: OFFER.modelId, modelName: OFFER.modelName });
  offers._setWorkerModelOfferSaveForTests(async () => {});
  await offers.resolveWorkerModelOffer({ sessionId, offerId, action: 'save' });
  assert.equal(project()?.resolved, 'save');
  const resolvedRow = eventlog.listEvents(sessionId, { types: ['worker_model_offer_resolved'] })[0]!;
  assert.deepEqual(presentation.projectHarnessEventForPublic(resolvedRow)?.data, { offerId, action: 'save' });
});
