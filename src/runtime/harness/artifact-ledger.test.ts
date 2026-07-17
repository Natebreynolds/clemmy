import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-artifact-ledger-'));
process.env.CLEMENTINE_HOME = home;

const eventlog = await import('./eventlog.js');
const ledger = await import('./artifact-ledger.js');

beforeEach(() => {
  eventlog.resetEventLog();
  ledger._resetArtifactLedgerForTests();
});

after(() => rmSync(home, { recursive: true, force: true }));

function session(): string {
  return eventlog.createSession({ kind: 'chat' }).id;
}

test('classifies Google Docs create calls across Composio and native MCP names', () => {
  const gateway = ledger.artifactIntentForTool('composio_execute_tool', {
    tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
    arguments: JSON.stringify({ title: 'Client snapshot', markdown_text: '# Hi' }),
  });
  assert.deepEqual(gateway, {
    kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary',
    title: 'Client snapshot', createShape: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
  });

  const native = ledger.artifactIntentForTool('mcp__googledocs__create_document', {
    title: 'Second', artifact_key: 'appendix',
  });
  assert.equal(native?.slotKey, 'google_doc:appendix');
  assert.equal(native?.title, 'Second');
});

test('explicit multi-document objectives receive deterministic distinct slots while ordinary renamed retries stay primary', () => {
  const firstRaw = { title: 'Client brief' };
  const secondRaw = { title: 'Technical appendix' };
  const first = ledger.artifactIntentForTool('mcp__googledocs__create_document', firstRaw)!;
  const second = ledger.artifactIntentForTool('mcp__googledocs__create_document', secondRaw)!;
  const objective = 'Create two separate Google Docs: a client brief and a technical appendix.';
  assert.equal(
    ledger.scopeArtifactIntentForObjective(first, objective, firstRaw).slotKey,
    'google_doc:client-brief',
  );
  assert.equal(
    ledger.scopeArtifactIntentForObjective(second, objective, secondRaw).slotKey,
    'google_doc:technical-appendix',
  );
  assert.equal(
    ledger.scopeArtifactIntentForObjective(second, 'Create a Google Doc about the firm.', secondRaw).slotKey,
    'google_doc:primary',
    'a renamed retry in a single-artifact objective must not mint a sibling',
  );
  const siteRaw = { command: 'netlify sites:create --name client-portal' };
  const site = ledger.artifactIntentForTool('run_shell_command', siteRaw)!;
  assert.equal(
    ledger.scopeArtifactIntentForObjective(site, 'Create two separate sites for the client.', siteRaw).slotKey,
    'site:client-portal',
  );
});

test('titleless multi-artifact retries fail closed on primary despite changed mutable content', () => {
  const sid = session();
  const objective = 'Create two separate Google Docs for the client.';
  const firstRaw = { markdown_text: '# Draft one' };
  const retryRaw = { markdown_text: '# Rewritten draft with different formatting' };
  const first = ledger.scopeArtifactIntentForObjective(
    ledger.artifactIntentForTool('mcp__googledocs__create_document', firstRaw)!,
    objective,
    firstRaw,
  );
  const retry = ledger.scopeArtifactIntentForObjective(
    ledger.artifactIntentForTool('mcp__googledocs__create_document', retryRaw)!,
    objective,
    retryRaw,
  );
  assert.equal(first.slotKey, 'google_doc:primary');
  assert.equal(retry.slotKey, first.slotKey, 'mutable body text is not a durable output identity');
  assert.equal(ledger.claimArtifactSlot(sid, first, 'call-titleless-1', 'run:titleless').acquired, true);
  assert.equal(
    ledger.claimArtifactSlot(sid, retry, 'call-titleless-2', 'run:titleless').acquired,
    false,
    'the rewritten retry cannot mint a second remote document',
  );
});

