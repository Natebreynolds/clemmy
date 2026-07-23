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
    data: { documentId: 'fixture_google_doc_0000000001', display_url: 'https://docs.google.com/document/d/fixture_google_doc_0000000001/edit' },
  }), {
    resourceId: 'fixture_google_doc_0000000001',
    uri: 'https://docs.google.com/document/d/fixture_google_doc_0000000001/edit',
    title: 'Snapshot',
  });
  const loose = ledger.extractArtifactResource(intent, 'data: { "documentId": "fixture_google_doc_0000000002" }');
  assert.equal(loose?.resourceId, 'fixture_google_doc_0000000002');
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

test('typed shell outcome releases local materialization and authoritative no-effect failures only', async () => {
  const { classifyShellExecutionOutcome } = await import('../shell-execution-outcome.js');
  const materialization = classifyShellExecutionOutcome({
    command: 'npx provider-cli resource:create --name x',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: 'npm error code EACCES\nnpm error path /Users/me/.npm/_cacache\nnpm error permission denied',
  });
  assert.equal(ledger.artifactOutputProvesNoDispatch('exit_code: 1', materialization), true);

  const accountRejected = classifyShellExecutionOutcome({
    command: 'netlify sites:create --name x --account-slug wrong-team --json',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: 'createSiteInTeam error: 404: Not Found',
  });
  assert.equal(accountRejected.effect, 'none');
  assert.equal(ledger.artifactOutputProvesNoDispatch('exit_code: 1', accountRejected), true);

  const unknownProviderExit = classifyShellExecutionOutcome({
    command: 'provider-cli resource:create --name x',
    externalMutation: true,
    exitCode: 1,
    stdout: 'resource may have been created',
    stderr: 'final readback failed',
  });
  assert.equal(ledger.artifactOutputProvesNoDispatch('exit_code: 1', unknownProviderExit), false);
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
  const siteId = '00000000-0000-4000-8000-000000000001';
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
  const resource = ledger.extractArtifactResource(intent, `Success! Site created\n\nProject ID: 00000000-0000-4000-8000-000000000001\nWebsite URL: https://fixture-client-snapshot.netlify.app\nAdmin URL: https://app.netlify.com/projects/fixture-client-snapshot`);
  assert.deepEqual(resource, {
    resourceId: '00000000-0000-4000-8000-000000000001',
    uri: 'https://fixture-client-snapshot.netlify.app',
    title: 'client-snapshot',
  });
  const sid = session();
  ledger.claimArtifactSlot(sid, intent, 'site-1', 'run:one');
  const bound = ledger.bindArtifactSlot(sid, intent.slotKey, resource!, 'site-1', 'run:one');
  assert.match(ledger.artifactReuseMessage(bound), /--site 00000000-0000-4000-8000-000000000001/);
  assert.match(ledger.artifactReuseMessage(bound), /do not run sites:create again/i);
});

