/** Strip the `desktop:` / `harness:` namespace from a unified session id. */
export function rawId(id: string): string {
  const i = id.indexOf(':');
  return i >= 0 ? id.slice(i + 1) : id;
}
