/**
 * Run: npx tsx --test src/runtime/mcp-servers.test.ts
 *
 * Scoped external MCP bases: a named scope must not construct the all-external
 * base first and filter afterward, because that cold-starts unrelated servers.
 */
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
  getOrCreateExternalMcpServerForTool,
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

test('named scope matches canonical MCP suffix aliases but never substring-confusable servers', async () => {
  writeMcpServers({
    'dataforseo-mcp-server': {
      type: 'stdio',
      command: 'node',
      args: ['real-dataforseo.js'],
      enabled: true,
    },
    'evil-dataforseo-proxy': {
      type: 'stdio',
      command: 'node',
      args: ['evil-proxy.js'],
      enabled: true,
    },
  });
  invalidateMcpServerDiscoveryCache();
  await invalidateConfiguredMcpServers();
  assert.deepEqual(
    mcpServersTestHooks.rawExternalServerNames(['dataforseo']),
    ['dataforseo-mcp-server'],
  );
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

test('per-server caps and exact tool leases produce distinct cached views in either order', async () => {
  const scope = (tool: string, cap: number) => ({
    reason: `packet ${tool} cap ${cap}`,
    allowedServerSlugs: ['dataforseo'],
    allowedToolNames: [`dataforseo__${tool}`],
    maxTools: 8,
    serverMaxTools: { dataforseo: cap },
  });
  getOrCreateExternalMcpServers(scope('ranked_keywords', 1));
  getOrCreateExternalMcpServers(scope('ranked_keywords', 3));
  getOrCreateExternalMcpServers(scope('keywords_for_site', 3));
  assert.equal(mcpServersTestHooks.cacheState().scopedExternalViewKeys.length, 3);

  await invalidateConfiguredMcpServers();
  invalidateMcpServerDiscoveryCache();
  writeMcpServers();
  getOrCreateExternalMcpServers(scope('keywords_for_site', 3));
  getOrCreateExternalMcpServers(scope('ranked_keywords', 3));
  getOrCreateExternalMcpServers(scope('ranked_keywords', 1));
  assert.equal(mcpServersTestHooks.cacheState().scopedExternalViewKeys.length, 3);
});

test('a named scope without maxTools still creates its scoped base', () => {
  getOrCreateExternalMcpServers({
    reason: 'exact workflow lock without a cap',
    allowedServerSlugs: ['dataforseo'],
  });
  assert.deepEqual(mcpServersTestHooks.cacheState().scopedExternalBaseKeys, ['dataforseo']);
});

test('scoped callTool dispatches only an exact member of the selected list', async () => {
  let listCalls = 0;
  let dispatchCalls = 0;
  const base = {
    cacheToolsList: true,
    name: 'fake-base',
    async connect() {},
    async close() {},
    async listTools() {
      listCalls += 1;
      return [
        { name: 'dataforseo__read_serp', description: 'read' },
        { name: 'dataforseo__delete_task', description: 'delete' },
      ];
    },
    async callTool() {
      dispatchCalls += 1;
      return [{ type: 'text', text: 'ok' }];
    },
    async invalidateToolsCache() {},
  };
  const scoped = mcpServersTestHooks.scopedView(base as never, {
    reason: 'read only',
    allowedServerSlugs: ['dataforseo'],
    toolPatterns: ['read'],
    maxTools: 1,
  });
  await assert.rejects(
    () => scoped.callTool('dataforseo__delete_task', {}),
    /outside this turn's scope|not selected for this turn/,
  );
  assert.equal(dispatchCalls, 0, 'an off-pattern guessed tool never reaches the base');
  await scoped.callTool('dataforseo__read_serp', {});
  assert.equal(dispatchCalls, 1);
  assert.equal(listCalls, 1, 'the exact advertised membership is cached for dispatch');
});

test('scoped callTool accepts the MCP carrier but dispatches the advertised server__tool identity', async () => {
  const dispatched: Array<{ toolName: string; args: Record<string, unknown> | null }> = [];
  const base = {
    cacheToolsList: true,
    name: 'fake-carrier-base',
    async connect() {},
    async close() {},
    async listTools() {
      return [{ name: 'dataforseo__read_serp', description: 'read' }];
    },
    async callTool(toolName: string, args: Record<string, unknown> | null) {
      dispatched.push({ toolName, args });
      return [{ type: 'text', text: 'ok' }];
    },
    async invalidateToolsCache() {},
  };
  const scoped = mcpServersTestHooks.scopedView(base as never, {
    reason: 'exact typed worker lease',
    allowedServerSlugs: ['dataforseo'],
    allowedToolNames: ['mcp__dataforseo__read_serp'],
    maxTools: 1,
  });

  await scoped.callTool('mcp__dataforseo__read_serp', { keyword: 'clementine' });

  assert.deepEqual(dispatched, [{
    toolName: 'dataforseo__read_serp',
    args: { keyword: 'clementine' },
  }]);
});

test('exact on-demand tool dispatch reuses only its server-scoped base', () => {
  const shim = getOrCreateExternalMcpServerForTool(
    'mcp__dataforseo__dataforseo_labs_google_keyword_suggestions',
  );
  assert.match(shim.name, /mcp/i);
  const state = mcpServersTestHooks.cacheState();
  assert.equal(state.allExternalBaseCreated, false, 'exact dispatch must not cold-start every external server');
  assert.deepEqual(state.scopedExternalBaseKeys, ['dataforseo']);
  assert.throws(
    () => getOrCreateExternalMcpServerForTool('missing__tool'),
    /No enabled MCP server matches namespace/,
  );
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

test('an explicit zero-width fail-open scope does not construct external providers', () => {
  getOrCreateExternalMcpServers({
    reason: 'zero-width fail-open',
    failOpenCandidate: true,
    maxTools: 0,
  });
  assert.equal(mcpServersTestHooks.cacheState().allExternalBaseCreated, false);
  assert.equal(mcpServersTestHooks.cacheState().failOpenCreated, false);
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

test('prewarm selection reads legacy tool memory without triggering canonical migration writes', () => {
  const machineId = 'machine-mcp-servers-test';
  const legacyDir = path.join(TMP_HOME, 'memory', 'tool-choices', machineId);
  const procedureDir = path.join(TMP_HOME, 'memory', 'tool-procedures', machineId);
  mkdirSync(legacyDir, { recursive: true });
  const legacyPath = path.join(legacyDir, 'dataforseo-serp.md');
  writeFileSync(legacyPath, [
    '---',
    'intent: dataforseo serp',
    'choice:',
    '  kind: mcp',
    '  identifier: dataforseo__serp_organic_live_advanced',
    '  testedAt: 2026-07-01T00:00:00.000Z',
    '  successCount: 4',
    'fallbacks: []',
    '---',
    '# legacy alias',
    '',
  ].join('\n'));
  const old = new Date('2004-04-04T00:00:00.000Z');
  utimesSync(legacyPath, old, old);
  const contentsBefore = readFileSync(legacyPath, 'utf-8');
  const mtimeBefore = statSync(legacyPath).mtimeMs;
  const proceduresBefore = existsSync(procedureDir) ? readdirSync(procedureDir).sort() : [];

  assert.deepEqual(resolveMcpPrewarmSelection({ mode: 'on' }), {
    mode: 'scoped',
    allowedServerSlugs: ['dataforseo'],
    reason: 'remembered/single-server scoped prewarm',
  });
  assert.equal(readFileSync(legacyPath, 'utf-8'), contentsBefore);
  assert.equal(statSync(legacyPath).mtimeMs, mtimeBefore);
  assert.deepEqual(
    existsSync(procedureDir) ? readdirSync(procedureDir).sort() : [],
    proceduresBefore,
    'prewarm must not create canonical procedures or a migration marker',
  );
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
