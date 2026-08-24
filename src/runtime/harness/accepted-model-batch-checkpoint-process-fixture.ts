import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { AgentInputItem } from '@openai/agents';
import type { HostCallAttestation } from './accepted-turn-call-authority.js';
import type { DispatchLeaseRef } from './dispatch-lease.js';
import type { HarnessRunContext } from './brackets.js';
import type { HostToolInvocationResult } from './host-tool-invocation.js';
import type {
  AcceptedModelBatchCheckpoint,
  AdmitAcceptedModelBatchResult,
  FinalizeAcceptedModelBatchResult,
} from './accepted-model-batch-checkpoint.js';

const home = process.env.CLEMENTINE_HOME?.trim();
const mode = process.argv[2];
if (!home || !mode) throw new Error('fixture requires CLEMENTINE_HOME and a mode');
mkdirSync(path.join(home, 'state'), { recursive: true });

const eventlog = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const checkpoints = await import('./accepted-model-batch-checkpoint.js');
const identities = await import('./attempt-identity.js');
const contracts = await import('./logical-call-contract.js');
const hostBindings = await import('./host-call-capability-binding.js');
const leases = await import('./dispatch-lease.js');
const brackets = await import('./brackets.js');
const invocation = await import('./host-tool-invocation.js');
const graphShadow = await import('../graph/turn-graph-shadow.js');
const toolEffects = await import('./tool-effect.js');
const restartRecovery = await import('./restart-recovery.js');

const SESSION_ID = 'discord-midturn-restart';
const PROMPT = 'Find 10 restaurants in Santa Clarita and put them in a new Google Sheet.';
const READ_CALL_ID = 'restaurant-read';
const READ_TOOL = 'composio_execute_tool';
const READ_LOGICAL_TOOL = 'RESTAURANTS_SEARCH';
const READ_LOGICAL_ARGS = { location: 'Santa Clarita, CA', category: 'restaurant', limit: 10 };
const READ_ARGS = {
  tool_slug: READ_LOGICAL_TOOL,
  arguments: JSON.stringify(READ_LOGICAL_ARGS),
  connected_account_id: 'conn-restaurants',
};
const RESTAURANTS = Array.from({ length: 10 }, (_, index) => ({
  name: `Restaurant ${index + 1}`,
  address: `${100 + index} Main Street, Santa Clarita, CA`,
}));
const READ_RESULT = { successful: true, data: { records: RESTAURANTS, complete: true } };
const WRITE_CALL_ID = 'sheet-create';
const WRITE_TOOL = 'composio_execute_tool';
const WRITE_LOGICAL_TOOL = 'GOOGLESHEETS_SHEET_FROM_JSON';
const WRITE_LOGICAL_ARGS = {
  title: 'Santa Clarita Restaurants',
  sheet_name: 'Restaurants',
  sheet_json: JSON.stringify(RESTAURANTS),
};
const WRITE_ARGS = {
  tool_slug: WRITE_LOGICAL_TOOL,
  arguments: JSON.stringify(WRITE_LOGICAL_ARGS),
  connected_account_id: 'conn-googlesheets',
};
const WRITE_RESULT = {
  successful: true,
  data: {
    spreadsheetId: 'sheet_restart_exact_once',
    url: 'https://docs.google.com/spreadsheets/d/sheet_restart_exact_once/edit',
    rowsWritten: 10,
  },
};

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const auditPath = path.join(home, 'state', 'checkpoint-process-audit.log');
const audit = (line: string): void => appendFileSync(auditPath, `${line}\n`, 'utf8');

function openFrame(callId: string, name: string, args: unknown): AgentInputItem[] {
  return [{
    type: 'function_call',
    callId,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  } as AgentInputItem];
}

