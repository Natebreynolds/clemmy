/**
 * Run: npx tsx --test src/runtime/mcp-servers.test.ts
 *
 * Scoped external MCP bases: a named scope must not construct the all-external
 * base first and filter afterward, because that cold-starts unrelated servers.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-mcp-servers-test-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-mcp-servers-test\n', 'utf-8');

const {
  getOrCreateExternalMcpServers,
  invalidateConfiguredMcpServers,
  mcpServersTestHooks,
  prewarmMcpServers,
  resolveMcpPrewarmSelection,
  selectMcpPrewarmServerSlugs,
} = await import('./mcp-servers.js');
const { invalidateMcpServerDiscoveryCache } = await import('./mcp-config.js');
const {
  deleteToolChoice,
  listToolChoices,
  rememberToolChoice,
  updateToolChoiceOutcome,
} = await import('../memory/tool-choice-store.js');

const mcpDir = path.join(TMP_HOME, 'mcp');
const serversPath = path.join(mcpDir, 'servers.json');

function writeMcpServers(servers: Record<string, Record<string, unknown>> = {
  dataforseo: {
    type: 'stdio',
    command: 'node',
    args: ['dataforseo-server.js'],
    description: 'SEO',
    enabled: true,
  },
  supabase: {
    type: 'stdio',
    command: 'node',
    args: ['supabase-server.js'],
    description: 'database',
    enabled: true,
  },
  firecrawl: {
    type: 'http',
    url: 'https://example.test/mcp',
    description: 'web crawl',
    enabled: true,
  },
}): void {
  mkdirSync(mcpDir, { recursive: true });
  writeFileSync(serversPath, JSON.stringify(servers), 'utf-8');
}

function clearToolChoices(): void {
  for (const record of listToolChoices()) {
    deleteToolChoice(record.intent);
  }
}

beforeEach(async () => {
  clearToolChoices();
  writeMcpServers();
  invalidateMcpServerDiscoveryCache();
  await invalidateConfiguredMcpServers();
});

after(async () => {
  await invalidateConfiguredMcpServers();
  invalidateMcpServerDiscoveryCache();
  clearToolChoices();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

test('named external scope creates only a scoped server-set base, not the all-external base', () => {
  getOrCreateExternalMcpServers({
    reason: 'seo turn',
    allowedServerSlugs: ['dataforseo'],
    toolPatterns: ['dataforseo__'],
    maxTools: 25,
  });

  const state = mcpServersTestHooks.cacheState();
  assert.equal(state.allExternalBaseCreated, false, 'named scope must not build the all-external base');
  assert.deepEqual(state.scopedExternalBaseKeys, ['dataforseo']);
  assert.equal(state.scopedExternalViewKeys.length, 1, 'the full scope still gets a cached filtered view');
  assert.equal(state.failOpenCreated, false);
  assert.deepEqual(mcpServersTestHooks.rawExternalServerNames(['dataforseo']), ['dataforseo']);
});

test('multiple tool-pattern scopes for the same server set reuse one scoped base', () => {
  getOrCreateExternalMcpServers({
    reason: 'seo broad',
    allowedServerSlugs: ['dataforseo'],
    toolPatterns: ['serp'],
    maxTools: 10,
  });
  getOrCreateExternalMcpServers({
    reason: 'seo backlink',
    allowedServerSlugs: ['dataforseo'],
    toolPatterns: ['backlink'],
    priorityKeywords: ['backlink'],
    maxTools: 5,
  });

  const state = mcpServersTestHooks.cacheState();
  assert.deepEqual(state.scopedExternalBaseKeys, ['dataforseo']);
  assert.equal(state.scopedExternalViewKeys.length, 2, 'different caps/patterns remain distinct filtered views');
  assert.equal(state.allExternalBaseCreated, false);
});

test('fail-open and allow-all still use the all-external base by design', async () => {
  getOrCreateExternalMcpServers({
    reason: 'unrecognized external intent',
    failOpenCandidate: true,
    maxTools: 8,
  });

  let state = mcpServersTestHooks.cacheState();
  assert.equal(state.allExternalBaseCreated, true);
  assert.deepEqual(state.scopedExternalBaseKeys, []);
  assert.equal(state.failOpenCreated, true);

  await invalidateConfiguredMcpServers();
  invalidateMcpServerDiscoveryCache();
  writeMcpServers();

  getOrCreateExternalMcpServers({ reason: 'legacy broad attach', allowAll: true });
  state = mcpServersTestHooks.cacheState();
  assert.equal(state.allExternalBaseCreated, true);
  assert.deepEqual(state.scopedExternalBaseKeys, []);
});

test('empty or explicitly zero external scope stays empty and creates no base', () => {
  const empty = getOrCreateExternalMcpServers({
    reason: 'no external tools',
    allowedServerSlugs: [],
    maxTools: 20,
  });
  const zero = getOrCreateExternalMcpServers({
    reason: 'explicit external cap zero',
    allowedServerSlugs: ['dataforseo'],
    maxTools: 0,
  });

  assert.equal(empty.name, 'clementine-external-empty');
  assert.equal(zero.name, 'clementine-external-empty');
  assert.deepEqual(mcpServersTestHooks.cacheState(), {
    allExternalBaseCreated: false,
    scopedExternalBaseKeys: [],
    scopedExternalViewKeys: [],
    failOpenCreated: false,
  });
});

test('prewarm selection defaults to none when multiple external servers have no demand signal', () => {
  assert.deepEqual(selectMcpPrewarmServerSlugs({ limit: 3 }), []);
  assert.deepEqual(resolveMcpPrewarmSelection({ mode: 'on' }), {
    mode: 'none',
    allowedServerSlugs: [],
    reason: 'no remembered MCP server and multiple/no configured servers',
  });
});

test('prewarm selection warms the single configured external server without falling back to all', () => {
  writeMcpServers({
    dataforseo: {
      type: 'stdio',
      command: 'node',
      args: ['dataforseo-server.js'],
      description: 'SEO',
      enabled: true,
    },
  });
  invalidateMcpServerDiscoveryCache();

  assert.deepEqual(selectMcpPrewarmServerSlugs({ limit: 3 }), ['dataforseo']);
  assert.deepEqual(resolveMcpPrewarmSelection({ mode: 'scoped' }), {
    mode: 'scoped',
    allowedServerSlugs: ['dataforseo'],
    reason: 'remembered/single-server scoped prewarm',
  });
});

test('prewarm selection uses healthy remembered MCP servers and skips failed or non-MCP memories', () => {
  rememberToolChoice({
    intent: 'seo rankings',
    choice: {
      kind: 'mcp',
      identifier: 'dataforseo__serp_organic_live_advanced',
      testedAt: '2026-07-01T00:00:00.000Z',
    },
  });
  for (let i = 0; i < 4; i += 1) updateToolChoiceOutcome('seo rankings', 'success');
  rememberToolChoice({
    intent: 'fire crawl',
    choice: {
      kind: 'mcp',
      identifier: 'firecrawl__scrape',
      testedAt: '2026-07-02T00:00:00.000Z',
    },
  });
  updateToolChoiceOutcome('fire crawl', 'success');
  updateToolChoiceOutcome('fire crawl', 'failure');
  updateToolChoiceOutcome('fire crawl', 'failure');
  rememberToolChoice({
    intent: 'db query via composio',
    choice: {
      kind: 'composio',
      identifier: 'SUPABASE_QUERY',
      testedAt: '2026-07-04T00:00:00.000Z',
    },
  });
  updateToolChoiceOutcome('db query via composio', 'success');
  rememberToolChoice({
    intent: 'invalid mcp prose',
    choice: {
      kind: 'mcp',
      identifier: 'not a callable tool',
      testedAt: '2026-07-05T00:00:00.000Z',
    },
  });
  updateToolChoiceOutcome('invalid mcp prose', 'success');

  assert.deepEqual(selectMcpPrewarmServerSlugs({ limit: 3 }), ['dataforseo']);
  assert.deepEqual(resolveMcpPrewarmSelection({ mode: 'on' }), {
    mode: 'scoped',
    allowedServerSlugs: ['dataforseo'],
    reason: 'remembered/single-server scoped prewarm',
  });
});

test('prewarm selection honors explicit scoped/all/off settings', () => {
  assert.deepEqual(resolveMcpPrewarmSelection({ mode: 'off' }), {
    mode: 'off',
    reason: 'CLEMMY_MCP_PREWARM=off',
  });
  assert.deepEqual(resolveMcpPrewarmSelection({ mode: 'all' }), {
    mode: 'all',
    reason: 'CLEMMY_MCP_PREWARM=all',
  });
  assert.deepEqual(resolveMcpPrewarmSelection({ mode: 'on', servers: 'firecrawl, dataforseo' }), {
    mode: 'scoped',
    allowedServerSlugs: ['dataforseo', 'firecrawl'],
    reason: 'explicit CLEMMY_MCP_PREWARM_SERVERS',
  });
  assert.deepEqual(resolveMcpPrewarmSelection({ mode: 'on', servers: '*' }), {
    mode: 'all',
    reason: 'CLEMMY_MCP_PREWARM_SERVERS=*',
  });
});

test('empty scoped prewarm is a no-op and does not construct any external base', async () => {
  const result = await prewarmMcpServers({ allowedServerSlugs: [] });
  assert.deepEqual(result, { attempts: 0, allConnected: true, target: 'none', serverSlugs: [] });
  assert.deepEqual(mcpServersTestHooks.cacheState(), {
    allExternalBaseCreated: false,
    scopedExternalBaseKeys: [],
    scopedExternalViewKeys: [],
    failOpenCreated: false,
  });
});

test('npx stdio external servers launch with isolated npm cache defaults', () => {
  writeMcpServers({
    dataforseo: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'dataforseo-mcp-server'],
      description: 'SEO',
      enabled: true,
    },
    supabase: {
      type: 'stdio',
      command: '/usr/local/bin/npx',
      args: ['-y', '@supabase/mcp-server-supabase'],
      description: 'database',
      enabled: true,
    },
    direct: {
      type: 'stdio',
      command: 'node',
      args: ['direct-server.js'],
      description: 'direct stdio server',
      enabled: true,
    },
  });
  invalidateMcpServerDiscoveryCache();

  const launches = mcpServersTestHooks.rawExternalStdioLaunches();
  const dataforseo = launches.find((server) => server.name === 'dataforseo');
  const supabase = launches.find((server) => server.name === 'supabase');
  const direct = launches.find((server) => server.name === 'direct');

  assert.ok(dataforseo);
  assert.ok(supabase);
  assert.ok(direct);
  assert.equal(path.basename(dataforseo.env.npm_config_cache), 'dataforseo');
  assert.equal(path.basename(supabase.env.npm_config_cache), 'supabase');
  assert.notEqual(dataforseo.env.npm_config_cache, supabase.env.npm_config_cache);
  assert.equal(dataforseo.env.NPM_CONFIG_CACHE, dataforseo.env.npm_config_cache);
  assert.equal(dataforseo.env.npm_config_update_notifier, 'false');
  assert.equal(dataforseo.env.npm_config_audit, 'false');
  assert.equal(dataforseo.env.npm_config_fund, 'false');
  assert.equal(dataforseo.env.npm_config_yes, 'true');
  assert.equal(existsSync(dataforseo.env.npm_config_cache), true);
  assert.equal(existsSync(supabase.env.npm_config_cache), true);
  const marker = JSON.parse(readFileSync(path.join(dataforseo.env.npm_config_cache, '.last-used.json'), 'utf8')) as { server: string; at: string };
  assert.equal(marker.server, 'dataforseo');
  assert.ok(Number.isFinite(Date.parse(marker.at)), 'cache last-used marker is timestamped for safe retention');
  assert.notEqual(direct.env.npm_config_cache, dataforseo.env.npm_config_cache);
  assert.notEqual(direct.env.npm_config_cache, supabase.env.npm_config_cache);
});
