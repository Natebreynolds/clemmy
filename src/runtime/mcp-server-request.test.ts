import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  mcpServerCreateSummary,
  prepareMcpServerCreateRequest,
  type McpServerCreatePreparation,
} from './mcp-server-request.js';

// The preparer receives canonical identities from the caller. Route controls
// below exercise the runtime's actual slugger, discovery, and persistence.
const options = { existingNames: [], slugifyName: (name: string) => name.toLowerCase() };

function accepted(body: unknown) {
  const result = prepareMcpServerCreateRequest(body, options);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  return result.server;
}

function rejected(body: unknown, expected: 400 | 409 = 400): Extract<McpServerCreatePreparation, { ok: false }> {
  const result = prepareMcpServerCreateRequest(body, options);
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.status, expected);
  return result;
}

test('stdio preparation preserves complete valid fields, empty values, and disabled state without mutating input', () => {
  const body = Object.freeze({
    name: ' Fixture.Server ', type: 'stdio', command: '/path with spaces/server',
    args: Object.freeze(['--flag', '', '${EXACT_VALUE}']), enabled: false,
    description: 'Named local fixture', url: 'https://retained.example/mcp',
    env: Object.freeze({ TOKEN: '${PRIVATE_TOKEN}', EMPTY: '' }),
    headers: Object.freeze({ Authorization: 'Bearer private-header' }),
  });
  const server = accepted(body);
  assert.deepEqual(server, { ...body, name: 'Fixture.Server' });
  assert.notEqual(server.args, body.args);
  assert.notEqual(server.env, body.env);
  assert.notEqual(server.headers, body.headers);
  server.args!.push('new-argument');
  server.env!.TOKEN = 'changed';
  assert.deepEqual(body.args, ['--flag', '', '${EXACT_VALUE}']);
  assert.equal(body.env.TOKEN, '${PRIVATE_TOKEN}');
});

test('omitted transport/enabled keep existing defaults and HTTP/SSE retain valid connection fields', () => {
  assert.deepEqual(accepted({ name: 'default-server', command: 'node' }), {
    name: 'default-server', type: 'stdio', enabled: true, command: 'node',
  });
  for (const type of ['http', 'sse']) {
    const body = { name: 'remote-server', type, url: 'http://127.0.0.1:8080/mcp?key=private',
      headers: { 'X-Token': 'private-token' }, env: { REMOTE_TOKEN: '' }, description: '' };
    assert.deepEqual(accepted(body), { ...body, enabled: true });
  }
});

test('invalid requests and wrongly typed optional fields are rejected instead of silently dropped or coerced', () => {
  for (const body of [undefined, null, [], 'config', 1, new Date()]) rejected(body);
  for (const name of ['', 'x', 'has space', 'x'.repeat(41)]) rejected({ name, command: 'node' });
  for (const command of [undefined, null, '', '   ', 42, 'node\0bad']) rejected({ name: 'fixture', command });
  for (const fields of [
    { type: 'websocket' }, { type: null }, { enabled: 'false' }, { enabled: null },
    { description: {} }, { args: '--token private-value' }, { args: ['valid', 42] },
    { args: ['valid', null] }, { args: ['bad\0argument'] }, { env: [] }, { env: null },
    { env: { GOOD: 'yes', BAD: 42 } }, { env: { '': 'value' } },
    { env: { 'BAD=NAME': 'value' } }, { env: { TOKEN: 'bad\0value' } },
    { headers: [] }, { headers: { Authorization: false } },
    { headers: { 'Bad Name': 'private-value' } },
    { headers: { Authorization: 'private-value\r\nX-Injected: yes' } }, { url: 42 },
  ]) rejected({ name: 'fixture', command: 'node', ...fields });
});

test('remote URL validation rejects unsupported, relative, missing, or malformed endpoints for both transports', () => {
  for (const type of ['http', 'sse']) {
    for (const url of [undefined, '', '/mcp', 'http:example.com', 'https://', 'file:///tmp/mcp',
      'javascript:private-value', 'ftp://example.com', ' https://example.com']) {
      rejected({ name: 'fixture', type, url });
    }
  }
});

test('conflicts return a static actionable 409 for any current/discovered identity or reserved builtin', () => {
  for (const existingNames of [['fixture'], ['FIXTURE']]) {
    const result = prepareMcpServerCreateRequest({ name: 'fixture', command: 'node' }, { ...options, existingNames });
    assert.deepEqual(result, {
      ok: false, status: 409, code: 'mcp_server_exists',
      error: 'A server with this name already exists. Edit the existing server or choose a different name.',
    });
  }
  rejected({ name: 'Clementine-Local', command: 'node' }, 409);
});

