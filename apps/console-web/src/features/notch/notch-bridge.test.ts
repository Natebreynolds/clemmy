import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { resizeLiveSurface } from './notch-bridge';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

after(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

function installWindow(clementineLive?: ClementineLiveBridge): void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { clementineLive },
  });
}

test('native layout becomes renderable only after its matching acknowledgement', async () => {
  let received: ClementineLiveBounds | undefined;
  installWindow({
    resize: async (bounds) => {
      received = bounds;
      return { ok: true, applied: true, layoutId: bounds.layoutId };
    },
  });

  assert.equal(await resizeLiveSurface({ width: 360, height: 144 }, 'panel', 41), true);
  assert.deepEqual(received, { width: 360, height: 144, presentation: 'panel', layoutId: 41 });
});

test('stale or rejected native layouts stay pending for retry', async () => {
  installWindow({
    resize: async (bounds) => ({ ok: true, applied: false, layoutId: bounds.layoutId }),
  });
  assert.equal(await resizeLiveSurface({ width: 62, height: 48 }, 'dormant', 42), false);

  installWindow({ resize: async () => { throw new Error('renderer navigated'); } });
  assert.equal(await resizeLiveSurface({ width: 62, height: 48 }, 'dormant', 43), false);
});

test('browser preview has no native frame to wait for', async () => {
  installWindow();
  assert.equal(await resizeLiveSurface({ width: 360, height: 144 }, 'panel', 44), true);
});
