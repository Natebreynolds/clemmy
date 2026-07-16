import { AUTH_MODE } from '../config.js';
import { CodexNativeRuntime } from './codex-native-runtime.js';
import { OpenAIRuntime } from './openai.js';
import type { AgentRuntime } from './provider.js';
import { getAuthStatus } from './auth-store.js';

export function createRuntimeFromConfig(): AgentRuntime {
  if (AUTH_MODE === 'api_key') {
    return new OpenAIRuntime();
  }

  const status = getAuthStatus();
  // A revoked independent grant or disabled legacy/CLI-linked grant cannot make
  // model calls, but an upgraded daemon/dashboard must still boot so the user
  // can reach Settings and mint a replacement grant. The auth store never hands
  // either token to a runtime; every truly never-configured state remains a
  // startup error and follows the normal setup path.
  const recoveryShellAllowed = status.mode === 'codex_oauth' && status.codexRecoveryRequired === true;
  if (!status.configured && !recoveryShellAllowed) {
    throw new Error([`AUTH_MODE=${AUTH_MODE} is selected.`, status.message].join(' '));
  }
  return new CodexNativeRuntime();
}
