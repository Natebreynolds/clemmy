import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TOOL_REGISTRY,
  deriveCatalogNames,
  deriveOrchestratorDiscoveryNames,
  deriveSdkProfile,
  deriveJitCore,
  deriveCodeModeSets,
  deriveWorkspaceDockNames,
  deriveWorkflowStepBlocked,
  deriveWorkerBlocked,
  deriveNeedsApproval,
  deriveGuardrailIdempotent,
  deriveGuardrailMutating,
  deriveGuardrailCacheSafeReads,
  deriveGuardrailReadMutators,
} from './tool-registry.js';

import { LOCAL_MCP_TOOL_NAMES } from './catalog.js';
import { READ_ONLY_TOOLS, WRITE_TOOLS } from './code-mode-tool.js';
import { TOOL_JIT_MANDATED } from '../agents/tool-jit.js';
import { WORKFLOW_STEP_BLOCKED_TOOL_NAMES } from '../agents/workflow-step-agent.js';
import { WORKSPACE_DOCK_TOOLS } from '../spaces/workspace-context.js';
import {
  CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS,
  CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS,
  CLAUDE_AGENT_SDK_FULL_TOOLS,
  CLAUDE_AGENT_SDK_WORKER_TOOLS,
} from '../runtime/harness/claude-agent-sdk.js';
import { classifyTool } from '../agents/tool-taxonomy.js';
import {
  IDEMPOTENT_TOOLS,
  MUTATING_TOOLS,
  CACHE_SAFE_READS,
  READ_MUTATORS,
} from '../runtime/harness/tool-guardrail.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function asSet(names: Iterable<string>): Set<string> {
  return names instanceof Set ? names : new Set(names);
}

/** Set-equality assertion with a readable, direction-labelled diff. */
function assertSetEqual(actual: Set<string>, expected: Set<string>, label: string): void {
  const missingFromRegistry = [...expected].filter((n) => !actual.has(n)).sort();
  const missingFromList = [...actual].filter((n) => !expected.has(n)).sort();
  if (missingFromRegistry.length === 0 && missingFromList.length === 0) return;
  const lines = [`${label}: registry derivation != hand-maintained list`];
  if (missingFromRegistry.length) {
    lines.push(`  in the LIST but MISSING from the registry derivation (add/tag in tool-registry.ts): ${missingFromRegistry.join(', ')}`);
  }
  if (missingFromList.length) {
    lines.push(`  in the registry derivation but MISSING from the LIST (registry over-claims): ${missingFromList.join(', ')}`);
  }
  assert.fail(lines.join('\n'));
}

// F1 members that are NOT registered as real tools anywhere in the advertise /
// JIT / code-mode surface. propose_plan is referenced only in prompts + the
// blocklist (see workflow-step-agent.ts / loop.ts) — a dead blocklist entry, not
// a registered tool. It is a harmless no-op filter today; documented here so a
// NEW phantom (or an eventual real registration) trips this test.
const KNOWN_UNREGISTERED_BLOCKLIST = new Set<string>(['propose_plan']);

// B1 guardrail (tool-guardrail.ts) names that are NOT in TOOL_REGISTRY, so the
// guardrail sets union them on top of the registry derivation. Two kinds:
//   - focus_list / focus_inspect: REAL focus-tools reads (focus-tools.ts,
//     registered via local-runtime-tools) reachable on the default-include
//     worker/workflow-step lanes, but on NO advertise surface — outside the
//     registry's membership scope by design (do not expand the registry ahead of
//     a consumer flip). They stay idempotent.
//   - replace_file: a genuine DEAD entry (no such tool is registered anywhere);
//     kept in MUTATING_TOOLS (+ as a READ_MUTATORS value) for byte-identity.
// Documented here so a NEW out-of-registry member (or an eventual real
// registration that should move INTO the registry) trips the invariant test below.
const KNOWN_UNREGISTERED_GUARDRAIL = new Set<string>(['focus_list', 'focus_inspect', 'replace_file']);

/** Record<string, Set> equality with a readable diff (for READ_MUTATORS). */
function assertReadMutatorsEqual(
  actual: Record<string, Set<string>>,
  expected: Record<string, ReadonlySet<string>>,
): void {
  assertSetEqual(new Set(Object.keys(actual)), new Set(Object.keys(expected)), 'READ_MUTATORS keys');
  for (const k of Object.keys(expected)) {
    assertSetEqual(asSet(actual[k] ?? new Set()), asSet(expected[k]), `READ_MUTATORS[${k}] mutators`);
  }
}

