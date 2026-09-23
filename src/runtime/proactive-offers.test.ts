import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-offer-routing-'));
process.env.CLEMENTINE_HOME = home;
mkdirSync(path.join(home, 'state'), { recursive: true });
const offers = await import('./proactive-offers.js');
const log = await import('./harness/eventlog.js');
const input = (id: string) => ({ id, userId: 'owner', kind: 'space' as const,
  title: 'Bring the research together', summary: 'A Space for the existing research.',
  whyNow: 'Related work spans several conversations.', evidenceRefs: ['fact:12', 'receipt:9'] });

test('publication creates no chat; engagement creates one thread with no synthetic user input', () => {
  const offer = offers.publishProactiveOffer(input('new-space'));
  assert.equal(offer.conversationId, null);
  assert.equal(log.listSessions().length, 0);
  const first = offers.discussProactiveOffer(offer.id, offer.revision, 'owner');
  const repeat = offers.discussProactiveOffer(offer.id, offer.revision, 'owner');
  assert.equal(first.sessionId, repeat.sessionId);
  assert.equal(log.listSessions().length, 1);
  assert.equal(log.listEvents(first.sessionId).length, 0);
  assert.deepEqual(first.offer.evidenceRefs, input('new-space').evidenceRefs);
  log.closeEventLog();
  assert.equal(offers.discussProactiveOffer(offer.id, 1, 'owner').sessionId, first.sessionId);
});

test('related work reuses its owned conversation without changing that conversation metadata', () => {
  const session = log.createSession({ id: 'existing-chat', kind: 'chat', userId: 'owner', metadata: { goal: 'keep' } });
  offers.publishProactiveOffer({ ...input('related'), originSessionId: session.id });
  assert.equal(offers.discussProactiveOffer('related', 1, 'owner').sessionId, session.id);
  assert.deepEqual(log.getSession(session.id)!.metadata, { goal: 'keep' });
});

test('dismissal persists and identical evidence does not revive it', () => {
  offers.publishProactiveOffer(input('declined'));
  offers.dismissProactiveOffer('declined', 1, 'owner');
  log.closeEventLog();
  assert.equal(offers.publishProactiveOffer(input('declined')).status, 'dismissed');
  assert.equal(offers.listProactiveOffers('owner').some(o => o.id === 'declined'), false);
  assert.throws(() => offers.discussProactiveOffer('declined', 1, 'owner'), /dismissed/);
});

test('wrong audience, stale revisions, conflicting publications and missing origins cannot create chats', () => {
  offers.publishProactiveOffer(input('protected'));
  const count = log.listSessions().length;
  assert.equal(offers.getProactiveOffer('protected', 'other'), null);
  assert.throws(() => offers.discussProactiveOffer('protected', 1, 'other'), /not found/);
  assert.throws(() => offers.discussProactiveOffer('protected', 2, 'owner'), /revision/);
  assert.throws(() => offers.publishProactiveOffer({ ...input('protected'), summary: 'Different proposal' }), /different content/);
  offers.publishProactiveOffer({ ...input('missing-origin'), originSessionId: 'missing' });
  assert.throws(() => offers.discussProactiveOffer('missing-origin', 1, 'owner'), /origin unavailable/);
  const foreign = log.createSession({ kind: 'chat', userId: 'other' });
  offers.publishProactiveOffer({ ...input('foreign-origin'), originSessionId: foreign.id });
  assert.throws(() => offers.discussProactiveOffer('foreign-origin', 1, 'owner'), /owned chat/);
  assert.equal(log.listSessions().length, count + 1);
});

