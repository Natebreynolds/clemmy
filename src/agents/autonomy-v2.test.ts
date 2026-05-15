/**
 * Run: npx tsx --test src/agents/autonomy-v2.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentDecisionSchema,
  buildPolicyEvent,
  buildPolicyText,
  categorizeToolForPolicy,
  chooseFollowUpMinutes,
  filterToolsByPolicy,
  looksLikeToolError,
  parseToolArguments,
} from './autonomy-v2.js';
import { DEFAULT_PROACTIVITY_POLICY, type ProactivityPolicySnapshot } from './proactivity-policy.js';

test('AgentDecisionSchema accepts the minimal valid shape', () => {
  const r = AgentDecisionSchema.safeParse({
    summary: 'Did X.',
    commitments: [],
  });
  assert.equal(r.success, true);
});

test('AgentDecisionSchema rejects missing summary', () => {
  const r = AgentDecisionSchema.safeParse({ commitments: [] });
  assert.equal(r.success, false);
});

test('AgentDecisionSchema rejects out-of-bounds followUpMinutes', () => {
  const lo = AgentDecisionSchema.safeParse({ summary: 's', commitments: [], followUpMinutes: 1 });
  const hi = AgentDecisionSchema.safeParse({ summary: 's', commitments: [], followUpMinutes: 9999 });
  assert.equal(lo.success, false);
  assert.equal(hi.success, false);
});

test('AgentDecisionSchema strips unknown keys (e.g. legacy actions array)', () => {
  // Strip behavior means old payloads don't crash rollout.
  const r = AgentDecisionSchema.safeParse({
    summary: 's',
    commitments: [],
    actions: [{ type: 'noop' }],
  });
  assert.equal(r.success, true);
  if (r.success) {
    assert.equal('actions' in r.data, false, 'unknown actions key should be stripped');
  }
});

test('buildPolicyText reflects watch mode guidance', () => {
  const text = buildPolicyText({ ...DEFAULT_PROACTIVITY_POLICY, mode: 'watch' });
  assert.match(text, /Watch mode/);
  assert.match(text, /noop and notify_user/);
});

test('buildPolicyText reflects hands_on mode guidance', () => {
  const text = buildPolicyText({ ...DEFAULT_PROACTIVITY_POLICY, mode: 'hands_on' });
  assert.match(text, /Hands-on mode/);
  assert.match(text, /drive things forward/i);
});

test('buildPolicyText reflects balanced mode by default', () => {
  const text = buildPolicyText(DEFAULT_PROACTIVITY_POLICY);
  assert.match(text, /Balanced mode/);
});

test('buildPolicyText surfaces check-in cadence', () => {
  const text = buildPolicyText({ ...DEFAULT_PROACTIVITY_POLICY, checkInMinutes: 7 });
  assert.match(text, /7 minute\(s\)/);
});

test('buildPolicyText lists allowed action categories', () => {
  const text = buildPolicyText({
    ...DEFAULT_PROACTIVITY_POLICY,
    allowComputerActions: true,
    allowComposioActions: true,
    allowDiscordCheckIns: true,
  });
  assert.match(text, /local computer tools/);
  assert.match(text, /Composio/);
  assert.match(text, /Discord/);
});

test('buildPolicyText warns about blocked categories', () => {
  const text = buildPolicyText({
    ...DEFAULT_PROACTIVITY_POLICY,
    allowComputerActions: false,
    allowComposioActions: false,
    allowDiscordCheckIns: true,
  });
  assert.match(text, /Blocked: computer actions, Composio actions/);
  assert.match(text, /will fail/);
});

test('buildPolicyText handles all-allowed without blocked section', () => {
  const text = buildPolicyText({
    ...DEFAULT_PROACTIVITY_POLICY,
    allowComputerActions: true,
    allowComposioActions: true,
    allowDiscordCheckIns: true,
  });
  assert.doesNotMatch(text, /Blocked:/);
});

test('categorizeToolForPolicy: composio_* → composio', () => {
  assert.equal(categorizeToolForPolicy('composio_status'), 'composio');
  assert.equal(categorizeToolForPolicy('composio_execute_tool'), 'composio');
  assert.equal(categorizeToolForPolicy('cx_gmail_send_email'), 'composio');
});

test('categorizeToolForPolicy: known shell/fs tools → computer', () => {
  for (const name of ['run_shell_command', 'write_file', 'read_file', 'list_files', 'git_status', 'workspace_info']) {
    assert.equal(categorizeToolForPolicy(name), 'computer', `${name} should be computer`);
  }
});

test('categorizeToolForPolicy: safe tools → other', () => {
  for (const name of ['memory_recall', 'memory_remember', 'task_add', 'notify_user', 'goal_update', 'note_take', 'agent_runs_recent']) {
    assert.equal(categorizeToolForPolicy(name), 'other', `${name} should be other`);
  }
});

test('filterToolsByPolicy: default policy keeps all tools', () => {
  const tools = [
    { name: 'composio_execute_tool' },
    { name: 'run_shell_command' },
    { name: 'memory_recall' },
  ];
  const filtered = filterToolsByPolicy(tools, DEFAULT_PROACTIVITY_POLICY);
  assert.equal(filtered.length, 3);
});

test('filterToolsByPolicy: allowComposioActions=false drops composio_* tools', () => {
  const tools = [
    { name: 'composio_status' },
    { name: 'composio_execute_tool' },
    { name: 'memory_recall' },
    { name: 'run_shell_command' },
  ];
  const filtered = filterToolsByPolicy(tools, { ...DEFAULT_PROACTIVITY_POLICY, allowComposioActions: false });
  const names = filtered.map((t) => t.name);
  assert.deepEqual(names, ['memory_recall', 'run_shell_command']);
});

test('filterToolsByPolicy: allowComputerActions=false drops shell/fs tools', () => {
  const tools = [
    { name: 'run_shell_command' },
    { name: 'write_file' },
    { name: 'read_file' },
    { name: 'memory_recall' },
    { name: 'composio_status' },
  ];
  const filtered = filterToolsByPolicy(tools, { ...DEFAULT_PROACTIVITY_POLICY, allowComputerActions: false });
  const names = filtered.map((t) => t.name);
  assert.deepEqual(names, ['memory_recall', 'composio_status']);
});

test('filterToolsByPolicy: both gates off keeps only safe tools', () => {
  const tools = [
    { name: 'run_shell_command' },
    { name: 'composio_execute_tool' },
    { name: 'memory_recall' },
    { name: 'notify_user' },
  ];
  const filtered = filterToolsByPolicy(tools, {
    ...DEFAULT_PROACTIVITY_POLICY,
    allowComputerActions: false,
    allowComposioActions: false,
  });
  const names = filtered.map((t) => t.name);
  assert.deepEqual(names, ['memory_recall', 'notify_user']);
});

test('filterToolsByPolicy: does not mutate input array', () => {
  const tools = [{ name: 'composio_status' }, { name: 'memory_recall' }];
  const before = tools.length;
  filterToolsByPolicy(tools, { ...DEFAULT_PROACTIVITY_POLICY, allowComposioActions: false });
  assert.equal(tools.length, before, 'input array length unchanged');
});

// ---------- buildPolicyEvent ----------

function snapshotOf(overrides: Partial<typeof DEFAULT_PROACTIVITY_POLICY> = {}, quietActive = false): ProactivityPolicySnapshot {
  const policy = { ...DEFAULT_PROACTIVITY_POLICY, ...overrides };
  return {
    policy,
    quietHoursActive: quietActive,
    proactiveWorkAllowed: policy.enabled && !quietActive,
  };
}

test('buildPolicyEvent: type is always status', () => {
  const event = buildPolicyEvent(snapshotOf());
  assert.equal(event.type, 'status');
});

test('buildPolicyEvent: message includes mode and check-in cadence', () => {
  const event = buildPolicyEvent(snapshotOf({ mode: 'hands_on', checkInMinutes: 9 }));
  assert.match(event.message, /hands_on/);
  assert.match(event.message, /check-in 9m/);
});

test('buildPolicyEvent: message flags quiet hours when active', () => {
  const event = buildPolicyEvent(snapshotOf({ quietHoursEnabled: true }, true));
  assert.match(event.message, /quiet hours active/);
});

test('buildPolicyEvent: message omits quiet-hours suffix when not active', () => {
  const event = buildPolicyEvent(snapshotOf({}, false));
  assert.doesNotMatch(event.message, /quiet hours/);
});

test('buildPolicyEvent: data captures every policy gate', () => {
  const event = buildPolicyEvent(snapshotOf({
    mode: 'watch',
    checkInMinutes: 15,
    allowComputerActions: false,
    allowComposioActions: true,
    allowDiscordCheckIns: false,
    quietHoursEnabled: true,
  }, true));

  assert.equal(event.data.mode, 'watch');
  assert.equal(event.data.checkInMinutes, 15);
  assert.equal(event.data.allowComputerActions, false);
  assert.equal(event.data.allowComposioActions, true);
  assert.equal(event.data.allowDiscordCheckIns, false);
  assert.equal(event.data.quietHoursEnabled, true);
  assert.equal(event.data.quietHoursActive, true);
  assert.equal(event.data.proactiveWorkAllowed, false, 'proactive blocked by quiet hours');
});

test('buildPolicyEvent: data is JSON-serializable (no functions, no circular refs)', () => {
  const event = buildPolicyEvent(snapshotOf());
  // Throws on circular structure or non-serializable values.
  const roundtripped = JSON.parse(JSON.stringify(event.data));
  assert.equal(roundtripped.mode, event.data.mode);
});

// ---------- parseToolArguments ----------

test('parseToolArguments: parses JSON-object string', () => {
  const r = parseToolArguments('{"title":"hi","body":"there"}');
  assert.deepEqual(r, { title: 'hi', body: 'there' });
});

test('parseToolArguments: parses JSON-array string', () => {
  const r = parseToolArguments('[1, 2, 3]');
  assert.deepEqual(r, [1, 2, 3]);
});

test('parseToolArguments: parses quoted JSON string', () => {
  const r = parseToolArguments('"plain text"');
  assert.equal(r, 'plain text');
});

test('parseToolArguments: returns original string when not JSON-shaped', () => {
  assert.equal(parseToolArguments('not json'), 'not json');
});

test('parseToolArguments: returns empty object for empty string', () => {
  assert.deepEqual(parseToolArguments(''), {});
});

test('parseToolArguments: returns input unchanged for non-string', () => {
  const arr = [1, 2];
  assert.equal(parseToolArguments(arr as unknown), arr);
});

test('parseToolArguments: falls back to string when JSON parse fails', () => {
  const broken = '{this is not valid json';
  assert.equal(parseToolArguments(broken), broken);
});

// ---------- looksLikeToolError ----------

test('looksLikeToolError: flags strings starting with Error / Failed / Failure', () => {
  assert.equal(looksLikeToolError('Error: file not found'), true);
  assert.equal(looksLikeToolError('Failed to send'), true);
  assert.equal(looksLikeToolError('failure during composio call'), true);
});

test('looksLikeToolError: flags common error vocabulary', () => {
  for (const phrase of ['Unauthorized', 'forbidden', 'not found', 'bad request', 'timeout', 'denied', 'exception thrown', 'Traceback']) {
    assert.equal(looksLikeToolError(phrase), true, `expected ${phrase} → true`);
  }
});

test('looksLikeToolError: flags HTTP-error-shaped codes', () => {
  for (const code of ['401', '403', '404', '429', '500', '503']) {
    assert.equal(looksLikeToolError(`got ${code} from upstream`), true, `expected ${code} → true`);
  }
});

test('looksLikeToolError: empty string is not an error', () => {
  assert.equal(looksLikeToolError(''), false);
});

test('looksLikeToolError: ordinary success output is not flagged', () => {
  assert.equal(looksLikeToolError('Notification queued: abc'), false);
  assert.equal(looksLikeToolError('Remembered #5 (user): Nathan prefers concise replies.'), false);
});

// ---------- chooseFollowUpMinutes ----------

test('chooseFollowUpMinutes: agent explicit pick wins', () => {
  const r = chooseFollowUpMinutes(42, 0, DEFAULT_PROACTIVITY_POLICY);
  assert.equal(r, 42);
});

test('chooseFollowUpMinutes: floors agent pick at 5', () => {
  const r = chooseFollowUpMinutes(2, 5, DEFAULT_PROACTIVITY_POLICY);
  // Below schema floor → discarded, fall through to active-exec logic
  // which uses checkInMinutes (3 default). 3 < 5 floor → 5. Then
  // balanced multiplies by 2 → 10.
  assert.equal(r, 10);
});

test('chooseFollowUpMinutes: no agent pick, no active execs → undefined (cadence applies)', () => {
  const r = chooseFollowUpMinutes(undefined, 0, DEFAULT_PROACTIVITY_POLICY);
  assert.equal(r, undefined);
});

test('chooseFollowUpMinutes: hands_on with active execs uses checkInMinutes directly', () => {
  const r = chooseFollowUpMinutes(undefined, 1, { ...DEFAULT_PROACTIVITY_POLICY, mode: 'hands_on', checkInMinutes: 7 });
  assert.equal(r, 7);
});

test('chooseFollowUpMinutes: balanced with active execs doubles the cadence', () => {
  const r = chooseFollowUpMinutes(undefined, 1, { ...DEFAULT_PROACTIVITY_POLICY, mode: 'balanced', checkInMinutes: 6 });
  assert.equal(r, 12);
});

test('chooseFollowUpMinutes: watch with active execs triples (or 15 min floor)', () => {
  const r1 = chooseFollowUpMinutes(undefined, 1, { ...DEFAULT_PROACTIVITY_POLICY, mode: 'watch', checkInMinutes: 6 });
  assert.equal(r1, 18);
  // checkInMinutes=3 → base=5 (floored), 5*3=15. floor kicks in.
  const r2 = chooseFollowUpMinutes(undefined, 1, { ...DEFAULT_PROACTIVITY_POLICY, mode: 'watch', checkInMinutes: 3 });
  assert.equal(r2, 15);
});

test('chooseFollowUpMinutes: caps at 60 even with high checkInMinutes', () => {
  const r = chooseFollowUpMinutes(undefined, 1, { ...DEFAULT_PROACTIVITY_POLICY, mode: 'hands_on', checkInMinutes: 999 });
  assert.equal(r, 60);
});
