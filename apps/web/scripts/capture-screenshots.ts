/**
 * Capture fresh marketing screenshots from the live Clementine console.
 *
 * Usage (from apps/web):
 *   npm run capture                 # headless, all targets
 *   npm run capture -- --headed     # headed Chromium (WebGL-safe for /memory)
 *   npm run capture -- --only=dashboard,connect
 *   npm run capture -- --skip-seed  # reuse the existing demo session
 *   npm run capture -- --keep-seed  # leave the demo session in the console
 *
 * Auth: the daemon at localhost:8520 accepts ?token=<WEBHOOK_SECRET> once,
 * then a session cookie carries the rest of the run. The secret is read from
 * the environment, ~/.clementine-next/.env (installed daemon), or the repo
 * root .env.
 *
 * Privacy: screenshots come from a LIVE instance. The demo chat is seeded
 * with curated content, the conversation sidebar is rewritten in-page to
 * curated demo titles before the chat shots, and any target can declare
 * maskSelectors (blurred via injected CSS). ALWAYS eyeball every PNG before
 * committing.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..');
const OUT_DIR = path.join(WEB_ROOT, 'public', 'screenshots');
const BASE = process.env.CLEMENTINE_BASE_URL ?? 'http://localhost:8520';
const DEMO_SESSION_ID = 'demo-landing';
/** the unified-sessions id the SPA routes on (desktop store prefix) */
const DEMO_ROUTE_ID = `desktop:${DEMO_SESSION_ID}`;

const DEMO_PROMPT =
  'What can you take off my plate this week? Keep it short — meetings, follow-ups, memory, automations.';

/** Curated sidebar rows shown in place of real conversation history. */
const DEMO_SIDEBAR: Array<{ title: string; preview: string }> = [
  { title: 'Prep me for the 2pm board call', preview: 'Done — agenda, open questions, and the latest numbers are in your notes.' },
  { title: 'Draft follow-ups from this morning', preview: 'Three drafts ready for review. Two need your sign-off before they send.' },
  { title: 'Weekly pipeline report', preview: 'Workflow finished — report delivered. 4 deals moved stage this week.' },
  { title: 'Remember: Dana prefers Tuesday mtgs', preview: 'Saved. I will route scheduling around that going forward.' },
  { title: 'Summarize the Q3 planning doc', preview: 'Key bets, owners, and risks pulled out — want it as a page?' },
  { title: 'Fix the onboarding workflow', preview: 'Diagnosed the failing step, retried with backoff — green now.' },
  { title: 'What did we decide about pricing?', preview: 'From memory: tiered launch in March, revisit usage caps after beta.' },
  { title: 'Morning briefing', preview: 'Calendar, inbox highlights, and two things that need you today.' },
];

/** Plain text — the thread renders whitespace-pre-wrap, not markdown. */
const DEMO_REPLY = [
  "Here's what I can own this week:",
  '',
  "• Meetings — I'll sit in, take notes, and have follow-ups drafted before you're back at your desk.",
  "• Follow-ups — three emails are drafted from yesterday; I'll send as soon as you approve.",
  "• Memory — I keep tracking decisions, people, and preferences, so you never have to re-explain.",
  "• Automations — your morning briefing and weekly pipeline report run on schedule; I'll flag anything that needs you.",
  '',
  'Want me to start with the follow-ups?',
].join('\n');

/** Curated workflow cards shown in place of the user's real automations. */
const DEMO_WORKFLOWS: Array<{ name: string; description: string }> = [
  { name: 'morning-briefing', description: "Every weekday at 8 AM — calendar, inbox highlights, top goals, and the two things that need you first." },
  { name: 'meeting-follow-ups', description: 'After each meeting, draft the recap and follow-up emails, then park them for your approval.' },
  { name: 'weekly-pipeline-report', description: 'Every Friday at 4 PM — pull the pipeline, summarize what moved, deliver the report to chat.' },
  { name: 'inbox-triage-hourly', description: 'Hourly 7 AM–7 PM — triage new mail, flag what needs you, file the rest.' },
  { name: 'end-of-day-wrap', description: "Daily 5 PM wrap-up — review completed work, flag urgent items, record tomorrow's intention." },
  { name: 'lead-research', description: 'On demand — research a company, score the fit, and prep a one-page brief.' },
  { name: 'invoice-chaser', description: 'Every Monday — find unpaid invoices and draft polite nudges for your approval.' },
  { name: 'content-drafts', description: 'Twice a week — turn the ideas list into rough drafts in your voice.' },
  { name: 'crm-hygiene', description: 'Nightly — dedupe contacts, fill missing fields, flag stale deals.' },
];

