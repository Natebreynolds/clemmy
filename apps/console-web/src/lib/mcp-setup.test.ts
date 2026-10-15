import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMcpSetup } from './mcp-setup';

const server = (text: string, name?: string) => {
  const result = parseMcpSetup(text, name);
  assert.equal(result.ok, true, result.ok ? undefined : result.error);
  if (!result.ok) throw new Error('Expected a valid setup.');
  assert.equal(result.servers.length, 1);
  return result.servers[0]!;
};

function rejects(text: string, name?: string) {
  const result = parseMcpSetup(text, name);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected invalid setup.');
  assert.ok(result.error.length > 0);
  assert.equal('servers' in result, false, 'invalid multi-server input must not expose a partial submission');
  return result.error;
}

test('launch command keeps quoted spaces, quoted empty args and Windows backslashes', () => {
  assert.deepEqual(server('npx -y "@example/server" "/Users/Test Person/Docs" ""', 'files'), {
    name: 'files', type: 'stdio', command: 'npx', args: ['-y', '@example/server', '/Users/Test Person/Docs', ''],
  });
  assert.deepEqual(server('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Test Person\\server.js" --path C:\\Docs\\Files', 'windows'), {
    name: 'windows', type: 'stdio', command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['C:\\Users\\Test Person\\server.js', '--path', 'C:\\Docs\\Files'],
  });
});

test('launch command supports literal single quotes, escaped spaces and escaped quote characters', () => {
  assert.deepEqual(server("node '/tmp/team docs/server.js' /tmp/my\\ folder --label \"say \\\"hello\\\"\"", 'docs').args,
    ['/tmp/team docs/server.js', '/tmp/my folder', '--label', 'say "hello"']);
});

test('launch command requires a name and an executable', () => {
  rejects('npx -y @example/server');
  rejects('   ', 'server');
  rejects('"" --flag', 'server');
  rejects('-y @example/server', 'server');
  rejects('npx -y @example/server', 'bad name');
});

test('malformed quoting and unsupported shell syntax fail without guessing', () => {
  for (const command of [
    'node "unfinished', "node 'unfinished", 'node server.js && other', 'node server.js; other',
    'node server.js | other', 'node server.js > output', 'node server.js < input', 'node server.js &',
    'node $(other)', 'node `other`', 'node "$HOME/server.js"', 'node ${HOME}/server.js',
    'TOKEN=value node server.js', 'node %APPDATA%\\server.js', 'node server.js\nother', 'node server.js # comment',
    'bash -c "node server.js"', 'cmd.exe /c "node server.js"', 'pwsh -Command "node server.js"',
  ]) rejects(command, 'server');
});

test('quoted shell punctuation is a literal argument, never executed or expanded', () => {
  assert.deepEqual(server("node server.js '--literal=one&two|three;four' '$LITERAL' '%LITERAL%'", 'server').args,
    ['server.js', '--literal=one&two|three;four', '$LITERAL', '%LITERAL%']);
});

test('whole MCP JSON imports every named entry with exact string arrays and private values', () => {
  const result = parseMcpSetup(JSON.stringify({ mcpServers: {
    files: { command: 'node', args: ['/Users/Test Person/server.js', '', 'a\\b', '--literal=$VALUE'], env: { API_KEY: ' private value ', EMPTY: '' }, description: 'Local files', enabled: false },
    remote: { type: 'http', url: 'https://example.test/mcp?token=private', headers: { Authorization: 'Bearer private' } },
  } }));
  assert.deepEqual(result, { ok: true, servers: [
    { name: 'files', type: 'stdio', command: 'node', args: ['/Users/Test Person/server.js', '', 'a\\b', '--literal=$VALUE'], env: { API_KEY: ' private value ', EMPTY: '' }, description: 'Local files', enabled: false },
    { name: 'remote', type: 'http', url: 'https://example.test/mcp?token=private', headers: { Authorization: 'Bearer private' } },
  ] });
});

test('one named entry and direct JSON work with explicit or supplied names', () => {
  assert.equal(server('{"files":{"command":"npx","args":["-y","@example/server"]}}').name, 'files');
  assert.equal(server('{"command":"node","args":["server.js"]}', ' files ').name, 'files');
  assert.equal(server('{"name":"files","command":"node"}').name, 'files');
  assert.equal(server('{"name":"files","command":"node"}', 'files').name, 'files');
  rejects('{"name":"files","command":"node"}', 'other');
  rejects('{"command":"node"}');
});

test('remote HTTP and SSE require valid HTTP URLs and do not become local commands', () => {
  assert.deepEqual(server('{"url":"http://localhost:3000/mcp"}', 'remote'), {
    name: 'remote', type: 'http', url: 'http://localhost:3000/mcp',
  });
  assert.equal(server('{"remote":{"type":"sse","url":"https://example.test/sse"}}').type, 'sse');
  for (const url of ['file:///tmp/socket', 'ftp://example.test/mcp', 'javascript:run()', 'https://', 'https:example.test', 'https://example.test\\other', 'https://user:secret@example.test/mcp', 'https://example.test/a b', 'https://example.test/\r\nX:private']) {
    rejects(JSON.stringify({ remote: { type: 'http', url } }));
  }
  rejects('{"remote":{"type":"http","url":"https://example.test/mcp","command":"node"}}');
  rejects('{"local":{"type":"stdio","command":"node","url":"https://example.test/mcp"}}');
});

