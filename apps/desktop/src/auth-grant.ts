/**
 * Electron-free check: does CLEMENTINE'S OWN auth store hold a complete Codex
 * grant right now? Mirrors the daemon's getAuthStatus().configured predicate
 * (accessToken AND refreshToken in state/auth.json — the Codex CLI
 * compatibility file deliberately does NOT count).
 *
 * setup-complete uses this to verify a sign-in actually persisted before
 * committing AUTH_MODE=codex_oauth: writing the mode on the renderer's word
 * alone shipped users whose OAuth dance failed into a daemon that refused to
 * boot on every launch (live user report, 2026-07-16).
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function localAuthFile(): string {
  const base = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
  return path.join(base, 'state', 'auth.json');
}

export function hasPersistedCodexGrant(): boolean {
  const filePath = localAuthFile();
  if (!existsSync(filePath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown> | null;
    const codexOauth = parsed?.codexOauth && typeof parsed.codexOauth === 'object'
      ? parsed.codexOauth as Record<string, unknown>
      : null;
    return Boolean(
      codexOauth
      && typeof codexOauth.accessToken === 'string' && codexOauth.accessToken
      && typeof codexOauth.refreshToken === 'string' && codexOauth.refreshToken,
    );
  } catch {
    return false;
  }
}
