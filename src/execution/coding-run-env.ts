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
const WINDOWS_ALLOWED_NAMES = new Map<string, string>();
for (const name of PASSTHROUGH) {
  if (!WINDOWS_ALLOWED_NAMES.has(name.toLowerCase())) WINDOWS_ALLOWED_NAMES.set(name.toLowerCase(), name);
}

// Windows process creation, native DLL loading and per-user CLI configuration
// need these OS values even though provider credentials remain withheld.
const WINDOWS_PASSTHROUGH = new Map([
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
].map((name) => [name.toLowerCase(), name]));

/** Never forwarded, even when a prefix above would admit them. */
const WITHHELD = /^(?:ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH|CLEMENTINE_|CLEMMY_|ELECTRON_|NODE_OPTIONS$)/;

export function buildCodingAgentEnv(source: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const checkedKey = platform === 'win32' ? key.toUpperCase() : key;
    if (typeof value !== 'string' || WITHHELD.test(checkedKey)) continue;
    if (platform === 'win32') {
      const windowsKey = WINDOWS_PASSTHROUGH.get(key.toLowerCase()) ?? WINDOWS_ALLOWED_NAMES.get(key.toLowerCase());
      if (windowsKey) env[windowsKey] = value;
      else if (PASSTHROUGH_PREFIXES.some(prefix => checkedKey.startsWith(prefix))) env[checkedKey] = value;
    } else if (PASSTHROUGH.has(key) || PASSTHROUGH_PREFIXES.some(prefix => key.startsWith(prefix))) env[key] = value;
  }
  const pathKey = platform === 'win32'
    ? Object.keys(source).find((key) => key.toLowerCase() === 'path')
    : 'PATH';
  env.PATH = augmentPath(pathKey ? source[pathKey] : undefined);
  return env;
}
