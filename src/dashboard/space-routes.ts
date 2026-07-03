/**
 * Workspaces ("Spaces") daemon routes. Additive, mounted only when the
 * CLEMENTINE_SPACES flag is on (gated by the caller in webhook.ts).
 *
 *  - View serving (same-origin so the agent-authored view inherits the console
 *    session cookie + CSP): GET /console/spaces/:id/view[/*] — path-safe,
 *    no-store, loopback-only. ONLY the view/ subtree is served, so data.json /
 *    notes / the manifest can never leak.
 *  - Data plane the view calls (cookie-authed): GET/PUT data, GET/POST notes.
 *  - Management for the console UI: list / create / get / patch / delete.
 *  - Lifecycle: refresh (server-side, NO LLM), rollback.
 *
 * Mirrors the inline auth + path-safety idioms in console-routes.ts.
 */
import type { Express, Request, Response } from 'express';
import { existsSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  spaceStore, resolveInSpace, resolveSpaceDir, isValidSpaceSlug,
} from '../spaces/store.js';
import {
  readData, writeData, appendNote, listNotes, appendAudit, listAudit,
} from '../spaces/data-store.js';
import { refreshSpaceData, runSpaceAction } from '../spaces/runner.js';
import { composeForSpace } from '../spaces/compose.js';
import {
  spaceActionApprovalEnabled, spaceActionNeedsApproval,
  enqueueSpaceActionApproval, initSpaceActionApprovals,
} from '../spaces/space-action-gate.js';
import { reengageSpace } from '../spaces/reengage.js';
import { buildPublishSnapshot } from '../spaces/publish.js';
import { availableStarterRecipes } from '../spaces/starter-recipes.js';
import { listUsableConnectedToolkits } from '../integrations/composio/client.js';

type IsAuthorized = (req: Request) => boolean;

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

/** Injected into every served HTML view: turn external-protocol link clicks
 *  (tel:/mailto:/sms:/facetime:) into window.open so the desktop routes them to
 *  the OS instead of navigating (and blanking) the iframe. Capture-phase so it
 *  wins over the link's own navigation; works no matter how the agent authored
 *  the link. */
const EXTERNAL_LINK_SHIM = `<script>(function(){document.addEventListener('click',function(e){var t=e.target;var a=t&&t.closest?t.closest('a[href]'):null;if(!a)return;var h=a.getAttribute('href')||'';if(/^(tel:|callto:|sms:|mailto:|facetime:|facetime-audio:|maps:|webcal:)/i.test(h)){e.preventDefault();try{window.open(h);}catch(_){}}},true);})();</script>`;

/** Injected into every served HTML view: a tiny same-origin helper so Clem
 *  never hand-rolls fetch() (the #1 source of broken views — wrong slug, wrong
 *  data key). The slug is baked in at serve time, so the view just calls:
 *    await clem.data()                       → the dataset (keyed by sourceId)
 *    await clem.refresh(sourceId?)           → re-pull server-side, returns data
 *    await clem.compose(instructions, ctx)   → a grounded draft (throws on error)
 *    await clem.action(actionId, args)       → fire a declared action
 *    await clem.note(text, kind?, meta?)     → record a note
 *  clem.action() RESOLVES the E1 approval contract: a send/write returns
 *  {pending:true, approvalId} (the user approves in the inbox; it fires then),
 *  a read returns {ok:true, result}. CSP-safe (inline, same-origin). */
