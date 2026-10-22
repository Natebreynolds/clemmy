import { h, type FunctionComponent } from 'preact';
import { lazy } from 'preact/compat';

/** A failed chunk load must be retryable without reloading unsent drafts.
 * Preact's lazy component retains its rejected promise, so retry replaces only
 * that loader. The surrounding authenticated shell stays mounted. */
export function deferredScreen<Props extends object>(load: () => Promise<{ default: FunctionComponent<Props> }>) {
  let Screen = lazy(load);
  const Component: FunctionComponent<Props> = (props) => h(Screen, props);
  return { Component, retry: () => { Screen = lazy(load); } };
}
