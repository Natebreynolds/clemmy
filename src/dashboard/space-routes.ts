/**
 * Workspaces ("Spaces") daemon routes. Mounted by the caller in webhook.ts.
 *
 *  - View serving: GET /console/spaces/:id/view[/*] — path-safe, no-store,
 *    loopback-only, and forced into an opaque-origin CSP sandbox. Agent-authored
 *    HTML never inherits the console's admin principal. ONLY the view/ subtree
 *    is served, so data.json / notes / the manifest can never leak.
 *  - Cookie-authenticated data plane called only by the trusted parent RPC host:
 *    GET/PUT data, GET/POST notes.
 *  - Management for the console UI: list / create / get / patch / delete.
 *  - Lifecycle: refresh (server-side, NO LLM), rollback.
 *
 * Mirrors the inline auth + path-safety idioms in console-routes.ts.
 */
import type { Express, Request, Response } from 'express';
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  spaceStore, resolveInSpace, resolveSpaceDir, isValidSpaceSlug, buildSpaceHealthSnapshot,
  mergeSpaceContract,
  type SpaceRecord,
} from '../spaces/store.js';
import {
  readData, MAX_DATA_BYTES, appendNote, listNotes, appendAudit, listAudit,
} from '../spaces/data-store.js';
import {
  bootstrapWorkspaceObservationHistory,
  commitWorkspaceObservationBatch,
  getCurrentWorkspaceDatasetObservation,
  getWorkspaceDatasetObservation,
  getWorkspaceObservationDocument,
  indexWorkspaceRecord,
  listIndexedWorkspaces,
  listWorkspaceDatasetObservations,
  type WorkspaceDatasetObservation,
} from '../spaces/workspace-db.js';
import { diffWorkspaceObservationDocuments } from '../spaces/observation-diff.js';
import { listWorkflows, readWorkflowDefinitionFile } from '../memory/workflow-store.js';

/**
 * Workflows that feed this workspace — any enabled workflow whose definition
 * references the workspace slug (space_refresh, data pulls, the CONSTANTS
 * block Clem writes). Computed by content scan so the link needs no schema:
 * the workflow's own text is the source of truth, exactly as authored.
 */
function linkedWorkflowsForSpace(slug: string): Array<{ name: string; description: string; enabled: boolean }> {
  try {
    const needle = slug.toLowerCase();
    const out: Array<{ name: string; description: string; enabled: boolean }> = [];
    for (const entry of listWorkflows()) {
      try {
        const raw = readFileSync(entry.filePath, 'utf-8');
        if (!raw.toLowerCase().includes(needle)) continue;
        const def = readWorkflowDefinitionFile(entry.filePath);
        out.push({
          name: entry.name,
          description: (def?.description ?? '').slice(0, 200),
          enabled: def?.enabled !== false,
        });
      } catch { /* an unreadable workflow never breaks the workspace payload */ }
    }
    return out;
  } catch {
    return [];
  }
}
import { finalizeWorkspaceObservationCommit } from '../spaces/workspace-observation-finalize.js';
import { redactSensitiveText } from '../runtime/security.js';
import { refreshSpaceData, runSpaceAction } from '../spaces/runner.js';
import { composeForSpace } from '../spaces/compose.js';
import {
  spaceActionNeedsApproval, enqueueSpaceActionApproval, initSpaceActionApprovals,
  standingSpaceActionAuthority,
} from '../spaces/space-action-gate.js';
import { reengageSpace } from '../spaces/reengage.js';
import { buildPublishSnapshot } from '../spaces/publish.js';
import { injectWorkspaceBootstrap } from '../spaces/view-html.js';
import { appendWiringHealthBanner, spaceWiringHealth } from '../spaces/wiring-health.js';
import { availableStarterRecipes } from '../spaces/starter-recipes.js';
import { listUsableConnectedToolkits } from '../integrations/composio/client.js';

type IsAuthorized = (req: Request) => boolean;

const OBSERVATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SOURCE_KEY_RE = /^[^\u0000-\u001f\u007f]{1,200}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;

interface SafeWorkspaceObservation {
  id: string;
  sourceKey: string;
  status: WorkspaceDatasetObservation['status'];
  changed: boolean | null;
  cause: string;
  observedAt: string;
  previousObservationId: string | null;
  isCurrent: boolean;
}

