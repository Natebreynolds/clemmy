/**
 * Serves the new React/Vite console SPA (apps/console-web) at /console,
 * behind the CLEMENTINE_CONSOLE_NEXT flag. Mirrors the static-serving +
 * SPA-fallback pattern in src/channels/mobile-routes.ts.
 *
 * Registered in webhook.ts *before* registerConsoleRoutes so, when the
 * flag is on, this answers GET /console (and client deep-links) while the
 * legacy string console stays reachable at /console-legacy. The
 * /console/vendor/* and /console/icon.png routes registered by
 * registerConsoleRoutes are left untouched — the fallback here defers to
 * them via next(). All /api/* handlers are unchanged; the SPA is a pure
 * consumer of the existing API.
 */
import type { Express, Request, Response, NextFunction } from 'express';
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PKG_DIR, getRuntimeEnv } from '../config.js';

/** True when the new React console should serve at /console.
 *
 * DEFAULT ON: the new console ships to everyone. The legacy console
 * remains served at /console-legacy regardless, and this is a kill-switch:
 * set CLEMENTINE_CONSOLE_NEXT to 0 / false / off / no (in
 * ~/.clementine-next/.env or the process env) to fall back to the legacy
 * console at /console. Reads process env AND ~/.clementine-next/.env via
 * getRuntimeEnv so it works however the daemon was launched. */
export function isConsoleNextEnabled(): boolean {
  const raw = getRuntimeEnv('CLEMENTINE_CONSOLE_NEXT', '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/** Locate the built console-web bundle. Returns null if not built yet. */
export function resolveConsoleDistDir(override?: string | null): string | null {
  if (override === null) return null;
  if (typeof override === 'string') {
    return existsSync(path.join(override, 'index.html')) ? override : null;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Dev/repo layout: PKG_DIR/apps/console-web/dist.
    path.join(PKG_DIR, 'apps', 'console-web', 'dist'),
    // Packaged Electron layout: alongside the daemon's dist.
    path.join(here, '..', '..', 'apps', 'console-web', 'dist'),
    path.join(here, '..', '..', '..', 'apps', 'console-web', 'dist'),
    // Override via env (useful in CI / custom packaging).
    process.env.CLEMENTINE_CONSOLE_WEB_DIST ?? '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/** Build the inline bootstrap <script> the SPA reads on boot. */
function bootstrapScript(token: string): string {
  // Escape `<` so the JSON can't break out of the surrounding <script>.
  const json = JSON.stringify({ token, flags: { memory3d: true } }).replace(/</g, '\\u003c');
  return `<script>window.__CLEM_BOOTSTRAP__=${json};</script>`;
}

function serveSpaIndex(distDir: string, req: Request, res: Response): void {
  const indexPath = path.join(distDir, 'index.html');
  if (!existsSync(indexPath)) {
    res.status(404).send('console-web not built');
    return;
  }
  const queryToken = typeof req.query.token === 'string' ? req.query.token : '';
  const html = readFileSync(indexPath, 'utf-8').replace('<!--CLEM_BOOTSTRAP-->', bootstrapScript(queryToken));
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.type('html').send(html);
}

export function registerConsoleSpaRoutes(
  app: Express,
  isAuthorized: (req: Request) => boolean,
  opts?: { distDir?: string | null },
): boolean {
  const distDir = resolveConsoleDistDir(opts?.distDir);
  if (!distDir) {
    // Not built — leave /console to the legacy handler so we never serve
    // a blank page. (Build with `npm run build:console-web`.)
    return false;
  }

  // 1. Hashed, immutable assets (JS/CSS/fonts). No secrets → no auth.
  app.use(
    '/console/assets',
    express.static(path.join(distDir, 'assets'), {
      index: false,
      fallthrough: true,
      immutable: true,
      maxAge: '1y',
    }),
  );

  // 2. The app entry. Auth-gated (the bootstrap carries the token).
  app.get('/console', (req, res) => {
    if (!isAuthorized(req)) { res.status(401).send('Unauthorized'); return; }
    serveSpaIndex(distDir, req, res);
  });

  // 3. Client-side deep links (/console/inbox, /console/memory, …).
  //    Defer asset/vendor/icon paths to their dedicated handlers.
  app.get('/console/*', (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET') { next(); return; }
    const sub = req.path.slice('/console/'.length);
    if (sub.startsWith('assets/') || sub.startsWith('vendor/') || sub === 'icon.png') {
      next();
      return;
    }
    const accepts = (req.headers.accept ?? '').toLowerCase();
    if (!accepts.includes('text/html') && accepts !== '*/*' && accepts !== '') {
      next();
      return;
    }
    if (!isAuthorized(req)) { res.status(401).send('Unauthorized'); return; }
    serveSpaIndex(distDir, req, res);
  });

  return true;
}
