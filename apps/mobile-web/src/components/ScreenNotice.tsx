/**
 * The one honest failure surface for screens on useScreenData.
 *
 * Rules it encodes:
 *  - Offline reads as a state of the WORLD ("can't reach your Mac"), never as
 *    an app bug, and always offers retry.
 *  - When stale data is on screen, the notice rides above it as a banner —
 *    the data stays visible and usable.
 *  - Raw backend error strings are shown only when short and plain;
 *    stack-trace-shaped text gets a calm generic line.
 */
export interface ScreenNote {
  tone: 'success' | 'error' | 'info';
  text: string;
  /** Focus target id for a receipt the screen wants to announce. */
  id?: string;
}

interface Props {
  error: string | null;
  offline: boolean;
  onRetry: () => void;
  /** True when the screen has data behind the notice (banner mode). */
  hasData?: boolean;
  /** A screen-owned line (an action receipt, a partial refresh) shown when
   *  there is no transport failure to report. ONE line per screen: the
   *  transport truth outranks it. */
  note?: ScreenNote | null;
}

function presentable(error: string): string {
  if (error.length > 120 || /at\s+\w+\s+\(|stack|ECONN|ETIMEDOUT|\{"/.test(error)) {
    return 'Something went wrong talking to your Mac.';
  }
  return error;
}

export function ScreenNotice({ error, offline, onRetry, hasData, note }: Props) {
  if (!error && !offline) {
    if (!note) return null;
    return (
      <div
        id={note.id}
        class={`screen-notice screen-notice-${note.tone}${hasData ? ' screen-notice-banner' : ''}`}
        role={note.tone === 'error' ? 'alert' : 'status'}
        tabIndex={note.id ? -1 : undefined}
      >
        <span class="screen-notice-text">{note.text}</span>
      </div>
    );
  }
  const text = offline
    ? "Can't reach your Mac right now."
    : presentable(error ?? '');
  return (
    <div class={`screen-notice${hasData ? ' screen-notice-banner' : ''}${offline ? ' screen-notice-offline' : ''}`} role="status">
      <span class="screen-notice-text">{text}</span>
      <button class="screen-notice-retry" onClick={onRetry}>Retry</button>
    </div>
  );
}