interface Target {
  name: string;
  route: string;
  out: string; // relative to public/
  settleMs?: number;
  waitForSelector?: string;
  maskSelectors?: string[];
  /** rewrite the conversation sidebar to curated demo content */
  rewriteSidebar?: boolean;
  /** rewrite workflow card names/descriptions to curated demo content */
  rewriteAutomate?: boolean;
  /** capture at a custom viewport (e.g. the 1200x630 OG card) */
  viewport?: { width: number; height: number; deviceScaleFactor: number };
}

const TARGETS: Target[] = [
  {
    name: 'dashboard',
    route: `/console/chat/${encodeURIComponent(DEMO_ROUTE_ID)}`,
    out: 'screenshots/dashboard.png',
    settleMs: 3000,
    rewriteSidebar: true,
  },
  {
    name: 'memory',
    // JPEG: the constellation starfield is ~2MB as PNG, ~300KB as JPEG.
    route: '/console/memory',
    out: 'screenshots/memory.jpg',
    settleMs: 6000, // three.js constellation needs time to lay out
  },
  {
    name: 'automate',
    route: '/console/automate',
    out: 'screenshots/automate.png',
    settleMs: 2500,
    rewriteAutomate: true,
  },
  {
    name: 'connect',
    route: '/console/connect',
    out: 'screenshots/connect.png',
    settleMs: 2500,
  },
  // 'spaces' (/console/workspaces) is intentionally NOT captured: the live
  // workspace cards render real client/prospect data in their previews and
  // can't be masked cleanly. The landing page uses a hand-built animated
  // SpacesPreview instead.
  {
    name: 'inbox',
    route: '/console/inbox',
    out: 'screenshots/inbox.png',
    settleMs: 2500,
  },
  {
    name: 'og',
    route: `/console/chat/${encodeURIComponent(DEMO_ROUTE_ID)}`,
    out: 'og.png',
    settleMs: 3000,
    rewriteSidebar: true,
    viewport: { width: 1200, height: 630, deviceScaleFactor: 1 },
  },
];

