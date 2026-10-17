import assert from 'node:assert/strict';
import test from 'node:test';
import { decideMeetingHelp, getMeetingHelp, meetingHelpNotice, startMeetingHelp, type MeetingHelpOffer } from './meeting-assistance';

const offer: MeetingHelpOffer = { id: 'controlled-offer', digest: 'a'.repeat(64), question: 'Which proposal is current?',
  why: 'A participant asked for the approved proposal.', quote: 'Which proposal is current?', segmentIds: ['controlled-final'],
  sourceDigest: 'b'.repeat(64), createdAt: 100, expiresAt: 200, state: 'open' };
const packet = { meetingId: 'controlled-meeting', offerId: offer.id, offerDigest: offer.digest,
  input: 'Controlled private lookup content', clientRequestId: 'controlled-owner-choice', privateOriginSessionId: 'controlled-private-chat' };

test('lookup retries use the same canonical chat request, without putting transcript or identity into the URL', async () => {
  const previousFetch = globalThis.fetch; const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: { __CLEM_BOOTSTRAP__: { token: 'controlled-meeting-test', version: '', flags: {} } } });
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url, init) => { calls.push({ url: String(url).split('?')[0], body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ sessionId: packet.privateOriginSessionId, turn: 1, accepted: true }), { status: 200 }); }) as typeof fetch;
  try {
    await startMeetingHelp(packet); await startMeetingHelp(packet);
    assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[0].url, '/api/harness/chat');
    assert.equal(calls[0].body.sessionId, undefined, 'canonical ingress owns deterministic session creation');
    assert.equal(calls[0].body.clientRequestId, packet.clientRequestId);
    assert.equal(calls[0].body.input, packet.input);
    assert.deepEqual(calls[0].body.meetingLookup, { meetingId: packet.meetingId, offerId: packet.offerId, digest: packet.offerDigest });
    assert.equal(calls[0].body.taskMode, undefined, 'ordinary reviewed task, no generic background write scope');
  } finally { Object.assign(globalThis, { fetch: previousFetch, window: previousWindow }); }
});

test('a mismatched accepted conversation is an explicit failure, not a successful displayed lookup', async () => {
  const previousFetch = globalThis.fetch; const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: { __CLEM_BOOTSTRAP__: { token: 'controlled-meeting-test', version: '', flags: {} } } });
  globalThis.fetch = (async () => new Response(JSON.stringify({ sessionId: 'foreign-chat' }), { status: 200 })) as typeof fetch;
  try { await assert.rejects(startMeetingHelp(packet), /different conversation/); }
  finally { Object.assign(globalThis, { fetch: previousFetch, window: previousWindow }); }
});

test('GET is passive and an owner choice carries the exact offer digest and version', async () => {
  const previousFetch = globalThis.fetch; const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: { __CLEM_BOOTSTRAP__: { token: 'controlled-meeting-test', version: '', flags: {} } } });
  const calls: Array<{ url: string; method?: string; body?: string }> = [];
  globalThis.fetch = (async (url, init) => { calls.push({ url: String(url).split('?')[0], method: init?.method, body: init?.body as string | undefined });
    return new Response('{}', { status: 200 }); }) as typeof fetch;
  try {
    await getMeetingHelp('controlled/meeting'); await decideMeetingHelp('controlled/meeting', offer, 7, 'defer');
    assert.equal(calls[0].url, '/api/console/meetings/controlled%2Fmeeting/assistance');
    assert.equal(calls[0].body, undefined);
    assert.deepEqual(JSON.parse(calls[1].body!), { digest: offer.digest, version: 7, decision: 'defer' });
    assert.equal(calls[1].url.includes(offer.quote), false);
  } finally { Object.assign(globalThis, { fetch: previousFetch, window: previousWindow }); }
});

test('meeting status distinguishes a real check, waiting for final text, unavailable and paused', () => {
  assert.match(meetingHelpNotice({ status: 'watching', checking: true, finalSegmentCount: 1 }), /^Checking/);
  assert.match(meetingHelpNotice({ status: 'watching', checking: false, finalSegmentCount: 0 }), /^Waiting for finalized/);
  assert.match(meetingHelpNotice({ status: 'watching', checking: false, finalSegmentCount: 1 }), /No suggestion yet/);
  assert.match(meetingHelpNotice({ status: 'unavailable', checking: false }), /couldn’t check/);
  assert.match(meetingHelpNotice({ status: 'disabled', checking: false }), /Suggestions are off/);
  assert.match(meetingHelpNotice({ status: 'completed', checking: false }), /meeting has ended/);
});
