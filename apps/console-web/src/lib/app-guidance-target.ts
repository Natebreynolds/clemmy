export type GuidanceTargetState = 'checking' | 'ready' | 'unavailable';

export interface GuidanceTargetEnvironment {
  find: (selector: string) => HTMLElement | null;
  focused: () => HTMLElement | null;
  reducedMotion: () => boolean;
  observe: (check: () => void) => () => void;
  schedule: (run: () => void, delayMs: number) => () => void;
}

function browserEnvironment(): GuidanceTargetEnvironment {
  return {
    find: selector => {
      const element = document.querySelector<HTMLElement>(selector);
      return element?.isConnected && element.getClientRects().length > 0
        && !element.closest('[hidden],[aria-hidden="true"]') && !element.matches(':disabled,[aria-disabled="true"]') ? element : null;
    },
    focused: () => document.activeElement === document.body ? null : document.activeElement as HTMLElement | null,
    reducedMotion: () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    observe: check => {
      const observer = new MutationObserver(check);
      observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-hidden', 'aria-disabled'] });
      return () => observer.disconnect();
    },
    schedule: (run, delayMs) => { const timer = window.setTimeout(run, delayMs); return () => window.clearTimeout(timer); },
  };
}

/** The guide follows an available control, never a guessed setup/completion state. */
export function watchGuidanceTarget(selector: string, onState: (state: GuidanceTargetState) => void, environment: GuidanceTargetEnvironment = browserEnvironment()): () => void {
  let stopped = false;
  let timedOut = false;
  let state: GuidanceTargetState | undefined;
  let target: HTMLElement | null = null;
  let addedTabIndex = false;
  const initialFocus = environment.focused();
  let cancelTimer = () => {};
  let disconnect = () => {};
  const report = (next: GuidanceTargetState) => { if (!stopped && state !== next) { state = next; onState(next); } };
  const release = (restoreFocus: boolean) => {
    if (!target) return;
    if (restoreFocus && environment.focused() === target && initialFocus?.isConnected && typeof initialFocus.focus === 'function') initialFocus.focus({ preventScroll: true });
    target.classList.remove('clem-guide-target');
    if (addedTabIndex && target.getAttribute('tabindex') === '-1') target.removeAttribute('tabindex');
    target = null; addedTabIndex = false;
  };
  const wait = () => {
    cancelTimer(); report('checking');
    cancelTimer = environment.schedule(() => {
      if (stopped || target) return;
      timedOut = true; report('unavailable'); disconnect();
    }, 8_000);
  };
  const check = () => {
    if (stopped || timedOut) return;
    const found = environment.find(selector);
    if (found === target && target) return;
    if (target) release(false);
    if (!found) { if (state !== 'checking') wait(); return; }
    cancelTimer(); target = found;
    found.classList.add('clem-guide-target');
    if (!found.matches('a[href],button,input,select,textarea,[tabindex]')) {
      found.setAttribute('tabindex', '-1'); addedTabIndex = true;
    }
    // An asynchronously loaded page must not steal focus from new typing.
    const focused = environment.focused();
    if (!focused || focused === initialFocus) {
      found.scrollIntoView({ behavior: environment.reducedMotion() ? 'auto' : 'smooth', block: 'center' });
      found.focus({ preventScroll: true });
    }
    report('ready');
  };
  disconnect = environment.observe(check);
  check();
  return () => { stopped = true; disconnect(); cancelTimer(); release(true); };
}
