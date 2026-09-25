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

test('the top-bar chip says the busiest window in words and admits an old reading', async () => {
  const { usageChipText, USAGE_READING_STALE_MS } = await import('./usage-presentation.js');
  const now = Date.parse('2026-09-22T12:00:00Z');
  const meter = {
    id: 'codex', label: 'Codex',
    windows: [{ id: 'week', label: 'week', usedPercent: 83, tone: 'warning' as const }],
    capturedAt: now - 50 * 3_600_000,
  };
  assert.deepEqual(usageChipText(meter, now), { text: '83% of week · 2d old', stale: true });
  assert.deepEqual(usageChipText({ ...meter, capturedAt: now - USAGE_READING_STALE_MS + 1 }, now), { text: '83% of week', stale: false });
  const claude = {
    id: 'claude', label: 'Claude', capturedAt: now,
    windows: [
      { id: 'five', label: '5h', usedPercent: 10, tone: 'ok' as const },
      { id: 'week', label: 'week', usedPercent: 38, tone: 'ok' as const },
    ],
  };
  assert.equal(usageChipText(claude, now).text, '38% of week');
});

test('a provider refusing for credit is shown as what it did, in its own words, with the page that fixes it', async () => {
  const { usageChipText, creditRefusalSentence } = await import('./usage-presentation.js');
  const since = Date.parse('2026-09-24T21:14:00Z');
  const meters = presentUsageMeters({
    codex: { connected: false },
    claude: { connected: true, weekly: { usedPercent: 20 }, capturedAt: now, billing: { url: 'https://claude.example/usage', kind: 'plan', roles: ['judge'] } },
    byoProviders: [{
      id: 'together', label: 'Together AI', connected: true,
      limits: { requests: { limit: 100, remaining: 99 }, capturedAt: now },
      billing: { url: 'https://together.example/billing', kind: 'prepaid', outOfCredit: { since, lastSeenAt: since, status: 402, detail: 'Credit limit exceeded' }, roles: ['worker', 'brain'] },
    }],
    spendToday: { date: '2026-09-24', byProvider: { together: { tokens: 1_200_000, calls: 40 } } },
  });
  const together = meters.find((m) => m.id === 'together')!;
  assert.deepEqual(together.billing, { url: 'https://together.example/billing', action: 'Add credit' });
  assert.deepEqual(together.uses, ['helps in parallel', 'does the work']);
  assert.equal(together.outOfCredit?.detail, 'Credit limit exceeded');
  assert.equal(meterTone(together), 'danger', 'a healthy request window does not hide a refusal');
  // The headline names what the provider did; it never claims a balance.
  assert.equal(compactUsageText(together), 'refusing requests');
  assert.deepEqual(usageChipText(together, now), { text: 'refusing requests', stale: false });
  assert.equal(
    creditRefusalSentence(together, () => '2:14 PM'),
    'Together AI turned down Clem’s last request at 2:14 PM: “Credit limit exceeded”. Clem uses another model where it can until Together AI answers again.',
  );
  const bare = { ...together, outOfCredit: { since, lastSeenAt: since, status: 402 } };
  assert.match(creditRefusalSentence(bare, () => '2:14 PM') ?? '', /at 2:14 PM with “payment required\.”/);
  const claude = meters.find((m) => m.id === 'claude')!;
  assert.deepEqual(claude.billing, { url: 'https://claude.example/usage', action: 'Manage plan' });
  assert.equal(creditRefusalSentence(claude, () => ''), null);
});

test('with no balance to read, the provider’s own billed spend for the month is the headline', () => {
  const [together] = presentUsageMeters({
    codex: { connected: false },
    claude: { connected: false },
    byoProviders: [{
      id: 'together', label: 'Together AI', connected: true,
      billing: { url: 'https://together.example/billing', kind: 'prepaid', monthSpend: { amount: 42.1, currency: 'USD', capturedAt: now } },
    }],
    spendToday: { date: '2026-09-24', byProvider: { together: { tokens: 1_200_000, calls: 40 } } },
  });
  assert.deepEqual(together.monthSpend, { amount: 42.1, currency: 'USD', capturedAt: now });
  assert.equal(compactUsageText(together), '$42.10 this month');
});

test('a readable balance becomes the meter line; the OpenAI key and Jev get meters when connected', async () => {
  const { formatBalance } = await import('./usage-presentation.js');
  const meters = presentUsageMeters({
    codex: { connected: false },
    claude: { connected: false },
    openai: { connected: true, billing: { url: 'https://openai.example/billing', kind: 'prepaid', roles: ['memory_search'] } },
    jev: { connected: true, billing: { url: 'https://typesafe.example/billing', kind: 'prepaid', roles: ['quick_checks'] } },
    byoProviders: [{ id: 'moonshot', label: 'Moonshot', connected: true, billing: { balance: { amount: 49.5, currency: 'USD', capturedAt: now } } }],
    spendToday: { date: '2026-09-24', byProvider: { jev: { tokens: 90_000, calls: 300 } } },
  });
  assert.deepEqual(meters.map((m) => m.id), ['moonshot', 'openai', 'jev']);
  const moonshot = meters[0];
  assert.equal(compactUsageText(moonshot), '$49.50 left');
  assert.equal(moonshot.billing, undefined, 'no page is invented for an account the daemon gave none');
  assert.deepEqual(meters[1].uses, ['memory search']);
  assert.equal(meters[2].spend?.calls, 300, 'Jev spend lands on Jev');
  assert.equal(formatBalance({ amount: 110, currency: 'cny' }), '¥110.00');
  assert.equal(formatBalance({ amount: 3, currency: 'XYZ' }), '3.00 XYZ');
  // Disconnected accounts stay off the list.
  assert.deepEqual(presentUsageMeters({ codex: { connected: false }, claude: { connected: false }, jev: { connected: false } }), []);
});
