import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import {
  completeNativeOnboarding,
  initialDesktopDashboardUrl,
  isCurrentOnboardingMainFrame,
  onboardingModelConfigured,
} from './onboarding.js';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-native-onboarding-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
const setup = await import('./setup-state.js');
const marker = path.join(TEST_HOME, 'state', 'setup-complete.json');
beforeEach(() => setup.clearSetupComplete());
after(() => rmSync(TEST_HOME, { recursive: true, force: true }));

function settings(brain = 'api_key', value = 'api_key:controlled-model', available: unknown = true) {
  const modelId = value.slice(brain.length + 1);
  return { activeBrain: 'codex_oauth', modelRoles: { activeBrain: 'codex_oauth',
    effectiveBrain: brain, effectiveBrainValue: value,
    roles: { brain: { modelId } },
    brainOptions: [{ id: brain, value, modelId, available }],
  } };
}

function ports(snapshot: unknown = settings()) {
  let reads = 0;
  let writes = 0;
  return {
    hasCompletedSetup: setup.hasCompletedSetup,
    readSettings: async () => { reads++; return snapshot; },
    writeSetupComplete: (record: Parameters<typeof setup.writeSetupComplete>[0]) => {
      writes++;
      return setup.writeSetupComplete(record);
    },
    counts: () => ({ reads, writes }),
  };
}

test('first-run URL preserves the exact bootstrap query and returning users keep the normal dashboard', () => {
  const base = 'http://127.0.0.1:3131/console?token=controlled%2Btoken%2Fvalue&other=kept';
  const initial = new URL(initialDesktopDashboardUrl(base, true));
  assert.equal(initial.pathname, '/console/onboarding');
  assert.equal(initial.search, new URL(base).search);
  assert.equal(initial.origin, new URL(base).origin);
  assert.equal(initialDesktopDashboardUrl(base, false), base);
  const restarted = new URL(initialDesktopDashboardUrl(base.replace(':3131/', ':3132/'), true));
  assert.equal(restarted.pathname, '/console/onboarding');
  assert.equal(restarted.port, '3132');
  assert.equal(restarted.search, initial.search);
});

test('onboarding completion permits only the current main frame after trusted-dashboard validation', () => {
  const current = { webContentsId: 42, mainFrameRoutingId: 7 };
  assert.equal(isCurrentOnboardingMainFrame({ senderId: 42, senderFrameRoutingId: 7 }, current), true);
  for (const sender of [{ senderId: 41, senderFrameRoutingId: 7 }, { senderId: 42, senderFrameRoutingId: 8 },
    { senderId: 42, senderFrameRoutingId: null }]) assert.equal(isCurrentOnboardingMainFrame(sender, current), false);
  assert.equal(isCurrentOnboardingMainFrame({ senderId: 42, senderFrameRoutingId: 7 }, null), false);
});

test('configured availability requires one exact selected effective brain, not another connected account', () => {
  for (const brain of ['api_key', 'claude_oauth', 'codex_oauth']) {
    assert.equal(onboardingModelConfigured(settings(brain, `${brain}:controlled-model`)), true);
  }
  const duplicate = settings();
  duplicate.modelRoles.brainOptions.push({ ...duplicate.modelRoles.brainOptions[0]! });
  const wrongClass = settings();
  wrongClass.modelRoles.brainOptions[0]!.id = 'claude_oauth';
  const anotherConnected = settings('codex_oauth', 'codex_oauth:missing', false);
  anotherConnected.modelRoles.brainOptions.push({ id: 'api_key', value: 'api_key:controlled-model', modelId: 'controlled-model', available: true });
  const wrongResolvedModel = settings();
  wrongResolvedModel.modelRoles.roles.brain.modelId = 'different-controlled-model';
  const wrongOptionModel = settings();
  wrongOptionModel.modelRoles.brainOptions[0]!.modelId = 'different-controlled-model';
  for (const snapshot of [undefined, {}, { modelRoles: {} }, settings('foreign', 'foreign:model'),
    settings('api_key', ''), settings('api_key', ' api_key:model'), settings('api_key', 'api_key:model', 'true'),
    settings('api_key', 'api_key:model', false), duplicate, wrongClass, anotherConnected, wrongResolvedModel, wrongOptionModel]) {
    assert.equal(onboardingModelConfigured(snapshot), false);
  }
});

test('a connected completion writes only the existing marker and retry preserves exact bytes without reading settings again', async () => {
  const dependencies = ports();
  assert.equal(setup.needsSetup(), true);
  assert.deepEqual(await completeNativeOnboarding({}, dependencies), { ok: true });
  assert.equal(setup.needsSetup(), false);
  assert.equal(setup.loadSetupRecord()?.configured.auth, 'connected');
  const original = readFileSync(marker, 'utf8');
  assert.deepEqual(await completeNativeOnboarding({ exploreWithoutModel: true }, dependencies), { ok: true });
  assert.equal(readFileSync(marker, 'utf8'), original);
  assert.deepEqual(dependencies.counts(), { reads: 1, writes: 1 });
});

