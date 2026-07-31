import type { Express, Request, Response } from 'express';
import { licensePosture, type LicensePosture } from '../licensing/license-status.js';
import { tickLicense, type LicenseTickResult } from '../licensing/license-tick.js';
import { readSecret } from '../runtime/secrets/index.js';

/**
 * License status for the console.
 *
 * Read-only plus one explicit "check now". The key itself is never in a
 * response — only whether one is stored — because this endpoint is reachable
 * from the console and a key in a JSON body is a key in a browser's memory,
 * devtools, and history.
 *
 * Registered from registerConsoleRoutes so it shares the same auth gate.
 */

export interface ConsoleLicenseStatus extends LicensePosture {
  /** Whether a key is in the vault. Never the key. */
  hasKey: boolean;
  generatedAt: string;
}

async function hasStoredKey(): Promise<boolean> {
  try {
    return Boolean((await readSecret('license_key'))?.trim());
  } catch {
    // A locked or unavailable keychain is not "no key" in truth, but it is the
    // safe answer here: it never claims an activation that may not exist.
    return false;
  }
}

async function buildStatus(): Promise<ConsoleLicenseStatus> {
  const hasKey = await hasStoredKey();
  return {
    ...licensePosture({ hasKey }),
    hasKey,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * One forced check at a time.
 *
 * A double-clicked Refresh button would otherwise fire two activations at the
 * license server; callers that arrive mid-flight share the result instead.
 */
let inFlightRefresh: Promise<LicenseTickResult> | null = null;

function forceRefresh(): Promise<LicenseTickResult> {
  if (!inFlightRefresh) {
    inFlightRefresh = tickLicense({ force: true }).finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

export function registerConsoleLicenseRoutes(
  app: Express,
  isAuthorized: (req: Request) => boolean,
): void {
  app.get('/api/console/license', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      res.json(await buildStatus());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/console/license/refresh', async (req: Request, res: Response) => {
    if (!isAuthorized(req)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const tick = await forceRefresh();
      // Posture is re-read AFTER the tick so the response reflects what the
      // check just wrote, not what was cached before it.
      res.json({ ...(await buildStatus()), tick });
    } catch (err) {
      // A failed check must not read as a failed license. The status still
      // renders; only the attempt failed.
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
