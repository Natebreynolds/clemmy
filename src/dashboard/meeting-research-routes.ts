import type { Express, Request } from 'express';
import { z } from 'zod';
import { meetingDocuments } from '../integrations/recall/meeting-documents.js';
import { meetingResearch, requestMeetingResearch, projectMeetingResearchSnapshot } from '../integrations/recall/meeting-research-service.js';
import { setMeetingAssistance, requestMeetingAssistanceCheck } from '../integrations/recall/meeting-assistance.js';

const reference = z.object({ id: z.string().min(1).max(200), revision: z.number().int().positive(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const setting = z.object({ expectedVersion: z.number().int().nonnegative(), enabled: z.boolean(), useMemory: z.boolean(),
  maxLookups: z.number().int().min(1).max(8), documentRefs: z.array(reference).max(8) }).strict();
const empty = z.object({}).strict();

/** Every route authenticates before opening state. Polling is passive. Only a
 * saved owner permission or retained final transcript can schedule research. */
export function registerMeetingResearchRoutes(app: Express, authorized: (req: Request) => boolean): void {
  const base = '/api/console/meetings/:id';
  app.get(`${base}/research`, async (req, res) => {
    if (!authorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { res.json(await projectMeetingResearchSnapshot(meetingResearch.get(req.params.id))); }
    catch { res.status(409).json({ error: 'Research permission couldn’t be loaded. Reopen this meeting and try again.' }); }
  });
  app.patch(`${base}/research`, async (req, res) => {
    if (!authorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const input = setting.safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Choose the sources and limit for private research.' }); return; }
    try {
      const state = meetingResearch.set(req.params.id, input.data);
      if (input.data.enabled) {
        // Choosing automatic research explicitly opts into its suggestion scan.
        // A disabled/failed scan never fabricates a researched answer.
        setMeetingAssistance(req.params.id, { enabled: true });
        requestMeetingAssistanceCheck(req.params.id);
      }
      requestMeetingResearch(req.params.id);
      res.json(await projectMeetingResearchSnapshot(state));
    } catch { res.status(409).json({ error: 'This meeting or its sources changed. Refresh, choose the current sources and save again.' }); }
  });
  app.post(`${base}/research/stop`, async (req, res) => {
    if (!authorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (!empty.safeParse(req.body === undefined ? {} : req.body).success) { res.status(400).json({ error: 'No research input is needed to pause.' }); return; }
    try { res.json(await projectMeetingResearchSnapshot(meetingResearch.stop(req.params.id))); }
    catch { res.status(409).json({ error: 'Research pause couldn’t be confirmed. Refresh this meeting to check its state.' }); }
  });
  app.get(`${base}/documents`, (req, res) => {
    if (!authorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { res.json(meetingDocuments.getMeetingDocuments(req.params.id)); }
    catch { res.status(409).json({ error: 'Meeting context couldn’t be loaded. Reopen the meeting and try again.' }); }
  });
  app.post(`${base}/documents`, (req, res) => {
    if (!authorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const state = meetingDocuments.attachMeetingDocument(req.params.id, req.body);
      requestMeetingResearch(req.params.id); res.json(state);
    } catch { res.status(409).json({ error: 'Meeting context changed or was too large. Refresh before saving your note again.' }); }
  });
  app.delete(`${base}/documents/:documentId`, (req, res) => {
    if (!authorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const input = z.object({ expectedVersion: z.number().int().nonnegative(), captureDigest: z.string().regex(/^[a-f0-9]{64}$/),
      revision: z.number().int().positive() }).strict().safeParse(req.body);
    if (!input.success) { res.status(400).json({ error: 'Refresh this meeting before removing a note.' }); return; }
    try {
      const state = meetingDocuments.removeMeetingDocument(req.params.id, { ...input.data, id: req.params.documentId });
      requestMeetingResearch(req.params.id); res.json(state);
    } catch { res.status(409).json({ error: 'This note changed. Refresh the meeting before removing it.' }); }
  });
}
