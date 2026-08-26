/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/io-fence.test.ts */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-io-fence-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-io-fence\n', 'utf8');

const eventlog = await import('./eventlog.js');
const shadow = await import('../graph/turn-graph-shadow.js');
const dispatch = await import('./dispatch-ledger.js');
const identities = await import('./attempt-identity.js');
const { openEventLog } = eventlog;
const { readCanonicalGraphNodeLease, encodeCanonicalOwnerFence } = await import('./canonical-graph-node-lease.js');
const { writeCanonicalGraphNodeLeaseFixture } = await import('./canonical-graph-node-lease.fixture.js');
const { claimPhysicalIo, physicalIoClaimed } = await import('./physical-io-claim.js');
const { derivePhysicalDispatchId } = await import('./physical-crossing-identity.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');
const { removeV65StructuresFromHistoricalMigrationFixture } = await import('./historical-migration-fixture.testsupport.js');

const GRAPH = { graphId: 'g', nodeId: 'n' };
let serial = 0;

/** Reserve one crossing through the production ledger path, unclaimed. */
function reserve(): { sessionId: string; sourceUserSeq: number; physicalDispatchId: string } {
  const session = eventlog.createSession({ id: `io-fence-${++serial}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the workbook.' },
  });
  assert.ok(shadow.recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  const started = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: session.id,
      sourceUserSeq: source.seq,
      acceptedTaskId: identities.acceptedTaskIdFor(session.id, source.seq),
      logicalToolCallId: 'logical:n',
      physicalDispatchId: 'phys:n:1',
      ordinal: 0,
    },
    tool: 'host_create',
    args: { title: 'Workbook' },
  });
  assert.equal(started.status, 'inserted');
  if (started.status !== 'inserted') throw new Error('fixture reservation was not admitted');
  return {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    physicalDispatchId: started.identity.physicalDispatchId,
  };
}

function authorityFor(input: {
  sessionId: string;
  sourceUserSeq: number;
  physicalDispatchId: string;
  ownerFence: string;
}): never {
  return {
    acceptedSource: { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq },
    graphId: GRAPH.graphId,
    nodeId: GRAPH.nodeId,
    physicalDispatchId: input.physicalDispatchId,
    ownerFence: input.ownerFence,
  } as never;
}

test('the latest schema retains schema 49 I/O claims on the reservation itself', () => {
  const db = openEventLog();
  assert.ok(HARNESS_SCHEMA_VERSION >= 52);
  const columns = new Set(
    (db.prepare('PRAGMA table_info(physical_dispatches)').all() as Array<{ name: string }>)
      .map((row) => row.name),
  );
  for (const column of ['io_claimed_at', 'io_owner', 'io_fence', 'io_revision']) {
    assert.ok(columns.has(column), `physical_dispatches must own ${column}`);
  }
  // The parallel ledger is gone, not merely unused.
  const legacy = db.prepare(
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'graph_dispatch_io'`,
  ).get();
  assert.equal(legacy, undefined, 'graph_dispatch_io must not exist after migration');
});