function readSecret(): string {
  if (process.env.WEBHOOK_SECRET) return process.env.WEBHOOK_SECRET;
  // The installed daemon reads ~/.clementine-next/.env; a source checkout
  // uses the repo root .env. Prefer whichever matches the running daemon.
  const candidates = [
    path.join(process.env.HOME ?? '', '.clementine-next', '.env'),
    path.join(REPO_ROOT, '.env'),
  ];
  for (const envPath of candidates) {
    let raw: string;
    try { raw = readFileSync(envPath, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      const match = line.match(/^WEBHOOK_SECRET=(.*)$/);
      if (match) return match[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new Error(`WEBHOOK_SECRET not found in env or ${candidates.join(', ')}`);
}

async function seedDemoSession(secret: string): Promise<void> {
  console.log(`Seeding demo chat session "${DEMO_SESSION_ID}"…`);
  const res = await fetch(`${BASE}/api/console/home/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ message: DEMO_PROMPT, sessionId: DEMO_SESSION_ID }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { text?: string };
  console.log(`  seeded (reply ${body.text?.length ?? 0} chars)`);
}

async function deleteSession(secret: string, routeId: string): Promise<void> {
  const res = await fetch(`${BASE}/api/console/sessions/${encodeURIComponent(routeId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}` },
  });
  if (res.ok) console.log(`Cleaned up seeded session ${routeId}`);
}

async function authenticate(page: Page, secret: string): Promise<void> {
  await page.goto(`${BASE}/console?token=${encodeURIComponent(secret)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
}

/**
 * Replace every real conversation row in the sidebar with curated demo
 * titles/previews. The active (demo) row keeps its real content.
 */
async function rewriteSidebar(page: Page): Promise<void> {
  await page.evaluate((rows) => {
    const items = Array.from(document.querySelectorAll('aside .group.relative'));
    let i = 0;
    for (const item of items) {
      const link = item.querySelector('a');
      const active = link?.getAttribute('aria-current') === 'page'
        || (link?.className ?? '').includes('bg-primary');
      const title = item.querySelector<HTMLElement>('span.font-semibold');
      const preview = item.querySelector<HTMLElement>('span.text-caption.text-muted');
      if (active) {
        if (preview) preview.textContent = "Here's what I can own this week: meetings, follow-ups, memory…";
        continue;
      }
      const row = rows[i % rows.length];
      i += 1;
      if (title) title.textContent = row.title;
      if (preview) preview.textContent = row.preview;
    }
  }, DEMO_SIDEBAR);
}

/**
 * Replace the assistant reply in the open thread with curated demo copy —
 * the live model's answer can reference real clients/projects.
 */
async function rewriteThread(page: Page): Promise<void> {
  await page.evaluate((reply) => {
    const bubbles = Array.from(
      document.querySelectorAll<HTMLElement>('div.bg-surface p.whitespace-pre-wrap'),
    );
    const last = bubbles[bubbles.length - 1];
    if (last) last.textContent = reply;
  }, DEMO_REPLY);
}

/**
 * Replace real workflow names/descriptions on /automate — they reference
 * real clients and internal projects.
 */
async function rewriteAutomate(page: Page): Promise<void> {
  await page.evaluate((rows) => {
    const descs = Array.from(document.querySelectorAll<HTMLElement>('button.line-clamp-3'));
    descs.forEach((desc, i) => {
      const row = rows[i % rows.length];
      const card = desc.parentElement;
      const title = card?.querySelector<HTMLElement>('button.text-h3');
      if (title) title.textContent = row.name;
      desc.textContent = row.description;
    });
  }, DEMO_WORKFLOWS);
}

async function capture(browser: Browser, secret: string, target: Target): Promise<void> {
  const viewport = target.viewport ?? { width: 1440, height: 900, deviceScaleFactor: 2 };
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.deviceScaleFactor,
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  try {
    await authenticate(page, secret);
    await page.goto(`${BASE}${target.route}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    if (target.waitForSelector) {
      await page.waitForSelector(target.waitForSelector, { timeout: 15_000 }).catch(() => {
        console.warn(`  [${target.name}] selector ${target.waitForSelector} never appeared`);
      });
    }
    if (target.maskSelectors?.length) {
      const css = target.maskSelectors.map((s) => `${s} { filter: blur(7px) !important; }`).join('\n');
      await page.addStyleTag({ content: css });
    }
    await page.waitForTimeout(target.settleMs ?? 2000);
    if (target.rewriteSidebar) {
      await rewriteSidebar(page);
      await rewriteThread(page);
    }
    if (target.rewriteAutomate) await rewriteAutomate(page);
    const outPath = path.join(WEB_ROOT, 'public', target.out);
    mkdirSync(path.dirname(outPath), { recursive: true });
    const jpeg = outPath.endsWith('.jpg') || outPath.endsWith('.jpeg');
    await page.screenshot(jpeg ? { path: outPath, type: 'jpeg', quality: 60 } : { path: outPath });
    console.log(`  [${target.name}] → public/${target.out}`);
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const headed = args.includes('--headed');
  const skipSeed = args.includes('--skip-seed');
  const keepSeed = args.includes('--keep-seed');
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? new Set(onlyArg.slice(7).split(',')) : null;
  const targets = TARGETS.filter((t) => !only || only.has(t.name));
  if (!targets.length) throw new Error('no targets matched --only filter');

  const secret = readSecret();
  const needsSeed = targets.some((t) => t.rewriteSidebar);
  if (needsSeed && !skipSeed) await seedDemoSession(secret);

  const browser = await chromium.launch({ headless: !headed });
  try {
    for (const target of targets) {
      await capture(browser, secret, target);
    }
  } finally {
    await browser.close();
  }
  if (needsSeed && !keepSeed) await deleteSession(secret, DEMO_ROUTE_ID);
  console.log('\nDone. REVIEW EVERY PNG for real client names/emails before committing:');
  console.log(`  open ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
