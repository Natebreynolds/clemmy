import type { NotchSurfaceSize } from './notch-model';

const LIVE_MOUNT_NONCE_QUERY_PARAM = 'clemmyLiveMount';
const LIVE_MOUNT_GENERATION_QUERY_PARAM = 'clemmyLiveGeneration';
const LIVE_MOUNT_NONCE_PATTERN = /^[A-Za-z0-9_-]{24,128}$/;

function ignoreAsyncFailure(result: void | Promise<void>): void {
  if (result && typeof result.then === 'function') void result.catch(() => undefined);
}

export async function resizeLiveSurface(
  size: NotchSurfaceSize,
  presentation: 'dormant' | 'panel',
  layoutId: number,
): Promise<boolean> {
  const resize = window.clementineLive?.resize;
  // A regular browser preview has no native frame to coordinate. Treat its
  // viewport as already laid out so the companion remains previewable there.
  if (typeof resize !== 'function') return true;
  try {
    const result = await resize({ ...size, presentation, layoutId });
    return Boolean(result
      && typeof result === 'object'
      && result.ok === true
      && result.applied === true
      && result.layoutId === layoutId);
  } catch {
    // The caller owns a bounded retry loop. Keeping the failure explicit avoids
    // rendering a panel into a stale 62px native frame.
    return false;
  }
}

/** Called once by NotchSurface after it mounts. A generic SPA document, 404,
 * or stale renderer cannot manufacture readiness merely by finishing load. */
export function acknowledgeLiveSurfaceMounted(): void {
  const mounted = window.clementineLive?.mounted;
  if (typeof mounted !== 'function') return;
  const params = new URLSearchParams(window.location.search);
  const nonce = params.get(LIVE_MOUNT_NONCE_QUERY_PARAM);
  const generation = Number(params.get(LIVE_MOUNT_GENERATION_QUERY_PARAM));
  if (!nonce || !LIVE_MOUNT_NONCE_PATTERN.test(nonce)
      || !Number.isSafeInteger(generation) || generation <= 0) return;
  try {
    ignoreAsyncFailure(mounted({ generation, nonce }));
  } catch {
    // A navigation can supersede this mount between React commit and IPC.
  }
}

export function dismissLiveSurface(): void {
  const dismiss = window.clementineLive?.dismiss;
  if (typeof dismiss !== 'function') return;
  try {
    ignoreAsyncFailure(dismiss());
  } catch {
    // Local reducer state is the browser-safe fallback.
  }
}

export function openClementineConsole(): void {
  const openConsole = window.clementineLive?.openConsole;
  if (typeof openConsole === 'function') {
    try {
      ignoreAsyncFailure(openConsole());
      return;
    } catch {
      // Fall through to the regular browser route.
    }
  }

  const opened = window.open('/console/chat', '_blank', 'noopener,noreferrer');
  if (!opened) window.location.assign('/console/chat');
}

export function subscribeToLivePreview(callback: (payload: unknown) => void): () => void {
  const onPreview = window.clementineLive?.onPreview;
  if (typeof onPreview !== 'function') return () => undefined;
  try {
    const unsubscribe = onPreview(callback);
    return typeof unsubscribe === 'function' ? unsubscribe : () => undefined;
  } catch {
    return () => undefined;
  }
}

export async function getLiveMeetingStatus(): Promise<unknown | null> {
  const status = window.clementineLive?.meetingStatus;
  if (typeof status !== 'function') return null;
  return await status();
}

async function invokeMeetingWindowAction(
  method: ((windowId: string) => unknown | Promise<unknown>) | undefined,
  windowId: string,
): Promise<unknown> {
  if (typeof method !== 'function') throw new Error('Meeting controls are available in the Clementine macOS app.');
  return await method(windowId);
}

export const recordDetectedMeeting = (windowId: string): Promise<unknown> => (
  invokeMeetingWindowAction(window.clementineLive?.recordDetectedMeeting, windowId)
);

export const alwaysRecordDetectedMeeting = (windowId: string): Promise<unknown> => (
  invokeMeetingWindowAction(window.clementineLive?.alwaysRecordMeeting, windowId)
);

export const dismissDetectedMeeting = (windowId: string): Promise<unknown> => (
  invokeMeetingWindowAction(window.clementineLive?.dismissMeetingPrompt, windowId)
);

export const stopDetectedMeeting = (windowId: string): Promise<unknown> => (
  invokeMeetingWindowAction(window.clementineLive?.stopMeetingRecording, windowId)
);

export async function requestLiveMeetingPermissions(): Promise<unknown> {
  const request = window.clementineLive?.requestMeetingPermissions;
  if (typeof request !== 'function') throw new Error('Meeting permissions are available in the Clementine macOS app.');
  return await request();
}

export function subscribeToLiveMeetingEvents(callback: (payload: unknown) => void): () => void {
  const subscribe = window.clementineLive?.onMeetingEvent;
  if (typeof subscribe !== 'function') return () => undefined;
  try {
    const unsubscribe = subscribe(callback);
    return typeof unsubscribe === 'function' ? unsubscribe : () => undefined;
  } catch {
    return () => undefined;
  }
}
