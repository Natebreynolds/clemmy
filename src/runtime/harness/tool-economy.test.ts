import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolEconomyState,
  evaluateToolEconomy,
  interactiveToolEconomyEnabled,
  interactiveToolEconomyPolicy,
  isFinishPhaseTool,
} from './tool-economy.js';

test('interactive economy is default-on with an emergency kill switch', () => {
  const prior = process.env.CLEMMY_INTERACTIVE_TOOL_ECONOMY;
  delete process.env.CLEMMY_INTERACTIVE_TOOL_ECONOMY;
  assert.equal(interactiveToolEconomyEnabled(), true);
  process.env.CLEMMY_INTERACTIVE_TOOL_ECONOMY = 'off';
  assert.equal(interactiveToolEconomyEnabled(), false);
  if (prior === undefined) delete process.env.CLEMMY_INTERACTIVE_TOOL_ECONOMY;
  else process.env.CLEMMY_INTERACTIVE_TOOL_ECONOMY = prior;
});

test('single-deliverable policy turns the 135-call incident into a 15-call maximum', () => {
  const policy = interactiveToolEconomyPolicy({
    message: 'Pull some research and create a Google Doc about this firm.',
  });
  assert.deepEqual(policy, { kind: 'single_deliverable', softLimit: 10, hardLimit: 15 });
  const state = createToolEconomyState(policy);
  let terminalAt = 0;
  for (let i = 1; i <= 135; i += 1) {
    const verdict = evaluateToolEconomy({
      state,
      toolName: 'mcp__dataforseo__DATAFORSEO_SERP_GOOGLE_ORGANIC_LIVE_ADVANCED',
      args: { keyword: `firm evidence ${i}` },
      callId: `toolu_${i}`,
    });
    if (verdict?.interrupt) { terminalAt = i; break; }
  }
  assert.ok(terminalAt > 0 && terminalAt <= 13, `exploratory grind stopped at ${terminalAt}`);
  assert.ok(state.attempts < 15);
});

test('finish phase preserves batching, deliverable writes, render work, and exact read-back', () => {
  const allowed = [
    ['mcp__clementine-local__run_tool_program', { code: 'await Promise.all(items.map(read))' }],
    ['mcp__clementine-local__write_file', { path: '/tmp/report.md', content: 'done' }],
    ['mcp__googledocs__create_document', { title: 'Firm' }],
    ['mcp__googledocs__get_document', { document_id: 'doc_123' }],
    ['mcp__clementine-local__composio_execute_tool', {
      tool_slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
      arguments: JSON.stringify({ document_id: 'doc_123' }),
    }],
    ['mcp__clementine-local__run_shell_command', { command: 'npm run render' }],
    ['mcp__clementine-local__call_tool', {
      name: 'run_shell_command',
      args_json: JSON.stringify({ command: 'node /tmp/proof/open-tasks.mjs' }),
    }],
    ['mcp__clementine-local__call_tool', {
      name: 'space_save',
      args_json: JSON.stringify({ slug: 'proof-cockpit', title: 'Proof Cockpit' }),
    }],
    ['mcp__clementine-local__call_tool', {
      name: 'space_refresh',
      args_json: JSON.stringify({ slug: 'proof-cockpit' }),
    }],
    ['mcp__clementine-local__offer_background', { objective: 'finish research' }],
  ] as const;
  for (const [toolName, args] of allowed) assert.equal(isFinishPhaseTool(toolName, args), true, toolName);
  assert.equal(isFinishPhaseTool(
    'mcp__dataforseo__DATAFORSEO_SERP_GOOGLE_ORGANIC_LIVE_ADVANCED',
    { keyword: 'one more thing' },
  ), false, 'an exact production DataForSEO research action is exploration');
  assert.equal(isFinishPhaseTool('mcp__clementine-local__read_file', { path: '/tmp/new-source' }), false);
  assert.equal(isFinishPhaseTool('mcp__googledocs__get_document', {}), false, 'read-back needs an exact id');
  assert.equal(isFinishPhaseTool('mcp__googledocs__get_documents_list', { page_size: 50 }), false, 'list is exploration');
  assert.equal(isFinishPhaseTool('mcp__clementine-local__run_worker', { objective: 'research more' }), false, 'new exploratory helpers are not a finish action');
});

