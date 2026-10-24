import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { HomeToday } from '../../lib/home-data.js';

// Exercise the shipped component with controlled calendar data. Rendering must
// not fetch a calendar, mark anything read, or execute a reply.
const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-today-render-'));
test.after(() => rmSync(temporary, { recursive: true, force: true }));
const consoleRoot = fileURLToPath(new URL('../../../', import.meta.url));
const output = await build({
  stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { TodayPane } from './src/components/home/TodayPane';
    export function render(props) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => { throw new Error('Rendering must not request data'); };
      try {
        return renderToStaticMarkup(<MemoryRouter><TodayPane headingId="controlled-today"
          onRetry={() => { throw new Error('Rendering must not retry'); }} {...props} /></MemoryRouter>);
      } finally { globalThis.fetch = originalFetch; }
    }
  `, resolveDir: consoleRoot, loader: 'tsx', sourcefile: 'today-render-fixture.tsx' },
  tsconfig: path.join(consoleRoot, 'tsconfig.json'), bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', target: 'node22', logLevel: 'silent',
});
const fixtureFile = path.join(temporary, 'render.cjs');
writeFileSync(fixtureFile, output.outputFiles[0].contents);
const { render } = createRequire(import.meta.url)(fixtureFile) as {
  render: (props: { today: HomeToday; loading: boolean; error: boolean; nowMs: number; maxRows?: number }) => string;
};
const nowMs = Date.parse('2026-10-24T17:00:00Z');
function calendar(): HomeToday {
  return {
    connected: true, asOf: new Date(nowMs - 60 * 60_000).toISOString(), nextCheckAt: null, lastError: null,
    events: Array.from({ length: 8 }, (_, index) => ({
      key: `controlled-event-${index}`, title: `Controlled calendar item ${index} with a long title that remains readable`,
      startMs: nowMs + (index + 1) * 30 * 60_000, endMs: nowMs + (index + 2) * 30 * 60_000,
      allDay: false, needsReply: index === 0, attendeeCount: 4,
      location: index === 0 ? 'Controlled room with a long descriptive location' : 'https://fixture.example.test/private-meeting',
    })),
  };
}

test('calendar rows expose full text in native disclosures and preserve reply navigation', () => {
  const html = render({ today: calendar(), loading: false, error: false, nowMs });
  const details = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/g) ?? [];
  assert.equal(details.length, 6);
  assert.match(details[0], /<summary\b/);
  assert.doesNotMatch(details[0], /^<details\b[^>]*\bopen(?:[\s=>])/);
  assert.match(details[0], /Controlled calendar item 0 with a long title that remains readable/);
  assert.match(details[0], /Controlled room with a long descriptive location/);
  assert.match(details[0], /4 people/);
  assert.match(html, /href="\/inbox\?tab=needs"[^>]*>Reply needed/);
  assert.match(html, /Online/);
  assert.doesNotMatch(html, /fixture\.example\.test|private-meeting/);
});

test('the saved remainder has an accessible expansion control, with no control when all rows fit', () => {
  const props = { today: calendar(), loading: false, error: false, nowMs };
  const html = render(props);
  assert.match(html, /id="controlled-today-events"/);
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*aria-controls="controlled-today-events"[^>]*>Show 2 more<\/button>/);
  assert.doesNotMatch(html, /Controlled calendar item 6/);
  const all = render({ ...props, maxRows: 8 });
  assert.match(all, /Controlled calendar item 7/);
  assert.doesNotMatch(all, /aria-controls="controlled-today-events"/);
});

test('expansion affordances do not hide stale, failed-read, or disconnected states', () => {
  const today = calendar();
  today.lastError = 'controlled previous read failed';
  const html = render({ today, loading: false, error: false, nowMs });
  assert.match(html, /As of /);
  assert.match(html, /The last calendar read failed; this is the one before it/);
  const disconnected = render({ today: { ...today, connected: false, events: [], lastError: null }, loading: false, error: false, nowMs });
  assert.match(disconnected, /Connect a calendar/);
  assert.doesNotMatch(disconnected, /<details|Show \d+ more/);
});
