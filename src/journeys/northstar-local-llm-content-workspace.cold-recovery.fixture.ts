/**
 * Fresh-process terminal owner for the model-driven north-star journey.
 * Phase A runs in the governing host E2E. This process reopens only durable
 * accepted-source, planning, call, Workspace, and terminal state; it installs
 * no provider transport and therefore cannot replay either business body.
 */
import assert from 'node:assert/strict';

import { acceptedTurnCallAuthorityFor } from '../runtime/harness/accepted-turn-call-authority.js';
import { recoverAcceptedModelBatchForRestart } from '../runtime/harness/accepted-model-batch-checkpoint.js';
import { prepareAcceptedTaskTerminal } from '../runtime/harness/accepted-task-terminal-preparation.js';
import { commitTurnOutcome } from '../runtime/harness/delivery-committer.js';
import {
  closeEventLog,
  listEvents,
  openEventLog,
} from '../runtime/harness/eventlog.js';
import { turnOutcomeId } from '../runtime/harness/turn-outcome.js';
import { primePrimaryModelPlanningCatalog } from '../runtime/semantic-boundary/admit-and-compile-accepted-source.js';
import { readData } from '../spaces/data-store.js';
import { spaceStore } from '../spaces/store.js';
import { closeWorkspaceDb } from '../spaces/workspace-db.js';

const MARKER = '@@CLEM_NORTHSTAR_COLD_RECOVERY@@';

type Input = {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  planningDigest: string;
};

function parseInput(): Input {
  const encoded = process.env.CLEM_NORTHSTAR_COLD_RECOVERY_INPUT;
  assert.ok(encoded, 'cold recovery requires exact phase-A identity');
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<Input>;
  assert.equal(typeof value.sessionId, 'string');
  assert.ok(Number.isSafeInteger(value.sourceUserSeq) && Number(value.sourceUserSeq) > 0);
  assert.ok(Number.isSafeInteger(value.turn) && Number(value.turn) > 0);
  assert.match(String(value.planningDigest), /^[a-f0-9]{64}$/);
  return value as Input;
}

function resultText(item: unknown): string {
  const output = (item as { output?: unknown })?.output;
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && typeof (output as { text?: unknown }).text === 'string') {
    return (output as { text: string }).text;
  }
  return '';
}

