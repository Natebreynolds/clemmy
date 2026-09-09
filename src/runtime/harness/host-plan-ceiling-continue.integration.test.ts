/**
 * The 50-item shape through the real interactive door: a planned native
 * write batch that outgrows one activation budget must finish across several
 * activations with ONE accepted source, ONE terminal, one effect per item and
 * nothing re-run — no human "continue". Live 2026-09-09 (budget 16): the
 * resumed activation re-armed the host root under a changed surface digest and
 * was poisoned as `authority_conflict` before its first model call.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-plan-ceiling-'));
process.env.CLEMENTINE_HOME = fixtureHome;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.HARNESS_TOOL_BRACKETS = 'on';
process.env.CLEMMY_TURN_ENGINE = 'host_v1';
process.env.CLEMMY_UNIFIED_RECALL = 'off';
process.env.CLEMMY_UNIFIED_TURN_PRIMER = 'off';
process.env.CLEMMY_WATCHER_JUDGE = 'off';
process.env.HARNESS_BUDGET_PRESET = 'unlimited';
mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
writeFileSync(path.join(fixtureHome, 'state', 'machine-id'), 'plan-ceiling-fixture\n');
const eventlog = await import('./eventlog.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const stores = await import('./capability-manifest-store.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');
const { buildOrchestratorAgent } = await import('../../agents/orchestrator.js');
const { runConversationContinuingPastToolCallsLimit } = await import('./loop.js');
const memoryDatabase = await import('../../memory/db.js');
after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  stores.installCapabilityManifestStore(null);
  semanticPorts.installTurnSemanticModelPort(null);
  eventlog.closeEventLog();
  memoryDatabase.closeMemoryDb();
  rmSync(fixtureHome, { recursive: true, force: true });
});

const COUNT = 10;
// Inside the home's workspace root so the REAL write_file admits the path and
// mints the committed-file receipt the terminal's obligations verify.
const draftsDir = path.join(fixtureHome, 'workspace', 'drafts');
mkdirSync(draftsDir, { recursive: true });

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => { throw new Error('legacy Runner.run must not own a host_v1 activation'); };
  return runner;
}

test('a planned native batch past the activation ceiling completes across activations with one source and one terminal', async () => {
  // The real write_file runs; progress is read from the files it commits.
  const written = () => readdirSync(draftsDir).filter((name) => name.endsWith('.eml'));
  catalogs.installHostCapabilityCatalogFactory(catalogs.createHostCapabilityCatalogFactory());
  stores.installCapabilityManifestStore(stores.createCapabilityManifestStore());
  semanticPorts.installTurnSemanticModelPort({
    async interpret() { throw new Error('No semantic compiler in this replay'); },
    async judgeAccountSelection(input) { return { verdict: 'default_compatible', proposalDigest: input.proposalDigest, modelIdentity: 'fixture-reviewer' }; },
  });
  const session = eventlog.createSession({ id: 'plan-ceiling-drafts', kind: 'chat' });
  const text = `Create ${COUNT} local email drafts as separate files under ${draftsDir}, one per contact1@example.test through contact${COUNT}@example.test. Do not send anything.`;
  const call = (callId: string, name: string, args: unknown) => ({ type: 'function_call', callId, name, arguments: JSON.stringify(args) });
  let requests = 0;
  const model = {
    async getResponse(request: { input: Array<{ type?: string; callId?: string; output?: { text?: string } }> }) {
      requests += 1;
      const resultFor = (id: string) => request.input.find((x) => x.callId === id && x.output)?.output?.text;
      const discovery = resultFor('discover-draft');
      let output: unknown[];
      if (!discovery) output = [call('discover-draft', 'tool_search', { query: 'write_file', limit: 3 })];
      else if (!resultFor('plan-drafts')) {
        const found = JSON.parse(discovery).results?.find((x: { name: string }) => x.name === 'write_file');
        const ref = found?.capabilityVariants?.find((v: { capabilityRef: string }) => v.capabilityRef.endsWith(':create'))?.capabilityRef;
        assert.ok(ref, discovery);
        output = [call('plan-drafts', 'plan_task', { preamble: `I will save ${COUNT} draft files now.`, draft: {
          criteria: [`Exactly ${COUNT} separate drafts are saved.`], cardinality: null,
          destination: { posture: 'create_new', family: 'file', handleRequired: true },
          topology: { version: 1,
            operations: [{ id: 'draft_email', effect: 'local_write', coverage: null, dependsOn: [], dataFrom: [], cardinality: { kind: 'each', universeId: 'contacts' } }],
            universes: [{ id: 'contacts', seal: 'accepted_input', members: Array.from({ length: COUNT }, (_, i) => `contact-${i + 1}`) }] },
          bindings: [{ operationId: 'draft_email', role: 'write', capabilityRef: ref, evidence: ['local_commit_receipt'] }],
          deliverables: [{ id: 'drafts', kind: 'file' }], evidenceRequirements: ['local_commit_receipt'] } })];
      } else {
        const remaining = Array.from({ length: COUNT }, (_, i) => i + 1).filter((n) => !written().includes(`draft-${n}.eml`));
        output = remaining.length === 0
          ? [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ summary: `All ${COUNT} drafts saved.`, reply: `All ${COUNT} drafts saved.`, done: true, nextAction: 'completed', reason: null }) }] }]
          : remaining.map((n) => call(`draft-${n}-r${requests}`, 'work_call', { requirement_id: 'draft_email', universe_item_id: `contact-${n}`,
            universe_selector: null, seal_amendment: null, source_call_ids: null, source_record_ids: null, name: 'write_file',
            args_json: JSON.stringify({ path: path.join(draftsDir, `draft-${n}.eml`), mode: 'create', content: `To: contact${n}@example.test\nSubject: Monday\n` }) }));
      }
      return { responseId: `plan-ceiling-${requests}`, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, output };
    },
    async *getStreamedResponse(request: never) {
      const response = await this.getResponse(request);
      yield { type: 'response_started' } as never;
      yield { type: 'response_done', response: { id: response.responseId, usage: response.usage, output: response.output } } as never;
    },
  };

  const result = await runConversationContinuingPastToolCallsLimit({
    sessionId: session.id,
    input: text,
    turnEngine: 'host_v1',
    judgeCompletion: false,
    buildAgent: (identity) => buildOrchestratorAgent({
      userInput: text, sessionId: session.id, sourceUserSeq: identity.sourceUserSeq, acceptedRoute: identity.route,
      ...(identity.hostFreshPlanning ? { hostFreshPlanning: identity.hostFreshPlanning } : {}),
      allowToolJit: true, model: model as never,
    }),
    makeRunner: () => throwingRunner() as never,
    maxTurns: 8,
    // discovery + plan + 4 drafts fill one activation; the rest need resumes.
    toolCallsPerTurn: 6,
    suppressMemoryCapture: true,
  });

  const guides = eventlog.listEvents(session.id, { types: ['guardrail_tripped'] }).map((e) => e.data as Record<string, unknown>);
  const kinds = guides.map((g) => g.kind);
  const trace = eventlog.listEvents(session.id, {}).map((e) => `${e.seq}:${e.type}:${String((e.data as Record<string, unknown>).kind ?? (e.data as Record<string, unknown>).reason ?? (e.data as Record<string, unknown>).callId ?? '').slice(0, 40)}`);
  const detail = eventlog.listEvents(session.id, { types: ['obligation_manifest', 'resolution_finalized', 'obligation_satisfied', 'obligation_unsatisfied', 'expected_work_progress', 'turn_outcome'] })
    .map((e) => ({ type: e.type, data: JSON.stringify(e.data).slice(0, 700) }));
  assert.equal(result.status, 'completed', JSON.stringify({ status: result.status, kinds, detail: detail.slice(-6) }).slice(0, 4000));
  assert.deepEqual([...written()].sort(), Array.from({ length: COUNT }, (_, i) => `draft-${i + 1}.eml`).sort(), 'every draft written exactly once');
  assert.ok(guides.filter((g) => g.kind === 'tool_calls_limit').length >= 1, JSON.stringify(kinds));
  assert.ok(guides.some((g) => g.kind === 'budget_checkpoint_auto_resume' && g.resume === true), JSON.stringify(kinds));
  assert.equal(eventlog.listEvents(session.id, { types: ['user_input_received'] }).length, 1, 'one accepted source');
  assert.equal(eventlog.listEvents(session.id, { types: ['conversation_completed'] }).length, 1, 'one terminal');
  const settled = eventlog.openEventLog().prepare(`SELECT outcome_kind, execution_kind, COUNT(*) AS n FROM logical_call_settlements WHERE session_id = ? GROUP BY 1, 2`).all(session.id) as Array<{ outcome_kind: string; execution_kind: string; n: number }>;
  const succeededWrites = eventlog.openEventLog().prepare(`SELECT COUNT(*) AS n FROM logical_call_settlements WHERE session_id = ? AND mutating = 1 AND outcome_kind = 'succeeded'`).get(session.id) as { n: number };
  assert.equal(succeededWrites.n, COUNT, JSON.stringify(settled));
});
