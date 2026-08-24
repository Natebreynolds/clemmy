/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/session-tool-index.test.ts
 *
 * THE TOOL INDEX pins (live 2026-08-19 sess-synthetic-008: 40 denied tool_search
 * retries for `workflow_schedule` — her own tool). Names always in context,
 * schemas on demand, deterministic bytes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-tool-index-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-tool-index\n', 'utf8');

const { renderSessionToolIndex } = await import('./session-tool-index.js');
const { renderClaudeAgentBrainSystemAppend } = await import('./claude-agent-brain.js');

test('the index names her own workflow tools — the 40-search hunt is dead', () => {
  const index = renderSessionToolIndex();
  assert.match(index, /- workflow_schedule — /, 'the exact tool the live turn hunted for');
  assert.match(index, /- workflow_update — /);
  assert.match(index, /- workflow_list — /);
  assert.match(index, /- tool_search — /);
  assert.match(index, /schemas load on demand/i, 'the contract states schemas never preload');
});

test('the index is byte-deterministic across renders (KV-cache-first)', () => {
  assert.equal(renderSessionToolIndex(), renderSessionToolIndex());
});

test('the always-present index stays names-only and within its bounded prompt budget', () => {
  const index = renderSessionToolIndex();
  assert.ok(
    Buffer.byteLength(index, 'utf8') <= 32 * 1024,
    'the names-only index must remain below 32 KiB',
  );
  assert.doesNotMatch(index, /"type"\s*:\s*"object"|"properties"\s*:/i,
    'the index must not preload JSON schemas');
});

test('the brain system append carries the index', () => {
  const append = renderClaudeAgentBrainSystemAppend('home', {
    message: 'update the platform 49 workflow to run every 4 hours',
    sessionId: 'sess-tool-index-pin',
  } as never, 'full');
  assert.match(append, /TOOL INDEX/);
  assert.match(append, /- workflow_schedule — /);
});

test('the brain index never leaks mutation names into a read-only prompt', () => {
  const append = renderClaudeAgentBrainSystemAppend('home', {
    message: 'What workflows do I have?',
    sessionId: 'sess-tool-index-read-only',
  } as never, 'read_only');
  assert.doesNotMatch(append, /TOOL INDEX/);
  assert.doesNotMatch(append, /- workflow_schedule — /);
});

test('the index names the deferred door so a "No such tool" bounce costs one retry, not a search round', async () => {
  const { renderSessionToolIndex } = await import('./session-tool-index.js');
  const index = renderSessionToolIndex();
  if (index) {
    assert.match(index, /No such tool available/, 'the bounce error is named');
    assert.match(index, /call_tool/, 'and steered to the carrier door');
  }
});

test('the index names what this install can actually reach, from provisioning rather than use', async () => {
  // The blank-install answer to "what tools do I have". Before the capability
  // index the model saw a names-only builtin list and, at best, a line of
  // toolkit slugs from a warm connection cache — nothing about what those
  // toolkits could DO, and nothing at all on a cold boot.
  const { recordCapabilityOperations } = await import('../../memory/capability-index.js');
  const { renderSessionToolIndex } = await import('./session-tool-index.js');
  recordCapabilityOperations([
    { identifier: 'ACME_SEND', carrierKind: 'composio', carrier: 'acme', displayName: 'Send', description: 'Send a thing.', effectClass: 'write', effectProvenance: 'inferred' },
    { identifier: 'ACME_LIST', carrierKind: 'composio', carrier: 'acme', displayName: 'List', description: 'List things.', effectClass: 'read', effectProvenance: 'inferred' },
    { identifier: 'srv__probe', carrierKind: 'mcp', carrier: 'srv', displayName: 'probe', description: 'Probe.', effectClass: 'read', effectProvenance: 'declared' },
    { identifier: 'gh', carrierKind: 'cli', carrier: 'gh', displayName: 'gh', description: 'GitHub CLI.', effectClass: 'unknown', effectProvenance: 'none' },
  ]);
  const rendered = renderSessionToolIndex();
  assert.match(rendered, /CONNECTED CAPABILITIES/);
  assert.match(rendered, /connected apps: acme \(2\)/, 'apps are named with what they expose');
  assert.match(rendered, /MCP servers: srv \(1\)/);
  assert.match(rendered, /local CLIs: 1 programs on PATH/, 'CLIs are counted, not named — a PATH scan is mostly system binaries');
  assert.doesNotMatch(rendered, /ACME_SEND|ACME_LIST|srv__probe/,
    'the stable prefix names carriers and counts, never a static external operation dump');
  assert.doesNotMatch(rendered, /local CLIs: gh/, 'naming PATH entries would spend prompt bytes on noise');
  assert.match(rendered, /tool_search/, 'and the model is told how to go from name to call');

  // Byte-stability: consecutive renders must be identical while the index is
  // unchanged, or the prompt prefix churns and the cache misses every turn.
  assert.equal(renderSessionToolIndex(), rendered);
});
