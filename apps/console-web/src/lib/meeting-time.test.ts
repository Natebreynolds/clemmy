import { test } from 'node:test';
import assert from 'node:assert/strict';

import { meetingTimeLabel } from './meeting-time.js';

test('completed meeting duration stays fixed as wall time advances', () => {
  const meeting = {
    startedAt: '2026-07-14T07:00:00.000Z',
    endedAt: '2026-07-14T07:01:02.000Z',
  };

  assert.equal(meetingTimeLabel(meeting, Date.parse('2026-07-14T07:01:10.000Z')), '1:02');
  assert.equal(meetingTimeLabel(meeting, Date.parse('2026-07-14T07:04:30.000Z')), '1:02');
});

test('API duration takes precedence over timestamp rounding', () => {
  assert.equal(meetingTimeLabel({
    startedAt: '2026-07-14T07:00:00.000Z',
    endedAt: '2026-07-14T07:01:01.600Z',
    durationSeconds: 62,
  }), '1:02');
});
