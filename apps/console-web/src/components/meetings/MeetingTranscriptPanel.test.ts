import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { MeetingTranscriptPanelProps } from './MeetingTranscriptPanel';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-meeting-transcript-render-'));
test.after(() => rmSync(temporary, { recursive: true, force: true }));
const consoleRoot = fileURLToPath(new URL('../../../', import.meta.url));
const output = await build({
  stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MeetingTranscriptPanel } from './src/components/meetings/MeetingTranscriptPanel';
    export function render(props) {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => { throw new Error('Transcript rendering must not request data'); };
      try { return renderToStaticMarkup(<MeetingTranscriptPanel {...props} onFinal={() => { throw new Error('Rendering must not request a refresh'); }} />); }
      finally { globalThis.fetch = originalFetch; }
    }
  `, resolveDir: consoleRoot, loader: 'tsx', sourcefile: 'meeting-transcript-render-fixture.tsx' },
  tsconfig: path.join(consoleRoot, 'tsconfig.json'), bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', target: 'node22', logLevel: 'silent',
});
const fixtureFile = path.join(temporary, 'render.cjs');
writeFileSync(fixtureFile, output.outputFiles[0].contents);
const { render } = createRequire(import.meta.url)(fixtureFile) as { render: (props: Omit<MeetingTranscriptPanelProps, 'onFinal'>) => string };
const base = { capture: { windowId: 'controlled-window', sdkUploadId: 'controlled-upload' }, recording: true, segments: [] };

test('an unknown connection remains waiting instead of claiming capture or transcription health', () => {
  const html = render(base);
  assert.match(html, /Waiting for transcript/);
  assert.doesNotMatch(html, /Listening|Transcript connected|Recording your meeting/);
  assert.match(html, /aria-live="off"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-expanded="true"/);
});

test('a failed read keeps the readable conversation and distinguishes disconnected streaming', () => {
  const fullText = 'A complete retained line. '.repeat(300);
  const html = render({ ...base, readError: true, connection: 'disconnected', segments: [
    { id: 'saved-one', text: fullText, speaker: 'Avery', timestamp: '2026-10-17T12:00:00Z', isFinal: true },
    { id: 'unsaved-partial', text: 'Never label this saved', isFinal: false },
  ] });
  assert.ok(html.includes(fullText), 'saved words are not truncated to a teaser');
  assert.match(html, /Avery/);
  assert.match(html, /<time dateTime="2026-10-17T12:00:00Z"/);
  assert.match(html, /couldn’t refresh/);
  assert.match(html, /Live updates are interrupted/);
  assert.doesNotMatch(html, /Never label this saved|try again automatically/);
});

test('saved lines with unknown transport are not mislabeled as waiting or live-connected', () => {
  const html = render({ ...base, segments: [{ text: 'An actual retained line.' }] });
  assert.match(html, /Saved lines shown below/);
  assert.doesNotMatch(html, /Waiting for transcript|Transcript connected|Receiving transcript/);
});

test('malformed saved rows do not prevent valid retained speech from rendering', () => {
  const html = render({ ...base, segments: [null, { text: 17 }, { text: 'Retained, readable words.', speaker: {} }] } as unknown as Omit<MeetingTranscriptPanelProps, 'onFinal'>);
  assert.match(html, /Retained, readable words/);
  assert.equal((html.match(/<li\b/g) ?? []).length, 1);
});

test('large saved transcripts render a bounded latest page with discoverable earlier lines', () => {
  const html = render({ ...base, segments: Array.from({ length: 500 }, (_, n) => ({ id: `saved-${n}`, text: `Retained line ${n} ending.` })) });
  assert.equal((html.match(/<li\b/g) ?? []).length, 200);
  assert.ok(html.includes('Retained line 499 ending.'));
  assert.ok(html.includes('Retained line 300 ending.'));
  assert.ok(!html.includes('Retained line 299 ending.'));
  assert.match(html, /Earlier lines/);
  assert.match(html, /Lines 301–500 of 500/);
});

test('meeting speech remains plain content rather than HTML or an instruction to execute', () => {
  const html = render({ ...base, recording: false, segments: [{ text: '<img src=x onerror=steal()>', speaker: '<script>send()</script>' }] });
  assert.match(html, /Saved transcript/);
  assert.ok(html.includes('&lt;img src=x onerror=steal()&gt;'));
  assert.doesNotMatch(html, /<img|<script/);
});
