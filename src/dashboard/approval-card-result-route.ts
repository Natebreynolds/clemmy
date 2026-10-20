/** Shared transport handler: caller supplies the surface's existing auth gate. */
import type { RequestHandler } from 'express';

export const handleApprovalCardResultRead: RequestHandler = async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const allowed = new Set(['sessionId', 'pendingActionId', 'payloadHash', 'recordUpdatedAt']);
  if (Object.keys(req.query).some(key => !allowed.has(key))) {
    res.status(400).json({ error: 'approval_result_query_invalid' }); return;
  }
  try {
    const [{ readApprovalCardResultSnapshot }, { readPendingActionPublicResult }] = await Promise.all([
      import('../runtime/harness/approval-card-result-reader.js'),
      import('../runtime/harness/pending-action-result-reader.js'),
    ]);
    const result = readApprovalCardResultSnapshot({ approvalId: req.params.id, sessionId: req.query.sessionId,
      ...(req.query.pendingActionId !== undefined ? { pendingActionId: req.query.pendingActionId } : {}),
      ...(req.query.payloadHash !== undefined ? { payloadHash: req.query.payloadHash } : {}),
      ...(req.query.recordUpdatedAt !== undefined ? { recordUpdatedAt: req.query.recordUpdatedAt } : {}) }, readPendingActionPublicResult);
    if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
    res.json(result.value);
  } catch { res.status(503).json({ error: 'approval_result_unavailable' }); }
};
