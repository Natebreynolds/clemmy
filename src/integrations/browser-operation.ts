/** Fixed browser operations. No caller-authored Python or JavaScript crosses this adapter. */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseBrowserOperationArguments, type BrowserOperationName } from '../tools/browser-operation-contract.js';

export interface BrowserProcessResult { code: number | null; stdout: string; stderr: string; termination?: 'timeout' | 'cancelled'; dispatched?: boolean; }
export type BrowserOperationRunner = (code: string, sessionName: string, signal?: AbortSignal) => Promise<BrowserProcessResult>;
const MARKER = 'CLEM_BROWSER_OPERATION_V1:';
// This identity is never serialized; caller/provider JSON cannot assert it.
const NO_MUTATION_RESULTS = new WeakSet<object>();
export function browserOperationProvesNoMutation(value: unknown): boolean {
  return typeof value === 'object' && value !== null && NO_MUTATION_RESULTS.has(value);
}

export interface BrowserConnectionObservation { state: 'connected' | 'not_connected' | 'unknown'; session_name: string; detail: string; }
/** Installation is not connection proof. The typed adapter obtains a fresh,
 * read-only target observation without starting/repairing Chrome or a daemon. */
export async function observeBrowserConnection(): Promise<BrowserConnectionObservation> {
  const result = await executeBrowserOperation('browser_tabs', {});
  return { state: result.ok === true ? 'connected' : 'not_connected', session_name: 'default',
    detail: result.ok === true ? 'The configured local Chrome connection answered a CDP target observation.' : String(result.error) };
}

function browserProfile(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local'), 'Google/Chrome/User Data');
  return path.join(os.homedir(), '.config/google-chrome');
}

/** Resolve the installed CLI's exact venv interpreter, without executing its
 * run.py prelude, helpers, learned Python, update check, or self-healing daemon. */