test('synthetic retry replay permits one Google Doc and one asset container despite renamed retries', () => {
  const sid = session();
  const runScope = 'run:multi-artifact-retry';
  let providerCreates = 0;

  const docCalls = [
    {
      tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
      arguments: JSON.stringify({ title: 'Metro Live Search Snapshot — Harbor Law Group (Jul 16, 2026)', markdown_text: '# Snapshot' }),
    },
    {
      tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
      arguments: JSON.stringify({ title: 'Metro Live Search Snapshot — Harbor Law Group (Jul 16, 2026)', markdown_text: '# Snapshot' }),
    },
    {
      tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT',
      arguments: JSON.stringify({ title: 'Metro Injury — Live Search Snapshot (for Harbor Law)', text: '' }),
    },
  ];
  for (const [index, args] of docCalls.entries()) {
    const intent = ledger.artifactIntentForTool('composio_execute_tool', args)!;
    const claim = ledger.claimArtifactSlot(sid, intent, `doc-${index + 1}`, runScope);
    if (!claim.acquired) continue;
    providerCreates += 1;
    const resource = ledger.extractArtifactResource(intent, `{
      data: { "display_url": "https://docs.google.com/document/d/fixture_google_doc_0000000003/edit", "documentId": "fixture_google_doc_0000000003" }
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
      resourceId: 'site_fixture_snapshot', uri: 'https://fixture-snapshot-assets.netlify.app',
    }, `site-${index + 1}`, runScope);
  }

  assert.equal(providerCreates, 2, 'only one create may cross each provider boundary');
  assert.deepEqual(
    ledger.listRunArtifacts(sid, runScope).map((artifact) => [artifact.kind, artifact.status]),
    [['google_doc', 'bound'], ['site', 'bound']],
  );
});

test('partitionSupersededPendingClaims: a dead mid-flight claim is superseded only by a VERIFIED same-kind sibling', async () => {
  const { partitionSupersededPendingClaims } = await import('./artifact-ledger.js');
  const { deepEqual, equal } = await import('node:assert/strict');

  const dead = { id: 'a-dead', kind: 'site', provider: 'netlify', resourceId: null };
  const verifiedSibling = { id: 'a-new', kind: 'site', provider: 'netlify', resourceId: 'site-123' };
  const unrelatedPending = { id: 'a-doc', kind: 'document', provider: 'airtable', resourceId: null };

  // Verified sibling present → the dead claim is superseded; the unrelated one is not.
  const out = partitionSupersededPendingClaims({
    artifacts: [dead, verifiedSibling, unrelatedPending],
    pending: [dead, unrelatedPending],
  });
  deepEqual(out.superseded.map((a) => a.id), ['a-dead']);
  deepEqual(out.stillPending.map((a) => a.id), ['a-doc']);

  // No verified sibling → nothing superseded (fail-closed).
  const none = partitionSupersededPendingClaims({ artifacts: [dead], pending: [dead] });
  equal(none.superseded.length, 0);
  equal(none.stillPending.length, 1);

  // A claim WITH a resourceId is never superseded — it can verify itself.
  const withId = { id: 'a-hasid', kind: 'site', provider: 'netlify', resourceId: 'site-999' };
  const keep = partitionSupersededPendingClaims({ artifacts: [withId, verifiedSibling], pending: [withId] });
  equal(keep.superseded.length, 0);

  // A PENDING sibling (even with a resourceId) supersedes nothing.
  const pendingSibling = { id: 'a-pend', kind: 'site', provider: 'netlify', resourceId: 'site-777' };
  const noPendHelp = partitionSupersededPendingClaims({
    artifacts: [dead, pendingSibling],
    pending: [dead, pendingSibling],
  });
  equal(noPendHelp.superseded.length, 0);
});

test('resolveUncertainArtifactClaim: bind and absent free a jailed uncertain claim; bound claims are untouchable', async () => {
  const { resolveUncertainArtifactClaim, claimArtifactSlot } = await import('./artifact-ledger.js');
  const { openEventLog, createSession } = await import('./eventlog.js');
  const { equal, ok } = await import('node:assert/strict');
  const session = createSession({ id: 'sess-uncertain-claim', kind: 'chat' });
  const db = openEventLog();

  const mkClaim = (id: string, status: string): void => {
    db.prepare(`
      INSERT INTO run_artifacts (id, session_id, run_scope_id, slot_key, kind, provider, status, create_shape, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'site', 'Netlify', ?, 'test-shape', datetime('now'), datetime('now'))
    `).run(id, session.id, 'scope-1', `slot-${id}`, status);
  };
  mkClaim('art-uncertain-1', 'uncertain');
  mkClaim('art-uncertain-2', 'uncertain');
  mkClaim('art-bound-1', 'bound');

  // bind: attaches the id and verifies.
  const bound = resolveUncertainArtifactClaim(session.id, 'art-uncertain-1', { kind: 'bind', resourceId: 'site-abc123' });
  equal(bound.ok, true);
  const row = db.prepare('SELECT status, resource_id, binding_verified_at FROM run_artifacts WHERE id = ?').get('art-uncertain-1') as { status: string; resource_id: string; binding_verified_at: string | null };
  equal(row.status, 'bound');
  equal(row.resource_id, 'site-abc123');
  ok(row.binding_verified_at, 'bind marks the claim verified');

  // absent: releases the claim entirely.
  equal(resolveUncertainArtifactClaim(session.id, 'art-uncertain-2', { kind: 'absent' }).ok, true);
  equal(db.prepare('SELECT COUNT(*) AS n FROM run_artifacts WHERE id = ?').get('art-uncertain-2') as unknown as { n: number } | undefined && (db.prepare('SELECT COUNT(*) AS n FROM run_artifacts WHERE id = ?').get('art-uncertain-2') as { n: number }).n, 0);

  // an already-bound claim is untouchable.
  equal(resolveUncertainArtifactClaim(session.id, 'art-bound-1', { kind: 'absent' }).ok, false);
  // wrong session is refused.
  equal(resolveUncertainArtifactClaim('sess-other', 'art-uncertain-1', { kind: 'absent' }).ok, false);
  void claimArtifactSlot;
});

test('effect-anchored generic classifier: any CLI create and any root provider create claim; item-level creates never do', async () => {
  const { artifactIntentForTool, extractArtifactResource } = await import('./artifact-ledger.js');
  const { equal, ok } = await import('node:assert/strict');

  // ANY installed CLI with a create-verb subcommand claims — no product list.
  const supabase = artifactIntentForTool('run_shell_command', { command: 'supabase projects:create my-landing' });
  equal(supabase?.kind, 'resource'); equal(supabase?.provider, 'supabase'); equal(supabase?.title, 'my-landing');
  // Deploy/publish target EXISTING resources — deliberately NOT claimed
  // (that ambiguity belongs to the duplicate-write wall, not the slot model).
  equal(artifactIntentForTool('run_shell_command', { command: 'vercel deploy --prod' }), null);
  const gh = artifactIntentForTool('run_shell_command', { command: 'CI=1 npx --yes gh repo create acme-site --public' });
  equal(gh?.provider, 'gh'); equal(gh?.title, 'acme-site');
  const wrangler = artifactIntentForTool('run_shell_command', { command: 'wrangler init worker-thing' });
  equal(wrangler?.provider, 'wrangler');
  // Reads and plumbing commands never claim.
  equal(artifactIntentForTool('run_shell_command', { command: 'gh repo list' }), null);
  equal(artifactIntentForTool('run_shell_command', { command: 'git checkout -b create-fix' }), null);
  equal(artifactIntentForTool('run_shell_command', { command: 'echo create' }), null);

  // Root provider create (no parent reference) claims with a derived label…
  const base = artifactIntentForTool('composio_execute_tool', { tool_slug: 'AIRTABLE_CREATE_BASE', arguments: '{"name":"PI Intel"}' });
  equal(base?.kind, 'resource'); equal(base?.provider, 'airtable'); equal(base?.title, 'PI Intel');
  // …item-level creates (parent-container reference) never claim.
  equal(artifactIntentForTool('composio_execute_tool', { tool_slug: 'AIRTABLE_CREATE_RECORDS', arguments: '{"baseId":"appX","name":"row"}' }), null);
  equal(artifactIntentForTool('composio_execute_tool', { tool_slug: 'TRELLO_CREATE_CARD', arguments: '{"name":"c","board_id":"b1"}' }), null);

  // Account-scoping ids (workspaceId) do NOT demote a root deliverable —
  // an Airtable base created in a workspace claims (live 2026-07-22 gap).
  const atBase = artifactIntentForTool('composio_execute_tool', { tool_slug: 'AIRTABLE_CREATE_BASE', arguments: '{"name":"AI Tooling Intel","workspaceId":"wspX"}' });
  equal(atBase?.kind, 'resource'); equal(atBase?.provider, 'airtable');

  // Local first-class tools NEVER claim — session bookkeeping is not a
  // provider resource (live 2026-07-22: execution_create claimed and would
  // have parked the run on a phantom artifact).
  equal(artifactIntentForTool('execution_create', { title: 'Deploy intel pipeline', objective: 'x' }), null);
  equal(artifactIntentForTool('workflow_create', { name: 'daily-brief' }), null);
  // …but namespaced MCP creates DO (external surface).
  const linear = artifactIntentForTool('mcp__linear__create_project', { name: 'Q3 Launch' });
  equal(linear?.kind, 'resource'); equal(linear?.provider, 'linear');

  // Existing precise branches keep their richer kinds (regression).
  const netlify = artifactIntentForTool('run_shell_command', { command: 'netlify sites:create --name harness-viz' });
  equal(netlify?.kind, 'site'); equal(netlify?.provider, 'Netlify');

  // Generic extraction proves success from id/url evidence.
  const bound = extractArtifactResource(
    { kind: 'resource', provider: 'vercel', slotKey: 'resource:primary', createShape: 'CLI_VERCEL_DEPLOY' },
    JSON.stringify({ id: 'prj_123', url: 'https://my-landing.vercel.app' }),
  );
  equal(bound?.resourceId, 'prj_123');
  ok(bound?.uri?.includes('vercel.app'));
});

test('a uniform-failure abort boundary excludes dead pre-abort rounds from fan-out coverage', async () => {
  const { summarizeFanoutCoverage } = await import('./fanout-ledger.js');
  const session = eventlog.createSession({ id: 'sess-fanout-abort-boundary', kind: 'chat' });
  for (const item of ['a', 'b', 'c']) {
    eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'worker_result', data: { item, ok: false, lane: 'orchestrator' } });
  }
  assert.equal(summarizeFanoutCoverage(session.id).failed, 3, 'pre-boundary the dead round blocks');
  eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'fanout_run_boundary', data: { reason: 'uniform_failure_abort' } });
  const after = summarizeFanoutCoverage(session.id);
  assert.equal(after.total, 0);
  assert.equal(after.failed, 0);
});

test('retention sweeps: stale rows reaped, fresh rows kept (cancellations / telemetry / route metrics)', async () => {
  const { reapStaleChatCancellations, openEventLog } = await import('./eventlog.js');
  const { reapStaleOperationalEvents, recordOperationalEvent, openOperationalTelemetryDb } = await import('../operational-telemetry.js');
  const { reapStaleModelRouteMetrics, recordModelRouteDecision, openModelRouteMetricsDb } = await import('../model-route-metrics.js');
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  const hdb = openEventLog();
  hdb.prepare('INSERT OR REPLACE INTO harness_chat_request_cancellations (request_id, requested_at, reason) VALUES (?, ?, ?)')
    .run('req-old-1', old, 'test');
  hdb.prepare('INSERT OR REPLACE INTO harness_chat_request_cancellations (request_id, requested_at, reason) VALUES (?, ?, ?)')
    .run('req-new-1', new Date().toISOString(), 'test');
  assert.ok(reapStaleChatCancellations() >= 1);
  assert.equal((hdb.prepare("SELECT COUNT(*) AS n FROM harness_chat_request_cancellations WHERE request_id='req-new-1'").get() as { n: number }).n, 1);

  recordOperationalEvent({ source: 'harness', type: 'worker_queued', payload: { probe: true } });
  openOperationalTelemetryDb().prepare('UPDATE operational_events SET ts = ? WHERE 1=1 AND ts > ?').run(old, old);
  assert.ok(reapStaleOperationalEvents() >= 1, 'aged telemetry rows reaped');

  recordModelRouteDecision({ role: 'worker', resolvedModel: 'glm-5.2', provider: 'byo', source: 'default', reason: {} });
  openModelRouteMetricsDb().prepare('UPDATE model_route_decisions SET created_at = ?').run(old);
  assert.ok(reapStaleModelRouteMetrics() >= 1, 'aged route decisions reaped');
});

test('question-store unification: answering the check-in copy resumes the linked task; task-side answers close the check-in', async () => {
  const { createCheckIn, answerCheckIn, getCheckIn, listOpenCheckIns } = await import('../../agents/check-ins.js');
  const { createBackgroundTask, markBackgroundTaskAwaitingInput, getBackgroundTask, queueBackgroundTaskInputResolution } = await import('../../execution/background-tasks.js');
  const origin = eventlog.createSession({ id: 'sess-qstore-unify', kind: 'chat' });

  // Direction 1: check-in answer resumes the task.
  const task = createBackgroundTask({ title: 'Q-store unify A', prompt: 'x', originSessionId: origin.id });
  markBackgroundTaskAwaitingInput(task.id, 'q-unify-a', 'Which region?');
  const checkIn = createCheckIn({ agentSlug: 'clementine', question: 'Which region should I use?', linkedTaskId: task.id });
  answerCheckIn(checkIn.id, 'US-West');
  await new Promise((r) => setTimeout(r, 120)); // the bridge is fire-and-forget
  assert.equal(getBackgroundTask(task.id)?.status, 'pending', 'check-in answer queued the task continuation');
  assert.equal(getBackgroundTask(task.id)?.inputResolution?.answer, 'US-West');

  // Direction 2: task-side answer closes the linked check-in copy.
  const task2 = createBackgroundTask({ title: 'Q-store unify B', prompt: 'y', originSessionId: origin.id });
  markBackgroundTaskAwaitingInput(task2.id, 'q-unify-b', 'Which workspace?');
  const checkIn2 = createCheckIn({ agentSlug: 'clementine', question: 'Which workspace?', linkedTaskId: task2.id });
  queueBackgroundTaskInputResolution('q-unify-b', 'wspX');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(getCheckIn(checkIn2.id)?.status, 'closed', 'the ghost question was closed');
  assert.ok(!listOpenCheckIns().some((c) => c.id === checkIn2.id));
});

// Live 2026-07-23: a successfully created Google Sheet (bound, URI in hand,
// VALUES_UPDATE already writing to it) parked the run behind "the create
// attempt is unresolved… reply retry" — an unanswerable loop, since the
// standard lane has no verification machinery. A BOUND claim is the
// deliverable; only truly-unresolved dispatch outcomes (pending/uncertain)
// belong in the double-create park set.
test('bound-but-unverified claims are deliverable — only pending/uncertain park', () => {
  const sid = session();
  const intent = ledger.artifactIntentForTool('composio_execute_tool', {
    tool_slug: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
    arguments: JSON.stringify({ title: 'Firm Outreach Drafts — Jul 23' }),
  })!;
  const claim = ledger.claimArtifactSlot(sid, intent, 'call-sheet-1');
  assert.equal(claim.acquired, true);

  // Outcome unknown → truly unresolved → in the park set.
  assert.equal(ledger.listUnresolvedCreateClaims(sid).length, 1);

  // The provider responded: bound with a URI (read-back verification NOT run).
  ledger.bindArtifactSlot(sid, intent.slotKey, {
    uri: 'https://docs.google.com/spreadsheets/d/16NwxaMKd3pqT3K0/edit',
  }, 'call-sheet-1');
  assert.equal(ledger.listUnresolvedCreateClaims(sid).length, 0, 'bound = deliverable, never parks');
  assert.equal(ledger.listUnverifiedRunArtifacts(sid).length, 1, 'verification advisory still reports it');
});