test('does not classify document subresource creation as a new document', () => {
  assert.equal(ledger.artifactIntentForTool('googledocs__create_tab', { title: 'Tab' }), null);
  assert.equal(ledger.artifactIntentForTool('googledocs__create_header', {}), null);
});

test('guarded additive migration upgrades the original artifact table without losing rows', () => {
  const sid = session();
  const db = eventlog.openEventLog();
  db.exec(`
    DROP TABLE IF EXISTS run_artifacts;
    CREATE TABLE run_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_scope_id TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      title TEXT,
      create_shape TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','bound','uncertain')),
      resource_id TEXT,
      uri TEXT,
      source_call_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, run_scope_id, slot_key)
    );
  `);
  db.prepare(`
    INSERT INTO run_artifacts
      (id, session_id, run_scope_id, slot_key, kind, provider, title, create_shape,
       status, resource_id, uri, source_call_id, created_at, updated_at)
    VALUES ('legacy-artifact', ?, 'run:legacy', 'google_doc:primary', 'google_doc',
      'Google Docs', 'Legacy', 'CREATE', 'bound', 'legacy_doc_123456789',
      'https://docs.google.com/document/d/legacy_doc_123456789/edit', 'legacy-call',
      '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z')
  `).run(sid);
  ledger._resetArtifactLedgerForTests();

  const [migrated] = ledger.listRunArtifacts(sid, 'run:legacy');
  assert.equal(migrated?.resourceId, 'legacy_doc_123456789');
  assert.equal(migrated?.bindingVerifiedAt, null);
  const columns = db.prepare('PRAGMA table_info(run_artifacts)').all() as Array<{ name: string }>;
  for (const name of [
    'binding_verified_at', 'verification_call_id', 'verification_shape', 'verification_fingerprint',
  ]) assert.ok(columns.some((column) => column.name === name), name);
});

test('classifies only exact-id Google Docs read-backs', () => {
  const gateway = ledger.artifactVerificationIntentForTool('composio_execute_tool', {
    tool_slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
    arguments: JSON.stringify({ document_id: 'doc_exact_123456789' }),
  });
  assert.deepEqual(gateway, {
    kind: 'google_doc', provider: 'Google Docs', resourceId: 'doc_exact_123456789',
    verificationShape: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
  });
  assert.equal(
    ledger.artifactVerificationIntentForTool('mcp__googledocs__get_document', { document_id: 'native_doc_123456789' })?.resourceId,
    'native_doc_123456789',
  );
  assert.equal(ledger.artifactVerificationIntentForTool('composio_execute_tool', {
    tool_slug: 'GOOGLEDOCS_GET_DOCUMENT_END_INDEX', arguments: '{"document_id":"doc"}',
  }), null);
  assert.equal(ledger.artifactVerificationIntentForTool('composio_execute_tool', {
    tool_slug: 'GOOGLEDOCS_SEARCH_DOCUMENTS', arguments: '{"query":"title"}',
  }), null);
});

test('an artifact slot is claimed once and remains reusable after binding', () => {
  const sid = session();
  const intent = ledger.artifactIntentForTool('composio_execute_tool', {
    tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
    arguments: JSON.stringify({ title: 'One document' }),
  })!;
  const first = ledger.claimArtifactSlot(sid, intent, 'call-1');
  assert.equal(first.acquired, true);
  const bound = ledger.bindArtifactSlot(sid, intent.slotKey, {
    resourceId: 'doc_1234567890', uri: 'https://docs.google.com/document/d/doc_1234567890/edit',
  }, 'call-1');
  assert.equal(bound.status, 'bound');
  assert.equal(bound.bindingVerifiedAt, null, 'a create response binds but does not independently verify');

  const retry = ledger.claimArtifactSlot(sid, { ...intent, title: 'Renamed retry' }, 'call-2');
  assert.equal(retry.acquired, false, 'a changed title cannot mint a second primary document');
  assert.equal(retry.artifact.resourceId, 'doc_1234567890');
  assert.match(ledger.artifactReuseMessage(retry.artifact), /Reuse or update/);
});

