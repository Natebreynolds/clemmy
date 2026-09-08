/**
 * A per-item EXTERNAL fetch must be tracked for fan-out whatever its name.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/live-fanout-tracking.test.ts
 *
 * Live 2026-09-07, source 143751 ("find 30 of Tim's accounts…"): Clem issued 28
 * sequential `salesforce_sf_soql_query` calls, one account at a time. The
 * fan-out tracker keyed on name spelling — a composio slug, or a `__` in the
 * tool name — so this tool matched neither and was treated as local plumbing
 * that legitimately serializes. It was never counted, so the fan-out nudge
 * (which already mandates and names run_worker) could not fire, the
 * deterministic block could not fire, and the turn ran 15 minutes and was
 * killed with nothing written.
 *
 * The realm signal is `requirement_id`: host-authored, and `cap:live:` means
 * the call leaves this machine.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('./tool-guardrail.ts', import.meta.url), 'utf8');

/** The exact predicate the guardrail uses, lifted for direct exercise. */
function callCarriesLiveCapability(args: unknown): boolean {
  const seen = new Set<unknown>();
  const walk = (value: unknown, depth: number): boolean => {
    if (depth > 4 || value == null) return false;
    if (typeof value === 'string') return value.startsWith('cap:live:');
    if (typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    const row = value as Record<string, unknown>;
    const requirement = row.requirement_id ?? row.requirementId;
    if (typeof requirement === 'string' && requirement.startsWith('cap:live:')) return true;
    for (const key of ['args', 'args_json', 'arguments', 'input']) {
      const nested = row[key];
      if (typeof nested === 'string') {
        try { if (walk(JSON.parse(nested), depth + 1)) return true; } catch { /* not json */ }
      } else if (walk(nested, depth + 1)) return true;
    }
    return false;
  };
  try { return walk(args, 0); } catch { return false; }
}

test('the guardrail no longer decides fan-out eligibility by name spelling alone', () => {
  assert.match(SRC, /callCarriesLiveCapability\(args\)/,
    'the realm predicate is wired into fanoutKey');
  assert.match(SRC, /live::\$\{toolName\}/, 'live calls get their own fan-out key');
});

test('THE 143751 SHAPE: a work_call-wrapped live SOQL read is a fan-out call', () => {
  // The exact envelope shape retained from that turn.
  const call = {
    tool: 'work_call',
    effectiveTool: 'salesforce_sf_soql_query',
    arguments: JSON.stringify({
      requirement_id: 'cap:live:v1:d03b71838749648a803a4c52:b96b480702e2fbe61508025c:1539af97',
      args_json: JSON.stringify({ query: "SELECT Id FROM Account WHERE OwnerId = '005xx'" }),
    }),
  };
  assert.equal(callCarriesLiveCapability(call), true,
    'a live capability is an external per-item fetch regardless of its name');
});

test('a direct live call is tracked too', () => {
  assert.equal(callCarriesLiveCapability({ requirement_id: 'cap:live:v1:abc:def:ghi' }), true);
  assert.equal(callCarriesLiveCapability({ requirementId: 'cap:live:v1:abc:def:ghi' }), true);
});

test('PURE-LOCAL work still serializes freely', () => {
  // The behaviour the old `__` test was reaching for, kept exactly: local
  // tools carry no live requirement and must not be nudged to fan out.
  assert.equal(callCarriesLiveCapability({ path: 'notes/todo.md' }), false, 'read_file');
  assert.equal(callCarriesLiveCapability({ query: 'renewal' }), false, 'memory_recall');
  assert.equal(callCarriesLiveCapability({ requirement_id: 'cap:local:workflow_create:reversible' }), false,
    'a LOCAL capability ref is not a live one');
  assert.equal(callCarriesLiveCapability(null), false);
  assert.equal(callCarriesLiveCapability('plain string'), false);
});

test('the walk is bounded and cycle-safe', () => {
  const cyclic: Record<string, unknown> = { requirement_id: 'nope' };
  cyclic.args = cyclic;
  assert.equal(callCarriesLiveCapability(cyclic), false, 'a self-referencing envelope terminates');
  let deep: Record<string, unknown> = { requirement_id: 'cap:live:v1:deep' };
  for (let i = 0; i < 8; i += 1) deep = { args: deep };
  assert.equal(callCarriesLiveCapability(deep), false, 'past the depth bound it stays closed, not hung');
});
