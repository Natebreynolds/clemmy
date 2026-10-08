import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_ADOPTED_BRAIN_MODEL, claudeBrainAdoptionAfterSignIn } from './claude-brain-adoption.js';

const base = { authMode: 'api_key' as const, routingMode: 'off', codexSignedIn: false, openAiKey: false, claudeModel: '' };

test('a Claude sign-in on a home with no runnable brain makes Claude the brain, on Sonnet unless a Claude model was chosen', () => {
  assert.deepEqual(claudeBrainAdoptionAfterSignIn(base), { claudeModel: CLAUDE_ADOPTED_BRAIN_MODEL });
  assert.deepEqual(claudeBrainAdoptionAfterSignIn({ ...base, authMode: 'codex_oauth' }), { claudeModel: CLAUDE_ADOPTED_BRAIN_MODEL },
    'a Codex mode with no Codex sign-in cannot run either');
  assert.deepEqual(claudeBrainAdoptionAfterSignIn({ ...base, claudeModel: 'claude-haiku-4-5' }), { claudeModel: null }, 'an existing Claude choice is kept');
  assert.notEqual(CLAUDE_ADOPTED_BRAIN_MODEL, 'claude-opus-4-8', 'never a premium model unbidden');
});

test('a working Codex, OpenAI-key, BYO or Claude brain is never moved', () => {
  assert.equal(claudeBrainAdoptionAfterSignIn({ ...base, codexSignedIn: true }), null);
  assert.equal(claudeBrainAdoptionAfterSignIn({ ...base, openAiKey: true }), null);
  assert.equal(claudeBrainAdoptionAfterSignIn({ ...base, routingMode: 'all_in' }), null);
  assert.equal(claudeBrainAdoptionAfterSignIn({ ...base, authMode: 'claude_oauth' }), null);
});
