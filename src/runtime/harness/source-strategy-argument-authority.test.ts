import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-source-arg-authority-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-source-arg-authority\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const identities = await import('./attempt-identity.js');
const leases = await import('./dispatch-lease.js');
const contracts = await import('./logical-call-contract.js');
const authority = await import('./source-strategy-argument-authority.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

let serial = 0;

function fixture() {
  const session = eventlog.createSession({
    id: `source-arg-authority-${++serial}`,
    kind: 'chat',
  });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Find five Pismo Beach restaurants from public reviews.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
    turn: 1,
    parentLease: leases.activateDispatchLease({
      sessionId: session.id,
      scopeId: `${session.id}::parent`,
    }),
  };
}

test('opaque source-argument authority binds reopened raw bytes to the exact current provider-ready call', async () => {
  const task = fixture();
  const tool = 'APIFY_RUN_ACTOR_SYNC_GET_DATASET_ITEMS';
  const rawArgs = {
    actorId: 'compass/crawler-google-places',
    runInput: { searchStringsArray: ['restaurants in Pismo Beach CA'] },
    routeAccount: 'research@example.test',
  };
  const providerReadyArgs = {
    actorId: 'compass/crawler-google-places',
    runInput: { searchStringsArray: ['restaurants in Pismo Beach CA'] },
    limit: 5,
  };
  const logicalToolCallId = 'model:source-argument-authority';
  const recovery = contracts.durableLogicalCallRecoveryMaterial(
    task.acceptedTaskId,
    tool,
    rawArgs,
  );
  assert.ok(recovery);
  let token: authority.CurrentRequestSourceArgumentAuthorityV1 | null = null;
  let childLease: leases.DispatchLeaseRef | undefined;

  await identities.withLogicalToolCall({
    ...task,
    logicalToolCallId,
    tool,
    args: rawArgs,
  }, async () => {
    childLease = leases.activateDispatchLease({
      sessionId: task.sessionId,
      scopeId: `${task.sessionId}::source-call`,
      parentLease: task.parentLease,
      sourceUserSeq: task.sourceUserSeq,
      acceptedTaskId: task.acceptedTaskId,
      logicalToolCallId,
      recovery: {
        effect: 'read',
        businessCall: true,
        material: recovery!,
        turn: task.turn,
      },
    });
    await leases.runWithDispatchLease(childLease, async () => {
      const refined = identities.authorizeResolvedLogicalCallContract({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        turn: task.turn,
        tool,
        effectiveArgs: providerReadyArgs,
      });
      assert.ok(refined);
      token = authority.mintCurrentRequestSourceArgumentAuthority({
        ...task,
        logicalToolCallId,
        tool,
        args: providerReadyArgs,
        lease: childLease!,
      });
      assert.ok(token);
      assert.equal(authority.currentRequestSourceArgumentAuthorityMatches({
        authority: token,
        ...task,
        logicalToolCallId,
        tool,
        args: providerReadyArgs,
        lease: childLease!,
      }), true);
      for (const widenedArgs of [
        { ...providerReadyArgs, limit: 10 },
        { ...providerReadyArgs, locale: 'all' },
        { ...providerReadyArgs, runInput: { searchStringsArray: ['restaurants in Santa Barbara CA'] } },
      ]) {
        assert.equal(authority.currentRequestSourceArgumentAuthorityMatches({
          authority: token,
          ...task,
          logicalToolCallId,
          tool,
          args: widenedArgs,
          lease: childLease!,
        }), false, `widened args were admitted: ${JSON.stringify(widenedArgs)}`);
      }
      const structuralReplay = JSON.parse(JSON.stringify(token)) as unknown;
      assert.equal(authority.currentRequestSourceArgumentAuthorityMatches({
        authority: structuralReplay,
        ...task,
        logicalToolCallId,
        tool,
        args: providerReadyArgs,
        lease: childLease!,
      }), false, 'a structural/JSON lookalike acquired opaque authority');
      assert.equal(authority.currentRequestSourceArgumentAuthorityMatches({
        authority: token,
        ...task,
        logicalToolCallId: 'model:other-call',
        tool,
        args: providerReadyArgs,
        lease: childLease!,
      }), false, 'the token crossed logical-call identity');
      assert.equal(authority.currentRequestSourceArgumentAuthorityMatches({
        authority: token,
        ...task,
        acceptedTaskId: `${task.acceptedTaskId}:other`,
        logicalToolCallId,
        tool,
        args: providerReadyArgs,
        lease: childLease!,
      }), false, 'the token crossed accepted-task identity');
      const nextSourceUserSeq = task.sourceUserSeq + 1;
      assert.equal(authority.currentRequestSourceArgumentAuthorityMatches({
        authority: token,
        ...task,
        sourceUserSeq: nextSourceUserSeq,
        acceptedTaskId: identities.acceptedTaskIdFor(task.sessionId, nextSourceUserSeq),
        logicalToolCallId,
        tool,
        args: providerReadyArgs,
        lease: childLease!,
      }), false, 'the token replayed into a later accepted source/turn');
    });
  });

  assert.ok(token && childLease);
  leases.revokeDispatchLease(childLease);
  await leases.runWithDispatchLease(childLease, async () => {
    assert.equal(authority.currentRequestSourceArgumentAuthorityMatches({
      authority: token,
      ...task,
      logicalToolCallId,
      tool,
      args: providerReadyArgs,
      lease: childLease!,
    }), false, 'a revoked lease replayed its argument token');
  });
  leases.revokeDispatchLease(task.parentLease);
});
