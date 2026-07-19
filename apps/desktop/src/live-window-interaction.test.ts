import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLEMENTINE_LIVE_WINDOW_INTERACTION_OPTIONS,
  CLEMENTINE_LIVE_WINDOW_LEVEL,
  planClementineLivePanelToggle,
} from './live-window-interaction.js';

test('uses a normal focusable window that accepts the first macOS click', () => {
  assert.equal(Object.hasOwn(CLEMENTINE_LIVE_WINDOW_INTERACTION_OPTIONS, 'type'), false);
  assert.equal(CLEMENTINE_LIVE_WINDOW_INTERACTION_OPTIONS.focusable, true);
  assert.equal(CLEMENTINE_LIVE_WINDOW_INTERACTION_OPTIONS.acceptFirstMouse, true);
});

test('sits just above the macOS menu bar instead of using the screen-saver level', () => {
  assert.deepEqual(CLEMENTINE_LIVE_WINDOW_LEVEL, {
    name: 'main-menu',
    relativeLevel: 3,
  });
});

test('a hidden ready notch is shown and toggled in the same intent', () => {
  assert.equal(planClementineLivePanelToggle({ availability: 'loading', visible: false }), 'defer');
  assert.equal(planClementineLivePanelToggle({ availability: 'unavailable', visible: false }), 'defer');
  assert.equal(planClementineLivePanelToggle({ availability: 'ready', visible: false }), 'show-and-toggle');
  assert.equal(planClementineLivePanelToggle({ availability: 'ready', visible: true }), 'toggle');
});
