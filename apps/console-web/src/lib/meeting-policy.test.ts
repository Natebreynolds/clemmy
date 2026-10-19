import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  adoptMeetingPolicy, getMeetingPolicy, meetingPolicyChanged, meetingPolicyDraft, meetingPolicyModelChoices,
  meetingPolicyPatch, meetingPolicyPayload, meetingPolicyRequestError, saveMeetingPolicy, selectedMeetingPolicyModel,
  type MeetingPolicy,
} from './meeting-policy.js';

const snapshot = (patch: Partial<MeetingPolicy> = {}): MeetingPolicy => ({
  version: 1, revision: 4, updatedAt: '2026-10-18T12:00:00.000Z',
  before: { calendarPrepSuggestions: false }, during: { modelId: null }, after: { modelId: null },
  modelOptions: {
    live: [{ id: 'quick-connected', label: 'Quick connected model', providerLabel: 'Sample provider', available: true }],
    after: [{ id: 'main-connected', label: 'Main connected model', providerLabel: 'Sample provider', available: true }],
  },
  defaults: { live: { modelId: 'quick-connected', label: 'Current quick model', available: true },
    after: { modelId: 'main-connected', label: 'Current main model', available: true } },
  ...patch,
});

test('meeting preferences read only the dedicated endpoint with cancellation and no cache/list fallback', async () => {
  const controller = new AbortController(); const calls: string[] = [];
  const profile = await getMeetingPolicy(controller.signal, async (path, options) => {
    calls.push(path); assert.equal(options?.signal, controller.signal); assert.equal(options?.cache, 'no-store');
    assert.equal(options?.method, undefined); assert.equal(options?.body, undefined); return snapshot();
  });
  assert.equal(profile.revision, 4); assert.equal(profile.during.modelId, null);
  assert.deepEqual(calls, ['/api/console/meetings/policy']);
});

test('missing or malformed profiles never become editable defaults', () => {
  const invalid: unknown[] = [null, {}, { ...snapshot(), ok: false }, snapshot({ version: 2 as 1 }),
    snapshot({ revision: -1 }), snapshot({ revision: Number.MAX_SAFE_INTEGER + 1 }), snapshot({ updatedAt: 'not-a-date' }),
    snapshot({ before: undefined }), snapshot({ during: { modelId: '' } }), snapshot({ after: { modelId: 1 as unknown as string } }),
    snapshot({ modelOptions: undefined }), snapshot({ defaults: undefined }),
    snapshot({ preparation: { state: 'unknown', message: 'Unavailable' } as unknown as MeetingPolicy['preparation'] }),
  ];
  for (const value of invalid) assert.throws(() => meetingPolicyPayload(value), /could not be read/);
  assert.equal(meetingPolicyPayload(snapshot({ revision: 0, updatedAt: null })).revision, 0);
});

test('model catalog and availability records are validated before a selector can use them', () => {
  for (const row of [null, {}, { id: '', label: 'Model', providerLabel: 'Provider', available: true },
    { id: 'a', label: 'Model', providerLabel: 'Provider' },
    { id: 'a', label: {}, providerLabel: 'Provider', available: true },
    { id: 'a', label: 'Model', providerLabel: 'Provider', available: true, reason: {} }]) {
    assert.throws(() => meetingPolicyPayload(snapshot({ modelOptions: { live: [row] as never, after: [] } })));
  }
  const duplicated = snapshot(); duplicated.modelOptions.live.push({ ...duplicated.modelOptions.live[0]! });
  assert.throws(() => meetingPolicyPayload(duplicated));
  const unavailable = snapshot({ defaults: { live: { modelId: null, label: 'No quick model connected', available: false },
    after: { modelId: null, label: 'No main model connected', available: false } }, modelOptions: { live: [], after: [] } });
  assert.equal(meetingPolicyPayload(unavailable).defaults.live.available, false);
});

test('an unavailable saved choice is retained without substituting the inherited or first connected model', () => {
  const profile = snapshot({ during: { modelId: 'old-unavailable' } });
  const choice = meetingPolicyModelChoices(profile, 'live', profile.during.modelId).find((row) => row.id === 'old-unavailable');
  assert.equal(choice?.available, false);
  assert.equal(selectedMeetingPolicyModel(profile, 'live', 'old-unavailable').label, 'Previously selected model');
  assert.equal(profile.during.modelId, 'old-unavailable');
  assert.equal(profile.modelOptions.live.length, 1, 'catalog is not mutated');
  const retained = { id: 'old-unavailable', label: 'My saved model', providerLabel: 'Saved provider', available: false, reason: 'Reconnect this model.' };
  profile.modelOptions.live.push(retained);
  assert.equal(selectedMeetingPolicyModel(profile, 'live', 'old-unavailable'), retained);
  assert.equal(meetingPolicyModelChoices(profile, 'live', 'old-unavailable').length, 2);
});

