import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * Native options that keep the notch clickable without stealing focus merely
 * because it was shown. Do not use Electron's `panel` window type here: on
 * macOS it applies the non-activating panel style mask, which prevents the
 * dormant notch from reliably delivering its first click to Chromium.
 */
export const CLEMENTINE_LIVE_WINDOW_INTERACTION_OPTIONS: Readonly<Pick<
  BrowserWindowConstructorOptions,
  'acceptFirstMouse' | 'focusable'
>> = Object.freeze({
  acceptFirstMouse: true,
  focusable: true,
});

/**
 * Keep the notch immediately above macOS' menu-bar windows. A screen-saver
 * level window can paint in the reserved strip but is not a reliable mouse
 * target there; native notch panels use the main-menu level plus a small
 * relative offset instead.
 */
export const CLEMENTINE_LIVE_WINDOW_LEVEL = Object.freeze({
  name: 'main-menu' as const,
  relativeLevel: 3,
});

export type ClementineLivePanelTogglePlan = 'defer' | 'show-and-toggle' | 'toggle';

/** Decide how a native menu/shortcut intent reaches the renderer. */
export function planClementineLivePanelToggle(input: {
  availability: 'loading' | 'ready' | 'unavailable';
  visible: boolean;
}): ClementineLivePanelTogglePlan {
  if (input.availability !== 'ready') return 'defer';
  return input.visible ? 'toggle' : 'show-and-toggle';
}
