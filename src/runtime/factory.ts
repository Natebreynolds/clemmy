import pino from 'pino';
import { AUTH_MODE } from '../config.js';
import { CodexNativeRuntime } from './codex-native-runtime.js';
import { OpenAIRuntime } from './openai.js';
import type { AgentRuntime } from './provider.js';
import { getAuthStatus } from './auth-store.js';

const logger = pino({ name: 'clementine-next.runtime-factory' });

/**
 * Missing credentials must DEGRADE the boot, never kill it. The old throw
 * here crash-looped the whole daemon when AUTH_MODE named an OAuth mode but
 * the grant was absent (dismissed browser dance, revoked shared-family token)
 * — a brand-new user's first relaunch died with "Clementine couldn't start
 * the daemon" and a log path (live report 2026-07-16). Booting unconfigured
 * is honest: the console, notifications, and every agent call surface the
 * re-authenticate path, and Settings → Re-authenticate fixes it in place.
 */
export function createRuntimeFromConfig(): AgentRuntime {
  if (AUTH_MODE === 'api_key') {
    return new OpenAIRuntime();
  }

  const status = getAuthStatus();
  if (!status.configured) {
    logger.warn({ authMode: AUTH_MODE }, `AUTH_MODE=${AUTH_MODE} selected but no credentials are configured — booting degraded. ${status.message}`);
  }
  return new CodexNativeRuntime();
}
