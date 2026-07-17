/**
 * Run: npx tsx --test src/runtime/harness/tool-guardrail.rehydrate.test.ts
 *
 * STRAND-HUNT finding F (2026-07-12): the fanout ENTITY gate must survive a
 * daemon UPGRADE+restart mid-batch. Rows persisted BEFORE the fanoutEntity field
 * existed rehydrate with signatures but no entities; if the rehydrate did not
 * fall back entity := signature, the entity gate would rehydrate EMPTY and the
 * block would silently die after restart (distinctEntities < threshold while
 * distinct stays high). This drives the REAL persist→restart→rehydrate path with
 * an isolated temp CLEMENTINE_HOME (never the real home).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-guardrail-rehydrate-'));
process.env.CLEMENTINE_HOME = TMP_HOME; // BEFORE imports — HARNESS_DB_PATH is frozen at load
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-rehydrate-test\n', 'utf-8');
process.env.CLEMMY_GUARDRAIL_PERSIST = 'on'; // this test NEEDS the persist path

const { evaluateToolCall, applyMode, _simulateRestartForTests } = await import('./tool-guardrail.js');
const { createSession, readGuardrailState, writeGuardrailState } = await import('./eventlog.js');

test('synthetic code-mode guardrail scopes persist under their real parent session', () => {
  const sid = 'sess-scoped-persistence';
  createSession({ id: sid, kind: 'chat' });
  const scopeId = `${sid}::codeMode`;
  const payload = JSON.stringify([{ signature: 'sig-1', toolName: 'read_file', firstSeenMs: 1 }]);

  assert.doesNotThrow(() => writeGuardrailState(scopeId, payload));
  assert.equal(readGuardrailState(scopeId), payload);

  // A scope with no durable parent is intentionally memory-only and should not
  // emit the foreign-key failures seen in the production log.
  assert.doesNotThrow(() => writeGuardrailState('missing-parent::codeMode', payload));
  assert.equal(readGuardrailState('missing-parent::codeMode'), null);
});

test('strand-hunt F: legacy persisted rows (no fanoutEntity) still arm the entity gate after restart', async () => {
  const sid = 'sess-rehydrate-F';
  createSession({ id: sid, kind: 'chat' });

  // Simulate 6 distinct native-MCP reads persisted by an OLDER build: real
  // fanoutKey + distinct signatures, but NO fanoutEntity field (the pre-upgrade
  // shape). These are exactly what rehydrateFromSqlite reads back.
  const fanoutKey = 'mcp::dataforseo__serp_organic_live_advanced';
  const legacyRecent = Array.from({ length: 6 }, (_v, i) => ({
    signature: `legacy-sig-${i}`,
    toolName: 'dataforseo__serp_organic_live_advanced',
    firstSeenMs: 1_000 + i,
    fanoutKey,
    // NOTE: intentionally NO fanoutEntity — this is the pre-upgrade row shape.
  }));
  writeGuardrailState(sid, JSON.stringify(legacyRecent));

  // Drop any in-memory tracker so the next call rehydrates from sqlite.
  _simulateRestartForTests(sid);

  // One fresh direct read of the SAME slug, block on. If the 6 legacy rows armed
  // the entity gate (entity := signature fallback), we are at 7 distinct entities
  // → the block fires. Without the fallback the gate rehydrated empty → no block.
  process.env.CLEMMY_GUARDRAIL_FANOUT_BLOCK = 'on';
  try {
    const d = applyMode(evaluateToolCall(sid, 'dataforseo__serp_organic_live_advanced', { keyword: 'k-after-restart' }));
    assert.ok(d.fanoutBlock, 'the entity gate survived the upgrade+restart — the block still fires');
  } finally {
    delete process.env.CLEMMY_GUARDRAIL_FANOUT_BLOCK;
  }
});

test('review #9: a persisted composio WRITE runaway survives restart; persisted reads never inflate', async () => {
  const sid = 'sess-rehydrate-mut';
  createSession({ id: sid, kind: 'chat' });

  // 7 distinct gateway WRITES persisted with the live classification, plus 5
  // gateway READS (no mutating flag on a modern row means classified read),
  // plus 2 legacy rows (no mutating field at all — pre-upgrade shape).
  const rows = [
    ...Array.from({ length: 7 }, (_v, i) => ({
      signature: `send-sig-${i}`, toolName: 'composio_execute_tool', firstSeenMs: 1_000 + i, mutating: true,
    })),
    ...Array.from({ length: 5 }, (_v, i) => ({
      signature: `read-sig-${i}`, toolName: 'composio_execute_tool', firstSeenMs: 2_000 + i, mutating: false,
    })),
    ...Array.from({ length: 2 }, (_v, i) => ({
      signature: `legacy-sig-${i}`, toolName: 'composio_execute_tool', firstSeenMs: 3_000 + i,
    })),
  ];
  writeGuardrailState(sid, JSON.stringify(rows));
  _simulateRestartForTests(sid);

  // The 8th distinct WRITE after restart must land at the halt threshold
  // (default sameMutToolHaltAt = 8): 7 persisted writes + this one. If reads
  // or legacy rows had inflated the count, the halt would have fired EARLIER
  // (false positive); if writes hadn't survived, action would be allow/warn.
  const d = evaluateToolCall(sid, 'composio_execute_tool', {
    tool_slug: 'GMAIL_SEND_EMAIL',
    arguments: { to: 'someone-new@example.com' },
  });
  assert.equal(d.rule, 'same_mut_tool_repeat', 'the persisted write count survived the restart');
  assert.equal(d.action, 'halt', '7 persisted writes + 1 live write = the halt threshold exactly');
  assert.equal(d.count, 8, 'reads and legacy gateway rows did NOT inflate the count');
});

after(() => {
  try { rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});