function singleQueryString(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function parseSourceKey(value: unknown): { ok: true; value?: string } | { ok: false } {
  const raw = singleQueryString(value);
  if (raw === undefined) return { ok: true };
  if (raw === null || raw.trim() !== raw || !SOURCE_KEY_RE.test(raw)) return { ok: false };
  return { ok: true, value: raw };
}

function parseObservationId(value: unknown): { ok: true; value?: string } | { ok: false } {
  const raw = singleQueryString(value);
  if (raw === undefined) return { ok: true };
  if (raw === null || !OBSERVATION_ID_RE.test(raw)) return { ok: false };
  return { ok: true, value: raw };
}

function parseBefore(value: unknown): { ok: true; value?: string } | { ok: false } {
  const raw = singleQueryString(value);
  if (raw === undefined) return { ok: true };
  if (
    raw === null
    || raw.length > 32
    || !ISO_TIMESTAMP_RE.test(raw)
    || !Number.isFinite(Date.parse(raw))
  ) return { ok: false };
  return { ok: true, value: new Date(raw).toISOString() };
}

function parseHistoryLimit(value: unknown): { ok: true; value: number } | { ok: false } {
  const raw = singleQueryString(value);
  if (raw === undefined) return { ok: true, value: DEFAULT_HISTORY_LIMIT };
  if (raw === null || !/^[1-9]\d{0,2}$/.test(raw)) return { ok: false };
  const parsed = Number(raw);
  return parsed <= MAX_HISTORY_LIMIT ? { ok: true, value: parsed } : { ok: false };
}

function safeObservation(observation: WorkspaceDatasetObservation): SafeWorkspaceObservation {
  return {
    id: OBSERVATION_ID_RE.test(observation.id) ? observation.id : 'invalid-observation-id',
    sourceKey: SOURCE_KEY_RE.test(observation.sourceKey)
      ? observation.sourceKey
      : 'unknown-source',
    status: observation.status,
    changed: typeof observation.changed === 'boolean' ? observation.changed : null,
    cause: String(observation.cause ?? 'unknown')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
      .slice(0, 80) || 'unknown',
    observedAt: Number.isFinite(Date.parse(observation.observedAt))
      ? new Date(observation.observedAt).toISOString()
      : new Date(0).toISOString(),
    previousObservationId:
      observation.previousObservationId && OBSERVATION_ID_RE.test(observation.previousObservationId)
        ? observation.previousObservationId
        : null,
    isCurrent: observation.isCurrent === true,
  };
}

function safeObservationDiff(
  diff: ReturnType<typeof diffWorkspaceObservationDocuments>,
): ReturnType<typeof diffWorkspaceObservationDocuments> {
  return {
    ...diff,
    summary: redactSensitiveText(diff.summary).slice(0, 500),
    changes: diff.changes.map((change) => ({
      ...change,
      path: redactSensitiveText(change.path).slice(0, 1_000),
      ...(change.entityKey
        ? { entityKey: redactSensitiveText(change.entityKey).slice(0, 300) }
        : {}),
      ...(change.before !== undefined
        ? { before: redactSensitiveText(change.before).slice(0, 2_000) }
        : {}),
      ...(change.after !== undefined
        ? { after: redactSensitiveText(change.after).slice(0, 2_000) }
        : {}),
    })),
  };
}

function ensureWorkspaceIndexed(record: SpaceRecord): void {
  if (listIndexedWorkspaces().some((entry) => entry.id === record.id)) return;
  indexWorkspaceRecord(record, {
    emitOperational: false,
    appendStateEvent: false,
  });
}

function bootstrapLegacyWorkspaceHistoryIfNeeded(workspaceId: string): void {
  if (listWorkspaceDatasetObservations(workspaceId, { limit: 1 }).length > 0) return;
  const bootstrapped = bootstrapWorkspaceObservationHistory(workspaceId);
  if (!bootstrapped.ok) throw new Error(bootstrapped.error);
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * SVG is an image when embedded, but an active document when opened directly.
 * Keep authored SVG useful as a Workspace asset while denying scripts, network,
 * forms, frames, navigation, and a same-origin principal in document contexts.
 */
const WORKSPACE_SVG_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  'sandbox',
  "style-src 'unsafe-inline'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
].join('; ');

/**
 * Agent-authored HTML is executable content and must never share the console's
 * authenticated origin. The response-level sandbox applies even when someone
 * opens a raw view URL outside our iframe; connect/form/frame/navigation
 * capabilities stay closed. Relative, inert presentation assets remain usable.
 */
function workspaceViewCsp(req: Request, slug: string): string | null {
  // An opaque sandbox origin has no useful `'self'`. Name only this exact
  // loopback Workspace's /view/ subtree so multi-file views work without
  // granting authored HTML a generic localhost fetch/source capability.
  const host = String(req.get('host') ?? '').trim().toLowerCase();
  if (!/^(?:127\.0\.0\.1|localhost):\d{1,5}$/.test(host)
    && !/^\[::1\]:\d{1,5}$/.test(host)) return null;
  const assetRoot = `http://${host}/console/spaces/${encodeURIComponent(slug)}/view/`;
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    'sandbox allow-scripts',
    `script-src 'unsafe-inline' ${assetRoot}`,
    `style-src 'unsafe-inline' ${assetRoot}`,
    `img-src data: ${assetRoot}`,
    `font-src data: ${assetRoot}`,
    `media-src data: blob: ${assetRoot}`,
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
  ].join('; ');
}

/** Injected into every served HTML view: a tiny opaque-origin RPC client. The
 *  trusted console parent owns authentication and accepts only a fixed,
 *  workspace-scoped operation set. Authored HTML therefore never sees a cookie,
 *  token, API URL, or general-purpose authenticated fetch primitive:
 *    await clem.data()                       → the dataset (keyed by sourceId)
 *    await clem.history(opts?)               → bounded observation summaries
 *    await clem.diff(opts?)                  → bounded, redacted structural diff
 *    await clem.refresh(sourceId?)           → re-pull server-side, returns data
 *    await clem.compose(instructions, ctx)   → a grounded draft (throws on error)
 *    await clem.action(actionId, args)       → fire a declared action
 *    await clem.note(text, kind?, meta?)     → record a note
 *  clem.action() RESOLVES the E1 approval contract: a send/write returns
 *  {pending:true, approvalId} (the user approves in the inbox; it fires then),
 *  a read returns {ok:true, result}. */
