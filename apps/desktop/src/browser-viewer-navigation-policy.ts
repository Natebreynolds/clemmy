import { isPrivilegedDashboardRendererUrl, isWorkspaceViewUrl } from './workspace-navigation-policy.js';

/** The WebFrameMain fields used here are read synchronously from Electron's
 * navigation event. Process + routing ids identify the underlying frame even
 * when Electron supplies different wrappers for it. */
export interface BrowserViewerFrame {
  readonly url: string;
  readonly processId: number;
  readonly routingId: number;
  readonly frameTreeNodeId: number;
  readonly parent: BrowserViewerFrame | null;
  readonly top: BrowserViewerFrame | null;
}

/** Recognize the provider boundary even when a URL is unsafe to embed. A
 * rejected viewer URL is a private capability, never an external link. */
export function isBrowserViewerNavigationUrl(rawUrl: string | null | undefined): boolean {
  try { return ['www.browserbase.com', 'browserbase.com'].includes(new URL(rawUrl ?? '').hostname); }
  catch { return false; }
}

function safeViewerUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return !/[\u0000-\u0020\u007f]/.test(rawUrl) && isBrowserViewerNavigationUrl(rawUrl)
      && url.protocol === 'https:' && !url.port && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

function sameFrame(a: BrowserViewerFrame | null | undefined, b: BrowserViewerFrame | null | undefined): boolean {
  return !!a && !!b && a.processId === b.processId && a.routingId === b.routingId;
}

function trustedDashboard(frame: BrowserViewerFrame, origins: ReadonlySet<string>): boolean {
  if (!isPrivilegedDashboardRendererUrl(frame.url, origins)) return false;
  try {
    const path = decodeURIComponent(new URL(frame.url).pathname);
    return /^\/console(?:\/|$)/.test(path) && !/^\/console\/notch(?:\/|$)/i.test(path)
      && !isWorkspaceViewUrl(frame.url) && !/^\/console\/spaces\/[^/]+\/view(?:\/|$)/i.test(path);
  } catch { return false; }
}

/** Browserbase is embedded content, never a privileged renderer. Only a direct
 * child of the actual trusted dashboard may load its provider-minted viewer.
 * The parent can mount/renew it; the same viewer can navigate within the exact
 * provider origins. Missing identity, other initiators and escape attempts
 * fail closed without opening a bearer URL in another application. */
export interface BrowserViewerNavigation {
  targetUrl: string;
  isMainFrame: boolean;
  frame: BrowserViewerFrame | null;
  initiator?: BrowserViewerFrame | null;
  mainFrame: BrowserViewerFrame;
  trustedOrigins: ReadonlySet<string>;
}
export function browserViewerNavigationDecision(input: BrowserViewerNavigation): 'allow' | 'block' | 'unhandled' {
  const { frame, initiator, mainFrame, targetUrl, trustedOrigins } = input;
  if (![targetUrl, frame?.url, initiator?.url].some(isBrowserViewerNavigationUrl)) return 'unhandled';
  if (input.isMainFrame || !frame || sameFrame(frame, mainFrame) || !safeViewerUrl(targetUrl)
    || !sameFrame(frame.parent, mainFrame) || !sameFrame(frame.top, mainFrame)
    || mainFrame.parent !== null || !trustedDashboard(mainFrame, trustedOrigins)) return 'block';

  const firstLoad = frame.url === '' || frame.url === 'about:blank';
  const existingViewer = safeViewerUrl(frame.url);
  if (!firstLoad && !existingViewer) return 'block';
  if (sameFrame(initiator, mainFrame) && trustedDashboard(initiator!, trustedOrigins)) return 'allow';
  if (existingViewer && sameFrame(initiator, frame) && safeViewerUrl(initiator!.url)) return 'allow';
  return 'block';
}

/** During a first-load HTTP redirect Electron can still report frame.url as
 * empty. Retain the admitted navigation's stable frame-tree identity so an
 * escaping redirect cannot fall through to ordinary localhost navigation.
 * This stores no viewer URL or token, and never turns missing initiator proof
 * into permission. */
export function createBrowserViewerNavigationGuard() {
  const pending = new Map<number, { mainFrameTreeNodeId: number; processId: number; routingId: number }>();
  // Failure/commit events identify a frame, not its navigation. A late failure
  // for A can arrive after B starts in that same frame. It may revoke pending
  // permission, but must never remove this deny-only classification and make
  // B's empty-source redirect look like unrelated dashboard navigation.
  const viewerFrames = new Set<number>();
  const remember = (input: BrowserViewerNavigation) => {
    const frame = input.frame!;
    viewerFrames.add(frame.frameTreeNodeId);
    pending.set(frame.frameTreeNodeId, { mainFrameTreeNodeId: input.mainFrame.frameTreeNodeId,
      processId: frame.processId, routingId: frame.routingId });
  };
  return {
    navigation(input: BrowserViewerNavigation): 'allow' | 'block' | 'unhandled' {
      if (input.frame) pending.delete(input.frame.frameTreeNodeId);
      const decision = browserViewerNavigationDecision(input);
      if (decision === 'allow') remember(input);
      if (decision === 'unhandled' && input.frame && viewerFrames.has(input.frame.frameTreeNodeId)) return 'block';
      return decision;
    },
    redirect(input: BrowserViewerNavigation): 'allow' | 'block' | 'unhandled' {
      const id = input.frame?.frameTreeNodeId;
      const admitted = id === undefined ? undefined : pending.get(id);
      const decision = browserViewerNavigationDecision(input);
      if (!admitted && decision === 'unhandled' && (id === undefined || !viewerFrames.has(id))) return 'unhandled';
      if (admitted?.mainFrameTreeNodeId === input.mainFrame.frameTreeNodeId && decision === 'allow') {
        remember(input);
        return 'allow';
      }
      if (id !== undefined) pending.delete(id);
      return 'block';
    },
    /** Commit/failure may report a new renderer process after a cross-origin
     * navigation. Use the stable id if Electron can still resolve the frame. */
    settled(processId: number, routingId: number, frameTreeNodeId?: number) {
      for (const [id, row] of pending) {
        if (id === frameTreeNodeId || (row.processId === processId && row.routingId === routingId)) pending.delete(id);
      }
    },
    prune(liveFrameTreeNodeIds: ReadonlySet<number>) {
      for (const id of pending.keys()) if (!liveFrameTreeNodeIds.has(id)) pending.delete(id);
      for (const id of viewerFrames) if (!liveFrameTreeNodeIds.has(id)) viewerFrames.delete(id);
    },
    /** Only actual frame removal, main-document commit or WebContents teardown
     * can end the deny-only boundary. A canceled navigation cannot. */
    clear() { pending.clear(); viewerFrames.clear(); },
  };
}
