import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { FromClem } from '../../lib/from-clem.js';

// Render the actual component, without browser globals, API requests or mocked
// presentation functions. Bundling shares one React/context instance and resolves
// the same console aliases as the shipped screen; only a disposable module is written.
const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-from-clem-render-'));
test.after(() => rmSync(temporary, { recursive: true, force: true }));
const consoleRoot = fileURLToPath(new URL('../../../', import.meta.url));
const output = await build({
  stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { FromClemPane } from './src/components/home/FromClemPane';
    export function render(props) {
      const client = new QueryClient();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => { throw new Error('Rendering must not request data'); };
      try {
        return renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}>
          <FromClemPane headingId="controlled-from-clem" onRetry={() => { throw new Error('Rendering must not retry'); }} {...props} />
        </QueryClientProvider></MemoryRouter>);
      } finally { globalThis.fetch = originalFetch; client.clear(); }
    }
  `, resolveDir: consoleRoot, loader: 'tsx', sourcefile: 'from-clem-render-fixture.tsx' },
  tsconfig: path.join(consoleRoot, 'tsconfig.json'), bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', target: 'node22', logLevel: 'silent',
});
const fixtureFile = path.join(temporary, 'render.cjs');
writeFileSync(fixtureFile, output.outputFiles[0].contents);
const { render } = createRequire(import.meta.url)(fixtureFile) as {
  render: (props: { data?: FromClem; loading: boolean; error: boolean }) => string;
};

function snapshot(): FromClem {
  return { rows: [], pulses: [], covers: { questionIds: [], planProposalIds: [], notificationIds: [] } };
}
function historyIn(html: string): string {
  const details = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/g) ?? [];
  assert.equal(details.length, 1, 'quiet history has one native disclosure');
  assert.doesNotMatch(details[0], /^<details\b[^>]*\bopen(?:[\s=>])/);
  assert.match(details[0], /<summary\b/);
  return details[0];
}

test('cached empty refresh failures remain visibly stale, including a subsequent loading state', () => {
  for (const loading of [false, true]) {
    const html = render({ data: snapshot(), error: true, loading });
    assert.match(html, /Couldn’t refresh what Clem noticed/);
    assert.match(html, /Showing the last saved reading/);
    assert.match(html, /<button[^>]*>Try again<\/button>/);
    assert.match(html, /No updates in the last saved reading/);
    assert.doesNotMatch(html, /right now|Nothing new from Clem/);
  }
});

test('a cached update and its exact conversation link survive a refresh failure', () => {
  const data = snapshot();
  data.rows.push({ key: 'controlled-update', heartbeat: 'noticing', heartbeatTitle: 'Controlled check',
    at: '2026-10-17T18:00:00Z', asks: false, text: 'Controlled retained update', voiceDigest: 'controlled-digest',
    handoff: { state: 'needs_attention', sessionId: 'sess-controlled', reason: 'Controlled continuation needs attention.' } });
  const html = render({ data, error: true, loading: false });
  assert.match(html, /Showing the last saved reading/);
  assert.match(html, /Controlled retained update/);
  assert.match(html, /Controlled continuation needs attention/);
  assert.match(html, /href="\/chat\/harness%3Asess-controlled"/);
  assert.match(html, /Open conversation/);
});

test('quiet heartbeat history stays mounted inside a closed native disclosure', () => {
  const data = snapshot();
  data.pulses.push({ heartbeat: 'controlled-history', title: 'Controlled historical check', enabled: true,
    lastAt: '2026-10-17T18:00:00Z', summary: 'Controlled retained summary',
    presentation: { state: 'scheduled', lastCheck: { state: 'recorded', at: '2026-10-17T18:00:00Z' } } });
  const html = render({ data, error: false, loading: false });
  const history = historyIn(html);
  assert.match(history, /Controlled historical check/);
  assert.match(history, /Last check recorded/);
  assert.match(history, /Controlled retained summary/);
  assert.doesNotMatch(html.replace(history, ''), /Controlled historical check/);
});

test('live and uncertain heartbeat states remain visible outside quiet history', () => {
  const data = snapshot();
  data.pulses.push({ heartbeat: 'quiet', title: 'Quiet fixture', enabled: true,
    presentation: { state: 'scheduled', lastCheck: { state: 'recorded' } } });
  for (const state of ['checking', 'due', 'failed', 'partial', 'unknown'] as const) {
    data.pulses.push({ heartbeat: state, title: `Visible ${state}`, enabled: true,
      presentation: { state, lastCheck: { state: 'recorded' } } });
  }
  data.pulses.push({ heartbeat: 'missing', title: 'Visible unavailable', enabled: null, availability: 'unavailable' });
  data.pulses.push({ heartbeat: 'prior-failure', title: 'Visible prior failure', enabled: true,
    presentation: { state: 'scheduled', lastCheck: { state: 'failed' } } });
  const html = render({ data, error: false, loading: false });
  const history = historyIn(html);
  const visible = html.replace(history, '');
  for (const title of ['checking', 'due', 'failed', 'partial', 'unknown', 'unavailable', 'prior failure']) {
    assert.ok(visible.includes(`Visible ${title}`), `${title} must not disappear into quiet history`);
    assert.ok(!history.includes(`Visible ${title}`));
  }
  assert.match(visible, /Status unavailable/);
});

test('an unreadable first snapshot shows recovery rather than empty or loading claims', () => {
  const html = render({ error: true, loading: true });
  assert.match(html, /role="alert"/);
  assert.match(html, /Couldn’t load what Clem noticed/);
  assert.match(html, /Retry/);
  assert.doesNotMatch(html, /Nothing new|No updates|Background check history/);
});

test('fresh decision controls keep their existing choices and quiet history remains separate', () => {
  const data = snapshot();
  data.rows.push({ key: 'controlled-decision', heartbeat: 'controlled', heartbeatTitle: 'Controlled check',
    at: '2026-10-17T18:00:00Z', asks: true, text: 'Controlled owner decision', voiceDigest: 'controlled-digest',
    answer: { kind: 'yes_no', planProposalId: 'controlled-plan' } });
  data.pulses.push({ heartbeat: 'quiet', title: 'Quiet retained check', enabled: true,
    presentation: { state: 'scheduled', lastCheck: { state: 'recorded' } } });
  const html = render({ data, error: false, loading: false });
  assert.match(html, /Controlled owner decision/);
  assert.match(html, /<button[^>]*>Yes<\/button>/);
  assert.match(html, /<button[^>]*>No<\/button>/);
  assert.match(historyIn(html), /Quiet retained check/);
  assert.doesNotMatch(html, /Showing the last saved reading/);
});
