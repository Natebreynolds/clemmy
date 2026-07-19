/**
 * Live demonstration of the Workspace authoring-reliability contract — runs the
 * REAL space_save tool handler through each failure mode. Uses a scratch
 * CLEMENTINE_HOME (so your real gallery is untouched) but the REAL Composio
 * API key (so the action toolkit check is genuine: outlook=connected, a made-up
 * app = not connected).
 *
 *   npx tsx scripts/demo-space-contract.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Borrow the real Composio key so the toolkit-connection check is real, then
// point everything at a throwaway home.
const realEnv = path.join(os.homedir(), '.clementine-next', '.env');
if (existsSync(realEnv)) {
  for (const line of readFileSync(realEnv, 'utf-8').split('\n')) {
    const m = line.match(/^(COMPOSIO_API_KEY|COMPOSIO_USER_ID)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-contract-demo-'));
process.env.CLEMENTINE_SPACES = '1';

const { registerSpaceTools } = await import('../src/tools/space-tools.js');
const { resolveInSpace, spaceStore } = await import('../src/spaces/store.js');

type Handler = (i: Record<string, unknown>) => Promise<unknown> | unknown;
const handlers: Record<string, Handler> = {};
registerSpaceTools({ tool(n: string, _d: string, _p: unknown, h: Handler) { handlers[n] = h; } } as never);
const text = (r: unknown) => (r as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '';

function seed(slug: string, opts: { view: string; runner?: string }) {
  mkdirSync(resolveInSpace(slug, 'view'), { recursive: true });
  writeFileSync(resolveInSpace(slug, 'view/index.html'), opts.view, 'utf-8');
  if (opts.runner) {
    mkdirSync(resolveInSpace(slug, 'data'), { recursive: true });
    writeFileSync(resolveInSpace(slug, 'data/refresh.mjs'), opts.runner, 'utf-8');
  }
}
const GOOD_VIEW = `<html><script>fetch('/api/console/spaces/x/contacts'+'/data').then(r=>r.json()).then(j=>render(j.data.contacts.contacts))</script></html>`;
const ROWS = 'process.stdout.write(JSON.stringify({contacts:[{name:"Dana",email:"d@site.example"}]}))';
const EMPTY = 'process.stdout.write(JSON.stringify({contacts:[]}))';

async function run(label: string, slug: string, args: Record<string, unknown>) {
  console.log(`\n══════════ ${label} ══════════`);
  const out = text(await handlers.space_save({ slug, title: slug, ...args }));
  console.log(out);
}

async function main() {
  // A — data source with no backend → REFUSED
  seed('demo-nobackend', { view: GOOD_VIEW });
  await run('A. source with no runner/slug → REFUSE', 'demo-nobackend', {
    view_path: resolveInSpace('demo-nobackend', 'view/index.html'),
    data_sources: [{ id: 'contacts' }],
  });

  // B — runner file missing → REFUSED
  seed('demo-missing', { view: GOOD_VIEW });
  await run('B. runner file not on disk → REFUSE', 'demo-missing', {
    view_path: resolveInSpace('demo-missing', 'view/index.html'),
    data_sources: [{ id: 'contacts', runner: 'refresh.mjs' }],
  });

  // C — bad cron → REFUSED
  seed('demo-badcron', { view: GOOD_VIEW, runner: ROWS });
  await run('C. invalid cron → REFUSE', 'demo-badcron', {
    view_path: resolveInSpace('demo-badcron', 'view/index.html'),
    data_sources: [{ id: 'contacts', runner: 'refresh.mjs', schedule: 'every morning' }],
  });

  // D — send action, no confirm, unconnected app → auto-repair confirm + toolkit warning
  seed('demo-fakeapp', { view: GOOD_VIEW, runner: ROWS });
  await run('D. send to an unconnected app → auto-confirm + smoke WARNING', 'demo-fakeapp', {
    view_path: resolveInSpace('demo-fakeapp', 'view/index.html'),
    data_sources: [{ id: 'contacts', runner: 'refresh.mjs' }],
    actions: [{ id: 'send', label: 'Send', composio_slug: 'FAKEAPP_SEND_EMAIL' }],
  });

  // E — source returns 0 rows → active + gap question
  seed('demo-empty', { view: GOOD_VIEW, runner: EMPTY });
  await run('E. source returns 0 rows → active + GAP question', 'demo-empty', {
    view_path: resolveInSpace('demo-empty', 'view/index.html'),
    data_sources: [{ id: 'contacts', runner: 'refresh.mjs' }],
  });

  // F — view never references the source → gap question
  seed('demo-blindview', { view: '<html><body>no fetch, no source id</body></html>', runner: ROWS });
  await run('F. view ignores the data source → GAP question', 'demo-blindview', {
    view_path: resolveInSpace('demo-blindview', 'view/index.html'),
    data_sources: [{ id: 'contacts', runner: 'refresh.mjs' }],
  });

  // G — clean build with a real (connected) Outlook send → active, smoke passed
  seed('demo-clean', { view: GOOD_VIEW, runner: ROWS });
  await run('G. clean build (real Outlook slug) → active, smoke passed', 'demo-clean', {
    view_path: resolveInSpace('demo-clean', 'view/index.html'),
    data_sources: [{ id: 'contacts', runner: 'refresh.mjs' }],
    actions: [{ id: 'send', label: 'Send email', composio_slug: 'OUTLOOK_OUTLOOK_SEND_EMAIL' }],
  });

  // H — runner that ERRORS at runtime → creation smoke parks it PAUSED
  seed('demo-broken', { view: GOOD_VIEW, runner: 'process.stderr.write("boom: bad SOQL");process.exit(2)' });
  await run('H. runner errors at runtime → PARKED paused', 'demo-broken', {
    view_path: resolveInSpace('demo-broken', 'view/index.html'),
    data_sources: [{ id: 'contacts', runner: 'refresh.mjs' }],
  });

  console.log('\n══════════ final status of each demo space ══════════');
  for (const s of spaceStore.list(true)) console.log(` - ${s.id} → ${s.status}`);
  console.log('\n(scratch home — nothing touched your real gallery)');
}
main().catch((e) => { console.error(e); process.exit(1); });