test('claim settlement is owned by the provider call id, not just the slot', () => {
  const sid = session();
  const intent = {
    kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary',
    title: 'Owned claim', createShape: 'GOOGLEDOCS_CREATE_DOCUMENT',
  } as const;
  const claim = ledger.claimArtifactSlot(sid, intent, 'toolu-owner', 'run:owned');
  assert.equal(claim.acquired, true);
  assert.equal(
    ledger.bindClaimedArtifact(claim.artifact.id, 'toolu-sibling', { resourceId: 'wrong-doc' }),
    null,
    'an out-of-order sibling result cannot settle this row',
  );
  assert.equal(ledger.getRunArtifact(sid, intent.slotKey, 'run:owned')?.status, 'pending');
  const bound = ledger.bindClaimedArtifact(claim.artifact.id, 'toolu-owner', { resourceId: 'right-doc' });
  assert.equal(bound?.resourceId, 'right-doc');
});

test('artifact root lineage survives same-turn fallback, manual continue, and restart recovery', () => {
  const sid = session();
  eventlog.appendEvent({
    sessionId: sid, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create a Google Doc about the firm.' },
  });
  const root = ledger.resolveArtifactRunScopeId(sid, 'sdk:attempt-1');
  assert.equal(root, 'sdk:attempt-1');
  assert.equal(
    ledger.resolveArtifactRunScopeId(sid, 'codex:fallback-1'),
    root,
    'a second lane serving the same durable user turn shares the root',
  );
  const intent = {
    kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary',
    title: 'Firm', createShape: 'GOOGLEDOCS_CREATE_DOCUMENT',
  } as const;
  ledger.claimArtifactSlot(sid, intent, 'create-1', root);
  ledger.bindArtifactSlot(sid, intent.slotKey, { resourceId: 'doc-lineage' }, 'create-1', root);

  eventlog.appendEvent({
    sessionId: sid, turn: 1, role: 'system', type: 'conversation_completed',
    data: { reason: 'awaiting_continue', reply: 'Say continue.' },
  });
  eventlog.appendEvent({
    sessionId: sid, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'continue' },
  });
  assert.equal(ledger.resolveArtifactRunScopeId(sid, 'sdk:attempt-2'), root, 'manual continue inherits the root');

  eventlog.appendEvent({
    sessionId: sid, turn: 2, role: 'system', type: 'conversation_completed',
    data: { reason: 'interrupted_by_restart', reply: 'Restarted.' },
  });
  eventlog.appendEvent({
    sessionId: sid, turn: 3, role: 'user', type: 'user_input_received',
    data: { text: 'The previous run in this session was interrupted by a daemon restart and has been automatically resumed.\nInspect the audit trail.' },
  });
  assert.equal(ledger.resolveArtifactRunScopeId(sid, 'sdk:after-restart'), root, 'restart recovery inherits the root');

  eventlog.appendEvent({
    sessionId: sid, turn: 3, role: 'system', type: 'conversation_completed', data: { reason: 'success' },
  });
  eventlog.appendEvent({
    sessionId: sid, turn: 4, role: 'user', type: 'user_input_received',
    data: { text: 'Create a new unrelated Google Doc.' },
  });
  assert.equal(
    ledger.resolveArtifactRunScopeId(sid, 'sdk:new-request'),
    'sdk:new-request',
    'an ordinary new request starts a fresh root',
  );
});

test('artifact lineage honors the bound source sequence instead of a newer unbound input', () => {
  const sid = session();
  const source = eventlog.appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the original firm document.' },
  });
  const root = ledger.resolveArtifactRunScopeId(sid, 'sdk:source-a', source.seq);
  eventlog.appendEvent({
    sessionId: sid,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'A newer unrelated request arrived.' },
  });

  assert.equal(
    ledger.resolveArtifactRunScopeId(sid, 'codex:fallback-source-a', source.seq),
    root,
    'a later unbound input cannot split fallback lineage for the bound attempt',
  );
  assert.equal(ledger.getArtifactRunScope(sid, 'codex:fallback-source-a')?.sourceUserSeq, source.seq);
});