test('two processes engaging the same offer resolve one durable thread', async () => {
  offers.publishProactiveOffer(input('concurrent'));
  log.closeEventLog();
  const moduleUrl = new URL('./proactive-offers.ts', import.meta.url).href;
  const script = `const { discussProactiveOffer } = await import(${JSON.stringify(moduleUrl)});
    process.stdout.write('READY\\n');
    process.stdin.once('data', () => {
      try { process.stdout.write('RESULT:' + discussProactiveOffer('concurrent', 1, 'owner').sessionId + '\\n'); }
      catch (e) { process.stderr.write(String(e)); process.exitCode = 1; }
      process.stdin.destroy();
    });`;
  const children = [0, 1].map(() => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: { ...process.env, CLEMENTINE_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  }));
  const output = ['', ''];
  const errors = ['', ''];
  const done = children.map((child, i) => new Promise<number | null>((resolve, reject) => {
    child.on('error', reject); child.on('exit', resolve);
    child.stderr.on('data', data => { errors[i] += data; });
  }));
  const ready = children.map((child, i) => new Promise<void>(resolve => {
    child.stdout.on('data', data => { output[i] += data; if (output[i].includes('READY\n')) resolve(); });
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await Promise.all(ready);
        children.forEach(child => child.stdin.write('GO\n'));
        assert.deepEqual(await Promise.all(done), [0, 0], errors.join('\n'));
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('offer race timed out')), 20_000); }),
    ]);
    const ids = output.map(text => text.match(/RESULT:(.+)/)?.[1]);
    assert.ok(ids[0]); assert.equal(ids[0], ids[1]);
    assert.equal(offers.getProactiveOffer('concurrent', 'owner')!.conversationId, ids[0]);
  } finally {
    clearTimeout(timer);
    children.forEach(child => { if (child.exitCode === null) child.kill('SIGKILL'); });
    await Promise.allSettled(done);
  }
});

test('not now persists, stays quiet until the requested time, and reuses the discussion', () => {
  offers.publishProactiveOffer(input('later'));
  const first = offers.discussProactiveOffer('later', 1, 'owner');
  const until = new Date(Date.now() + 60_000).toISOString();
  offers.snoozeProactiveOffer('later', 1, 'owner', until);
  log.closeEventLog();
  assert.equal(offers.getProactiveOffer('later', 'owner')!.snoozedUntil, until);
  assert.equal(offers.listProactiveOffers('owner').some(o => o.id === 'later'), false);
  assert.throws(() => offers.discussProactiveOffer('later', 1, 'owner'), /snoozed/);
  const after = new Date(Date.parse(until) + 1);
  assert.equal(offers.listProactiveOffers('owner', after).some(o => o.id === 'later'), true);
  assert.equal(offers.discussProactiveOffer('later', 1, 'owner', after).sessionId, first.sessionId);
});

test('revised evidence invalidates stale cards without losing the original conversation or dismissal', () => {
  offers.publishProactiveOffer(input('amended'));
  const first = offers.discussProactiveOffer('amended', 1, 'owner');
  const changed = { ...input('amended'), summary: 'Updated research context', evidenceRefs: ['fact:13'] };
  assert.equal(offers.reviseProactiveOffer(changed, 1).revision, 2);
  assert.throws(() => offers.discussProactiveOffer('amended', 1, 'owner'), /revision/);
  assert.throws(() => offers.dismissProactiveOffer('amended', 1, 'owner'), /revision/);
  assert.equal(offers.discussProactiveOffer('amended', 2, 'owner').sessionId, first.sessionId);
  offers.dismissProactiveOffer('amended', 2, 'owner');
  assert.equal(offers.reviseProactiveOffer({ ...changed, summary: 'Additional detail' }, 2).status, 'dismissed');
  assert.equal(offers.getProactiveOffer('amended', 'owner')!.revision, 3);
});