function browserPython(): string | null {
  const directories = [path.join(os.homedir(), '.local/bin'), ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const directory of directories) {
    const command = path.join(directory, 'browser-harness');
    try {
      const firstLine = readFileSync(command, 'utf8').split('\n')[0]!;
      const interpreter = firstLine.match(/^#!(\/[^\r\n]+\/python(?:[0-9.]+)?)$/)?.[1];
      if (interpreter && existsSync(interpreter)) return interpreter;
    } catch { /* Try the next installed CLI path. */ }
  }
  return null;
}

export function browserOperationScript(operation: BrowserOperationName, args: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ operation, ...args, chrome_profile: browserProfile() })).toString('base64');
  return `import asyncio, base64, json, os, re, sys, time, hashlib
from pathlib import Path
import cdp_use.client as cdp_client
from cdp_use.client import CDPClient
from websockets.asyncio.client import connect as WebSocketConnection
sys.stdout.reconfigure(errors='backslashreplace')
p = json.loads(base64.b64decode('${payload}'))
profile = p.pop('chrome_profile')
browser_id = None
client = None
mutation = False
target = p.get('target_id')

# Connection establishment may not proxy or redirect the exact local endpoint.
# Binding is confined to this one fixed-operation Python process. CDPClient's
# public start/stop API still owns its socket and message dispatch lifecycle.
class ExactLocalConnection(WebSocketConnection):
    def process_redirect(self, exception):
        return exception

async def cdp(method, params=None, sid=None):
    return await asyncio.wait_for(client.send_raw(method, params or {}, session_id=sid), timeout=5)

def brief(row):
    url = row.get('url','')
    if len(url.encode('utf-16-le')) // 2 > 8000: raise RuntimeError('Page URL exceeds the exact identity limit')
    return {'target_id':row['targetId'], 'url':url, 'title':row.get('title','').encode('utf-16-le')[:2000].decode('utf-16-le', errors='ignore')}

async def info(t):
    row = (await cdp('Target.getTargetInfo', {'targetId':t}))['targetInfo']
    if row.get('type') != 'page' or row.get('targetId') != t: raise RuntimeError('The exact target is not a browser page')
    return brief(row)

async def main():
  global client, browser_id, mutation, target
  try:
    active = (Path(profile) / 'DevToolsActivePort').read_text().splitlines()
    if len(active) < 2 or not active[0].isdigit() or not 1 <= int(active[0]) <= 65535 or not re.fullmatch(r'/devtools/browser/[A-Za-z0-9_-]{1,128}', active[1]): raise RuntimeError('Chrome endpoint identity is invalid')
    endpoint = 'ws://127.0.0.1:'+active[0]+active[1]
    browser_id = hashlib.sha256(endpoint.encode()).hexdigest()
    if p.get('browser_id') and p['browser_id'] != browser_id: raise RuntimeError('Browser identity changed; observe tabs again before any action')
    def connect_local(url, **kwargs):
        if url != endpoint: raise RuntimeError('Refusing a changed browser endpoint')
        kwargs.update(proxy=None, host='127.0.0.1', port=int(active[0]))
        return ExactLocalConnection(url, **kwargs)
    cdp_client.websockets.connect = connect_local
    client = CDPClient(endpoint)
    await asyncio.wait_for(client.start(), timeout=5)
    op = p['operation']
    if op == 'browser_tabs':
        pages = [t for t in (await cdp('Target.getTargets'))['targetInfos'] if t.get('type') == 'page']
        result = {'tabs':[brief(t) for t in pages[:100]], 'tabs_truncated':len(pages)>100}
    elif op == 'browser_open':
        mutation = True
        target = (await cdp('Target.createTarget', {'url':'about:blank'}))['targetId']
        result = await info(target)
    else:
        before = await info(target)
        sid = (await cdp('Target.attachToTarget', {'targetId':target,'flatten':True}))['sessionId']
        try:
            if op == 'browser_navigate':
                mutation = True
                navigation = await cdp('Page.navigate', {'url':p['url']}, sid)
                if navigation.get('errorText'): raise RuntimeError(navigation['errorText'])
                if navigation.get('isDownload'): raise RuntimeError('Navigation started a download; page completion is unconfirmed')
                deadline = time.monotonic() + 15
                while True:
                    frame = (await cdp('Page.getFrameTree', {}, sid))['frameTree']['frame']
                    current = await info(target)
                    loader = navigation.get('loaderId')
                    state = (await cdp('Runtime.evaluate', {'expression':'document.readyState','returnByValue':True}, sid))['result'].get('value')
                    frame_url = frame.get('url','') + frame.get('urlFragment','')
                    if (frame.get('loaderId') == loader if loader else current['url'] == p['url']) and current['url'] == frame_url and state in ('interactive','complete'): break
                    if time.monotonic() >= deadline: raise RuntimeError('Navigation did not settle on the exact target before the deadline')
                    await asyncio.sleep(0.1)
                result = {**current,'requested_url':p['url']}
            else:
                limit = p.get('max_chars') or 8000
                expression = 'JSON.stringify({url:location.href,title:document.title.slice(0,1000),text:(document.body?document.body.innerText:"").slice(0,'+str(limit)+'),text_truncated:(document.body?document.body.innerText.length:0)>'+str(limit)+'})'
                value = await cdp('Runtime.evaluate', {'expression':expression,'returnByValue':True}, sid)
                if value.get('exceptionDetails'): raise RuntimeError('Page observation failed')
                result = {'target_id':target, **json.loads(value['result']['value'])}
                if result['url'] != (await info(target))['url']: raise RuntimeError('The page navigated during observation; read the exact target again')
        finally:
            try: await cdp('Target.detachFromTarget', {'sessionId':sid})
            except Exception: pass
    print('${MARKER}'+json.dumps({'ok':True,'result':result,'target_id':target,'browser_id':browser_id,'effect':'confirmed' if mutation else 'none'}, ensure_ascii=False))
  except Exception as e:
    print('${MARKER}'+json.dumps({'ok':False,'error':str(e)[:4000],'target_id':target,'browser_id':browser_id,'effect':'uncertain' if mutation else 'none'}, ensure_ascii=False))
    sys.exit(1)
  finally:
    if client is not None:
      try: await client.stop()
      except Exception: pass

asyncio.run(main())
`;
}

/** Use the installed backend's CDP client directly. Never run upstream CLI
 * helper loading, Chrome/profile fallback, auto-repair, or mutation replay. */
export const runBrowserOperationProcess: BrowserOperationRunner = (code, _sessionName, signal) => new Promise((resolve) => {
  if (signal?.aborted) { resolve({ code: null, stdout: '', stderr: 'Cancelled before dispatch', termination: 'cancelled', dispatched: false }); return; }
  const python = browserPython();
  if (!python) { resolve({ code: -1, stdout: '', stderr: 'Browser Harness venv interpreter is unavailable; install/repair the backend.', dispatched: false }); return; }
  // -I ignores PYTHONPATH/user site and the fixed script imports no browser helpers.
  const env = { ...process.env };
  // The endpoint is loopback-only. A inherited proxy must never carry local
  // browser traffic to a remote relay.
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'WS_PROXY', 'WSS_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'ws_proxy', 'wss_proxy']) delete env[key];
  env.NO_PROXY = '*'; env.no_proxy = '*';
  const child = spawn(python, ['-I', '-'], { env, stdio: ['pipe','pipe','pipe'], detached: process.platform !== 'win32' });
  let stdout = '', stderr = '', termination: BrowserProcessResult['termination'];
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const kill = (reason: 'timeout' | 'cancelled') => {
    if (termination) return;
    termination = reason;
    const send = (sig: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { /* already exited */ }
    };
    send('SIGTERM'); escalation = setTimeout(() => send('SIGKILL'), 1000);
  };
  const timer = setTimeout(() => kill('timeout'), 30000);
  const cancel = () => kill('cancelled'); signal?.addEventListener('abort', cancel, { once: true });
  // Page text supports 16k Unicode characters, and a bounded 100-target list
  // can carry long URLs. Retain the complete structured record up to 2 MiB.
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-2 * 1024 * 1024); });
  child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4000); });
  const finish = (code: number | null) => {
    clearTimeout(timer); if (escalation) clearTimeout(escalation); signal?.removeEventListener('abort', cancel);
    resolve({ code, stdout, stderr, dispatched: Boolean(child.pid), ...(termination ? { termination } : {}) });
  };
  child.on('error', error => { stderr += error.message; finish(-1); });
  if (signal?.aborted) cancel();
  child.on('close', finish); child.stdin.on('error', () => {}); child.stdin.end(code);
});