test('one durable source authority makes competing artifact-root candidates converge', () => {
  const sid = session();
  const source = eventlog.appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the requested client document.' },
  });
  // Materialize the ledger's additive schema before modeling the two lanes.
  ledger.listRunArtifacts(sid);
  const db = eventlog.openEventLog();
  // Model the database state after lane A wins while lane B still holds a
  // stale optimistic candidate. SQLite's unique source authority must make B
  // consume A's root instead of persisting its own.
  db.prepare(`
    INSERT INTO artifact_source_roots
      (session_id, source_user_seq, root_scope_id, created_at)
    VALUES (?, ?, 'sdk:lane-a', '2026-07-17T00:00:00.000Z')
  `).run(sid, source.seq);
  const losingInsert = db.prepare(`
    INSERT OR IGNORE INTO artifact_source_roots
      (session_id, source_user_seq, root_scope_id, created_at)
    VALUES (?, ?, 'codex:lane-b', '2026-07-17T00:00:00.001Z')
  `).run(sid, source.seq);
  assert.equal(losingInsert.changes, 0, 'the source event accepts exactly one root authority');

  assert.equal(
    ledger.resolveArtifactRunScopeId(sid, 'codex:lane-b', source.seq),
    'sdk:lane-a',
    'a contender with a different candidate consumes the authoritative root',
  );
  assert.equal(
    ledger.getArtifactRunScope(sid, 'codex:lane-b')?.reason,
    'same_user_turn_fallback',
  );
  const authorities = db.prepare(`
    SELECT root_scope_id
      FROM artifact_source_roots
     WHERE session_id = ? AND source_user_seq = ?
  `).all(sid, source.seq) as Array<{ root_scope_id: string }>;
  assert.deepEqual(authorities, [{ root_scope_id: 'sdk:lane-a' }]);
});