const CLEM_VIEW_BRIDGE = (slug: string): string => {
  const S = JSON.stringify(slug);
  return `<script>(function(){'use strict';
var C='clementine.workspace.rpc.v1',GC='clementine.workspace.gesture.v1',S=${S},N=0,P=new Map(),Q=[],GQ=[],PORT=null,GPORT=null;
var U=function(fn){return Function.prototype.call.bind(fn);};
var ADD=U(EventTarget.prototype.addEventListener),REMOVE=U(EventTarget.prototype.removeEventListener);
var STOP=U(Event.prototype.stopImmediatePropagation),PREVENT=U(Event.prototype.preventDefault);
var PORT_POST=U(MessagePort.prototype.postMessage),PORT_START=U(MessagePort.prototype.start);
var OWN_DESC=Object.getOwnPropertyDescriptor,PORTS_DESC=OWN_DESC(MessageEvent.prototype,'ports'),DATA_DESC=OWN_DESC(MessageEvent.prototype,'data'),SOURCE_DESC=OWN_DESC(MessageEvent.prototype,'source');
var TARGET_DESC=OWN_DESC(Event.prototype,'target'),TRUSTED_DESC=OWN_DESC(Event.prototype,'isTrusted'),PATH=U(Event.prototype.composedPath);
var GET_PORTS=PORTS_DESC&&PORTS_DESC.get?U(PORTS_DESC.get):null,GET_DATA=DATA_DESC&&DATA_DESC.get?U(DATA_DESC.get):null,GET_SOURCE=SOURCE_DESC&&SOURCE_DESC.get?U(SOURCE_DESC.get):null;
var GET_TARGET=TARGET_DESC&&TARGET_DESC.get?U(TARGET_DESC.get):null,GET_TRUSTED=TRUSTED_DESC&&TRUSTED_DESC.get?U(TRUSTED_DESC.get):function(e){return e.isTrusted;};
var CLOSEST=U(Element.prototype.closest),HAS_ATTR=U(Element.prototype.hasAttribute),GET_ATTR=U(Element.prototype.getAttribute);
var ARRAY_PUSH=U(Array.prototype.push),ARRAY_INDEX=U(Array.prototype.indexOf);
var URL_PROTOCOL_DESC=OWN_DESC(URL.prototype,'protocol'),URL_HREF_DESC=OWN_DESC(URL.prototype,'href');
var GET_URL_PROTOCOL=URL_PROTOCOL_DESC&&URL_PROTOCOL_DESC.get?U(URL_PROTOCOL_DESC.get):null,GET_URL_HREF=URL_HREF_DESC&&URL_HREF_DESC.get?U(URL_HREF_DESC.get):null;
var JSON_PARSE=JSON.parse,JSON_STRINGIFY=JSON.stringify,URL_CTOR=URL,RESPONSE_CTOR=Response,BASE_URL=location.href;
function id(){try{if(crypto&&crypto.randomUUID)return crypto.randomUUID();}catch(_){}return Date.now().toString(36)+'-'+(++N).toString(36);}
var D='doc_'+id(),nav=window.navigation,SAFE_NAV=!!(nav&&typeof nav.addEventListener==='function'&&GET_PORTS&&GET_DATA&&GET_SOURCE&&GET_TARGET&&GET_TRUSTED&&GET_URL_PROTOCOL&&GET_URL_HREF);
function lock(name,value){try{Object.defineProperty(window,name,{value:value,writable:false,configurable:false});}catch(_){}}
if(SAFE_NAV){ADD(nav,'navigate',function(e){if(e.hashChange)return;if(e.cancelable)PREVENT(e);},true);}
function finish(m){var p;if(!m||m.channel!==C||m.version!==1||m.kind!=='response'||m.workspaceId!==S||typeof m.id!=='string')return;p=P.get(m.id);if(!p)return;P.delete(m.id);clearTimeout(p.timer);if(m.ok)p.resolve(m.result);else p.reject(new Error(typeof m.error==='string'?m.error:'Workspace request failed'));}
function send(m){if(PORT)PORT_POST(PORT,m);else ARRAY_PUSH(Q,m);}
function gesture(op,payload){var m;if(!SAFE_NAV)return;m={channel:GC,version:1,kind:'gesture',workspaceId:S,documentId:D,id:id(),op:op,payload:payload||{}};if(GPORT)PORT_POST(GPORT,m);else if(GQ.length<8)ARRAY_PUSH(GQ,m);}
function rpc(op,payload){return new Promise(function(resolve,reject){if(!SAFE_NAV){reject(new Error('This browser cannot safely isolate Workspace navigation'));return;}if(parent===window){reject(new Error('Workspace bridge requires the Clementine shell'));return;}if(P.size>=64){reject(new Error('Too many Workspace requests'));return;}var rid=id(),timer=setTimeout(function(){P.delete(rid);reject(new Error('Workspace request timed out'));},30000);P.set(rid,{resolve:resolve,reject:reject,timer:timer});send({channel:C,version:1,kind:'request',workspaceId:S,id:rid,op:op,payload:payload||{}});});}
function onAck(e){var m,p,g,i,ports;if(GET_TRUSTED(e)!==true||GET_SOURCE(e)!==parent)return;m=GET_DATA(e);ports=GET_PORTS(e);if(!m||m.channel!==C||m.version!==1||m.kind!=='bootstrap_ack'||m.workspaceId!==S||m.documentId!==D||!ports||!ports[0]||!ports[1])return;STOP(e);PORT=ports[0];GPORT=ports[1];ADD(PORT,'message',function(pe){finish(GET_DATA(pe));});PORT_START(PORT);for(i=0;i<Q.length;i++){p=Q[i];PORT_POST(PORT,p);}Q.length=0;for(i=0;i<GQ.length;i++){g=GQ[i];PORT_POST(GPORT,g);}GQ.length=0;if(BOOT)clearInterval(BOOT);REMOVE(window,'message',onAck,true);}
ADD(window,'message',onAck,true);
function bootstrap(){parent.postMessage({channel:C,version:1,kind:'bootstrap',workspaceId:S,documentId:D},'*');}
var BOOT=null;if(parent!==window){bootstrap();BOOT=setInterval(bootstrap,250);setTimeout(function(){if(BOOT){clearInterval(BOOT);BOOT=null;}},5000);}
function response(body,status){return new RESPONSE_CTOR(JSON_STRINGIFY(body),{status:status||200,headers:{'content-type':'application/json'}});}
function parsedBody(init){if(!init||init.body===undefined||init.body===null||init.body==='')return {};if(typeof init.body!=='string')throw new TypeError('Workspace compatibility fetch accepts a JSON string body only');var value=JSON_PARSE(init.body);if(!value||typeof value!=='object'||Array.isArray(value))throw new TypeError('Workspace request body must be a JSON object');return value;}
function legacyFetch(input,init){return Promise.resolve().then(function(){var raw=typeof input==='string'?input:(input&&typeof input.url==='string'?input.url:String(input));var u=new URL_CTOR(raw,location.href),here=new URL_CTOR(location.href),prefix='/api/console/spaces/'+encodeURIComponent(S)+'/',method=String((init&&init.method)||(input&&input.method)||'GET').toUpperCase(),body=parsedBody(init),tail;if(u.origin!==here.origin||u.search||u.hash||u.pathname.indexOf(prefix)!==0)throw new TypeError('Workspace fetch is limited to this Workspace RPC surface');tail=u.pathname.slice(prefix.length);if(tail==='data'&&method==='GET')return rpc('data',{}).then(function(r){return response({data:r},200);});if(tail==='refresh'&&method==='POST')return rpc('refresh',typeof body.sourceId==='string'?{sourceId:body.sourceId}:{}).then(function(r){return response(r,200);});if(tail==='notes'&&method==='POST')return rpc('note',{text:body.text,kind:body.kind,meta:body.meta}).then(function(r){return response(r,201);});if(tail==='compose'&&method==='POST')return rpc('compose',{instructions:body.instructions,context:body.context,maxChars:body.maxChars}).then(function(r){return response({text:r},200);});if(tail==='action'&&method==='POST')return rpc('action',{actionId:body.actionId,args:body.args||{}}).then(function(r){return response(r,r&&r.pending?202:200);});throw new TypeError('Workspace fetch operation is not allowed');}).catch(function(error){return response({error:error&&error.message?String(error.message):'Workspace request failed'},500);});}
lock('fetch',legacyFetch);
['XMLHttpRequest','WebSocket','EventSource','WebTransport','RTCPeerConnection','webkitRTCPeerConnection'].forEach(function(name){lock(name,undefined);});
try{Object.defineProperty(navigator,'sendBeacon',{value:function(){return false;},writable:false,configurable:false});}catch(_){}
function anchor(e){var path=PATH(e),i,a;for(i=0;i<path.length;i++){try{a=CLOSEST(path[i],'a');if(a)return a;}catch(_){}}return null;}
ADD(document,'click',function(e){var a,raw,parsed,url,protocol;if(GET_TRUSTED(e)!==true||GET_TARGET(e)===null||(a=anchor(e))===null)return;if(HAS_ATTR(a,'download')){PREVENT(e);STOP(e);gesture('download',{filename:GET_ATTR(a,'download')||'download',dataUrl:GET_ATTR(a,'href')||''});return;}raw=GET_ATTR(a,'href');if(typeof raw!=='string'||!raw)return;try{parsed=new URL_CTOR(raw,BASE_URL);url=GET_URL_HREF(parsed);protocol=GET_URL_PROTOCOL(parsed);}catch(_){return;}if(ARRAY_INDEX(['https:','http:','mailto:','tel:','callto:','sms:','facetime:','facetime-audio:','maps:','webcal:','zoommtg:','msteams:'],protocol)<0)return;PREVENT(e);STOP(e);gesture('open_external',{url:url});},true);
window.clem=Object.freeze({slug:S,data:function(){return rpc('data',{});},history:function(opts){return rpc('history',opts&&typeof opts==='object'?opts:{});},diff:function(opts){return rpc('diff',opts&&typeof opts==='object'?opts:{});},refresh:function(sourceId){return rpc('refresh',typeof sourceId==='string'?{sourceId:sourceId}:{});},note:function(text,kind,meta){return rpc('note',{text:text,kind:kind,meta:meta});},compose:function(instructions,context,maxChars){return rpc('compose',{instructions:instructions,context:context,maxChars:maxChars});},action:function(actionId,args){return rpc('action',{actionId:actionId,args:args||{}});}});
})();</script>`;
};

