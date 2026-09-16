import assert from 'node:assert/strict';
import test from 'node:test';
import { compactUsageText, formatTokenCount, meterTone, presentUsageMeters, resetsInText } from './usage-presentation.js';

const now = Date.parse('2026-09-16T16:00:00Z');

test('only connected accounts get a meter, each with the windows its provider reports', () => {
  const meters = presentUsageMeters({
    codex: { connected: true, secondary: { usedPercent: 90, windowMinutes: 10080, resetAt: now + 6 * 86_400_000 }, capturedAt: now },
    claude: { connected: false },
    xai: { connected: true, requests: { limit: 600, remaining: 590 }, tokens: { limit: 12_000_000, remaining: 6_000_000 }, capturedAt: now },
    byoProviders: [
      { id: 'glm', label: 'GLM (Z.ai)', connected: true },
      { id: 'xai', label: 'xAI (Grok)', connected: true },
    ],
    spendToday: { date: '2026-09-16', byProvider: { codex: { tokens: 186_000, calls: 12 }, xai: { tokens: 186, calls: 1 } } },
  });
  assert.deepEqual(meters.map((m) => m.id), ['codex', 'xai', 'glm'], 'Claude is off; the xAI BYO row is folded into the Grok meter');

  const codex = meters[0];
  assert.deepEqual(codex.windows.map((w) => [w.label, w.usedPercent, w.tone]), [['week', 90, 'danger']]);
  assert.equal(compactUsageText(codex), 'wk 90%');
  assert.equal(meterTone(codex), 'danger');
  assert.deepEqual(codex.spend, { tokens: 186_000, calls: 12 });

  const grok = meters[1];
  assert.deepEqual(grok.windows.map((w) => [w.label, w.usedPercent, w.tone]), [['requests', 2, 'ok'], ['tokens', 50, 'ok']]);
  assert.equal(grok.windows[1].detail, '6.0M of 12M tokens left');
  assert.equal(compactUsageText(grok), 'req 2% · tok 50%');

  const glm = meters[2];
  assert.equal(glm.windows.length, 0);
  assert.match(glm.note ?? '', /does not report a limit/);
  assert.equal(compactUsageText(glm), 'connected');
});

test('a connected account with no window still shows its spend', () => {
  const [codex] = presentUsageMeters({
    codex: { connected: true },
    claude: { connected: false },
    spendToday: { date: '2026-09-16', byProvider: { codex: { tokens: 950, calls: 3 } } },
  });
  assert.equal(compactUsageText(codex), '950 today');
  assert.match(codex.note ?? '', /first Codex answer/);
});

test('Claude carries 5h, week and an active model-scoped week', () => {
  const [claude] = presentUsageMeters({
    codex: { connected: false },
    claude: {
      connected: true,
      fiveHour: { usedPercent: 71, resetAt: now + 90 * 60_000 },
      weekly: { usedPercent: 12 },
      scopedWeekly: { usedPercent: 40, active: true, modelLabel: 'Opus' },
    },
  });
  assert.deepEqual(claude.windows.map((w) => [w.label, w.usedPercent, w.tone]), [['5h', 71, 'warning'], ['week', 12, 'ok'], ['Opus week', 40, 'ok']]);
  assert.equal(compactUsageText(claude), '5h 71% · wk 12%');
  assert.equal(resetsInText(claude.windows[0].resetAt, now), 'resets in 1h 30m');
});

test('formatting is short and honest', () => {
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(950), '950');
  assert.equal(formatTokenCount(1_500), '1.5k');
  assert.equal(formatTokenCount(186_000), '186k');
  assert.equal(formatTokenCount(1_200_000), '1.2M');
  assert.equal(resetsInText(undefined, now), null);
  assert.equal(resetsInText(now - 1, now), 'resets now');
  assert.equal(resetsInText(now + 3 * 86_400_000, now), 'resets in 3d');
});
