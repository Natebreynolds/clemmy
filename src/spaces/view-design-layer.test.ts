/**
 * Run: npx tsx --test src/spaces/view-design-layer.test.ts
 *
 * The framework design layer every served Workspace view carries: tokens for
 * both themes, a zero-specificity base, the `.clem-*` vocabulary, and a pure
 * helper kit that escapes everything it interpolates and never reaches the
 * network. Evaluated in a bare sandbox, exactly as the bridge runs it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  CLEM_VIEW_DESIGN_STYLE,
  CLEM_VIEW_DESIGN_STYLE_ID,
  CLEM_VIEW_KIT_JS,
  clemViewDesignLayer,
} from './view-design-layer.js';

type Kit = {
  fmt: Record<string, (...args: unknown[]) => string | number | null>;
  ui: Record<string, (...args: unknown[]) => string>;
  sources: () => Array<Record<string, unknown>>;
  theme: () => { name: string; isDark: boolean };
};

/** Browsers drop a trailing ".0" in compact notation ("$160K") where Node
 *  prints "$160.0K"; the kit must be right under both. */
const BrowserCompactIntl = {
  ...Intl,
  NumberFormat: function NumberFormat(locale?: string, options?: Intl.NumberFormatOptions) {
    const inner = new Intl.NumberFormat(locale, options);
    return { format: (value: number) => inner.format(value).replace(/\.0(?=[KMB]$)/, '') };
  },
};

function loadKit(opts: { search?: string; data?: unknown; dark?: boolean; intl?: typeof Intl } = {}): { kit: Kit; html: { theme: string | null } } {
  const html = { theme: null as string | null };
  const window: Record<string, unknown> = {
    __SPACE_DATA__: opts.data,
    matchMedia: () => ({ matches: opts.dark === true }),
  };
  const sandbox: Record<string, unknown> = {
    window,
    document: { documentElement: { getAttribute: () => html.theme, setAttribute: (_: string, v: string) => { html.theme = v; } } },
    location: { search: opts.search ?? '' },
    URLSearchParams,
    Intl: opts.intl ?? Intl,
    Date,
    Math,
    String,
    Number,
    Object,
    Array,
    parseFloat,
    parseInt,
    isFinite,
    isNaN,
  };
  vm.runInNewContext(CLEM_VIEW_KIT_JS, sandbox);
  return { kit: window.__clemKit as Kit, html };
}