test('object-reserved names are invalid even when the configuration has no current entries', () => {
  for (const name of ['__proto__', 'constructor', 'prototype', ' __proto__ ']) {
    assert.deepEqual(rejected({ name, command: 'node' }), {
      ok: false, status: 400, code: 'invalid_mcp_server',
      error: 'This server name is reserved. Choose a different name.',
    });
  }
});

test('success summary and all validation errors exclude credentials, URLs, commands, and arguments', () => {
  const secret = 'private-fixture-credential-never-return';
  const server = accepted({ name: 'fixture', command: secret, args: [secret], url: `https://example.com/${secret}`,
    env: { TOKEN: secret }, headers: { Authorization: secret }, description: 'Safe label' });
  assert.deepEqual(mcpServerCreateSummary(server), { name: 'fixture', type: 'stdio', enabled: true, description: 'Safe label' });
  assert.ok(!JSON.stringify(mcpServerCreateSummary(server)).includes(secret));
  for (const fields of [{ args: [secret, false] }, { env: { [secret]: false } },
    { headers: { [secret]: false } }, { type: secret }, { url: `file:///${secret}`, type: 'http' }]) {
    assert.ok(!JSON.stringify(rejected({ name: 'fixture', command: 'node', ...fields })).includes(secret));
  }
});