test('workspace builds get bounded artifact headroom instead of the generic interactive rail', () => {
  assert.deepEqual(
    interactiveToolEconomyPolicy({
      message: 'Build me a workspace called Proof Cockpit with a local task runner.',
    }),
    { kind: 'artifact_build', softLimit: 16, hardLimit: 24 },
  );
  assert.deepEqual(
    interactiveToolEconomyPolicy({
      message: 'Let’s brainstorm how we might build a workspace for this someday.',
    }),
    { kind: 'interactive', softLimit: 12, hardLimit: 20 },
    'artifact vocabulary plus a hypothetical build must remain exploration',
  );
  assert.deepEqual(
    interactiveToolEconomyPolicy({
      message: 'Build it now.',
      priorMessages: ['Let’s brainstorm a social media command-center workspace.'],
    }),
    { kind: 'artifact_build', softLimit: 16, hardLimit: 24 },
    'an explicit execution follow-up inherits artifact shape without inheriting the old hypothetical stance',
  );
});

test('goal-advancing artifact execution clears stale finish refusals and has a bounded hard-limit reserve', () => {
  const state = createToolEconomyState({
    kind: 'artifact_build',
    softLimit: 1,
    hardLimit: 4,
  });
  assert.equal(evaluateToolEconomy({
    state,
    toolName: 'mcp__clementine-local__read_file',
    args: { path: '/tmp/source-a' },
    callId: 'read-a',
  }), null);
  assert.equal(evaluateToolEconomy({
    state,
    toolName: 'mcp__clementine-local__read_file',
    args: { path: '/tmp/source-b' },
    callId: 'read-b',
  })?.kind, 'finish_phase');
  assert.equal(evaluateToolEconomy({
    state,
    toolName: 'mcp__clementine-local__tool_search',
    args: { query: 'one more schema' },
    callId: 'search',
  })?.kind, 'finish_phase');
  assert.equal(state.softRefusals, 2);

  assert.equal(evaluateToolEconomy({
    state,
    toolName: 'mcp__clementine-local__call_tool',
    args: {
      name: 'run_shell_command',
      args_json: JSON.stringify({ command: 'cat > /tmp/open-tasks.mjs <<EOF\nconsole.log([])\nEOF' }),
    },
    callId: 'author-runner',
  }), null);
  assert.equal(state.softRefusals, 0, 'real execution progress resets stale exploration refusals');

  assert.equal(evaluateToolEconomy({
    state,
    toolName: 'mcp__clementine-local__call_tool',
    args: {
      name: 'space_save',
      args_json: JSON.stringify({ slug: 'proof-cockpit', title: 'Proof Cockpit' }),
    },
    callId: 'save-space',
  }), null, 'the requested terminal artifact write may consume the bounded completion reserve');
  assert.equal(evaluateToolEconomy({
    state,
    toolName: 'mcp__clementine-local__call_tool',
    args: {
      name: 'space_refresh',
      args_json: JSON.stringify({ slug: 'proof-cockpit' }),
    },
    callId: 'refresh-space',
  }), null, 'exact artifact refresh remains goal-advancing');

  for (let i = 0; i < 4; i += 1) {
    evaluateToolEconomy({
      state,
      toolName: 'mcp__clementine-local__call_tool',
      args: {
        name: 'space_refresh',
        args_json: JSON.stringify({ slug: `proof-cockpit-${i}` }),
      },
      callId: `extra-${i}`,
    });
  }
  const exhausted = evaluateToolEconomy({
    state,
    toolName: 'mcp__clementine-local__call_tool',
    args: {
      name: 'space_refresh',
      args_json: JSON.stringify({ slug: 'one-too-many' }),
    },
    callId: 'reserve-exhausted',
  });
  assert.equal(exhausted?.kind, 'hard_stop');
  assert.equal(exhausted?.interrupt, true, 'artifact headroom is a reserve, not an unbounded bypass');

  const sendState = createToolEconomyState({
    kind: 'artifact_build',
    softLimit: 1,
    hardLimit: 1,
  });
  assert.equal(evaluateToolEconomy({
    state: sendState,
    toolName: 'mcp__clementine-local__read_file',
    args: { path: '/tmp/source' },
    callId: 'send-prelude',
  }), null);
  const send = evaluateToolEconomy({
    state: sendState,
    toolName: 'mcp__gmail__send_email',
    args: { to: 'person@example.com', subject: 'Not an artifact completion' },
    callId: 'send-after-hard-limit',
  });
  assert.equal(send?.kind, 'hard_stop');
  assert.equal(send?.interrupt, true, 'the reserve never widens sends or unrelated external mutations');
});

test('call ids are canonical: replayed permission frames do not consume budget twice', () => {
  const state = createToolEconomyState({ kind: 'interactive', softLimit: 2, hardLimit: 5 });
  assert.equal(evaluateToolEconomy({
    state, toolName: 'read_file', args: { path: '/tmp/a', offset: 10 }, callId: 'same',
  }), null);
  assert.equal(evaluateToolEconomy({
    state, toolName: 'read_file', args: { offset: 10, path: '/tmp/a' }, callId: 'same',
  }), null, 'JSON key order does not turn an exact replay into an integrity stop');
  assert.equal(state.attempts, 1);
});

