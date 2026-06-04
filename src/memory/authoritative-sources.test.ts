/**
 * Run: npx tsx --test src/memory/authoritative-sources.test.ts
 *
 * Source-category trust priors for connectors-as-authoritative-writers.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifySource,
  cliBinaryFromCommand,
  isSourceTrustEnabled,
  SOURCE_OF_RECORD_TRUST,
  WEB_SOURCE_TRUST,
} from './authoritative-sources.js';

afterEach(() => { delete process.env.CLEMMY_SOURCE_TRUST; });

test('systems of record classify as authoritative (0.9) across naming conventions', () => {
  for (const tool of [
    'SALESFORCE_GET_RECORD_BY_ID',
    'OUTLOOK_OUTLOOK_SEND_EMAIL',
    'mcp__claude_ai_Microsoft_365__outlook_email_search',
    'mcp__claude_ai_Airtable__list_records_for_table',
    'GMAIL_FETCH_EMAILS',
    'mcp__claude_ai_Google_Calendar__list_events',
    'HUBSPOT_GET_CONTACT',
  ]) {
    const c = classifySource(tool);
    assert.ok(c, `expected a classification for ${tool}`);
    assert.equal(c!.trust, SOURCE_OF_RECORD_TRUST, `${tool} → SoR trust`);
    assert.equal(c!.category, 'system_of_record');
    assert.ok(c!.app.length > 0);
  }
});

test('web/scrape sources classify below generic inference (0.5)', () => {
  for (const tool of ['firecrawl', 'mcp__plugin_proposal-builder_dataforseo__serp_organic_live_advanced', 'brightdata_scrape']) {
    const c = classifySource(tool);
    assert.ok(c, `expected a classification for ${tool}`);
    assert.equal(c!.trust, WEB_SOURCE_TRUST, `${tool} → web trust`);
    assert.equal(c!.category, 'web_source');
  }
});

test('unrecognized tools (and the composio wrapper) classify as null → default trust', () => {
  assert.equal(classifySource('composio_execute_tool'), null, 'wrapper carries slug in args, not name');
  assert.equal(classifySource('run_shell_command'), null);
  assert.equal(classifySource('some_random_local_tool'), null);
  assert.equal(classifySource(null), null);
  assert.equal(classifySource(undefined), null);
  assert.equal(classifySource(''), null);
});

test('native-CLI binaries classify as authoritative via EXACT match (no substring false positives)', () => {
  assert.equal(classifySource('sf')?.app, 'Salesforce');
  assert.equal(classifySource('sf')?.trust, SOURCE_OF_RECORD_TRUST);
  assert.equal(classifySource('sfdx')?.app, 'Salesforce');
  assert.equal(classifySource('gh')?.app, 'GitHub');
  // The whole point of exact-match: "transfer" CONTAINS "sf" but must NOT classify.
  assert.equal(classifySource('transfer'), null);
  assert.equal(classifySource('ls'), null);
  assert.equal(classifySource('git'), null); // git ≠ gh; not a connector we map
});

test('cliBinaryFromCommand finds a known connector binary through prefixes, else null', () => {
  assert.equal(cliBinaryFromCommand('sf data query --json "SELECT Id FROM Account"'), 'sf');
  assert.equal(cliBinaryFromCommand('cd ~/proj && sf sobject list'), 'sf');
  assert.equal(cliBinaryFromCommand('npx gh pr list'), 'gh');
  assert.equal(cliBinaryFromCommand('ls -la'), null);
  assert.equal(cliBinaryFromCommand('git status'), null);
  assert.equal(cliBinaryFromCommand('echo transfer funds'), null, 'substring of a word never matches');
  assert.equal(cliBinaryFromCommand(''), null);
  assert.equal(cliBinaryFromCommand(null), null);
});

test('source-trust flag defaults off and reads CLEMMY_SOURCE_TRUST', () => {
  delete process.env.CLEMMY_SOURCE_TRUST;
  assert.equal(isSourceTrustEnabled(), false, 'default off');
  process.env.CLEMMY_SOURCE_TRUST = 'on';
  assert.equal(isSourceTrustEnabled(), true);
  process.env.CLEMMY_SOURCE_TRUST = 'off';
  assert.equal(isSourceTrustEnabled(), false);
});