export async function executeBrowserOperation(operation: BrowserOperationName, args: unknown,
  options: { runner?: BrowserOperationRunner; signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
  const parsed = parseBrowserOperationArguments(operation, args);
  const sessionName = typeof parsed.session_name === 'string' ? parsed.session_name : 'default';
  const processResult = await (options.runner ?? runBrowserOperationProcess)(browserOperationScript(operation, parsed), sessionName, options.signal);
  const mutating = operation === 'browser_open' || operation === 'browser_navigate';
  const line = processResult.stdout.split('\n').reverse().find(line => line.startsWith(MARKER));
  let returned: Record<string, unknown> | undefined;
  try { if (line) returned = JSON.parse(line.slice(MARKER.length)); } catch { /* no trusted structured outcome */ }
  const result = returned?.result && typeof returned.result === 'object' ? returned.result : undefined;
  const record = result as Record<string, unknown> | undefined;
  const validPage = (value: unknown): value is Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const page = value as Record<string, unknown>;
    return typeof page.target_id === 'string' && page.target_id.length > 0 && page.target_id.length <= 128
      && typeof page.url === 'string' && page.url.length <= 8000 && typeof page.title === 'string' && page.title.length <= 1000;
  };
  const validResult = operation === 'browser_tabs'
    ? record && Array.isArray(record.tabs) && record.tabs.length <= 100 && record.tabs.every(validPage)
      && typeof record.tabs_truncated === 'boolean' && returned?.target_id === null
    : validPage(record) && returned?.target_id === record.target_id
      && (operation === 'browser_open' ? record.url === 'about:blank' : record.target_id === parsed.target_id)
      && (operation !== 'browser_read' || (typeof record.text === 'string' && record.text.length <= (Number(parsed.max_chars) || 8000) && typeof record.text_truncated === 'boolean'))
      && (operation !== 'browser_navigate' || record.requested_url === parsed.url);
  const ok = processResult.code === 0 && !processResult.termination && returned?.ok === true
    && Boolean(validResult) && typeof returned.browser_id === 'string' && /^[a-f0-9]{64}$/.test(returned.browser_id)
    && (parsed.browser_id === undefined || parsed.browser_id === returned.browser_id) && returned.effect === (mutating ? 'confirmed' : 'none');
  const provenNoMutation = processResult.dispatched === false || (!processResult.termination
    && returned?.ok === false && returned.effect === 'none'
    && typeof returned.error === 'string' && returned.error.length > 0 && returned.error.length <= 4000
    && returned.target_id === (parsed.target_id ?? null)
    && (returned.browser_id === null || (typeof returned.browser_id === 'string' && /^[a-f0-9]{64}$/.test(returned.browser_id))));
  const receipt = { version: 1, kind: 'browser_operation_receipt', operation, backend: 'local_chrome',
    session_name: sessionName, browser_id: ok ? returned?.browser_id : parsed.browser_id ?? null,
    target_id: ok ? returned?.target_id ?? null : parsed.target_id ?? null,
    requested_url: parsed.url ?? (operation === 'browser_open' ? 'about:blank' : null),
    effect: ok ? returned?.effect : mutating && !provenNoMutation ? 'uncertain' : 'none',
    status: ok ? 'completed' : processResult.termination ?? 'failed',
  };
  const receiptDigest = createHash('sha256').update(JSON.stringify({ receipt, result })).digest('hex');
  const value = { ok, ...(ok && result ? { result } : {}), receipt, receiptDigest,
    ...(ok ? { artifactId: `browser:${receiptDigest}`, handle: { session_name: sessionName, browser_id: receipt.browser_id, target_id: receipt.target_id } }
      : { error: returned?.error || processResult.stderr || 'Browser returned no valid exact-target outcome' }) };
  if (!ok && provenNoMutation && (mutating || processResult.dispatched === false)) NO_MUTATION_RESULTS.add(value);
  return value;
}
