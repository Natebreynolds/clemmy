/**
 * Shared by the ESM main process and CommonJS preload build. Keeping this
 * narrow predicate in a .cts module lets both runtimes consume the exact same
 * Workspace boundary without the preload compiler overwriting an ESM module.
 */
export function isWorkspaceViewUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const loopback = parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]');
    return loopback && /^\/console\/spaces\/[^/]+\/view(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}
