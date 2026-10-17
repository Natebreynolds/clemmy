import type { Express, Request } from 'express';
import { z } from 'zod';
import {
  checkMeetingAssistance, decideMeetingAssistanceOffer, getMeetingAssistance,
  prepareMeetingLookup, readPreparedMeetingLookup, setMeetingAssistance, type PreparedMeetingLookup,
} from '../integrations/recall/meeting-assistance.js';

const toggle = z.object({ enabled: z.boolean(), expectedVersion: z.number().int().nonnegative().optional() }).strict();
const decision = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/), version: z.number().int().nonnegative(),
  decision: z.enum(['dismiss', 'defer', 'lookup']) }).strict();

/** Private, authenticated owner controls. GET never runs a model or resumes work. */
export function registerMeetingAssistanceRoutes(app: Express, isAuthorized: (req: Request) => boolean,
  options: { isLookupAccepted?: (packet: PreparedMeetingLookup) => boolean } = {}): void {
  const project = (id: string) => {
    const state = getMeetingAssistance(id);
    const accepted = (offer: (typeof state.recentOffers)[number]) => {
      if (!offer.lookup) return offer;
      let admitted: boolean | null = null;
      try {
        const packet = readPreparedMeetingLookup(id, offer.id, offer.digest, { acceptedReplay: true });
        admitted = options.isLookupAccepted?.(packet) ?? null;
      } catch { /* unknown acceptance is not success or failure */ }
      return { ...offer, lookup: { ...offer.lookup, accepted: admitted } };
    };
    return { ...state, ...(state.offer ? { offer: accepted(state.offer) } : {}), recentOffers: state.recentOffers.map(accepted), keptOffers: state.keptOffers.map(accepted) };
  };
  const base = '/api/console/meetings/:id/assistance';
  app.get(base, (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { res.json(project(req.params.id)); }
    catch { res.status(409).json({ error: 'Meeting assistance could not be loaded. Reopen the meeting to try again.' }); }
  });
  app.patch(base, (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const parsed = toggle.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Choose whether to enable meeting suggestions.' }); return; }
    try { res.json(setMeetingAssistance(req.params.id, parsed.data)); }
    catch { res.status(409).json({ error: 'This meeting changed. Refresh it before changing suggestions.' }); }
  });
  app.post(`${base}/check`, async (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (req.body !== undefined && !z.object({}).strict().safeParse(req.body).success) { res.status(400).json({ error: 'No transcript input is accepted here.' }); return; }
    try { res.json(await checkMeetingAssistance(req.params.id)); }
    catch { res.status(409).json({ error: 'Clem could not check this meeting. Your recording is unaffected.' }); }
  });
  app.post(`${base}/offers/:offerId`, (req, res) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    const parsed = decision.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Choose an action on the current suggestion.' }); return; }
    try {
      const { digest, version, decision: action } = parsed.data;
      if (action === 'lookup') {
        const lookup = prepareMeetingLookup(req.params.id, req.params.offerId, digest, { expectedVersion: version });
        res.json({ state: project(req.params.id), lookup });
      } else {
        res.json({ state: decideMeetingAssistanceOffer(req.params.id, req.params.offerId, digest,
          { decision: action, expectedVersion: version }) });
      }
    } catch { res.status(409).json({ error: 'This suggestion changed or expired. Refresh the meeting before choosing again.' }); }
  });
}