test('a stale owner cannot claim I/O after a legitimate lease takeover', () => {
  const { physicalDispatchId, ...identity } = reserve();
  writeCanonicalGraphNodeLeaseFixture({
    ...identity, ...GRAPH, owner: 'old-owner', fence: 1, revision: 1,
    expiresAt: Date.now() - 1, released: false,
  });
  writeCanonicalGraphNodeLeaseFixture({
    ...identity, ...GRAPH, owner: 'new-owner', fence: 2, revision: 2,
    expiresAt: Date.now() + 60_000, released: false,
  });
  assert.equal(readCanonicalGraphNodeLease({ ...identity, ...GRAPH })?.owner, 'new-owner');

  const stale = claimPhysicalIo({
    identity: { ...identity, physicalDispatchId },
    authority: authorityFor({
      ...identity,
      physicalDispatchId,
      ownerFence: encodeCanonicalOwnerFence({ owner: 'old-owner', fence: 1, revision: 1 }),
    }),
    currentOwnerFence: encodeCanonicalOwnerFence({ owner: 'old-owner', fence: 1, revision: 1 }),
  });
  assert.deepEqual(stale, { claimed: false, reason: 'lease_not_current' });
  assert.equal(physicalIoClaimed({ ...identity, physicalDispatchId }), false);

  // The current owner takes over the still-unclaimed reservation exactly once.
  const takeover = claimPhysicalIo({
    identity: { ...identity, physicalDispatchId },
    authority: authorityFor({
      ...identity,
      physicalDispatchId,
      ownerFence: encodeCanonicalOwnerFence({ owner: 'new-owner', fence: 2, revision: 2 }),
    }),
    currentOwnerFence: encodeCanonicalOwnerFence({ owner: 'new-owner', fence: 2, revision: 2 }),
  });
  assert.deepEqual(takeover, { claimed: true });
  assert.equal(physicalIoClaimed({ ...identity, physicalDispatchId }), true);
});

