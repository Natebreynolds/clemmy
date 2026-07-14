/**
 * Media capture is reserved for the trusted dashboard SPA. Workspace HTML is
 * intentionally rendered same-origin at /console/spaces/:id/view, so origin
 * checks alone are insufficient: agent-authored content must never inherit
 * Clementine's automatic microphone grant, even after a top-frame navigation.
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