test('malformed field types are refused rather than filtered or coerced', () => {
  for (const config of [
    { command: 1 }, { command: '' }, { command: 'node', args: 'server.js' }, { command: 'node', args: ['server.js', 1] },
    { command: 'node', env: ['API_KEY'] }, { command: 'node', env: { API_KEY: 2 } },
    { command: 'node', env: { 'BAD KEY': 'private' } }, { command: 'node', enabled: 'false' },
    { command: 'node', description: 3 }, { command: 'node', type: 'streamable-http' },
    { type: 'http', url: 4 }, { type: 'http', url: 'https://example.test', headers: [] },
    { type: 'http', url: 'https://example.test', headers: { Authorization: 5 } },
  ]) rejects(JSON.stringify({ server: config }));
});

test('unknown launch, authentication and wrapper fields are never silently dropped', () => {
  for (const config of [
    { command: 'node', transport: 'stdio' }, { command: 'node', timeout: 30 },
    { command: 'node', auth: { token: 'private' } }, { command: 'node', oauth: true },
    { command: 'node', headers: { Authorization: 'private' } },
    { type: 'http', url: 'https://example.test', args: ['unexpected'] },
    { command: 'bash', args: ['-c', 'node server.js'] },
  ]) rejects(JSON.stringify({ server: config }));
  rejects('{"mcpServers":{"server":{"command":"node"}},"otherSetting":true}');
  rejects('{"mcpServers":[]}');
  rejects('{"mcpServers":{}}');
  rejects('[]', 'server');
});

test('header injection, NUL payloads and conflicting header names are refused privately', () => {
  for (const headers of [
    { 'Authorization\r\nX-Injected': 'private' }, { Authorization: 'Bearer private\r\nX: injected' },
    { Authorization: 'one', authorization: 'two' }, { 'Bad Header': 'private' },
  ]) rejects(JSON.stringify({ remote: { url: 'https://example.test/mcp', headers } }));
  rejects(JSON.stringify({ local: { command: 'node', args: ['bad\u0000arg'] } }));
  rejects(JSON.stringify({ local: { command: 'node', env: { TOKEN: 'bad\u0000value' } } }));
});

test('multi-server validation completes before exposing any server to submission', () => {
  rejects('{"mcpServers":{"first":{"command":"node"},"second":{"command":"node","cwd":"relative/path"}}}');
  rejects('{"first":{"command":"node"},"bad name":{"command":"node"}}');
  rejects('{"__proto__":{"command":"node"}}');
  rejects('{"constructor":{"command":"node"}}');
});

test('stdio JSON retains absolute working directories with spaces without shell interpretation', () => {
  for (const cwd of ['/tmp/Project Files', 'C:\\Users\\Test Person\\project', '\\\\server\\share\\project']) {
    assert.equal(server(JSON.stringify({ local: { command: 'node', args: ['./server.js'], cwd } })).cwd, cwd);
  }
  for (const cwd of ['', ' ', '.', './project', 'C:project', '\\project', null, 4, '/tmp/line\nbreak']) {
    rejects(JSON.stringify({ local: { command: 'node', cwd } }));
  }
  for (const type of ['http', 'sse']) rejects(JSON.stringify({ remote: { type, url: 'https://example.test/mcp', cwd: '/tmp' } }));
});

test('duplicate JSON names and settings are rejected instead of overwriting prior input', () => {
  rejects('{"mcpServers":{"same":{"command":"node","cwd":"/tmp"},"same":{"command":"node"}}}');
  rejects('{"server":{"command":"wrong","command":"node"}}');
  rejects('{"server":{"command":"node","env":{"TOKEN":"one","TOKEN":"two"}}}');
  rejects('{" same ":{"command":"node"},"same":{"command":"node"}}');
  rejects('{"server":{"command":"node","args":["value",{"same":1,"same":2}]}}');
  assert.deepEqual(server('{"server":{"command":"node","args":["same","same","{\\\"same\\\":1}"],"env":{"KEY":"same"}}}').args,
    ['same', 'same', '{"same":1}']);
  rejects('{"server":{"command":"node","\\u0063ommand":"other"}}');
});

test('validation messages never repeat malformed input, private values or JSON parser details', () => {
  const secret = 'PRIVATE-DO-NOT-ECHO-19';
  for (const input of [
    `{"mcpServers":{"server":{"command":"node","env":{"API_KEY":"${secret}"}},`,
    JSON.stringify({ server: { command: 'node', auth: secret } }),
    JSON.stringify({ server: { url: `https://u:${secret}@example.test` } }),
    `node "${secret}`,
  ]) assert.equal(rejects(input, 'server').includes(secret), false);
});

test('parser bounds large pastes without exposing partial data', () => {
  rejects('npx ' + 'x'.repeat(100_000), 'server');
  const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`server-${i}`, { command: 'node' }]));
  rejects(JSON.stringify({ mcpServers: many }));
});
