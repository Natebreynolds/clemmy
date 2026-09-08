/** Synthetic C6 reproduction: a submitted plan and shared vocabulary must not invoke a saved workflow.
 * The production planned-write integration separately proves plan activation.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const isolatedHome = mkdtempSync(path.join(os.tmpdir(), 'clem-c6-workflow-routing-'));
process.env.CLEMENTINE_HOME = isolatedHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(isolatedHome, 'state'), { recursive: true });
const { writeWorkflow } = await import('../memory/workflow-store.js');
const { uniqueEnabledWorkflowMatch } = await import('./named-workflow-match.js');
const { tryHostDispatchNamedWorkflow } = await import('../runtime/harness/named-workflow-host-dispatch.js');
const { createSession, appendEvent, closeEventLog } = await import('../runtime/harness/eventlog.js');
const { WORKFLOW_RUNS_DIR } = await import('./shared.js');
const { registerToolSearchTool } = await import('./tool-search-tool.js');
const catalog = JSON.parse(readFileSync(new URL('./fixtures/c6-saved-workflow-catalog.json', import.meta.url), 'utf8')) as Array<{ slug: string; name: string; enabled: boolean }>;
// Preserve catalog size and enablement distribution without retaining owner metadata.
assert.equal(catalog.length, 29);
assert.equal(catalog.filter(entry => entry.enabled).length, 14);
assert.equal(catalog.find(entry => entry.name === 'Outlook Sampleteam Inbox Read Canary')?.enabled, false);
for (const entry of catalog) writeWorkflow(entry.slug, {
  name: entry.name, enabled: entry.enabled, description: 'Synthetic catalog collision reproduction; isolated inert definition.',
  steps: [{ id: 'fixture', prompt: 'Return fixture text without tools.' }],
});
const C6_REQUEST = 'Save those exact three drafts in the Outlook Drafts folder for my Sampleteam mailbox. This is the live draft-write test. Keep To, Cc, and Bcc empty; preserve their subjects and bodies including punctuation and the line break; create each once. Do not send any email. Report each full subject and its full returned draft ID. Use plain-text bodies. Use a plan for these three saves, then execute it.';
const runCount = () => existsSync(WORKFLOW_RUNS_DIR) ? readdirSync(WORKFLOW_RUNS_DIR).filter(name => name.endsWith('.json')).length : 0;

after(() => { closeEventLog(); rmSync(isolatedHome, { recursive: true, force: true }); });

test('synthetic C6 request retrieves the read canary only as advice and never redirects or queues it', () => {
  assert.equal(uniqueEnabledWorkflowMatch(C6_REQUEST)?.name, 'Outlook Sampleteam Inbox Read Canary', 'the synthetic catalog retains a positive unique advisory collision');
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  const source = appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: C6_REQUEST } });
  assert.deepEqual(tryHostDispatchNamedWorkflow({ sessionId: session.id, sourceUserSeq: source.seq, userText: C6_REQUEST, route: 'act' }), { status: 'not_applicable', reason: 'typed_workflow_authority_required' });
  assert.equal(runCount(), 0);
});

test('prior workflow mentions and an unrelated current execution verb cannot manufacture a run', () => {
  const session = createSession({ kind: 'chat', channel: 'desktop' });
  appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received', data: { text: 'Inspect Outlook Sampleteam Inbox Read Canary.' } });
  for (const text of [
    'Use a plan for the three saves, then execute it.',
    'Do not run Outlook Sampleteam Inbox Read Canary. Execute this new plan instead.',
    'Inspect Outlook Sampleteam Inbox Read Canary; execute the draft-saving plan.',
    'Run Outlook Sampleteam Inbox Read Canary.',
  ]) {
    const source = appendEvent({ sessionId: session.id, turn: 2, role: 'user', type: 'user_input_received', data: { text } });
    assert.equal(tryHostDispatchNamedWorkflow({ sessionId: session.id, sourceUserSeq: source.seq, userText: text, route: 'act' }).status, 'not_applicable', text);
  }
  assert.equal(runCount(), 0, 'even an explicit prose request waits for the structured workflow tool or checked clarification');
});

test('synthetic C6 discovery does not replace requested writes with an exact workflow_run shortcut', async () => {
  let handler!: (input: { query: string; limit: number }) => Promise<unknown>;
  let providerSearches = 0;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) { handler = callback; } } as never, {
    allowedNames: new Set(['workflow_run', 'workflow_get']),
    candidateSources: [{ kind: 'authorized_composio', async search() { providerSearches += 1; return []; } }],
  });
  await handler({ query: C6_REQUEST, limit: 8 });
  assert.equal(providerSearches, 1, 'advisory workflow similarity must not suppress requested provider discovery');
  assert.equal(runCount(), 0);
});
