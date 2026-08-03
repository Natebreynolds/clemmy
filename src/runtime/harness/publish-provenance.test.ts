/**
 * Run: npx tsx --test src/runtime/harness/publish-provenance.test.ts
 *
 * Regression for the 2026-07-08 cross-task clobber: `sites:create --name X …
 * || sites:list --json` — the failed create's LIST fallback (exit 0, same
 * callId) handed blanket provenance to EVERY existing site, and the deploy
 * overwrote another task's live site. Listing-shaped output must confer
 * provenance ONLY on an object matching a requested create name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = mkdtempSync(path.join(os.tmpdir(), 'clemmy-provenance-'));
process.env.CLEMENTINE_HOME = TMP;
mkdirSync(path.join(TMP, 'state'), { recursive: true });

const { resetEventLog, createSession, appendEvent, writeToolOutput } = await import('./eventlog.js');
const { buildPublishProvenance } = await import('./brackets.js');

function seed(sessionId: string, command: string, result: string): void {
  appendEvent({ sessionId, turn: 1, role: 'Clem', type: 'tool_called', data: { tool: 'run_shell_command', callId: 'c1', arguments: JSON.stringify({ command }) } });
  appendEvent({ sessionId, turn: 1, role: 'tool', type: 'tool_returned', data: { tool: 'run_shell_command', callId: 'c1', result } });
}

const LISTING = `exit_code: 0\n\nstdout:\n[\n  {\n    "id": "00000000-0000-4000-8000-000000000005",\n    "site_id": "00000000-0000-4000-8000-000000000005",\n    "name": "fixture-coffee-site",\n    "url": "https://fixture-coffee-site.netlify.app"\n  }\n]`;

test('a failed create whose || list fallback exits 0 confers NO provenance on unrelated listed sites', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  seed(sess.id, 'netlify sites:create --name dust-devil-coffee-co --json || netlify sites:list --json', LISTING);
  const has = buildPublishProvenance(sess.id);
  assert.equal(has('00000000-0000-4000-8000-000000000005'), false, 'another task\'s site id must NOT gain provenance from a listing');
  assert.equal(has('fixture-coffee-site'), false, 'another task\'s site name must NOT gain provenance from a listing');
});

test('a listing that CONTAINS the requested create name provenances only that object', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  const listing = LISTING.replace(/fixture-coffee-site/g, 'dust-devil-coffee-co').replace(/00000000-0000-4000-8000-000000000005/g, 'aaaa1111');
  seed(sess.id, 'netlify sites:create --name dust-devil-coffee-co --json || netlify sites:list --json', listing);
  const has = buildPublishProvenance(sess.id);
  assert.equal(has('dust-devil-coffee-co'), true, 'the requested name matched in the listing IS provenanced');
  assert.equal(has('aaaa1111'), true, 'ids inside the matching object ride along');
});

test('a genuine single-site create result still confers provenance (unchanged path)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  seed(sess.id, 'netlify sites:create --name fresh-site --json', 'exit_code: 0\n\nstdout:\n{\n  "site_id": "bbbb2222",\n  "name": "fresh-site",\n  "url": "https://fresh-site.netlify.app"\n}');
  const has = buildPublishProvenance(sess.id);
  assert.equal(has('fresh-site'), true);
  assert.equal(has('bbbb2222'), true);
});

const TWO_SITE_LISTING = `exit_code: 0

stdout:
[
  {
    "id": "11111111-1111-4111-8111-111111111111",
    "site_id": "11111111-1111-4111-8111-111111111111",
    "name": "explicit-smoke-site",
    "url": "http://explicit-smoke-site.netlify.app"
  },
  {
    "id": "22222222-2222-4222-8222-222222222222",
    "site_id": "22222222-2222-4222-8222-222222222222",
    "name": "unrelated-live-site",
    "url": "http://unrelated-live-site.netlify.app"
  }
]`;

function seedReadOnlyListing(sessionId: string, clippedEvent = false): void {
  const secondObject = TWO_SITE_LISTING.indexOf('  {\n    "id": "22222222');
  const capturedPrefix = `${TWO_SITE_LISTING.slice(0, secondObject)}  {"id":"partial"\n...[capture stopped after 200000 chars]`;
  const called = appendEvent({
    sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_called',
    data: {
      tool: 'run_shell_command',
      callId: 'list-1',
      effect: 'compute',
      arguments: JSON.stringify({ command: 'netlify sites:list --json' }),
    },
  });
  if (clippedEvent) {
    writeToolOutput({
      sessionId,
      callId: 'list-1',
      invocationNonce: 'nonce-list-1',
      tool: 'run_shell_command',
      output: capturedPrefix,
    });
  }
  appendEvent({
    sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: called.id,
    data: {
      tool: 'run_shell_command',
      callId: 'list-1',
      effect: 'compute',
      result: clippedEvent
        ? 'exit_code: 0\n\nstdout:\n[{"id":"partial"\n[clipped: use recall_tool_result("list-1") for full output]'
        : TWO_SITE_LISTING,
    },
  });
}

test('an exact user-named site URL can resolve to its canonical UUID without provenancing neighboring sites', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Deploy this to https://explicit-smoke-site.netlify.app and no other site.' },
  });
  seedReadOnlyListing(sess.id, true);
  const has = buildPublishProvenance(sess.id);
  assert.equal(has('11111111-1111-4111-8111-111111111111'), true, 'fresh exact URL → matching canonical id');
  assert.equal(has('22222222-2222-4222-8222-222222222222'), false, 'an unrelated row in the same list stays unprovenanced');
});

test('a read-only site listing without a user-named host confers no UUID provenance', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  appendEvent({
    sessionId: sess.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Deploy this somewhere suitable.' },
  });
  seedReadOnlyListing(sess.id);
  const has = buildPublishProvenance(sess.id);
  assert.equal(has('11111111-1111-4111-8111-111111111111'), false);
  assert.equal(has('22222222-2222-4222-8222-222222222222'), false);
});

test('run_batch gets the long-executor timeout tier, never the 60s default (2026-07-08 false-kill)', async () => {
  const { timeoutForTool, DEFAULT_TIMEOUTS_MS } = await import('./brackets.js');
  assert.equal(timeoutForTool('run_batch'), DEFAULT_TIMEOUTS_MS.shell);
  assert.ok(timeoutForTool('run_batch') >= 600_000);
});

test('CONFIRM-MINT: an asked "publish to X?" + a short user affirmative provenances the asked host (live 2026-07-30 friction)', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'Clem', type: 'awaiting_user_input', data: {
    question: 'The dedicated Netlify site already exists from an earlier attempt. Confirm I should publish this brief to myatt-bell-brief.netlify.app?',
  } });
  appendEvent({ sessionId: sess.id, turn: 2, role: 'user', type: 'user_input_received', data: {
    text: 'Perfect can you give me the link then please',
  } });
  const has = buildPublishProvenance(sess.id);
  assert.equal(has('myatt-bell-brief.netlify.app'), true, 'the user-affirmed asked destination is user-sanctioned');
  assert.equal(has('myatt-bell-brief'), true, 'identity forms of the affirmed host ride along');
});

test('CONFIRM-MINT: a NON-affirmative or long answer confers nothing; an unanswered ask confers nothing', () => {
  resetEventLog();
  const sess = createSession({ kind: 'chat' });
  appendEvent({ sessionId: sess.id, turn: 1, role: 'Clem', type: 'awaiting_user_input', data: {
    question: 'Confirm I should publish to fixture-site-a.netlify.app?',
  } });
  appendEvent({ sessionId: sess.id, turn: 2, role: 'user', type: 'user_input_received', data: {
    text: 'No — actually use a different site, and while you are at it change the headline copy too.',
  } });
  appendEvent({ sessionId: sess.id, turn: 3, role: 'Clem', type: 'awaiting_user_input', data: {
    question: 'Should I publish to fixture-site-b.netlify.app?',
  } });
  // (no answer to the second ask)
  const has = buildPublishProvenance(sess.id);
  assert.equal(has('fixture-site-a.netlify.app'), false, 'a rejection never mints the asked destination');
  assert.equal(has('fixture-site-b.netlify.app'), false, 'an unanswered ask never mints');
});
