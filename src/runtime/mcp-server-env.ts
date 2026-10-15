import { readCredentialSourceFileSync } from './credential-private-filesystem.js';

export interface McpServerEnvSources {
  daemon: Readonly<Record<string, string | undefined>>;
  inherited: Readonly<Record<string, string | undefined>>;
}

export interface McpServerEnvStatus {
  declaredEnvKeys: string[];
  unsetEnvKeys: string[];
  /** Human entry can supply these declarations without replacing an inline value. */
  editableEnvKeys: string[];
}

interface ResolvedMcpServerEnv extends McpServerEnvStatus {
  values: Record<string, string>;
}

/** Add credential names without replacing existing inline human values or
 * losing legacy pass-through declarations when a definition is edited. */
export function declareMcpServerEnvKeys(raw: Record<string, string> | string[] | undefined,
  keys: string[]): Record<string, string> {
  const current = Array.isArray(raw)
    ? Object.fromEntries(raw.filter((key): key is string => typeof key === 'string').map(key => [key, '']))
    : raw ?? {};
  return { ...Object.fromEntries(keys.filter(key => !Object.hasOwn(current, key)).map(key => [key, ''])), ...current };
}

function declarations(raw: unknown): Array<[string, unknown]> {
  if (Array.isArray(raw)) return [...new Set(raw.filter((key): key is string => typeof key === 'string'))].map(key => [key, undefined]);
  return raw && typeof raw === 'object' ? Object.entries(raw) : [];
}

/** A blank declaration names the human-entered credential; it is not an empty
 * override. Keep status and the actual child/header values on the same source
 * order: nonempty inline value, daemon .env, then inherited process value.
 * An explicitly empty daemon value remains unset rather than selecting a
 * lower-priority credential. Only declared keys are copied from the daemon. */
export function resolveMcpServerEnv(raw: unknown, sources: McpServerEnvSources): ResolvedMcpServerEnv {
  const entries = declarations(raw);
  const values = Object.fromEntries(entries.map(([key, inline]) => {
    const daemon = Object.hasOwn(sources.daemon, key) ? sources.daemon[key] : undefined;
    const inherited = Object.hasOwn(sources.inherited, key) ? sources.inherited[key] : undefined;
    return [key, typeof inline === 'string' && inline.trim() ? inline : daemon ?? inherited ?? ''];
  }));
  return { values, declaredEnvKeys: entries.map(([key]) => key),
    unsetEnvKeys: entries.filter(([key]) => !values[key]?.trim()).map(([key]) => key),
    editableEnvKeys: entries.filter(([, inline]) => typeof inline !== 'string' || !inline.trim()).map(([key]) => key) };
}

/** One request's environment view, shared across server rows and overrides.
 * The private file stays unopened until a declaration needs it. Missing files
 * and failures are retained too, so one snapshot never retries a failed read
 * or silently selects a different credential. Create a new reader next request. */
export function createMcpServerEnvReader(daemonEnvFile: string,
  inherited: McpServerEnvSources['inherited'] = process.env,
  readText: (file: string) => string | undefined = readCredentialSourceFileSync,
): (raw: unknown) => ResolvedMcpServerEnv {
  const inheritedSnapshot = Object.fromEntries(Object.entries(inherited));
  let snapshot: { kind: 'read'; text: string | undefined } | { kind: 'failed'; error: unknown } | undefined;
  const readOnce = (file: string): string | undefined => {
    if (!snapshot) {
      try { snapshot = { kind: 'read', text: readText(file) }; }
      catch (error) { snapshot = { kind: 'failed', error }; }
    }
    if (snapshot.kind === 'failed') throw snapshot.error;
    return snapshot.text;
  };
  return raw => readMcpServerEnv(raw, daemonEnvFile, inheritedSnapshot, readOnce);
}

/** Same .env value syntax as config.ts:parseEnvText, including matched outer
 * quotes while preserving significant whitespace outside those quotes.
 * Injected reads let focused controls use synthetic inputs without opening any
 * credential file. A failed present-file read must not select another source. */
export function readMcpServerEnv(raw: unknown, daemonEnvFile: string,
  inherited: McpServerEnvSources['inherited'] = process.env,
  readText: (file: string) => string | undefined = readCredentialSourceFileSync,
): ResolvedMcpServerEnv {
  const entries = declarations(raw);
  const daemon: Record<string, string> = {};
  if (entries.some(([, inline]) => typeof inline !== 'string' || !inline.trim())) {
    const wanted = new Set(entries.map(([key]) => key));
    const text = readText(daemonEnvFile);
    for (const rawLine of text?.split('\n') ?? []) {
      const line = rawLine.replace(/^\s+|\r+$/g, '');
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf('=');
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim();
      let value = line.slice(separator + 1);
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (wanted.has(key)) Object.defineProperty(daemon, key, { value, enumerable: true, configurable: true });
    }
  }
  return resolveMcpServerEnv(raw, { daemon, inherited });
}