test('the stylesheet carries both themes, the vocabulary, and nothing external', () => {
  assert.ok(CLEM_VIEW_DESIGN_STYLE.startsWith(`<style id="${CLEM_VIEW_DESIGN_STYLE_ID}">`));
  assert.match(CLEM_VIEW_DESIGN_STYLE, /:root\{color-scheme: light;--clem-primary:#f26419/);
  assert.match(CLEM_VIEW_DESIGN_STYLE, /@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-theme=light\]\)\{color-scheme: dark;/);
  assert.match(CLEM_VIEW_DESIGN_STYLE, /:root\[data-theme=dark\]\{color-scheme: dark;--clem-primary:#ff7a45/);
  for (const cls of ['.clem-app', '.clem-kpis', '.clem-kpi', '.clem-grid', '.clem-card', '.clem-section', '.clem-list', '.clem-item', '.clem-table', '.clem-tag-ok', '.clem-btn-primary', '.clem-empty', '.clem-pending', '.clem-src', '.clem-dot-danger']) {
    assert.ok(CLEM_VIEW_DESIGN_STYLE.includes(cls), `${cls} is part of the vocabulary`);
  }
  // Base rules are zero-specificity so any authored rule still wins.
  assert.match(CLEM_VIEW_DESIGN_STYLE, /:where\(body\)\{margin:0;background:var\(--clem-bg-canvas\)/);
  assert.doesNotMatch(CLEM_VIEW_DESIGN_STYLE, /url\(|@import|https?:/, 'inline only; the view CSP blocks the rest');
  assert.ok(Buffer.byteLength(CLEM_VIEW_DESIGN_STYLE) < 12_000, 'the layer stays small');
  const layer = clemViewDesignLayer();
  assert.ok(layer.indexOf('<script>') < layer.indexOf('<style'), 'kit precedes style so the theme attribute lands before styles resolve');
});

test('the kit is pure: formatting, escaping helpers, and no network surface', () => {
  const { kit } = loadKit();
  assert.doesNotMatch(CLEM_VIEW_KIT_JS, /fetch\(|XMLHttpRequest|WebSocket|postMessage|innerHTML|document\.write/);
  assert.equal(kit.fmt.esc('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
  assert.equal(kit.fmt.number(1234567.891), '1,234,568');
  assert.equal(kit.fmt.number('n/a'), '—');
  assert.match(String(kit.fmt.money(1250000)), /^\$1\.[23]M$/);
  assert.match(String(kit.fmt.money(85000)), /^\$85K$/);
  const browserKit = loadKit({ intl: BrowserCompactIntl as unknown as typeof Intl }).kit;
  for (const [amount, shown] of [[160000, '$160K'], [159999.99, '$160K'], [130000.01, '$130K'], [100000, '$100K'], [250000, '$250K'], [12849.98, '$12.8K']] as const) {
    assert.equal(kit.fmt.money(amount), shown, `compact money keeps every digit of ${amount}`);
    assert.equal(browserKit.fmt.money(amount), shown, `compact money keeps every digit of ${amount} as a browser formats it`);
  }
  assert.equal(kit.fmt.money(1234.4), '$1,234');
  assert.equal(kit.fmt.money(null), '—');
  assert.equal(kit.fmt.plural(1, 'deal'), '1 deal');
  assert.equal(kit.fmt.plural(3, 'deal'), '3 deals');
  assert.equal(kit.fmt.plural(2, 'opportunity', 'opportunities'), '2 opportunities');
  assert.equal(kit.fmt.truncate('the quick brown fox jumps', 12), 'the quick…');
  assert.equal(kit.fmt.initials('Dana Lee'), 'DL');
  const now = new Date('2026-09-16T20:00:00Z');
  assert.equal(kit.fmt.relative(new Date(now.getTime() - 5 * 60_000).toISOString(), now), '5m ago');
  assert.equal(kit.fmt.relative(new Date(now.getTime() + 3 * 86_400_000).toISOString(), now), 'in 3d');
  assert.equal(kit.fmt.relative('garbage'), '—');
  assert.equal(kit.fmt.daysUntil(new Date(now.getTime() + 2 * 86_400_000), now), 2);
  assert.equal(kit.fmt.daysUntil(null), null);
  assert.match(String(kit.fmt.date('2026-09-16T12:00:00', 'long')), /^Wed, Sep 16/);
});

test('ui helpers render the vocabulary and escape every interpolated field', () => {
  const { kit } = loadKit({ data: { _meta: { emails: { ok: true, refreshedAt: new Date().toISOString() }, sf: { ok: false, error: 'No default org <found>', refreshedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() } } } });
  const hostile = '<img src=x onerror=alert(1)>';
  assert.equal(kit.ui.tag(hostile, 'ok'), '<span class="clem-tag clem-tag-ok">&lt;img src=x onerror=alert(1)&gt;</span>');
  const kpis = kit.ui.kpis([{ label: 'Open', value: 41, hint: hostile, tone: 'warn' }]);
  assert.match(kpis, /class="clem-kpi clem-kpi-warn"/);
  assert.ok(!kpis.includes('<img'), 'hint is escaped');
  const list = kit.ui.list([
    { title: hostile, meta: '2d', body: 'b', tags: ['x', { text: 'y', tone: 'danger' }], urgent: true, href: 'javascript:alert(1)' },
  ]);
  assert.ok(!list.includes('<img'), 'title is escaped');
  assert.match(list, /clem-item clem-item-urgent/);
  assert.match(list, /clem-tag clem-tag-danger">y/);
  assert.equal(kit.ui.list([], { empty: 'No emails', emptyHint: 'Inbox zero' }), '<div class="clem-empty">No emails<span class="clem-empty-hint">Inbox zero</span></div>');
  const table = kit.ui.table(
    [{ name: hostile, amt: 5000 }],
    [{ key: 'name', label: 'Name' }, { label: 'Amount', align: 'right', render: (r: { amt: number }) => kit.fmt.money(r.amt) }],
  );
  assert.ok(!table.includes('<img'), 'cells are escaped by default');
  assert.match(table, /<th class="clem-right">Amount<\/th>/);
  assert.match(table, /<td class="clem-right">\$5,000<\/td>/);
  assert.equal(kit.ui.table([], [], { empty: 'none' }), '<div class="clem-empty">none</div>');
  assert.match(kit.ui.section('Deals', '<p>x</p>', { count: 3, meta: 'closing this week' }), /<h2>Deals<\/h2><span class="clem-section-count">3<\/span><span class="clem-section-meta">closing this week<\/span>/);
  assert.match(kit.ui.pending(), /clem-pending/);
  assert.match(kit.ui.error(hostile), /clem-error.*&lt;img/);
  // Source freshness is read from the planted dataset's _meta.
  const sources = kit.sources();
  // Sandbox values come from another realm; compare by value, not prototype.
  assert.equal(JSON.stringify(sources.map((s) => [s.id, s.ok, s.stale])), JSON.stringify([['emails', true, false], ['sf', false, true]]));
  const strip = kit.ui.sourceStrip();
  assert.match(strip, /clem-dot clem-dot-ok"><\/i>emails/);
  assert.match(strip, /clem-dot clem-dot-danger"><\/i>sf .*No default org &lt;found&gt;/);
  assert.equal(loadKit({ data: {} }).kit.ui.sourceStrip(), '', 'no _meta, no strip');
});

test('theme follows the shell handoff, else the system', () => {
  const dark = loadKit({ search: '?theme=dark' });
  assert.equal(dark.html.theme, 'dark', 'the ?theme= handoff lands on <html> before styles resolve');
  assert.equal(JSON.stringify(dark.kit.theme()), JSON.stringify({ name: 'dark', isDark: true }));
  const light = loadKit({ search: '?theme=light', dark: true });
  assert.equal(JSON.stringify(light.kit.theme()), JSON.stringify({ name: 'light', isDark: false }), 'an explicit choice beats the system');
  const system = loadKit({ search: '?theme=bogus', dark: true });
  assert.equal(system.html.theme, null, 'an unknown value sets nothing');
  assert.equal(JSON.stringify(system.kit.theme()), JSON.stringify({ name: 'dark', isDark: true }));
});

test('clem.rows finds the record list inside any stored source envelope; clem.pick reads a path safely', () => {
  const { kit } = loadKit();
  const rows = (kit as unknown as { rows: (v: unknown) => unknown[] }).rows;
  const pick = (kit as unknown as { pick: (v: unknown, p: string) => unknown }).pick;
  const json = (v: unknown) => JSON.stringify(v);

  // A Composio source as the refresh stores it.
  const outlook = { complete: true, result: { data: { '@odata.context': 'x', value: [{ subject: 'A' }, { subject: 'B' }] }, successful: true } };
  assert.equal(json(rows(outlook)), json([{ subject: 'A' }, { subject: 'B' }]));
  // Slack search nests the list deeper.
  const slack = { complete: true, result: { data: { ok: true, messages: { total: 2, matches: [{ text: 'hi' }, { text: 'yo' }] } } } };
  assert.equal(json(rows(slack)), json([{ text: 'hi' }, { text: 'yo' }]));
  // A reviewed CLI read stores the command's parsed JSON.
  const sf = { status: 0, result: { records: [{ Name: 'Deal' }], totalSize: 1, done: true }, warnings: [] };
  assert.equal(json(rows(sf)), json([{ Name: 'Deal' }]));
  // An older stored carrier envelope with stdout text still yields its rows.
  const envelope = { complete: true, result: { stdout: JSON.stringify(sf), exitCode: 0 } };
  assert.equal(json(rows(envelope)), json([{ Name: 'Deal' }]));
  // Plain arrays, empty lists, and shapes without a list.
  assert.equal(json(rows([{ id: 1 }])), json([{ id: 1 }]));
  assert.equal(json(rows({ complete: true, result: { data: { value: [] } } })), json([]));
  assert.equal(json(rows({ complete: true, result: { data: { count: 3 } } })), json([]));
  assert.equal(json(rows(null)), json([]));

  assert.equal(pick(outlook, 'result.data.value.1.subject'), 'B');
  assert.equal(pick(outlook, 'result.missing.deep'), undefined);
  assert.equal(pick(null, 'a.b'), undefined);
  assert.equal(json(pick({ a: 1 }, '')), json({ a: 1 }), 'an empty path returns the value itself');
});

test('text helpers decode what providers encode, and mail helpers recognise automated senders', () => {
  const { kit } = loadKit();
  const fmt = kit.fmt as unknown as Record<string, (...args: unknown[]) => string>;
  const mail = (kit as unknown as { mail: Record<string, (m: unknown) => unknown> }).mail;
  assert.equal(fmt.text('Waple &amp; Houk &#8211; Q3 &lt;draft&gt;'), 'Waple & Houk \u2013 Q3 <draft>');
  assert.equal(fmt.text('&bogus; stays'), '&bogus; stays', 'an unknown entity is left as written');
  assert.equal(
    fmt.slack('Oh nice:rolling_on_the_floor_laughing: for Acme Lawn &amp; Pest <@U1|sam> see <https://x.test|the doc> <!here> :no_such_emoji:'),
    'Oh nice\ud83e\udd23 for Acme Lawn & Pest @sam see the doc @here',
  );
  assert.equal(
    fmt.slack('\ud83c\udfaf New meeting *:bust_in_silhouette: Rep:* Dana Lee *:date: When:* 09/17 _soon_ ~old~ `code`'),
    '\ud83c\udfaf New meeting \ud83d\udc64 Rep: Dana Lee \ud83d\udcc5 When: 09/17 soon old code',
    'unicode-named emoji render and chat formatting markers are removed',
  );
  assert.equal(fmt.slack('call at 10:30:45 about snake_case_name and *'), 'call at 10:30:45 about snake_case_name and *', 'clock times and identifiers are left as written');
  assert.equal(fmt.slack('ping <@U2>', { U2: 'Dana Lee' }), 'ping @Dana Lee');
  assert.equal(fmt.slack('ping <@U3>'), 'ping @someone', 'an unresolved mention never shows a raw id');
  assert.equal(fmt.person('dana.lee'), 'Dana Lee');
  assert.equal(fmt.person('sam_ortiz@company.test'), 'Sam Ortiz');

  const from = (address: string, extra: Record<string, unknown> = {}) => ({ from: { emailAddress: { address, name: 'Sender' } }, ...extra });
  for (const address of ['notifications@github.com', 'no-reply@zoom.us', 'noreply@salesforce.com', 'mailer-daemon@example.test', 'news@vendor.test', 'updates+123@service.test']) {
    assert.equal(mail.isAutomated(from(address)), true, address);
  }
  assert.equal(mail.isAutomated(from('confluence@team.atlassian.net', { replyTo: [{ emailAddress: { address: 'noreply@atlassian.net' } }] })), true, 'a no-reply return address marks automation');
  assert.equal(mail.isAutomated(from('person@company.test', { inferenceClassification: 'other' })), true, "the mailbox's own Other classification counts");
  for (const address of ['dana.lee@company.test', 'sam@firm.test', 'newton@company.test', 'alertsmith@company.test']) {
    assert.equal(mail.isAutomated(from(address)), false, address);
  }
  assert.equal(mail.sender(from('dana.lee@company.test')), 'Sender');
  assert.equal(mail.sender({ from: { emailAddress: { address: 'dana.lee@company.test' } } }), 'Dana Lee');
});

test('clem.mail.preview shows the ask, not the signature, quoted thread, or security banner', () => {
  const { kit } = loadKit();
  const mail = (kit as unknown as { mail: Record<string, (m: unknown, max?: number) => string> }).mail;
  const from = (name: string, address: string, bodyPreview: string) => ({ from: { emailAddress: { name, address } }, bodyPreview });
  assert.equal(mail.preview(from('Sam Ortiz', 'sam@co.test', 'Sam Ortiz Director of Growth sam@co.test 555.123.4567 www.co.test 100 Main St')), '', 'a signature-only preview says nothing');
  assert.equal(
    mail.preview(from('Dana Lee', 'dana@co.test', 'These look viable, but we lack campaign detail. Could be a starting point. Thanks, Dana Lee Account Manager dana@co.test')),
    'These look viable, but we lack campaign detail. Could be a starting point.',
  );
  assert.equal(mail.preview(from('Dana Lee', 'dana@co.test', 'Can you send the Q3 numbers by Friday? From: Sam Ortiz Sent: Monday To: Dana Lee')), 'Can you send the Q3 numbers by Friday?');
  assert.equal(
    mail.preview(from('Vendor', 'v@co.test', 'Hello ZjQcmQRYFpfptBannerStart [CAUTION] *EXTERNAL* sender. Use caution with links. The renewal is ready for review.')),
    'The renewal is ready for review.',
  );
  assert.equal(mail.preview(from('Dana Lee', 'dana@co.test', 'Quick question about the &quot;Q3&quot; plan &amp; budget')), 'Quick question about the "Q3" plan & budget');
  assert.equal(mail.preview('Plain text with no message object'), 'Plain text with no message object');
  assert.ok(mail.preview(from('Dana Lee', 'dana@co.test', 'word '.repeat(80)), 40).length <= 41);
});