test('a real-session artifact-root persistence failure is fail-closed', () => {
  const sid = session();
  const source = eventlog.appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the client document.' },
  });
  ledger.listRunArtifacts(sid); // materialize additive schema before the trigger
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER artifact_source_roots_fail_test
    BEFORE INSERT ON artifact_source_roots
    BEGIN
      SELECT RAISE(ABORT, 'injected artifact authority persistence failure');
    END;
  `);
  assert.throws(
    () => ledger.resolveArtifactRunScopeId(sid, 'sdk:must-not-escape', source.seq),
    (error: unknown) => error instanceof ledger.ArtifactLineagePersistenceError
      && /injected artifact authority persistence failure/.test(error.message),
  );
  assert.equal(ledger.getArtifactRunScope(sid, 'sdk:must-not-escape'), null);
});

test('only the immediate reply to a typed awaiting-input terminal inherits its exact root', () => {
  const sid = session();
  const request = eventlog.appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the deployment document.' },
  });
  const root = ledger.resolveArtifactRunScopeId(sid, 'sdk:paused', request.seq);
  eventlog.appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reason: 'awaiting_user_input',
      artifactRunScopeId: root,
      reply: 'Which environment should the document cover?',
    },
  });
  const answer = eventlog.appendEvent({
    sessionId: sid,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Production.' },
  });
  assert.equal(ledger.resolveArtifactRunScopeId(sid, 'sdk:answer', answer.seq), root);
  assert.equal(ledger.getArtifactRunScope(sid, 'sdk:answer')?.reason, 'awaiting_user_input_reply');

  const sidWithInterveningInput = session();
  const initial = eventlog.appendEvent({
    sessionId: sidWithInterveningInput,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create another deployment document.' },
  });
  const oldRoot = ledger.resolveArtifactRunScopeId(sidWithInterveningInput, 'sdk:old', initial.seq);
  eventlog.appendEvent({
    sessionId: sidWithInterveningInput,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'awaiting_user_input', artifactRunScopeId: oldRoot },
  });
  eventlog.appendEvent({
    sessionId: sidWithInterveningInput,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Production.' },
  });
  const later = eventlog.appendEvent({
    sessionId: sidWithInterveningInput,
    turn: 3,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Start a separate unrelated report.' },
  });
  assert.equal(
    ledger.resolveArtifactRunScopeId(sidWithInterveningInput, 'sdk:later', later.seq),
    'sdk:later',
    'an intervening user input breaks awaiting-input reply lineage',
  );
});

test('Google Docs binding verifies only when request and successful response identify the exact bound document', () => {
  const sid = session();
  const runScope = 'run:google-readback';
  const intent = {
    kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary',
    title: 'Exact doc', createShape: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
  } as const;
  ledger.claimArtifactSlot(sid, intent, 'create-doc', runScope);
  ledger.bindArtifactSlot(sid, intent.slotKey, {
    resourceId: 'doc_exact_123456789',
    uri: 'https://docs.google.com/document/d/doc_exact_123456789/edit',
  }, 'create-doc', runScope);

  const getter = {
    tool_slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
    arguments: JSON.stringify({ document_id: 'doc_exact_123456789' }),
  };
  assert.equal(ledger.verifyArtifactBindingFromToolResult(
    sid, runScope, 'composio_execute_tool',
    { ...getter, arguments: JSON.stringify({ document_id: 'other_doc_123456789' }) },
    { data: { document_id: 'other_doc_123456789' } }, 'wrong-request',
  ), null, 'a read of a different document cannot verify this slot');
  assert.equal(ledger.verifyArtifactBindingFromToolResult(
    sid, runScope, 'composio_execute_tool', getter,
    { data: { document_id: 'other_doc_123456789' } }, 'wrong-response',
  ), null, 'a mismatched provider response is not proof');
  assert.equal(ledger.verifyArtifactBindingFromToolResult(
    sid, runScope, 'composio_execute_tool', getter,
    { successful: false, data: { document_id: 'doc_exact_123456789' }, error: 'not found' }, 'failed-read',
  ), null, 'a failed response cannot verify even when it echoes the id');
  assert.equal(ledger.verifyArtifactBindingFromToolResult(
    sid, runScope, 'composio_execute_tool', getter,
    { data: { document_id: 'doc_exact_123456789' } }, 'native-error', false,
  ), null, 'the native SDK is_error bit is authoritative');

  const verified = ledger.verifyArtifactBindingFromToolResult(
    sid,
    runScope,
    'composio_execute_tool',
    getter,
    { data: { display_url: 'https://docs.google.com/document/d/doc_exact_123456789/edit', plain_text: 'Finished brief' } },
    'readback-doc',
  );
  assert.ok(verified?.bindingVerifiedAt);
  assert.equal(verified?.verificationCallId, 'readback-doc');
  assert.equal(verified?.verificationShape, 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT');
  assert.match(verified?.verificationFingerprint ?? '', /^[a-f0-9]{16}$/);
  assert.deepEqual(ledger.listUnverifiedRunArtifacts(sid, runScope), []);
  assert.match(ledger.artifactReuseMessage(verified!), /provider-verified/i);
});

test('provider verification survives expiry of the raw tool result', () => {
  const sid = session();
  const runScope = 'run:durable-readback';
  const documentId = 'doc_durable_123456789';
  const intent = {
    kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary',
    title: 'Durable proof', createShape: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
  } as const;
  ledger.claimArtifactSlot(sid, intent, 'create-durable-doc', runScope);
  ledger.bindArtifactSlot(sid, intent.slotKey, {
    resourceId: documentId,
    uri: `https://docs.google.com/document/d/${documentId}/edit`,
  }, 'create-durable-doc', runScope);

  const output = JSON.stringify({
    successful: true,
    data: { document_id: documentId, plain_text: 'Verified provider contents' },
  });
  eventlog.writeToolOutput({
    sessionId: sid,
    callId: 'readback-durable-doc',
    tool: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
    output,
  });
  const verified = ledger.verifyArtifactBindingFromToolResult(
    sid,
    runScope,
    'composio_execute_tool',
    {
      tool_slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
      arguments: JSON.stringify({ document_id: documentId }),
    },
    output,
    'readback-durable-doc',
  );
  assert.ok(verified?.bindingVerifiedAt);

  eventlog.openEventLog().prepare(
    'DELETE FROM tool_outputs WHERE session_id = ? AND call_id = ?',
  ).run(sid, 'readback-durable-doc');
  ledger._resetArtifactLedgerForTests();

  const [durable] = ledger.listRunArtifacts(sid, runScope);
  assert.equal(durable?.verificationCallId, 'readback-durable-doc');
  assert.equal(durable?.verificationShape, 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT');
  assert.match(durable?.verificationFingerprint ?? '', /^[a-f0-9]{16}$/);
  assert.ok(durable?.bindingVerifiedAt, 'the compact proof lives independently of raw tool-output TTL');
});

