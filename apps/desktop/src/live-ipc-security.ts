export interface ClementineLiveIpcSenderIdentity {
  webContentsId: number;
  mainFrameRoutingId: number;
}

export interface ClementineLiveIpcEventIdentity {
  senderId: number;
  senderFrameRoutingId: number | null;
}

/**
 * Live IPC is intentionally narrower than origin-based dashboard IPC. Matching
 * both WebContents and the main frame prevents another dashboard window, an
 * old destroyed renderer, or a same-origin iframe from controlling the shell.
 */
export function isExactClementineLiveIpcSender(
  event: ClementineLiveIpcEventIdentity,
  expected: ClementineLiveIpcSenderIdentity | null,
): boolean {
  return expected !== null
    && event.senderId === expected.webContentsId
    && event.senderFrameRoutingId === expected.mainFrameRoutingId;
}

/** Settings mutations additionally require the trusted dashboard's exact
 * Settings route. Route matching is a product guard; the exact WebContents and
 * main-frame identity remain the actual renderer isolation boundary. */
export function isExactClementineNotchSettingsIpcSender(
  event: ClementineLiveIpcEventIdentity,
  expected: ClementineLiveIpcSenderIdentity | null,
  senderUrl: string,
  trustedDashboard: boolean,
): boolean {
  if (!trustedDashboard || !isExactClementineLiveIpcSender(event, expected)) return false;
  try {
    return /^\/console\/settings\/?$/i.test(new URL(senderUrl).pathname);
  } catch {
    return false;
  }
}
