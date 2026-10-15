import { readCredentialSourceFileSync, writeCredentialTextFileSync } from './credential-private-filesystem.js';

/** MCP access details use the same one-line .env grammar as their reader. */
export function validMcpCredentialInput(key: string, value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && Boolean(value.trim()) && !/[\r\n\0]/.test(value);
}

/** Replace every declaration of this exact key. The reader accepts indented
 * keys and uses the last declaration, so replacing only the first is not a
 * credential change. Outer quotes retain significant spaces and quote bytes. */
export function replaceMcpCredentialDeclaration(text: string, key: string, value: string): string {
  if (!validMcpCredentialInput(key, value)) throw new Error('The access detail is not a valid single-line value.');
  const replacement = `${key}="${value}"`;
  let replaced = false;
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s+|\r+$/g, '');
    const equal = line.indexOf('=');
    if (line && !line.startsWith('#') && equal >= 0 && line.slice(0, equal).trim() === key) {
      if (!replaced) lines.push(replacement);
      replaced = true;
    } else lines.push(raw);
  }
  if (!replaced) lines.push(replacement);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

/** Only the human credential route calls this. Keep the existing private-file
 * policy and mirror the running value only after persistence succeeds. */
export function writeMcpServerCredential(file: string, key: string, value: string,
  dependencies: {
    readText?: (file: string) => string | undefined;
    writeText?: (file: string, text: string, options: { expectedPrior: string | undefined }) => void;
    environment?: Record<string, string | undefined>;
  } = {}): void {
  if (!validMcpCredentialInput(key, value)) throw new Error('The access detail is not a valid single-line value.');
  const readText = dependencies.readText ?? readCredentialSourceFileSync;
  const writeText = dependencies.writeText ?? writeCredentialTextFileSync;
  const prior = readText(file);
  const next = replaceMcpCredentialDeclaration(prior ?? '', key, value);
  writeText(file, next, { expectedPrior: prior });
  Object.defineProperty(dependencies.environment ?? process.env, key,
    { value, enumerable: true, writable: true, configurable: true });
}
