/** Real idle-loop, scroll-scrub and WebGL journey acceptance.
 * Run: npx tsx scripts/cinematic-smoke.ts http://localhost:3008
 * Focus only: CLEM_MEDIA_SCOPE=handoff npx tsx scripts/cinematic-smoke.ts <url>
 * Requires final idle+handoff assets. No screenshots or actual downloads.
 * Native hidden-tab acceptance briefly opens its own Chrome window. */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chromium, type BrowserContext, type Page } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3008';
const HANDOFF_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'short-desktop', width: 1440, height: 720 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'narrow', width: 320, height: 740 },
];
const handoffOnly = process.env.CLEM_MEDIA_SCOPE === 'handoff';
const VIEWPORTS = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 390, height: 844 }];
const BEATS = ['loop', 'memory', 'tools', 'recording', 'agents', 'spaces'] as const;
const HERO = 'section[aria-labelledby="hero-title"]';
const IDLE = 'video[data-hero-film="idle"]';
const HANDOFF = 'video[data-hero-film="handoff"]';
const WORLD = '[data-world-progress]';
const failures: string[] = [];
let passed = 0;
const isMp4 = (url: string) => /\.mp4(?:\?|$)/.test(url);
const heroMedia = (url: string) => /\/media\/(?:clem-hero-loop|clem-handoff)\.mp4(?:\?|$)/.test(url);

