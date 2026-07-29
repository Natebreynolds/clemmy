/** Main-process navigation policy for agent-authored Workspace frames.
 *
 * The renderer also cancels navigations through the Navigation API, but this
 * boundary is authoritative in Electron. A Workspace frame may be initially
 * loaded by the trusted dashboard; once loaded, neither it nor content it
 * initiated may navigate anywhere (including another localhost admin route).
 */

import { isWorkspaceViewUrl } from './workspace-view-url.cjs';

export { isWorkspaceViewUrl };

/**
 * A dashboard renderer gets privileged desktop IPC only when it is on one of
 * the exact daemon origins and is not agent-authored Workspace content.
 *
 * Workspace views intentionally share the daemon's HTTP origin so their inert
 * assets can load, but they are a separate, untrusted renderer surface. Keep
 * this decision path-based instead of treating every localhost URL as admin.
 */
export function isPrivilegedDashboardRendererUrl(
  rawUrl: string,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  try {
    const parsed = new URL(rawUrl);
    return trustedOrigins.has(parsed.origin) && !isWorkspaceViewUrl(rawUrl);
  } catch {
    return false;
  }
}

export function workspaceFrameNavigationMustBeBlocked(input: {
  frameUrl?: string | null;
  initiatorUrl?: string | null;
  targetUrl: string;
}): boolean {
  void input.targetUrl;
  return isWorkspaceViewUrl(input.frameUrl ?? '')
    || isWorkspaceViewUrl(input.initiatorUrl ?? '');
}

/** Raw Workspace documents must never replace the privileged dashboard frame. */
export function workspaceTopLevelNavigationMustBeBlocked(targetUrl: string): boolean {
  return isWorkspaceViewUrl(targetUrl);
}

/**
 * The trusted dashboard still needs to perform the iframe's first navigation
 * from about:blank to its Workspace view. This is the only Workspace-targeted
 * frame navigation allowed; once authored content has loaded, the source check
 * above blocks every attempted navigation.
 */
export function workspaceInitialFrameLoadMayProceed(input: {
  frameUrl?: string | null;
  initiatorUrl?: string | null;
  targetUrl: string;
}): boolean {
  return isWorkspaceViewUrl(input.targetUrl)
    && !workspaceFrameNavigationMustBeBlocked(input);
}

const EXTERNAL_PROTOCOLS = new Set([
  'https:',
  'http:',
  'mailto:',
  'tel:',
  'callto:',
  'sms:',
  'facetime:',
  'facetime-audio:',
  'maps:',
  'webcal:',
  'zoommtg:',
  'msteams:',
]);

export function isSafeWorkspaceExternalUrl(rawUrl: string): boolean {
  const value = rawUrl.trim();
  if (!value || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return EXTERNAL_PROTOCOLS.has(parsed.protocol)
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}
