export type ChildEnvLayer = Readonly<Record<string, string | undefined>>;

interface EnvEntry { key: string; value: string }

/** Resolve aliases inside one Windows layer deterministically. Uppercase wins
 * when supplied; otherwise the last own spelling wins. A later layer always
 * takes precedence, including an explicitly empty value. */
function windowsLayer(layer: ChildEnvLayer): Map<string, EnvEntry> {
  const entries = new Map<string, EnvEntry>();
  for (const [key, value] of Object.entries(layer)) {
    if (typeof value !== 'string') continue;
    const identity = key.toUpperCase();
    const previous = entries.get(identity);
    if (previous?.key === identity && key !== identity) continue;
    entries.set(identity, { key, value });
  }
  return entries;
}

/** Read one own environment value with the same alias policy as child merges.
 * Does not load process.env, credential files, or prototype values. */
export function childEnvValue(layer: ChildEnvLayer, name: string,
  platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === 'win32') {
    const identity = name.toUpperCase();
    let value: string | undefined;
    for (const [key, candidate] of Object.entries(layer)) {
      if (key.toUpperCase() !== identity || typeof candidate !== 'string') continue;
      if (key === identity) return candidate;
      value = candidate;
    }
    return value;
  }
  return Object.hasOwn(layer, name) && typeof layer[name] === 'string' ? layer[name] : undefined;
}

/** Merge already-selected child environment layers without granting any new
 * environment access. Windows receives one key per case-insensitive name and
 * an uppercase PATH for SDKs that prepend that spelling. POSIX names remain
 * distinct. Inputs and significant/empty values are preserved. */
export function mergeChildEnvLayers(layers: readonly ChildEnvLayer[],
  platform: NodeJS.Platform = process.platform): Record<string, string> {
  if (platform !== 'win32') return Object.fromEntries(layers.flatMap(layer =>
    Object.entries(layer).filter((entry): entry is [string, string] => typeof entry[1] === 'string')));
  const merged = new Map<string, EnvEntry>();
  for (const layer of layers) for (const [identity, entry] of windowsLayer(layer)) merged.set(identity, entry);
  return Object.fromEntries([...merged].map(([identity, { key, value }]) => [identity === 'PATH' ? 'PATH' : key, value]));
}
