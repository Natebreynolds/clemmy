#!/usr/bin/env node
/**
 * v0.5.10 auto-compact REPLAY VERIFICATION
 *
 * Reads the failing session snapshot from harness.db, runs Layer 1
 * (deterministic clip) against it, and reports the empirical token
 * shrink. Confirms that the next turn would have fit in budget.
 *
 * Usage (choose exactly one input source):
 *   node scripts/verify-compaction-replay.mjs SESSION_ID
 *   CLEMMY_REPLAY_SESSION_ID=SESSION_ID node scripts/verify-compaction-replay.mjs
 */
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import { clipOldToolResults } from '../dist/runtime/harness/compaction.js';
import { estimateInputTokens } from '../dist/runtime/harness/token-estimator.js';

const cliSessionId = process.argv[2]?.trim() ?? '';
const envSessionId = process.env.CLEMMY_REPLAY_SESSION_ID?.trim() ?? '';
const usage = 'Usage: node scripts/verify-compaction-replay.mjs SESSION_ID\n'
  + '   or: CLEMMY_REPLAY_SESSION_ID=SESSION_ID node scripts/verify-compaction-replay.mjs';
if (process.argv.length > 3 || (cliSessionId && envSessionId)) {
  console.error(`Choose exactly one session-id input source.\n${usage}`);
  process.exit(2);
}
const sessionId = cliSessionId || envSessionId;
if (!/^sess-[a-z0-9][a-z0-9._:-]{2,123}$/i.test(sessionId)) {
  console.error(`A valid Clementine session ID is required.\n${usage}`);
  process.exit(2);
}

const clementineHome = process.env.CLEMENTINE_HOME?.trim()
  || path.join(os.homedir(), '.clementine-next');
const dbPath = path.join(clementineHome, 'state', 'harness.db');
const db = new Database(dbPath, { readonly: true });

const row = db.prepare('SELECT metadata_json FROM sessions WHERE id = ?').get(sessionId);
if (!row) {
  console.error(`session not found: ${sessionId}`);
  process.exit(1);
}

const meta = JSON.parse(row.metadata_json);
const items = (meta.__conversation && Array.isArray(meta.__conversation.items))
  ? meta.__conversation.items
  : [];

console.log(`session: ${sessionId}`);
console.log(`items in snapshot: ${items.length}`);

// Per-type breakdown
const byType = {};
for (const item of items) {
  const t = item.type || (item.role ? `message:${item.role}` : 'unknown');
  byType[t] = (byType[t] ?? 0) + 1;
}
console.log('item breakdown:', byType);

const before = estimateInputTokens(items);
console.log(`estimated input tokens BEFORE compaction: ${before.toLocaleString()}`);

// Clone items so we don't mutate the in-memory snapshot
const clone = JSON.parse(JSON.stringify(items));
const clipped = clipOldToolResults(clone, 8);
const after = estimateInputTokens(clone);

console.log(`\nLayer 1 clipped: ${clipped} tool results`);
console.log(`estimated input tokens AFTER  compaction: ${after.toLocaleString()}`);

const budget = 200_000;
const beforePct = ((before / budget) * 100).toFixed(1);
const afterPct = ((after / budget) * 100).toFixed(1);
console.log(`\nbefore: ${beforePct}% of 200k budget`);
console.log(`after:  ${afterPct}% of 200k budget`);
console.log(`shrink: ${(((before - after) / before) * 100).toFixed(1)}%`);

// Verify call_id pairing survives (Codex 400 risk check)
const callIds = new Set();
for (const item of clone) {
  if (item?.type === 'function_call' && item.callId) callIds.add(item.callId);
}
let unpaired = 0;
for (const id of callIds) {
  const hasResult = clone.some((it) => it?.type === 'function_call_result' && it.callId === id);
  if (!hasResult) unpaired += 1;
}
console.log(`\ncall_id pairing check: ${callIds.size} function_calls, ${unpaired} unpaired`);
if (unpaired === 0) console.log('✓ all call_id pairs preserved — no Codex 400 risk');

const headroom = budget - after;
console.log(`\nheadroom for next turn: ${headroom.toLocaleString()} tokens (${((headroom / budget) * 100).toFixed(1)}%)`);
if (after < budget * 0.7) {
  console.log('✓ post-compaction is well under Layer 2 threshold (70%)');
} else if (after < budget * 0.9) {
  console.log('~ post-compaction is under Layer 3 (90%) but would trip Layer 2 LLM summarization');
} else {
  console.log('✗ post-compaction still over 90% — Layer 3 fork would fire');
}