test('unavailable, contradictory or unreadable settings cannot mark a new installation complete', async () => {
  for (const snapshot of [undefined, settings('api_key', 'api_key:model', false),
    { modelRoles: { effectiveBrain: 'api_key', effectiveBrainValue: 'api_key:missing',
      brainOptions: [{ id: 'api_key', value: 'api_key:other', available: true }] } }]) {
    const dependencies = ports(snapshot);
    // The undefined snapshot is intentional, not ports()'s default fixture.
    dependencies.readSettings = async () => snapshot;
    await assert.rejects(completeNativeOnboarding({}, dependencies), /Connect and select a model/);
    assert.equal(setup.hasCompletedSetup(), false);
    assert.equal(dependencies.counts().writes, 0);
  }
  const dependencies = ports();
  dependencies.readSettings = async () => { throw new Error('Controlled settings read failure'); };
  await assert.rejects(completeNativeOnboarding({}, dependencies), /Controlled settings read failure/);
  assert.equal(setup.hasCompletedSetup(), false);
});

test('only an explicit boolean exploration choice skips model setup without a settings request', async () => {
  const dependencies = ports();
  dependencies.readSettings = async () => { throw new Error('Exploration must not request model settings'); };
  for (const payload of [null, [], { exploreWithoutModel: 'true' }, { exploreWithoutModel: 1 },
    { exploreWithoutModel: null }, { brainOptions: [{ available: true }] }]) {
    await assert.rejects(completeNativeOnboarding(payload, dependencies), /Choose whether/);
    assert.equal(setup.hasCompletedSetup(), false);
  }
  assert.deepEqual(await completeNativeOnboarding({ exploreWithoutModel: true }, dependencies), { ok: true });
  assert.equal(setup.loadSetupRecord()?.configured.auth, 'skipped');
  assert.deepEqual(dependencies.counts(), { reads: 0, writes: 1 });
});

test('an inherited exploration flag is not an explicit owner choice', async () => {
  const dependencies = ports(settings('api_key', 'api_key:unavailable', false));
  await assert.rejects(completeNativeOnboarding(Object.create({ exploreWithoutModel: true }), dependencies), /Connect and select a model/);
  assert.deepEqual(dependencies.counts(), { reads: 1, writes: 0 });
  assert.equal(setup.hasCompletedSetup(), false);
});

test('legacy completed setup is retained without relabeling or changing saved selections', async () => {
  setup.writeSetupComplete({ configured: { auth: 'codex', discord: true, composio: true, workspaceCount: 2, profileSet: true } });
  const original = readFileSync(marker, 'utf8');
  const dependencies = ports();
  assert.deepEqual(await completeNativeOnboarding({}, dependencies), { ok: true });
  assert.equal(readFileSync(marker, 'utf8'), original);
  assert.deepEqual(dependencies.counts(), { reads: 0, writes: 0 });
});

test('a pending connected check cannot overwrite an exploration decision retained while it waited', async () => {
  let resolveSettings!: (value: unknown) => void;
  const dependencies = ports();
  dependencies.readSettings = () => new Promise(resolve => { resolveSettings = resolve; });
  const checking = completeNativeOnboarding({}, dependencies);
  await completeNativeOnboarding({ exploreWithoutModel: true }, dependencies);
  const retained = readFileSync(marker, 'utf8');
  resolveSettings(settings());
  assert.deepEqual(await checking, { ok: true });
  assert.equal(readFileSync(marker, 'utf8'), retained);
  assert.equal(setup.loadSetupRecord()?.configured.auth, 'skipped');
  assert.equal(dependencies.counts().writes, 1);
});

test('the actual native entry routes first runs through daemon-backed onboarding and exposes no restart or model rewrite in completion', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8');
  const boot = main.slice(main.indexOf('async function boot()'), main.indexOf('function saveDiagnosticsForSupport()'));
  assert.match(boot, /await launchDaemon\(\)/);
  assert.doesNotMatch(boot, /openSetupWindow\(/);
  assert.equal((main.match(/createMainWindow\(initialDesktopDashboardUrl\(dashboardUrl, needsSetup\(\)\)\)/g) ?? []).length, 2,
    'initial load and window recreation both retain unfinished onboarding');
  assert.match(main, /win\.loadURL\(initialDesktopDashboardUrl\(nextUrl, needsSetup\(\)\)\)/,
    'daemon restart retains unfinished onboarding without replacing the canonical base URL');
  const completion = main.slice(main.indexOf("ipcMain.handle('clemmy:onboarding-complete'"), main.indexOf("ipcMain.handle('clemmy:setup-status'"));
  assert.match(completion, /assertIpcSender\(evt, \['dashboard'\]\)/);
  assert.match(completion, /isCurrentOnboardingMainFrame/);
  assert.match(completion, /fetchDaemonJson\('\/api\/console\/settings'/);
  assert.match(completion, /completeNativeOnboarding/);
  assert.doesNotMatch(completion, /launchDaemon|restart|setHomeEnv|AUTH_MODE|setCredential|setupSkip/);
  assert.match(preload, /onboardingComplete:[\s\S]*?ipcRenderer\.invoke\('clemmy:onboarding-complete', payload\)/);
});
