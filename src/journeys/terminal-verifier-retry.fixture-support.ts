/** Transactional controls over an already-completed, isolated journey only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { acceptedTaskIdFor } from '../runtime/harness/attempt-identity.js';
import { loadObligationManifest } from '../runtime/harness/obligation-store.js';
import { proveFrozenMutationVerification } from '../runtime/harness/mutation-verification-proof.js';
import { MAX_FROZEN_MUTATION_VERIFICATION_ATTEMPTS, verifierLogicalCallId, verifierLogicalCallAttemptId } from '../runtime/harness/mutation-verification-contract.js';
import { hostCallAttestationBindingDigest, hostCallCapabilityBindingDigest, loadHostCallCapabilityBinding } from '../runtime/harness/host-call-capability-binding.js';
import { verifyAcceptedTaskTerminalProofInTransaction } from '../runtime/harness/terminal-publication-proof.js';

export async function assertTerminalVerifierRetryProofControls(identity: {
  sessionId: string;
  sourceUserSeq: number;
  ownerLogicalToolCallId: string;
}): Promise<number> {
  const original = openEventLog();
  assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1');
  assert.ok(!path.resolve(original.name).startsWith(path.join(os.homedir(), '.clementine-next') + path.sep),
    'these corruption controls must never open the live home');
  const manifest = loadObligationManifest(identity.sessionId, identity.sourceUserSeq);
  assert.ok(manifest, 'the actual accepted journey must have its canonical manifest');
  const proof = proveFrozenMutationVerification(identity);
  assert.equal(proof.status, 'verified');
  if (proof.status !== 'verified') throw new Error('fixture has no verified mutation');
  assert.equal(MAX_FROZEN_MUTATION_VERIFICATION_ATTEMPTS, 3);
  const base = verifierLogicalCallId({
    acceptedTaskId: proof.recipe.acceptedTaskId,
    workContractId: proof.recipe.workContractId,
    ownerRequirementId: proof.recipe.ownerRequirementId,
    ownerBindingDigest: proof.recipe.ownerBindingDigest,
    recipeDigest: proof.recipe.recipeDigest,
    proof: proof.recipe.proof,
    targetDigest: proof.targetDigest,
  });
  assert.equal(proof.verifierLogicalCallId, verifierLogicalCallAttemptId(base, 1),
    'the fixture must exercise a successful retry, not a successful original read');
  const failedBase = original.prepare(`SELECT result_handle_id FROM logical_call_settlements
    WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?`)
    .get(identity.sessionId, identity.sourceUserSeq, base) as { result_handle_id: string | null } | undefined;
  assert.ok(failedBase && failedBase.result_handle_id === null, 'the failed original cannot supply result authority');
  const image = original.serialize();
  const before = createHash('sha256').update(image).digest('hex');
  const exact = { sessionId: identity.sessionId, sourceUserSeq: identity.sourceUserSeq,
    acceptedTaskId: acceptedTaskIdFor(identity.sessionId, identity.sourceUserSeq), manifest };
  const retryIdentity = [identity.sessionId, identity.sourceUserSeq, proof.verifierLogicalCallId] as const;
  const prove = (db: Database.Database) => db.transaction(() =>
    verifyAcceptedTaskTerminalProofInTransaction({ db, ...exact })).immediate();

  const corruptBinding = (db: Database.Database, property: 'accountId' | 'schemaFingerprint' | 'providerInputSchemaDigest', value: string) => {
    const loaded = loadHostCallCapabilityBinding({ db, ...identity, logicalToolCallId: proof.verifierLogicalCallId });
    assert.equal(loaded.status, 'ok');
    if (loaded.status !== 'ok') throw new Error('fixture binding is not exact');
    const modified = { ...loaded.binding, [property]: value };
    modified.hostBindingDigest = hostCallAttestationBindingDigest(modified);
    const { effectiveArgumentDigest: _effective, durableBindingDigest: _durable, boundAt: _at, ...durable } = modified;
    modified.durableBindingDigest = hostCallCapabilityBindingDigest(durable);
    const column = { accountId: 'account_id', schemaFingerprint: 'schema_fingerprint',
      providerInputSchemaDigest: 'provider_input_schema_digest' }[property];
    db.prepare(`UPDATE host_call_capability_bindings SET ${column}=?,host_binding_digest=?,durable_binding_digest=?
      WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?`)
      .run(value, modified.hostBindingDigest, modified.durableBindingDigest, ...retryIdentity);
    assert.equal(loadHostCallCapabilityBinding({ db, ...identity, logicalToolCallId: proof.verifierLogicalCallId }).status, 'ok',
      'self-consistent binding hashes must not bypass the frozen recipe comparison');
  };
  const controls: Array<[string, (db: Database.Database) => void]> = [
    ['another account', db => corruptBinding(db, 'accountId', 'fixture-other-account')],
    ['another schema', db => corruptBinding(db, 'schemaFingerprint', 'f'.repeat(64))],
    ['another provider input schema', db => corruptBinding(db, 'providerInputSchemaDigest', 'e'.repeat(64))],
    ['missing selected retry result', db => {
      assert.equal(db.prepare('DELETE FROM durable_result_handles WHERE handle_id=?').run(proof.verifierResultHandleId).changes, 1);
    }],
    ['another source result', db => {
      assert.equal(db.prepare('UPDATE durable_result_handles SET source_user_seq=source_user_seq+1 WHERE handle_id=?')
        .run(proof.verifierResultHandleId).changes, 1);
    }],
    ['unsettled selected crossing', db => {
      assert.equal(db.prepare(`UPDATE physical_dispatches SET state='started' WHERE session_id=? AND source_user_seq=? AND physical_dispatch_id=?`)
        .run(identity.sessionId, identity.sourceUserSeq, proof.verifierPhysicalDispatchId).changes, 1);
    }],
    ['unacknowledged selected result with consistent byte hash', db => {
      const raw = JSON.stringify({ data: {}, error: 'controlled refusal', successful: false });
      assert.equal(db.prepare('UPDATE durable_result_handles SET raw_payload_json=?,raw_payload_sha256=?,raw_byte_count=? WHERE handle_id=?')
        .run(raw, createHash('sha256').update(raw).digest('hex'), Buffer.byteLength(raw), proof.verifierResultHandleId).changes, 1);
    }],
    ['changed receipt identity', db => {
      assert.ok(db.prepare(`UPDATE host_write_receipts SET provider_receipt='fixture-wrong-verifier-receipt'
        WHERE session_id=? AND source_user_seq=? AND logical_tool_call_id=?`)
        .run(identity.sessionId, identity.sourceUserSeq, identity.ownerLogicalToolCallId).changes > 0);
    }],
  ];
  const fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), 'clem-terminal-retry-proof-'));
  try {
    const snapshotPath = path.join(fixtureDirectory, 'canonical-snapshot.sqlite');
    // SQLite's backup API produces a complete snapshot without changing source
    // journal state. Normalize only that disposable copy to a standalone file.
    await original.backup(snapshotPath);
    const snapshot = new Database(snapshotPath);
    try { snapshot.pragma('journal_mode = DELETE'); }
    finally { snapshot.close(); }
    const openClone = async (name: string): Promise<Database.Database> => {
      const clonePath = path.join(fixtureDirectory, `${name}.sqlite`);
      await copyFile(snapshotPath, clonePath);
      return new Database(clonePath);
    };
    const clean = await openClone('clean');
    try { assert.deepEqual(prove(clean), { ok: true }, 'the actual successful retry satisfies terminal proof'); }
    finally { clean.close(); }
    for (const [index, [label, corrupt]] of controls.entries()) {
      const clone = await openClone(`control-${index}`);
      try {
        // Deliberately simulate retained-byte corruption in a disposable clone.
        // Production immutability triggers and the original fixture are untouched.
        clone.pragma('foreign_keys = OFF');
        for (const row of clone.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>) {
          clone.exec(`DROP TRIGGER "${row.name.replace(/"/g, '""')}"`);
        }
        corrupt(clone);
        const denied = prove(clone);
        assert.equal(denied.ok, false, `${label} must not borrow another successful read`);
        if (!denied.ok) assert.equal(denied.status, 'conflict', label);
      } finally { clone.close(); }
    }
  } finally { await rm(fixtureDirectory, { recursive: true, force: true }); }
  assert.equal(createHash('sha256').update(original.serialize()).digest('hex'), before,
    'the actual accepted journey and all its receipts remain byte-for-byte unchanged');
  return controls.length;
}