// ── conformance ───────────────────────────────────────────────────────────────
//
// The catalog surface (LOCAL_MCP_TOOL_NAMES) and the four SDK profiles are now
// DERIVED from the registry (step 2 slice 1): each exported constant IS
// deriveCatalogNames()/deriveSdkProfile(...). A set-equality check against the
// derivation would be a tautology, so those flipped surfaces get INVARIANT tests
// instead — the live exported surface must contain its known-critical members (a
// registry edit that drops one fails here) and honor the nesting/exclusion rules.
// The hand-maintained lists further down keep full set-equality conformance.

test('catalog surface contains its known-critical members', () => {
  const catalog = asSet(LOCAL_MCP_TOOL_NAMES);
  for (const n of ['memory_recall', 'memory_remember', 'run_batch', 'workflow_create', 'pending_action_queue', 'tool_search', 'composio_execute_tool', 'notify_user', 'browser_harness_run', 'goal_create']) {
    assert.ok(catalog.has(n), `catalog (LOCAL_MCP_TOOL_NAMES) must include ${n}`);
  }
});

test('orchestrator discovery surface: critical members present, non-orchestrator tools absent', () => {
  // orchestrator.ts discoveryTools is now DERIVED from the registry (step 2):
  // `[...deriveOrchestratorDiscoveryNames()].map(byName)`. A set-equality check
  // against the derivation would be a tautology, so this is an INVARIANT test
  // (catalog precedent). Members below are tools whose ABSENCE from this curated
  // surface each caused a logged live incident (see the git history / registry).
  const surface = deriveOrchestratorDiscoveryNames();
  for (const n of [
    'composio_execute_tool', 'memory_forget', 'memory_pin', 'space_save', 'workflow_create',
    'workflow_from_session', 'goal_create', 'run_batch', 'run_tool_program', 'recall_tool_result',
    'tool_output_query', 'focus_get', 'browser_harness_run', 'pending_action_queue', 'tool_search',
  ]) {
    assert.ok(surface.has(n), `orchestrator discovery surface must include ${n}`);
  }
  // Tools whose registry lanes do NOT include 'orchestrator' must stay off it:
  // brain-only fan-out/publish, SDK-only health, and CLI-only jobs.
  for (const n of ['run_worker', 'space_publish', 'ping', 'add_cron_job', 'memory_search_facts']) {
    assert.ok(!surface.has(n), `orchestrator discovery surface must NOT include ${n}`);
  }
});

test('SDK read-only profile: critical reads present, write/execution primitives absent', () => {
  const ro = asSet(CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS);
  for (const n of ['memory_recall', 'read_file', 'ask_user_question', 'tool_search', 'recall_tool_result', 'skill_read']) {
    assert.ok(ro.has(n), `read-only must include ${n}`);
  }
  for (const n of ['write_file', 'run_shell_command', 'run_worker', 'composio_execute_tool']) {
    assert.ok(!ro.has(n), `read-only must NOT include the write/execution tool ${n}`);
  }
});

test('SDK local-authoring ⊇ read-only + its authoring members', () => {
  const ro = asSet(CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS);
  const auth = asSet(CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS);
  for (const n of ro) assert.ok(auth.has(n), `authoring must be a superset of read-only (missing ${n})`);
  for (const n of ['workflow_create', 'goal_create', 'space_save', 'pending_action_queue', 'set_model_role']) {
    assert.ok(auth.has(n), `authoring must include ${n}`);
  }
});

test('SDK full (brain) ⊇ authoring + execution + brain-only fan-out', () => {
  const auth = asSet(CLAUDE_AGENT_SDK_LOCAL_AUTHORING_TOOLS);
  const full = asSet(CLAUDE_AGENT_SDK_FULL_TOOLS);
  for (const n of auth) assert.ok(full.has(n), `full must be a superset of authoring (missing ${n})`);
  for (const n of ['run_worker', 'run_batch', 'write_file', 'run_shell_command', 'composio_execute_tool', 'execution_create', 'notify_user']) {
    assert.ok(full.has(n), `full must include ${n}`);
  }
});

test('SDK worker == read-only ∪ agentic; brain-only fan-out excluded', () => {
  const ro = asSet(CLAUDE_AGENT_SDK_READ_ONLY_LOCAL_TOOLS);
  const worker = asSet(CLAUDE_AGENT_SDK_WORKER_TOOLS);
  const agentic = deriveSdkProfile('agentic');
  // The defining nesting relationship (not a hardcoded list → not brittle).
  assertSetEqual(worker, new Set([...ro, ...agentic]), 'worker == read-only ∪ agentic');
  for (const n of ['composio_execute_tool', 'write_file', 'notify_user', 'memory_recall']) {
    assert.ok(worker.has(n), `worker must include ${n}`);
  }
  // A worker must NEVER get the fan-out/batch/execution primitives (no worker-spawns-worker).
  for (const n of ['run_worker', 'run_batch', 'execution_create']) {
    assert.ok(!worker.has(n), `worker must NOT include the brain-only primitive ${n}`);
  }
});

