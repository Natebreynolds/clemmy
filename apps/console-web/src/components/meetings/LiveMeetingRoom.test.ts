import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ComponentProps } from 'react';
import type { LiveMeetingRoom } from './LiveMeetingRoom';
import type { MeetingHelpState } from '../../lib/meeting-assistance';
import type { MeetingResearchDocuments, MeetingResearchState } from '../../lib/meeting-research';

// Render the real room and both real assistance variants from cached, controlled
// snapshots. No browser, capture, API, permission or model operation is permitted.
const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-live-meeting-render-'));
test.after(() => rmSync(temporary, { recursive: true, force: true }));
const consoleRoot = fileURLToPath(new URL('../../../', import.meta.url));
const output = await build({
  stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { LiveMeetingRoom } from './src/components/meetings/LiveMeetingRoom';
    import { MeetingCompanion } from './src/components/meetings/MeetingCompanion';
    import { MeetingResearchControls } from './src/components/meetings/MeetingResearchControls';
    export function render(options) {
      const meetingId = 'controlled-meeting';
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      client.setQueryData(['meeting-assistance', meetingId], options.help);
      client.setQueryData(['meeting-research', meetingId], options.research);
      client.setQueryData(['meeting-research-documents', meetingId], options.documents);
      if (options.researchError) client.getQueryCache().find({ queryKey: ['meeting-research', meetingId] }).setState({ status: 'error', error: new Error('Controlled stale research'), fetchStatus: 'idle' });
      const originalFetch = globalThis.fetch;
      const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
      const originalWindow = globalThis.window;
      const calls = { fetch: 0, native: 0, stop: 0, refresh: 0, openLookup: 0 };
      globalThis.fetch = () => { calls.fetch++; throw new Error('Render must not call an API, provider or model'); };
      globalThis.window = { clemmy: new Proxy({}, { get: () => () => { calls.native++; throw new Error('Render must not control native capture or permissions'); } }) };
      const stop = () => { calls.stop++; throw new Error('Render must not stop a capture'); };
      const refresh = () => { calls.refresh++; throw new Error('Render must not trigger a final refresh'); };
      const openLookup = () => { calls.openLookup++; throw new Error('Render must not open a lookup automatically'); };
      try {
        let content;
        if (options.component === 'companion') content = <MeetingCompanion meetingId={meetingId} active={options.active ?? true} presentation={options.presentation ?? 'live'} />;
        else if (options.component === 'research') content = <MeetingResearchControls meetingId={meetingId} active={options.active ?? true} presentation={options.presentation ?? 'live'} onOpenLookup={openLookup} />;
        else content = <LiveMeetingRoom meetingId={meetingId} title="Controlled meeting" platform="Zoom"
          startedAt="2026-10-17T12:00:00.000Z" capture={{ windowId: 'controlled-window', sdkUploadId: 'controlled-upload' }}
          segments={[{ id: 'saved-one', text: 'A retained conversation line.', speaker: 'Avery', timestamp: '2026-10-17T12:01:00.000Z' }]}
          connection="unknown" transcriptReadError={false} statusReadError={false} deliveryIncomplete={false} busy={false}
          notes={<p>Controlled private note</p>} {...options.room} onStop={stop} onFinal={refresh} />;
        const html = renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}>{content}</QueryClientProvider></MemoryRouter>);
        return { html, calls };
      } finally {
        globalThis.fetch = originalFetch;
        if (hadWindow) globalThis.window = originalWindow; else delete globalThis.window;
        client.clear();
      }
    }
  `, resolveDir: consoleRoot, loader: 'tsx', sourcefile: 'live-meeting-render-fixture.tsx' },
  tsconfig: path.join(consoleRoot, 'tsconfig.json'), bundle: true, write: false,
  loader: { '.png': 'dataurl', '.css': 'empty' },
  plugins: [{ name: 'vite-url-imports', setup(bundler) {
    bundler.onResolve({ filter: /\?url$/ }, args => ({ path: args.path, namespace: 'url-import' }));
    bundler.onLoad({ filter: /.*/, namespace: 'url-import' }, args => ({ contents: `export default ${JSON.stringify(args.path)};`, loader: 'js' }));
  } }],
  platform: 'node', format: 'cjs', jsx: 'automatic', target: 'node22', logLevel: 'silent',
});
const fixtureFile = path.join(temporary, 'render.cjs');
writeFileSync(fixtureFile, output.outputFiles[0].contents);
interface RenderOptions {
  component?: 'room' | 'companion' | 'research';
  presentation?: 'default' | 'live';
  room?: Partial<ComponentProps<typeof LiveMeetingRoom>>;
  help: MeetingHelpState;
  research: MeetingResearchState;
  documents: MeetingResearchDocuments;
  researchError?: boolean;
  active?: boolean;
}
const { render } = createRequire(import.meta.url)(fixtureFile) as {
  render(options: RenderOptions): { html: string; calls: Record<string, number> };
};
const meetingId = 'controlled-meeting';
function fixture(): RenderOptions {
  return {
    help: { meetingId, enabled: false, version: 2, checking: false, status: 'disabled', recentOffers: [], keptOffers: [],
      retainedOfferCount: 0, omittedOfferCount: 0, heldOfferCount: 0, skippedFinalSegments: 0, finalSegmentCount: 1 },
    research: { meetingId, version: 3, enabled: false, useMemory: false, maxLookups: 3, usedLookups: 0,
      status: 'disabled', documentRefs: [], jobs: [] },
    documents: { meetingId, captureDigest: 'a'.repeat(64), snapshotVersion: 1, documents: [] },
  };
}
const plain = (html: string) => html.replace(/<[^>]*>/g, '').trim();
function button(html: string, name: string) {
  const found = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match => plain(match[2]) === name);
  assert.ok(found, `Expected an accessible ${name} button`);
  return { attributes: found[1], content: found[2] };
}
function researchDisclosure(html: string): string {
  const found = (html.match(/<details\b[^>]*>[\s\S]*?<\/details>/g) ?? []).find(detail => /<summary\b[^>]*>[\s\S]*?Research privately[\s\S]*?<\/summary>/.test(detail));
  assert.ok(found, 'Research permission has a native disclosure');
  assert.doesNotMatch(found, /^<details\b[^>]*\bopen(?:[\s=>])/);
  return found;
}
function addAnswer(data: RenderOptions, reviewState: 'reviewed' | 'disabled_by_owner' | 'not_required' | 'unverified' = 'reviewed') {
  data.research.jobs.push({ id: 'controlled-job', question: 'What changed in our saved plan?', status: 'completed', reviewState,
    task: { sessionId: 'controlled-private-answer', sourceUserSeq: 7, attemptId: 'attempt-controlled', runId: 'run-controlled', clientRequestId: 'request-controlled' } });
  data.research.usedLookups = 1;
}

test('opening room, live companion and research controls render passively with permission off', () => {
  for (const component of ['room', 'companion', 'research'] as const) {
    const result = render({ ...fixture(), component });
    assert.deepEqual(result.calls, { fetch: 0, native: 0, stop: 0, refresh: 0, openLookup: 0 });
    const permission = researchDisclosure(result.html);
    assert.match(permission, /Automatic research is off/);
    assert.match(permission, /<label\b[^>]*>[\s\S]*?<input\b[^>]*type="checkbox"[^>]*\/>General memory<\/label>/);
    assert.doesNotMatch(permission, /<input\b[^>]*type="checkbox"[^>]*\bchecked/);
    assert.match(button(permission, 'Allow private research').attributes, /\sdisabled(?:=|\s|$)/);
  }
});

test('stale capture and transcript reads retain speech without a fresh live or timer claim', () => {
  const result = render({ ...fixture(), room: { statusReadError: true, transcriptReadError: true, connection: 'unknown' } });
  assert.match(result.html, /Recording status unavailable/);
  assert.match(result.html, /recording may still be running/);
  assert.match(result.html, /A retained conversation line/);
  assert.match(result.html, /Avery/);
  assert.match(result.html, /transcript couldn’t refresh/);
  assert.doesNotMatch(result.html, />Recording<\/span>|aria-label="Recording duration|Transcript connected|Receiving transcript/);
  assert.doesNotMatch(button(result.html, 'Stop recording').attributes, /\sdisabled(?:=|\s|$)/);
  assert.deepEqual(result.calls, { fetch: 0, native: 0, stop: 0, refresh: 0, openLookup: 0 });
});

test('a completed live answer remains discoverable outside closed research permission controls', () => {
  for (const component of ['room', 'companion', 'research'] as const) {
    const data = { ...fixture(), component }; addAnswer(data);
    const { html } = render(data);
    const permission = researchDisclosure(html);
    assert.match(html, /What changed in our saved plan/);
    assert.match(html, /Answer ready/);
    assert.ok(html.indexOf('What changed in our saved plan') < html.indexOf(permission));
    assert.doesNotMatch(permission, /What changed in our saved plan|Show answer/);
    button(html, 'Show answer');
    assert.equal([...html.matchAll(/>Private lookups<\/h3>/g)].length, 1);
  }
});

test('answer review uncertainty and owner review choices remain truthful in the live surface', () => {
  for (const [reviewState, expected] of [
    ['unverified', 'The answer is available, but review couldn’t confirm it.'],
    ['disabled_by_owner', 'Review was off for this answer.'],
    ['not_required', 'Separate review wasn’t required for this answer.'],
    ['reviewed', 'Reviewed'],
  ] as const) {
    const data = { ...fixture(), component: 'companion' as const }; addAnswer(data, reviewState);
    const { html } = render(data);
    assert.ok(html.includes(expected));
    button(html, 'Show answer');
    if (reviewState !== 'reviewed') assert.doesNotMatch(html, />Reviewed<\/p>/);
  }
});

test('saved private answer is visible inline after Stop, outside permission, without mounting a conversation', () => {
  const data = { ...fixture(), component: 'companion' as const, presentation: 'default' as const, active: false };
  addAnswer(data, 'unverified');
  data.research.jobs[0]!.answer = { text: 'The source says **seven**. <script>unsafe()</script>',
    sessionId: data.research.jobs[0]!.task!.sessionId, sourceUserSeq: data.research.jobs[0]!.task!.sourceUserSeq };
  const { html, calls } = render(data);
  const permission = researchDisclosure(html);
  assert.match(html, /The source says <strong>seven<\/strong>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.ok(html.indexOf('The source says') < html.indexOf(permission));
  assert.doesNotMatch(permission, /The source says/);
  assert.match(html, /review couldn’t confirm/);
  assert.doesNotMatch(html, /Your lookup with Clem|Continue in chat/);
  assert.deepEqual(calls, { fetch: 0, native: 0, stop: 0, refresh: 0, openLookup: 0 });
});

test('narrow-view choices have distinct controlled regions and truthful selected state', () => {
  const { html } = render(fixture());
  assert.match(html, /role="group" aria-label="Meeting view"/);
  const transcript = button(html, 'Transcript');
  const companion = button(html, 'From Clem');
  assert.match(transcript.attributes, /aria-pressed="true"/);
  assert.match(companion.attributes, /aria-pressed="false"/);
  const transcriptId = transcript.attributes.match(/aria-controls="([^"]+)"/)?.[1];
  const companionId = companion.attributes.match(/aria-controls="([^"]+)"/)?.[1];
  assert.ok(transcriptId); assert.ok(companionId); assert.notEqual(transcriptId, companionId);
  assert.ok(html.includes(`<div id="${transcriptId}"`));
  assert.ok(html.includes(`<aside id="${companionId}"`));
  assert.match(button(html, 'Hide transcript').attributes, /aria-expanded="true" aria-controls="[^"]+"/);
});

test('a cached enabled permission can still be paused after its latest read fails', () => {
  const data = { ...fixture(), component: 'research' as const, researchError: true };
  data.research.enabled = true; data.research.status = 'ready';
  const { html } = render(data);
  assert.match(html, /Research couldn’t refresh/);
  assert.doesNotMatch(button(html, 'Pause research').attributes, /\sdisabled(?:=|\s|$)/);
  assert.match(button(html, 'Save research permission').attributes, /\sdisabled(?:=|\s|$)/);
});

test('the default companion keeps existing lookup, defer and dismiss choices', () => {
  const data = { ...fixture(), component: 'companion' as const, presentation: 'default' as const };
  data.help.enabled = true; data.help.status = 'offer';
  data.help.offer = { id: 'controlled-offer', digest: 'b'.repeat(64), question: 'Should we check the retained plan?', why: 'The meeting asked about a saved plan.',
    quote: 'What changed in the plan?', segmentIds: ['saved-one'], sourceDigest: 'c'.repeat(64), createdAt: 1, expiresAt: 9999999999999, state: 'open' };
  const { html, calls } = render(data);
  assert.match(html, /Clem, alongside your meeting/);
  for (const action of ['Look it up', 'After the meeting', 'Not now']) button(html, action);
  assert.deepEqual(calls, { fetch: 0, native: 0, stop: 0, refresh: 0, openLookup: 0 });
});