test('a claimed reservation is never claimed twice, by any owner', () => {
  const { physicalDispatchId, ...identity } = reserve();
  writeCanonicalGraphNodeLeaseFixture({
    ...identity, ...GRAPH, owner: 'owner-a', fence: 1, revision: 1,
    expiresAt: Date.now() + 60_000, released: false,
  });
  const ownerFenceA = encodeCanonicalOwnerFence({ owner: 'owner-a', fence: 1, revision: 1 });
  const authority = authorityFor({ ...identity, physicalDispatchId, ownerFence: ownerFenceA });
  assert.deepEqual(claimPhysicalIo({ identity: { ...identity, physicalDispatchId }, authority, currentOwnerFence: ownerFenceA }), { claimed: true });
  // Same owner replaying the same activation gets no second crossing.
  assert.deepEqual(
    claimPhysicalIo({ identity: { ...identity, physicalDispatchId }, authority, currentOwnerFence: ownerFenceA }),
    { claimed: false, reason: 'already_claimed' },
  );

  // A later legitimate owner also cannot redispatch a claimed crossing.
  writeCanonicalGraphNodeLeaseFixture({
    ...identity, ...GRAPH, owner: 'owner-b', fence: 2, revision: 2,
    expiresAt: Date.now() + 60_000, released: false,
  });
  assert.deepEqual(
    claimPhysicalIo({
      identity: { ...identity, physicalDispatchId },
      authority: authorityFor({
        ...identity,
        physicalDispatchId,
        ownerFence: encodeCanonicalOwnerFence({ owner: 'owner-b', fence: 2, revision: 2 }),
      }),
      currentOwnerFence: encodeCanonicalOwnerFence({ owner: 'owner-b', fence: 2, revision: 2 }),
    }),
    { claimed: false, reason: 'already_claimed' },
  );

  const claims = openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatches
      WHERE session_id = ? AND io_claimed_at IS NOT NULL`,
  ).get(identity.sessionId) as { n: number };
  assert.equal(claims.n, 1, 'exactly one crossing may be claimed');
});

test('a claim cannot be minted without a matching reservation or authority', () => {
  const identity = { sessionId: 'sess-mint', sourceUserSeq: 1 };
  const physicalDispatchId = 'phys:n:1';
  writeCanonicalGraphNodeLeaseFixture({
    ...identity, ...GRAPH, owner: 'owner-a', fence: 1, revision: 1,
    expiresAt: Date.now() + 60_000, released: false,
  });
  const ownerFence = encodeCanonicalOwnerFence({ owner: 'owner-a', fence: 1, revision: 1 });

  // No reservation exists: a caller cannot conjure one by asking.
  assert.deepEqual(
    claimPhysicalIo({
      identity: { ...identity, physicalDispatchId },
      authority: authorityFor({ ...identity, physicalDispatchId, ownerFence }),
      currentOwnerFence: ownerFence,
    }),
    { claimed: false, reason: 'no_reservation' },
  );

  // On a real reservation, authority describing a different crossing is refused.
  const { physicalDispatchId: realDispatchId, ...real } = reserve();
  const realFence = encodeCanonicalOwnerFence({ owner: 'owner-a', fence: 1, revision: 1 });
  writeCanonicalGraphNodeLeaseFixture({
    ...real, ...GRAPH, owner: 'owner-a', fence: 1, revision: 1,
    expiresAt: Date.now() + 60_000, released: false,
  });
  assert.deepEqual(
    claimPhysicalIo({
      identity: { ...real, physicalDispatchId: realDispatchId },
      authority: authorityFor({ ...real, physicalDispatchId: 'phys:other:9', ownerFence: realFence }),
      currentOwnerFence: realFence,
    }),
    { claimed: false, reason: 'authority_mismatch' },
  );
  assert.deepEqual(
    claimPhysicalIo({
      identity: { ...real, physicalDispatchId: realDispatchId },
      authority: authorityFor({
        ...real, sessionId: 'sess-elsewhere', physicalDispatchId: realDispatchId, ownerFence: realFence,
      }),
      currentOwnerFence: realFence,
    }),
    { claimed: false, reason: 'authority_mismatch' },
  );
  assert.deepEqual(
    claimPhysicalIo({
      identity: { ...real, physicalDispatchId: realDispatchId },
      authority: authorityFor({ ...real, physicalDispatchId: realDispatchId, ownerFence: 'not-a-fence' }),
      currentOwnerFence: 'not-a-fence',
    }),
    { claimed: false, reason: 'malformed_owner_fence' },
  );
  assert.equal(physicalIoClaimed({ ...real, physicalDispatchId: realDispatchId }), false);
});

test('schema 49 carries a claimed legacy I/O marker onto its reservation', () => {
  const { physicalDispatchId, ...identity } = reserve();
  const db = openEventLog();

  // Rebuild the v48 shape: the claim lived in a separate runtime-created table.
  db.exec(`
    CREATE TABLE graph_dispatch_io (
      physical_dispatch_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      logical_tool_call_id TEXT NOT NULL,
      io_started INTEGER NOT NULL DEFAULT 0,
      io_owner TEXT,
      io_fence INTEGER,
      io_revision INTEGER
    );
  `);
  db.prepare(`
    INSERT INTO graph_dispatch_io
      (physical_dispatch_id, session_id, source_user_seq, logical_tool_call_id,
       io_started, io_owner, io_fence, io_revision)
    VALUES (?, ?, ?, 'logical:n', 1, 'legacy-owner', 7, 3)
  `).run(physicalDispatchId, identity.sessionId, identity.sourceUserSeq);
  db.prepare(
    `UPDATE physical_dispatches SET io_claimed_at = NULL, io_owner = NULL,
            io_fence = NULL, io_revision = NULL
      WHERE session_id = ? AND physical_dispatch_id = ?`,
  ).run(identity.sessionId, physicalDispatchId);
  // The runner resumes from MAX(version), so this rewind replays v50..v65 too:
  // shed what those replays may not meet twice.
  removeV65StructuresFromHistoricalMigrationFixture(db);
  db.prepare('DELETE FROM schema_version WHERE version >= 49').run();
  assert.equal(physicalIoClaimed({ ...identity, physicalDispatchId }), false);

  eventlog.closeEventLog();
  const upgraded = openEventLog();

  // The claim survived the fold, and the parallel table is gone.
  assert.equal(physicalIoClaimed({ ...identity, physicalDispatchId }), true);
  const row = upgraded.prepare(
    `SELECT io_owner AS owner, io_fence AS fence, io_revision AS revision
       FROM physical_dispatches WHERE session_id = ? AND physical_dispatch_id = ?`,
  ).get(identity.sessionId, physicalDispatchId) as { owner: string; fence: number; revision: number };
  assert.deepEqual(row, { owner: 'legacy-owner', fence: 7, revision: 3 });
  assert.equal(
    upgraded.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='graph_dispatch_io'`).get(),
    undefined,
  );
});

