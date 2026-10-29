export interface ComputerScreenCycle {
  loaded: (source: string) => void;
  failed: (source: string) => void;
  stop: () => void;
}

/** A capture can take tens of seconds. Never replace it with another request
 * before its image settles, and never retry a failed capture without the user. */
export function startComputerScreenCycle(host: {
  source: () => string;
  show: (source: string) => void;
  fail: () => void;
  schedule: (run: () => void, delayMs: number) => () => void;
}): ComputerScreenCycle {
  let stopped = false;
  let pending: string | null = null;
  let cancelRefresh: (() => void) | null = null;
  const stop = () => {
    stopped = true; pending = null;
    cancelRefresh?.(); cancelRefresh = null;
  };
  const request = () => {
    if (stopped || pending !== null) return;
    pending = host.source(); host.show(pending);
  };
  request();
  return {
    loaded: source => {
      if (stopped || source !== pending) return;
      pending = null;
      cancelRefresh = host.schedule(() => { cancelRefresh = null; request(); }, 2_000);
    },
    failed: source => {
      if (stopped || source !== pending) return;
      stop(); host.fail();
    },
    stop,
  };
}
