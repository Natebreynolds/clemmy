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
import { deliverOutcome } from '../runtime/outcome.js';

type IsAuthorized = (req: Request) => boolean;

/** The dedicated chat thread for a Workspace's floating "Ask Clem" dock +
 *  re-engage wakes. Stable + deterministic so the dock and the callback share
 *  one continuous per-workspace conversation. */
export function spaceSessionId(slug: string): string {
  return `space-${slug}`;
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

/** Injected into every served HTML view: turn external-protocol link clicks
 *  (tel:/mailto:/sms:/facetime:) into window.open so the desktop routes them to
 *  the OS instead of navigating (and blanking) the iframe. Capture-phase so it
 *  wins over the link's own navigation; works no matter how the agent authored
 *  the link. */
const EXTERNAL_LINK_SHIM = `<script>(function(){document.addEventListener('click',function(e){var t=e.target;var a=t&&t.closest?t.closest('a[href]'):null;if(!a)return;var h=a.getAttribute('href')||'';if(/^(tel:|callto:|sms:|mailto:|facetime:|facetime-audio:|maps:|webcal:)/i.test(h)){e.preventDefault();try{window.open(h);}catch(_){}}},true);})();</script>`;

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
      res.send(html.includes('</body>') ? html.replace('</body>', `${EXTERNAL_LINK_SHIM}</body>`) : html + EXTERNAL_LINK_SHIM);
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
    if (!spaceStore.get(slug)) { res.status(404).json({ error: 'not found' }); return; }
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
    const actionId = typeof req.body?.actionId === 'string' ? req.body.actionId : '';
    const action = rec.actions.find((a) => a.id === actionId);
    if (!action) { res.status(404).json({ error: `no action "${actionId}"` }); return; }
    const callerArgs = (req.body?.args && typeof req.body.args === 'object') ? req.body.args as Record<string, unknown> : {};
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
    const rec = spaceStore.get(slug);
    if (!isValidSpaceSlug(slug) || !rec) { res.status(404).json({ error: 'not found' }); return; }
    if (rec.status === 'archived') { res.status(423).json({ error: 'workspace is archived' }); return; }

    const trigger: 'note' | 'ask' | 'threshold' =
      req.body?.trigger === 'ask' || req.body?.trigger === 'threshold' ? req.body.trigger : 'note';
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    const actionId = typeof req.body?.actionId === 'string' && req.body.actionId.trim()
      ? req.body.actionId.trim()
      : `${trigger}-${message.slice(0, 24)}`;

    // Always record the interaction durably (notes are the audit of what
    // happened in the surface, even if we don't wake Clem for it).
    if (message) appendNote(slug, { text: message, kind: trigger, meta: req.body?.meta });
    appendAudit(slug, { method: 'POST', path: `/reengage/${trigger}`, outcome: 'ok' });

    // A configured-but-unlisted, non-'ask' trigger is recorded only (no wake) —
    // 'ask' is an explicit user request and always wakes.
    const configured = rec.reengage?.triggers ?? [];
    const shouldWake = trigger === 'ask' || configured.includes(trigger);
    if (!shouldWake) { res.status(202).json({ ok: true, reengaged: false, reason: 'trigger not configured' }); return; }

    try {
      const guidance = rec.reengage?.guidance;
      await deliverOutcome(
        {
          status: 'needs_input',
          summary: message
            ? `In your "${rec.title}" workspace: ${message}`
            : `Activity in your "${rec.title}" workspace (${trigger}) needs a look.`,
          detail: [
            message ? `User: ${message}` : `Trigger: ${trigger}`,
            guidance ? `What you set up to do here: ${guidance}` : '',
            `Inspect the current state with space_get('${slug}').`,
            `If the user wants to change the DATA (better/different rows, a tighter filter, fewer/more fields, one row per entity), edit the data runner then call space_refresh('${slug}') and report the new row count — do NOT say it's done while the surface still shows the old data. For layout/copy tweaks use space_edit_view.`,
          ].filter(Boolean).join('\n\n'),
        },
        {
          originSessionId: spaceSessionId(slug),
          sourceLabel: 'workspace',
          sourceId: `${slug}:${actionId}`,
          title: rec.title,
          statusHint: `space_get('${slug}')`,
        },
      );
      res.status(202).json({ ok: true, reengaged: true, sessionId: spaceSessionId(slug) });
    } catch (err) {
      res.status(202).json({ ok: true, reengaged: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Quiet helper so a stray directory under SPACES_DIR never 500s the list.
  void resolveSpaceDir;
}
