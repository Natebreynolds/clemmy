/**
 * Switching back to Claude never dead-ends on a "not connected" label.
 *
 * 2026-09-08: a v3.16.0 user whose in-app Claude sign-in had expired could not
 * get back to Claude — the picker refused with a 409 that pointed at Claude
 * Code and left them to find the sign-in form on their own. The picker now
 * renders the sign-in inline on that refusal, retries the switch when the
 * sign-in lands, and says why Claude is unavailable.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CARD = readFileSync(new URL('./ModelRolesCard.tsx', import.meta.url), 'utf8');
const OAUTH = readFileSync(new URL('../../../../../src/runtime/claude-oauth.ts', import.meta.url), 'utf8');

test('a 409 on a Claude switch renders the Claude sign-in inline and remembers the attempted brain', () => {
  assert.match(CARD, /setClaudeSignInFor\(value\)/, 'the attempted brain value is remembered on a needsLogin refusal');
  assert.match(CARD, /claudeSignInFor && \(\s*<div[^>]*>\s*<ClaudeLoginForm embedded \/>/, 'the sign-in form renders inline under the refusal');
});

test('the switch completes on its own once the sign-in lands', () => {
  assert.match(CARD, /if \(claudeSignInFor && claudeAuth\?\.configured && !claudeAuth\.degraded\)/);
  assert.match(CARD, /void onBrain\(value\);/);
});

test('the Claude row says why it is unavailable, and the server copy is app-first', () => {
  assert.match(CARD, /\(sign-in expired\)/);
  assert.match(CARD, /\(via Claude Code\)/);
  assert.doesNotMatch(OAUTH, /Re-open Claude Code to refresh your login\./, 'app users are not sent to Claude Code as the only door');
  assert.match(OAUTH, /Settings → Models → Claude login/);
});