test('registered MCP create route protects real config and discovery without launching servers or using a socket', async (t) => {
  assert.equal(process.env.CLEMMY_TEST_ISOLATED_HOME, '1', 'use the repository isolated runner');
  const fixtureHome = mkdtempSync(path.join(os.tmpdir(), 'clem-mcp-create-route-'));
  process.env.CLEMENTINE_HOME = fixtureHome;
  process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
  process.env.NODE_ENV = 'test';
  mkdirSync(path.join(fixtureHome, 'state'), { recursive: true });
  const [{ default: express }, { registerConsoleRoutes }, config, mcp] = await Promise.all([
    import('express'), import('../dashboard/console-routes.js'), import('../config.js'), import('./mcp-config.js'),
  ]);
  assert.ok(config.MCP_SERVERS_FILE.startsWith(fixtureHome + path.sep));
  const app = express();
  let authorized = true;
  registerConsoleRoutes(app, () => authorized, {} as never, { serveLegacyAtRoot: false });
  const route = (app as unknown as { _router: { stack: Array<{
    route?: { path: string; methods: { post?: boolean }; stack: Array<{ handle: (req: unknown, res: unknown) => Promise<void> }> };
  }> } })._router.stack.find((entry) => entry.route?.path === '/api/console/mcp-servers' && entry.route.methods.post)?.route;
  assert.ok(route);
  async function request(body: unknown, method: 'post' | 'get' | 'patch' = 'post', name?: string, credential = false) {
    let status = 200;
    let payload: unknown;
    const response = {
      status(code: number) { status = code; return response; },
      json(value: unknown) { payload = value; return response; },
    };
    const requestedPath = credential ? '/api/console/mcp-servers/:name/credential'
      : method === 'patch' ? '/api/console/mcp-servers/:name' : '/api/console/mcp-servers';
    const selected = (app as any)._router.stack.find((entry: any) =>
      entry.route?.path === requestedPath && entry.route.methods[method])?.route.stack[0].handle;
    assert.ok(selected);
    await selected({ body, params: { name } }, response);
    return { status, payload };
  }
  const post = (body: unknown) => request(body);
  const original = {
    'Existing__Server': {
      name: 'Existing__Server', type: 'stdio', command: 'not-executed-existing-command',
      enabled: false, args: ['keep'], env: { TOKEN: 'existing-secret' },
      headers: { Authorization: 'existing-header' }, description: 'Keep description', customField: { keep: true },
    },
  };
  function seed() {
    rmSync(config.MCP_SERVERS_FILE, { recursive: true, force: true });
    mkdirSync(path.dirname(config.MCP_SERVERS_FILE), { recursive: true });
    writeFileSync(config.MCP_SERVERS_FILE, JSON.stringify(original));
    mcp.invalidateMcpServerDiscoveryCache();
  }
  t.after(() => {
    rmSync(fixtureHome, { recursive: true, force: true });
  });

  await t.test('authorization, malformed fields, exact names, canonical slug aliases, and builtin refuse before a save', async () => {
    seed();
    const bytes = readFileSync(config.MCP_SERVERS_FILE, 'utf8');
    const discovered = mcp.discoverMcpServers();
    authorized = false;
    assert.deepEqual(await post({ name: 'unauthorized', command: 'node' }), { status: 401, payload: { error: 'unauthorized' } });
    authorized = true;
    for (const name of ['Existing__Server', 'existing_server', '_existing_server_', 'CLEMENTINE-LOCAL']) {
      const response = await post({ name, command: 'different-command', enabled: false });
      assert.equal(response.status, 409);
      assert.equal((response.payload as { code: string }).code, 'mcp_server_exists');
    }
    assert.equal((await post({ name: 'invalid-new', command: 'node', args: ['valid', 42] })).status, 400);
    assert.equal(readFileSync(config.MCP_SERVERS_FILE, 'utf8'), bytes);
    assert.equal(mcp.discoverMcpServers(), discovered, 'rejections do not invalidate discovery');
  });

  await t.test('auto-discovered names also conflict without creating a user override', async () => {
    seed();
    const claudeDir = path.join(os.homedir(), '.claude');
    const settingsFile = path.join(claudeDir, 'settings.json');
    assert.equal(existsSync(settingsFile), false, 'outer runner provides a disposable user home');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(settingsFile, JSON.stringify({ mcpServers: { 'Imported Fixture': { command: 'not-executed-import' } } }));
    process.env.MCP_AUTO_IMPORT_ENABLED = 'true';
    mcp.invalidateMcpServerDiscoveryCache();
    try {
      const bytes = readFileSync(config.MCP_SERVERS_FILE, 'utf8');
      const discovered = mcp.discoverMcpServers();
      assert.equal(discovered.find((server) => server.name === 'Imported Fixture')?.source, 'auto-detected');
      assert.equal((await post({ name: 'imported_fixture', command: 'not-executed-replacement', enabled: false })).status, 409);
      assert.equal(readFileSync(config.MCP_SERVERS_FILE, 'utf8'), bytes);
      assert.equal(mcp.discoverMcpServers(), discovered);
    } finally {
      rmSync(settingsFile);
      process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
      mcp.invalidateMcpServerDiscoveryCache();
    }
  });

  await t.test('valid create preserves existing fields, saves submitted fields, and returns metadata only', async () => {
    seed();
    const body = { name: 'new-fixture', type: 'http', enabled: false, description: 'Safe description',
      command: 'private-command', args: ['private-argument'], url: 'https://example.com/private-url',
      env: { TOKEN: 'private-env' }, headers: { Authorization: 'private-header' } };
    const response = await post(body);
    assert.deepEqual(response, { status: 201, payload: { server: {
      name: 'new-fixture', type: 'http', enabled: false, description: 'Safe description',
    } } });
    const saved = JSON.parse(readFileSync(config.MCP_SERVERS_FILE, 'utf8'));
    assert.deepEqual(saved, { ...original, 'new-fixture': body });
    assert.ok(!JSON.stringify(response.payload).includes('private-'));
  });

  await t.test('simultaneous same-name submissions admit one create and refuse the replacement', async () => {
    seed();
    const requests = [
      { name: 'race-fixture', command: 'first-not-executed', enabled: false },
      { name: 'RACE-fixture', command: 'second-not-executed', enabled: false },
    ];
    const responses = await Promise.all(requests.map(post));
    assert.deepEqual(responses.map((response) => response.status), [201, 409]);
    const saved = JSON.parse(readFileSync(config.MCP_SERVERS_FILE, 'utf8'));
    assert.equal(saved['race-fixture'].command, requests[0].command);
    assert.ok(!Object.hasOwn(saved, 'RACE-fixture'));
  });

  await t.test('object-reserved names refuse before saving or modifying existing configuration', async () => {
    seed();
    const bytes = readFileSync(config.MCP_SERVERS_FILE, 'utf8');
    const discovered = mcp.discoverMcpServers();
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      assert.equal((await post({ name, command: 'not-executed-reserved', enabled: false })).status, 400);
    }
    assert.equal(readFileSync(config.MCP_SERVERS_FILE, 'utf8'), bytes);
    assert.deepEqual(JSON.parse(bytes), original);
    assert.equal(mcp.discoverMcpServers(), discovered);
  });

  await t.test('list and user overrides expose metadata and credential key names, never connection values', async () => {
    seed();
    const before = readFileSync(config.MCP_SERVERS_FILE, 'utf8');
    const response = await request(undefined, 'get');
    assert.equal(response.status, 200);
    const body = response.payload as { servers: Array<Record<string, unknown>>; userOverrides: Record<string, Record<string, unknown>> };
    const external = body.servers.find((server) => server.name === 'Existing__Server');
    assert.ok(external);
    assert.equal(external.type, 'stdio');
    assert.equal(external.enabled, false);
    assert.equal(external.source, 'user');
    assert.equal(external.description, original.Existing__Server.description);
    assert.equal(external.state, 'unknown');
    assert.deepEqual(external.declaredEnvKeys, ['TOKEN']);
    assert.deepEqual(external.unsetEnvKeys, []);
    assert.ok(body.servers.some((server) => server.name === 'clementine-local' && server.builtin === true));
    assert.deepEqual(body.userOverrides.Existing__Server.declaredEnvKeys, ['TOKEN']);
    for (const summary of [external, body.userOverrides.Existing__Server]) {
      for (const key of ['command', 'args', 'url', 'env', 'headers', 'customField']) {
        assert.ok(!Object.hasOwn(summary, key), `must omit connection field ${key}`);
      }
    }
    for (const secret of ['existing-secret', 'existing-header', 'not-executed-existing-command']) {
      assert.ok(!JSON.stringify(body).includes(secret));
    }
    assert.equal(readFileSync(config.MCP_SERVERS_FILE, 'utf8'), before, 'list is read-only');
    authorized = false;
    assert.deepEqual(await request(undefined, 'get'), { status: 401, payload: { error: 'unauthorized' } });
    authorized = true;
  });

  await t.test('patch preserves stored connection values while returning only safe metadata and key names', async () => {
    seed();
    const response = await request({ enabled: false, description: 'Updated safe description' }, 'patch', 'Existing__Server');
    assert.equal(response.status, 200);
    const summary = (response.payload as { server: Record<string, unknown> }).server;
    assert.equal(summary.name, 'Existing__Server');
    assert.equal(summary.enabled, false);
    assert.equal(summary.description, 'Updated safe description');
    for (const key of ['command', 'args', 'url', 'env', 'headers', 'customField']) assert.ok(!Object.hasOwn(summary, key));
    assert.deepEqual(summary.declaredEnvKeys, ['TOKEN']);
    assert.ok(!JSON.stringify(response.payload).includes('existing-secret'));
    assert.deepEqual(JSON.parse(readFileSync(config.MCP_SERVERS_FILE, 'utf8')), {
      Existing__Server: { ...original.Existing__Server, description: 'Updated safe description' },
    });
  });

  await t.test('saving a declared credential on a disabled server resolves the value without starting or claiming connection', async () => {
    seed();
    const name = 'disabled-credential-fixture';
    const key = 'CLEMMY_MCP_DISABLED_ROUTE_FIXTURE_TOKEN';
    const value = 'synthetic-disabled-route-value';
    const definition = { name, type: 'stdio', command: 'not-executed-disabled-credential-command',
      enabled: false, env: { [key]: '' }, description: 'Disabled credential fixture' };
    writeFileSync(config.MCP_SERVERS_FILE, JSON.stringify({ [name]: definition }));
    mcp.invalidateMcpServerDiscoveryCache();
    const previous = process.env[key];
    delete process.env[key];
    const envFile = path.join(config.BASE_DIR, '.env');
    const previousEnv = existsSync(envFile) ? readFileSync(envFile, 'utf8') : undefined;
    try {
      const response = await request({ key, value }, 'post', name, true);
      assert.equal(response.status, 200);
      assert.deepEqual(response.payload, { ok: true, server: name, key, set: true, state: 'disabled', unsetEnvKeys: [] });
      assert.ok(!JSON.stringify(response.payload).includes(value));
      assert.ok(!Object.hasOwn(response.payload as object, 'tools'));
      assert.ok(!Object.hasOwn(response.payload as object, 'toolCount'));
      const saved = JSON.parse(readFileSync(config.MCP_SERVERS_FILE, 'utf8'));
      assert.deepEqual(saved, { [name]: definition }, 'human credential entry does not alter or enable the server definition');
      const { readMcpServerEnv } = await import('./mcp-server-env.js');
      const resolved = readMcpServerEnv(saved[name].env, envFile, {});
      assert.deepEqual(resolved.declaredEnvKeys, [key]);
      assert.deepEqual(resolved.unsetEnvKeys, []);
      assert.equal(resolved.values[key], value, 'actual daemon-file resolver sees the saved value without inherited process env');
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
      if (previousEnv === undefined) rmSync(envFile, { force: true });
      else writeFileSync(envFile, previousEnv);
    }
  });

  await t.test('persistence failures return a generic error without raw paths or submitted connection values', async () => {
    seed();
    rmSync(config.MCP_SERVERS_FILE);
    mkdirSync(config.MCP_SERVERS_FILE);
    mcp.invalidateMcpServerDiscoveryCache();
    assert.deepEqual(await post({ name: 'save-failure', command: 'private-command', enabled: false }), {
      status: 500,
      payload: { error: 'Could not finish adding the MCP server. Refresh the server list before trying again.' },
    });
  });
});
