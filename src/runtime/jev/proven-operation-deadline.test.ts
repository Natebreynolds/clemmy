import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-proven-deadline-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const { prepareProvenOperationForRequest, PROVEN_PICK_BUDGET_MS } = await import('./proven-operation.js');
const { recordRunStrategy } = await import('../../memory/run-strategy-store.js');
const { evaluateLearningCandidate } = await import('../../memory/learning-receipt.js');
const { createSession, appendEvent } = await import('../harness/eventlog.js');
const { provenCapabilityEntriesForTurn } = await import('../harness/capability-resolution.js');
const { _setToolSchemaLoaderForTests } = await import('../../tools/composio-schema-cache.js');
// The unmodified heartbeat remains local even when an operation is not cached.
_setToolSchemaLoaderForTests(async () => null);
after(() => {
  _setToolSchemaLoaderForTests(null);
  rmSync(HOME, { recursive: true, force: true });
});

const OPERATION = 'quasar__deadline_summary';
const QUERY = 'Read the quasar deadline summary';
const receipt = evaluateLearningCandidate({
  target: 'strategy', authority: 'background_delivery_verifier',
  sessionId: 'background:deadline-fixture', sourceId: 'deadline-fixture',
  terminalSuccess: true, controllerValidation: true,
}).receipt;
assert.ok(receipt);
const remembered = recordRunStrategy({
  objective: 'Inspect distant archive indices', toolsUsed: [OPERATION],
  workerCount: 0, durationMs: 1, scope: 'chat', learningReceipt: receipt,
});
assert.ok(remembered);

for (const kind of ['strategy', 'route'] as const) {
  for (const blocked of [true, false]) {
    test(`${blocked ? 'an overdue' : 'a timely'} ${kind} decision ${blocked ? 'cannot beat a delayed timer' : 'retains its exact source acquisition'}`, async (t) => {
      const session = createSession({ kind: 'chat', channel: 'desktop', title: 'deadline admission fixture' });
      const source = appendEvent({
        sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: QUERY },
      });
      const identity = { sessionId: session.id, sourceUserSeq: source.seq };
      assert.deepEqual(provenCapabilityEntriesForTurn(identity), []);
      const acquired: Array<{ operation: string; identity: typeof identity }> = [];
      let decisions = 0;
      let positiveReturned = false;
      let blockedForMs = 0;
      const prepared = await prepareProvenOperationForRequest({ query: QUERY, ...identity, acceptedInput: QUERY }, {
        decideTurnStart: async (request, strategies, operations, options) => {
          decisions += 1;
          assert.equal(request, QUERY);
          assert.equal(options?.sessionId, session.id);
          assert.equal(options?.timeoutMs, PROVEN_PICK_BUDGET_MS);
          const strategy = strategies.find((row) => row.id === remembered.id);
          const operation = operations.find((row) => row.id === OPERATION);
          assert.ok(strategy, 'a real verified run is offered despite different request wording');
          assert.ok(operation, 'the operation is a real candidate, not an invented reply ID');
          if (blocked) {
            const started = performance.now();
            // No timer callback can run while this isolated synchronous work
            // is active. The fulfilled decision microtask precedes that timer.
            while (performance.now() - started < PROVEN_PICK_BUDGET_MS + 50) { /* controlled event-loop stall */ }
            blockedForMs = performance.now() - started;
          }
          positiveReturned = true;
          return {
            strategy: kind === 'strategy' ? strategy : null,
            route: kind === 'route'
              ? { pick: operation, outcome: 'picked' as const, confidence: 1, fit: 1 }
              : { pick: null, outcome: 'none' as const },
            failedOpen: false,
          };
        },
        acquireLiveRead: async ({ operation, identity: currentIdentity }) => {
          acquired.push({ operation, identity: currentIdentity });
          return { status: 'installed', kind: 'mcp', operation, accountId: 'fixture-current-account' };
        },
      });
      const entries = provenCapabilityEntriesForTurn(identity);
      t.diagnostic(JSON.stringify({ kind, blocked, decisions, positiveReturned,
        blockedForMs, decisionWaitMs: prepared.decisionWaitMs,
        acquisitions: acquired.length, capabilityEntries: entries.length,
        selected: prepared.strategyId !== undefined }));
      assert.equal(decisions, 1);
      assert.equal(positiveReturned, true, 'the decision actually resolves positively');
      if (blocked) {
        assert.ok(blockedForMs > PROVEN_PICK_BUDGET_MS);
        assert.equal(prepared.strategyId, undefined, 'an overdue fulfilled decision is unavailable, even before the timer callback');
        assert.equal(prepared.pickedBy, undefined);
        assert.equal(prepared.text, undefined);
        assert.deepEqual(prepared.tools, []);
        assert.deepEqual(prepared.nativeTools, []);
        assert.deepEqual(prepared.liveReads, []);
        assert.deepEqual(prepared.capabilityRefs, []);
        assert.deepEqual(prepared.descriptors, []);
        assert.deepEqual(prepared.boundAccounts, []);
        assert.equal(prepared.skipDiscoverySearch, false);
        assert.equal(prepared.narrowSurface, false);
        assert.deepEqual(acquired, [], 'late relevance cannot warm or bind a live operation');
        assert.deepEqual(entries, [], 'late relevance cannot publish source capability evidence');
      } else {
        assert.ok((prepared.decisionWaitMs ?? Infinity) < PROVEN_PICK_BUDGET_MS);
        assert.equal(prepared.strategyId, kind === 'strategy' ? remembered.id : `route:${OPERATION}`);
        assert.equal(prepared.pickedBy, kind === 'strategy' ? 'jev' : 'jev_route');
        assert.match(prepared.text ?? '', /quasar__deadline_summary/);
        assert.deepEqual(acquired, [{ operation: OPERATION, identity }]);
        assert.deepEqual(prepared.liveReads, [{ operation: OPERATION, kind: 'mcp', accountId: 'fixture-current-account' }]);
        assert.equal(entries.length, 1);
        assert.equal(entries[0]!.identifier, OPERATION);
        assert.equal(entries[0]!.accountIdentity, 'fixture-current-account');
        assert.equal(prepared.skipDiscoverySearch, false, 'the test creates no callable catalog authority');
        assert.equal(prepared.narrowSurface, false);
      }
    });
  }
}
