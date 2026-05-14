import type { Express, Request } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { renderConsoleHtml } from './console.js';
import { WEBHOOK_SECRET } from '../config.js';
import { recallHybrid } from '../memory/recall.js';
import { forgetFact, listActiveFacts, listAllFacts } from '../memory/facts.js';
import { openMemoryDb } from '../memory/db.js';
import { readMemoryIndexStatus } from '../memory/indexer.js';

/**
 * Mounts the new Console dashboard at /console.
 *
 * The existing /dashboard route in webhook.ts is left untouched —
 * Run Control Center keeps working. /console is the new parallel
 * surface with its own visual language, growing toward the goal of
 * "manage your agent, workflows, skills, and all local/external tools."
 *
 * Auth piggy-backs on the same isAuthorized check the rest of the
 * dashboard routes use. Future console-specific endpoints (workflow
 * studio chat, project picker actions, etc.) register here too.
 */
export function registerConsoleRoutes(
  app: Express,
  isAuthorized: (req: Request) => boolean,
): void {
  app.get('/console', (req, res) => {
    if (!isAuthorized(req)) {
      res.status(401).send('Unauthorized');
      return;
    }
    const queryToken = typeof req.query.token === 'string' ? req.query.token : WEBHOOK_SECRET;
    res.type('html').send(renderConsoleHtml(queryToken));
  });

  // ─── Console-specific API namespace ───────────────────────────────
  //
  // Routes under /api/console/* support the console panels. We avoid
  // touching the existing /api/* routes the dashboard already uses.

  /**
   * Search the vault via the existing recall layer (FTS + optional
   * embedding rerank). Returns hits in the same shape as MemorySearchHit
   * so the panel renderer stays simple.
   */
  app.get('/api/console/memory/search', async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.max(1, Math.min(20, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '10', 10) || 10));
    if (!query) { res.json({ query: '', hits: [] }); return; }
    try {
      const hits = await recallHybrid(query, { limit });
      res.json({ query, hits });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * List durable facts. ?kind=user|project|feedback|reference filters.
   * Defaults to active only; ?includeInactive=1 includes soft-deleted.
   */
  app.get('/api/console/memory/facts', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const kindRaw = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const allowedKinds = new Set(['user', 'project', 'feedback', 'reference']);
    const kind = kindRaw && allowedKinds.has(kindRaw) ? kindRaw as 'user' | 'project' | 'feedback' | 'reference' : undefined;
    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    const limit = Math.max(1, Math.min(200, parseInt(typeof req.query.limit === 'string' ? req.query.limit : '60', 10) || 60));
    try {
      const facts = includeInactive
        ? listAllFacts(limit).filter((f) => !kind || f.kind === kind)
        : listActiveFacts({ kind, limit });
      res.json({ facts });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Soft-delete a fact (sets active=0). Used by the panel's forget button.
   * Hard delete intentionally not exposed here — that lives in MCP tools
   * for the agent itself.
   */
  app.post('/api/console/memory/facts/:id/forget', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: 'invalid id' }); return; }
    try {
      const ok = forgetFact(id);
      res.json({ ok });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * List indexed vault files with chunk counts + last index time. The
   * panel renders this as a browsable file tree on the left side.
   */
  app.get('/api/console/memory/files', (_req, res) => {
    try {
      const db = openMemoryDb();
      const rows = db.prepare(`
        SELECT
          path,
          COUNT(*) AS chunks,
          MAX(mtime) AS mtime,
          MAX(byte_size) AS byteSize
        FROM vault_chunks
        GROUP BY path
        ORDER BY MAX(mtime) DESC
      `).all() as Array<{ path: string; chunks: number; mtime: number; byteSize: number }>;
      const status = readMemoryIndexStatus();
      res.json({ files: rows, status });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Fetch the chunks for a single file, optionally with full content.
   * Used by the panel's file inspector.
   */
  app.get('/api/console/memory/file', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
    try {
      const db = openMemoryDb();
      const chunks = db.prepare(`
        SELECT id, chunk_index AS chunkIndex, title, content, mtime, byte_size AS byteSize
        FROM vault_chunks WHERE path = ?
        ORDER BY chunk_index ASC
      `).all(filePath) as Array<{ id: number; chunkIndex: number; title: string | null; content: string; mtime: number; byteSize: number }>;

      let rawContent: string | undefined;
      if (existsSync(filePath)) {
        try { rawContent = readFileSync(filePath, 'utf-8').slice(0, 50_000); }
        catch { rawContent = undefined; }
      }

      res.json({ path: filePath, chunks, rawContent });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
