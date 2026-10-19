import type { Express, Request } from 'express';
import { MeetingAssistantPolicyError, meetingAssistantPolicySnapshot, saveMeetingAssistantPolicy } from '../integrations/recall/meeting-assistant-policy.js';
import { meetingPreparationReadiness } from '../agents/noticing-runtime.js';

/** Passive reads; an explicit preferences write never starts capture, changes
 * global model roles, reads a calendar, or grants meeting research permission. */
export function registerMeetingAssistantPolicyRoutes(app: Express, isAuthorized: (request: Request) => boolean,
  ports: { snapshot: typeof meetingAssistantPolicySnapshot; save: typeof saveMeetingAssistantPolicy;
    preparation?: typeof meetingPreparationReadiness } = {
    snapshot: meetingAssistantPolicySnapshot, save: saveMeetingAssistantPolicy, preparation: meetingPreparationReadiness,
  }): void {
  const project = () => {
    const policy = ports.snapshot();
    if (!ports.preparation) return policy;
    try { return { ...policy, preparation: ports.preparation() }; }
    catch { return { ...policy, preparation: { state: 'unavailable', message: 'Calendar preparation could not be checked. Your saved choices are kept.' } }; }
  };
  app.get('/api/console/meetings/policy', (request, response) => {
    if (!isAuthorized(request)) { response.status(401).json({ error: 'unauthorized' }); return; }
    try { response.json(project()); }
    catch { response.status(503).json({ error: 'Meeting preferences could not be loaded. Your saved choices have been kept.' }); }
  });
  app.patch('/api/console/meetings/policy', (request, response) => {
    if (!isAuthorized(request)) { response.status(401).json({ error: 'unauthorized' }); return; }
    try { ports.save(request.body); response.json(project()); }
    catch (error) {
      const code = error instanceof MeetingAssistantPolicyError ? error.code : 'unavailable';
      response.status(code === 'conflict' ? 409 : code === 'invalid' || code === 'model_unavailable' ? 400 : 503)
        .json({ error: error instanceof MeetingAssistantPolicyError ? error.message : 'Meeting preferences could not be saved. Try again shortly.' });
    }
  });
}
