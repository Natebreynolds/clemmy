import type { Request, RequestHandler, Response, Router } from 'express';
import {
  bustComposioDashboardCaches,
  credentialModeFor,
  getToolkitDetail,
  isRedirectableToolkitAuthScheme,
  oauthAppSetupFor,
  prepareInAppToolkitConnection,
  selectToolkitCredentialValues,
  setupCredentialToolkit,
  setupCustomOAuthToolkit,
  setupMetaForMode,
} from '../integrations/composio/client.js';
import {
  readConnectionSetup,
  recordConnectionSetupResult,
  requireConnectionSetupContext,
  verifyConnectionSetup,
  type ConnectionSetupContext,
} from '../runtime/harness/connection-setup.js';

export interface ConnectionSetupRouteDependencies {
  prepareConnection: typeof prepareInAppToolkitConnection;
  getDetail: typeof getToolkitDetail;
  setupCredentials: typeof setupCredentialToolkit;
  setupOAuthApp: typeof setupCustomOAuthToolkit;
  invalidate: typeof bustComposioDashboardCaches;
  verify: typeof verifyConnectionSetup;
}

interface ConnectionSetupRouteOptions {
  /** Mobile may only connect the toolkit needed by an existing parked task. */
  requireContext?: boolean;
  /** Desktop retains its previous API-key alias when adopting these handlers. */
  includeLegacyCredentialAlias?: boolean;
  dependencies?: Partial<ConnectionSetupRouteDependencies>;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

/** Shared desktop/mobile setup handlers. The caller supplies its existing auth
 * middleware; this module never upgrades a cookie or accepts a provider account
 * id from a browser. Credential values and raw provider errors are neither
 * logged nor appended to conversation events. */
export function registerConnectionSetupRoutes(
  router: Pick<Router, 'get' | 'post'>,
  guard: RequestHandler,
  prefix: string,
  options: ConnectionSetupRouteOptions = {},
): void {
  const deps: ConnectionSetupRouteDependencies = {
    prepareConnection: prepareInAppToolkitConnection,
    getDetail: getToolkitDetail,
    setupCredentials: setupCredentialToolkit,
    setupOAuthApp: setupCustomOAuthToolkit,
    invalidate: bustComposioDashboardCaches,
    verify: verifyConnectionSetup,
    ...options.dependencies,
  };
  const noStore: RequestHandler = (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  // A wrapper keeps "no context, permitted on desktop" distinct from rejection.
  const contextFor = (req: Request, res: Response, slug: string): { context?: ConnectionSetupContext } | null => {
    try {
      const context = requireConnectionSetupContext(req.body, slug);
      if (options.requireContext && !context) {
        res.status(400).json({ error: 'Open this connection from the conversation that needs it.' });
        return null;
      }
      return { context };
    } catch {
      res.status(409).json({ error: 'This connection no longer belongs to the current task. Return to the conversation.' });
      return null;
    }
  };
  const failed = (res: Response, slug: string) => {
    // Even a provider error that echoes a submitted secret must stay private.
    res.status(500).json({ error: 'Couldn’t connect this app. Check the details and try again.', toolkit: slug });
  };
  const slugFor = (req: Request): string => String(req.params.slug ?? '');

  router.get(`${prefix}/connection-requests`, guard, noStore, (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    res.json({ request: sessionId ? readConnectionSetup(sessionId) : null });
  });

  router.post(`${prefix}/connection-requests/:requestId/verify`, guard, noStore, async (req, res) => {
    const sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : '';
    const connectionRequestId = String(req.params.requestId ?? '');
    if (options.requireContext && !readConnectionSetup(sessionId, connectionRequestId)) {
      res.status(409).json({ error: 'This connection no longer belongs to the current task. Return to the conversation.' });
      return;
    }
    try {
      const { request, ready, connectionVerified } = await deps.verify({ sessionId, connectionRequestId });
      // The accepted-source admission snapshot stays server-side. Browsers
      // receive status and the host continuation key, never an admission proof.
      res.json({ request, ready, ...(connectionVerified ? { connectionVerified } : {}) });
    } catch {
      res.status(503).json({ error: 'Couldn’t verify this connection. Your task is still paused. Try again.' });
    }
  });

  router.post(`${prefix}/composio/toolkits/:slug/authorize`, guard, noStore, async (req, res) => {
    const slug = slugFor(req);
    const bound = contextFor(req, res, slug);
    if (!bound) return;
    try {
      const authorized = await deps.prepareConnection(slug, undefined, stringRecord(req.body?.details));
      recordConnectionSetupResult(bound.context, authorized);
      deps.invalidate();
      res.json(authorized);
    } catch { failed(res, slug); }
  });

  router.post(`${prefix}/composio/toolkits/:slug/oauth-app`, guard, noStore, async (req, res) => {
    const slug = slugFor(req);
    const bound = contextFor(req, res, slug);
    if (!bound) return;
    try {
      const detail = await deps.getDetail(slug);
      if (!detail) {
        res.status(404).json({ error: 'Composio has no record of this app, or your Composio key is missing.' });
        return;
      }
      const wanted = typeof req.body?.authScheme === 'string' ? req.body.authScheme.toUpperCase() : '';
      const mode = detail.modes.find((entry) => entry.mode === wanted && isRedirectableToolkitAuthScheme(entry.mode))
        ?? detail.modes.find((entry) => isRedirectableToolkitAuthScheme(entry.mode));
      if (!mode) {
        res.status(400).json({ error: `${detail.name} has no sign-in that uses a developer app.` });
        return;
      }
      const app = oauthAppSetupFor(detail, mode.mode);
      const creationFields = app.fields.filter((field) => !/redirect/i.test(field.name));
      const { credentials, missing } = selectToolkitCredentialValues(
        { ...setupMetaForMode(detail, mode.mode), fields: creationFields },
        stringRecord(req.body?.credentials) ?? {},
      );
      if (missing.length > 0) {
        res.status(400).json({ error: `Missing ${missing.join(', ')}.` });
        return;
      }
      // Metadata can take time to arrive; do not start a credential mutation
      // for a contextual task that has already been replaced while awaiting it.
      if (bound.context && !contextFor(req, res, slug)) return;
      await deps.setupOAuthApp(slug, mode.mode, credentials, app.callbackUrl);
      if (bound.context && !contextFor(req, res, slug)) return;
      const authorized = await deps.prepareConnection(slug, undefined, stringRecord(req.body?.details));
      recordConnectionSetupResult(bound.context, authorized);
      deps.invalidate();
      res.json(authorized);
    } catch { failed(res, slug); }
  });

  const setupCredentials: RequestHandler = async (req, res) => {
    const slug = slugFor(req);
    const bound = contextFor(req, res, slug);
    if (!bound) return;
    try {
      const detail = await deps.getDetail(slug);
      if (!detail) {
        res.status(404).json({ error: 'toolkit not found or Composio not configured' });
        return;
      }
      const mode = credentialModeFor(detail, typeof req.body?.authScheme === 'string' ? req.body.authScheme : undefined);
      if (!mode) {
        res.status(400).json({ error: `${detail.name} signs in through its own page, not with a key; use Connect instead.` });
        return;
      }
      const setup = setupMetaForMode(detail, mode);
      const submitted: Record<string, unknown> = stringRecord(req.body?.credentials) ?? {};
      // Retain the existing desktop API-key body when using the shared handler.
      if (typeof req.body?.apiKey === 'string') submitted.generic_api_key = req.body.apiKey;
      if (typeof req.body?.baseUrl === 'string') submitted.base_url = req.body.baseUrl;
      const { credentials, missing } = selectToolkitCredentialValues(setup, submitted);
      if (missing.length > 0) {
        res.status(400).json({ error: `Missing required credential field${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}` });
        return;
      }
      if (bound.context && !contextFor(req, res, slug)) return;
      const result = await deps.setupCredentials(slug, setup.authScheme, credentials);
      recordConnectionSetupResult(bound.context, result);
      deps.invalidate();
      res.json(result);
    } catch { failed(res, slug); }
  };
  router.post(`${prefix}/composio/toolkits/:slug/setup-credentials`, guard, noStore, setupCredentials);
  if (options.includeLegacyCredentialAlias) {
    router.post(`${prefix}/composio/toolkits/:slug/setup-api-key`, guard, noStore, setupCredentials);
  }
}
