/** Run: npx tsx --test apps/console-web/src/lib/meetings.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recallMeetingDetailPollInterval,
  recallMeetingTone,
  meetingAnalysisNotice,
  canRetryMeetingAnalysis,
  getMeeting,
  retryRecallMeetingAnalysis,
  type MeetingDetail,
  type MeetingSummary,
} from './meetings.js';

function summary(presentation: MeetingSummary['presentation']): MeetingSummary {
  return {
    id: 'meeting-presentation-test',
    provider: 'recall',
    status: 'completed',
    segmentCount: 0,
    presentation,
  };
}

test('Recall list presentation never maps failed or timed-out transcript work to green Done', () => {
  assert.deepEqual(recallMeetingTone(summary({
    status: 'failed',
    label: 'Transcript failed',
    error: 'canonical transcript came back empty',
    retryable: true,
  })), { tone: 'danger', label: 'Transcript failed' });

  assert.deepEqual(recallMeetingTone(summary({
    status: 'timed_out',
    label: 'Upload timed out',
    error: 'upload reconciliation timed out',
    retryable: true,
  })), { tone: 'danger', label: 'Upload timed out' });
});

test('Recall list presentation distinguishes processing and a verified transcript', () => {
  assert.deepEqual(recallMeetingTone(summary({
    status: 'processing',
    label: 'Processing transcript',
    retryable: false,
  })), { tone: 'live', label: 'Processing transcript' });

  assert.deepEqual(recallMeetingTone(summary({
    status: 'ready',
    label: 'Transcribed',
    retryable: false,
  })), { tone: 'success', label: 'Transcribed' });
});

test('Recall list fallback still refuses green capture completion when canonical work failed', () => {
  assert.deepEqual(recallMeetingTone({
    id: 'legacy-canonical-failure',
    provider: 'recall',
    status: 'completed',
    segmentCount: 12,
    canonicalStatus: 'failed',
    canonicalError: 'canonical transcript came back empty',
  }), { tone: 'danger', label: 'Transcript failed' });
});

test('selected Recall detail polls only while transcript recovery is active', () => {
  assert.equal(recallMeetingDetailPollInterval({
    record: { id: 'processing', provider: 'recall' },
    presentation: { status: 'processing', label: 'Processing transcript', retryable: false },
  }), 5_000);
  assert.equal(recallMeetingDetailPollInterval({
    record: { id: 'recording', provider: 'recall' },
    presentation: { status: 'recording', label: 'Recording', retryable: false },
  }), 5_000);
  assert.equal(recallMeetingDetailPollInterval({
    record: { id: 'ready', provider: 'recall' },
    presentation: { status: 'ready', label: 'Transcribed', retryable: false },
  }), false);
  assert.equal(recallMeetingDetailPollInterval({
    record: { id: 'local', provider: 'local', transcriptionStatus: 'transcribing' },
  }), false, 'local status keeps its existing recorder polling path');
});

test('selected detail follows its own queued or running summary after the transcript is ready', () => {
  for (const status of ['queued', 'running'] as const) {
    const detail: MeetingDetail = { record: { id: 'exact-meeting' },
      presentation: { status: 'ready', label: 'Transcribed', retryable: false }, analysisState: { status, taskId: 'bg-exact-summary' } };
    assert.equal(recallMeetingDetailPollInterval(detail), 5_000);
    assert.equal(recallMeetingDetailPollInterval({ ...detail, analysisState: { status } }), false, 'no unowned pending loop');
  }
  for (const status of ['off', 'complete', 'failed', 'incomplete', 'unavailable'] as const) {
    assert.equal(recallMeetingDetailPollInterval({ analysisState: { status, taskId: 'bg-exact-summary' } }), false);
  }
});

test('summary completion, failed execution and a missing saved result remain distinct', () => {
  assert.equal(meetingAnalysisNotice(undefined), null, 'older services do not invent a task');
  assert.match(meetingAnalysisNotice({ analysisState: { status: 'queued', taskId: 'bg-exact-summary' } })!.title, /queued/);
  const incomplete = meetingAnalysisNotice({ analysisState: { status: 'incomplete', taskId: 'bg-exact-summary' } })!;
  assert.match(incomplete.description!, /without a saved meeting summary/);
  assert.equal(incomplete.canRefresh, true);
  assert.equal(incomplete.taskHref, '/tasks?select=bg-exact-summary');
  assert.equal(meetingAnalysisNotice({ analysisState: { status: 'failed' } })!.attention, true);
  assert.equal(meetingAnalysisNotice({ analysisState: { status: 'complete' } })!.title, 'Summary ready');
  assert.equal(meetingAnalysisNotice({ analysisState: { status: 'off' } })!.canRefresh, false);
});


test('summary recovery requires an ended Recall recording with retained transcript and no active task', () => {
  const detail: MeetingDetail = { record: { id: 'owned-meeting', provider: 'recall', status: 'completed', artifactPath: '/controlled/meeting.md' },
    analysisState: { status: 'incomplete', taskId: 'bg-original' } };
  for (const status of ['failed', 'incomplete', 'unavailable'] as const) {
    assert.equal(canRetryMeetingAnalysis({ ...detail, analysisState: { status } }), true);
  }
  for (const status of ['off', 'queued', 'running', 'complete'] as const) {
    assert.equal(canRetryMeetingAnalysis({ ...detail, analysisState: { status, taskId: 'bg-owned' } }), false);
  }
  for (const record of [{ ...detail.record, status: 'recording' }, { ...detail.record, status: 'cancelled' },
    { ...detail.record, provider: 'local' }, { ...detail.record, id: undefined }, { ...detail.record, artifactPath: undefined },
    { ...detail.record, artifactPath: ' ' }]) {
    assert.equal(canRetryMeetingAnalysis({ ...detail, record }), false);
  }
  assert.equal(canRetryMeetingAnalysis(undefined), false);
});

test('summary reads stay passive and explicit recovery binds the exact meeting and prior task without replay', async () => {
  const previousFetch = globalThis.fetch; const previousWindow = globalThis.window;
  Object.assign(globalThis, { window: { __CLEM_BOOTSTRAP__: { token: 'controlled-summary-test', version: '', flags: {} } } });
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  let response: unknown = { record: { id: 'controlled/meeting' }, analysisState: { status: 'failed', taskId: 'bg-original' } };
  let status = 200;
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url).split('?')[0], method: init?.method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    return new Response(JSON.stringify(response), { status });
  }) as typeof fetch;
  try {
    await getMeeting('controlled/meeting');
    assert.deepEqual(calls[0], { url: '/api/console/meetings/recall/controlled%2Fmeeting', method: undefined });
    response = { taskId: 'bg-recovery' }; status = 202;
    assert.deepEqual(await retryRecallMeetingAnalysis('controlled/meeting', 'bg-original'), response);
    assert.deepEqual(calls[1], { url: '/api/console/meetings/recall/controlled%2Fmeeting/analysis/retry', method: 'POST', body: { expectedTaskId: 'bg-original' } });
    await retryRecallMeetingAnalysis('controlled/meeting', null);
    assert.deepEqual(calls[2].body, { expectedTaskId: null });
    await retryRecallMeetingAnalysis('controlled/meeting', 'bg-original', false);
    assert.deepEqual(calls[3].body, { expectedTaskId: 'bg-original' }, 'false preserves the original request shape and owned model');
    await retryRecallMeetingAnalysis('controlled/meeting', 'bg-original', true);
    assert.deepEqual(calls[4], { url: '/api/console/meetings/recall/controlled%2Fmeeting/analysis/retry', method: 'POST',
      body: { expectedTaskId: 'bg-original', useCurrentModel: true } }, 'only an explicit choice requests the current model for a fresh attempt');
    assert.deepEqual(Object.keys(calls[4].body as object).sort(), ['expectedTaskId', 'useCurrentModel'], 'no recording, context or research permission is added');
    for (const invalid of [{}, { taskId: '' }, { taskId: 'x'.repeat(201) }, { taskId: 'bad\nidentity' }, { ok: false }]) {
      response = invalid;
      await assert.rejects(retryRecallMeetingAnalysis('controlled/meeting', 'bg-original'), /could not be confirmed/);
    }
    status = 409; response = { error: 'Controlled changed task.' };
    const before = calls.length;
    await assert.rejects(retryRecallMeetingAnalysis('controlled/meeting', 'bg-original'), (error: unknown) => {
      assert.equal((error as { status: number }).status, 409); return true;
    });
    assert.equal(calls.length, before + 1, 'a stale recovery is never replayed automatically');
    const beforeCurrentModel = calls.length;
    await assert.rejects(retryRecallMeetingAnalysis('controlled/meeting', 'bg-original', true));
    assert.equal(calls.length, beforeCurrentModel + 1, 'the new-model choice cannot automatically resubmit a stale occurrence');
  } finally { Object.assign(globalThis, { fetch: previousFetch, window: previousWindow }); }
});
