export type GuidanceTargetState = 'checking' | 'ready' | 'unavailable';
export interface GuidanceTargetHost {
  find: () => boolean;
  observe: (check: () => void) => () => void;
  later: (check: () => void, milliseconds: number) => () => void;
}

export interface GuidanceTargetCandidate {
  isConnected: boolean;
  getClientRects: () => ArrayLike<unknown>;
  closest: (selector: string) => unknown;
  matches: (selector: string) => boolean;
}

/** A visible control behind a sheet or marked unavailable is not a guide target. */
export function guidanceTargetEligible(node: GuidanceTargetCandidate | null): boolean {
  return Boolean(node?.isConnected && node.getClientRects().length > 0
    && !node.closest('[hidden],[aria-hidden="true"],[inert],[aria-disabled="true"]')
    && !node.matches(':disabled'));
}

/** Waits are bounded; a ready target stays observed until the guide closes. */
export function watchGuidanceTarget(host: GuidanceTargetHost, onState: (state: GuidanceTargetState) => void, timeoutMs = 8_000): () => void {
  let stopped = false;
  let state: GuidanceTargetState | null = null;
  let stopObserving = () => {};
  let stopTimer = () => {};
  let waiting = false;
  const report = (next: GuidanceTargetState) => { if (!stopped && next !== state) { state = next; onState(next); } };
  const clearTimer = () => { if (waiting) { waiting = false; stopTimer(); stopTimer = () => {}; } };
  const cancel = () => { if (stopped) return; stopped = true; stopObserving(); clearTimer(); };
  const check = () => {
    if (stopped) return;
    if (host.find()) { clearTimer(); report('ready'); return; }
    report('checking');
    if (waiting) return;
    waiting = true;
    stopTimer = host.later(() => {
      if (stopped || !waiting) return;
      if (host.find()) { clearTimer(); report('ready'); return; }
      report('unavailable'); cancel();
    }, timeoutMs);
  };
  stopObserving = host.observe(check);
  check();
  return cancel;
}
