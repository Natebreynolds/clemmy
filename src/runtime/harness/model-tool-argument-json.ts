/** Decode a model's complete tool-argument object. A literal control character
 * inside an otherwise valid JSON string has one lossless encoding: its Unicode
 * escape. Accept that spelling without making the model regenerate long text.
 * Never infer quotes, delimiters, missing content, or values. The tool's normal
 * schema and authority checks still consume the decoded object. Callers retain
 * the original model bytes separately from materialized invocation bytes. */
export function parseModelToolArgumentObject(raw: string): Record<string, unknown> | null {
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null;
  try { return object(JSON.parse(raw)); } catch { /* Try only string controls. */ }

  let inString = false;
  let escaped = false;
  let changed = false;
  let start = 0;
  const parts: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (escaped) { escaped = false; continue; }
    if (inString && char === '\\') { escaped = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    const code = raw.charCodeAt(index);
    if (inString && code < 0x20) {
      parts.push(raw.slice(start, index), `\\u${code.toString(16).padStart(4, '0')}`);
      start = index + 1;
      changed = true;
    }
  }
  if (!changed) return null;
  parts.push(raw.slice(start));
  try { return object(JSON.parse(parts.join(''))); } catch { return null; }
}
