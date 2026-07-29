import path from 'node:path';

const SECRET_NAME_RE = /\b(?:OPENAI|COMPOSIO|DISCORD|WEBHOOK|RECALL|CODEX|AUTH|API|BEARER|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN)[A-Z0-9_/-]*\b|^MCP_(?:HEADERS?|ENV|.*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH))$/i;
const SECRET_PATH_BASENAMES = new Set([
  '.env',
  'auth.json',
  'secrets-vault.json',
  'secrets-meta.json',
  'claude_desktop_config.json',
]);
const OPERATOR_AUTHORITY_PATH_BASENAMES = new Set([
  // This file contains no credential, but changing it mints/revokes the
  // capability to write through a provider-side CLI default account. Generic
  // file/shell tools must therefore always surface a human approval instead of
  // changing it under an ordinary plan scope.
  'composio-cli-default-accounts.json',
]);

export function isPlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return true;
  return normalized === 'changeme'
    || normalized === 'change-me'
    || normalized === 'placeholder'
    || normalized === 'secret'
    || normalized === 'webhook_secret'
    || normalized.includes('replace_me')
    || normalized.includes('your_')
    || normalized.includes('example');
}

export function isStrongLocalSecret(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 24) return false;
  if (isPlaceholderSecret(trimmed)) return false;
  return /[A-Za-z]/.test(trimmed) && /[0-9_-]/.test(trimmed);
}

/**
 * Classify secret-bearing field names across snake_case, kebab-case, dotted,
 * spaced, and camelCase spellings. Values are intentionally irrelevant: a
 * provider can return a perfectly ordinary-looking credential that format
 * detectors cannot recognize.
 */
export function isSecretLikeKey(input: string): boolean {
  const normalized = String(input ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) return false;
  const words = new Set(normalized.split('_').filter(Boolean));
  if (
    words.has('token')
    || words.has('tokens')
    || words.has('secret')
    || words.has('secrets')
    || words.has('password')
    || words.has('passwords')
    || words.has('passwd')
    || words.has('credential')
    || words.has('credentials')
    || words.has('authorization')
    || words.has('bearer')
    || words.has('jwt')
    || words.has('cookie')
    || normalized === 'auth'
    || normalized === 'proxy_authorization'
    || normalized === 'set_cookie'
  ) {
    return true;
  }
  const joined = `_${normalized}_`;
  return joined.includes('_api_key_')
    || joined.includes('_private_key_')
    || joined.includes('_signing_key_')
    || joined.includes('_encryption_key_')
    || joined.includes('_access_key_')
    || normalized === 'x_api_key'
    || normalized === 'mcp_headers'
    || normalized === 'mcp_env';
}

function redactSecretAssignments(input: string): string {
  const redactQuoted = input.replace(
    /(["'])([^"'\r\n]{1,80})\1(\s*[:=]\s*)(["'])(.*?)\4/g,
    (match, keyQuote: string, key: string, separator: string, valueQuote: string) =>
      isSecretLikeKey(key)
        ? `${keyQuote}${key}${keyQuote}${separator}${valueQuote}[REDACTED]${valueQuote}`
        : match,
  );
  return redactQuoted.replace(
    /\b([A-Za-z][A-Za-z0-9_.-]{0,80})(\s*[:=]\s*)(?:(?:Bearer|Basic|Bot)\s+[A-Za-z0-9._~+/=-]+|"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    (match, key: string, separator: string) =>
      isSecretLikeKey(key) ? `${key}${separator}[REDACTED]` : match,
  );
}

export function redactSensitiveText(input: unknown): string {
  let text = typeof input === 'string' ? input : String(input ?? '');
  if (!text) return text;

  text = redactSecretAssignments(text);
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, (match) => `${match.slice(0, 10)}...REDACTED`);
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED]');
  text = text.replace(/\bBot\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bot [REDACTED]');
  text = text.replace(/([?&](?:token|access_token|refresh_token|api_key|secret)=)[^&#\s"']+/gi, '$1[REDACTED]');
  text = text.replace(/((?:Authorization|authorization)\s*[:=]\s*)(?:Bearer|Bot)?\s*[A-Za-z0-9._~+/=-]{12,}/g, '$1[REDACTED]');
  text = text.replace(
    /((?:OPENAI|COMPOSIO|DISCORD|WEBHOOK|RECALL|CODEX|MCP|AUTH)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)\s*[=:]\s*)("[^"]+"|'[^']+'|\S+)/gi,
    '$1[REDACTED]',
  );
  text = text.replace(
    /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|secret|password|token|headers?)"\s*:\s*)("[^"]+"|\{[^}]*\}|\[[^\]]*\])/gi,
    '$1"[REDACTED]"',
  );
  return text;
}

export function redactSensitiveValue<T>(value: T, depth = 0): T {
  if (depth > 6) return '[REDACTED]' as T;
  if (typeof value === 'string') return redactSensitiveText(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, depth + 1)) as T;
  if (!value || typeof value !== 'object') return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    redacted[key] = isSecretLikeKey(key) || SECRET_NAME_RE.test(key)
      ? '[REDACTED]'
      : redactSensitiveValue(item, depth + 1);
  }
  return redacted as T;
}

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const basename = path.basename(normalized).toLowerCase();
  if (
    SECRET_PATH_BASENAMES.has(basename)
    || OPERATOR_AUTHORITY_PATH_BASENAMES.has(basename)
  ) return true;
  return /(^|\/)\.codex\/auth\.json$/i.test(normalized)
    || /(^|\/)\.clementine-next\/mcp\/servers\.json$/i.test(normalized)
    || /(^|\/)\.clementine-next\/state\/secrets-[^/]+\.json$/i.test(normalized)
    || /(^|\/)(?:mcp|\.mcp)\/servers\.json$/i.test(normalized);
}

export function shellCommandTouchesSensitiveData(command: string): boolean {
  const normalized = command.toLowerCase();
  if (/\bsecurity\s+(dump-keychain|find-generic-password|find-internet-password|find-certificate)\b/.test(normalized)) {
    return true;
  }
  if (/\b(printenv|env)\b/.test(normalized) && SECRET_NAME_RE.test(command)) return true;
  if (/\b(openai|composio|discord|webhook|recall|codex|mcp)[a-z0-9_/-]*(key|token|secret|password)\b/i.test(command)) {
    return true;
  }
  if (/(^|[\s"'`/])(?:\.env|secrets-vault\.json|secrets-meta\.json|auth\.json|servers\.json|composio-cli-default-accounts\.json)(?=$|[\s"'`])/i.test(command)
    || /(?:^|[\s"'`])(?:~|\/[A-Za-z0-9_.-]+)?\/?\.clementine-next\/mcp\/servers\.json(?=$|[\s"'`])/i.test(command)) {
    return true;
  }
  return false;
}
