/**
 * One clean quit at a time.
 *
 * Quitting prepares first (meeting capture, the daemon's shutdown) and only
 * then lets Electron exit. Every request to quit — the tray item, Cmd-Q, a
 * quit event from the system or an installer, a second press while the first
 * is still preparing — joins the single quit already in flight. Starting a
 * second one would call app.quit() before preparation has finished; that
 * re-enters before-quit, which starts another, and the cycle runs as
 * back-to-back microtasks that never yield to the event loop the preparation
 * is waiting on. The app then spins in its quit handler forever.
 */
export interface QuitCoordinator {
  /** Start the clean quit, or join the one in flight. */
  quitCleanly(): Promise<void>;
  /**
   * Handle Electron's before-quit. Returns true when the default must be
   * prevented (preparation is not finished); the caller calls
   * event.preventDefault() in that case.
   */
  onBeforeQuit(): boolean;
  /** Preparation has finished; the next before-quit lets the app exit. */
  readonly prepared: boolean;
}

export function createQuitCoordinator(deps: {
  /** Everything that must finish before the process exits. Should not throw. */
  prepare: () => Promise<void>;
  /** Electron's app.quit(); emits before-quit synchronously. */
  quit: () => void;
  /** Mark the app as quitting as soon as a quit is requested. */
  markQuitting?: () => void;
}): QuitCoordinator {
  let prepared = false;
  let inFlight: Promise<void> | null = null;

  const quitCleanly = (): Promise<void> => {
    if (inFlight) return inFlight;
    deps.markQuitting?.();
    inFlight = (async () => {
      try {
        await deps.prepare();
      } catch {
        // A failed step must not trap the app open: each step reports its own
        // failure, and the quit still proceeds.
      }
      prepared = true;
      deps.quit();
    })();
    return inFlight;
  };

  return {
    quitCleanly,
    onBeforeQuit() {
      if (prepared) return false;
      void quitCleanly();
      return true;
    },
    get prepared() { return prepared; },
  };
}
