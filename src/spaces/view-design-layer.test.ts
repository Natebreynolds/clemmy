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

function loadKit(opts: { search?: string; data?: unknown; dark?: boolean } = {}): { kit: Kit; html: { theme: string | null } } {
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
    Intl,
    Date,
    Math,
    String,
    Number,
    Object,
    Array,
    parseFloat,
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
  assert.equal(kit.fmt.money(1234.4), '$1,234');
  assert.equal(kit.fmt.money(null), '—');
  assert.equal(kit.fmt.plural(1, 'deal'), '1 deal');
  assert.equal(kit.fmt.plural(3, 'deal'), '3 deals');
  assert.equal(kit.fmt.plural(2, 'opportunity', 'opportunities'), '2 opportunities');
  assert.equal(kit.fmt.truncate('the quick brown fox jumps', 12), 'the quick…');
  assert.equal(kit.fmt.initials('Nathan Reynolds'), 'NR');
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
