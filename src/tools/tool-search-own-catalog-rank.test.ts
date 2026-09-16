/** Native and provider metadata share query relevance; source membership is
 * not a permanent ranking floor. Exercise model-visible ordering in both lanes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acquiredLiveReadAnswersQuery, emptyMemoryFetchSlugs, registerToolSearchTool, type ToolSearchCandidateSource } from './tool-search-tool.js';
import { successorSlugsFromProse } from '../integrations/composio/lifecycle-prose.js';
import { composioSlugLooksWellFormed } from '../integrations/composio/toolkit-slug.js';
import { AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE } from '../runtime/harness/live-read-planning-authority.js';
import {
  materializeReviewedPlanSearchReceipts,
  queryMatchesReviewedPlanTool,
  reviewedPlanReceiptAnswersQuery,
  reviewedPlanSearchReceiptsForCurrentTurn,
  type ReviewedPlanSearchReceipt,
} from '../runtime/harness/reviewed-plan-search-receipts.js';

const SRC = new URL('./tool-search-tool.ts', import.meta.url);
async function search(
  query: string,
  planning: boolean,
  sources: ToolSearchCandidateSource[],
  planSearchReceipts?: (query: string) => ReadonlyArray<ReviewedPlanSearchReceipt>,
) {
  let handler!: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) { handler = callback; } } as never, {
    allowedNames: new Set(['space_save', 'workflow_get']), candidateSources: sources,
    ...(planning ? { discloseForPlanning: async () => ({ version: 1 as const, refs: {}, blockers: {} }) } : {}),
    ...(planSearchReceipts ? { planSearchReceipts } : {}),
  });
  return JSON.parse((await handler({ query, limit: 8, cursor: null, role_key: null, account_selection: null })).content[0]!.text);
}
const weakProvider: ToolSearchCandidateSource = { kind: 'authorized_composio', search: async () => [{
  name: 'CRM_EXPORT_CUSTOMERS', summary: 'Export customer records into a report.', carrier: 'work_call', score: 1,
}] };
const acquired: ToolSearchCandidateSource = { kind: AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE, search: async () => [{
  name: 'local_workspace_inventory', summary: 'Read workspace information from the current local connection.', carrier: 'work_call', score: 0,
}] };

test('relevant native metadata beats weak provider rank in planning and ordinary discovery', async () => {
  for (const planning of [false, true]) {
    const result = await search('create a new Space with a static HTML view', planning, [weakProvider]);
    assert.equal(result.results[0]?.name, 'space_save');
    assert.ok(result.results.some((row: { name: string }) => row.name === 'CRM_EXPORT_CUSTOMERS'),
      'lower relevance changes order, not provider visibility');
  }
});

test('query-bound acquired read retains precedence on planning discovery', async () => {
  const result = await search('create a new Space with a static HTML view', true, [weakProvider, acquired]);
  assert.equal(result.results[0]?.name, 'local_workspace_inventory');
  assert.equal(result.results[0]?.capabilityRef, undefined, 'ranking alone grants no callable authority');
});

test('acquired read precedence does not depend on a planning-membership boost', async () => {
  const result = await search('create a new Space with a static HTML view', false, [weakProvider, acquired]);
  assert.equal(result.results[0]?.name, 'local_workspace_inventory');
});

test('a relevant provider remains visible and can lead without a membership boost', async () => {
  const provider: ToolSearchCandidateSource = { kind: 'authorized_composio', search: async () => [{
    name: 'CONTENT_EXTRACT_ARTICLE', summary: 'Extract article text from a webpage URL.', carrier: 'work_call', score: 0,
  }] };
  for (const planning of [false, true]) {
    const result = await search('extract article text from a webpage URL', planning, [provider]);
    assert.equal(result.results[0]?.name, 'CONTENT_EXTRACT_ARTICLE');
    assert.equal(result.results[0]?.capabilityRef, undefined);
  }
});

// ── the window, not the rank ────────────────────────────────────────────────
// The tier design only decides among candidates that REACH the ranker. The
// per-source truncation runs before scoring, so a broad query that fills the
// window with provider rows evicts an acquired live read whose boost would
// have won. Live 2026-09-03 run 15: "run shell command Salesforce sf CLI query
// prospects" returned 20 provider rows and zero salesforce_sf_soql_query,
// while run 13's "run shell command salesforce sf cli" found it — same sealed
// descriptor, same machine, two extra words.
test('acquiredLiveReadAnswersQuery recognizes a Salesforce CLI SOQL read without the exact slug', () => {
  const candidate = {
    name: 'salesforce_sf_soql_query',
    sourceKind: AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE,
  };
  assert.equal(acquiredLiveReadAnswersQuery(
    'Run Salesforce CLI SOQL query for today activity counts by owner',
    [candidate],
  ), true);
  assert.equal(acquiredLiveReadAnswersQuery(
    'how did my team do with activity today',
    [candidate],
  ), false, 'a vague ask must not skip live provider discovery');
  assert.equal(acquiredLiveReadAnswersQuery(
    'create a Salesforce account then query it',
    [candidate],
  ), false, 'mixed write+read must still search providers');
});

test('a query-bound acquired live read skips provider fuzzy search', async () => {
  let composioCalls = 0;
  const live: ToolSearchCandidateSource = {
    kind: AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE,
    search: async () => [{
      name: 'salesforce_sf_soql_query',
      summary: 'Current attested read capability salesforce_sf_soql_query',
      carrier: 'work_call',
      score: 1,
    }],
  };
  const composio: ToolSearchCandidateSource = {
    kind: 'authorized_composio',
    search: async () => {
      composioCalls += 1;
      return [{
        name: 'FIRECRAWL_EXTRACT',
        summary: 'Extract structured data from web pages.',
        carrier: 'work_call',
        score: 1,
      }];
    },
  };
  const result = await search(
    'Run Salesforce CLI SOQL query for today activity counts by owner',
    true,
    [live, composio],
  );
  assert.equal(composioCalls, 0, 'provider fuzzy search must not start after a matching live CLI read');
  assert.equal(result.results[0]?.name, 'salesforce_sf_soql_query');
  assert.equal(
    result.results.some((row: { name: string }) => row.name === 'FIRECRAWL_EXTRACT'),
    false,
  );
});

test('an acquired read does not hide write or mixed provider discovery', async () => {
  let composioCalls = 0;
  const live: ToolSearchCandidateSource = {
    kind: AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE,
    search: async () => [{
      name: 'salesforce_sf_soql_query',
      summary: 'Current attested read capability salesforce_sf_soql_query',
      carrier: 'work_call',
      score: 1,
    }],
  };
  const composio: ToolSearchCandidateSource = {
    kind: 'authorized_composio',
    search: async () => {
      composioCalls += 1;
      return [{
        name: 'SALESFORCE_CREATE_ACCOUNT',
        summary: 'Create a Salesforce account.',
        carrier: 'work_call',
        score: 1,
      }];
    },
  };
  await search('create a Salesforce account and query it with SOQL', true, [live, composio]);
  assert.equal(composioCalls, 1, 'write/mixed work still searches the provider catalog');
});

test('a vague activity ask still searches providers even with an acquired Salesforce read', async () => {
  let composioCalls = 0;
  const live: ToolSearchCandidateSource = {
    kind: AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE,
    search: async () => [{
      name: 'salesforce_sf_soql_query',
      summary: 'Current attested read capability salesforce_sf_soql_query',
      carrier: 'work_call',
      score: 1,
    }],
  };
  const composio: ToolSearchCandidateSource = {
    kind: 'authorized_composio',
    search: async () => {
      composioCalls += 1;
      return [{
        name: 'FIRECRAWL_EXTRACT',
        summary: 'Extract structured data from web pages.',
        carrier: 'work_call',
        score: 1,
      }];
    },
  };
  await search('how did my team do with activity today', true, [live, composio]);
  assert.equal(composioCalls, 1, 'a vague ask must not skip live provider discovery');
});

test('a query-bound live read does not wait for a wedged provider', async () => {
  const live: ToolSearchCandidateSource = {
    kind: AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE,
    search: async () => [{
      name: 'salesforce_sf_soql_query',
      summary: 'Current attested read capability salesforce_sf_soql_query',
      carrier: 'work_call',
      score: 1,
    }],
  };
  const composio: ToolSearchCandidateSource = {
    kind: 'authorized_composio',
    search: () => new Promise(() => { /* never resolves */ }),
  };
  const startedAt = Date.now();
  const result = await search(
    'Run Salesforce CLI SOQL query for today activity counts by owner',
    true,
    [live, composio],
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(
    elapsedMs < 2_000,
    `query-bound live read must return without the provider deadline (took ${elapsedMs}ms)`,
  );
  assert.equal(result.results[0]?.name, 'salesforce_sf_soql_query');
});

