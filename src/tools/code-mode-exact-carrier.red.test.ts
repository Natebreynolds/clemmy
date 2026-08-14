/**
 * RED TESTS — exact code-mode result carriers (live 2026-08-11).
 *
 * THE INVARIANT: in code mode, the child tool's authoritative returned result
 * is appended/registered — one complete, PARENTED durable tool_called/
 * tool_returned lifecycle — BEFORE the authority resolver normalizes it for the
 * program. A valid durable JSON child result larger than the model-presentation
 * cap (20,000 chars) but below the durable output cap (16MB) reaches the
 * PROGRAM as the exact parsed object — never a structure digest or clipped
 * string. Model-facing history stays bounded independently: the durable
 * tool_returned preview and the program's model-facing return are capped
 * regardless of how large the program-facing carrier is.
 *
 * Today dispatchCodeModeTool appends the durable tool_returned record AFTER
 * normalizeCodeModeToolResult has already consulted the authority resolver, and
 * neither lifecycle event carries a parent id — so the resolver can never prove
 * the occurrence, the parked exact bytes are unreachable, and the program
 * receives the model-facing digest instead of its data. The same corruption
 * reaches the MCP branch by a different key: the namespace shim parks the exact
 * bytes under its own synthesized call id, which the code-mode normalizer never
 * looks up.
 *
 * Companion (stays green, deliberately untouched):
 * src/runtime/wire-agents-codemode.red.test.ts pins settlement conservation for
 * the same dispatch path — the fix must reorder append-vs-normalize without
 * breaking one-settlement-per-dispatch or durable ok-truthfulness (the latter is
 * re-pinned as a guard in THIS file too).
 *
 * Every test enters real production dispatch code (dispatchCodeModeTool →
 * wrapToolForHarness / MCP shim seam → normalizeCodeModeToolResult →
 * resolveToolOutputForAuthority). Tool/server names are fictional (alpha*).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-codemode-exact-carrier-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-exact-carrier\n', 'utf-8');

const eventlog = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const brackets = await import('../runtime/harness/brackets.js');
const codeMode = await import('./code-mode-tool.js');
const fmt = await import('../runtime/harness/tool-output-format.js');
const toolOutputCtx = await import('../runtime/harness/tool-output-context.js');

test.after(() => {
  try { eventlog.closeEventLog(); } catch { /* the temp home goes away regardless */ }
  rmSync(TMP_HOME, { recursive: true, force: true });
});

// ─── accepted task identity (fixture pattern shared with the settlement pins) ─

interface Task { sessionId: string; sourceUserSeq: number; turn: number }

