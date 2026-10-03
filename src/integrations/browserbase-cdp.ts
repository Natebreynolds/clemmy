import { WebSocket } from 'undici';
import { z } from 'zod';
import { BROWSER_HTTP_URL } from '../tools/browser-operation-contract.js';
import { browserbaseConnectUrlFor } from './browserbase-connect-url.js';

export type BrowserbaseOperation = 'tabs' | 'read' | 'open' | 'navigate' | 'click' | 'fill' | 'key';
export type BrowserbaseEffect = 'none' | 'confirmed' | 'uncertain';
export interface BrowserbasePage { targetId: string; title: string; url: string; }
export class BrowserbaseCdpError extends Error {
  constructor(public readonly code: string, public readonly effect: 'none' | 'uncertain') { super(code); this.name = 'BrowserbaseCdpError'; }
}
export interface BrowserbaseSocket {
  readyState: number;
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  send(value: string): void;
  close(): void;
}
export interface BrowserbaseCdpResult { result: Record<string, unknown>; effect: 'none' | 'confirmed'; targetId: string | null; pages?: BrowserbasePage[]; }
const target = z.string().min(1).max(128);
const selector = z.string().min(1).max(1000);
const keys = ['Enter','Tab','Escape','Backspace','Delete','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown',' '] as const;
const shapes = {
  tabs: z.strictObject({}), open: z.strictObject({}),
  read: z.strictObject({ targetId: target, maxChars: z.number().int().min(1).max(16000).optional() }),
  navigate: z.strictObject({ targetId: target, url: BROWSER_HTTP_URL }),
  click: z.strictObject({ targetId: target, selector }),
  fill: z.strictObject({ targetId: target, selector, text: z.string().max(100000) }),
  key: z.strictObject({ targetId: target, key: z.enum(keys) }),
  insert_text: z.strictObject({ targetId: target, text: z.string().max(100000) }),
};
type FixedOperation = BrowserbaseOperation | 'insert_text';
export function parseBrowserbaseOperation(operation: FixedOperation, args: unknown): Record<string, unknown> {
  if (!(operation in shapes)) throw new BrowserbaseCdpError('invalid_operation', 'none');
  const parsed = shapes[operation].safeParse(args);
  if (!parsed.success) throw new BrowserbaseCdpError('invalid_arguments', 'none');
  const value = parsed.data as Record<string, unknown>;
  if (operation === 'navigate') {
    const normalized = BROWSER_HTTP_URL.safeParse(new URL(String(value.url)).href);
    if (!normalized.success) throw new BrowserbaseCdpError('invalid_arguments', 'none');
    value.url = normalized.data;
  }
  return value;
}
export function browserbasePublicUrl(value: unknown): string {
  if (value === 'about:blank') return 'about:blank';
  if (typeof value !== 'string') return '';
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? `${url.origin}${url.pathname}`.slice(0, 2000) : ''; } catch { return ''; }
}
function page(row: Record<string, unknown>): BrowserbasePage {
  if (typeof row.targetId !== 'string' || !row.targetId || row.targetId.length > 128 || row.type !== 'page') throw new BrowserbaseCdpError('invalid_target', 'none');
  return { targetId: row.targetId, title: String(row.title ?? '').slice(0, 1000), url: browserbasePublicUrl(row.url) };
}

/** Fixed CDP operations on one exact cloud session. No caller JavaScript, model,
 * automatic retry, local-browser fallback or private URL in an error/receipt. */