const docsWriteReceipt: ReviewedPlanSearchReceipt = {
  name: 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
  summary: 'Reviewed GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
  carrier: 'work_call',
  score: 1,
  sourceKind: 'authorized_composio',
  schema: { type: 'object', properties: { id: { type: 'string' }, markdown: { type: 'string' } } },
};

test('queryMatchesReviewedPlanTool recognizes a reviewed Docs write without hiding vague asks', () => {
  assert.equal(queryMatchesReviewedPlanTool(
    'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
    'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
  ), true);
  assert.equal(queryMatchesReviewedPlanTool(
    'update the Google Docs document markdown',
    'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
  ), true);
  assert.equal(queryMatchesReviewedPlanTool(
    'ok lets get the doc updated with the new evidence please',
    'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
  ), false, 'a vague Act follow-up must not infer the newest plan');
  assert.equal(reviewedPlanReceiptAnswersQuery(
    'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
    [docsWriteReceipt],
  ), true);
});

test('a query-bound reviewed write receipt skips provider fuzzy search', async () => {
  let composioCalls = 0;
  const composio: ToolSearchCandidateSource = {
    kind: 'authorized_composio',
    search: async () => {
      composioCalls += 1;
      return [{
        name: 'FIRECRAWL_EXTRACT',
        summary: 'Extract structured data from web pages.',
        carrier: 'work_call',
        score: 1,
      }];
    },
  };
  const result = await search(
    'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
    true,
    [composio],
    () => [docsWriteReceipt],
  );
  assert.equal(composioCalls, 0, 'Execute must not pay provider fuzzy after a reviewed write receipt');
  assert.equal(result.results[0]?.name, 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN');
  assert.equal(
    result.results.some((row: { name: string }) => row.name === 'FIRECRAWL_EXTRACT'),
    false,
  );
});

test('a vague follow-up still searches providers even with a reviewed write receipt', async () => {
  let composioCalls = 0;
  const composio: ToolSearchCandidateSource = {
    kind: 'authorized_composio',
    search: async () => {
      composioCalls += 1;
      return [{
        name: 'FIRECRAWL_EXTRACT',
        summary: 'Extract structured data from web pages.',
        carrier: 'work_call',
        score: 1,
      }];
    },
  };
  await search(
    'ok lets get the doc updated with the new evidence please',
    true,
    [composio],
    () => [docsWriteReceipt],
  );
  assert.equal(composioCalls, 1, 'Act must not infer the newest plan from a vague go');
});

test('a query-bound reviewed write receipt does not wait for a wedged provider', async () => {
  const composio: ToolSearchCandidateSource = {
    kind: 'authorized_composio',
    search: () => new Promise(() => { /* never resolves */ }),
  };
  const startedAt = Date.now();
  const result = await search(
    'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
    true,
    [composio],
    () => [docsWriteReceipt],
  );
  const elapsedMs = Date.now() - startedAt;
  assert.ok(
    elapsedMs < 2_000,
    `reviewed write receipt must return without the provider deadline (took ${elapsedMs}ms)`,
  );
  assert.equal(result.results[0]?.name, 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN');
});

test('a reviewed write receipt that cannot be revalidated is omitted rather than authorizing search skip', async () => {
  const receipts = await materializeReviewedPlanSearchReceipts(
    'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
    {
      version: 1,
      planId: 'plan-test',
      revision: 1,
      digest: 'a'.repeat(64),
      sessionId: 'sess-test',
      principalId: 'owner',
      sourceUserSeq: 1,
      sourceEventId: 'evt-1',
      sourceDigest: 'b'.repeat(64),
      createdAt: '2026-09-14T00:00:00.000Z',
      fullText: 'Update the doc.',
      readiness: 'ready',
      missingPrerequisites: [],
      structuredPlan: {
        preparedBindings: [{
          stepId: 'update-current-doc',
          capabilityRef: 'cap:resolved:googledocs_update_document_markdown',
          identity: {
            operationId: 'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
            providerKind: 'composio',
          },
          inputSchema: { type: 'object' },
        }],
      },
    },
  );
  assert.deepEqual(receipts, [], 'stale or unpublished catalog identity cannot skip live discovery');
  assert.deepEqual(await reviewedPlanSearchReceiptsForCurrentTurn('GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN'), []);
});

test('an acquired live read survives a window flooded by provider rows', () => {
  const src = readFileSync(SRC, 'utf8');
  const truncation = src.slice(
    src.indexOf('const sourced = candidates'),
    src.indexOf('.slice(0, TOOL_SEARCH_WINDOW_RESULTS);', src.indexOf('const sourced = candidates')),
  );
  assert.ok(
    truncation.includes('isAcquiredLiveReadCandidate'),
    'acquired candidates must be carried past the per-source truncation, '
    + 'or broker volume decides what the ranker sees',
  );
  // and the bound must still be applied, so a source cannot return unbounded rows
  assert.ok(
    src.includes('].slice(0, TOOL_SEARCH_WINDOW_RESULTS);'),
    'the window must stay bounded',
  );
});

test('a named integration with spaced words leads its relevant operation, without hiding alternatives', async () => {
  const provider: ToolSearchCandidateSource = { kind: 'authorized_composio', search: async () => [
    { name: 'FIRECRAWL_EXTRACT', summary: 'Create a document from markdown extracted from webpages.', carrier: 'work_call', score: 1 },
    { name: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN', summary: 'Create a document with Markdown content.', carrier: 'work_call', score: 0 },
  ] };
  const result = await search('Google Docs create document from markdown', true, [provider]);
  assert.equal(result.results[0]?.name, 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN');
  assert.ok(result.results.some((row: any) => row.name === 'FIRECRAWL_EXTRACT'));
  assert.equal(result.results[0]?.capabilityRef, undefined, 'ranking cannot invent a callable capability');
});

test('generic MCP operations are searchable through their live input contract', async () => {
  const provider: ToolSearchCandidateSource = { kind: 'authorized_external_mcp', search: async () => [
    { name: 'atlas__a_docs_index', summary: 'Atlas API documentation index.', carrier: 'work_call', score: 1 },
    { name: 'atlas__z_api_request', summary: 'Make an authenticated request to Atlas.', carrier: 'work_call', score: 0,
      schema: { type: 'object', properties: { path: { type: 'string', description: 'API path, e.g. /v3/supplier/pricing/live' }, data: { description: 'Request body with supplier product identifiers' } } } },
  ] };
  const result = await search('Atlas supplier pricing live', true, [provider]);
  assert.equal(result.results[0]?.name, 'atlas__z_api_request');
  assert.ok(result.schemas.atlas__z_api_request);
  const withoutSchema: ToolSearchCandidateSource = { ...provider, search: async input => (await provider.search(input)).map(({ schema, ...row }) => row) };
  const control = await search('Atlas supplier pricing live', true, [withoutSchema]);
  assert.equal(control.results[0]?.name, 'atlas__a_docs_index', 'the selected input contract, not a name/rank tie, makes the operation discoverable');
});

test('successorSlugsFromProse reads Use SLUG instead as well as prefer', () => {
  assert.deepEqual(
    successorSlugsFromProse('Deprecated: Use OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR instead, which supports bots.'),
    ['OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR'],
  );
  assert.deepEqual(
    successorSlugsFromProse('This action is deprecated; prefer FIRECRAWL_SEARCH + FIRECRAWL_EXTRACT for durable workflows.'),
    ['FIRECRAWL_SEARCH', 'FIRECRAWL_EXTRACT'],
  );
  assert.equal(composioSlugLooksWellFormed('OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR'), true);
  assert.equal(composioSlugLooksWellFormed('OUTLOOK_OUTLOOK_UPDATE_CALENDAR_EVENT'), false);
  assert.deepEqual(
    emptyMemoryFetchSlugs('OUTLOOK update calendar event by event ID', [{
      name: 'OUTLOOK_OUTLOOK_UPDATE_CALENDAR_EVENT',
      summary: 'Deprecated: Use OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR instead',
    }]),
    ['OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR'],
  );
});

test('empty memory fetches the callable successor instead of dispatching an unmaterialized row', async () => {
  const queries: string[] = [];
  const composio: ToolSearchCandidateSource = {
    kind: 'authorized_composio',
    search: async ({ query }) => {
      queries.push(query);
      if (query === 'OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR') {
        return [{
          name: 'OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR',
          summary: 'Update an event in a specific Outlook calendar.',
          schema: { type: 'object', properties: { event_id: { type: 'string' } } },
          carrier: 'work_call',
          score: 1,
        }];
      }
      return [{
        name: 'OUTLOOK_OUTLOOK_UPDATE_CALENDAR_EVENT',
        summary: 'Deprecated: Use OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR instead',
        carrier: 'work_call',
        score: 1,
      }];
    },
  };
  let handler!: (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
  registerToolSearchTool({ tool(_name: string, _description: string, _schema: unknown, callback: typeof handler) { handler = callback; } } as never, {
    allowedNames: new Set(),
    candidateSources: [composio],
    discloseForPlanning: async (candidates) => ({
      version: 1 as const,
      refs: Object.fromEntries(
        candidates
          .filter((candidate) => candidate.name === 'OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR')
          .map((candidate) => [candidate.name, `cap:resolved:${candidate.name.toLowerCase()}`]),
      ),
      blockers: Object.fromEntries(
        candidates
          .filter((candidate) => candidate.name !== 'OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR')
          .map((candidate) => [candidate.name, {
            code: 'capability_publication_required' as const,
            choices: [],
            reason: 'exact_definition_unavailable' as const,
          }]),
      ),
    }),
  });
  const result = JSON.parse((await handler({
    query: 'OUTLOOK update calendar event by event ID',
    limit: 8,
    cursor: null,
    role_key: null,
    account_selection: null,
  })).content[0]!.text);
  assert.ok(queries.includes('OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR'), 'empty memory must exact-fetch the successor');
  assert.equal(result.results[0]?.name, 'OUTLOOK_UPDATE_CALENDAR_EVENT_IN_CALENDAR');
  assert.equal(result.results[0]?.capabilityRef, 'cap:resolved:outlook_update_calendar_event_in_calendar');
});
