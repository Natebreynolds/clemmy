/**
 * Media capture is reserved for trusted first-party dashboard surfaces,
 * including the voice-enabled notch. Workspace URLs live under the dashboard
 * origin but their response + iframe force an opaque-origin sandbox. Keep the
 * path deny as defense in depth: agent-authored content must never inherit
 * Clementine's microphone grant, even after a top-frame navigation.
 */
export function isTrustedDashboardMediaUrl(
  rawUrl: string,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  try {
    const url = new URL(rawUrl);
    if (!trustedOrigins.has(url.origin)) return false;
    const pathname = decodeURIComponent(url.pathname);
    return !/^\/console\/spaces\/[^/]+\/view(?:\/|$)/i.test(pathname);
  } catch {
    return false;
  }
}