test('SDK agentic bundle contains the shared execution tools', () => {
  const agentic = deriveSdkProfile('agentic');
  for (const n of ['run_shell_command', 'write_file', 'composio_execute_tool', 'composio_search_tools', 'local_cli_probe', 'notify_user']) {
    assert.ok(agentic.has(n), `agentic bundle must include ${n}`);
  }
});

test('JIT core surface: mandated members present, JIT-able tools absent', () => {
  // TOOL_JIT_MANDATED is now DERIVED from the registry (step 2): it IS deriveJitCore().
  // A set-equality check would be a tautology, so this is an INVARIANT test — the
  // always-loaded CORE must keep the tools whose JIT-pruning caused a live incident,
  // and must NOT swallow the intent-evident JIT-able tools (which retrieval brings back).
  const core = asSet(TOOL_JIT_MANDATED);
  for (const n of ['focus_get', 'memory_recall', 'composio_search_tools', 'composio_execute_tool', 'run_batch', 'run_worker', 'tool_search', 'notify_user', 'browser_harness_run', 'goal_create']) {
    assert.ok(core.has(n), `JIT core must include mandated ${n}`);
  }
  // These are intent-evident / discoverable — they must stay JIT-able, not core.
  for (const n of ['workflow_run', 'space_save', 'delegate_task', 'convert_to_markdown', 'add_cron_job']) {
    assert.ok(!core.has(n), `JIT core must NOT include the JIT-able tool ${n}`);
  }
});

test('code-mode sets: INVARIANT members after the derive flip (equality is now tautological)', () => {
  // READ_ONLY_TOOLS/WRITE_TOOLS derive from the registry since the step-2
  // flip, so set-equality proves nothing. Pin the incident-critical members
  // and the safety exclusions instead (same conversion as the catalog /
  // discovery / JIT flips).
  const { readOnly, write } = deriveCodeModeSets();
  assertSetEqual(readOnly, asSet(READ_ONLY_TOOLS), 'exported set mirrors the derivation');
  assertSetEqual(write, asSet(WRITE_TOOLS), 'exported set mirrors the derivation');
  for (const n of ['memory_recall', 'read_file', 'list_files', 'recall_tool_result', 'tool_output_query', 'skill_read', 'composio_search_tools']) {
    assert.ok(readOnly.has(n), `code-mode read surface must keep ${n}`);
  }
  for (const n of ['composio_execute_tool', 'write_file', 'run_shell_command']) {
    assert.ok(write.has(n), `code-mode write surface must keep ${n}`);
  }
  // Safety exclusions: never reachable from a program, in either set.
  for (const n of ['run_worker', 'run_batch', 'run_tool_program', 'add_cron_job', 'workflow_create']) {
    assert.ok(!readOnly.has(n) && !write.has(n), `${n} must never be callable from inside a code-mode program`);
  }
});

test('WORKSPACE_DOCK_TOOLS == deriveWorkspaceDockNames()', () => {
  assertSetEqual(deriveWorkspaceDockNames(), asSet(WORKSPACE_DOCK_TOOLS), 'spaces-dock feature group');
});

test('WORKFLOW_STEP_BLOCKED_TOOL_NAMES == deriveWorkflowStepBlocked() (minus known phantoms)', () => {
  const expected = new Set([...WORKFLOW_STEP_BLOCKED_TOOL_NAMES].filter((n) => !KNOWN_UNREGISTERED_BLOCKLIST.has(n)));
  assertSetEqual(deriveWorkflowStepBlocked(), expected, 'F1 workflow-step blocked');
});

test('workerBlockedToolNames (F1 ∪ {notify_user}) == deriveWorkerBlocked() (minus known phantoms)', () => {
  // sub-agents.ts defines workerBlockedToolNames = WORKFLOW_STEP_BLOCKED ∪ {notify_user}.
  const f2 = new Set<string>([...WORKFLOW_STEP_BLOCKED_TOOL_NAMES, 'notify_user']);
  const expected = new Set([...f2].filter((n) => !KNOWN_UNREGISTERED_BLOCKLIST.has(n)));
  assertSetEqual(deriveWorkerBlocked(), expected, 'F2 worker blocked');
});

test('B1 IDEMPOTENT_TOOLS == deriveGuardrailIdempotent() (minus known phantoms)', () => {
  const expected = new Set([...IDEMPOTENT_TOOLS].filter((n) => !KNOWN_UNREGISTERED_GUARDRAIL.has(n)));
  assertSetEqual(deriveGuardrailIdempotent(), expected, 'B1 idempotent');
});

test('B1 MUTATING_TOOLS == deriveGuardrailMutating() (minus known phantoms)', () => {
  const expected = new Set([...MUTATING_TOOLS].filter((n) => !KNOWN_UNREGISTERED_GUARDRAIL.has(n)));
  assertSetEqual(deriveGuardrailMutating(), expected, 'B1 mutating');
});

