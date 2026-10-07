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
import { CredentialStoragePrivacyError, readCredentialFileSync } from './credential-private-filesystem.js';

function localAuthFile(): string {
  const base = process.env.CLEMENTINE_HOME || path.join(os.homedir(), '.clementine-next');
  return path.join(base, 'state', 'auth.json');
}

export function hasPersistedCodexGrant(): boolean {
  const filePath = localAuthFile();
  if (process.platform !== 'win32' && !existsSync(filePath)) return false;
  try {
    const raw = process.platform === 'win32' ? readCredentialFileSync(filePath) : readFileSync(filePath, 'utf-8');
    if (raw === undefined) return false;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (process.platform === 'win32' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || (parsed.codexOauth !== undefined && (!parsed.codexOauth || typeof parsed.codexOauth !== 'object' || Array.isArray(parsed.codexOauth))))) throw new CredentialStoragePrivacyError();
    const codexOauth = parsed?.codexOauth && typeof parsed.codexOauth === 'object'
      ? parsed.codexOauth as Record<string, unknown>
      : null;
    if (process.platform === 'win32' && codexOauth && ['accessToken', 'refreshToken', 'idToken', 'accountId', 'lastRefresh'].some(key =>
      codexOauth[key] !== undefined && typeof codexOauth[key] !== 'string')) throw new CredentialStoragePrivacyError();
    return Boolean(
      codexOauth
      && typeof codexOauth.accessToken === 'string' && codexOauth.accessToken
      && typeof codexOauth.refreshToken === 'string' && codexOauth.refreshToken,
    );
  } catch (cause) {
    if (process.platform === 'win32') throw new CredentialStoragePrivacyError(cause);
    return false;
  }
}
