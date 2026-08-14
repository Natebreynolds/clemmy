/**
 * The approved-mandate door in the expected-work wall.
 *
 * Live 2026-08-12 (apr-r7i2): the user approved "Send Outlook draft", the
 * approve-turn routed act (arming the wall), and the resumed business
 * dispatch died with ExpectedWorkBindingRequiredError — approval consumed,
 * nothing sent, no retry path. A resolved-approved card for the EXACT
 * payload is the strongest mandate the system holds; the wall admits it.
 * Everything else about the wall stays closed: unapproved payloads, payload
 * drift, rejections, and other sessions' approvals all still refuse.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-approved-mandate-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-approved-mandate\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const admission = await import('./expected-work-admission.js');
const approvals = await import('./approval-registry.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function acceptArmedAction() {
  const session = eventlog.createSession({ id: `approved-mandate-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Send the follow-up email to alex@example.com now please.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const activated = admission.activateActionExpectedWork({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  assert.ok(
    activated.status === 'activated' || activated.status === 'replayed',
    JSON.stringify(activated),
  );
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

const SEND_ARGS = {
  tool_slug: 'OUTLOOK_SEND_DRAFT',
  arguments: '{"user_id":"user@example.com","message_id":"AAMk-fixture"}',
  connected_account_id: 'ca_fixture',
};

function admit(task: { sessionId: string; sourceUserSeq: number }, args: unknown) {
  return admission.assertExpectedWorkLogicalAdmission({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: `logical:approved-mandate:${serial}:${Math.random().toString(36).slice(2, 8)}`,
    tool: 'composio_execute_tool',
    args,
  });
}

test('an unapproved business dispatch under an armed wall still refuses', () => {
  const task = acceptArmedAction();
  assert.throws(
    () => admit(task, SEND_ARGS),
    admission.ExpectedWorkBindingRequiredError,
  );
});

test('a resolved-approved card for the exact payload admits the dispatch (live apr-r7i2)', () => {
  const task = acceptArmedAction();
  const card = approvals.register({
    sessionId: task.sessionId,
    subject: 'Send Outlook draft',
    tool: 'composio_execute_tool',
    args: SEND_ARGS,
  });
  approvals.resolve(card.approvalId, 'approved', 'discord-user');
  assert.doesNotThrow(() => admit(task, SEND_ARGS));
  // Key-order differences never defeat the mandate: identity is canonical.
  assert.doesNotThrow(() => admit(task, {
    connected_account_id: SEND_ARGS.connected_account_id,
    arguments: SEND_ARGS.arguments,
    tool_slug: SEND_ARGS.tool_slug,
  }));
});

test('payload drift, rejections, and foreign sessions never ride an approval', () => {
  const task = acceptArmedAction();
  const card = approvals.register({
    sessionId: task.sessionId,
    subject: 'Send Outlook draft',
    tool: 'composio_execute_tool',
    args: SEND_ARGS,
  });
  approvals.resolve(card.approvalId, 'approved', 'discord-user');
  // Drifted payload: the user never saw this message id.
  assert.throws(
    () => admit(task, { ...SEND_ARGS, arguments: '{"user_id":"user@example.com","message_id":"AAMk-OTHER"}' }),
    admission.ExpectedWorkBindingRequiredError,
  );

  // A rejected card mandates nothing.
  const rejectedTask = acceptArmedAction();
  const rejected = approvals.register({
    sessionId: rejectedTask.sessionId,
    subject: 'Send Outlook draft',
    tool: 'composio_execute_tool',
    args: SEND_ARGS,
  });
  approvals.resolve(rejected.approvalId, 'rejected', 'discord-user');
  assert.throws(
    () => admit(rejectedTask, SEND_ARGS),
    admission.ExpectedWorkBindingRequiredError,
  );

  // Another session's approval is not this session's mandate.
  const foreignTask = acceptArmedAction();
  assert.throws(
    () => admit(foreignTask, SEND_ARGS),
    admission.ExpectedWorkBindingRequiredError,
  );
});

test('the frozen contract is required for dangerous effects only (live 2026-08-12 fan-out)', () => {
  // Three workers spent whole budgets being refused for contract grammar and
  // made zero business calls. A plan proves per-item once-ness for
  // irreversible effects; for a read or a reversible write it proves nothing
  // the settlement ledger does not already prove.
  const gentle: Array<[string, unknown]> = [
    ['composio_execute_tool', { tool_slug: 'APIFY_RUN_ACTOR', arguments: '{}' }],
    ['composio_execute_tool', { tool_slug: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1', arguments: '{}' }],
    ['composio_execute_tool', { tool_slug: 'GOOGLESHEETS_BATCH_UPDATE', arguments: '{}' }],
    ['read_file', { path: 'leads.json' }],
    ['run_shell_command', { command: 'sf data query --json' }],
  ];
  for (const [tool, args] of gentle) {
    assert.equal(
      admission.frozenContractRequiredForCall(tool, args),
      false,
      `${tool} must not need a frozen plan`,
    );
  }

  const dangerous: Array<[string, unknown]> = [
    ['composio_execute_tool', { tool_slug: 'GMAIL_SEND_EMAIL', arguments: '{}' }],
    ['composio_execute_tool', { tool_slug: 'OUTLOOK_SEND_DRAFT', arguments: '{}' }],
  ];
  for (const [tool, args] of dangerous) {
    assert.equal(
      admission.frozenContractRequiredForCall(tool, args),
      true,
      `${tool} keeps its frozen-plan requirement`,
    );
  }

  // End to end: an armed action turn admits a gentle unbound business call
  // and still refuses an unbound irreversible send.
  const task = acceptArmedAction();
  assert.doesNotThrow(() => admission.assertExpectedWorkLogicalAdmission({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: `logical:gentle:${serial}`,
    tool: 'composio_execute_tool',
    args: { tool_slug: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1', arguments: '{}' },
  }));
  assert.throws(
    () => admission.assertExpectedWorkLogicalAdmission({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: `logical:send:${serial}`,
      tool: 'composio_execute_tool',
      args: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: '{}' },
    }),
    admission.ExpectedWorkBindingRequiredError,
  );
});

test('a verification READ is never blocked by the binding, even under a frozen contract (live 2026-08-12)', () => {
  // An Apify actor run settled uncertain_write. The ONLY way to resolve that
  // is to read the run's status — and nobody declares "the verification read
  // I will need if my write comes back unacknowledged" in a plan written
  // before the write. The read was refused `work_binding_required`, the
  // refusal said "use a different action or tool", and the run escalated to a
  // browser workaround, then parked asking the user to enable Chrome remote
  // debugging to answer a question one API read answers.
  const task = acceptArmedAction();

  // Freeze a contract so the wall is at its strictest: a plan EXISTS and this
  // read is not in it.
  const frozen = admission.admitExpectedWorkInvocation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: `logical:frozen:${serial}`,
    proposal: {
      version: 1,
      operations: [{
        id: 'send_it',
        effect: 'external_write',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    } as never,
    requirementId: 'send_it',
    tool: 'composio_execute_tool',
    args: SEND_ARGS,
  });
  assert.ok(frozen.status === 'bound' || frozen.status === 'refused', JSON.stringify(frozen));

  // The unplanned verification read is admitted.
  assert.doesNotThrow(() => admission.assertExpectedWorkLogicalAdmission({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    logicalToolCallId: `logical:verify-read:${serial}`,
    tool: 'composio_execute_tool',
    args: { tool_slug: 'APIFY_ACTOR_RUNS_GET', arguments: '{"actorId":"x"}' },
  }));

  // An unplanned irreversible SEND is still refused — the wall keeps its job.
  assert.throws(
    () => admission.assertExpectedWorkLogicalAdmission({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      logicalToolCallId: `logical:unplanned-send:${serial}`,
      tool: 'composio_execute_tool',
      args: { tool_slug: 'GMAIL_SEND_EMAIL', arguments: '{"recipient_email":"x@y.invalid"}' },
    }),
    admission.ExpectedWorkBindingRequiredError,
  );
});
