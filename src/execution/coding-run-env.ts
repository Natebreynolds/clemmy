/**
 * The environment a delegated coding agent (and the host commands run in its
 * worktree) starts with.
 *
 * Built from an allow-list, never by copying the daemon's environment: the
 * daemon carries Clem's own Claude grant, provider API keys and its internal
 * control variables. A coding agent runs on its CLI's own sign-in — the one the
 * Connect screen shows — and must never bill an API key the user set for
 * something else.
 */
import { augmentPath } from '../runtime/spawn-env.js';

const PASSTHROUGH = new Set([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR',
  'LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ',
  'SSH_AUTH_SOCK', 'GPG_AGENT_INFO',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Where each CLI keeps its own sign-in and settings, when the user moved it.
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME',
  '__CF_USER_TEXT_ENCODING',
]);

const PASSTHROUGH_PREFIXES = ['LC_', 'XDG_'];

/** Never forwarded, even when a prefix above would admit them. */
const WITHHELD = /^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH|CLEMENTINE_|CLEMMY_|ELECTRON_|NODE_OPTIONS$)/;

export function buildCodingAgentEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || WITHHELD.test(key)) continue;
    if (PASSTHROUGH.has(key) || PASSTHROUGH_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  env.PATH = augmentPath(source.PATH);
  return env;
}
