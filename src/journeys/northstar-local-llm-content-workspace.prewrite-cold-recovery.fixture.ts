/**
 * Fresh-process phase B for the Northstar crash cut after the exact Firecrawl
 * result settled but before the model could author `space_save`.
 *
 * The parent passes only accepted-source identity plus the immutable planning
 * digest. This process reconstructs provider/catalog/tool surfaces, lets the
 * production runTurn owner finalize and adopt its persisted HostRecoveryState,
 * then lets the real model->host loop synthesize one atomic Workspace from the
 * retained result. The provider execute seam throws if recovery tries to read
 * again.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { buildOrchestratorAgent } from '../agents/orchestrator.js';
import { closeEventLog, listEvents, openEventLog } from '../runtime/harness/eventlog.js';
import { HostRecoveryState } from '../runtime/harness/host-turn-runner.js';
import { runConversation, runTurn } from '../runtime/harness/loop.js';
import { HarnessSession } from '../runtime/harness/session.js';
import { primePrimaryModelPlanningCatalog } from '../runtime/semantic-boundary/admit-and-compile-accepted-source.js';
import * as capabilityCatalogs from '../runtime/harness/host-capability-catalog-factory.js';
import * as capabilityManifestStores from '../runtime/harness/capability-manifest-store.js';
import * as connectedCatalog from '../runtime/harness/connected-goal-catalog.js';
import * as productionAdapters from '../runtime/harness/production-capability-adapters.js';
import * as productionPorts from '../runtime/harness/production-capability-ports.js';
import * as innerDispatch from '../tools/inner-dispatch.js';
import * as localRuntimeTools from '../tools/local-runtime-tools.js';
import * as composioTools from '../tools/composio-tools.js';
import * as composioClient from '../integrations/composio/client.js';
import { provisionBuiltinSkills } from '../setup/builtin-skills.js';
import { readData } from '../spaces/data-store.js';
import { closeWorkspaceDb } from '../spaces/workspace-db.js';
import { spaceStore } from '../spaces/store.js';
import { recoverPlanTaskBindingSealPreparation } from '../tools/plan-tools.js';

const MARKER = '@@CLEM_NORTHSTAR_PREWRITE_COLD_RECOVERY@@';
const PROMPT = 'Hey Clem can you scape the top recent news about local LLM processing and help me write a content calendar and 5 social post using the marketing skills. Drop all this in a workspace so i can see it.';
const NEWS_OPERATION = 'FIRECRAWL_SEARCH';
const NEWS_OPERATION_VERSION = '20260826_00';
const NEWS_ACCOUNT = 'conn-web-research';
const READ_CALL_ID = 'cold-prewrite-read-current-news';
const SLUG = 'local-llm-prewrite-cold-recovery';
const TITLE = 'Cold-Recovered Local LLM Campaign';
const MOBILE_LINK = `/m/?tab=spaces&workspace=${SLUG}`;
const FINAL_REPLY = `Created [${TITLE}](/workspaces/${SLUG}) with the cited research, three-week calendar, and five complete posts. [Open it on mobile](${MOBILE_LINK}).`;
const SKILL_RULE_MARKER = 'SOURCE-DATED-CALENDAR-ONE-IDEA-PER-POST';

type Input = {
  sessionId: string;
  sourceUserSeq: number;
  planningDigest: string;
};

type ResearchRow = {
  title: string;
  publisher: string;
  publishedAt: string;
  url: string;
  finding: string;
};

function parseInput(): Input {
  const encoded = process.env.CLEM_NORTHSTAR_PREWRITE_COLD_RECOVERY_INPUT;
  assert.ok(encoded, 'pre-write cold recovery requires exact phase-A identity');
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<Input>;
  assert.equal(typeof value.sessionId, 'string');
  assert.ok(Number.isSafeInteger(value.sourceUserSeq) && Number(value.sourceUserSeq) > 0);
  assert.match(String(value.planningDigest), /^[a-f0-9]{64}$/);
  return value as Input;
}

function functionCall(callId: string, name: string, args: Record<string, unknown>) {
  return { type: 'function_call', callId, name, arguments: JSON.stringify(args) };
}

function assistantText(text: string) {
  return {
    type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

async function* modelStream(
  this: { getResponse: (request: unknown) => Promise<Record<string, unknown>> },
  request: unknown,
) {
  const response = await this.getResponse(request);
  const output = Array.isArray(response.output) ? response.output : [];
  yield { type: 'response_started' } as never;
  yield {
    type: 'model',
    event: { type: 'finish', finishReason: output.some((item) => item.type === 'function_call') ? 'tool_calls' : 'stop' },
  } as never;
  yield {
    type: 'response_done',
    response: {
      id: response.responseId,
      usage: response.usage ?? { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output,
    },
  } as never;
}

function throwingRunner(): EventEmitter {
  const runner = new EventEmitter();
  (runner as unknown as { run: () => never }).run = () => {
    throw new Error('the legacy SDK runner must remain unreachable');
  };
  return runner;
}

function resultText(item: unknown): string {
  const output = (item as { output?: unknown })?.output;
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && typeof (output as { text?: unknown }).text === 'string') {
    return (output as { text: string }).text;
  }
  return '';
}

function resultForCall(history: readonly unknown[], callId: string): string {
  const item = history.find((candidate) => (
    (candidate as { type?: unknown }).type === 'function_call_result'
    && (candidate as { callId?: unknown }).callId === callId
  ));
  return resultText(item);
}

function nestedNews(value: unknown, depth = 0): Array<Record<string, unknown>> | null {
  if (depth > 8) return null;
  if (typeof value === 'string') {
    try { return nestedNews(JSON.parse(value), depth + 1); } catch {
      const start = value.indexOf('{');
      if (start < 0) return null;
      let objectDepth = 0;
      let inString = false;
      let escaped = false;
      for (let index = start; index < value.length; index += 1) {
        const char = value[index]!;
        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === '{') objectDepth += 1;
        else if (char === '}') {
          objectDepth -= 1;
          if (objectDepth === 0) {
            try { return nestedNews(JSON.parse(value.slice(start, index + 1)), depth + 1); } catch { return null; }
          }
        }
      }
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.news)) {
    return record.news.filter((row): row is Record<string, unknown> => (
      Boolean(row) && typeof row === 'object' && !Array.isArray(row)
    ));
  }
  for (const child of Object.values(record)) {
    const found = nestedNews(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function selectedResearch(result: string): ResearchRow[] {
  const retrieval = Date.parse('2026-08-31T00:00:00.000Z');
  const seen = new Set<string>();
  const selected: ResearchRow[] = [];
  for (const row of nestedNews(result) ?? []) {
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const url = typeof row.url === 'string' ? row.url.trim() : '';
    const publishedAt = typeof row.date === 'string' ? row.date.slice(0, 10) : '';
    const finding = [row.snippet, row.description, row.content, row.markdown]
      .find((value) => typeof value === 'string' && value.trim());
    const findingText = typeof finding === 'string' ? finding.trim() : '';
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    const publisher = typeof row.publisher === 'string' && row.publisher.trim()
      ? row.publisher.trim()
      : parsed.hostname;
    const published = Date.parse(`${publishedAt}T00:00:00.000Z`);
    const ageDays = (retrieval - published) / 86_400_000;
    if (
      !title || !publisher || !findingText
      || !['http:', 'https:'].includes(parsed.protocol)
      || !Number.isFinite(published) || ageDays < 0 || ageDays > 30
      || seen.has(parsed.href)
      || !/\b(?:local|llm|model|inference)\b/i.test(`${title} ${findingText}`)
      || /ignore prior instructions|send secrets|replace the destination|(?:^|\n)\s*(?:system|developer|assistant|user)\s*:|earlier rules are obsolete|copy the api key/i.test(findingText)
    ) continue;
    seen.add(parsed.href);
    selected.push({ title, publisher, publishedAt, url: parsed.href, finding: findingText });
  }
  return selected.slice(0, 3);
}

const POSTS = [
  { id: 'post-1', date: '2026-09-01', channel: 'LinkedIn', theme: 'Why local now', body: 'Local LLM processing is becoming a product decision, not a novelty demo. Start with the moments that benefit from private context, responsive interaction, or resilience through weak connectivity, then benchmark those moments on the devices people actually use.' },
  { id: 'post-2', date: '2026-09-03', channel: 'X', theme: 'Hybrid architecture', body: 'A practical local-LLM architecture is rarely all-local or all-cloud. Keep the fast, sensitive, repeatable loop near the user and escalate only when additional reasoning clearly earns the network trip and remains visibly recoverable.' },
  { id: 'post-3', date: '2026-09-08', channel: 'LinkedIn', theme: 'Prototype with evidence', body: 'Prototype one narrow local-model workflow with a measurable before-and-after. Track latency, quality, battery cost, memory pressure, and fallback behavior before turning an impressive demo into a durable product promise.' },
  { id: 'post-4', date: '2026-09-10', channel: 'X', theme: 'Choose for the device', body: 'Small models make device constraints first-class design inputs. Context window, memory footprint, evaluation set, device class, and recovery path belong in one decision record that teams can test and revisit.' },
  { id: 'post-5', date: '2026-09-15', channel: 'LinkedIn', theme: 'Trust through boundaries', body: 'Local inference can reduce unnecessary data movement, but deployment location alone does not create trust. Define allowed actions, visible decisions, disclosed fallback, and correction paths before making privacy claims.' },
] as const;

function evidenceTheme(finding: string): string {
  const themes: string[] = [];
  const add = (pattern: RegExp, value: string) => { if (pattern.test(finding)) themes.push(value); };
  add(/latency|response|fast/i, 'runtime responsiveness');
  add(/memory|footprint/i, 'device memory pressure');
  add(/battery|energy|power/i, 'energy use');
  add(/privacy|private|data movement/i, 'data boundaries');
  add(/fallback|cloud|network/i, 'fallback architecture');
  add(/quality|evaluation|accuracy/i, 'quality validation');
  return [...new Set(themes)].slice(0, 3).join(', ') || 'implementation evidence';
}

function campaignDataset(articles: readonly ResearchRow[]) {
  const citations = articles.map(({ title, publisher, publishedAt, url }) => ({
    title, publisher, publishedAt, url,
  }));
  const posts = POSTS.map((post, index) => {
    const source = articles[index % articles.length]!;
    return {
      ...post,
      body: `${post.body} Evidence anchor: ${source.publisher}'s ${source.publishedAt} report, “${source.title},” makes ${evidenceTheme(source.finding)} the concrete proof point; the cited link keeps the implementation context inspectable.`,
      citations,
    };
  });
  return {
    strategy: {
      objective: 'Teach practical local-LLM product decisions',
      audience: 'Technical builders', channels: ['LinkedIn', 'X'],
      voice: 'Practical and credible', cadence: 'Five posts across three weeks',
    },
    synthesis: {
      appliedSkill: 'technical-content-marketing', appliedRuleMarker: SKILL_RULE_MARKER,
    },
    research: { retrievedAt: '2026-08-31', windowDays: 30, articles },
    calendar: POSTS.map(({ id, date, channel, theme }) => ({ id, date, channel, theme })),
    posts,
    _mobile: {
      headline: [{ label: 'Posts ready', value: '5' }],
      records: {
        label: 'Ready-to-review social posts', total: 5,
        items: posts.map((post) => ({
          key: post.id,
          primary: `${post.date} · ${post.theme}`,
          body: post.body,
          fields: [
            { label: 'Channel', value: post.channel },
            { label: 'Theme', value: post.theme },
          ],
          links: citations.map((citation) => ({ label: citation.publisher, url: citation.url })),
        })),
      },
    },
  };
}

const VIEW_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>${TITLE}</title></head><body>
<main><h1>${TITLE}</h1><p id="strategy"></p><section><h2>Calendar</h2><ol id="calendar"></ol></section><section><h2>Five social posts</h2><div id="posts"></div></section></main>
<script type="module">
const data = await clem.data();
const node = (tag, text) => { const item = document.createElement(tag); item.textContent = String(text ?? ''); return item; };
document.querySelector('#strategy').textContent = [data.strategy.objective, data.strategy.audience, data.strategy.channels.join(' + '), data.strategy.voice, data.strategy.cadence].join(' · ');
for (const entry of data.calendar) { document.querySelector('#calendar').append(node('li', entry.date + ' · ' + entry.channel + ' · ' + entry.theme)); }
for (const post of data.posts) { const article = node('article', ''); article.append(node('h3', post.date + ' · ' + post.channel + ' · ' + post.theme), node('p', post.body)); const sources = node('ul', ''); for (const citation of post.citations) { const parsed = new URL(citation.url); if (!['http:', 'https:'].includes(parsed.protocol)) continue; const link = node('a', citation.publisher + ' · ' + citation.publishedAt); link.href = parsed.href; link.rel = 'noopener noreferrer'; const row = node('li', ''); row.append(link); sources.append(row); } article.append(sources); document.querySelector('#posts').append(article); }
</script></body></html>`;

function configureColdProviderSurface(): void {
  connectedCatalog.installConnectedRegistryPort(() => ({
    connectedToolkits: ['firecrawl'],
    tools: [{
      slug: NEWS_OPERATION,
      schema: {
        type: 'object', additionalProperties: false, required: ['q'],
        properties: {
          q: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 },
          formats: { type: 'array', items: { type: 'string' } },
        },
      },
    }],
  }));
  composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => [{
    id: NEWS_ACCOUNT, status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'firecrawl' },
  }]);
  composioClient.__test__.setComposioClient({
    client: { baseURL: 'https://backend.composio.dev' },
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async () => {
            throw new Error('cold recovery must not replay the settled Firecrawl read');
          },
        },
      }),
    }),
    tools: {
      async getRawComposioTools() {
        return [{
          slug: NEWS_OPERATION, name: 'Search',
          description: 'Performs a web search for a query, scrapes content from the top search results using Firecrawl, and returns web, news, and image results.',
          toolkit: { slug: 'firecrawl' },
          inputParameters: {
            type: 'object', additionalProperties: false, required: ['q'],
            properties: {
              q: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 },
              formats: { type: 'array', items: { type: 'string' } },
            },
          },
          outputParameters: {
            type: 'object', additionalProperties: false, required: ['web', 'news', 'images'],
            properties: {
              web: { type: 'array', items: { type: 'object' } },
              news: {
                type: 'array', items: {
                  type: 'object', required: ['title', 'url'],
                  properties: {
                    title: { type: 'string' }, url: { type: 'string' }, date: { type: 'string' },
                    snippet: { type: 'string' }, description: { type: 'string' },
                    content: { type: 'string' }, markdown: { type: 'string' }, publisher: { type: 'string' },
                  },
                },
              },
              images: { type: 'array', items: { type: 'object' } },
            },
          },
          version: NEWS_OPERATION_VERSION,
        }];
      },
      async execute() { throw new Error('cold recovery cannot use the high-level Composio fallback'); },
    },
  });
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.startsWith('https://backend.composio.dev/api/v3/tools?')) {
      return new Response(JSON.stringify({ items: [] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`pre-write cold fixture forbids real network: ${url}`);
  }) as typeof fetch;
  productionAdapters.installProductionTransport(async () => {
    throw new Error('cold recovery cannot enter the fallback production transport');
  });
  const gateway = composioTools.getComposioRuntimeTools()
    .find((tool) => tool.name === 'composio_execute_tool');
  const workspaceSave = localRuntimeTools.getLocalDeferredDispatchTools()
    .find((tool) => tool.name === 'space_save');
  assert.ok(gateway && workspaceSave);
  innerDispatch._setInnerDispatchToolsForTests(new Map([
    ['composio_execute_tool', gateway as never],
    ['space_save', workspaceSave as never],
  ]));
}

function physicalRows(input: Input) {
  return openEventLog().prepare(`
    SELECT tool_name, state, execution_site, COUNT(*) AS n
      FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
       AND tool_name IN ('firecrawl_search', 'space_save')
     GROUP BY tool_name, state, execution_site
     ORDER BY tool_name, state, execution_site
  `).all(input.sessionId, input.sourceUserSeq) as Array<{
    tool_name: string; state: string; execution_site: string | null; n: number;
  }>;
}

const input = parseInput();
provisionBuiltinSkills();
capabilityCatalogs.installHostCapabilityCatalogFactory(
  capabilityCatalogs.createHostCapabilityCatalogFactory(),
);
capabilityManifestStores.installCapabilityManifestStore(
  capabilityManifestStores.createCapabilityManifestStore([], { durable: true }),
);
productionPorts.clearProductionCapabilityPorts();
configureColdProviderSurface();

const session = HarnessSession.load(input.sessionId);
assert.ok(session);
const recoveryBlob = session.loadRecoveryState();
assert.ok(recoveryBlob, 'phase A persisted the private recovery owner');
const phaseARecovery = HostRecoveryState.fromString(recoveryBlob);
assert.equal(phaseARecovery.phase, 'finalize');
assert.equal(phaseARecovery.sessionId, input.sessionId);
assert.equal(phaseARecovery.sourceUserSeq, input.sourceUserSeq);
assert.match(JSON.stringify(phaseARecovery.resultItems), /On-device inference benchmark update/,
  'the cold process receives research only through the durable recovery checkpoint');
assert.equal(spaceStore.get(SLUG), undefined);

const rePrimed = await primePrimaryModelPlanningCatalog({
  sessionId: input.sessionId,
  sourceUserSeq: input.sourceUserSeq,
});
if (!rePrimed.ok) throw new Error(rePrimed.reason);
assert.equal(rePrimed.planning.digest, input.planningDigest);

let modelCalls = 0;
let selected: ResearchRow[] = [];
const model = {
  async getResponse(request: unknown) {
    modelCalls += 1;
    const history = (request as { input?: readonly unknown[] }).input ?? [];
    if (modelCalls === 1) {
      const serialized = JSON.stringify(request);
      assert.match(serialized, new RegExp(SKILL_RULE_MARKER));
      const researchResult = resultForCall(history, READ_CALL_ID);
      assert.match(researchResult, /On-device inference benchmark update/);
      selected = selectedResearch(researchResult);
      assert.equal(selected.length, 3);
      const data = campaignDataset(selected);
      return {
        responseId: 'cold-prewrite-save-response',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [functionCall('cold-prewrite-save-workspace', 'work_call', {
          requirement_id: 'author_content_workspace',
          universe_item_id: null,
          universe_selector: null,
          seal_amendment: null,
          source_call_ids: [READ_CALL_ID],
          source_record_ids: selected.map((row) => row.url),
          name: 'space_save',
          args_json: JSON.stringify({
            slug: SLUG,
            title: TITLE,
            objective: 'Create one cold-recovered cited local-LLM content calendar.',
            success_criteria: ['Exactly five complete posts with three recent cited sources.'],
            invariants: ['No external publishing.', 'Retain only verified dated research.'],
            view_html: VIEW_HTML,
            view_path: null,
            data_sources: null,
            actions: null,
            reengage_triggers: null,
            reengage_guidance: null,
            origin_session_id: input.sessionId,
            initial_data_json: JSON.stringify(data),
          }),
        })],
      };
    }
    assert.equal(modelCalls, 2);
    const saved = resultForCall(history, 'cold-prewrite-save-workspace');
    assert.match(saved, /Created workspace/);
    assert.match(saved, new RegExp(MOBILE_LINK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return {
      responseId: 'cold-prewrite-terminal-response',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      output: [assistantText(FINAL_REPLY)],
    };
  },
  getStreamedResponse: modelStream,
};

const buildAgent = () => buildOrchestratorAgent({
  userInput: PROMPT,
  sessionId: input.sessionId,
  sourceUserSeq: input.sourceUserSeq,
  acceptedRoute: 'act',
  hostFreshPlanning: rePrimed.planning,
  allowedToolNames: ['skill_list', 'skill_read', 'tool_search', 'composio_execute_tool', 'space_save'],
  allowToolJit: true,
  mcpToolScope: {
    authority: 'none',
    reason: 'cold Northstar recovery uses only the frozen provider/local carriers',
    allowedServerSlugs: [], toolPatterns: [], maxTools: 0,
  },
  model: model as never,
});

const recoveryAgent = await buildAgent();
const finalized = await runTurn({
  sessionId: input.sessionId,
  input: PROMPT,
  sourceUserSeq: input.sourceUserSeq,
  reuseRecordedUserInput: true,
  suppressMemoryCapture: true,
  turnEngine: 'host_v1',
  agent: recoveryAgent,
  makeRunner: throwingRunner as never,
  maxTurns: 5,
  toolCallsPerTurn: 8,
});
assert.equal(finalized.status, 'held', JSON.stringify(finalized));
assert.equal(modelCalls, 0, 'checkpoint finalization performs no model or provider replay');
const continuationBlob = HarnessSession.load(input.sessionId)?.loadRecoveryState();
assert.ok(continuationBlob);
assert.equal(HostRecoveryState.fromString(continuationBlob).phase, 'continue');

const physicalBeforeContinuation = physicalRows(input);
assert.deepEqual(physicalBeforeContinuation.filter((row) => row.tool_name === 'firecrawl_search'), [{
  tool_name: 'firecrawl_search', state: 'returned', execution_site: null, n: 1,
}]);
assert.equal(physicalBeforeContinuation.some((row) => row.tool_name === 'space_save'), false);

const planPreparation = await recoverPlanTaskBindingSealPreparation({
  sessionId: input.sessionId,
  sourceUserSeq: input.sourceUserSeq,
});
assert.notEqual(planPreparation.status, 'held', JSON.stringify(planPreparation));

const completed = await runConversation({
  sessionId: input.sessionId,
  input: PROMPT,
  sourceUserSeq: input.sourceUserSeq,
  reuseRecordedUserInput: true,
  turnEngine: 'host_v1',
  maxSteps: 1,
  maxTurns: 5,
  toolCallsPerTurn: 8,
  judgeCompletion: false,
  suppressMemoryCapture: true,
  mcpToolScope: {
    authority: 'none',
    reason: 'cold Northstar recovery uses only the frozen provider/local carriers',
    allowedServerSlugs: [], toolPatterns: [], maxTools: 0,
  },
  buildAgent: async () => buildAgent(),
  makeRunner: throwingRunner as never,
});
assert.equal(completed.status, 'completed', JSON.stringify(completed));
assert.equal(completed.publicPresentation?.text, FINAL_REPLY);
assert.equal(modelCalls, 2);
assert.equal(HarnessSession.load(input.sessionId)?.loadRecoveryState(), null);

const workspace = spaceStore.get(SLUG);
assert.ok(workspace);
assert.equal(workspace.version, 1);
const data = readData(SLUG) as {
  calendar?: unknown[];
  posts?: unknown[];
  research?: { articles?: unknown[] };
  _mobile?: { records?: { items?: unknown[] } };
};
assert.equal(data.calendar?.length, 5);
assert.equal(data.posts?.length, 5);
assert.equal(data.research?.articles?.length, 3);
assert.equal(data._mobile?.records?.items?.length, 5);
assert.doesNotMatch(JSON.stringify(data), /evil\.example|send secrets|copy the api key/i);

const physicalAfter = physicalRows(input);
assert.deepEqual(physicalAfter.filter((row) => row.tool_name === 'firecrawl_search'), [{
  tool_name: 'firecrawl_search', state: 'returned', execution_site: null, n: 1,
}], 'the fresh process never replays the provider read');
assert.deepEqual(physicalAfter.filter((row) => row.tool_name === 'space_save'), [{
  tool_name: 'space_save', state: 'returned', execution_site: 'host', n: 1,
}], 'the fresh process commits one and only one local Workspace');

const delivered = listEvents(input.sessionId, { types: ['conversation_completed'] })
  .filter((event) => event.data.sourceUserSeq === input.sourceUserSeq);
assert.equal(delivered.length, 1);
assert.equal(delivered[0]?.data.delivered, true);
assert.equal(delivered[0]?.data.reply, FINAL_REPLY);

const replay = await runConversation({
  sessionId: input.sessionId,
  input: PROMPT,
  sourceUserSeq: input.sourceUserSeq,
  reuseRecordedUserInput: true,
  turnEngine: 'host_v1',
  maxSteps: 1,
  judgeCompletion: false,
  buildAgent: async () => { throw new Error('terminal replay must not rebuild the agent'); },
});
assert.equal(replay.status, 'completed');
assert.equal(replay.steps, 0);
assert.equal(modelCalls, 2);
assert.deepEqual(physicalRows(input), physicalAfter);
assert.equal(spaceStore.get(SLUG)?.version, 1);
assert.equal(listEvents(input.sessionId, { types: ['conversation_completed'] })
  .filter((event) => event.data.sourceUserSeq === input.sourceUserSeq).length, 1);

const result = {
  pid: process.pid,
  planningDigest: rePrimed.planning.digest,
  modelCalls,
  workspaceVersion: workspace.version,
  postCount: data.posts?.length ?? 0,
  mobilePostCount: data._mobile?.records?.items?.length ?? 0,
  selectedUrls: selected.map((row) => row.url),
  physicalBeforeContinuation,
  physicalAfter,
  terminalEvents: delivered.length,
  terminalReply: delivered[0]?.data.reply,
  replaySteps: replay.steps,
};

innerDispatch._setInnerDispatchToolsForTests(null);
connectedCatalog.installConnectedRegistryPort(null);
capabilityCatalogs.installHostCapabilityCatalogFactory(null);
capabilityManifestStores.installCapabilityManifestStore(null);
productionPorts.clearProductionCapabilityPorts();
productionAdapters.installProductionTransport(null);
composioClient.__test__.setConnectedAccountsLoader(null);
composioClient.__test__.setComposioApiKeyOverride(null);
composioClient.resetComposioClient();
closeWorkspaceDb();
closeEventLog();
process.stdout.write(`${MARKER}${JSON.stringify(result)}\n`);