function deriveTerminalFromCheckpoint(input: Input) {
  const recovered = recoverAcceptedModelBatchForRestart({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  });
  if (recovered.status !== 'ready') throw new Error(JSON.stringify(recovered));
  const saveResult = recovered.checkpoint.history.find((item) => (
    (item as { type?: unknown }).type === 'function_call_result'
    && /Created workspace/.test(resultText(item))
    && /[?&]workspace=/.test(resultText(item))
  )) as ({ callId?: unknown } & Record<string, unknown>) | undefined;
  assert.ok(saveResult && typeof saveResult.callId === 'string',
    'the cold owner reopens the exact settled compound Workspace result');
  const saveCall = recovered.checkpoint.history.find((item) => (
    (item as { type?: unknown }).type === 'function_call'
    && (item as { callId?: unknown }).callId === saveResult.callId
  )) as { name?: unknown; arguments?: unknown } | undefined;
  assert.equal(saveCall?.name, 'work_call');
  assert.equal(typeof saveCall?.arguments, 'string');
  const outer = JSON.parse(saveCall.arguments as string) as {
    name?: unknown;
    args_json?: unknown;
  };
  assert.equal(outer.name, 'space_save');
  assert.equal(typeof outer.args_json, 'string');
  const inner = JSON.parse(outer.args_json as string) as {
    slug?: unknown;
    title?: unknown;
  };
  assert.equal(typeof inner.slug, 'string');
  assert.equal(typeof inner.title, 'string');
  const slug = inner.slug as string;
  const title = inner.title as string;
  const mobileLink = `/m/?tab=spaces&workspace=${slug}`;
  assert.match(resultText(saveResult), new RegExp(mobileLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const proposedReply = `Created [${title}](/workspaces/${slug}) with the cited research, three-week calendar, and five complete posts. [Open it on mobile](${mobileLink}).`;
  return { checkpoint: recovered.checkpoint, slug, proposedReply };
}

function physicalRows(input: Input) {
  return openEventLog().prepare(`
    SELECT tool_name, state, COUNT(*) AS n
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
     GROUP BY tool_name, state
     ORDER BY tool_name, state
  `).all(input.sessionId, input.sourceUserSeq) as Array<{
    tool_name: string;
    state: string;
    n: number;
  }>;
}

const input = parseInput();
const physicalBefore = physicalRows(input);
const authority = acceptedTurnCallAuthorityFor(input.sessionId, input.sourceUserSeq);
if (authority.status !== 'ok') throw new Error(JSON.stringify(authority));
assert.equal(authority.authority.state, 'open');

const rePrimed = await primePrimaryModelPlanningCatalog({
  sessionId: input.sessionId,
  sourceUserSeq: input.sourceUserSeq,
});
if (!rePrimed.ok) throw new Error(rePrimed.reason);
assert.equal(rePrimed.planning.digest, input.planningDigest,
  'a cold module graph must rehydrate the exact immutable planning card');

const terminal = deriveTerminalFromCheckpoint(input);
const workspace = spaceStore.get(terminal.slug);
assert.ok(workspace, 'the compound Workspace must reopen in the cold process');
assert.equal(workspace.version, 1);
const data = readData(terminal.slug) as {
  calendar?: unknown[];
  posts?: unknown[];
  _mobile?: { records?: { items?: unknown[] } };
};
assert.equal(data.calendar?.length, 5);
assert.equal(data.posts?.length, 5);
assert.equal(data._mobile?.records?.items?.length, 5);

const prepared = prepareAcceptedTaskTerminal({
  sessionId: input.sessionId,
  sourceUserSeq: input.sourceUserSeq,
  proposedReply: terminal.proposedReply,
});
assert.equal(prepared.status, 'ready', JSON.stringify(prepared));

const committed = commitTurnOutcome({
  version: 2,
  id: turnOutcomeId({
    sessionId: input.sessionId,
    turn: input.turn,
    sourceUserSeq: input.sourceUserSeq,
  }),
  identity: {
    sessionId: input.sessionId,
    turn: input.turn,
    sourceUserSeq: input.sourceUserSeq,
  },
  status: 'done',
  resumable: false,
  presentation: { kind: 'answer', text: terminal.proposedReply },
});
assert.equal(committed.presentation.status, 'done');

// A second publication attempt is a durable replay, never a second delivery.
const replayed = commitTurnOutcome({
  version: 2,
  id: turnOutcomeId({
    sessionId: input.sessionId,
    turn: input.turn,
    sourceUserSeq: input.sourceUserSeq,
  }),
  identity: {
    sessionId: input.sessionId,
    turn: input.turn,
    sourceUserSeq: input.sourceUserSeq,
  },
  status: 'done',
  resumable: false,
  presentation: { kind: 'answer', text: terminal.proposedReply },
});
assert.equal(replayed.event.id, committed.event.id);

const delivered = listEvents(input.sessionId, { types: ['conversation_completed'] })
  .filter((event) => event.data.sourceUserSeq === input.sourceUserSeq);
assert.equal(delivered.length, 1);
assert.equal(delivered[0]?.data.delivered, true);
assert.equal(delivered[0]?.data.reply, terminal.proposedReply);

const physicalAfter = physicalRows(input);
assert.deepEqual(physicalAfter, physicalBefore,
  'cold planning/terminal recovery cannot add a provider or Workspace crossing');

const result = {
  pid: process.pid,
  planningDigest: rePrimed.planning.digest,
  authorityDigest: authority.authority.authorityDigest,
  checkpointBatchId: terminal.checkpoint.batchId,
  checkpointHistoryDigest: terminal.checkpoint.historyDigest,
  proposedReply: terminal.proposedReply,
  workspaceVersion: workspace.version,
  postCount: data.posts?.length ?? 0,
  mobilePostCount: data._mobile?.records?.items?.length ?? 0,
  terminalPreparationStatus: prepared.status,
  terminalManifestId: prepared.status === 'ready' ? prepared.manifestId : null,
  terminalVerdict: prepared.status === 'ready' ? prepared.verdict.status : null,
  physicalBefore,
  physicalAfter,
  terminalEventId: committed.event.id,
  terminalEvents: delivered.length,
};

closeWorkspaceDb();
closeEventLog();
process.stdout.write(`${MARKER}${JSON.stringify(result)}\n`);
