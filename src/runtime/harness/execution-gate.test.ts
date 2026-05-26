/**
 * Run: npx tsx --test src/runtime/harness/execution-gate.test.ts
 *
 * Pure-function tests for the execution-wrap gate. No SDK, no DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMutatingExternalWrite,
  isGateEnabled,
  MissingExecutionWrapError,
} from './execution-gate.js';

// ─── isMutatingExternalWrite — composio_execute_tool ──────────────

test('isMutatingExternalWrite: GOOGLESHEETS_VALUES_UPDATE is a write', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'GOOGLESHEETS_VALUES_UPDATE' }),
    true,
  );
});

test('isMutatingExternalWrite: GOOGLESHEETS_VALUES_GET is a READ — not gated', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'GOOGLESHEETS_VALUES_GET' }),
    false,
  );
});

test('isMutatingExternalWrite: OUTLOOK_CREATE_DRAFT is a write', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'OUTLOOK_CREATE_DRAFT' }),
    true,
  );
});

test('isMutatingExternalWrite: OUTLOOK_LIST_MESSAGES is a read', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'OUTLOOK_LIST_MESSAGES' }),
    false,
  );
});

test('isMutatingExternalWrite: GOOGLESHEETS_BATCH_UPDATE is a write (BATCH verb)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'GOOGLESHEETS_BATCH_UPDATE' }),
    true,
  );
});

test('isMutatingExternalWrite: GOOGLESHEETS_BATCH_GET is a read (BATCH+GET — BATCH triggers, but GET doesn\'t exempt)', () => {
  // Honest behavior: BATCH alone triggers. This is the false-positive
  // we accept to keep the rule simple — a BATCH_GET is read but still
  // gated. The audit overhead is small; the safety is real.
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'GOOGLESHEETS_BATCH_GET' }),
    true,
  );
});

test('isMutatingExternalWrite: SALESFORCE_LIST_ACCOUNTS is a read', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'SALESFORCE_LIST_ACCOUNTS' }),
    false,
  );
});

test('isMutatingExternalWrite: INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH is a write (POST + PUBLISH)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'INSTAGRAM_POST_IG_USER_MEDIA_PUBLISH' }),
    true,
  );
});

// ─── isMutatingExternalWrite — exempt slug patterns ──────────────

test('isMutatingExternalWrite: DATAFORSEO_CREATE_SERP_TASK_POST is exempt (task creation, not user data)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST' }),
    false,
  );
});

test('isMutatingExternalWrite: FIRECRAWL_SCRAPE is exempt (external read, not mutation)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'FIRECRAWL_SCRAPE' }),
    false,
  );
});

test('isMutatingExternalWrite: FIRECRAWL_BATCH_SCRAPE is exempt (provider-side read job)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', { tool_slug: 'FIRECRAWL_BATCH_SCRAPE' }),
    false,
  );
});

// ─── isMutatingExternalWrite — exempt tool names ──────────────

test('isMutatingExternalWrite: execution_create is exempt (this is HOW Clem satisfies the gate)', () => {
  assert.equal(
    isMutatingExternalWrite('execution_create', { objective: 'x' }),
    false,
  );
});

test('isMutatingExternalWrite: notify_user is exempt', () => {
  assert.equal(
    isMutatingExternalWrite('notify_user', { title: 'x', body: 'y' }),
    false,
  );
});

test('isMutatingExternalWrite: tool_choice_recall is exempt (pure cache)', () => {
  assert.equal(
    isMutatingExternalWrite('tool_choice_recall', { intent: 'x' }),
    false,
  );
});

test('isMutatingExternalWrite: ask_user_question is exempt', () => {
  assert.equal(
    isMutatingExternalWrite('ask_user_question', { question: 'x' }),
    false,
  );
});

// ─── isMutatingExternalWrite — defensive / edge cases ────────────

test('isMutatingExternalWrite: missing tool_slug → false (fail-open, don\'t block)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', {}),
    false,
  );
});

test('isMutatingExternalWrite: null args → false', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', null),
    false,
  );
});

test('isMutatingExternalWrite: string args (legacy serialized form) parse and check', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', JSON.stringify({ tool_slug: 'GOOGLESHEETS_VALUES_UPDATE' })),
    true,
  );
});

test('isMutatingExternalWrite: corrupt JSON string args → false (fail-open)', () => {
  assert.equal(
    isMutatingExternalWrite('composio_execute_tool', '{not valid json'),
    false,
  );
});

test('isMutatingExternalWrite: non-composio tool (run_shell_command) NOT gated by this rule', () => {
  // Future enhancement: classify shell commands. For now, only
  // composio_execute_tool is gated. Documented in execution-gate.ts.
  assert.equal(
    isMutatingExternalWrite('run_shell_command', { command: 'echo hi' }),
    false,
  );
});

test('isMutatingExternalWrite: random unknown tool → false', () => {
  assert.equal(
    isMutatingExternalWrite('some_random_internal_tool', { x: 1 }),
    false,
  );
});

// ─── isGateEnabled — env flag parsing ─────────────────────────────

test('isGateEnabled: default ON when env unset', () => {
  const prev = process.env.CLEMMY_EXECUTION_GATE;
  delete process.env.CLEMMY_EXECUTION_GATE;
  try {
    assert.equal(isGateEnabled(), true);
  } finally {
    if (prev !== undefined) process.env.CLEMMY_EXECUTION_GATE = prev;
  }
});

test('isGateEnabled: explicit off disables', () => {
  const prev = process.env.CLEMMY_EXECUTION_GATE;
  process.env.CLEMMY_EXECUTION_GATE = 'off';
  try {
    assert.equal(isGateEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_EXECUTION_GATE;
    else process.env.CLEMMY_EXECUTION_GATE = prev;
  }
});

test('isGateEnabled: explicit on enables', () => {
  const prev = process.env.CLEMMY_EXECUTION_GATE;
  process.env.CLEMMY_EXECUTION_GATE = 'on';
  try {
    assert.equal(isGateEnabled(), true);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_EXECUTION_GATE;
    else process.env.CLEMMY_EXECUTION_GATE = prev;
  }
});

test('isGateEnabled: unrecognized value treated as OFF (permissive — don\'t block on typo)', () => {
  const prev = process.env.CLEMMY_EXECUTION_GATE;
  process.env.CLEMMY_EXECUTION_GATE = 'enabled';
  try {
    assert.equal(isGateEnabled(), false);
  } finally {
    if (prev === undefined) delete process.env.CLEMMY_EXECUTION_GATE;
    else process.env.CLEMMY_EXECUTION_GATE = prev;
  }
});

// ─── MissingExecutionWrapError — message shape ───────────────────

test('MissingExecutionWrapError: message tells Clem how to recover', () => {
  const err = new MissingExecutionWrapError({
    toolName: 'composio_execute_tool',
    toolSlug: 'GOOGLESHEETS_VALUES_UPDATE',
    sessionId: 'sess-test',
  });
  assert.match(err.message, /EXECUTION_WRAP_REQUIRED/);
  assert.match(err.message, /GOOGLESHEETS_VALUES_UPDATE/);
  assert.match(err.message, /execution_create/);
  assert.match(err.message, /re-issue this tool call/);
  assert.equal(err.sessionId, 'sess-test');
});

test('MissingExecutionWrapError: message handles missing slug gracefully', () => {
  const err = new MissingExecutionWrapError({
    toolName: 'composio_execute_tool',
    toolSlug: undefined,
    sessionId: 'sess-test',
  });
  assert.match(err.message, /composio_execute_tool/);
  // No double parens / weird formatting when slug is absent
  assert.ok(!err.message.includes('()'));
});