let taskCounter = 0;
function acceptTask(label: string): Task {
  const session = eventlog.createSession({ id: `exact-carrier-${label}-${++taskCounter}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    // The carrier assertions exercise a successful business read, so the
    // fixture must own the retrieve node that call will settle. "Pull" alone
    // is intentionally ambiguous conversational tool intent and now compiles
    // without a work node.
    data: { text: `${label}: find the current alpha records` },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }), 'fixture precondition: the accepted task has its exact durable graph');
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
}

function runContextFor(task: Task) {
  return {
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    turn: task.turn,
    counter: new brackets.ToolCallsCounter(50),
  };
}

function settlements(task: Task): Array<Record<string, unknown>> {
  return eventlog
    .listEvents(task.sessionId, { types: ['tool_attempt_settled'] })
    .map((event) => event.data as Record<string, unknown>)
    .filter((data) => data?.sourceUserSeq === task.sourceUserSeq);
}

/** The one code-mode lifecycle pair a single dispatch must leave behind. */
function codeModeLifecycle(task: Task): {
  called: { id: string; parentEventId: string | null; data: Record<string, unknown> };
  returned: { id: string; parentEventId: string | null; data: Record<string, unknown> };
  callId: string;
} {
  const events = eventlog
    .listEvents(task.sessionId, { types: ['tool_called', 'tool_returned'] })
    .map((event) => ({
      id: (event as { id: string }).id,
      type: (event as { type: string }).type,
      parentEventId: (event as { parentEventId?: string | null }).parentEventId ?? null,
      data: event.data as Record<string, unknown>,
    }))
    .filter((event) => event.data?.codeMode === true);
  const called = events.filter((event) => event.type === 'tool_called');
  const returned = events.filter((event) => event.type === 'tool_returned');
  assert.equal(called.length, 1, `fixture: one dispatch leaves exactly one code-mode tool_called (saw ${called.length})`);
  assert.equal(returned.length, 1, `fixture: one dispatch leaves exactly one code-mode tool_returned (saw ${returned.length})`);
  return { called: called[0], returned: returned[0], callId: String(called[0].data.callId ?? '') };
}

/** Compact red-friendly view of the value the program received. */
function carrierSummary(normalized: unknown): Record<string, unknown> {
  if (typeof normalized === 'string') {
    return {
      carrier: 'string',
      chars: normalized.length,
      digestReceipt: /exact-output-receipt/.test(normalized),
      head: normalized.slice(0, 120),
    };
  }
  return { carrier: normalized === null ? 'null' : typeof normalized };
}

/**
 * Dispatch one local read through the REAL production path:
 * dispatchCodeModeTool → dispatchCodeModeLocalTool → wrapToolForHarness →
 * the tool formats its result through formatRecallableToolText exactly as
 * production read tools (local-runtime, composio, computer) do — registering
 * the full exact bytes durably and handing the wrapper the model-facing text.
 */
async function dispatchLocalRead(task: Task, payload: string): Promise<unknown> {
  codeMode._setCodeModeToolsForTests(new Map([['read_file', {
    name: 'read_file',
    invoke: async () => fmt.formatRecallableToolText(payload),
  }]]) as never);
  try {
    return await brackets.withHarnessRunContext(
      runContextFor(task),
      () => codeMode.dispatchCodeModeTool('read_file', { path: 'alpha.txt' }, task.sessionId),
    );
  } finally {
    codeMode._setCodeModeToolsForTests(null);
  }
}

// ~28KB of valid JSON: above the 20,000-char presentation cap, far below the
// 16MB durable cap. Provider-shaped (successful/data envelope) but every
// assertion below is structural, not provider-conditional.
const BIG_RECORDS = Array.from({ length: 600 }, (_, i) => ({
  id: `rec_${i}`,
  name: `Alpha Firm ${i}`,
  value: i,
}));
const BIG_JSON = JSON.stringify({ successful: true, data: { records: BIG_RECORDS } });

// ─── 1. the invariant itself: the program gets the exact parsed object ───────

test('code mode: a durable JSON child result above the presentation cap reaches the program as the exact parsed object', async () => {
  assert.ok(
    BIG_JSON.length > 20_000 && Buffer.byteLength(BIG_JSON, 'utf8') < eventlog.TOOL_OUTPUT_MAX_BYTES,
    `fixture: the payload must sit between the presentation cap and the durable cap (chars=${BIG_JSON.length})`,
  );
  const task = acceptTask('exact-object');
  const normalized = await dispatchLocalRead(task, BIG_JSON);
  // isDeepStrictEqual carries the target comparison; the asserted object stays
  // small so the failure diff (and the runner's IPC) stays bounded.
  assert.deepEqual(
    { exactParsedObject: isDeepStrictEqual(normalized, JSON.parse(BIG_JSON)), ...carrierSummary(normalized) },
    { exactParsedObject: true, carrier: 'object' },
    'the child call returned valid JSON and its exact bytes are already parked durably under this '
    + 'call id — the PROGRAM must receive that exact parsed object. Handing it the model-facing '
    + 'structure digest corrupts every downstream computation the program was written to do.',
  );
});

// ─── 2. the mechanism: registered + parented BEFORE the resolver normalizes ──

test('code mode: the durable return record is parented and authority-resolved ok for the value the program consumed', async () => {
  const task = acceptTask('parented-authority');
  await dispatchLocalRead(task, BIG_JSON);
  const { called, returned, callId } = codeModeLifecycle(task);
  assert.ok(callId.length > 0, 'fixture: the code-mode lifecycle carries its call id');
  const resolution = eventlog.resolveToolOutputForAuthority(task.sessionId, callId);
  assert.deepEqual(
    {
      resolutionStatus: resolution.status,
      resolutionReason: (resolution as { reason?: string }).reason ?? null,
      returnParentedToCall: returned.parentEventId === called.id,
    },
    {
      resolutionStatus: 'ok',
      resolutionReason: null,
      returnParentedToCall: true,
    },
    'the authoritative child result must be registered as one complete PARENTED durable '
    + 'tool_called/tool_returned occurrence BEFORE the authority resolver normalizes it — '
    + 'an unparented return appended after normalization can never prove the occurrence, so '
    + 'the parked exact bytes stay unreachable for the program forever.\n'
    + `tool_returned.parentEventId=${JSON.stringify(returned.parentEventId)} tool_called.id=${JSON.stringify(called.id)}`,
  );
});

// ─── 3. durable-cap fail-closed through the PRODUCTION path ──────────────────

test('code mode: a child result above the durable cap fails closed as a typed truncated_tool_output refusal, never a clipped string', async () => {
  // Sized FROM the cap ('a,1\n' = 4 bytes/row) so the fixture keeps crossing
  // the durable ceiling at any cap value.
  const cap = eventlog.TOOL_OUTPUT_MAX_BYTES;
  const huge = `group,value\n${'a,1\n'.repeat(Math.ceil(cap / 4) + 50_000)}`;
  assert.ok(Buffer.byteLength(huge, 'utf8') > cap, 'fixture: the payload must cross the durable output cap');
  const task = acceptTask('durable-cap');
  const normalized = await dispatchLocalRead(task, huge);
  const { callId } = codeModeLifecycle(task);
  const refusal = normalized as {
    ok?: unknown; error_kind?: unknown; truncated_at_write?: unknown; result_handle?: unknown;
  } | string | null;
  const observed = typeof refusal === 'string' || refusal === null
    ? carrierSummary(refusal)
    : {
        carrier: 'refusal',
        ok: refusal.ok,
        error_kind: refusal.error_kind,
        truncated_at_write: refusal.truncated_at_write,
        result_handle: refusal.result_handle,
      };
  assert.deepEqual(
    observed,
    {
      carrier: 'refusal',
      ok: false,
      error_kind: 'truncated_tool_output',
      truncated_at_write: true,
      result_handle: callId,
    },
    'a result whose durable registration is incomplete (truncated at write) must reach the '
    + 'program as the typed truncated_tool_output refusal so it can re-page — never as a '
    + 'silently clipped/digested string it would mistake for the data. Today the fail-closed '
    + 'branch is unreachable through production dispatch because the resolver never reports ok.',
  );
});

// ─── 4. the MCP branch: shim-parked exact bytes reach the program ────────────

test('code mode: a large MCP child result parked by the namespace shim reaches the program as the exact parsed object', async () => {
  const task = acceptTask('mcp-exact');
  let parkedUnderCallId = '';
  codeMode._setCodeModeMcpResolverForTests(() => ({
    callTool: async (name: string) => {
      // Mirrors the production namespace shim's recall clipping: the full text
      // is parked through formatRecallableToolText and the model-facing digest
      // is returned. Today no code-mode identity is threaded into the MCP
      // dispatch, so the shim synthesizes its OWN `mcp_<tool>_<seq>` call id;
      // this fake prefers an ambient tool-output context when dispatch supplies
      // one, so the pin settles green under an identity-threading fix without
      // edits here.
      const ambient = toolOutputCtx.getToolOutputContext();
      const sessionId = ambient?.sessionId ?? task.sessionId;
      const callId = ambient?.callId ?? `mcp_${name}_1`;
      parkedUnderCallId = callId;
      return fmt.formatRecallableToolText(BIG_JSON, { sessionId, callId, toolName: name });
    },
  }));
  try {
    const normalized = await brackets.withHarnessRunContext(
      runContextFor(task),
      () => codeMode.dispatchCodeModeTool('alphaserver__list_records', { q: 'alpha' }, task.sessionId),
    );
    assert.deepEqual(
      { exactParsedObject: isDeepStrictEqual(normalized, JSON.parse(BIG_JSON)), ...carrierSummary(normalized) },
      { exactParsedObject: true, carrier: 'object' },
      'an MCP child call whose exact bytes were parked durably must hand the PROGRAM the exact '
      + 'parsed object, same as the local lane. Today the shim parks under its own synthesized '
      + 'call id while the normalizer resolves the code-mode call id, so the parked bytes are '
      + 'never found and the program receives the digest.\n'
      + `exact bytes were parked under callId: ${JSON.stringify(parkedUnderCallId)}`,
    );
  } finally {
    codeMode._setCodeModeMcpResolverForTests(null);
  }
});

// ─── guards: already-true behavior the fix must not break ────────────────────

test('guard: one large code-mode dispatch leaves exactly one exact durable payload, one settlement, and a bounded return preview', async () => {
  const task = acceptTask('carrier-conservation');
  await dispatchLocalRead(task, BIG_JSON);
  const { returned, callId } = codeModeLifecycle(task);
  const invocations = eventlog.listToolOutputInvocations(task.sessionId, callId);
  assert.equal(
    invocations.length,
    1,
    'exactly ONE durable payload reference exists for the call — widening the program-facing '
    + 'carrier must not duplicate the registered bytes',
  );
  assert.equal(
    invocations[0].output,
    BIG_JSON,
    'the durable payload holds the EXACT child bytes — delivery, not storage, is what the fix changes',
  );
  assert.equal(invocations[0].contentBytes, Buffer.byteLength(BIG_JSON, 'utf8'));
  assert.equal(invocations[0].truncatedAtWrite, false);
  assert.equal(
    settlements(task).length,
    1,
    'one physical dispatch settles exactly once (conservation also pinned in wire-agents-codemode.red.test.ts)',
  );
  const preview = String(returned.data.preview ?? '');
  assert.ok(
    preview.length <= 400,
    `model-facing history stays bounded: the durable tool_returned preview must stay <=400 chars (saw ${preview.length})`,
  );
});

test('guard: the model-facing program return stays bounded when a child call carries a large result', async () => {
  // Through the REAL program runtime (sandbox child + dispatchCodeModeTool):
  // runCodeModeForSession's result.value is byte-for-byte what
  // buildCodeModeTool.execute embeds in the model-facing return. The exact
  // carrier belongs to the PROGRAM; an oversized program RETURN is parked and
  // the model gets a handle — that bound must survive the exact-carrier fix.
  const task = acceptTask('model-bound');
  codeMode._setCodeModeToolsForTests(new Map([['read_file', {
    name: 'read_file',
    invoke: async () => fmt.formatRecallableToolText(BIG_JSON),
  }]]) as never);
  try {
    const result = await brackets.withHarnessRunContext(
      runContextFor(task),
      () => codeMode.runCodeModeForSession('return await clem.read_file({ path: "alpha.txt" });', task.sessionId),
    );
    assert.equal(result.ok, true, `fixture: the program must complete (error: ${result.error ?? 'none'})`);
    const modelFacing = JSON.stringify(result.value ?? null);
    assert.ok(
      modelFacing.length <= 20_000,
      'the model-facing serialization of the program result must stay within the presentation cap '
      + `— exact bytes widen only the PROGRAM-facing carrier (saw ${modelFacing.length} chars)`,
    );
  } finally {
    codeMode._setCodeModeToolsForTests(null);
  }
});

test('guard: a resolved child failure stays recorded as ok:false in the durable trace', async () => {
  // Durable ok-truthfulness: today ok is computed FROM the normalized value
  // after the fact; the reordering fix (register/parent BEFORE normalize) must
  // keep the durable trace agreeing with the value the program received.
  const task = acceptTask('ok-truthful');
  const normalized = await dispatchLocalRead(task, '⚠️ FAILED alpha_records_list: upstream refused');
  const { returned } = codeModeLifecycle(task);
  assert.equal(
    (normalized as { ok?: unknown } | null)?.ok,
    false,
    'the program receives the structured failure for an upstream tool-error banner',
  );
  assert.equal(
    returned.data.ok,
    false,
    'the durable tool_returned record agrees: a resolved failure is ok:false, not a successful call',
  );
});