function isLoopback(req: Request): boolean {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
}

/** Generate a unique, valid slug from a title. */
function slugify(title: string): string {
  let base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  if (base.length < 2) base = `workspace-${Date.now().toString(36)}`;
  if (!isValidSpaceSlug(base)) base = `workspace-${Date.now().toString(36)}`;
  let candidate = base;
  let n = 2;
  while (spaceStore.get(candidate)) { candidate = `${base}-${n++}`.slice(0, 63); }
  return candidate;
}

const PLACEHOLDER_VIEW = (title: string) => `<!doctype html><html><head><meta charset="utf-8">
<title>${title.replace(/[<>&]/g, '')}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:48px;color:#1f1b16;background:#faf7f2}
.card{max-width:640px;margin:0 auto;background:#fff;border:1px solid #e7e1d6;border-radius:16px;padding:32px}</style></head>
<body><div class="card"><h1>${title.replace(/[<>&]/g, '')}</h1>
<p>This workspace is empty. Ask Clem to build it — she'll write the view and wire up its data.</p></div></body></html>`;

export function registerSpaceRoutes(app: Express, isAuthorized: IsAuthorized): void {
  // Wire the gated-action resolve listener once, so an APPROVED one-click Space
  // action actually runs (a button click has no agent turn to resume). Idempotent.
  initSpaceActionApprovals();

  // ---- View serving (opaque-origin sandbox) ------------------------------
  const serveView = (req: Request, res: Response): void => {
    if (!isAuthorized(req)) { res.status(401).send('Unauthorized'); return; }
    if (!isLoopback(req)) { res.status(403).send('Workspaces are loopback-only'); return; }
    const slug = String(req.params.id ?? '');
    if (!isValidSpaceSlug(slug)) { res.status(400).send('invalid workspace id'); return; }
    const rec = spaceStore.get(slug);
    if (!rec || rec.status === 'archived') { res.status(404).send('workspace not found'); return; }
    const csp = workspaceViewCsp(req, slug);
    if (!csp) { res.status(400).send('invalid loopback host'); return; }
    const sub = (req.params[0] as string | undefined) || 'index.html';
    let target: string;
    try {
      target = resolveInSpace(slug, path.join('view', sub));
    } catch {
      res.status(403).send('forbidden'); return;
    }
    if (!existsSync(target) || statSync(target).isDirectory()) { res.status(404).send('not found'); return; }
    const ext = path.extname(target).toLowerCase();
    res.setHeader('Content-Type', CONTENT_TYPES[ext] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (ext === '.svg') {
      res.setHeader('Content-Security-Policy', WORKSPACE_SVG_CSP);
    }
    if (ext === '.html' || ext === '.htm') {
      // A response header is mandatory here: an iframe attribute protects the
      // normal console path, but not a raw URL opened in a tab. No
      // allow-same-origin means the authored document gets a unique opaque
      // origin; connect-src/form-action/frame-src keep it from using the parent
      // as a network or navigation deputy.
      res.setHeader('Content-Security-Policy', csp);
      const html = readFileSync(target, 'utf-8');
      // Bridge FIRST — literally. It must be DEFINED before any authored
      // <script> runs, so it goes at the TOP of <head>, not before </body>.
      // (An end-of-body injection lands AFTER a view's own load()/clem.data()
      // script, which runs first in document order → `clem` is undefined →
      // the surface renders empty on first load. That ordering bug forced
      // hand-rolled `waitForClem` polls in authored views.) The bridge touches
      // no DOM, so <head> is safe.
      // Wiring-health banner LAST (end of body): the surface tells the user
      // when its own plumbing can't deliver what the UI promises (e.g. a
      // refresh action with no data source attached) and names the one-line
      // ask that has Clem repair it. Advisory: dismissible, never blocks.
      const wiring = spaceWiringHealth(spaceStore.get(slug) ?? { title: slug, dataSources: [], actions: [] });
      res.send(appendWiringHealthBanner(injectWorkspaceBootstrap(html, CLEM_VIEW_BRIDGE(slug)), wiring));
      return;
    }
    res.send(readFileSync(target));
  };
  app.get('/console/spaces/:id/view', (req, res) => {
    // Express is non-strict about trailing slashes, so this handler sees both
    // `/view` and `/view/`. Serve the canonical slash form directly and only
    // redirect the non-slash form; otherwise fetch/browser follows a loop.
    if (req.path.endsWith('/')) { serveView(req, res); return; }
    if (!isAuthorized(req)) { res.status(401).send('Unauthorized'); return; }
    if (!isLoopback(req)) { res.status(403).send('Workspaces are loopback-only'); return; }
    const slug = String(req.params.id ?? '');
    if (!isValidSpaceSlug(slug) || !spaceStore.get(slug)) { res.status(404).send('workspace not found'); return; }
    res.redirect(308, `/console/spaces/${encodeURIComponent(slug)}/view/`);
  });
  app.get('/console/spaces/:id/view/*', serveView);

  // ---- Management --------------------------------------------------------
  app.get('/api/console/spaces', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const spaces = spaceStore.list(req.query.archived === '1');
    res.json({ spaces: spaces.map((space) => ({ ...space, health: buildSpaceHealthSnapshot(space) })) });
  });

  app.post('/api/console/spaces', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'New workspace';
    const slug = typeof req.body?.slug === 'string' && isValidSpaceSlug(req.body.slug) ? req.body.slug : slugify(title);
    if (spaceStore.get(slug)) { res.status(409).json({ error: 'slug already exists' }); return; }
    const contract = mergeSpaceContract(undefined, {
      objective: req.body?.objective,
      successCriteria: req.body?.successCriteria ?? req.body?.success_criteria,
      invariants: req.body?.invariants,
    });
    const canonical = resolveInSpace(slug, 'view/index.html');
    mkdirSync(path.dirname(canonical), { recursive: true });
    writeFileSync(canonical, PLACEHOLDER_VIEW(title), 'utf-8');
    const rec = spaceStore.save({
      id: slug, title, viewEntry: 'view/index.html',
      ...(contract ? { contract } : {}),
    });
    res.status(201).json({ space: rec });
  });

  app.get('/api/console/spaces/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = req.params.id;
    if (!isValidSpaceSlug(slug)) { res.status(400).json({ error: 'invalid id' }); return; }
    const rec = spaceStore.get(slug);
    if (!rec) { res.status(404).json({ error: 'not found' }); return; }
    let viewSource = '';
    let viewMtimeMs = 0;
    try {
      const vf = resolveInSpace(slug, rec.viewEntry);
      viewSource = readFileSync(vf, 'utf-8');
      viewMtimeMs = statSync(vf).mtimeMs; // lets the UI auto-reload on ANY view edit (incl. write_file)
    } catch { /* no view yet */ }
    const health = buildSpaceHealthSnapshot(rec);
    res.json({
      space: { ...rec, health },
      viewSource,
      viewMtimeMs,
      notes: listNotes(slug, 50),
      audit: listAudit(slug, 50),
      health,
      linkedWorkflows: linkedWorkflowsForSpace(slug),
    });
  });

  app.patch('/api/console/spaces/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = req.params.id;
    if (!isValidSpaceSlug(slug)) { res.status(400).json({ error: 'invalid id' }); return; }
    const rec = spaceStore.get(slug);
    if (!rec) { res.status(404).json({ error: 'not found' }); return; }
    if (rec.manifestErrors && rec.manifestErrors.length > 0) {
      res.status(409).json({ error: `workspace manifest is invalid; fix with space_save before patching metadata: ${rec.manifestErrors.join('; ')}` });
      return;
    }
    const patch: Record<string, unknown> = {};
    if (typeof req.body?.title === 'string') patch.title = req.body.title.trim().slice(0, 200);
    if (req.body?.status === 'active' || req.body?.status === 'paused' || req.body?.status === 'archived') {
      patch.status = req.body.status;
    }
    if (
      Object.prototype.hasOwnProperty.call(req.body ?? {}, 'objective')
      || Object.prototype.hasOwnProperty.call(req.body ?? {}, 'successCriteria')
      || Object.prototype.hasOwnProperty.call(req.body ?? {}, 'success_criteria')
      || Object.prototype.hasOwnProperty.call(req.body ?? {}, 'invariants')
    ) {
      const contract = mergeSpaceContract(rec.contract, {
        objective: req.body?.objective,
        successCriteria: req.body?.successCriteria ?? req.body?.success_criteria,
        invariants: req.body?.invariants,
      });
      if (contract) {
        patch.contract = contract;
      } else {
        // Contract fields were sent but no contract can exist yet — a silent
        // 200 here would discard the caller's criteria/invariants.
        res.status(400).json({ error: 'A workspace contract needs an objective before success criteria or invariants can be saved. Send objective (or set it first) and retry.' });
        return;
      }
    }
    const updated = spaceStore.update(slug, patch);
    res.json({ space: updated });
  });

  app.delete('/api/console/spaces/:id', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = req.params.id;
    if (!isValidSpaceSlug(slug)) { res.status(400).json({ error: 'invalid id' }); return; }
    if (req.query.hard === '1') {
      res.json({ removed: spaceStore.remove(slug) });
    } else {
      res.json({ space: spaceStore.archive(slug) });
    }
  });

  // ---- Data plane (called by the trusted console RPC host) ---------------
  app.get('/api/console/spaces/:id/data', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = req.params.id;
    if (!isValidSpaceSlug(slug) || !spaceStore.get(slug)) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ data: readData(slug) });
  });

  app.put('/api/console/spaces/:id/data', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = req.params.id;
    const rec = spaceStore.get(slug);
    if (!isValidSpaceSlug(slug) || !rec) { res.status(404).json({ error: 'not found' }); return; }
    if (rec.status !== 'active') { res.status(423).json({ error: `workspace is ${rec.status}` }); return; }
    const body = req.body as unknown;
    const document = (
      body !== null
      && typeof body === 'object'
      && !Array.isArray(body)
      && Object.hasOwn(body, 'data')
    )
      ? (body as Record<string, unknown>).data
      : body;
    let serialized: string;
    try {
      const encoded = JSON.stringify(document === undefined ? {} : document);
      if (encoded === undefined) {
        throw new Error('top-level value is not representable in JSON');
      }
      serialized = encoded;
    } catch (err) {
      const error = `data is not JSON-serializable: ${(err as Error).message}`;
      appendAudit(slug, { method: 'PUT', path: '/data', outcome: 'rejected', bytes: 0, note: error });
      res.status(413).json({ error });
      return;
    }
    const bytes = Buffer.byteLength(serialized, 'utf-8');
    if (bytes > MAX_DATA_BYTES) {
      const error = `data exceeds ${MAX_DATA_BYTES} byte cap (${bytes} bytes)`;
      appendAudit(slug, { method: 'PUT', path: '/data', outcome: 'rejected', bytes, note: error });
      res.status(413).json({ error });
      return;
    }
    try {
      // A legacy file-backed Workspace may not have reached the rebuildable DB
      // index yet. Index it before the append-only temporal commit.
      ensureWorkspaceIndexed(rec);
      bootstrapLegacyWorkspaceHistoryIfNeeded(slug);
      const committed = commitWorkspaceObservationBatch({
        workspaceId: slug,
        observations: [{
          sourceKey: '$document',
          refreshId: randomUUID(),
          cause: 'direct_put',
          projectionMode: 'document',
          status: 'ok',
          data: document,
        }],
      });
      try {
        await finalizeWorkspaceObservationCommit(slug, committed);
      } catch {
        // The temporal commit + data.json projection are already durable.
        // Memory/retention maintenance is best-effort and must never turn a
        // successful external write into a false failure.
      }
      appendAudit(slug, {
        method: 'PUT',
        path: '/data',
        outcome: 'ok',
        bytes: committed.projection.bytes,
      });
      res.json({ ok: true, bytes: committed.projection.bytes });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      appendAudit(slug, {
        method: 'PUT',
        path: '/data',
        outcome: 'error',
        bytes,
        note: redactSensitiveText(error).slice(0, 1_000),
      });
      res.status(500).json({ error: 'workspace data could not be persisted' });
    }
  });

  app.get('/api/console/spaces/:id/history', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    const slug = String(req.params.id ?? '');
    const rec = spaceStore.get(slug);
    if (!isValidSpaceSlug(slug) || !rec) { res.status(404).json({ error: 'not found' }); return; }
    const sourceKey = parseSourceKey(req.query.sourceKey);
    const limit = parseHistoryLimit(req.query.limit);
    const before = parseBefore(req.query.before);
    const cursor = parseObservationId(req.query.cursor);
    if (
      !sourceKey.ok
      || !limit.ok
      || !before.ok
      || !cursor.ok
      || (before.value !== undefined && cursor.value !== undefined)
    ) {
      res.status(400).json({ error: 'invalid history query' });
      return;
    }
    try {
      ensureWorkspaceIndexed(rec);
      bootstrapLegacyWorkspaceHistoryIfNeeded(slug);
      const observations = listWorkspaceDatasetObservations(slug, {
        ...(sourceKey.value ? { sourceKey: sourceKey.value } : {}),
        ...(before.value ? { before: before.value } : {}),
        ...(cursor.value ? { cursor: cursor.value } : {}),
        // Fetch one extra row so pagination never guesses from a full page.
        limit: limit.value + 1,
      });
      const hasMore = observations.length > limit.value;
      const page = observations.slice(0, limit.value).map(safeObservation);
      const nextCursor = hasMore ? page.at(-1)?.id : undefined;
      const nextBefore = hasMore ? page.at(-1)?.observedAt : undefined;
      res.json({
        observations: page,
        hasMore,
        ...(nextCursor ? { nextCursor } : {}),
        // Kept for older console clients. Cursor is the lossless 3.0 contract.
        ...(nextBefore ? { nextBefore } : {}),
        ...(sourceKey.value ? { sourceKey: sourceKey.value } : {}),
      });
    } catch (error) {
      if (
        error instanceof Error
        && error.message === 'Workspace observation cursor was not found for this workspace'
      ) {
        res.status(400).json({ error: 'invalid history cursor' });
        return;
      }
      // The DB is a rebuildable index. A broken/unavailable index must not
      // break the live Workspace or accidentally fall back to unsafely reading
      // arbitrary files.
      res.status(503).json({ error: 'workspace history is temporarily unavailable' });
    }
  });

  app.get('/api/console/spaces/:id/diff', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.setHeader('Cache-Control', 'no-store');
    const slug = String(req.params.id ?? '');
    const rec = spaceStore.get(slug);
    if (!isValidSpaceSlug(slug) || !rec) { res.status(404).json({ error: 'not found' }); return; }
    const sourceKey = parseSourceKey(req.query.sourceKey);
    const fromId = parseObservationId(req.query.from);
    const toId = parseObservationId(req.query.to);
    if (!sourceKey.ok || !fromId.ok || !toId.ok) {
      res.status(400).json({ error: 'invalid diff query' });
      return;
    }
    try {
      ensureWorkspaceIndexed(rec);
      bootstrapLegacyWorkspaceHistoryIfNeeded(slug);
      const recent = listWorkspaceDatasetObservations(slug, {
        ...(sourceKey.value ? { sourceKey: sourceKey.value } : {}),
        limit: 500,
      });

      let to = toId.value
        ? getWorkspaceDatasetObservation(slug, toId.value) ?? undefined
        : undefined;
      let from = fromId.value
        ? getWorkspaceDatasetObservation(slug, fromId.value) ?? undefined
        : undefined;
      if ((toId.value && !to) || (fromId.value && !from)) {
        res.status(404).json({ error: 'observation not found in this workspace' });
        return;
      }

      if (!to) {
        if (sourceKey.value) {
          to = getCurrentWorkspaceDatasetObservation(slug, sourceKey.value) ?? undefined;
        } else if (from) {
          to = getCurrentWorkspaceDatasetObservation(slug, from.sourceKey) ?? undefined;
        } else {
          const current = recent.filter((entry) =>
            entry.isCurrent && entry.status === 'ok' && entry.datasetId);
          if (current.length > 1) {
            res.status(400).json({
              error: 'sourceKey is required when a workspace has multiple current data sources',
            });
            return;
          }
          to = current[0];
        }
      }
      if (to && !from) {
        from = to.previousObservationId
          ? getWorkspaceDatasetObservation(slug, to.previousObservationId) ?? undefined
          : undefined;
      }

      const selectedSource = sourceKey.value ?? to?.sourceKey ?? from?.sourceKey;
      const successfulCount = recent.filter((entry) =>
        entry.status === 'ok'
        && entry.datasetId
        && (!selectedSource || entry.sourceKey === selectedSource)).length;
      if (!to || !from) {
        res.json({
          status: 'insufficient_history',
          ...(selectedSource ? { sourceKey: selectedSource } : {}),
          observations: successfulCount,
        });
        return;
      }
      if (
        to.status !== 'ok'
        || from.status !== 'ok'
        || !to.datasetId
        || !from.datasetId
        || to.sourceKey !== from.sourceKey
        || (sourceKey.value && (to.sourceKey !== sourceKey.value || from.sourceKey !== sourceKey.value))
      ) {
        res.status(400).json({ error: 'diff observations must be successful observations from one source' });
        return;
      }

      const beforeDocument = getWorkspaceObservationDocument(slug, from.id);
      const afterDocument = getWorkspaceObservationDocument(slug, to.id);
      if (beforeDocument === undefined || afterDocument === undefined) {
        res.status(410).json({ error: 'observation data is no longer retained' });
        return;
      }
      const diff = safeObservationDiff(diffWorkspaceObservationDocuments(beforeDocument, afterDocument, {
        maxChanges: 80,
        maxDepth: 8,
        maxPreviewChars: 240,
        maxCollectionEntries: 500,
      }));
      res.json({
        status: 'ok',
        sourceKey: to.sourceKey,
        from: safeObservation(from),
        to: safeObservation(to),
        diff,
      });
    } catch {
      res.status(503).json({ error: 'workspace history is temporarily unavailable' });
    }
  });

  app.get('/api/console/spaces/:id/notes', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = req.params.id;
    if (!isValidSpaceSlug(slug) || !spaceStore.get(slug)) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ notes: listNotes(slug, Number(req.query.limit) || 200) });
  });

  app.post('/api/console/spaces/:id/notes', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = req.params.id;
    const rec = spaceStore.get(slug);
    if (!isValidSpaceSlug(slug) || !rec) { res.status(404).json({ error: 'not found' }); return; }
    if (rec.status === 'archived') { res.status(423).json({ error: 'workspace is archived' }); return; }
    const textVal = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!textVal.trim()) { res.status(400).json({ error: 'text required' }); return; }
    const explicitKind = typeof req.body?.kind === 'string' ? req.body.kind : undefined;
    const storedKind = explicitKind === 'correction' || explicitKind === 'user_correction'
      ? 'correction_candidate'
      : explicitKind;
    const note = appendNote(slug, { text: textVal, kind: storedKind, meta: req.body?.meta });
    appendAudit(slug, { method: 'POST', path: '/notes', outcome: 'ok' });
    // Authored Workspace code can call clem.note() programmatically, so a
    // caller-provided `kind` is not proof of a human correction. Such labels
    // are downgraded to a local candidate; genuine user corrections made in
    // chat follow the normal trusted conversation-memory path.
    res.status(201).json({ note });
  });

  // ---- Lifecycle ---------------------------------------------------------
  app.post('/api/console/spaces/:id/refresh', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = req.params.id;
    if (!isValidSpaceSlug(slug) || !spaceStore.get(slug)) { res.status(404).json({ error: 'not found' }); return; }
    try {
      const results = await refreshSpaceData(slug, typeof req.body?.sourceId === 'string' ? req.body.sourceId : undefined);
      res.json({ results, data: readData(slug) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/spaces/:id/rollback', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = req.params.id;
    const rec = spaceStore.get(slug);
    if (!isValidSpaceSlug(slug) || !rec) { res.status(404).json({ error: 'not found' }); return; }
    const wanted = Number(req.body?.version);
    const revision = rec.revisions.find((r) => r.version === wanted) ?? rec.revisions[rec.revisions.length - 1];
    if (!revision) { res.status(400).json({ error: 'no prior version to restore' }); return; }
    let snapshot: string;
    try { snapshot = readFileSync(resolveInSpace(slug, revision.file), 'utf-8'); } catch { res.status(404).json({ error: 'snapshot missing' }); return; }
    spaceStore.recordRevision(slug); // snapshot current before overwriting
    const canonical = resolveInSpace(slug, rec.viewEntry);
    mkdirSync(path.dirname(canonical), { recursive: true });
    writeFileSync(canonical, snapshot, 'utf-8');
    appendAudit(slug, { method: 'POST', path: `/rollback/${revision.version}`, outcome: 'ok' });
    res.json({ space: spaceStore.get(slug), restoredFrom: revision.version });
  });

  // ---- Starter recipes: the "start from a recipe" activation list ---------
  // Runtime-filtered against the user's actually-connected toolkits (never a
  // hardcoded vendor list); connection-free recipes are always present.
  app.get('/api/console/spaces/starters', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    let slugs: string[] = [];
    try { slugs = (await listUsableConnectedToolkits()).map((t) => t.slug).filter(Boolean); } catch { /* offline → connection-free only */ }
    res.json({ starters: availableStarterRecipes(slugs) });
  });

  // ---- Publish: export a static share-ready snapshot ----------------------
  // Local export ONLY (spaces/<slug>/publish/<ts>/, never served): the dataset
  // is inlined, actions/refresh are frozen, no tokens. Deploying the folder is
  // a separate (gated) step — the console shows the path; Clem can deploy on ask.
  app.post('/api/console/spaces/:id/publish', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = req.params.id;
    if (!isValidSpaceSlug(slug) || !spaceStore.get(slug)) { res.status(404).json({ error: 'not found' }); return; }
    const result = buildPublishSnapshot(slug);
    if (!result.ok) { res.status(400).json({ error: result.error }); return; }
    res.json({ dir: result.dir, files: result.files, bytes: result.bytes, rowsBySource: result.rowsBySource });
  });

  // ---- Compose: the LLM step (data → drafted text) -----------------------
  // The view POSTs instructions + a data row; gets back a grounded draft (e.g.
  // a personalized email) to show the user before an action sends it. One cheap
  // fast-model call, no tools, fail-open.
  app.post('/api/console/spaces/:id/compose', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = String(req.params.id ?? '');
    const rec = spaceStore.get(slug);
    if (!isValidSpaceSlug(slug) || !rec) { res.status(404).json({ error: 'not found' }); return; }
    if (rec.status === 'archived') { res.status(423).json({ error: 'workspace is archived' }); return; }
    const instructions = typeof req.body?.instructions === 'string' ? req.body.instructions : '';
    if (!instructions.trim()) { res.status(400).json({ error: 'instructions required' }); return; }
    const result = await composeForSpace(instructions, req.body?.context, Number(req.body?.maxChars) || 4000);
    appendAudit(slug, { method: 'COMPOSE', path: '/compose', outcome: result.ok ? 'ok' : 'error', note: result.ok ? undefined : result.error });
    if (!result.ok) { res.status(502).json({ error: result.error }); return; }
    res.json({ text: result.text });
  });

  // ---- Action: fire a declared side-effect (e.g. send an email) ----------
  // The "two-way" half — the view triggers a server-side Composio op (or
  // runner) with caller-supplied args merged over the declared template.
  // Credentials resolve server-side; the action is audited + recorded as a
  // note so the dock's Clem knows what the user did.
  app.post('/api/console/spaces/:id/action', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = String(req.params.id ?? '');
    const rec = spaceStore.get(slug);
    if (!isValidSpaceSlug(slug) || !rec) { res.status(404).json({ error: 'not found' }); return; }
    if (rec.status !== 'active') { res.status(423).json({ error: `workspace is ${rec.status}` }); return; }
    if (rec.manifestErrors && rec.manifestErrors.length > 0) {
      res.status(409).json({ error: `workspace manifest is invalid; fix with space_save before running actions: ${rec.manifestErrors.join('; ')}` });
      return;
    }
    const actionId = typeof req.body?.actionId === 'string' ? req.body.actionId : '';
    const action = rec.actions.find((a) => a.id === actionId);
    if (!action) { res.status(404).json({ error: `no action "${actionId}"` }); return; }
    const callerArgs = (req.body?.args && typeof req.body.args === 'object') ? req.body.args as Record<string, unknown> : {};
    // E1 — an action that MUTATES an external system (a send, a CRM write) takes
    // ONE approval (surfaced in the inbox/board) before it fires; READ-class
    // actions run instantly. The runtime boundary repeats this check, so an
    // alternate caller or stale debug configuration cannot bypass approval.
    // Standing trust: a prior approval whose EXACT authority still holds
    // (same action, same args, byte-identical runner) covers this click —
    // approve once per runner version instead of once per refresh.
    const standing = spaceActionNeedsApproval(action)
      ? standingSpaceActionAuthority(rec, action, callerArgs)
      : null;
    if (spaceActionNeedsApproval(action) && !standing?.ok) {
      try {
        const { approvalId, subject } = enqueueSpaceActionApproval(rec, action, callerArgs);
        res.status(202).json({ pending: true, approvalId, subject });
      } catch (err) {
        res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    try {
      const result = standing?.ok
        ? await runSpaceAction(slug, action, callerArgs, {
            approvalId: standing.approvalId,
            executionNonce: randomUUID(),
          })
        : await runSpaceAction(slug, action, callerArgs);
      appendAudit(slug, {
        method: 'ACTION',
        path: `/action/${actionId}`,
        outcome: result.ok ? 'ok' : 'error',
        note: standing?.ok
          ? `covered by standing approval ${standing.approvalId}${result.ok ? '' : ` — ${result.error}`}`
          : result.ok ? undefined : result.error,
      });
      // Record what happened so the workspace's Clem has context.
      appendNote(slug, {
        text: result.ok ? `Ran "${action.label ?? actionId}"` : `"${action.label ?? actionId}" failed: ${result.error}`,
        kind: 'action',
        meta: { actionId, ok: result.ok },
      });
      if (!result.ok) { res.status(502).json({ ok: false, error: result.error }); return; }
      res.json({ ok: true, result: result.data });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ---- Re-engage: wake Clem about this workspace -------------------------
  // Used by the floating dock's "ask" path and the view's tracked triggers
  // (a note left, a threshold crossed). Records the action durably, then stages
  // a turn into the workspace's dedicated chat thread via the unified outcome
  // contract (idempotent by action id, non-blocking, never throws).
  app.post('/api/console/spaces/:id/reengage', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = String(req.params.id ?? '');
    if (!isValidSpaceSlug(slug)) { res.status(404).json({ error: 'not found' }); return; }
    const trigger: 'note' | 'ask' | 'threshold' =
      req.body?.trigger === 'ask' || req.body?.trigger === 'threshold' ? req.body.trigger : 'note';
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    const actionId = typeof req.body?.actionId === 'string' ? req.body.actionId : undefined;
    const { status, body } = await reengageSpace(slug, { trigger, message, actionId, meta: req.body?.meta });
    res.status(status).json(body);
  });

  // Quiet helper so a stray directory under SPACES_DIR never 500s the list.
  void resolveSpaceDir;
}
