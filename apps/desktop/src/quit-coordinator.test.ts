/**
 * Run with: npx tsx --test apps/desktop/src/quit-coordinator.test.ts
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { createQuitCoordinator, quitStep } from './quit-coordinator.js';

/** An app whose quit() emits before-quit synchronously, as Electron's does. */
function fakeApp(prepareMs: number) {
  const app = new EventEmitter() as EventEmitter & { quit(): void; exited: boolean; beforeQuitCount: number };
  app.exited = false;
  app.beforeQuitCount = 0;
  let prepareCalls = 0;
  const coordinator = createQuitCoordinator({
    prepare: async () => { prepareCalls++; await new Promise((r) => setTimeout(r, prepareMs)); },
    quit: () => app.quit(),
  });
  app.quit = () => {
    let prevented = false;
    app.beforeQuitCount++;
    if (app.beforeQuitCount > 1_000) throw new Error('before-quit re-entered without the event loop turning');
    app.emit('before-quit', { preventDefault: () => { prevented = true; } });
    if (!prevented) app.exited = true;
  };
  app.on('before-quit', (event: { preventDefault(): void }) => {
    if (coordinator.onBeforeQuit()) event.preventDefault();
  });
  return { app, coordinator, prepareCalls: () => prepareCalls };
}

test('one quit request prepares once and exits', async () => {
  const { app, coordinator, prepareCalls } = fakeApp(20);
  app.quit();
  await coordinator.quitCleanly();
  assert.equal(app.exited, true);
  assert.equal(prepareCalls(), 1);
});

test('a second quit while the first is preparing joins it instead of spinning', async () => {
  const { app, coordinator, prepareCalls } = fakeApp(50);
  app.quit();
  app.quit(); // Cmd-Q pressed again, or a second quit event, mid-preparation
  void coordinator.quitCleanly(); // the tray item too
  await coordinator.quitCleanly();
  assert.equal(app.exited, true);
  assert.equal(prepareCalls(), 1, 'preparation runs exactly once');
  assert.ok(app.beforeQuitCount <= 4, `before-quit ran ${app.beforeQuitCount} times`);
});

test('a preparation step that throws still lets the app exit', async () => {
  const app = new EventEmitter() as EventEmitter & { quit(): void; exited: boolean };
  app.exited = false;
  const coordinator = createQuitCoordinator({
    prepare: async () => { throw new Error('meeting capture refused to stop'); },
    quit: () => app.quit(),
  });
  app.quit = () => {
    let prevented = false;
    app.emit('before-quit', { preventDefault: () => { prevented = true; } });
    if (!prevented) app.exited = true;
  };
  app.on('before-quit', (event: { preventDefault(): void }) => { if (coordinator.onBeforeQuit()) event.preventDefault(); });
  app.quit();
  await coordinator.quitCleanly().catch(() => undefined);
  assert.equal(app.exited, true);
});

test('a quit step that never settles stops holding the quit at its deadline', async () => {
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    const hung = new Promise<string>(() => { /* never settles */ });
    const started = Date.now();
    assert.equal(await quitStep('meeting capture drain', hung, 50), undefined);
    assert.ok(Date.now() - started < 1000, 'the quit moved on at the deadline');
    assert.match(String(errors[0]), /meeting capture drain did not finish/);
    assert.equal(await quitStep('service stop', Promise.resolve('stopped'), 50), 'stopped', 'a step that settles keeps its result');
    assert.equal(await quitStep('absent step', undefined, 50), undefined);
  } finally {
    console.error = original;
  }
});