function acceptedSource() {
  let session = eventlog.getSession(SESSION_ID);
  if (!session) {
    session = eventlog.createSession({
      id: SESSION_ID,
      kind: 'chat',
      channel: 'discord',
      metadata: {
        source: 'discord',
        channelId: 'discord-channel-midturn-restart',
        guildId: 'discord-guild-midturn-restart',
      },
    });
    const attempt = eventlog.beginRunAttempt(session.id, {
      runId: 'discord-midturn-restart-run',
    });
    eventlog.recordRunAttemptUserInput(attempt, {
      turn: 1,
      role: 'user',
      data: {
        text: PROMPT,
      },
    }, { armRunInFlight: true });
  }
  const sources = eventlog.listEvents(SESSION_ID, { types: ['user_input_received'] });
  assert.equal(sources.length, 1);
  const source = sources[0]!;
  const task = {
    sessionId: SESSION_ID,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(SESSION_ID, source.seq),
    sourceEventId: source.id,
  };
  const graph = graphShadow.recordTurnGraphShadow({
    identity: { sessionId: SESSION_ID, sourceUserSeq: source.seq, turn: 1 },
    surface: 'discord',
    allowedToolNames: [READ_TOOL, WRITE_TOOL],
  });
  assert.ok(graph, 'one durable graph must reopen for the accepted Discord source');
  let root = authority.acceptedTurnCallAuthorityFor(SESSION_ID, source.seq);
  if (root.status !== 'ok') {
    const armed = authority.armHostCallAuthority({
      sessionId: SESSION_ID,
      sourceUserSeq: source.seq,
      catalogRevisionDigest: digest(`catalog:${SESSION_ID}`),
      bindingRevisionDigest: digest(`binding:${SESSION_ID}`),
      maxLogicalCalls: 8,
      maxParallelCalls: 4,
    });
    assert.equal(armed.status, 'armed');
    root = authority.acceptedTurnCallAuthorityFor(SESSION_ID, source.seq);
  }
  if (root.status !== 'ok') throw new Error('exact host root did not reopen after arming');
  return { task, graph, root: root.authority };
}

type Source = ReturnType<typeof acceptedSource>;

function attestation(
  source: Source,
  input: {
    callId: string;
    toolName: string;
    args: unknown;
    effect: 'read' | 'external_write';
  },
): HostCallAttestation {
  const contract = contracts.durableLogicalCallContract(
    source.task.acceptedTaskId,
    input.toolName,
    input.args,
  );
  assert.ok(contract);
  if (!contract) throw new Error('fixture tool contract is unsafe');
  const base = {
    sessionId: source.task.sessionId,
    sourceUserSeq: source.task.sourceUserSeq,
    acceptedTaskId: source.task.acceptedTaskId,
    sourceEventId: source.root.sourceEventId,
    sourceEventDigest: source.root.sourceEventDigest,
    logicalToolCallId: input.callId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: input.effect,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: `cap:${contract.toolName.toLowerCase()}`,
    schemaFingerprint: digest(`schema:${contract.toolName}`),
    accountId: input.effect === 'read' ? 'conn-restaurants' : 'conn-googlesheets',
    invokePortId: 'fixture:provider',
    operationId: contract.toolName,
    manifestId: `manifest:${contract.toolName}`,
    manifestDigest: digest(`manifest:${contract.toolName}`),
    engineVersion: source.root.engineVersion,
    surfaceVersion: source.root.surfaceVersion,
    authorityDigest: source.root.authorityDigest,
    authorityRevision: source.root.revision,
    surfaceDigest: source.root.surfaceDigest,
    catalogRevisionDigest: source.root.catalogRevisionDigest!,
    bindingRevisionDigest: source.root.bindingRevisionDigest!,
  };
  return { ...base, bindingDigest: hostBindings.hostCallAttestationBindingDigest(base) };
}

function runCall<T>(
  source: Source,
  owner: {
    lease: DispatchLeaseRef;
    context: HarnessRunContext;
  },
  input: {
    callId: string;
    toolName: string;
    args: unknown;
    effect: 'read' | 'external_write';
    carrierToolName: string;
    carrierArgs: unknown;
    invoke: () => Promise<T>;
  },
) {
  const proof = attestation(source, input);
  return authority.withHostCallAttestation(proof, () =>
    brackets.withHarnessRunContext(owner.context, () => invocation.invokeHostToolCall({
      identity: {
        sessionId: source.task.sessionId,
        sourceUserSeq: source.task.sourceUserSeq,
        modelCallId: input.callId,
        toolName: input.toolName,
        args: input.args,
        turn: 1,
      },
      parentLease: owner.lease,
      effect: input.effect,
      boundary: 'host_owned_external',
      trustedEffectCarrier: toolEffects.trustedRuntimeEffectCarrier(
        input.carrierToolName,
        input.carrierArgs,
      ),
      deadlineMs: 1_000,
      invoke: input.invoke,
    }))) as Promise<HostToolInvocationResult<T>>;
}

function owner(source: Source) {
  const lease = leases.activateDispatchLease({
    sessionId: source.task.sessionId,
    scopeId: `${source.task.sessionId}::process:${mode}:${process.pid}`,
  });
  return {
    lease,
    context: {
      sessionId: source.task.sessionId,
      sourceUserSeq: source.task.sourceUserSeq,
      turn: 1,
      counter: new brackets.ToolCallsCounter(20),
      dispatchLease: lease,
    } satisfies HarnessRunContext,
  };
}

