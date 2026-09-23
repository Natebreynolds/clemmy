import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
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
