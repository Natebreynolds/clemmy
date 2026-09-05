/**
 * Fresh-process phase B/C for the exact Northstar async-read crash cut.
 *
 * `resume` enters only through the production boot claim + ordinary restart
 * dispatcher. Search and Batch START are forbidden; the host may execute only
 * the next deterministic GET, then the model may author one atomic Workspace.
 * `replay` is a third PID and proves the durable terminal returns before model,
 * provider, catalog, or Workspace execution can reopen.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { workspaceFixtureDay } from './northstar-local-llm-content-workspace.clock.fixture.js';

import { buildOrchestratorAgent } from '../agents/orchestrator.js';
import * as composioClient from '../integrations/composio/client.js';
import { provisionBuiltinSkills } from '../setup/builtin-skills.js';
import { readData } from '../spaces/data-store.js';
import { projectWorkspaceData } from '../spaces/mobile-projection.js';
import { spaceStore } from '../spaces/store.js';
import { closeWorkspaceDb } from '../spaces/workspace-db.js';
import * as capabilityCatalogs from '../runtime/harness/host-capability-catalog-factory.js';
import * as capabilityManifestStores from '../runtime/harness/capability-manifest-store.js';
import * as connectedCatalog from '../runtime/harness/connected-goal-catalog.js';
import * as productionAdapters from '../runtime/harness/production-capability-adapters.js';
import * as productionPorts from '../runtime/harness/production-capability-ports.js';
import {
  closeEventLog,
  interruptOrphanedRunAttemptsAtBoot,
  listEvents,
  openEventLog,
} from '../runtime/harness/eventlog.js';
import { reconcileTerminalRunAttemptDispatchLeasesAtBoot } from '../runtime/harness/dispatch-lease.js';
import { claimPendingAsyncReadRefinementRecoveries } from '../runtime/harness/async-read-refinement-recovery.js';
import { HostRecoveryState } from '../runtime/harness/host-turn-runner.js';
import { runConversation } from '../runtime/harness/loop.js';
import {
  _setBridgeImplsForTests,
  respondPreferHarness,
} from '../runtime/harness/respond-bridge.js';
import { recoverInterruptedChatRuns } from '../runtime/harness/restart-recovery.js';
import { HarnessSession } from '../runtime/harness/session.js';
import { configureTypedExecutionRuntime } from '../runtime/semantic-boundary/configure-typed-execution-runtime.js';
import { primePrimaryModelPlanningCatalog } from '../runtime/semantic-boundary/admit-and-compile-accepted-source.js';
import * as composioTools from '../tools/composio-tools.js';
import * as innerDispatch from '../tools/inner-dispatch.js';
import * as localRuntimeTools from '../tools/local-runtime-tools.js';
import {
  ASYNC_SELECTED_URLS,
  RAW_HTML_ONLY_HOSTILE_TOKEN,
  asyncCompletedPages,
} from './northstar-local-llm-content-workspace.async-pages.fixture.js';

const MARKER = '@@CLEM_NORTHSTAR_ASYNC_COLD_RECOVERY@@';
const PROMPT = 'Hey Clem can you scape the top recent news about local LLM processing and help me write a content calendar and 5 social post using the marketing skills. Drop all this in a workspace so i can see it.';
const NEWS_OPERATION = 'FIRECRAWL_SEARCH';
const BATCH_OPERATION = 'FIRECRAWL_BATCH_SCRAPE';
const GET_OPERATION = 'FIRECRAWL_BATCH_SCRAPE_GET';
const VERSION = '20260826_00';
const ACCOUNT = 'conn-web-research';
const OWNER_CALL_ID = 'srw-verify-current-articles';
const SAVE_CALL_ID = 'srw-save-visible-workspace';
const JOB_ID = 'fixture-local-llm-batch-1';
const SLUG = 'local-llm-content-calendar-srw';
const TITLE = 'Host-Verified Local LLM Content Calendar';
const MOBILE_LINK = `/m/?tab=spaces&workspace=${SLUG}`;
const FINAL_REPLY = `Created [${TITLE}](/workspaces/${SLUG}) from three host-verified recent articles, with a three-week calendar and five complete posts. [Open it on mobile](${MOBILE_LINK}).`;
const SKILL_RULE_MARKER = 'SOURCE-DATED-CALENDAR-ONE-IDEA-PER-POST';
// Shared with the in-process journey so every PID serves identical page bytes.
const RAW_HTML_SENTINEL = RAW_HTML_ONLY_HOSTILE_TOKEN;
const SELECTED_URLS = ASYNC_SELECTED_URLS;

type Input = {
  mode: 'resume' | 'replay';
  sessionId: string;
  sourceUserSeq: number;
};

type ResearchRow = {
  title: string;
  publisher: string;
  publishedAt: string;
  url: string;
  finding: string;
  selectionRationale: string;
};

function parseInput(): Input {
  const encoded = process.env.CLEM_NORTHSTAR_ASYNC_COLD_RECOVERY_INPUT;
  assert.ok(encoded, 'async cold recovery requires exact durable source identity');
  const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<Input>;
  assert.ok(parsed.mode === 'resume' || parsed.mode === 'replay');
  assert.equal(typeof parsed.sessionId, 'string');
  assert.ok(Number.isSafeInteger(parsed.sourceUserSeq) && Number(parsed.sourceUserSeq) > 0);
  return parsed as Input;
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

function resultText(history: readonly unknown[], callId: string): string {
  const row = history.find((item) => (
    (item as { type?: unknown }).type === 'function_call_result'
    && (item as { callId?: unknown }).callId === callId
  )) as { output?: unknown } | undefined;
  if (typeof row?.output === 'string') return row.output;
  if (row?.output && typeof row.output === 'object'
      && typeof (row.output as { text?: unknown }).text === 'string') {
    return (row.output as { text: string }).text;
  }
  return '';
}

function nestedVerifiedRecords(value: unknown, depth = 0): Array<Record<string, unknown>> | null {
  if (depth > 8) return null;
  if (typeof value === 'string') {
    try { return nestedVerifiedRecords(JSON.parse(value), depth + 1); } catch {
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
            try { return nestedVerifiedRecords(JSON.parse(value.slice(start, index + 1)), depth + 1); } catch { return null; }
          }
        }
      }
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.protocol === 'clementine.verified_recent_articles.v1' && Array.isArray(record.records)) {
    return record.records.filter((row): row is Record<string, unknown> => (
      Boolean(row) && typeof row === 'object' && !Array.isArray(row)
    ));
  }
  for (const child of Object.values(record)) {
    const found = nestedVerifiedRecords(child, depth + 1);
    if (found) return found;
  }
  return null;
}

const POSTS = Object.freeze([
  { id: 'post-1', date: workspaceFixtureDay(1), channel: 'LinkedIn', theme: 'Why local now', body: 'Local LLM processing is becoming a product choice, not a novelty demo. Start with the moments that benefit from private context, responsive interaction, or resilience through weak connectivity, then benchmark those moments on the devices people actually use.' },
  { id: 'post-2', date: workspaceFixtureDay(3), channel: 'X', theme: 'Hybrid architecture', body: 'A practical local-LLM architecture is rarely all-local or all-cloud. Keep the fast, sensitive, repeatable loop near the user and escalate only when additional reasoning clearly earns the network trip and remains visibly recoverable.' },
  { id: 'post-3', date: workspaceFixtureDay(8), channel: 'LinkedIn', theme: 'Prototype with evidence', body: 'Prototype one narrow local-model workflow with a measurable before-and-after. Track latency, quality, battery cost, memory pressure, and fallback behavior before turning an impressive demo into a durable product promise.' },
  { id: 'post-4', date: workspaceFixtureDay(10), channel: 'X', theme: 'Choose for the device', body: 'Small models make device constraints first-class design inputs. Context window, memory footprint, evaluation set, device class, and recovery path belong in one decision record that teams can test and revisit.' },
  { id: 'post-5', date: workspaceFixtureDay(15), channel: 'LinkedIn', theme: 'Trust through boundaries', body: 'Local inference can reduce unnecessary data movement, but deployment location alone does not create trust. Define allowed actions, visible decisions, disclosed fallback, and correction paths before making privacy claims.' },
]);

function evidenceTheme(finding: string): string {
  const labels: string[] = [];
  const add = (pattern: RegExp, label: string) => { if (pattern.test(finding)) labels.push(label); };
  add(/latency|response|fast/i, 'runtime responsiveness');
  add(/memory|footprint/i, 'device memory pressure');
  add(/battery|energy|power/i, 'energy use');
  add(/privacy|private|data movement/i, 'data boundaries');
  add(/fallback|cloud|network/i, 'fallback architecture');
  add(/quality|evaluation|accuracy/i, 'quality validation');
  return [...new Set(labels)].slice(0, 3).join(', ') || 'implementation evidence';
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
    research: {
      retrievedAt: workspaceFixtureDay(0), windowDays: 30,
      rankingRationale: 'Host-verified article dates, direct relevance, implementation specificity, and source distinctness.',
      articles,
    },
    calendar: POSTS.map(({ id, date, channel, theme }) => ({ id, date, channel, theme })),
    posts,
    _mobile: {
      headline: [
        { label: 'Posts ready', value: '5' },
        { label: 'Cited sources', value: String(articles.length) },
        { label: 'Audience', value: 'Technical builders' },
      ],
      breakdowns: [{
        label: 'Publishing cadence',
        entries: [
          { label: 'Week 1', value: '2' },
          { label: 'Week 2', value: '2' },
          { label: 'Week 3', value: '1' },
        ],
      }],
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

const SEARCH_INPUT = Object.freeze({
  type: 'object', additionalProperties: false, required: ['q'],
  properties: {
    q: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 },
    formats: { type: 'array', items: { type: 'string' } },
  },
});
const SEARCH_OUTPUT = Object.freeze({
  type: 'object', additionalProperties: false, required: ['web', 'news', 'images'],
  properties: {
    web: { type: 'array', items: { type: 'object' } },
    news: { type: 'array', items: { type: 'object', required: ['title', 'url'], properties: {
      title: { type: 'string' }, url: { type: 'string' }, date: { type: 'string' },
      snippet: { type: 'string' }, description: { type: 'string' }, content: { type: 'string' },
      markdown: { type: 'string' }, publisher: { type: 'string' },
    } } },
    images: { type: 'array', items: { type: 'object' } },
  },
});
const BATCH_INPUT = Object.freeze({
  type: 'object', additionalProperties: false, required: ['urls'],
  properties: {
    urls: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string' } },
    formats: { type: 'array', items: { type: 'string', enum: ['markdown', 'html', 'rawHtml'] } },
  },
});
const BATCH_OUTPUT = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: { success: { type: 'boolean' }, id: { type: 'string' }, url: { type: 'string' } },
});
const GET_INPUT = Object.freeze({
  type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } },
});
const GET_OUTPUT = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    status: { type: 'string' }, total: { type: 'number' }, completed: { type: 'number' },
    creditsUsed: { type: 'number' }, expiresAt: { type: 'string' },
    data: { type: 'array', items: { type: 'object', properties: {
      rawHtml: { type: 'string' }, metadata: { type: 'object', additionalProperties: true },
    } } },
  },
});

function toolDefinitions() {
  return [
    { slug: NEWS_OPERATION, name: 'Search', description: 'Performs a web search for a query, scrapes content from the top search results using Firecrawl, and returns web, news, and image results.', toolkit: { slug: 'firecrawl' }, inputParameters: SEARCH_INPUT, outputParameters: SEARCH_OUTPUT, version: VERSION },
    { slug: BATCH_OPERATION, name: 'Batch Scrape', description: 'Starts one bounded Firecrawl batch scrape for exact URLs and selected response formats.', toolkit: { slug: 'firecrawl' }, inputParameters: BATCH_INPUT, outputParameters: BATCH_OUTPUT, version: VERSION },
    { slug: GET_OPERATION, name: 'Get Batch Scrape', description: 'Reads the exact current state and completed page payload for a Firecrawl batch scrape id.', toolkit: { slug: 'firecrawl' }, inputParameters: GET_INPUT, outputParameters: GET_OUTPUT, version: VERSION },
  ];
}

function configureProvider(getCalls: { n: number }): void {
  connectedCatalog.installConnectedRegistryPort(() => ({
    connectedToolkits: ['firecrawl'],
    tools: [
      { slug: NEWS_OPERATION, schema: SEARCH_INPUT },
      { slug: BATCH_OPERATION, schema: BATCH_INPUT },
      { slug: GET_OPERATION, schema: GET_INPUT },
    ],
  }));
  composioClient.__test__.setComposioApiKeyOverride('fixture-composio-key');
  composioClient.__test__.setConnectedAccountsLoader(async () => [{
    id: ACCOUNT, status: 'ACTIVE', user_id: 'fixture-user', toolkit: { slug: 'firecrawl' },
  }]);
  composioClient.__test__.setComposioClient({
    client: { baseURL: 'https://backend.composio.dev' },
    getClient: () => ({ withOptions: () => ({ tools: { execute: async () => {
      throw new Error('cold async recovery must not replay Search or Batch START through the nested carrier');
    } } }) }),
    tools: {
      async getRawComposioTools(input?: { tools?: readonly string[]; limit?: number }) {
        const definitions = toolDefinitions();
        const selected = input?.tools?.length
          ? definitions.filter((definition) => input.tools!.some((slug) => slug.toUpperCase() === definition.slug))
          : definitions;
        return typeof input?.limit === 'number' ? selected.slice(0, input.limit) : selected;
      },
      async execute() { throw new Error('the high-level Composio fallback must remain unreachable'); },
    },
  });
  globalThis.fetch = (async (request: RequestInfo | URL) => {
    const url = String(request);
    if (url.startsWith('https://backend.composio.dev/api/v3/tools?')) {
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`async cold fixture forbids real network: ${url}`);
  }) as typeof fetch;
  productionAdapters.installProductionTransport(async (call) => {
    assert.equal(call.operationId, GET_OPERATION,
      `fresh async recovery may execute only the next getter, not ${call.operationId}`);
    assert.equal(call.accountId, ACCOUNT);
    assert.deepEqual(call.args, { id: JOB_ID });
    getCalls.n += 1;
    assert.equal(getCalls.n, 1, 'fresh recovery executes the missing getter exactly once');
    return {
      successful: true,
      error: null,
      data: {
        status: 'completed', total: SELECTED_URLS.length, completed: SELECTED_URLS.length,
        creditsUsed: SELECTED_URLS.length, expiresAt: '2026-09-01T00:00:00Z',
        data: asyncCompletedPages(),
      },
    };
  });
  const gateway = composioTools.getComposioRuntimeTools().find((tool) => tool.name === 'composio_execute_tool');
  const workspaceSave = localRuntimeTools.getLocalDeferredDispatchTools().find((tool) => tool.name === 'space_save');
  assert.ok(gateway && workspaceSave);
  innerDispatch._setInnerDispatchToolsForTests(new Map([
    ['composio_execute_tool', gateway as never],
    ['space_save', workspaceSave as never],
  ]));
}

function physicalRows(sessionId: string) {
  return openEventLog().prepare(`
    SELECT lower(tool_name) AS tool, state, execution_site AS site, COUNT(*) AS n
      FROM physical_dispatches
     WHERE session_id = ?
       AND lower(tool_name) IN ('firecrawl_search','firecrawl_batch_scrape',
                                'firecrawl_batch_scrape_get','space_save')
     GROUP BY lower(tool_name), state, execution_site
     ORDER BY lower(tool_name), state, execution_site
  `).all(sessionId);
}

function expectedPhysical(getCount: number, saveCount: number, batchHostCount: 0 | 1) {
  return [
    { tool: 'firecrawl_batch_scrape', state: 'returned', site: null, n: 1 },
    ...(batchHostCount > 0
      ? [{ tool: 'firecrawl_batch_scrape', state: 'returned', site: 'host', n: batchHostCount }]
      : []),
    { tool: 'firecrawl_batch_scrape_get', state: 'returned', site: null, n: getCount },
    { tool: 'firecrawl_search', state: 'returned', site: null, n: 1 },
    ...(saveCount > 0 ? [{ tool: 'space_save', state: 'returned', site: 'host', n: saveCount }] : []),
  ];
}

const input = parseInput();
const getCalls = { n: 0 };
let modelCalls = 0;

if (input.mode === 'replay') {
  const before = physicalRows(input.sessionId);
  _setBridgeImplsForTests({
    configure: (async () => { throw new Error('terminal replay must precede runtime configuration'); }) as never,
    buildAgent: (async () => { throw new Error('terminal replay must not rebuild an agent'); }) as never,
    runConversation: (async () => { throw new Error('terminal replay must not re-enter runConversation'); }) as never,
  });
  const claimed = claimPendingAsyncReadRefinementRecoveries({ limit: 8 });
  assert.equal(claimed.claimed, 0);
  const restarted = recoverInterruptedChatRuns(Date.now, async () => {
    throw new Error('a delivered terminal must not schedule restart work');
  }, { bootCutoffMs: performance.timeOrigin });
  assert.equal(restarted.recovered, 0);
  const response = await respondPreferHarness('home', {
    sessionId: input.sessionId,
    channel: 'mobile',
    message: PROMPT,
    sourceUserSeq: input.sourceUserSeq,
  }, async () => { throw new Error('terminal replay cannot use the legacy responder'); });
  assert.equal(response.text, FINAL_REPLY);
  assert.deepEqual(physicalRows(input.sessionId), before);
  assert.equal(spaceStore.get(SLUG)?.version, 1);
  assert.equal(listEvents(input.sessionId, { types: ['conversation_completed'] }).length, 1);
  process.stdout.write(`${MARKER}${JSON.stringify({
    mode: input.mode, pid: process.pid, modelCalls, claimed, restartRecovered: restarted.recovered,
    physicalBefore: before, physicalAfter: physicalRows(input.sessionId), reply: response.text,
  })}\n`);
} else {
  provisionBuiltinSkills();
  capabilityCatalogs.installHostCapabilityCatalogFactory(capabilityCatalogs.createHostCapabilityCatalogFactory());
  capabilityManifestStores.installCapabilityManifestStore(
    capabilityManifestStores.createCapabilityManifestStore([], { durable: true }),
  );
  productionPorts.clearProductionCapabilityPorts();
  configureProvider(getCalls);

  assert.deepEqual(physicalRows(input.sessionId), expectedPhysical(1, 0, 0));
  assert.equal(spaceStore.get(SLUG), undefined);
  assert.equal(HarnessSession.load(input.sessionId)?.loadRecoveryState(), null,
    'phase A crashed before any private recovery blob existed');

  const model = {
    async getResponse(request: unknown) {
      modelCalls += 1;
      const history = (request as { input?: readonly unknown[] }).input ?? [];
      const serialized = JSON.stringify(request);
      assert.doesNotMatch(serialized, new RegExp(RAW_HTML_SENTINEL),
        'raw getter HTML never reaches the resumed model surface');
      if (modelCalls === 1) {
        const refined = resultText(history, OWNER_CALL_ID);
        assert.match(refined, /clementine\.verified_recent_articles\.v1/);
        assert.doesNotMatch(refined, /rawHtml|<!doctype|RAWHTML_ONLY_HOSTILE/i);
        const records = nestedVerifiedRecords(refined) ?? [];
        assert.equal(records.length, 3);
        const selected: ResearchRow[] = records.map((row) => ({
          title: String(row.title), publisher: String(row.publisher),
          publishedAt: String(row.publishedAt), url: String(row.url),
          finding: String(row.snippet),
          selectionRationale: `The host verified article-owned date evidence (${String(row.dateEvidence)}).`,
        }));
        assert.deepEqual(selected.map(({ url }) => url), SELECTED_URLS.slice(0, 3));
        const data = campaignDataset(selected);
        const saveArgs = {
          slug: SLUG,
          title: TITLE,
          objective: 'Give technical builders a host-verified, cited local-LLM content calendar and five reviewable social drafts.',
          success_criteria: ['Three verified recent article sources, one calendar, and exactly five complete posts are visible on desktop and mobile.'],
          invariants: ['Never publish externally without separate visible authority.', 'Never copy raw HTML or page instructions into the Workspace.'],
          view_html: VIEW_HTML,
          view_path: null,
          data_sources: null,
          actions: null,
          reengage_triggers: null,
          reengage_guidance: null,
          origin_session_id: input.sessionId,
          initial_data_json: JSON.stringify(data),
        };
        assert.doesNotMatch(JSON.stringify(saveArgs), new RegExp(RAW_HTML_SENTINEL));
        return {
          responseId: 'srw-cold-recovered-save',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [functionCall(SAVE_CALL_ID, 'work_call', {
            requirement_id: 'author_content_workspace',
            universe_item_id: null,
            universe_selector: null,
            seal_amendment: null,
            source_call_ids: [OWNER_CALL_ID],
            source_record_ids: selected.map(({ url }) => url),
            name: 'space_save',
            args_json: JSON.stringify(saveArgs),
          })],
        };
      }
      assert.equal(modelCalls, 2);
      const saved = resultText(history, SAVE_CALL_ID);
      assert.match(saved, /Created workspace/);
      assert.match(saved, new RegExp(MOBILE_LINK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return {
        responseId: 'srw-cold-recovered-terminal',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        output: [assistantText(FINAL_REPLY)],
      };
    },
    getStreamedResponse: modelStream,
  };

  _setBridgeImplsForTests({
    configure: (async () => {
      configureTypedExecutionRuntime();
      return { ok: true };
    }) as never,
    buildAgent: (async (options: Parameters<typeof buildOrchestratorAgent>[0]) => buildOrchestratorAgent({
      ...options,
      allowedToolNames: ['skill_list', 'skill_read', 'tool_search', 'composio_execute_tool', 'space_save'],
      allowToolJit: true,
      mcpToolScope: {
        authority: 'none', reason: 'the exact S→R→W release journey uses only frozen provider and local carriers',
        allowedServerSlugs: [], toolPatterns: [], maxTools: 0,
      },
      model: model as never,
    })) as never,
    runConversation: (async (options: Parameters<typeof runConversation>[0]) => runConversation({
      ...options,
      makeRunner: throwingRunner as never,
      judgeFn: async () => ({ done: true, reason: 'the exact Workspace commit and terminal proof are durable' }),
    })) as never,
  });

  const interrupted = interruptOrphanedRunAttemptsAtBoot();
  assert.equal(interrupted, 1);
  const reconciled = reconcileTerminalRunAttemptDispatchLeasesAtBoot();
  assert.equal(reconciled, 2, 'only the crashed host parent and open R lease are quarantined');
  const claimed = claimPendingAsyncReadRefinementRecoveries({ limit: 8 });
  assert.deepEqual({ scanned: claimed.scanned, claimed: claimed.claimed, replayed: claimed.replayed, held: claimed.held },
    { scanned: 1, claimed: 1, replayed: 0, held: 0 });
  const claimedBlob = HarnessSession.load(input.sessionId)?.loadRecoveryState();
  assert.ok(claimedBlob);
  const claimedState = HostRecoveryState.fromString(claimedBlob);
  assert.equal(claimedState.phase, 'admit');
  assert.equal(claimedState.sourceUserSeq, input.sourceUserSeq);
  assert.deepEqual(physicalRows(input.sessionId), expectedPhysical(1, 0, 0));
  if (process.env.CLEM_NORTHSTAR_DEBUG_MANUAL_PRIME === '1') {
    const primed = await primePrimaryModelPlanningCatalog({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
    });
    assert.equal(primed.ok, true, JSON.stringify(primed));
  }

  const dispatches: Array<Promise<unknown>> = [];
  const restarted = recoverInterruptedChatRuns(Date.now, (restart) => {
    const promise = respondPreferHarness(restart.surface, {
      sessionId: restart.sessionId,
      channel: restart.channel ?? restart.surface,
      message: restart.acceptedInput,
      sourceUserSeq: restart.sourceUserSeq,
      allowedToolNames: ['skill_list', 'skill_read', 'tool_search', 'composio_execute_tool', 'space_save'],
      maxWallClockMs: 60_000,
    }, async () => { throw new Error('ordinary restart dispatch must remain on the harness'); });
    dispatches.push(promise);
    return promise.then(() => undefined);
  }, { bootCutoffMs: performance.timeOrigin });
  assert.equal(restarted.recovered, 1);
  assert.equal(restarted.records.length, 1);
  assert.equal(restarted.records[0]?.autoResumed, true, JSON.stringify(restarted.records[0]));
  assert.equal(restarted.records[0]?.autoResumeSkipped, undefined);
  assert.equal(dispatches.length, 1);
  const [response] = await Promise.all(dispatches) as Array<{ text?: string }>;
  assert.equal(response?.text, FINAL_REPLY, JSON.stringify({
    response,
    modelCalls,
    getCalls: getCalls.n,
    recovery: HarnessSession.load(input.sessionId)?.loadRecoveryState()
      ? HostRecoveryState.fromString(HarnessSession.load(input.sessionId)!.loadRecoveryState()!).phase
      : null,
    runInFlight: HarnessSession.load(input.sessionId)?.runInFlightSince(),
    physical: physicalRows(input.sessionId),
    events: listEvents(input.sessionId, {
      types: ['run_resumed', 'restart_recovery_decision', 'conversation_completed'],
    }).map((event) => ({ type: event.type, data: event.data })),
  }));

  assert.equal(modelCalls, 2);
  assert.equal(getCalls.n, 1);
  assert.equal(HarnessSession.load(input.sessionId)?.loadRecoveryState(), null);
  assert.equal(HarnessSession.load(input.sessionId)?.runInFlightSince(), null);
  assert.deepEqual(physicalRows(input.sessionId), expectedPhysical(2, 1, 1));
  const workspace = spaceStore.get(SLUG);
  assert.ok(workspace);
  assert.equal(workspace.version, 1);
  const data = readData(SLUG) as {
    calendar: unknown[]; posts: Array<{ body: string }>;
    research: { articles: Array<{ url: string }> };
    _mobile: { records: { items: unknown[] } };
  };
  assert.equal(data.calendar.length, 5);
  assert.equal(data.posts.length, 5);
  assert.equal(data._mobile.records.items.length, 5);
  assert.deepEqual(data.research.articles.map(({ url }) => url), SELECTED_URLS.slice(0, 3));
  assert.equal(projectWorkspaceData(data as never).total, 5);
  assert.doesNotMatch(JSON.stringify(data), new RegExp(RAW_HTML_SENTINEL));
  const terminals = listEvents(input.sessionId, { types: ['conversation_completed'] })
    .filter((event) => event.data.sourceUserSeq === input.sourceUserSeq);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0]?.data.delivered, true);
  assert.equal(terminals[0]?.data.reply, FINAL_REPLY);
  assert.equal(listEvents(input.sessionId, { types: ['run_resumed'] }).length, 1);

  const claimReplay = claimPendingAsyncReadRefinementRecoveries({ limit: 8 });
  assert.equal(claimReplay.claimed, 0);
  assert.deepEqual(physicalRows(input.sessionId), expectedPhysical(2, 1, 1));
  process.stdout.write(`${MARKER}${JSON.stringify({
    mode: input.mode, pid: process.pid, interrupted, reconciled, claimed,
    restartRecovered: restarted.recovered, modelCalls, getterCalls: getCalls.n,
    physical: physicalRows(input.sessionId), workspaceVersion: workspace.version,
    posts: data.posts.length, mobilePosts: data._mobile.records.items.length,
    terminalEvents: terminals.length, reply: terminals[0]?.data.reply,
  })}\n`);
}

_setBridgeImplsForTests({});
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