test('a replayed denied call stays denied without inflating attempts or refusal accounting', () => {
  const state = createToolEconomyState({ kind: 'interactive', softLimit: 1, hardLimit: 5 });
  assert.equal(evaluateToolEconomy({
    state, toolName: 'read_file', args: { path: '/tmp/a' }, callId: 'allowed',
  }), null);
  const denied = evaluateToolEconomy({
    state, toolName: 'read_file', args: { path: '/tmp/b' }, callId: 'denied',
  });
  assert.equal(denied?.kind, 'finish_phase');
  assert.equal(denied?.interrupt, false);

  const replay = evaluateToolEconomy({
    state, toolName: 'read_file', args: { path: '/tmp/b' }, callId: 'denied',
  });
  assert.equal(replay?.kind, 'finish_phase', 'a denied callback replay must never fail open');
  assert.equal(replay?.interrupt, false);
  assert.equal(replay?.replayed, true);
  assert.equal(state.attempts, 2);
  assert.equal(state.softRefusals, 1);
  assert.equal(state.allowed, 1);
});

test('reusing a provider call id for a different action is terminally denied', () => {
  const state = createToolEconomyState({ kind: 'interactive', softLimit: 10, hardLimit: 20 });
  assert.equal(evaluateToolEconomy({
    state, toolName: 'read_file', args: { path: '/tmp/source' }, callId: 'reused',
  }), null);

  const alteredPayload = evaluateToolEconomy({
    state, toolName: 'read_file', args: { path: '/tmp/other' }, callId: 'reused',
  });
  assert.equal(alteredPayload?.kind, 'hard_stop');
  assert.equal(alteredPayload?.interrupt, true);
  assert.equal(alteredPayload?.replayed, true);
  assert.match(alteredPayload?.message ?? '', /different tool or payload/i);
  assert.equal(state.attempts, 1, 'an altered replay is rejected, not counted as a fresh call');
  assert.equal(state.allowed, 1);

  const alteredTool = evaluateToolEconomy({
    state, toolName: 'mcp__gmail__send_email', args: { to: 'attacker@example.com' }, callId: 'reused',
  });
  assert.equal(alteredTool?.kind, 'hard_stop');
  assert.equal(alteredTool?.interrupt, true);
  assert.equal(state.attempts, 1);
});

test('multi-item and explicitly deep work retain larger bounded rails', () => {
  assert.deepEqual(
    interactiveToolEconomyPolicy({ message: 'Research these 20 firms', multiItem: true }),
    { kind: 'multi_item', softLimit: 16, hardLimit: 28 },
  );
  assert.deepEqual(
    interactiveToolEconomyPolicy({ message: 'Do a comprehensive audit of this codebase' }),
    { kind: 'deep', softLimit: 14, hardLimit: 24 },
  );
});

test('long/unlimited budget presets lift the economy limits to the per-turn tool budget', () => {
  // unlimited (64/turn): hard stop aligns with the user's ceiling, steer at 60%.
  assert.deepEqual(
    interactiveToolEconomyPolicy({
      message: 'Research these 20 firms', multiItem: true,
      budget: { preset: 'unlimited', toolCallsPerTurn: 64 },
    }),
    { kind: 'multi_item', softLimit: 38, hardLimit: 64 },
  );
  // long (80/turn) on the tightest class.
  assert.deepEqual(
    interactiveToolEconomyPolicy({
      message: 'create the report and send it',
      budget: { preset: 'long', toolCallsPerTurn: 80 },
    }),
    { kind: 'single_deliverable', softLimit: 48, hardLimit: 80 },
  );
  // standard keeps the tight text-shape limits — no lift.
  assert.deepEqual(
    interactiveToolEconomyPolicy({
      message: 'Research these 20 firms', multiItem: true,
      budget: { preset: 'standard', toolCallsPerTurn: 40 },
    }),
    { kind: 'multi_item', softLimit: 16, hardLimit: 28 },
  );
  // lift never lowers: a preset ceiling below the classified hard limit is ignored.
  assert.deepEqual(
    interactiveToolEconomyPolicy({
      message: 'Research these 20 firms', multiItem: true,
      budget: { preset: 'unlimited', toolCallsPerTurn: 12 },
    }),
    { kind: 'multi_item', softLimit: 16, hardLimit: 28 },
  );
});
