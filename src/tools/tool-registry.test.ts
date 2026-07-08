import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

// The orchestrator's curated discoveryTools array lives INSIDE a function (not
// exported), so we transcribe it the same way the registry generator did: slice
// the source between the array head and `.map(byName)`, strip comments (which
// mention other tool names in prose), then collect the quoted string literals.
// This mirrors reality and stays flag-independent (the array is static text; the
// byName resolution / feature gating happens at runtime, not in this list).
function orchestratorDiscoveryNamesFromSource(): Set<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(resolve(here, '../agents/orchestrator.ts'), 'utf8');
  const start = src.indexOf('const discoveryTools: Tool<RuntimeContextValue>[] = (');
  assert.ok(start >= 0, 'could not locate discoveryTools array in orchestrator.ts');
  const end = src.indexOf('.map(byName)', start);
  assert.ok(end > start, 'could not locate .map(byName) after discoveryTools');
  const block = src
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const out = new Set<string>();
  for (const m of block.matchAll(/'([a-z0-9_]+)'/g)) out.add(m[1]);
  return out;
}

// F1 members that are NOT registered as real tools anywhere in the advertise /
// JIT / code-mode surface. propose_plan is referenced only in prompts + the
// blocklist (see workflow-step-agent.ts / loop.ts) — a dead blocklist entry, not
// a registered tool. It is a harmless no-op filter today; documented here so a
// NEW phantom (or an eventual real registration) trips this test.
const KNOWN_UNREGISTERED_BLOCKLIST = new Set<string>(['propose_plan']);

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

test('orchestrator discoveryTools == deriveOrchestratorDiscoveryNames()', () => {
  assertSetEqual(deriveOrchestratorDiscoveryNames(), orchestratorDiscoveryNamesFromSource(), 'orchestrator discovery');
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

test('TOOL_JIT_MANDATED == deriveJitCore()', () => {
  assertSetEqual(deriveJitCore(), asSet(TOOL_JIT_MANDATED), 'jit core / mandated');
});

test('code-mode READ_ONLY_TOOLS/WRITE_TOOLS == deriveCodeModeSets()', () => {
  const { readOnly, write } = deriveCodeModeSets();
  assertSetEqual(readOnly, asSet(READ_ONLY_TOOLS), 'code-mode read-only');
  assertSetEqual(write, asSet(WRITE_TOOLS), 'code-mode write');
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
