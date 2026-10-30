import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ComputerDriverStatus } from '../../lib/computer-driver';
import { hasCloudBrowserSession } from '../../lib/cloud-browser';

const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-computer-dock-'));
test.after(() => rmSync(temporary, { recursive: true, force: true }));
const consoleRoot = fileURLToPath(new URL('../../../', import.meta.url));
const output = await build({
  stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
    import { ComputerDock } from './src/components/chat/ComputerDock';
    export { computerScreenUrl } from './src/lib/computer-driver';
    export function render(status, used = false, active = false) {
      const client = new QueryClient();
      if (status) client.setQueryData(['computer-driver'], status);
      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => { throw new Error('Rendering must not capture or request data'); };
      try {
        return renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={client}>
          <ComputerDock conversationId="controlled-chat" used={used} active={active}><p>conversation</p></ComputerDock>
        </QueryClientProvider></MemoryRouter>);
      } finally { globalThis.fetch = originalFetch; client.clear(); }
    }
  `, resolveDir: consoleRoot, loader: 'tsx', sourcefile: 'computer-dock-render-fixture.tsx' },
  tsconfig: path.join(consoleRoot, 'tsconfig.json'), bundle: true, write: false,
  platform: 'node', format: 'cjs', jsx: 'automatic', target: 'node22', logLevel: 'silent',
  define: { 'import.meta.env.DEV': 'false', 'import.meta.env.VITE_CLEM_TOKEN': '""' },
});
const fixtureFile = path.join(temporary, 'render.cjs');
writeFileSync(fixtureFile, output.outputFiles[0].contents);
const { render, computerScreenUrl } = createRequire(import.meta.url)(fixtureFile) as {
  render: (status?: Partial<ComputerDriverStatus>, used?: boolean, active?: boolean) => string;
  computerScreenUrl: (session?: string, now?: number) => string;
};

test('an installed driver does not advertise a computer view until connected', () => {
  for (const status of [undefined, { installed: false, connected: true, screenViewAvailable: true }, { installed: true, connected: false, screenViewAvailable: true }, { installed: true, connected: true }, { installed: true, connected: true, screenViewAvailable: false }]) {
    assert.equal(render(status), '<p>conversation</p>', 'only the conversation, untouched');
    assert.equal(render(status, true, true), '<p>conversation</p>');
  }
});

test('a connected computer is discoverable without opening or capturing its screen', () => {
  const html = render({ installed: true, connected: true, screenViewAvailable: true });
  assert.match(html, /<button[^>]*aria-expanded="false"[^>]*>[\s\S]*Computer<\/button>/);
  assert.doesNotMatch(html, /<img|computer-driver\/screen|data-computer-dock/);
  assert.doesNotMatch(html, /Mac|macOS/);
});

test('cookie-only screen requests use a real query and preserve exact chat identity', () => {
  const requested = new URL(computerScreenUrl('controlled / chat? &', 42), 'http://localhost');
  assert.equal(requested.pathname, '/api/console/computer-driver/screen');
  assert.equal(requested.searchParams.get('session'), 'controlled / chat? &');
  assert.equal(requested.searchParams.get('t'), '42');
  assert.equal(requested.searchParams.has('token'), false);
  assert.equal(computerScreenUrl(undefined, 43), '/api/console/computer-driver/screen?t=43');
});

test('idle cloud browsing stays quiet while every live or uncertain session remains reachable', () => {
  assert.equal(hasCloudBrowserSession([], 0), false);
  assert.equal(hasCloudBrowserSession([{ state: 'stopped' }, { state: 'expired' }], 0), false);
  for (const state of ['starting', 'active', 'stopping', 'uncertain'] as const) {
    assert.equal(hasCloudBrowserSession([{ state }], 0), true, state);
  }
  assert.equal(hasCloudBrowserSession([{ state: 'stopped', returnPending: true }], 0), true, 'unacknowledged viewer closure remains reachable');
  assert.equal(hasCloudBrowserSession([], 1), true, 'another open session can still be managed');
  assert.equal(hasCloudBrowserSession([], 0, true), true, 'an already open management panel retains its toggle');
});

test('the computer control is one small button the owner can hide until Clem uses the computer', () => {
  // Live 2026-10-30: "Computer · Watch your connected computer" sat across the
  // top of every chat, a calendar question included.
  const idle = render({ installed: true, connected: true, screenViewAvailable: true });
  assert.doesNotMatch(idle, /Watch your connected computer/);
  assert.match(idle, /aria-label="Hide the Computer button until Clem uses your computer"/);
  const used = render({ installed: true, connected: true, screenViewAvailable: true }, true);
  assert.match(used, /Computer<\/button>/);
  assert.doesNotMatch(used, /Hide the Computer button/, 'in a chat that used the computer it stays');
});

test('the computer view is a side panel beside the chat that opens on its own while Clem uses the computer', () => {
  // Owner 2026-10-30: "this needs to be a side pannel and should open anytime
  // clem is using the computer".
  const connected = { installed: true, connected: true, screenViewAvailable: true };
  const idle = render(connected);
  assert.doesNotMatch(idle, /data-computer-dock/, 'closed until Clem works on the computer or the owner opens it');
  const working = render(connected, true, true);
  assert.match(working, /<div class="cloud-browser-workspace is-open"><div class="cloud-browser-conversation">[\s\S]*<p>conversation<\/p><\/div><aside class="cloud-browser-panel computer-panel" aria-label="Your computer" data-computer-dock/);
  assert.match(working, /Opening the computer view/);
  assert.doesNotMatch(working, /<img|computer-driver\/screen/, 'the screen is fetched after the panel is on screen, never during render');
});
