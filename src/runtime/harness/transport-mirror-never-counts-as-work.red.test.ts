/**
 * GUARD PIN — transport mirrors never count as work.
 *
 * Invariant: every gated-lane tool call lands as TWO durable tool_called rows
 * — the provider-level row (accounting:'top_level') and the inner local-MCP
 * gateway copy (accounting:'transport_mirror'). The ONE canonical projection
 * (tool-effect.ts) is how every first-party aggregate stays truthful: mirrors
 * are excluded from counting, legacy rows without accounting metadata remain
 * countable, and a mirror PAIRS with its canonical row instead of becoming a
 * second countable call. Raw-row counting is the ~70% inflation trap that
 * poisoned a prior measurement baseline (live 2026-08-08).
 *
 * These guards are green today and must stay green through the telemetry-
 * separation fix: separation means NEW counters, never a redefinition of the
 * canonical projection.
 *
 * Run: npx tsx --test src/runtime/harness/transport-mirror-never-counts-as-work.red.test.ts
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isCanonicalTopLevelToolEvent,
  pairTransportMirrorToolCalls,
  projectCanonicalTopLevelToolEvents,
} from './tool-effect.js';

const CANONICAL = {
  type: 'tool_called',
  data: {
    tool: 'call_tool',
    callId: 'wrapper-1',
    accounting: 'top_level',
    effectiveTool: 'composio_search_tools',
    correlationFingerprint: 'fp-outlook-draft',
    arguments: '{"name":"composio_search_tools","args_json":"{\\"query\\":\\"outlook draft\\"}"}',
  },
};
const MIRROR = {
  type: 'tool_called',
  data: {
    tool: 'composio_search_tools',
    callId: 'mirror-1',
    accounting: 'transport_mirror',
    canonicalCallId: 'wrapper-1',
    correlationFingerprint: 'fp-outlook-draft',
    args: { query: 'outlook draft', limit: null },
  },
};
const LEGACY = {
  type: 'tool_called',
  data: { tool: 'remember_fact', callId: 'legacy-1' },
};

test('guard: the canonical projection excludes mirrors without dropping native or legacy rows', () => {
  const projected = projectCanonicalTopLevelToolEvents([CANONICAL, MIRROR, LEGACY], 'tool_called');
  assert.deepEqual(
    projected.map((event) => (event.data as { callId: string }).callId),
    ['wrapper-1', 'legacy-1'],
    'one logical action projects to one countable row; the legacy row stays countable',
  );
  assert.equal(isCanonicalTopLevelToolEvent(MIRROR), false, 'the labelled gateway copy is never canonical');
  assert.equal(isCanonicalTopLevelToolEvent(LEGACY), true, 'rows without accounting metadata remain countable');
});

test('guard: a mirror pairs with its canonical call instead of becoming a second countable call', () => {
  const pairs = pairTransportMirrorToolCalls([CANONICAL, MIRROR]);
  assert.equal(pairs.mirrorToCanonicalCallId.get('mirror-1'), 'wrapper-1');
  assert.equal(pairs.canonicalToMirrorCallId.get('wrapper-1'), 'mirror-1');
});
