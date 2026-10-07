import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCodexTokenResponse } from './codex-token-response.js';

for (const operation of ['exchange', 'refresh'] as const) {
  test(`${operation} error/invalid payload cannot expose token fragments or nested parse causes`, () => {
    const privateMarker = 'synthetic-private-refresh-token';
    for (const [body, status, ok] of [[privateMarker, 401, false], [`{"${privateMarker}": invalid}`, 200, true], ['null', 200, true], ['[]', 200, true]] as const) {
      assert.throws(() => parseCodexTokenResponse(body, status, ok, operation), (error: unknown) => {
        assert.ok(error instanceof Error); assert.equal(error.cause, undefined);
        assert.equal(error.message.includes(privateMarker), false); assert.match(error.message, /Retry sign-in from Settings/);
        if (!ok) assert.match(error.message, /HTTP 401/);
        return true;
      });
    }
    assert.deepEqual(parseCodexTokenResponse('{"access_token":"synthetic-owned","refresh_token":"synthetic-refresh"}', 200, true, operation), {
      access_token: 'synthetic-owned', refresh_token: 'synthetic-refresh',
    });
  });
}