test('inherited Quick and main choices remain distinct, and explicit choices do not follow a default change', () => {
  const profile = snapshot();
  assert.equal(selectedMeetingPolicyModel(profile, 'live', null).label, 'Current quick model');
  assert.equal(selectedMeetingPolicyModel(profile, 'after', null).label, 'Current main model');
  const editor = adoptMeetingPolicy(profile); editor.draft.during.modelId = 'quick-connected';
  const newDefaults = snapshot(); newDefaults.defaults.live = { modelId: 'different', label: 'New default model', available: true };
  const refreshed = adoptMeetingPolicy(newDefaults, editor, true);
  assert.equal(refreshed.draft.during.modelId, 'quick-connected');
  assert.equal(selectedMeetingPolicyModel(refreshed.saved, 'live', refreshed.draft.during.modelId).label, 'Quick connected model');
});

test('save carries only the exact saved revision and three consumed preferences, never research or capture consent', async () => {
  const editor = adoptMeetingPolicy(snapshot());
  editor.draft.before.calendarPrepSuggestions = true;
  editor.draft.during.modelId = 'quick-connected';
  const controller = new AbortController(); const calls: unknown[] = [];
  const result = await saveMeetingPolicy(editor, controller.signal, async (path, options) => {
    assert.equal(path, '/api/console/meetings/policy'); assert.equal(options?.method, 'PATCH');
    assert.equal(options?.signal, controller.signal); calls.push(JSON.parse(options?.body as string));
    return snapshot({ revision: 5, ...meetingPolicyDraft(editor.draft) });
  });
  assert.equal(result.revision, 5);
  assert.deepEqual(calls, [{ expectedRevision: 4, before: { calendarPrepSuggestions: true },
    during: { modelId: 'quick-connected' }, after: { modelId: null } }]);
  assert.equal(editor.saved.before.calendarPrepSuggestions, false, 'draft edit does not mutate the displayed snapshot');
});

test('a conflict keeps all draft choices while a read advances the current comparison and explicit next save revision', async () => {
  const previous = adoptMeetingPolicy(snapshot()); previous.draft.before.calendarPrepSuggestions = true;
  previous.draft.during.modelId = 'quick-connected';
  let mutations = 0;
  await assert.rejects(saveMeetingPolicy(previous, undefined, async () => {
    mutations += 1; throw Object.assign(new Error('private path must not reach UI'), { status: 409 });
  }), (error: unknown) => !!error && typeof error === 'object' && 'status' in error && error.status === 409);
  assert.equal(mutations, 1, 'the client never resends a conflicted write');
  const latest = snapshot({ revision: 7, after: { modelId: 'main-connected' } });
  const reviewed = adoptMeetingPolicy(latest, previous, true);
  assert.deepEqual(reviewed.draft, previous.draft);
  assert.equal(reviewed.saved.after.modelId, 'main-connected', 'current saved state remains separately available for comparison');
  assert.equal(meetingPolicyPatch(reviewed).expectedRevision, 7);
  assert.equal(meetingPolicyChanged(reviewed), true);
  assert.equal(meetingPolicyPatch(previous).expectedRevision, 4, 'old displayed revision is not changed in place');
});

test('normal successful adoption clears differences, but mismatched or unadvanced save receipts cannot claim saved', async () => {
  const editor = adoptMeetingPolicy(snapshot()); editor.draft.before.calendarPrepSuggestions = true;
  for (const returned of [snapshot(), snapshot({ revision: 5 }), { ...snapshot(), ok: false }]) {
    await assert.rejects(saveMeetingPolicy(editor, undefined, async () => returned));
  }
  const exact = snapshot({ revision: 5, before: { calendarPrepSuggestions: true } });
  const saved = await saveMeetingPolicy(editor, undefined, async () => exact);
  assert.equal(meetingPolicyChanged(adoptMeetingPolicy(saved)), false);
});

test('unreadable service, conflict and auth failures have bounded recoveries without exposing raw error text', async () => {
  for (const status of [401, 403, 409, 503, 500, 0]) {
    const error = Object.assign(new Error('secret=do-not-show /private/owner/path'), { status, body: { error: 'secret value' } });
    const copy = meetingPolicyRequestError(error, true);
    assert.doesNotMatch(copy, /secret|private|owner\/path/);
    if (status === 409) assert.match(copy, /choices are kept.*Review/);
    if (status === 503) assert.match(copy, /unavailable.*reading them again/);
    if (status === 401 || status === 403) assert.match(copy, /Reconnect/);
  }
  let reads = 0;
  await assert.rejects(getMeetingPolicy(undefined, async () => { reads += 1; throw Object.assign(new Error('unavailable'), { status: 503 }); }));
  assert.equal(reads, 1, 'no default profile or automatic read loop is created');
});