test('B1 CACHE_SAFE_READS == deriveGuardrailCacheSafeReads()', () => {
  // No phantoms in this set — every cache-safe read is a registered tool.
  assertSetEqual(deriveGuardrailCacheSafeReads(), asSet(CACHE_SAFE_READS), 'B1 cache-safe reads');
});

test('B1 CACHE_SAFE_READS ⊆ IDEMPOTENT_TOOLS (cache-safe is a narrower allowlist)', () => {
  for (const n of CACHE_SAFE_READS) assert.ok(IDEMPOTENT_TOOLS.has(n), `cache-safe read ${n} must also be idempotent`);
});

test('B1 READ_MUTATORS == deriveGuardrailReadMutators() (keys + per-read mutators, verbatim)', () => {
  // Values are compared verbatim — including the phantom mutator replace_file,
  // which readMutatedBy stores exactly as the hand list does (documented drift).
  assertReadMutatorsEqual(deriveGuardrailReadMutators(), READ_MUTATORS);
});

test('B1 guardrail sets: INVARIANT members after the derive flip (the runaway-write gap stays closed)', () => {
  // The guardrail exports now derive from the registry, so the equality tests
  // above are wiring mirrors. Pin the incident-critical classifications: a
  // send/notify repeat MUST stay tight-thresholded, and hot reads stay loose.
  for (const n of ['composio_execute_tool', 'write_file', 'run_shell_command', 'notify_user', 'ask_user_question', 'workflow_run']) {
    assert.ok(MUTATING_TOOLS.has(n), `${n} must classify as mutating (tight loop thresholds)`);
  }
  for (const n of ['read_file', 'list_files', 'memory_recall', 'focus_get', 'recall_tool_result']) {
    assert.ok(IDEMPOTENT_TOOLS.has(n), `${n} must classify as idempotent (loose loop thresholds)`);
  }
  assert.ok(CACHE_SAFE_READS.has('read_file') && !CACHE_SAFE_READS.has('git_status'), 'cache-safe stays narrower than idempotent (git_status is volatile)');
});

// ── invariants that guard the transcription itself ────────────────────────────

test('every registry name is unique', () => {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const d of TOOL_REGISTRY) {
    if (seen.has(d.name)) dupes.push(d.name);
    seen.add(d.name);
  }
  assert.deepEqual(dupes, [], `duplicate registry entries: ${dupes.join(', ')}`);
});

test('KNOWN_UNREGISTERED_BLOCKLIST is exactly the F1 names absent from the registry', () => {
  const registryNames = new Set(TOOL_REGISTRY.map((d) => d.name));
  const absent = new Set([...WORKFLOW_STEP_BLOCKED_TOOL_NAMES].filter((n) => !registryNames.has(n)));
  assertSetEqual(absent, KNOWN_UNREGISTERED_BLOCKLIST, 'unregistered F1 blocklist entries (phantoms)');
});

test('KNOWN_UNREGISTERED_GUARDRAIL is exactly the B1 names absent from the registry', () => {
  const registryNames = new Set(TOOL_REGISTRY.map((d) => d.name));
  // Every name the guardrail classifies: the three membership sets + the reads
  // keyed in READ_MUTATORS. (READ_MUTATORS *values* are mutator references, not
  // classified entries; the phantom value replace_file is already covered as a
  // MUTATING member.)
  const classified = new Set<string>([
    ...IDEMPOTENT_TOOLS,
    ...MUTATING_TOOLS,
    ...CACHE_SAFE_READS,
    ...Object.keys(READ_MUTATORS),
  ]);
  const absent = new Set([...classified].filter((n) => !registryNames.has(n)));
  assertSetEqual(absent, KNOWN_UNREGISTERED_GUARDRAIL, 'unregistered B1 guardrail entries (phantoms)');
});

test('sideEffect mirrors classifyTool (execute folded into write)', () => {
  const mismatches: string[] = [];
  for (const d of TOOL_REGISTRY) {
    const raw = classifyTool(d.name);
    const expected = raw === 'execute' ? 'write' : raw;
    if (d.sideEffect !== expected) mismatches.push(`${d.name}: registry=${d.sideEffect} taxonomy=${expected}`);
  }
  assert.deepEqual(mismatches, [], `sideEffect drift vs classifyTool:\n  ${mismatches.join('\n  ')}`);
});

test('deriveNeedsApproval defaults non-reads to ask (risk #2)', () => {
  for (const d of TOOL_REGISTRY) {
    if (d.needsApproval != null) continue;
    assert.equal(deriveNeedsApproval(d), d.sideEffect !== 'read', `${d.name} approval default`);
  }
});
