import type { Express, Request } from 'express';
import { readTaskHandlingDetails } from './task-handling-read.js';
import { readTaskMemoryStatus } from './task-memory-status-read.js';

/** Lazy task details: exact identity required, no latest-session fallback. */
export function registerConsoleTaskHandlingRoutes(app: Express, deps: { isAuthorized: (req: Request) => boolean }): void {
  // Only the original typed memory-work hint causes the client to poll this
  // lightweight reader. It does not fetch full model/tool activity per reply.
  app.get('/api/console/sessions/:id/memory-status', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!deps.isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const sessionId = String(req.params.id ?? '').trim();
    const raw = typeof req.query.sourceUserSeq === 'string' ? req.query.sourceUserSeq : '';
    const sourceUserSeq = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!sessionId || sessionId.length > 256 || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) {
      res.status(400).json({ error: 'An exact accepted request is required.' }); return;
    }
    try {
      const status = readTaskMemoryStatus({ sessionId, sourceUserSeq });
      if (!status) { res.status(404).json({ error: 'No retained accepted request was found.' }); return; }
      res.json(status);
    } catch { res.status(500).json({ error: 'Memory status is temporarily unavailable.' }); }
  });
  app.get('/api/console/sessions/:id/handling', (req, res) => {
    if (!deps.isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const sessionId = String(req.params.id ?? '').trim();
    const raw = typeof req.query.sourceUserSeq === 'string' ? req.query.sourceUserSeq : '';
    const sourceUserSeq = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!sessionId || sessionId.length > 256 || !Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) {
      res.status(400).json({ error: 'An exact accepted request is required.' }); return;
    }
    try {
      const details = readTaskHandlingDetails({ sessionId, sourceUserSeq });
      if (!details) { res.status(404).json({ error: 'No retained accepted request was found.' }); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.json(details);
    } catch {
      // Never serialize a raw persistence error that could contain file paths
      // or request content. Existing UI detail errors are independently retryable.
      res.status(500).json({ error: 'Task details are temporarily unavailable.' });
    }
  });
}
