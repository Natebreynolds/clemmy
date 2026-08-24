import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-partial-capability-discovery-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_WARM_TOOL_CONTRACTS = 'off';

const eventlog = await import('./eventlog.js');
const {
  recordCapabilityResolution,
  resolveTurnCapabilities,
} = await import('./capability-resolution.js');
const { discoveryGovernor } = await import('./discovery-governor.js');
const {
  DiscoveryBudgetDeniedError,
  admitDiscoveryBoundary,
} = await import('./discovery-boundary.js');
const { rememberToolChoice } = await import('../../memory/tool-choice-store.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const PROMPT = 'Pull the top 5 restaurants in Ventura CA from the Apify API, put them in a new Google Sheet with name, rating, and address, then email me the link.';

test('a partial proven capability cannot withhold the first missing-capability discovery', () => {
  rememberToolChoice({
    intent: 'google_sheets.create_restaurants_list',
    description: 'Create a Google Sheet containing restaurant name, rating, and address rows',
    choice: {
      kind: 'composio',
      identifier: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
    },
  });

  const session = eventlog.createSession({ id: 'partial-capability-live-shape', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: PROMPT },
  });
  const resolution = resolveTurnCapabilities(PROMPT, { sessionId: session.id });
  assert.ok(
    resolution.entries.some((entry) => entry.status === 'proven' && entry.identifier.startsWith('GOOGLESHEETS_')),
    'the production resolver must reproduce the known-Sheets side of the live partial-capability shape',
  );
  assert.equal(
    resolution.entries.some((entry) => entry.status === 'proven' && entry.identifier.startsWith('APIFY_')),
    false,
    'Apify remains unresolved and therefore needs discovery',
  );
  recordCapabilityResolution(session.id, resolution, source.seq);
  assert.equal(
    discoveryGovernor.getTaskState({ sessionId: session.id, sourceUserSeq: source.seq })?.policy.knownCapability,
    true,
    'the connection pin must cross the real accepted-source capability-recording seam',
  );

  const first = admitDiscoveryBoundary({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    attemptId: 'partial-capability-attempt',
    toolName: 'composio_search_tools',
    input: {
      toolkit_slug: 'apify',
      query: 'run an Apify Google Maps scraper actor and return restaurant results for a location',
    },
    callId: 'apify-discovery-1',
  });
  assert.ok(first, 'the first search for the unresolved capability is admitted');
  assert.equal(first.category, 'broad_discovery');

  // A synonym carrier for the same toolkit SHARES the claim rather than minting
  // a second one — that is the invariant. It is no longer refused for it: the
  // caller already paid for this call, and a refusal only bought a reformulated
  // retry through yet another door.
  const synonym = admitDiscoveryBoundary({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    attemptId: 'partial-capability-attempt',
    toolName: 'composio_list_tools',
    input: { toolkit_slug: 'apify', limit: 200 },
    callId: 'apify-discovery-synonym-2',
  });
  assert.ok(synonym, 'the synonym carrier is admitted against the claim already held');
  assert.equal(synonym.subject, first.subject, 'synonyms and carriers share one claim subject');
});
