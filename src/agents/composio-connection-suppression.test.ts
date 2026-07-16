/**
 * Run: npx tsx --test src/agents/composio-connection-suppression.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  hardAuthSuppressionDurationMs,
  mergeConnectionSuppressions,
  suppressConnectionAfterHardAuthFailure,
} = await import('./composio-connection-suppression.js');

test('suppresses Composio SDK auth errors even when message/cause are non-enumerable', () => {
  const err = Object.create(null);
  Object.defineProperty(err, 'message', {
    enumerable: false,
    value: 'Error executing the tool OUTLOOK_GET_CALENDAR_VIEW',
  });
  Object.defineProperty(err, 'cause', {
    enumerable: false,
    value: {
      message: '400 {"error":{"message":"Connected account user ID does not match the provided user ID again.","code":1812}}',
    },
  });
  Object.defineProperty(err, 'statusCode', {
    enumerable: true,
    value: 400,
  });

  const state = {};
  const suppression = suppressConnectionAfterHardAuthFailure(state, 'ca_stale', err, Date.parse('2026-07-02T12:00:00Z'));
  assert.equal(suppression?.reason, 'entity-mismatch');
});

test('suppresses expired connection errors from nested SDK payloads', () => {
  const state = {};
  const suppression = suppressConnectionAfterHardAuthFailure(
    state,
    'ca_expired',
    {
      message: 'Error executing the tool OUTLOOK_LIST_MAIL_FOLDER_MESSAGES',
      data: {
        error: {
          message: "Connected account ca_expired for toolkit 'outlook' is in EXPIRED state",
          code: 1820,
        },
      },
    },
    Date.parse('2026-07-02T12:00:00Z'),
  );
  assert.equal(suppression?.reason, 'expired');
});

test('suppresses not-connected (1810) errors from nested SDK payloads', () => {
  const state = {};
  const suppression = suppressConnectionAfterHardAuthFailure(
    state,
    'ca_gone',
    {
      message: 'Error executing the tool OUTLOOK_LIST_MAIL_FOLDER_MESSAGES',
      data: {
        error: {
          message: "ConnectedAccountNotFound: no connected account found for toolkit 'outlook'",
          code: 1810,
        },
      },
    },
    Date.parse('2026-07-02T12:00:00Z'),
  );
  assert.equal(suppression?.reason, 'not-connected');
  // Falls onto the expired backoff schedule (no dedicated schedule).
  assert.equal(
    suppression?.suppressUntil,
    new Date(Date.parse('2026-07-02T12:00:00Z') + hardAuthSuppressionDurationMs('not-connected', 1)).toISOString(),
  );
});

test('suppresses ToolRouterV2 NoActiveConnection variants', () => {
  const state = {};
  const suppression = suppressConnectionAfterHardAuthFailure(
    state,
    'ca_router',
    new Error('ToolRouterV2_NoActiveConnection: NoActiveConnection for GMAIL'),
    Date.parse('2026-07-02T12:00:00Z'),
  );
  assert.equal(suppression?.reason, 'not-connected');
});

test('a plain 404 / generic not-found does NOT quarantine (misfire has 1-30 day blast radius)', () => {
  const state = {};
  for (const err of [
    new Error('404 Not Found'),
    new Error('Tool OUTLOOK_FOO not found in catalog'),
    { message: 'resource not found', statusCode: 404 },
    new Error('no results found for query'),
  ]) {
    const suppression = suppressConnectionAfterHardAuthFailure(state, 'ca_healthy', err, Date.parse('2026-07-02T12:00:00Z'));
    assert.equal(suppression, undefined);
  }
  assert.deepEqual(state, {});
});

test('hard auth suppressions use progressive long-lived quarantine windows', () => {
  const now = Date.parse('2026-07-02T12:00:00Z');
  const expiredErr = {
    data: {
      error: {
        message: "Connected account ca_expired for toolkit 'outlook' is in EXPIRED state",
        code: 1820,
      },
    },
  };
  const state = {};

  const first = suppressConnectionAfterHardAuthFailure(state, 'ca_expired', expiredErr, now);
  assert.equal(first?.failures, 1);
  assert.equal(first?.suppressUntil, new Date(now + hardAuthSuppressionDurationMs('expired', 1)).toISOString());

  const secondNow = now + 60_000;
  const second = suppressConnectionAfterHardAuthFailure(state, 'ca_expired', expiredErr, secondNow);
  assert.equal(second?.failures, 2);
  assert.equal(second?.suppressUntil, new Date(secondNow + hardAuthSuppressionDurationMs('expired', 2)).toISOString());
});

test('entity mismatch starts with a week-long quarantine because it requires account repair', () => {
  const now = Date.parse('2026-07-02T12:00:00Z');
  const suppression = suppressConnectionAfterHardAuthFailure(
    {},
    'ca_stale',
    new Error('ConnectedAccountEntityIdMismatch: connected account user id does not match code: 1812'),
    now,
  );

  assert.equal(suppression?.reason, 'entity-mismatch');
  assert.equal(suppression?.suppressUntil, new Date(now + hardAuthSuppressionDurationMs('entity-mismatch', 1)).toISOString());
});

test('mergeConnectionSuppressions keeps the active record with the furthest suppressUntil', () => {
  const now = Date.parse('2026-07-02T12:00:00Z');
  const target = {
    suppressedConnections: {
      ca_same: {
        reason: 'expired',
        suppressUntil: '2026-07-03T12:00:00.000Z',
        lastErrorAt: '2026-07-02T11:00:00.000Z',
        failures: 1,
      },
    },
  };

  mergeConnectionSuppressions(target, {
    suppressedConnections: {
      ca_same: {
        reason: 'entity-mismatch',
        suppressUntil: '2026-07-09T12:00:00.000Z',
        lastErrorAt: '2026-07-02T11:30:00.000Z',
        failures: 2,
      },
      ca_expired_old: {
        reason: 'expired',
        suppressUntil: '2026-07-01T12:00:00.000Z',
        lastErrorAt: '2026-07-01T11:00:00.000Z',
        failures: 1,
      },
    },
  }, now);

  assert.equal(target.suppressedConnections.ca_same.reason, 'entity-mismatch');
  assert.equal(target.suppressedConnections.ca_same.failures, 2);
  assert.equal((target.suppressedConnections as Record<string, unknown>).ca_expired_old, undefined);
});