function signal(kind: 'READY' | 'DONE', value: Record<string, unknown>, hold = false): void {
  process.stdout.write(`${kind} ${JSON.stringify(value)}\n`, () => {
    if (hold) setInterval(() => {}, 1_000);
  });
}

function refFromAdmission(result: AdmitAcceptedModelBatchResult) {
  if ('reason' in result) throw new Error(result.reason);
  return result.admission;
}

function checkpointFromFinalization(result: FinalizeAcceptedModelBatchResult) {
  if ('reason' in result) throw new Error(result.reason);
  return result.checkpoint;
}

function checkpointIdentity(source: Source, checkpoint: AcceptedModelBatchCheckpoint) {
  return {
    sessionId: source.task.sessionId,
    sourceUserSeq: source.task.sourceUserSeq,
    acceptedTaskId: source.task.acceptedTaskId,
    authorityDigest: source.root.authorityDigest,
    graphEventId: source.graph.id,
    graphId: source.graph.data.graphId,
    graphHash: source.graph.data.graphHash,
    batchOrdinal: checkpoint.batchOrdinal,
    batchId: checkpoint.batchId,
    historyDigest: checkpoint.historyDigest,
    lastResponseId: checkpoint.lastResponseId,
  };
}

async function executeReadBatch(source: Source, runOwner: ReturnType<typeof owner>) {
  audit('model:response:read');
  const admitted = refFromAdmission(checkpoints.admitAcceptedModelBatch({
    sessionId: source.task.sessionId,
    sourceUserSeq: source.task.sourceUserSeq,
    preHistory: [{ role: 'user', content: PROMPT } as AgentInputItem],
    frameHistory: openFrame(READ_CALL_ID, READ_TOOL, READ_ARGS),
    providerResponseId: 'model-response-read',
  }));
  const result = await runCall(source, runOwner, {
    callId: READ_CALL_ID,
    toolName: READ_LOGICAL_TOOL,
    args: READ_LOGICAL_ARGS,
    effect: 'read',
    carrierToolName: READ_TOOL,
    carrierArgs: READ_ARGS,
    invoke: async () => {
      audit('provider:body:restaurant-read');
      return READ_RESULT;
    },
  });
  assert.deepEqual(result.value, READ_RESULT);
  return checkpointFromFinalization(checkpoints.finalizeAcceptedModelBatch(admitted));
}

async function executeWriteBatch(
  source: Source,
  runOwner: ReturnType<typeof owner>,
  prior: AcceptedModelBatchCheckpoint,
) {
  audit('model:response:write');
  const admitted = refFromAdmission(checkpoints.admitAcceptedModelBatch({
    sessionId: source.task.sessionId,
    sourceUserSeq: source.task.sourceUserSeq,
    preHistory: prior.history,
    frameHistory: openFrame(WRITE_CALL_ID, WRITE_TOOL, WRITE_ARGS),
    previousResponseId: prior.lastResponseId,
    providerResponseId: 'model-response-write',
  }));
  const result = await runCall(source, runOwner, {
    callId: WRITE_CALL_ID,
    toolName: WRITE_LOGICAL_TOOL,
    args: WRITE_LOGICAL_ARGS,
    effect: 'external_write',
    carrierToolName: WRITE_TOOL,
    carrierArgs: WRITE_ARGS,
    invoke: async () => {
      audit('provider:body:sheet-create');
      return WRITE_RESULT;
    },
  });
  assert.deepEqual(result.value, WRITE_RESULT);
  return checkpointFromFinalization(checkpoints.finalizeAcceptedModelBatch(admitted));
}

function recover(source: Source, expectedOrdinal: number) {
  const recovered = checkpoints.recoverAcceptedModelBatchForRestart({
    sessionId: source.task.sessionId,
    sourceUserSeq: source.task.sourceUserSeq,
  });
  if (recovered.status !== 'ready') throw new Error(JSON.stringify(recovered));
  assert.equal(recovered.checkpoint.batchOrdinal, expectedOrdinal);
  return recovered.checkpoint;
}

