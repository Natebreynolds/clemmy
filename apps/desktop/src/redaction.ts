export function redactSensitiveText(input: unknown): string {
  let text = typeof input === 'string' ? input : String(input ?? '');
  if (!text) return text;
  text = text.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, (match) => `${match.slice(0, 10)}...REDACTED`);
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED]');
  text = text.replace(/\bBot\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bot [REDACTED]');
  text = text.replace(/([?&](?:token|access_token|refresh_token|api_key|secret)=)[^&#\s"']+/gi, '$1[REDACTED]');
  text = text.replace(
    /((?:OPENAI|COMPOSIO|DISCORD|WEBHOOK|RECALL|CODEX|MCP|AUTH)[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|AUTH)\s*[=:]\s*)("[^"]+"|'[^']+'|\S+)/gi,
    '$1[REDACTED]',
  );
  return text;
}