test('explicit artifact keys preserve legitimate multi-document work', () => {
  const sid = session();
  const base = { kind: 'google_doc', provider: 'Google Docs', title: 'Doc', createShape: 'CREATE' } as const;
  assert.equal(ledger.claimArtifactSlot(sid, { ...base, slotKey: 'google_doc:proposal' }).acquired, true);
  assert.equal(ledger.claimArtifactSlot(sid, { ...base, slotKey: 'google_doc:appendix' }).acquired, true);
  assert.equal(ledger.listRunArtifacts(sid).length, 2);
});

test('the same chat may create a new primary document in a later logical run', () => {
  const sid = session();
  const intent = { kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary', title: 'Doc', createShape: 'CREATE' } as const;
  assert.equal(ledger.claimArtifactSlot(sid, intent, 'call-1', 'run:first').acquired, true);
  ledger.bindArtifactSlot(sid, intent.slotKey, { resourceId: 'doc_first_12345' }, 'call-1', 'run:first');
  assert.equal(ledger.claimArtifactSlot(sid, intent, 'call-2', 'run:second').acquired, true);
  assert.equal(ledger.listRunArtifacts(sid).length, 2);
  assert.equal(ledger.listRunArtifacts(sid, 'run:first')[0]?.resourceId, 'doc_first_12345');
});

test('a dispatched create with no ID becomes uncertain and cannot be retried blindly', () => {
  const sid = session();
  const intent = { kind: 'site', provider: 'Netlify', slotKey: 'site:primary', title: 'x', createShape: 'NETLIFY_SITE_CREATE' } as const;
  ledger.claimArtifactSlot(sid, intent, 'shell-1');
  const uncertain = ledger.markArtifactUncertain(sid, intent.slotKey, 'shell-1');
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(ledger.claimArtifactSlot(sid, intent, 'shell-2').acquired, false);
});

test('extracts stable Google Doc IDs from object and formatted provider output', () => {
  const intent = { kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary', title: 'Snapshot', createShape: 'CREATE' } as const;
  assert.deepEqual(ledger.extractArtifactResource(intent, {
    data: { documentId: '1NjRHpNKX5aN1zObtKIA-_YqZtwpBXi', display_url: 'https://docs.google.com/document/d/1NjRHpNKX5aN1zObtKIA-_YqZtwpBXi/edit' },
  }), {
    resourceId: '1NjRHpNKX5aN1zObtKIA-_YqZtwpBXi',
    uri: 'https://docs.google.com/document/d/1NjRHpNKX5aN1zObtKIA-_YqZtwpBXi/edit',
    title: 'Snapshot',
  });
  const loose = ledger.extractArtifactResource(intent, 'data: { "documentId": "1FdV_RH8NHg5KaWNfEboVyscuxsB0lT6" }');
  assert.equal(loose?.resourceId, '1FdV_RH8NHg5KaWNfEboVyscuxsB0lT6');
});

test('only an explicit pre-dispatch proof makes an artifact claim releasable', () => {
  assert.equal(
    ledger.artifactOutputProvesNoDispatch('[provider-dispatch:not-started:invalid-args]\nMissing title'),
    true,
  );
  assert.equal(ledger.artifactOutputProvesNoDispatch({ ok: false, dispatched: false, reason: 'constraint' }), true);
  assert.equal(ledger.artifactOutputProvesNoDispatch('request timed out; the document may exist'), false);
  assert.equal(ledger.artifactOutputProvesNoDispatch({ successful: false, error: 'provider failed' }), false);
});

test('classifies Netlify site creation but not deploy/status commands', () => {
  const create = ledger.artifactIntentForTool('run_shell_command', { command: 'npx netlify-cli sites:create --name client-snapshot' });
  assert.equal(create?.slotKey, 'site:primary');
  assert.equal(create?.title, 'client-snapshot');
  assert.equal(ledger.artifactIntentForTool('run_shell_command', { command: 'netlify deploy --prod --dir dist' }), null);
  assert.equal(ledger.artifactIntentForTool('run_shell_command', { command: 'netlify status' }), null);
});

test('Netlify binding requires an exact getSite request and matching successful top-level site id', () => {
  const sid = session();
  const runScope = 'run:netlify-readback';
  const siteId = 'd554f560-2511-47f2-a658-abc123456789';
  const intent = {
    kind: 'site', provider: 'Netlify', slotKey: 'site:primary',
    title: 'snapshot-assets', createShape: 'NETLIFY_SITE_CREATE',
  } as const;
  ledger.claimArtifactSlot(sid, intent, 'create-site', runScope);
  ledger.bindArtifactSlot(sid, intent.slotKey, {
    resourceId: siteId, uri: 'https://snapshot-assets.netlify.app',
  }, 'create-site', runScope);

  const getter = { command: `netlify api getSite --data '{"site_id":"${siteId}"}'` };
  assert.equal(ledger.artifactVerificationIntentForTool('run_shell_command', { command: 'netlify status --json' }), null);
  assert.equal(ledger.artifactVerificationIntentForTool('run_shell_command', { command: 'netlify sites:list --json' }), null);
  assert.equal(ledger.artifactVerificationIntentForTool('run_shell_command', {
    command: `${getter.command} && netlify deploy --prod --site ${siteId}`,
  }), null, 'a compound read+write is not independent proof');
  assert.equal(ledger.verifyArtifactBindingFromToolResult(
    sid, runScope, 'run_shell_command', getter,
    `exit_code: 0\n\nstdout:\n{"id":"wrong-site-id","ssl_url":"https://other.netlify.app"}`,
    'wrong-site-read',
  ), null);
  assert.equal(ledger.verifyArtifactBindingFromToolResult(
    sid, runScope, 'run_shell_command', getter,
    `exit_code: 1\n\nstderr:\nNot found ${siteId}`,
    'failed-site-read',
  ), null);

  const verified = ledger.verifyArtifactBindingFromToolResult(
    sid, runScope, 'run_shell_command', getter,
    `exit_code: 0\n\nstdout:\n{"id":"${siteId}","name":"snapshot-assets","ssl_url":"https://snapshot-assets.netlify.app"}`,
    'readback-site',
  );
  assert.ok(verified?.bindingVerifiedAt);
  assert.equal(verified?.verificationShape, 'NETLIFY_API_GETSITE');
  assert.match(ledger.artifactReuseMessage(verified!), /provider-verified/i);
});

test('resolves a simple Netlify name variable instead of recording the literal shell token', () => {
  const intent = ledger.artifactIntentForTool('run_shell_command', {
    command: 'NAME="client-snapshot"; npx netlify-cli sites:create --name "$NAME"',
  });
  assert.equal(intent?.title, 'client-snapshot');
});

test('extracts Netlify CLI Project ID and gives a repairable reuse instruction', () => {
  const intent = {
    kind: 'site', provider: 'Netlify', slotKey: 'site:primary',
    title: 'client-snapshot', createShape: 'NETLIFY_SITE_CREATE',
  } as const;
  const resource = ledger.extractArtifactResource(intent, `Success! Site created\n\nProject ID: d554f560-2511-47f2-a658-abc123456789\nWebsite URL: https://client-snapshot.netlify.app\nAdmin URL: https://app.netlify.com/projects/client-snapshot`);
  assert.deepEqual(resource, {
    resourceId: 'd554f560-2511-47f2-a658-abc123456789',
    uri: 'https://client-snapshot.netlify.app',
    title: 'client-snapshot',
  });
  const sid = session();
  ledger.claimArtifactSlot(sid, intent, 'site-1', 'run:one');
  const bound = ledger.bindArtifactSlot(sid, intent.slotKey, resource!, 'site-1', 'run:one');
  assert.match(ledger.artifactReuseMessage(bound), /--site d554f560-2511-47f2-a658-abc123456789/);
  assert.match(ledger.artifactReuseMessage(bound), /do not run sites:create again/i);
});

test('incident replay permits one Google Doc and one asset container despite renamed retries', () => {
  const sid = session();
  const runScope = 'run:jeff-davis-snapshot';
  let providerCreates = 0;

  const docCalls = [
    {
      tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
      arguments: JSON.stringify({ title: 'San Antonio Live Search Snapshot — Jeff Davis Law Firm (Jul 16, 2026)', markdown_text: '# Snapshot' }),
    },
    {
      tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
      arguments: JSON.stringify({ title: 'San Antonio Live Search Snapshot — Jeff Davis Law Firm (Jul 16, 2026)', markdown_text: '# Snapshot' }),
    },
    {
      tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT',
      arguments: JSON.stringify({ title: 'San Antonio PI — Live Search Snapshot (for Jeff Davis)', text: '' }),
    },
  ];
  for (const [index, args] of docCalls.entries()) {
    const intent = ledger.artifactIntentForTool('composio_execute_tool', args)!;
    const claim = ledger.claimArtifactSlot(sid, intent, `doc-${index + 1}`, runScope);
    if (!claim.acquired) continue;
    providerCreates += 1;
    const resource = ledger.extractArtifactResource(intent, `{
      data: { "display_url": "https://docs.google.com/document/d/1NjRHpNKX5aN1zObtKIA-_YqZtwpBXi-pWQjoneZ1JHw/edit", "documentId": "1NjRHpNKX5aN1zObtKIA-_YqZtwpBXi-pWQjoneZ1JHw" }
    }`)!;
    ledger.bindArtifactSlot(sid, intent.slotKey, resource, `doc-${index + 1}`, runScope);
  }

  for (let index = 0; index < 7; index += 1) {
    const intent = ledger.artifactIntentForTool('run_shell_command', {
      command: `npx netlify-cli sites:create --name snapshot-assets-${index}`,
    })!;
    const claim = ledger.claimArtifactSlot(sid, intent, `site-${index + 1}`, runScope);
    if (!claim.acquired) continue;
    providerCreates += 1;
    ledger.bindArtifactSlot(sid, intent.slotKey, {
      resourceId: 'site_jeff_snapshot', uri: 'https://sapisnap56899.netlify.app',
    }, `site-${index + 1}`, runScope);
  }

  assert.equal(providerCreates, 2, 'only one create may cross each provider boundary');
  assert.deepEqual(
    ledger.listRunArtifacts(sid, runScope).map((artifact) => [artifact.kind, artifact.status]),
    [['google_doc', 'bound'], ['site', 'bound']],
  );
});
