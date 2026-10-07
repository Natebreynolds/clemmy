import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { browserOperationScript, browserOperationProvesNoMutation, executeBrowserOperation, runBrowserOperationProcess, type BrowserOperationRunner } from './browser-operation.js';
import { parseBrowserOperationArguments } from '../tools/browser-operation-contract.js';

const browserId = 'a'.repeat(64);
const marker = 'CLEM_BROWSER_OPERATION_V1:';
const page = { browser_id: browserId, target_id: 'exact-target', url: 'https://example.com/', title: 'Example' };
function outcome(result: unknown, target: string | null, effect: 'none' | 'confirmed'): BrowserOperationRunner {
  return async () => ({ code: 0, stdout: marker + JSON.stringify({ ok: true, result, target_id: target, browser_id: browserId, effect }), stderr: '', dispatched: true });
}

test('browser inputs close the executable surface and refuse credentials and non-web schemes', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://name:secret@example.com/', 'data:text/html,test']) {
    assert.throws(() => parseBrowserOperationArguments('browser_navigate', { browser_id: browserId, target_id: 'exact-target', url }));
  }
  assert.throws(() => parseBrowserOperationArguments('browser_open', { code: 'anything' }));
  assert.throws(() => parseBrowserOperationArguments('browser_read', { browser_id: browserId, target_id: 'exact-target', session_name: '../default' }));
  assert.throws(() => parseBrowserOperationArguments('browser_read', { browser_id: browserId, target_id: 'exact-target', max_chars: 16001 }));
  assert.equal(parseBrowserOperationArguments('browser_navigate', { browser_id: browserId, target_id: 'exact-target', url: 'https://example.com/' }).url, 'https://example.com/');
  assert.throws(() => parseBrowserOperationArguments('browser_navigate', { browser_id: browserId, target_id: 'exact-target', url: 'https://example.com/' + '猫'.repeat(1000) }), /8000/);
});