// Observe actual decoded frames. No media API, clock, duration or time is faked.
const observationScript = `
window.__cinematicAudit = { overlaps: [], maxPlaying: 0, wraps: 0, frames: {}, previousIdleTime: null };
const watchedVideos = new WeakSet();
function auditPlayback() {
  const active = Array.from(document.querySelectorAll('video')).filter(video => !video.paused && !video.ended);
  const audit = window.__cinematicAudit;
  audit.maxPlaying = Math.max(audit.maxPlaying, active.length);
  if (active.length > 1) audit.overlaps.push(active.map(video => video.dataset.heroFilm || video.currentSrc));
}
function watchFrames(event) {
  const video = event.target;
  if (!(video instanceof HTMLVideoElement) || watchedVideos.has(video)) return;
  watchedVideos.add(video);
  function frame(now, metadata) {
    const audit = window.__cinematicAudit;
    const role = video.dataset.heroFilm;
    audit.frames[role] = (audit.frames[role] || 0) + 1;
    if (role === 'idle') {
      if (audit.previousIdleTime !== null && metadata.mediaTime < audit.previousIdleTime - 1 && video.loop) audit.wraps++;
      audit.previousIdleTime = metadata.mediaTime;
    }
    if (video.isConnected) video.requestVideoFrameCallback(frame);
  }
  video.requestVideoFrameCallback(frame);
}
for (const name of ['play', 'playing', 'pause', 'timeupdate', 'ended']) document.addEventListener(name, auditPlayback, true);
document.addEventListener('loadeddata', watchFrames, true);
`;
function observe(page: Page, planned = new Set<string>()) {
  const errors = new Set<string>(), requests = new Set<string>(), interceptedDownloads = new Set<string>(), retiredAssets = new Set<string>();
  const responses = new Map<string, number[]>();
  const cancelledRanges: string[] = [], injectedFailures: string[] = [];
  page.on('request', request => {
    if (isMp4(request.url())) requests.add(request.url());
    if (/\/media\/clem-(?:intro(?:-start|-hold)?|world|loop|memory|tools|team|outro)\.(?:mp4|webp)(?:\?|$)/.test(request.url())) retiredAssets.add(request.url());
  });
  page.on('response', response => {
    if (isMp4(response.url())) responses.set(response.url(), [...(responses.get(response.url()) ?? []), response.status()]);
    if (response.status() >= 400) errors.add(`HTTP ${response.status()}: ${response.url()}`);
  });
  page.on('requestfailed', request => {
    const error = request.failure()?.errorText;
    if (interceptedDownloads.has(request.url()) && request.resourceType() === 'document' && error === 'net::ERR_ABORTED') return;
    if (planned.has(request.url()) && error === 'net::ERR_FAILED') injectedFailures.push(request.url());
    else if (request.resourceType() === 'media' && heroMedia(request.url()) && error === 'net::ERR_ABORTED') cancelledRanges.push(request.url());
    else errors.add(`request: ${request.url()} — ${error}`);
  });
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (planned.has(message.location().url) && message.text().includes('net::ERR_FAILED')) return;
    errors.add(`console: ${message.text()} (${message.location().url})`);
  });
  page.on('pageerror', error => errors.add(`page: ${error.message}`));
  return { errors, requests, responses, cancelledRanges, injectedFailures, interceptedDownloads, retiredAssets };
}
type Audit = ReturnType<typeof observe>;
async function check(name: string, test: () => Promise<void>) {
  try { await test(); passed++; console.log(`PASS ${name}`); }
  catch (error) { const failure = `${name}: ${error instanceof Error ? error.message : String(error)}`; failures.push(failure); console.error(`FAIL ${failure}`); }
}
async function open(page: Page) {
  page.setDefaultTimeout(12000);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll('video[data-hero-film]').length === 2);
  await page.evaluate(() => document.fonts.ready);
}
async function heroProgress(page: Page, progress: number) {
  await page.locator(HERO).evaluate((hero, progress) => {
    const bounds = hero.getBoundingClientRect();
    const stage = hero.firstElementChild as HTMLElement;
    window.scrollTo({ top: scrollY + bounds.top + (bounds.height - stage.clientHeight) * progress, behavior: 'instant' });
  }, progress);
  await page.waitForFunction(progress => Math.abs(Number(document.querySelector('section[aria-labelledby="hero-title"]')?.getAttribute('data-hero-progress')) - progress) < 0.01, progress);
}
async function journeyProgress(page: Page, progress: number) {
  await page.locator('#journey').evaluate((section, progress) => {
    if (section.getAttribute('data-layout') === 'flow') {
      const articles = [...section.querySelectorAll<HTMLElement>('[data-story-beat]')];
      const index = Math.min(articles.length - 1, Math.floor(progress * articles.length));
      const bounds = articles[index].getBoundingClientRect();
      const portion = progress * articles.length - index;
      window.scrollTo({ top: scrollY + bounds.top + bounds.height * portion - innerHeight * .36, behavior: 'instant' });
    } else {
      const bounds = section.getBoundingClientRect();
      window.scrollTo({ top: scrollY + bounds.top + (bounds.height - innerHeight) * progress, behavior: 'instant' });
    }
  }, progress);
  await page.waitForFunction(progress => Math.abs(Number(document.querySelector('#journey')?.getAttribute('data-journey-progress')) - progress) < 0.005, progress);
}
async function settledWorld(page: Page) {
  // Acceptance waits for the smoothed camera to catch native scroll, then proves
  // it stops drawing. No expected easing formula or fixed intermediate frame.
  await page.waitForFunction(() => {
    const source = Number(document.querySelector('#journey')?.getAttribute('data-journey-progress'));
    const world = document.querySelector('[data-world-progress]');
    return world?.getAttribute('data-world-state') === 'ready' && Math.abs(Number(world.getAttribute('data-world-progress')) - source) < .00015;
  });
  await frames(page, 12);
}
async function advanceIdle(page: Page, baseline?: number) {
  const from = baseline ?? await page.locator(IDLE).evaluate((video: HTMLVideoElement) => video.currentTime);
  await page.waitForFunction(from => {
    const video = document.querySelector<HTMLVideoElement>('video[data-hero-film="idle"]');
    return video && !video.paused && !video.error && video.readyState >= 2 && video.videoWidth > 0 && video.currentTime > from + 0.15;
  }, from, { timeout: 15000, polling: 50 });
}
async function allPaused(page: Page) {
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>('video')].every(video => video.paused), undefined, { polling: 50 });
}
async function frames(page: Page, count = 18) {
  await page.evaluate(`new Promise(resolve => { let ticks = 0; function frame() { if (++ticks >= ${count}) resolve(); else requestAnimationFrame(frame); } requestAnimationFrame(frame); })`);
}
async function frozen(page: Page, clock = page) {
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLVideoElement>('video')].every(video => !video.seeking), undefined, { polling: 50 });
  const before = await page.locator('video').evaluateAll(videos => videos.map(video => (video as HTMLVideoElement).currentTime));
  await frames(clock);
  const after = await page.locator('video').evaluateAll(videos => videos.map(video => (video as HTMLVideoElement).currentTime));
  after.forEach((value, index) => assert.ok(Math.abs(value - before[index]) < 0.04, `Paused film advanced ${before[index]} → ${value}`));
}
async function noOverflow(page: Page) {
  assert.ok(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= document.documentElement.clientWidth + 1), 'Horizontal overflow');
}
async function healthy(page: Page, audit: Audit, label: string, requireDecoded: boolean) {
  assert.equal(await page.locator('video').count(), 2);
  assert.equal(await page.locator(`${HERO} video`).count(), 2, 'A dog video escaped the opening');
  assert.equal(await page.locator('[data-cinematic-scene]:not([data-cinematic-scene="intro"]):not([data-cinematic-scene="handoff"])').count(), 0, 'Retired chapter media remains mounted');
  assert.deepEqual([...audit.retiredAssets], [], 'Retired dog chapter assets were requested');
  for (const request of audit.requests) assert.ok(heroMedia(request), `Unexpected chapter MP4 request: ${request}`);
  const media = await page.locator('video').evaluateAll(elements => elements.map(element => {
    const video = element as HTMLVideoElement;
    return { role: video.dataset.heroFilm, width: video.videoWidth, height: video.videoHeight, duration: video.duration, time: video.currentTime, error: video.error && { code: video.error.code, message: video.error.message } };
  }));
  for (const video of media) {
    assert.equal(video.error, null, `Decoder failure: ${JSON.stringify(video)}`);
    if (requireDecoded) assert.ok(video.width > 0 && video.height > 0 && video.duration > 0, `Film not decoded: ${JSON.stringify(video)}`);
  }
  const auditState = await page.evaluate(() => (window as unknown as { __cinematicAudit: { overlaps: string[][]; maxPlaying: number; wraps: number; frames: Record<string, number> } }).__cinematicAudit);
  assert.equal(auditState.overlaps.length, 0, `Multiple auto-playing films: ${JSON.stringify(auditState.overlaps)}`);
  assert.ok(auditState.maxPlaying <= 1);
  if (requireDecoded) for (const role of ['idle', 'handoff']) assert.ok(auditState.frames[role] > 0, `No actual decoded ${role} frame observed`);
  assert.deepEqual([...audit.errors], [], 'Unexpected browser/resource errors');
  console.log(`MEDIA ${label}: ${JSON.stringify({ media, audit: auditState, requests: [...audit.requests], responses: Object.fromEntries(audit.responses), expectedRangeCancellations: audit.cancelledRanges.length })}`);
}
async function workingControls(page: Page) {
  for (const [beat, name] of [['loop', 'Verify'], ['memory', 'Correction']]) {
    if (await page.locator('#journey').getAttribute('data-layout') === 'flow') await page.locator(`[data-story-beat="${beat}"]`).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    else await journeyProgress(page, beat === 'loop' ? 0.08 : 0.22);
    const button = page.locator(`[data-story-beat="${beat}"]`).getByRole('button', { name, exact: true }); await button.click(); assert.equal(await button.getAttribute('aria-pressed'), 'true');
  }
}
async function workingDownload(page: Page, audit: Audit) {
  await page.route('**/api/download?arch=arm64', route => { audit.interceptedDownloads.add(route.request().url()); return route.fulfill({ status: 204 }); });
  const [request] = await Promise.all([page.waitForRequest(request => new URL(request.url()).pathname === '/api/download'), page.locator('main a[href="/api/download?arch=arm64"]').last().click()]);
  assert.equal(new URL(request.url()).searchParams.get('arch'), 'arm64');
}
async function normal(context: BrowserContext, label: string) {
  await context.addInitScript(observationScript);
  const page = await context.newPage(); const audit = observe(page); await open(page);
  await check(`${label}: only the two hero films are present`, async () => {
    assert.equal(await page.locator('video').count(), 2); assert.equal(await page.locator(`${HERO} video`).count(), 2);
    assert.equal(await page.locator(IDLE).getAttribute('loop'), ''); assert.equal(await page.locator(HANDOFF).getAttribute('loop'), null);
    assert.equal(await page.locator('#journey video, #console video, #download video').count(), 0);
    assert.ok(await page.locator('img[src^="/media/clem-"]').evaluateAll(images => images.every(image => Boolean(image.closest('section[aria-labelledby="hero-title"]')))), 'A character image appeared outside the hero');
    await noOverflow(page);
  });
  await check(`${label}: idle genuinely decodes and loops at rest`, async () => {
    await heroProgress(page, 0); await advanceIdle(page);
    const duration = await page.locator(IDLE).evaluate((video: HTMLVideoElement) => video.duration);
    assert.ok(Number.isFinite(duration) && duration > 0 && duration < 30);
    await page.waitForFunction(() => (window as unknown as { __cinematicAudit: { wraps: number } }).__cinematicAudit.wraps >= 1, undefined, { timeout: duration * 1000 + 8000, polling: 50 });
    assert.equal(await page.locator(HERO).getAttribute('data-hero-phase'), 'idle');
  });
  await check(`${label}: handoff seeks with scroll and reverses`, async () => {
    let midpoint = 0;
    for (const progress of [0.27, 0.52, 0.27]) {
      await heroProgress(page, progress);
      await page.waitForFunction(progress => {
        const video = document.querySelector<HTMLVideoElement>('video[data-hero-film="handoff"]');
        if (!video || video.error || video.readyState < 2 || video.videoWidth === 0 || video.seeking) return false;
        const expected = Math.max(0, Math.min(1, (progress - 0.04) / 0.66)) * video.duration;
        return Math.abs(video.currentTime - expected) < 0.25;
      }, progress, { polling: 50 });
      assert.ok(await page.locator(HANDOFF).evaluate((video: HTMLVideoElement) => video.paused), 'Scroll-scrub footage started autonomous playback');
      assert.ok(await page.locator(IDLE).evaluate((video: HTMLVideoElement) => video.paused), 'Idle dog kept playing behind the handoff');
      const current = await page.locator(HANDOFF).evaluate((video: HTMLVideoElement) => video.currentTime);
      if (progress === 0.52) midpoint = current;
      else if (midpoint) assert.ok(current < midpoint - 1, 'Reverse scroll did not reverse the handoff');
    }
  });
  await check(`${label}: paper gives way to one continuous rendered journey`, async () => {
    await heroProgress(page, 0.85); assert.equal(await page.locator(HERO).getAttribute('data-hero-phase'), 'paper');
    await journeyProgress(page, 0.12);
    await page.waitForFunction(() => document.querySelector('canvas[data-world-ready="true"]'));
    await page.waitForFunction(() => Math.abs(Number(document.querySelector('[data-world-progress]')?.getAttribute('data-world-progress')) - 0.12) < 0.01);
    await settledWorld(page);
    const firstCamera = await page.locator(WORLD).getAttribute('data-world-camera');
    const firstFrame = Number(await page.locator(WORLD).getAttribute('data-world-frame'));
    let previousCamera = firstCamera;
    for (let index = 1; index < BEATS.length; index++) {
      await journeyProgress(page, (index + .32) / BEATS.length); await settledWorld(page);
      assert.equal(await page.locator('#journey').getAttribute('data-journey-stage'), BEATS[index]);
      assert.notEqual(await page.locator(WORLD).getAttribute('data-world-camera'), previousCamera, `Camera did not move into ${BEATS[index]}`);
      previousCamera = await page.locator(WORLD).getAttribute('data-world-camera');
    }
    assert.ok(Number(await page.locator(WORLD).getAttribute('data-world-frame')) > firstFrame);
    await journeyProgress(page, 0.12); await settledWorld(page);
    await page.waitForFunction(camera => document.querySelector('[data-world-progress]')?.getAttribute('data-world-camera') === camera, firstCamera);
    const settledFrame = await page.locator(WORLD).getAttribute('data-world-frame'); await frames(page);
    assert.equal(await page.locator(WORLD).getAttribute('data-world-frame'), settledFrame, 'World renders continuously while native scroll is stationary');
    assert.equal(await page.locator('[data-artifact-id="working-brief"]').count(), 1); await noOverflow(page);
  });
  await check(`${label}: pause freezes the camera while every chapter remains usable`, async () => {
    await journeyProgress(page, .22); await settledWorld(page);
    await page.getByRole('button', { name: 'Pause immersive motion', exact: true }).click();
    const camera = await page.locator(WORLD).getAttribute('data-world-camera');
    await journeyProgress(page, .72); await frames(page);
    assert.equal(await page.locator(WORLD).getAttribute('data-world-camera'), camera, 'Paused camera followed scrolling');
    await page.getByRole('button', { name: 'Resume immersive motion', exact: true }).click();
    await settledWorld(page);
    assert.notEqual(await page.locator(WORLD).getAttribute('data-world-camera'), camera, 'Camera did not catch up after resume');
    await allPaused(page);
  });
  await check(`${label}: offscreen hero pauses and returns without resetting idle`, async () => {
    await allPaused(page); const retained = await page.locator(IDLE).evaluate((video: HTMLVideoElement) => video.currentTime);
    await frozen(page); await heroProgress(page, 0); await advanceIdle(page, retained);
  });
  await check(`${label}: global pause stops both time and scrub seeks`, async () => {
    await heroProgress(page, 0.35);
    await page.locator(HANDOFF).evaluate((video: HTMLVideoElement) => new Promise<void>(resolve => { if (!video.seeking) resolve(); else video.addEventListener('seeked', () => resolve(), { once: true }); }));
    await page.locator('.motion-toggle').evaluate((button: HTMLButtonElement) => button.click());
    await allPaused(page); await frozen(page);
    const before = await page.locator(HANDOFF).evaluate((video: HTMLVideoElement) => video.currentTime);
    await page.evaluate(() => window.scrollBy({ top: 120, behavior: 'instant' })); await frames(page);
    assert.ok(Math.abs(await page.locator(HANDOFF).evaluate((video: HTMLVideoElement) => video.currentTime) - before) < 0.04, 'A paused scroll issued a new seek');
    await page.locator('.motion-toggle').evaluate((button: HTMLButtonElement) => button.click());
  });
  await check(`${label}: healthy decode, requests and poster`, async () => {
    const image = page.locator(`${HERO} img`).first();
    assert.ok(await image.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0));
    console.log(`POSTER ${label}: ${JSON.stringify(await image.evaluate((image: HTMLImageElement) => ({ src: image.getAttribute('src'), width: image.naturalWidth, height: image.naturalHeight })))}`);
    await healthy(page, audit, label, true);
  });
}
async function staticPolicy(context: BrowserContext, label: string, saveData: boolean) {
  await context.addInitScript(observationScript);
  if (saveData) await context.addInitScript(`Object.defineProperty(navigator, 'connection', { configurable: true, value: Object.assign(new EventTarget(), { saveData: true }) });`);
  const page = await context.newPage(); const audit = observe(page); await open(page);
  await check(`${label}: static story with no media download or seeking`, async () => {
    await page.waitForFunction(() => document.querySelector('#journey')?.getAttribute('data-motion') === 'off');
    for (const beat of BEATS) {
      const article = page.locator(`[data-story-beat="${beat}"]`); await article.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
      assert.notEqual(await article.getAttribute('aria-hidden'), 'true'); assert.equal(await article.getAttribute('inert'), null); await noOverflow(page);
    }
    await workingControls(page); await allPaused(page); await frozen(page);
    assert.equal(await page.locator('video[src]').count(), 0); assert.equal(audit.requests.size, 0);
    assert.ok(await page.locator('video').evaluateAll(videos => videos.every(video => (video as HTMLVideoElement).currentTime === 0)));
    await healthy(page, audit, label, false);
  });
}
async function fallback(context: BrowserContext, label: string, mode: 'network' | 'autoplay') {
  await context.addInitScript(observationScript);
  if (mode === 'autoplay') await context.addInitScript(`HTMLMediaElement.prototype.play = function () { return Promise.reject(new DOMException('Acceptance test autoplay denial', 'NotAllowedError')); };`);
  const page = await context.newPage(); const planned = new Set<string>(); const audit = observe(page, planned);
  if (mode === 'network') await page.route('**/*.mp4', route => { planned.add(route.request().url()); return route.abort('failed'); });
  await open(page);
  await check(`${label}: graceful poster with working product controls/download`, async () => {
    await page.waitForFunction(() => document.querySelector('video[data-hero-film="idle"]')?.closest('[data-film-state]')?.getAttribute('data-film-state') === 'error');
    const image = page.locator(`${HERO} img`).first(); assert.ok(await image.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0));
    assert.equal(await page.locator(IDLE).evaluate(el => getComputedStyle(el).opacity), '0');
    await workingControls(page); await workingDownload(page, audit); await allPaused(page);
    assert.deepEqual([...audit.errors], [], 'Unexpected errors beside injected failure');
    if (mode === 'network') assert.ok(audit.injectedFailures.length > 0);
    console.log(`FALLBACK ${label}: ${JSON.stringify({ requests: [...audit.requests], deliberateFailures: audit.injectedFailures })}`);
  });
}
/** Observe real computed poses during scroll, before animation clocks settle. */
async function sweepHandoff(page: Page, from: number, to: number) {
  await heroProgress(page, from); await frames(page, 12);
  return page.evaluate(async ({ from, to }) => {
    const hero = document.querySelector<HTMLElement>('section[aria-labelledby="hero-title"]')!;
    const stage = hero.firstElementChild as HTMLElement;
    const journey = document.querySelector<HTMLElement>('#journey')!;
    const outgoing = document.querySelector<HTMLElement>('[data-artifact-id="hero-handoff"]')!;
    const incoming = document.querySelector<HTMLElement>('[data-artifact-id="working-brief"]')!;
    const start = scrollY + hero.getBoundingClientRect().top;
    const distance = hero.offsetHeight - stage.clientHeight;
    const metrics = {
    opacity(element: HTMLElement) {
      let value = 1;
      for (let node: HTMLElement | null = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') return 0;
        value *= Number(style.opacity);
      }
      return value;
    },
    rect(element: HTMLElement) {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
    colorAlpha(value: string) {
      if (value === 'transparent') return 0;
      const channels = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return channels.length >= 4 ? channels[3] : channels.length === 3 ? 1 : 0;
    },
    nextFrame() { return new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))); },
    };
    const ancestors: HTMLElement[] = [];
    for (let element = incoming.parentElement; element && journey.contains(element); element = element.parentElement) ancestors.push(element);
    const samples = [];
    for (let index = 0; index <= 40; index++) {
      const requested = from + (to - from) * index / 40;
      window.scrollTo({ top: start + distance * requested, behavior: 'instant' });
      // Read after the render phase: promise microtasks inside rAF run before
      // Framer commits other callbacks in that same frame.
      await metrics.nextFrame(); await metrics.nextFrame();
      const a = metrics.rect(outgoing), b = metrics.rect(incoming);
      const occluders = ancestors.flatMap(element => {
        const style = getComputedStyle(element);
        const alpha = metrics.colorAlpha(style.backgroundColor) * metrics.opacity(element);
        const bounds = element.getBoundingClientRect();
        const overlapWidth = Math.max(0, Math.min(innerWidth, bounds.right) - Math.max(0, bounds.left));
        const overlapHeight = Math.max(0, Math.min(innerHeight, bounds.bottom) - Math.max(0, bounds.top));
        const coverage = overlapWidth * overlapHeight / (innerWidth * innerHeight);
        // A parent paints even while its child viewport is transparent/inert.
        return alpha > .05 && coverage > .05 ? [{ element: element.id || element.className, alpha, coverage }] : [];
      });
      samples.push({ requested, heroProgress: Number(hero.dataset.heroProgress), stageTop: stage.getBoundingClientRect().top,
        incomingOpacity: metrics.opacity(incoming), outgoingOpacity: metrics.opacity(outgoing), outgoing: a, incoming: b,
        poseError: Math.max(...(['x', 'y', 'width', 'height'] as const).map(key => Math.abs(a[key] - b[key]))),
        occluders, filmTime: document.querySelector<HTMLVideoElement>('video[data-hero-film="handoff"]')?.currentTime ?? 0 });
    }
    return samples;
  }, { from, to });
}
async function handoffRegression(context: BrowserContext, label: string) {
  await context.addInitScript(observationScript);
  const page = await context.newPage(); const audit = observe(page); await open(page);
  await check(`${label}: a cold mid-hero reload keeps the journey hidden`, async () => {
    await heroProgress(page, .23);
    const before = await page.evaluate(() => scrollY);
    await page.reload({ waitUntil: 'networkidle' }); await frames(page, 12);
    const state = await page.evaluate(() => {
      const journey = document.querySelector('#journey')!;
      const viewport = journey.querySelector(':scope > div')!;
      return { y: scrollY, top: journey.getBoundingClientRect().top, height: innerHeight,
        opacity: Number(getComputedStyle(viewport).opacity), inert: viewport.hasAttribute('inert'),
        pointerEvents: getComputedStyle(viewport).pointerEvents };
    });
    assert.ok(Math.abs(state.y - before) < 3, `Browser did not restore the mid-hero position: ${JSON.stringify({ before, ...state })}`);
    assert.ok(state.top > state.height * .2, 'Reload did not exercise the pre-entrance state');
    assert.ok(state.opacity < .02 && state.inert && state.pointerEvents === 'none', `Journey appeared before the restored hero handoff: ${JSON.stringify(state)}`);
  });
  await heroProgress(page, .45);
  await page.waitForFunction(() => {
    const film = document.querySelector<HTMLVideoElement>('video[data-hero-film="handoff"]');
    return film && film.readyState >= 2 && film.videoWidth > 0 && !film.seeking;
  });
  const forward = await sweepHandoff(page, .45, .995);
  const reverse = await sweepHandoff(page, .995, .45);
  const samples = [...forward, ...reverse];
  await check(`${label}: moving hero footage is not covered by an opaque journey parent`, async () => {
    const obstructed = samples.filter(frame => frame.heroProgress > .2 && frame.heroProgress < .7 && frame.occluders.length);
    assert.deepEqual(obstructed.slice(0, 3), [], `${obstructed.length} moving frames cover the hero before the paper handoff`);
    assert.ok(forward.at(-1)!.filmTime > forward[0].filmTime + 1, 'Forward scrolling did not advance the handoff');
    assert.ok(reverse.at(-1)!.filmTime < reverse[0].filmTime - 1, 'Reverse scrolling did not rewind the handoff');
  });
  await check(`${label}: papers stay aligned during the moving forward/reverse reveal`, async () => {
    // After release, the old paper legitimately leaves with the hero stage.
    const revealing = samples.filter(frame => frame.incomingOpacity > .04 && frame.outgoingOpacity > .04 && Math.abs(frame.stageTop) < 1);
    assert.ok(revealing.length >= 2, 'The sweep did not sample the live paper reveal');
    const discontinuities = revealing.filter(frame => frame.poseError > 2);
    assert.deepEqual(discontinuities.slice(0, 3), [], `${discontinuities.length} moving frames reveal a different paper pose`);
    await heroProgress(page, .995);
    await journeyProgress(page, .08); await settledWorld(page);
    const verify = page.locator('[data-story-beat="loop"]').getByRole('button', { name: 'Verify', exact: true });
    await verify.click(); assert.equal(await verify.getAttribute('aria-pressed'), 'true');
    await noOverflow(page);
    assert.deepEqual([...audit.errors], [], 'Unexpected browser/hydration error during the handoff');
  });
  const revealing = samples.filter(frame => frame.incomingOpacity > .04 && Math.abs(frame.stageTop) < 1);
  console.log(`HANDOFF ${label}: ${JSON.stringify({ frames: samples.length, visibleRevealFrames: revealing.length, maximumPoseErrorDuringReveal: Math.max(0, ...revealing.map(frame => frame.poseError)) })}`);
}
async function unusedPort() {
  const server = createServer(); await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); return port;
}
async function nativeVisibility() {
  const port = await unusedPort();
  // Standard Playwright forces tab visibility. noDefaults lets a real foreground
  // tab produce a native document.hidden signal, without mocking the page API.
  const server = await chromium.launchServer({ channel: 'chrome', headless: false, args: [`--remote-debugging-port=${port}`] });
  try {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    try {
      const context = browser.contexts()[0]; await context.addInitScript(observationScript);
      for (const viewport of VIEWPORTS) {
        const page = await context.newPage(); await page.setViewportSize(viewport); const audit = observe(page);
        await check(`${viewport.name}: real hidden tab pauses and resumes idle`, async () => {
          await page.bringToFront(); await open(page); await advanceIdle(page);
          const foreground = await context.newPage();
          try {
            await foreground.bringToFront(); await page.waitForFunction(() => document.hidden, undefined, { polling: 50, timeout: 5000 });
            await allPaused(page); await frozen(page, foreground); const retained = await page.locator(IDLE).evaluate((video: HTMLVideoElement) => video.currentTime);
            await page.bringToFront(); await page.waitForFunction(() => !document.hidden, undefined, { polling: 50 }); await advanceIdle(page, retained);
            await healthy(page, audit, `${viewport.name} native visibility`, false);
          } finally { await foreground.close(); }
        });
        await page.close();
      }
    } finally { await browser.close(); }
  } finally { await server.close(); }
}
async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    if (!handoffOnly) for (const viewport of VIEWPORTS) for (const mode of ['normal', 'reduced', 'data-saver', 'network', 'autoplay'] as const) {
      const label = `${viewport.name} ${mode}`; const context = await browser.newContext({ viewport, reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
      try {
        if (mode === 'normal') await normal(context, label);
        else if (mode === 'reduced' || mode === 'data-saver') await staticPolicy(context, label, mode === 'data-saver');
        else await fallback(context, label, mode);
      } catch (error) { failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
      finally { await context.close(); }
    }
    for (const viewport of HANDOFF_VIEWPORTS) {
      const context = await browser.newContext({ viewport, reducedMotion: 'no-preference' });
      try { await handoffRegression(context, `${viewport.name} ${viewport.width}×${viewport.height}`); }
      catch (error) { const failure = `${viewport.name} handoff: ${error instanceof Error ? error.message : String(error)}`; failures.push(failure); console.error(`FAIL ${failure}`); }
      finally { await context.close(); }
    }
  } finally { await browser.close(); }
  if (!handoffOnly) await nativeVisibility();
  if (failures.length) { console.error(`\n${failures.length} cinematic failures (${passed} checks passed):\n${failures.map(f => `- ${f}`).join('\n')}`); process.exitCode = 1; }
  else console.log(`\nAll ${passed} immersive real-media checks passed. No screenshots saved.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
