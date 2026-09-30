import type { IRouter, RequestHandler } from 'express';
import { controlWorkspaceSource, listWorkspaceSourceControls, WorkspaceSourceControlError } from '../spaces/workspace-source-controls.js';
import { isValidSpaceSlug, spaceStore } from '../spaces/store.js';

/** First-party controls only. The authored Workspace iframe bridge deliberately
 * exposes no command for these routes; each surface supplies its real auth. */
export function registerWorkspaceSourceControlRoutes(router: IRouter, prefix: string, authorize: RequestHandler): void {
  const validate: RequestHandler = (req, res, next) => {
    if (req.get('origin') === 'null') { res.status(403).json({ error: 'Open this source in Workspace details to manage its permission.' }); return; }
    const slug = String(req.params.id ?? '');
    if (!isValidSpaceSlug(slug) || !spaceStore.get(slug) || spaceStore.get(slug)?.status === 'archived') {
      res.status(404).json({ error: 'Workspace not found.' }); return;
    }
    next();
  };
  router.get(`${prefix}/:id/source-controls`, authorize, validate, (req, res) => {
    try { res.json({ sources: listWorkspaceSourceControls(String(req.params.id)) }); }
    catch (error) { res.status(error instanceof WorkspaceSourceControlError ? error.status : 500)
      .json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  router.post(`${prefix}/:id/source-controls/:sourceId`, authorize, validate, async (req, res) => {
    try { res.json(await controlWorkspaceSource(String(req.params.id), String(req.params.sourceId), req.body)); }
    catch (error) { res.status(error instanceof WorkspaceSourceControlError ? error.status : 500)
      .json({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
