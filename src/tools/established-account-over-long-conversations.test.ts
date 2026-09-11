/**
 * Run:
 *   node scripts/run-tests-isolated.mjs \
 *     src/tools/established-account-over-long-conversations.test.ts
 *
 * A write can sit at the end of a long conversation, not just the second turn.
 * These pin what "established" means when there is a lot of history to read.
 *
 * The rule is: unique across the whole session, or ask. Never most-recent,
 * never a guess. A long conversation must fail CLOSED — an extra ask costs a
 * beat, a wrong bind writes to the wrong account.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-established-account-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-established-account\n', 'utf8');

const eventlog = await import('../runtime/harness/eventlog.js');
const { sessionEstablishedConnectedAccountEmail } = await import('./tool-search-provider-sources.js');

const WORK = 'owner@work-example.co';
const PERSONAL = 'owner@personal-example.ai';
const EMAILS = new Set([WORK, PERSONAL]);
const LABELS = { [WORK]: 'workco', [PERSONAL]: 'personalco' };

let sessionCounter = 0;

/** Build a session as an alternating transcript, then ask what is established
 *  for a write arriving after all of it. */
function established(exchanges: Array<{ user: string; reply: string }>): string | undefined {
  const session = eventlog.createSession({ id: `established-${sessionCounter += 1}`, kind: 'chat' });
  for (const [index, exchange] of exchanges.entries()) {
    eventlog.appendEvent({
      sessionId: session.id,
      turn: index + 1,
      role: 'user',
      type: 'user_input_received',
      data: { text: exchange.user, displayText: exchange.user },
    });
    eventlog.appendEvent({
      sessionId: session.id,
      turn: index + 1,
      role: 'Clem',
      type: 'conversation_completed',
      data: { reply: exchange.reply, presentation: { text: exchange.reply } },
    });
  }
  const write = eventlog.appendEvent({
    sessionId: session.id,
    turn: exchanges.length + 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'book an hour at 2pm', displayText: 'book an hour at 2pm' },
  });
  return sessionEstablishedConnectedAccountEmail({
    sessionId: session.id,
    sourceUserSeq: write.seq,
    connectedEmails: EMAILS,
    connectedLabels: LABELS,
  });
}

const CHATTER = Array.from({ length: 20 }, (_, i) => ({
  user: `and what about item ${i}?`,
  reply: `Here is item ${i}. Nothing else to report.`,
}));

test('an account established early survives a long conversation', () => {
  assert.equal(
    established([
      { user: "what's on my calendar tomorrow", reply: 'Tomorrow is clear on your Workco calendar.' },
      ...CHATTER,
    ]),
    WORK,
    'twenty unrelated exchanges do not erase which calendar she actually read',
  );
});

test('two accounts named across a long conversation resolve nothing', () => {
  assert.equal(
    established([
      { user: "what's on my calendar", reply: 'Your Workco calendar is clear.' },
      ...CHATTER,
      { user: 'and the other one?', reply: 'Your personalco calendar has two events.' },
    ]),
    undefined,
    'when both have been used, which one to write to is a question — ask it',
  );
});

test('a label in the user\u2019s prose never establishes an account', () => {
  // The long-conversation hazard: a label is an ordinary word. Over enough
  // turns someone says "the Workco deal" without choosing a mailbox, and
  // that must not silently become the account a write lands in.
  assert.equal(
    established([
      { user: 'how did the Workco deal close?', reply: 'It closed at 180k last week.' },
      { user: 'and the Workco renewal?', reply: 'Renewal is up in March.' },
      ...CHATTER,
    ]),
    undefined,
    'talking ABOUT something is not choosing an account to write from',
  );
});

test('only Clem\u2019s own reply carries a label, because she wrote it after doing the work', () => {
  assert.equal(
    established([
      { user: 'anything tomorrow?', reply: 'Nothing tomorrow on your Workco calendar.' },
    ]),
    WORK,
  );
});

test('an exact address in the user\u2019s prose still establishes, as it always did', () => {
  // The address matcher wants the address stated AS the account, not merely
  // mentioned — unchanged by the label work, which touches replies only.
  assert.equal(
    established([
      { user: `${PERSONAL} is my sending account`, reply: 'Got it.' },
      ...CHATTER,
    ]),
    PERSONAL,
  );
});

test('a bare address mention does not establish — narrow, but it fails closed', () => {
  // Pre-existing and deliberately conservative: "use X for this please" does
  // not match the accepted phrasings, so Clem asks instead of binding. Pinned
  // because it is a real limit on how much conversation she carries forward,
  // and because the safe direction of the failure is what makes it tolerable.
  assert.equal(
    established([
      { user: `use ${PERSONAL} for this please`, reply: 'Got it.' },
      ...CHATTER,
    ]),
    undefined,
  );
});

test('a conversation that never named an account establishes nothing', () => {
  assert.equal(established(CHATTER), undefined);
});
