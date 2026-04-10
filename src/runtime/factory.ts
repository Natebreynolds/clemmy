import { AUTH_MODE } from '../config.js';
import { CodexCliRuntime } from './codex-cli.js';
import { OpenAIRuntime } from './openai.js';
import type { AgentRuntime } from './provider.js';
import { getAuthStatus } from './auth-store.js';

export function createRuntimeFromConfig(): AgentRuntime {
  if (AUTH_MODE === 'api_key') {
    return new OpenAIRuntime();
  }

  const status = getAuthStatus();
  if (!status.configured) {
    throw new Error([`AUTH_MODE=${AUTH_MODE} is selected.`, status.message].join(' '));
  }
  return new CodexCliRuntime();
}
