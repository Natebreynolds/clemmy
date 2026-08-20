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
interface Props {
  error: string | null;
  offline: boolean;
  onRetry: () => void;
  /** True when the screen has data behind the notice (banner mode). */
  hasData?: boolean;
}

function presentable(error: string): string {
  if (error.length > 120 || /at\s+\w+\s+\(|stack|ECONN|ETIMEDOUT|\{"/.test(error)) {
    return 'Something went wrong talking to your Mac.';
  }
  return error;
}

export function ScreenNotice({ error, offline, onRetry, hasData }: Props) {
  if (!error && !offline) return null;
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