test('fixed operations never use the upstream default-session reattach/replay path or caller script', () => {
  const script = browserOperationScript('browser_navigate', { browser_id: browserId, target_id: 'exact-target', url: 'https://example.com/?q=\'a', session_name: 'task-1' });
  assert.match(script, /Target\.attachToTarget.*targetId.*target/);
  assert.doesNotMatch(script, /browser_harness|_ipc|agent_helpers|ensure_daemon/);
  assert.match(script, /p.get\('browser_id'\).*browser_id/);
  assert.match(script, /ws:\/\/127\.0\.0\.1/);
  assert.doesNotMatch(script, /set_session|restart_daemon|new_tab\(|goto_url\(/);
  assert.match(script, /Page\.navigate.*sid\)/);
  assert.doesNotMatch(script, /https:\/\/example\.com/);
  assert.match(script, /ensure_ascii=False/);
  assert.match(script, /loaderId/);
});

test('a browser read returns its exact target/session receipt and complete 16k Unicode text', async () => {
  const text = '猫'.repeat(16000);
  const value = await executeBrowserOperation('browser_read', { browser_id: browserId, target_id: page.target_id, session_name: 'task-1', max_chars: 16000 }, {
    runner: async (_code, name) => {
      assert.equal(name, 'task-1');
      return { code: 0, stdout: marker + JSON.stringify({ ok: true, result: { ...page, text, text_truncated: true }, target_id: page.target_id, browser_id: browserId, effect: 'none' }), stderr: '' };
    },
  });
  assert.equal(value.ok, true);
  assert.deepEqual(value.handle, { session_name: 'task-1', browser_id: browserId, target_id: page.target_id });
  assert.equal((value.result as Record<string, unknown>).text, text);
  assert.equal((value.receipt as Record<string, unknown>).effect, 'none');
});

test('open, list and navigation accept only complete bounded exact-target results', async () => {
  for (const [operation, args, result, target, effect] of [
    ['browser_tabs', {}, { tabs: [page], tabs_truncated: false }, null, 'none'],
    ['browser_open', {}, { ...page, url: 'about:blank' }, page.target_id, 'confirmed'],
    ['browser_navigate', { browser_id: browserId, target_id: page.target_id, url: 'https://example.com/' }, { ...page, requested_url: 'https://example.com/' }, page.target_id, 'confirmed'],
  ] as const) {
    const value = await executeBrowserOperation(operation, args, { runner: outcome(result, target, effect) });
    assert.equal(value.ok, true, operation);
  }
  for (const runner of [
    outcome({ ...page, target_id: 'different', requested_url: page.url }, 'different', 'confirmed'),
    outcome({ ...page, requested_url: 'https://different.example/' }, page.target_id, 'confirmed'),
    outcome({ target_id: page.target_id }, page.target_id, 'confirmed'),
    async () => ({ code: 0, stdout: marker + 'malformed', stderr: '' }),
    async () => ({ code: 0, stdout: '', stderr: '' }),
  ]) {
    const failed = await executeBrowserOperation('browser_navigate', { browser_id: browserId, target_id: page.target_id, url: page.url }, { runner });
    assert.equal(failed.ok, false);
    assert.equal(failed.artifactId, undefined);
    assert.equal(failed.result, undefined);
    assert.equal((failed.receipt as Record<string, unknown>).target_id, page.target_id);
    assert.equal((failed.receipt as Record<string, unknown>).effect, 'uncertain');
  }
});

test('cancellation before spawn is proven none; interrupted mutations are uncertain and never replayed', async () => {
  const controller = new AbortController(); controller.abort();
  const before = await runBrowserOperationProcess('must never run', 'default', controller.signal);
  assert.equal(before.dispatched, false);
  const cancelled = await executeBrowserOperation('browser_open', {}, { runner: async () => before });
  assert.equal((cancelled.receipt as Record<string, unknown>).effect, 'none');
  assert.equal(browserOperationProvesNoMutation(cancelled), true);
  assert.equal(browserOperationProvesNoMutation(structuredClone(cancelled)), false);
  let calls = 0;
  const timeout = await executeBrowserOperation('browser_open', {}, { runner: async () => { calls++; return { code: null, stdout: '', stderr: '', termination: 'timeout', dispatched: true }; } });
  assert.equal(calls, 1);
  assert.equal(timeout.ok, false);
  assert.equal((timeout.receipt as Record<string, unknown>).effect, 'uncertain');
  assert.equal(browserOperationProvesNoMutation(timeout), false);
  assert.equal((timeout.receipt as Record<string, unknown>).status, 'timeout');
});

test('the actual fixed Python program executes every operation through mock CDP, without a daemon or learned helpers', async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'clem-fixed-browser-cdp-'));
  writeFileSync(path.join(profile, 'DevToolsActivePort'), '9333\n/devtools/browser/fixture-browser\n');
  const id = createHash('sha256').update('ws://127.0.0.1:9333/devtools/browser/fixture-browser').digest('hex');
  const trace = path.join(profile, 'trace.json');
  const prelude = `import sys, types, json
# Reproduce Windows' legacy console encoding before the fixed adapter binds UTF-8.
sys.stdout.reconfigure(encoding='cp1252', errors='strict')
calls = []
class Connector:
  def __init__(self, endpoint, **kwargs):
    assert kwargs['proxy'] is None
    assert kwargs['host'] == '127.0.0.1' and kwargs['port'] == 9333
    self.endpoint = endpoint
  def process_redirect(self, exception): return 'ws://remote.example/redirected'
class CDP:
  def __init__(self, endpoint):
    assert endpoint == 'ws://127.0.0.1:9333/devtools/browser/fixture-browser'
    self.url = 'about:blank'
  async def start(self):
    connector = module.websockets.connect('ws://127.0.0.1:9333/devtools/browser/fixture-browser', max_size=100)
    redirect = RuntimeError('HTTP 302 to a different browser')
    assert connector.process_redirect(redirect) is redirect
    try: module.websockets.connect('ws://remote.example/changed')
    except RuntimeError: pass
    else: raise RuntimeError('Changed endpoint was not refused')
    calls.append(['start'])
  async def stop(self):
    open(${JSON.stringify(trace)}, 'w').write(json.dumps(calls))
  async def send_raw(self, method, params, session_id=None):
    calls.append([method, params, session_id])
    if method == 'Target.getTargets': return {'targetInfos':[{'type':'page','targetId':'exact-target','url':self.url,'title':'😀'*1000}]}
    if method == 'Target.createTarget': return {'targetId':'exact-target'}
    if method == 'Target.getTargetInfo': return {'targetInfo':{'type':'page','targetId':params['targetId'],'url':self.url,'title':'😀'*1000}}
    if method == 'Target.attachToTarget': return {'sessionId':'isolated-sid'}
    if method == 'Target.detachFromTarget': return {}
    if method == 'Page.navigate':
      assert session_id == 'isolated-sid'
      self.url = params['url']
      return {'frameId':'main-frame','loaderId':'new-loader'}
    if method == 'Page.getFrameTree': return {'frameTree':{'frame':{'url':self.url,'loaderId':'new-loader'}}}
    if method == 'Runtime.evaluate':
      assert session_id == 'isolated-sid'
      if params['expression'] == 'document.readyState': return {'result':{'value':'complete'}}
      return {'result':{'value':json.dumps({'url':self.url,'title':'😀'*500,'text':'猫'*16000,'text_truncated':True})}}
    raise RuntimeError('Unexpected CDP method: '+method)
module = types.ModuleType('cdp_use.client'); module.CDPClient = CDP
module.websockets = types.SimpleNamespace(connect=None)
sys.modules['cdp_use'] = types.ModuleType('cdp_use')
sys.modules['cdp_use.client'] = module
sys.modules['websockets'] = types.ModuleType('websockets')
sys.modules['websockets.asyncio'] = types.ModuleType('websockets.asyncio')
websocket_client = types.ModuleType('websockets.asyncio.client'); websocket_client.connect = Connector
sys.modules['websockets.asyncio.client'] = websocket_client
`;
  const runner: BrowserOperationRunner = async code => {
    const fixed = code.replace("profile = p.pop('chrome_profile')", `profile = ${JSON.stringify(profile)}`);
    // A fixture bound on a real interpreter start, not the product's: a cold
    // Windows runner once needed more than 10 s (run 37665180200).
    const child = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-c', prelude + fixed], { encoding: 'utf8', timeout: process.platform === 'win32' ? 60_000 : 10_000, maxBuffer: 2 * 1024 * 1024 });
    return { code: child.status, stdout: child.stdout, stderr: child.stderr, dispatched: true };
  };
  for (const [operation, args] of [
    ['browser_tabs', {}], ['browser_open', {}],
    ['browser_read', { target_id: 'exact-target', browser_id: id, max_chars: 16000 }],
    ['browser_navigate', { target_id: 'exact-target', browser_id: id, url: 'https://example.com/' }],
  ] as const) {
    const result = await executeBrowserOperation(operation, args, { runner });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((result.receipt as Record<string, unknown>).browser_id, id);
    const calls = JSON.parse(readFileSync(trace, 'utf8')) as Array<[string, Record<string, unknown>?, string?]>;
    assert.equal(calls.some(([method]) => method === 'Target.createTarget'), operation === 'browser_open');
    assert.equal(calls.some(([method]) => method === 'Page.navigate'), operation === 'browser_navigate');
    if (operation === 'browser_read') assert.equal((result.result as Record<string, unknown>).text, '猫'.repeat(16000));
    if (operation !== 'browser_tabs') assert.ok(String((result.result as Record<string, unknown>).title).startsWith('😀'));
  }
  const changed = await executeBrowserOperation('browser_navigate', { target_id: 'exact-target', browser_id: 'b'.repeat(64), url: 'https://example.com/' }, { runner });
  assert.equal(changed.ok, false);
  assert.equal((changed.receipt as Record<string, unknown>).effect, 'none', 'identity drift refuses before Page.navigate');
  assert.match(String(changed.error), /Browser identity changed/);
  assert.equal(browserOperationProvesNoMutation(changed), true);
});

test('a Chrome that never accepts the connection is a plain, proven no-change failure', async () => {
  const script = browserOperationScript('browser_open', parseBrowserOperationArguments('browser_open', {}));
  assert.match(script, /except asyncio\.TimeoutError:/);
  assert.match(script, /allow remote debugging/);
  assert.match(script, /str\(e\) or type\(e\)\.__name__/, 'an exception without a message still says what it was');
  const marker = `CLEM_BROWSER_OPERATION_V1:${JSON.stringify({ ok: false, error: 'Chrome did not accept the connection. It may be asking on the Mac to allow remote debugging: allow it in Chrome, then try again.', target_id: null, browser_id: browserId, effect: 'none' })}`;
  const value = await executeBrowserOperation('browser_open', {}, { runner: async () => ({ code: 1, stdout: `${marker}\n`, stderr: '', dispatched: true }) });
  assert.equal(value.ok, false);
  assert.equal((value.receipt as { effect: string }).effect, 'none', 'no tab was opened, and the receipt says so');
  assert.match(String(value.error), /allow remote debugging/);
  assert.equal(browserOperationProvesNoMutation(value), true);
});
