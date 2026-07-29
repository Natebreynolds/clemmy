/** Run: npx tsx --test apps/console-web/src/lib/meetings.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recallMeetingDetailPollInterval,
  recallMeetingTone,
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
