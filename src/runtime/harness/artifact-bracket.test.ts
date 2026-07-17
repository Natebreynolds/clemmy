import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-artifact-bracket-'));
process.env.CLEMENTINE_HOME = home;

const eventlog = await import('./eventlog.js');
const ledger = await import('./artifact-ledger.js');
const brackets = await import('./brackets.js');

beforeEach(() => {
  eventlog.resetEventLog();
  ledger._resetArtifactLedgerForTests();
});

after(() => rmSync(home, { recursive: true, force: true }));

function runContext(sessionId: string, runScopeId: string) {
  return {
    sessionId,
    behaviorScopeId: runScopeId,
    counter: new brackets.ToolCallsCounter(100),
  };
}

test('the tool bracket binds one create and reuses it across renamed retries in the same run', async () => {
  const sessionId = eventlog.createSession({ kind: 'chat' }).id;
  let dispatches = 0;
  const tool = brackets.wrapToolForHarness({
    name: 'googledocs__create_document',
    async execute() {
      dispatches += 1;
      return {
        documentId: 'doc_bound_123456789',
        display_url: 'https://docs.google.com/document/d/doc_bound_123456789/edit',
      };
    },
  });

  const invoke = (title: string, runScopeId = 'run:first') => brackets.withHarnessRunContext(
    runContext(sessionId, runScopeId),
    () => tool.execute!({ title }),
  );

  await invoke('Original title');
  const duplicate = await invoke('Renamed retry');
  assert.equal(dispatches, 1, 'the second call never crosses the provider boundary');
  assert.match(String(duplicate), /already bound/i);
  assert.equal(ledger.listRunArtifacts(sessionId, 'run:first')[0]?.status, 'bound');

  await invoke('A later user request', 'run:second');
  assert.equal(dispatches, 2, 'a later logical run in the same chat keeps the feature available');
});

test('a proven pre-dispatch block releases the slot, while an ambiguous failure stays fail-closed', async () => {
  const sessionId = eventlog.createSession({ kind: 'chat' }).id;
  let mode: 'blocked' | 'ambiguous' | 'success' = 'blocked';
  let dispatches = 0;
  const tool = brackets.wrapToolForHarness({
    name: 'googledocs__create_document',
    async execute() {
      dispatches += 1;
      if (mode === 'blocked') return '[provider-dispatch:not-started:invalid-args]\nMissing title';
      if (mode === 'ambiguous') return 'provider connection closed before a response; creation is unknown';
      return { documentId: 'doc_retry_123456789' };
    },
  });
  const invoke = (scope: string) => brackets.withHarnessRunContext(
    runContext(sessionId, scope),
    () => tool.execute!({ title: 'Retryable' }),
  );

  await invoke('run:blocked');
  assert.equal(ledger.listRunArtifacts(sessionId, 'run:blocked').length, 0, 'zero-dispatch proof releases the claim');
  mode = 'success';
  await invoke('run:blocked');
  assert.equal(dispatches, 2);
  assert.equal(ledger.listRunArtifacts(sessionId, 'run:blocked')[0]?.status, 'bound');

  mode = 'ambiguous';
  await invoke('run:ambiguous');
  assert.equal(ledger.listRunArtifacts(sessionId, 'run:ambiguous')[0]?.status, 'uncertain');
  mode = 'success';
  const denied = await invoke('run:ambiguous');
  assert.match(String(denied), /Verify that attempt before retrying/i);
  assert.equal(dispatches, 3, 'an uncertain write is never blindly replayed');
});

test('execute wrapper records an exact Google Docs provider read-back but ignores mismatches', async () => {
  const sessionId = eventlog.createSession({ kind: 'chat' }).id;
  const runScope = 'run:verify-doc';
  const intent = {
    kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary',
    title: 'Firm brief', createShape: 'CREATE',
  } as const;
  ledger.claimArtifactSlot(sessionId, intent, 'create-doc', runScope);
  ledger.bindArtifactSlot(sessionId, intent.slotKey, {
    resourceId: 'doc_bracket_123456789',
    uri: 'https://docs.google.com/document/d/doc_bracket_123456789/edit',
  }, 'create-doc', runScope);

  let responseId = 'wrong_doc_123456789';
  const getter = brackets.wrapToolForHarness({
    name: 'googledocs__get_document',
    async execute() {
      return { data: { document_id: responseId, display_url: `https://docs.google.com/document/d/${responseId}/edit` } };
    },
  });
  const invoke = () => brackets.withHarnessRunContext(
    runContext(sessionId, runScope),
    () => getter.execute!({ document_id: 'doc_bracket_123456789' }),
  );

  await invoke();
  assert.equal(ledger.listRunArtifacts(sessionId, runScope)[0]?.bindingVerifiedAt, null);
  responseId = 'doc_bracket_123456789';
  await invoke();
  const verified = ledger.listRunArtifacts(sessionId, runScope)[0];
  assert.ok(verified?.bindingVerifiedAt);
  assert.equal(verified?.verificationShape, 'GOOGLEDOCS_GET_DOCUMENT');
});

test('invoke wrapper records a Netlify getSite shell envelope and never treats status as proof', async () => {
  const sessionId = eventlog.createSession({ kind: 'chat' }).id;
  const runScope = 'run:verify-site';
  const siteId = 'd554f560-2511-47f2-a658-abc123456789';
  const intent = {
    kind: 'site', provider: 'Netlify', slotKey: 'site:primary',
    title: 'asset-site', createShape: 'NETLIFY_SITE_CREATE',
  } as const;
  ledger.claimArtifactSlot(sessionId, intent, 'create-site', runScope);
  ledger.bindArtifactSlot(sessionId, intent.slotKey, {
    resourceId: siteId, uri: 'https://asset-site.netlify.app',
  }, 'create-site', runScope);

  const shell = brackets.wrapToolForHarness({
    name: 'run_shell_command',
    async invoke(_runContext: unknown, input: unknown) {
      const command = String((input as { command?: unknown }).command ?? '');
      if (/\bstatus\b/i.test(command)) {
        return `exit_code: 0\n\nstdout:\n{"id":"${siteId}"}`;
      }
      return `exit_code: 0\n\nstdout:\n{"id":"${siteId}","ssl_url":"https://asset-site.netlify.app"}`;
    },
  });
  const invoke = (command: string, callId: string) => brackets.withHarnessRunContext(
    runContext(sessionId, runScope),
    () => shell.invoke!({}, { command }, { toolCall: { callId } }),
  );

  await invoke('netlify status --json', 'status-read');
  assert.equal(ledger.listRunArtifacts(sessionId, runScope)[0]?.bindingVerifiedAt, null);
  await invoke(`netlify api getSite --data '{"site_id":"${siteId}"}'`, 'get-site');
  const verified = ledger.listRunArtifacts(sessionId, runScope)[0];
  assert.ok(verified?.bindingVerifiedAt);
  assert.equal(verified?.verificationCallId, 'get-site');
});