test('expired and withdrawn offers cannot be discussed or quietly resurrected', () => {
  offers.publishProactiveOffer({ ...input('expired'), expiresAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(offers.listProactiveOffers('owner').some(o => o.id === 'expired'), false);
  assert.throws(() => offers.discussProactiveOffer('expired', 1, 'owner'), /expired/);
  offers.publishProactiveOffer(input('withdrawn'));
  offers.withdrawProactiveOffer('withdrawn', 1, 'owner', 'Supporting fact was corrected');
  log.closeEventLog();
  assert.equal(offers.publishProactiveOffer(input('withdrawn')).status, 'withdrawn');
  assert.throws(() => offers.discussProactiveOffer('withdrawn', 1, 'owner'), /withdrawn/);
});


test('upgrading the original schema retains its conversation and backs up the original revision', () => {
  const oldHome = mkdtempSync(path.join(os.tmpdir(), 'clem-offer-upgrade-'));
  const eventlogUrl = new URL('./harness/eventlog.ts', import.meta.url).href;
  const moduleUrl = new URL('./proactive-offers.ts', import.meta.url).href;
  const script = `
    const assert = (await import('node:assert/strict')).default;
    const log = await import(${JSON.stringify(eventlogUrl)});
    const db = log.openEventLog();
    log.createSession({ id: 'old-chat', kind: 'chat', userId: 'owner' });
    db.exec('CREATE TABLE proactive_offers (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, conversation_id TEXT, input_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.prepare('INSERT INTO proactive_offers VALUES (?, ?, 1, ?, ?, ?, ?, ?)').run(
      'old-offer', 'owner', 'discussing', 'old-chat', ${JSON.stringify(JSON.stringify(input('old-offer')))}, '2026-09-22', '2026-09-22');
    const offers = await import(${JSON.stringify(moduleUrl)});
    assert.equal(offers.discussProactiveOffer('old-offer', 1, 'owner').sessionId, 'old-chat');
    assert.equal(db.prepare('SELECT count(*) AS n FROM proactive_offer_revisions').get().n, 1);
    assert.equal(offers.getProactiveOffer('old-offer', 'owner').snoozedUntil, null);
    log.closeEventLog();
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    env: { ...process.env, CLEMENTINE_HOME: oldHome }, encoding: 'utf8', timeout: 20_000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
});

test('invalid snoozes and attempted scope changes leave the offer untouched', () => {
  offers.publishProactiveOffer({ ...input('bounded'), expiresAt: '2030-01-02T00:00:00.000Z' });
  const now = new Date('2030-01-01T00:00:00.000Z');
  assert.throws(() => offers.snoozeProactiveOffer('bounded', 1, 'owner', 'not a date', now));
  assert.throws(() => offers.snoozeProactiveOffer('bounded', 1, 'owner', now.toISOString(), now), /future/);
  assert.throws(() => offers.snoozeProactiveOffer('bounded', 1, 'owner', '2030-01-03T00:00:00.000Z', now), /expires/);
  assert.throws(() => offers.reviseProactiveOffer({ ...input('bounded'), kind: 'skill' }, 1), /scope/);
  assert.equal(offers.getProactiveOffer('bounded', 'owner')!.status, 'offered');
  assert.equal(offers.getProactiveOffer('bounded', 'owner')!.revision, 1);
});

test('offer context is available to its first accepted reply only, never another chat or later turn', () => {
  offers.publishProactiveOffer(input('reply-context'));
  const { sessionId } = offers.discussProactiveOffer('reply-context', 1, 'owner');
  assert.equal(offers.proactiveOfferContextForTurn(sessionId, 999), '');
  const synthetic = log.appendEvent({ sessionId, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'Internal continuation', synthetic: true } });
  assert.equal(offers.proactiveOfferContextForTurn(sessionId, synthetic.seq), '');
  const first = log.appendEvent({ sessionId, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'Yes, focus on California' } });
  assert.equal(JSON.parse(offers.proactiveOfferContextForTurn(sessionId, first.seq)).offerId, 'reply-context');
  offers.discussProactiveOffer('reply-context', 1, 'owner');
  const second = log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Another question' } });
  assert.equal(offers.proactiveOfferContextForTurn(sessionId, second.seq), '');
  assert.equal(offers.proactiveOfferContextForTurn('existing-chat', first.seq), '');
  offers.withdrawProactiveOffer('reply-context', 1, 'owner', 'Evidence corrected');
  assert.equal(offers.proactiveOfferContextForTurn(sessionId, first.seq), '');
});

test('a changed offer waits for renewed engagement before contributing context', () => {
  offers.publishProactiveOffer(input('fresh-context'));
  const { sessionId } = offers.discussProactiveOffer('fresh-context', 1, 'owner');
  offers.reviseProactiveOffer({ ...input('fresh-context'), summary: 'Corrected context' }, 1);
  const first = log.appendEvent({ sessionId, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'Tell me more' } });
  assert.equal(offers.proactiveOfferContextForTurn(sessionId, first.seq), '');
  offers.discussProactiveOffer('fresh-context', 2, 'owner');
  const next = log.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Use the revised context' } });
  assert.equal(JSON.parse(offers.proactiveOfferContextForTurn(sessionId, next.seq)).summary, 'Corrected context');
});

test('explicit reply selects one of two offers and survives restart without rebinding', () => {
  const sessionId = log.createSession({ kind: 'chat', userId: 'owner' }).id;
  for (const id of ['choice-a', 'choice-b']) {
    offers.publishProactiveOffer({ ...input(id), originSessionId: sessionId });
    offers.discussProactiveOffer(id, 1, 'owner');
  }
  const source = log.appendEvent({ sessionId, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'Yes' } });
  assert.equal(offers.proactiveOfferContextForTurn(sessionId, source.seq), '');
  const binding = { sessionId, sourceUserSeq: source.seq, userId: 'owner', offerId: 'choice-b', revision: 1 };
  offers.bindProactiveOfferReply(binding);
  log.closeEventLog();
  offers.bindProactiveOfferReply(binding);
  assert.equal(JSON.parse(offers.proactiveOfferContextForTurn(sessionId, source.seq)).offerId, 'choice-b');
  assert.throws(() => offers.bindProactiveOfferReply({ ...binding, offerId: 'choice-a' }), /binding conflict/);
  offers.withdrawProactiveOffer('choice-b', 1, 'owner', 'Already resolved');
  offers.bindProactiveOfferReply(binding);
  assert.equal(offers.proactiveOfferContextForTurn(sessionId, source.seq), '', 'withdrawal must not fall back to the other offer');
  assert.equal(log.listEvents(sessionId).length, 1, 'binding must not manufacture user input');
});

test('explicit reply rejects foreign, synthetic, stale and pre-engagement sources', () => {
  const sessionId = log.createSession({ kind: 'chat', userId: 'owner' }).id;
  const append = (synthetic = false) => log.appendEvent({ sessionId, turn: 0, role: 'user', type: 'user_input_received', data: { text: 'Yes', synthetic } });
  const before = append();
  offers.publishProactiveOffer({ ...input('binding-guards'), originSessionId: sessionId });
  offers.discussProactiveOffer('binding-guards', 1, 'owner');
  const source = append();
  const binding = { sessionId, sourceUserSeq: source.seq, userId: 'owner', offerId: 'binding-guards', revision: 1 };
  assert.throws(() => offers.bindProactiveOfferReply({ ...binding, userId: 'other' }), /owned chat/);
  assert.throws(() => offers.bindProactiveOfferReply({ ...binding, sourceUserSeq: append(true).seq }), /accepted user source/);
  assert.throws(() => offers.bindProactiveOfferReply({ ...binding, sourceUserSeq: before.seq }), /predates/);
  assert.throws(() => offers.bindProactiveOfferReply({ ...binding, revision: 2 }), /revision/);
  offers.reviseProactiveOffer({ ...input('binding-guards'), originSessionId: sessionId, summary: 'Corrected' }, 1);
  assert.throws(() => offers.bindProactiveOfferReply({ ...binding, revision: 2 }), /predates/);
  offers.discussProactiveOffer('binding-guards', 2, 'owner');
  const current = { ...binding, revision: 2, sourceUserSeq: append().seq };
  offers.bindProactiveOfferReply(current);
  assert.equal(JSON.parse(offers.proactiveOfferContextForTurn(sessionId, current.sourceUserSeq)).summary, 'Corrected');
});