async function resumeThroughBoot<T>(
  source: Source,
  expectedOrdinal: number,
  continuation: (checkpoint: AcceptedModelBatchCheckpoint) => Promise<T> | T,
): Promise<T> {
  let settle!: (value: T) => void;
  let fail!: (error: unknown) => void;
  const dispatched = new Promise<T>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const summary = restartRecovery.recoverInterruptedChatRuns(Date.now, async (restart) => {
    try {
      assert.equal(restart.sessionId, source.task.sessionId);
      assert.equal(restart.sourceUserSeq, source.task.sourceUserSeq);
      assert.equal(restart.surface, 'discord');
      assert.equal(restart.channel, 'discord');
      assert.equal(restart.acceptedInput, PROMPT);
      const prepared = checkpoints.prepareAcceptedModelBatchRestart({
        sessionId: restart.sessionId,
        sourceUserSeq: restart.sourceUserSeq,
      });
      assert.ok(
        prepared.status === 'ready' || prepared.status === 'reconciliation_required',
        JSON.stringify(prepared),
      );
      if (prepared.status !== 'ready' && prepared.status !== 'reconciliation_required') {
        throw new Error('restart checkpoint token was not prepared');
      }
      const reopened = checkpoints.recoverAcceptedModelBatchFromToken(
        prepared.token,
      );
      assert.equal(reopened.status, 'ready', JSON.stringify(reopened));
      if (reopened.status !== 'ready') throw new Error('restart checkpoint did not reopen ready');
      assert.equal(reopened.checkpoint.batchOrdinal, expectedOrdinal);
      const tokenBytes = JSON.stringify(prepared.token);
      const publicBytes = JSON.stringify(eventlog.listEvents(source.task.sessionId));
      assert.doesNotMatch(publicBytes, /clementine\.accepted_model_batch_restart/);
      assert.doesNotMatch(publicBytes, new RegExp(prepared.token.resumeFromBatchId));
      assert.notEqual(tokenBytes, publicBytes);
      settle(await continuation(reopened.checkpoint));
    } catch (error) {
      fail(error);
    }
  });
  assert.equal(summary.recovered, 1, JSON.stringify(summary));
  assert.equal(summary.records[0]?.autoResumed, true, JSON.stringify(summary));
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      dispatched,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('restart dispatch did not run')), 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function settleRestartOwner(source: Source): void {
  const attempt = eventlog.getLatestRunAttempt(source.task.sessionId);
  if (!attempt) return;
  eventlog.finishRunAttempt(attempt, 'completed');
  restartRecovery.clearRunInFlightAfterTerminal(
    source.task.sessionId,
    attempt.attemptId,
    source.task.sourceUserSeq,
  );
}

function terminal(source: Source) {
  const result = eventlog.appendTerminalEventOnce({
    sessionId: source.task.sessionId,
    turn: 1,
    role: 'system',
    data: {
      reply: `Created one Google Sheet with 10 restaurants: ${WRITE_RESULT.data.url}`,
      summary: 'Restaurant collection and Sheet creation completed.',
      delivered: true,
      reason: 'completed',
      acceptedSourceSeq: source.task.sourceUserSeq,
      acceptedTaskId: source.task.acceptedTaskId,
    },
  }, `turn:${source.task.sourceUserSeq}`);
  return { inserted: result.inserted, terminalEventId: result.event.id };
}

const source = acceptedSource();
const runOwner = owner(source);

if (mode === 'start-after-read') {
  const read = await executeReadBatch(source, runOwner);
  signal('READY', { crashPoint: 'after-read-checkpoint', ...checkpointIdentity(source, read) }, true);
} else if (mode === 'resume-after-read') {
  const resumed = await resumeThroughBoot(source, 1, async (read) => {
    const write = await executeWriteBatch(source, runOwner, read);
    const publication = terminal(source);
    settleRestartOwner(source);
    return { write, publication };
  });
  leases.revokeDispatchLease(runOwner.lease);
  eventlog.closeEventLog();
  signal('DONE', {
    resumePoint: 'after-read',
    ...checkpointIdentity(source, resumed.write),
    ...resumed.publication,
  });
} else if (mode === 'start-after-write') {
  const read = await executeReadBatch(source, runOwner);
  const write = await executeWriteBatch(source, runOwner, read);
  signal('READY', { crashPoint: 'after-write-checkpoint', ...checkpointIdentity(source, write) }, true);
} else if (mode === 'resume-after-write') {
  const existingTerminal = eventlog.listEvents(source.task.sessionId, {
    types: ['conversation_completed'],
  }).length > 0;
  const resumed = existingTerminal
    ? { write: recover(source, 2), publication: terminal(source) }
    : await resumeThroughBoot(source, 2, async (write) => {
        const publication = terminal(source);
        settleRestartOwner(source);
        return { write, publication };
      });
  leases.revokeDispatchLease(runOwner.lease);
  eventlog.closeEventLog();
  signal('DONE', {
    resumePoint: 'after-write',
    ...checkpointIdentity(source, resumed.write),
    ...resumed.publication,
  });
} else {
  throw new Error(`unsupported fixture mode: ${mode}`);
}