const CLEM_VIEW_BRIDGE = (slug: string): string => {
  const B = JSON.stringify(`/api/console/spaces/${slug}`);
  const S = JSON.stringify(slug);
  return `<script>(function(){var B=${B};`
    + `async function j(m,p,b){var r=await fetch(B+p,{method:m,headers:b?{'content-type':'application/json'}:undefined,body:b?JSON.stringify(b):undefined});var d=null;try{d=await r.json();}catch(e){}return{status:r.status,ok:r.ok,data:d};}`
    + `window.clem={slug:${S},`
    + `data:async function(){var r=await j('GET','/data');return r.data&&r.data.data;},`
    + `refresh:async function(id){var r=await j('POST','/refresh',id?{sourceId:id}:{});return r.data;},`
    + `note:async function(t,k,meta){var r=await j('POST','/notes',{text:t,kind:k,meta:meta});return r.data;},`
    + `compose:async function(ins,ctx,mx){var r=await j('POST','/compose',{instructions:ins,context:ctx,maxChars:mx});if(!r.ok)throw new Error((r.data&&r.data.error)||'compose failed');return r.data&&r.data.text;},`
    + `action:async function(id,args){var r=await j('POST','/action',{actionId:id,args:args||{}});if(r.status===202&&r.data&&r.data.pending)return{pending:true,approvalId:r.data.approvalId,subject:r.data.subject};if(!r.ok)throw new Error((r.data&&r.data.error)||'action failed');return{ok:true,result:r.data&&r.data.result};}`
    + `};})();</script>`;
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

  // ---- View serving (same-origin) ----------------------------------------
  const serveView = (req: Request, res: Response): void => {
    if (!isAuthorized(req)) { res.status(401).send('Unauthorized'); return; }
    if (!isLoopback(req)) { res.status(403).send('Workspaces are loopback-only'); return; }
    const slug = String(req.params.id ?? '');
    if (!isValidSpaceSlug(slug)) { res.status(400).send('invalid workspace id'); return; }
    const rec = spaceStore.get(slug);
    if (!rec || rec.status === 'archived') { res.status(404).send('workspace not found'); return; }
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
    if (ext === '.html' || ext === '.htm') {
      // Inject a click shim: external-protocol links (tel:/mailto:/sms:/…)
      // must NOT navigate the iframe (Electron has no handler → the frame
      // blanks with ERR_BLOCKED_BY_CSP). Route them through window.open, which
      // the desktop's setWindowOpenHandler hands to the OS (the dialer/mail).
      // Same-origin inline script — allowed by the console CSP.
      const html = readFileSync(target, 'utf-8');
      // Bridge first (so the view's own scripts can call window.clem), then the
      // external-link shim. Both are same-origin inline scripts (console CSP).
      const injected = `${CLEM_VIEW_BRIDGE(slug)}${EXTERNAL_LINK_SHIM}`;
      res.send(html.includes('</body>') ? html.replace('</body>', `${injected}</body>`) : html + injected);
      return;
    }
    res.send(readFileSync(target));
  };
  app.get('/console/spaces/:id/view', serveView);
  app.get('/console/spaces/:id/view/*', serveView);

  // ---- Management --------------------------------------------------------
  app.get('/api/console/spaces', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    res.json({ spaces: spaceStore.list(req.query.archived === '1') });
  });

  app.post('/api/console/spaces', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim() : 'New workspace';
    const slug = typeof req.body?.slug === 'string' && isValidSpaceSlug(req.body.slug) ? req.body.slug : slugify(title);
    if (spaceStore.get(slug)) { res.status(409).json({ error: 'slug already exists' }); return; }
    const canonical = resolveInSpace(slug, 'view/index.html');
    mkdirSync(path.dirname(canonical), { recursive: true });
    writeFileSync(canonical, PLACEHOLDER_VIEW(title), 'utf-8');
    const rec = spaceStore.save({ id: slug, title, viewEntry: 'view/index.html' });
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
    res.json({ space: rec, viewSource, viewMtimeMs, notes: listNotes(slug, 50), audit: listAudit(slug, 50) });
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

  // ---- Data plane (called by the agent-authored view) --------------------
  app.get('/api/console/spaces/:id/data', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = req.params.id;
    if (!isValidSpaceSlug(slug) || !spaceStore.get(slug)) { res.status(404).json({ error: 'not found' }); return; }
    res.json({ data: readData(slug) });
  });

  app.put('/api/console/spaces/:id/data', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const slug = req.params.id;
    const rec = spaceStore.get(slug);
    if (!isValidSpaceSlug(slug) || !rec) { res.status(404).json({ error: 'not found' }); return; }
    if (rec.status !== 'active') { res.status(423).json({ error: `workspace is ${rec.status}` }); return; }
    const result = writeData(slug, req.body?.data ?? req.body);
    appendAudit(slug, { method: 'PUT', path: '/data', outcome: result.ok ? 'ok' : 'rejected', bytes: result.bytes, note: result.ok ? undefined : result.error });
    if (!result.ok) { res.status(413).json({ error: result.error }); return; }
    res.json({ ok: true, bytes: result.bytes });
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
    const note = appendNote(slug, { text: textVal, kind: typeof req.body?.kind === 'string' ? req.body.kind : undefined, meta: req.body?.meta });
    appendAudit(slug, { method: 'POST', path: '/notes', outcome: 'ok' });
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
    // actions run instantly. Kill-switch: CLEMMY_SPACE_ACTION_APPROVAL.
    if (spaceActionApprovalEnabled() && spaceActionNeedsApproval(action)) {
      try {
        const { approvalId, subject } = enqueueSpaceActionApproval(rec, action, callerArgs);
        res.status(202).json({ pending: true, approvalId, subject });
      } catch (err) {
        res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    try {
      const result = await runSpaceAction(slug, action, callerArgs);
      appendAudit(slug, { method: 'ACTION', path: `/action/${actionId}`, outcome: result.ok ? 'ok' : 'error', note: result.ok ? undefined : result.error });
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
