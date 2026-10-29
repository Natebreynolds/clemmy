export interface OnboardingEntry { version: 1; intent: 'explore' | 'ready'; stamp: number }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
function readEntry(value: unknown): OnboardingEntry | null {
  if (!record(value) || !['version', 'intent', 'stamp'].every(key => Object.hasOwn(value, key))
    || value.version !== 1 || value.intent !== 'explore' && value.intent !== 'ready'
    || !Number.isSafeInteger(value.stamp) || Number(value.stamp) <= 0) return null;
  return { version: 1, intent: value.intent as OnboardingEntry['intent'], stamp: Number(value.stamp) };
}
export function readOnboardingEntry(state: unknown): OnboardingEntry | null {
  return record(state) && Object.hasOwn(state, 'onboardingEntry') ? readEntry(state.onboardingEntry) : null;
}
/** Exploration opens Today; connected completion opens the existing editable examples. */
export function onboardingCompletionNavigation(explore: boolean, stamp = Date.now()) {
  const entry = readEntry({ version: 1, intent: explore ? 'explore' : 'ready', stamp });
  if (!entry) throw new Error('Setup could not prepare its next page. Please try again.');
  return { pathname: '/chat' as const, state: { onboardingEntry: entry, ...(!explore ? { newChat: stamp } : {}) } };
}
/** The same explicit exploration entry owns its draft across a Settings return. */
export function explorationDraftStamp(pathname: string, state: unknown): number | undefined {
  const entry = pathname === '/chat' ? readOnboardingEntry(state) : null;
  return entry?.intent === 'explore' ? entry.stamp : undefined;
}
export function onboardingModelAccounts(entry: OnboardingEntry) {
  return { pathname: '/settings' as const, hash: '#accounts', state: { onboardingModelReturn: entry } };
}
export function onboardingDraftReturn(state: unknown) {
  const entry = record(state) && Object.hasOwn(state, 'onboardingModelReturn') ? readEntry(state.onboardingModelReturn) : null;
  return entry?.intent === 'explore' ? { pathname: '/chat' as const, state: { onboardingEntry: entry } } : null;
}

const DISMISS_KEY = 'clem.onboarding.exploration-dismissed.v1';
const dismissed = new Set<number>();
type DismissStorage = Pick<Storage, 'getItem' | 'setItem'>;
function localStoragePort(): DismissStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}
function retainedDismissals(storage: DismissStorage | null): number[] {
  try {
    const value: unknown = JSON.parse(storage?.getItem(DISMISS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter(stamp => Number.isSafeInteger(stamp) && stamp > 0).slice(-50) : [];
  } catch { return []; }
}
export function explorationWasDismissed(entry: OnboardingEntry, storage = localStoragePort()): boolean {
  return entry.intent === 'explore' && (dismissed.has(entry.stamp) || retainedDismissals(storage).includes(entry.stamp));
}
export function dismissExploration(entry: OnboardingEntry, storage = localStoragePort()): void {
  if (entry.intent !== 'explore') return;
  dismissed.add(entry.stamp);
  if (dismissed.size > 50) dismissed.delete(dismissed.values().next().value!);
  try { storage?.setItem(DISMISS_KEY, JSON.stringify([...new Set([...retainedDismissals(storage), entry.stamp])].slice(-50))); }
  catch { /* This window still respects dismissal when local storage is unavailable. */ }
}
