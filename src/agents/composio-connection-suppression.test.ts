/**
 * Run: npx tsx --test src/agents/composio-connection-suppression.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { suppressConnectionAfterHardAuthFailure } = await import('./composio-connection-suppression.js');

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
