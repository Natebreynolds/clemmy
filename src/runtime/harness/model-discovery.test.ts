/**
 * Run: npx tsx --test src/runtime/harness/model-discovery.test.ts
 *
 * Live model discovery: the picker must expose any Codex/Anthropic model the
 * user's credentials can see — a NEW model drop appears without a release —
 * while presets stay the floor and unknown/future ids still ROUTE correctly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterOpenAiChatModelIds, canonicalPickerId, labelForModelId, _setDiscoveredModelsForTest } from './model-discovery.js';
import { resolveProvider } from './model-wire-registry.js';

test('filterOpenAiChatModelIds keeps codex-wire families (gpt-5+/o/codex), drops legacy + modality + date-stamps', () => {
  const kept = filterOpenAiChatModelIds([
    'gpt-5.4', 'gpt-5.5', 'gpt-6', 'gpt-12', 'o3', 'o5-mini', 'codex-large',
    'gpt-4.1', 'gpt-4o', 'gpt-3.5-turbo', // pre-Codex-backend families → excluded
    'gpt-5.4-2026-01-15', 'gpt-5.4-20260115', // date-stamped snapshots → excluded
    'text-embedding-3-small', 'gpt-5-audio-preview', 'whisper-1', 'tts-1',
    'dall-e-3', 'gpt-image-1', 'omni-moderation-latest',
  ]);
  assert.deepEqual(kept.sort(), ['codex-large', 'gpt-12', 'gpt-5.4', 'gpt-5.5', 'gpt-6', 'o3', 'o5-mini'].sort());
});

test('canonicalPickerId strips date stamps and rejects unpersistable ids', () => {
  assert.equal(canonicalPickerId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(canonicalPickerId('claude-fable-5'), 'claude-fable-5');
  assert.equal(canonicalPickerId('claude-opus-4-8[1m]'), null, 'bracketed variant cannot be saved — never offer it');
});

test('labelForModelId prettifies ids; API display_name wins', () => {
  assert.equal(labelForModelId('claude-fable-5'), 'Claude Fable 5');
  assert.equal(labelForModelId('gpt-6'), 'GPT 6');
  assert.equal(labelForModelId('claude-sonnet-5-20260601', 'Claude Sonnet 5'), 'Claude Sonnet 5');
  assert.equal(labelForModelId('claude-omega-7-20270101'), 'Claude Omega 7');
});

test('FUTURE model ids ROUTE to the right provider (a picked discovered model must dispatch)', () => {
  // Any claude-* → the anthropic wire (registry catch-all).
  assert.equal(resolveProvider('claude-fable-6'), 'claude');
  assert.equal(resolveProvider('claude-omega-7-2'), 'claude');
  // Future gpt-N / oN / codex-* → the Codex wire (was: gpt-6 silently fell to BYO).
  assert.equal(resolveProvider('gpt-6'), 'codex');
  assert.equal(resolveProvider('gpt-5.6-mini'), 'codex');
  assert.equal(resolveProvider('o5'), 'codex');
  assert.equal(resolveProvider('codex-large'), 'codex');
  // BYO ids stay BYO.
  assert.equal(resolveProvider('glm-5.2'), 'byo');
});

test('picker choices include DISCOVERED models after presets, deduped against presets', async () => {
  _setDiscoveredModelsForTest({
    anthropic: [
      { id: 'claude-fable-5', label: 'dupe of a preset — must not double' },
      { id: 'claude-omega-7', label: 'Claude Omega 7' },
    ],
    openai: [{ id: 'gpt-6', label: 'GPT 6' }],
  });
  try {
    const { __testChoices } = await import('./model-role-options.js') as unknown as {
      __testChoices: () => { codex: Array<{ id: string; label: string }>; claude: Array<{ id: string; label: string }> };
    };
    const { codex, claude } = __testChoices();
    // Presets first (curated labels win on dupes), discovered appended.
    assert.equal(claude.filter((m) => m.id === 'claude-fable-5').length, 1, 'preset dupe not doubled');
    assert.equal(claude.find((m) => m.id === 'claude-fable-5')!.label.includes('most capable'), true, 'preset label wins');
    assert.ok(claude.some((m) => m.id === 'claude-omega-7'), 'a NEW Anthropic model appears in the picker');
    assert.ok(codex.some((m) => m.id === 'gpt-6'), 'a NEW OpenAI model appears in the picker');
    assert.equal(codex[0].id, 'gpt-5.4-nano', 'presets stay first / ordering stable');
  } finally {
    _setDiscoveredModelsForTest(null);
  }
});
