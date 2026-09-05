/**
 * The smallest possible shared store: one value, many readers.
 *
 * Preact has no built-in cross-component state, and pulling a state library
 * in for two records (home preferences, the working-now snapshot) would be
 * a dependency for a dozen lines. Readers subscribe through `useLiveStore`
 * and re-render only when the value identity changes.
 */
import { useEffect, useState } from 'preact/hooks';

export interface LiveStore<T> {
  get(): T;
  set(next: T | ((current: T) => T)): void;
  subscribe(listener: () => void): () => void;
}

export function createLiveStore<T>(initial: T): LiveStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const resolved = typeof next === 'function' ? (next as (current: T) => T)(value) : next;
      if (Object.is(resolved, value)) return;
      value = resolved;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

export function useLiveStore<T>(store: LiveStore<T>): T {
  const [value, setValue] = useState<T>(() => store.get());
  useEffect(() => {
    // The store may have moved between the first render and subscription.
    setValue(store.get());
    return store.subscribe(() => setValue(store.get()));
  }, [store]);
  return value;
}
