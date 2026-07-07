import { useCallback, useEffect, useState } from 'react';
import { clemmy, isDesktop } from '@/lib/clemmy';

/**
 * App auto-updater surface for the new console.
 *
 * The Electron updater (apps/desktop/src/updater.ts) already exposes full status
 * + actions over the preload bridge (window.clemmy.updater*), and the legacy
 * console rendered a header CTA from it — but the React console only had a TOAST
 * and no in-app surface, so a downloaded/blocked update had nowhere to land.
 * This is the missing surface: a thin global banner that mirrors the updater
 * state and offers the right one-click action (download / restart-to-install /
 * move-to-Applications / repair-ownership / retry). Degrades to nothing in a
 * plain browser (no bridge) and on non-actionable states.
 */
type UpdaterState =
  | 'idle' | 'checking' | 'no-update' | 'available' | 'downloading' | 'ready-to-install' | 'error';

interface UpdaterStatus {
  state: UpdaterState;
  version?: string;
  progressPct?: number;
  error?: string;
  installBlocker?: 'move-to-applications' | 'app-not-writable';
}

interface UpdaterBridge {
  updaterStatus?: () => Promise<UpdaterStatus>;
  updaterCheck?: () => Promise<UpdaterStatus>;
  updaterApply?: () => Promise<unknown>;
  updaterMoveToApplications?: () => Promise<unknown>;
  updaterRepairOwnership?: () => Promise<unknown>;
  onUpdaterEvent?: (cb: (e: UpdaterStatus) => void) => (() => void) | void;
}

function updaterBridge(): UpdaterBridge | null {
  // The shared lib type doesn't yet declare every updater method, but the
  // preload bridge implements them all — cast to the local shape we use.
  return clemmy() as unknown as UpdaterBridge | null;
}

type Tone = 'info' | 'ready' | 'error';

export function UpdaterBanner() {
  const [status, setStatus] = useState<UpdaterStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return;
    const b = updaterBridge();
    if (!b?.updaterStatus) return;
    let alive = true;
    void b.updaterStatus().then((s) => { if (alive && s) setStatus(s); }).catch(() => { /* bridge hiccup — stay silent */ });
    const off = b.onUpdaterEvent?.((e) => { if (e) setStatus(e); });
    return () => { alive = false; if (typeof off === 'function') off(); };
  }, []);

  const run = useCallback(async (fn?: () => Promise<unknown>) => {
    if (!fn) return;
    setBusy(true);
    try {
      const next = await fn();
      if (next && typeof next === 'object' && 'state' in (next as Record<string, unknown>)) {
        setStatus(next as UpdaterStatus);
      } else {
        const s = await updaterBridge()?.updaterStatus?.();
        if (s) setStatus(s);
      }
    } catch {
      /* failures surface via the next updater event */
    } finally {
      setBusy(false);
    }
  }, []);

  if (!status) return null;
  const { state, version, progressPct, error, installBlocker } = status;
  const v = version ? ` v${version}` : '';
  const b = updaterBridge();

  let tone: Tone = 'info';
  let text = '';
  let action: { label: string; fn?: () => Promise<unknown> } | null = null;

  if (installBlocker === 'move-to-applications') {
    tone = 'error';
    text = 'Move Clementine to /Applications to enable auto-updates.';
    action = { label: 'Move to Applications', fn: () => b!.updaterMoveToApplications!() };
  } else if (installBlocker === 'app-not-writable') {
    tone = 'error';
    text = "Updates can't apply — Clementine's app bundle isn't writable.";
    action = { label: 'Repair & enable updates', fn: () => b!.updaterRepairOwnership!() };
  } else if (state === 'available') {
    text = `An update${v} is available.`;
    action = { label: 'Download', fn: () => b!.updaterApply!() };
  } else if (state === 'downloading') {
    text = `Downloading update${v}${typeof progressPct === 'number' ? ` · ${progressPct}%` : '…'}`;
  } else if (state === 'ready-to-install') {
    tone = 'ready';
    text = `Clementine${v} is ready to install.`;
    action = { label: 'Restart & install', fn: () => b!.updaterApply!() };
  } else if (state === 'error' && error) {
    tone = 'error';
    text = `Update error: ${error}`;
    action = { label: 'Retry', fn: () => (b!.updaterCheck ?? b!.updaterStatus)!() };
  } else {
    // idle / checking / no-update → nothing to surface.
    return null;
  }

  const icon = tone === 'ready' ? '✓' : tone === 'error' ? '⚠' : '↓';
  const cardBg = tone === 'ready' ? 'bg-primary-tint' : 'bg-surface';
  const btnClass = tone === 'ready'
    ? 'bg-primary text-primary-fg hover:bg-primary-hover'
    : 'bg-surface border border-border text-fg hover:bg-subtle';

  // Unobtrusive floating chip pinned bottom-left — only mounts on an actionable
  // state (we returned null above otherwise), so it simply isn't there when
  // there's no update.
  return (
    <div
      role="status"
      aria-live="polite"
      title={text}
      className={`fixed bottom-4 left-4 z-50 flex max-w-xs items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm text-fg shadow-warm-halo ${cardBg}`}
    >
      <span aria-hidden className="shrink-0">{icon}</span>
      <span className="min-w-0 truncate">{text}</span>
      {action && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(action!.fn)}
          className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-progress disabled:opacity-60 ${btnClass}`}
        >
          {busy ? 'Working…' : action.label}
        </button>
      )}
    </div>
  );
}
