import path from 'node:path';

const SECRET_NAME_RE = /\b(?:OPENAI|COMPOSIO|DISCORD|WEBHOOK|RECALL|CODEX|AUTH|API|BEARER|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_TOKEN|REFRESH_TOKEN)[A-Z0-9_/-]*\b|^MCP_(?:HEADERS?|ENV|.*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH))$/i;
const SECRET_PATH_BASENAMES = new Set([
  '.env',
  'auth.json',
  'secrets-vault.json',
  'secrets-meta.json',
  'claude_desktop_config.json',
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

export function redactSensitiveText(input: unknown): string {
  let text = typeof input === 'string' ? input : String(input ?? '');
  if (!text) return text;

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
    redacted[key] = SECRET_NAME_RE.test(key) ? '[REDACTED]' : redactSensitiveValue(item, depth + 1);
  }
  return redacted as T;
}

export function isSensitivePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const basename = path.basename(normalized).toLowerCase();
  if (SECRET_PATH_BASENAMES.has(basename)) return true;
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
  if (/(^|[\s"'`/])(?:\.env|secrets-vault\.json|secrets-meta\.json|auth\.json|servers\.json)(?=$|[\s"'`])/i.test(command)
    || /(?:^|[\s"'`])(?:~|\/[A-Za-z0-9_.-]+)?\/?\.clementine-next\/mcp\/servers\.json(?=$|[\s"'`])/i.test(command)) {
    return true;
  }
  return false;
}