test('RED: after a crash, a legitimate new owner cannot use the unclaimed reservation', () => {
  // Production shape: owner A reserves and its authority is persisted carrying
  // A's fence. A crashes; its lease expires; B legitimately takes the lease.
  // On replay, production reloads the PERSISTED authority — which still carries
  // A's fence — so ownership is judged against a frozen string instead of the
  // live lease.
  const { physicalDispatchId, ...identity } = reserve();
  writeCanonicalGraphNodeLeaseFixture({
    ...identity, ...GRAPH, owner: 'owner-a', fence: 1, revision: 1,
    expiresAt: Date.now() - 1, released: false,
  });
  const persistedAuthority = authorityFor({
    ...identity,
    physicalDispatchId,
    ownerFence: encodeCanonicalOwnerFence({ owner: 'owner-a', fence: 1, revision: 1 }),
  });

  writeCanonicalGraphNodeLeaseFixture({
    ...identity, ...GRAPH, owner: 'owner-b', fence: 2, revision: 2,
    expiresAt: Date.now() + 60_000, released: false,
  });
  assert.equal(readCanonicalGraphNodeLease({ ...identity, ...GRAPH })?.owner, 'owner-b');
  assert.equal(physicalIoClaimed({ ...identity, physicalDispatchId }), false);

  // The reservation is unclaimed and owner-b holds a current lease, so exactly
  // one call should still be possible. Today the persisted authority makes the
  // crossing permanently unusable: B can neither invoke nor take over.
  const takeover = claimPhysicalIo({
    identity: { ...identity, physicalDispatchId },
    authority: persistedAuthority,
    currentOwnerFence: encodeCanonicalOwnerFence({ owner: 'owner-b', fence: 2, revision: 2 }),
  });
  assert.deepEqual(takeover, { claimed: true }, 'a current lease holder must be able to take an unclaimed reservation');
});

test('the ledger cannot yet admit a recovery probe as its own crossing', () => {
  // Phase 2 blocker, pinned so it cannot be forgotten or silently "fixed" by a
  // caller inventing a relation. Reconciliation must become a linked probe
  // crossing, but the ledger assigns relation itself -- retryOf => 'retry',
  // otherwise ordinal 1 => 'primary' and any later ordinal => 'child'. Nothing
  // assigns 'probe', so a recovery cannot currently be reserved, fenced,
  // counted or deduplicated as its own crossing.
  const { physicalDispatchId, ...identity } = reserve();
  const acceptedTaskId = identities.acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq);
  const probeId = derivePhysicalDispatchId({
    sessionId: identity.sessionId,
    sourceUserSeq: identity.sourceUserSeq,
    graphId: GRAPH.graphId,
    nodeId: GRAPH.nodeId,
    logicalCallId: 'logical:n',
    ordinal: 1,
    relation: 'probe',
  });
  assert.notEqual(probeId, physicalDispatchId, 'a probe identity is distinct from the write it recovers');

  const attempted = dispatch.beginPhysicalDispatch({
    identity: {
      sessionId: identity.sessionId,
      sourceUserSeq: identity.sourceUserSeq,
      acceptedTaskId,
      logicalToolCallId: 'logical:n',
      physicalDispatchId: probeId,
      ordinal: 2,
      retryOf: physicalDispatchId,
    },
    tool: 'host_create',
    args: { title: 'Workbook' },
    relation: 'probe',
  });
  assert.deepEqual(
    attempted,
    { status: 'conflict', reason: 'caller relation does not match the host-assigned crossing' },
    'a caller must not be able to mint a probe relation the host never assigns',
  );
  const probes = openEventLog().prepare(
    `SELECT COUNT(*) AS n FROM physical_dispatches WHERE session_id = ? AND relation = 'probe'`,
  ).get(identity.sessionId) as { n: number };
  assert.equal(probes.n, 0, 'no probe crossing exists until the ledger can assign the relation');
});