export class BrowserbaseCdpClient {
  constructor(private readonly dependencies: { socketFactory?: (url: string) => BrowserbaseSocket; timeoutMs?: number } = {}) {}
  async execute(connectUrl: string, providerSessionId: string, operation: FixedOperation, input: unknown,
    options: { signal?: AbortSignal; beforeMutation?: () => Promise<void> } = {}): Promise<BrowserbaseCdpResult> {
    const args = parseBrowserbaseOperation(operation, input);
    let endpoint: URL;
    try { endpoint = new URL(connectUrl); } catch { throw new BrowserbaseCdpError('connection_unavailable', 'none'); }
    if (!browserbaseConnectUrlFor(endpoint.href, providerSessionId)) throw new BrowserbaseCdpError('connection_identity_changed', 'none');
    if (options.signal?.aborted) throw new BrowserbaseCdpError('cancelled', 'none');
    let mutated = false, sequence = 0, closed = false, socket: BrowserbaseSocket;
    const pending = new Map<number, { resolve: (value: Record<string, any>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    const failure = (code: string) => new BrowserbaseCdpError(code, mutated ? 'uncertain' : 'none');
    try { socket = (this.dependencies.socketFactory ?? (url => new WebSocket(url)))(connectUrl); }
    catch { throw failure('connection_unavailable'); }
    const failPending = (code: string) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure(code)); } pending.clear(); };
    const onMessage = (event: { data: unknown }) => {
      try {
        const data = JSON.parse(String(event.data));
        const item = pending.get(data.id);
        if (!item) return;
        pending.delete(data.id); clearTimeout(item.timer);
        if (data.error) item.reject(failure('browser_operation_failed'));
        else if (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) item.reject(failure('invalid_browser_response'));
        else item.resolve(data.result);
      } catch { failPending('invalid_browser_response'); }
    };
    const onClose = () => { closed = true; failPending('connection_closed'); };
    const onError = () => failPending('connection_unavailable');
    const onAbort = () => { failPending('cancelled'); try { socket.close(); } catch {} };
    socket.addEventListener('message', onMessage); socket.addEventListener('close', onClose); socket.addEventListener('error', onError);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const deadlineMs = Math.min(60000, Math.max(1, this.dependencies.timeoutMs ?? 30000));
    const deadline = setTimeout(() => { failPending('browser_timeout'); try { socket.close(); } catch {} }, deadlineMs);
    const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string, mutation = false): Promise<Record<string, any>> => {
      if (options.signal?.aborted) throw failure('cancelled');
      if (closed || socket.readyState !== 1) throw failure('connection_closed');
      if (mutation && !mutated) { await options.beforeMutation?.(); if (options.signal?.aborted) throw failure('cancelled'); mutated = true; }
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(failure('browser_timeout')); }, Math.min(10000, deadlineMs));
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch { clearTimeout(timer); pending.delete(id); reject(failure('connection_closed')); }
      });
    };
    try {
      if (socket.readyState !== 1) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(failure('connection_timeout')); }, Math.min(10000, deadlineMs));
        const cleanup = () => { clearTimeout(timer); socket.removeEventListener('open', open); socket.removeEventListener('error', bad); socket.removeEventListener('close', bad); options.signal?.removeEventListener('abort', abort); };
        const open = () => { cleanup(); resolve(); };
        const bad = () => { cleanup(); reject(failure('connection_unavailable')); };
        const abort = () => { cleanup(); reject(failure('cancelled')); };
        socket.addEventListener('open', open, { once: true }); socket.addEventListener('error', bad, { once: true }); socket.addEventListener('close', bad, { once: true }); options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      });
      if (operation === 'tabs') {
        const observed = await send('Target.getTargets');
        if (!Array.isArray(observed.targetInfos)) throw failure('invalid_browser_response');
        const rows = observed.targetInfos.filter((row: Record<string, unknown>) => row.type === 'page');
        const pages = rows.slice(0, 100).map(page);
        return { result: { pages, truncated: rows.length > 100 }, pages, effect: 'none', targetId: null };
      }
      if (operation === 'open') {
        const created = await send('Target.createTarget', { url: 'about:blank' }, undefined, true);
        if (typeof created.targetId !== 'string') throw failure('invalid_browser_response');
        const observed = await send('Target.getTargetInfo', { targetId: created.targetId });
        if (observed.targetInfo?.targetId !== created.targetId || observed.targetInfo?.url !== 'about:blank') throw failure('target_identity_changed');
        const opened = page(observed.targetInfo);
        return { result: opened as unknown as Record<string, unknown>, pages: [opened], effect: 'confirmed', targetId: created.targetId };
      }
      const targetId = String(args.targetId);
      const before = await send('Target.getTargetInfo', { targetId });
      if (before.targetInfo?.targetId !== targetId || before.targetInfo?.type !== 'page') throw failure('target_identity_changed');
      const attached = await send('Target.attachToTarget', { targetId, flatten: true });
      if (typeof attached.sessionId !== 'string' || !attached.sessionId) throw failure('invalid_browser_response');
      const sid = attached.sessionId;
      try {
        if (operation === 'read') {
          const maxChars = Number(args.maxChars ?? 8000);
          const observed = await send('Runtime.evaluate', { expression: `JSON.stringify({url:location.href,title:document.title.slice(0,1000),text:(document.body?document.body.innerText:"").slice(0,${maxChars}),truncated:(document.body?document.body.innerText.length:0)>${maxChars}})`, returnByValue: true }, sid);
          let content: Record<string, unknown>;
          try { content = JSON.parse(observed.result?.value); } catch { throw failure('invalid_browser_response'); }
          const after = await send('Target.getTargetInfo', { targetId });
          if (observed.exceptionDetails || after.targetInfo?.targetId !== targetId || content.url !== after.targetInfo?.url || typeof content.text !== 'string' || content.text.length > maxChars || typeof content.truncated !== 'boolean') throw failure('page_changed_during_read');
          const observedPage = page(after.targetInfo);
          return { result: { ...observedPage, text: content.text, truncated: content.truncated }, pages: [observedPage], effect: 'none', targetId };
        }
        if (operation === 'navigate') {
          const navigation = await send('Page.navigate', { url: args.url }, sid, true);
          if (navigation.errorText || navigation.isDownload) throw failure('navigation_unconfirmed');
          const end = Date.now() + Math.min(15000, deadlineMs);
          while (true) {
            const after = await send('Target.getTargetInfo', { targetId });
            const frame = (await send('Page.getFrameTree', {}, sid)).frameTree?.frame;
            const ready = (await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, sid)).result?.value;
            const loaderMatches = navigation.loaderId ? frame?.loaderId === navigation.loaderId : after.targetInfo?.url === args.url;
            if (after.targetInfo?.targetId === targetId && loaderMatches && after.targetInfo?.url === `${frame?.url ?? ''}${frame?.urlFragment ?? ''}` && ['interactive','complete'].includes(ready)) {
              const observedPage = page(after.targetInfo);
              return { result: observedPage as unknown as Record<string, unknown>, pages: [observedPage], effect: 'confirmed', targetId };
            }
            if (Date.now() >= end) throw failure('navigation_unconfirmed');
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        if (operation === 'insert_text') {
          await send('Input.insertText', { text: args.text }, sid, true);
        } else if (operation === 'key') {
          const key = String(args.key);
          const codes: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 };
          await send('Input.dispatchKeyEvent', { type: 'keyDown', key, windowsVirtualKeyCode: codes[key] }, sid, true);
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key, windowsVirtualKeyCode: codes[key] }, sid);
        } else {
          const root = await send('DOM.getDocument', { depth: 1 }, sid);
          const located = await send('DOM.querySelector', { nodeId: root.root?.nodeId, selector: args.selector }, sid);
          if (!located.nodeId) throw failure('element_not_found');
          if (operation === 'click') {
            await send('DOM.scrollIntoViewIfNeeded', { nodeId: located.nodeId }, sid, true);
            const box = await send('DOM.getBoxModel', { nodeId: located.nodeId }, sid);
            const quad = box.model?.content;
            if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) throw failure('element_not_interactable');
            const x = (quad[0]+quad[2]+quad[4]+quad[6])/4, y = (quad[1]+quad[3]+quad[5]+quad[7])/4;
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sid);
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sid);
          } else {
            const resolved = await send('DOM.resolveNode', { nodeId: located.nodeId }, sid);
            if (!resolved.object?.objectId) throw failure('element_not_interactable');
            const filled = await send('Runtime.callFunctionOn', { objectId: resolved.object.objectId, functionDeclaration: 'function(text){if(!(this instanceof HTMLInputElement||this instanceof HTMLTextAreaElement))return false;const p=this instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype;Object.getOwnPropertyDescriptor(p,"value").set.call(this,text);this.dispatchEvent(new Event("input",{bubbles:true}));this.dispatchEvent(new Event("change",{bubbles:true}));return true;}', arguments: [{ value: args.text }], returnByValue: true }, sid, true);
            if (filled.exceptionDetails || filled.result?.value !== true) throw failure('element_not_interactable');
          }
        }
        return { result: { ok: true, targetId }, effect: 'confirmed', targetId };
      } finally { if (!closed && socket.readyState === 1) { try { await send('Target.detachFromTarget', { sessionId: sid }); } catch {} } }
    } catch (error) { if (error instanceof BrowserbaseCdpError) throw new BrowserbaseCdpError(error.code, mutated ? 'uncertain' : error.effect); throw failure('browser_operation_failed'); }
    finally {
      clearTimeout(deadline); options.signal?.removeEventListener('abort', onAbort); failPending('connection_closed');
      socket.removeEventListener('message', onMessage); socket.removeEventListener('close', onClose); socket.removeEventListener('error', onError);
      try { socket.close(); } catch {}
    }
  }
  /** Mobile keyboard bridge inserts text at the focused element on an exact
   * page; it cannot select another browser or execute JavaScript. */
  async humanText(connectUrl: string, providerSessionId: string, targetId: string, text: string, options: { signal?: AbortSignal; beforeMutation?: () => Promise<void> } = {}): Promise<BrowserbaseCdpResult> {
    return this.execute(connectUrl, providerSessionId, 'insert_text', { targetId, text }, options);
  }
}
