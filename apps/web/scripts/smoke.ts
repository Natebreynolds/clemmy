/** Functional and native-scroll acceptance for the immersive architecture.
 * Run: npx tsx scripts/smoke.ts http://localhost:3008
 * Installed Chrome; no screenshots, live integrations or actual downloads. */
import assert from 'node:assert/strict';
import { chromium, type Locator, type Page } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3008';
const BEATS = ['loop', 'memory', 'tools', 'recording', 'agents', 'spaces'] as const;
type Beat = typeof BEATS[number];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 },
  { name: 'narrow', width: 320, height: 740 },
  { name: 'short', width: 1440, height: 640 },
];
const selectedCases = process.env.CLEM_SMOKE_CASES?.split(',');
const selectedChecks = process.env.CLEM_SMOKE_MATCH ? new RegExp(process.env.CLEM_SMOKE_MATCH) : null;
const failures: string[] = [];
let passed = 0;
async function check(name: string, test: () => Promise<void>) {
  if (selectedChecks && !selectedChecks.test(name)) return;
  try { await test(); passed++; console.log(`PASS ${name}`); }
  catch (error) { const failure = `${name}: ${error instanceof Error ? error.message : String(error)}`; failures.push(failure); console.error(`FAIL ${failure}`); }
}
async function eventually(test: () => Promise<void>, timeout = 6000) {
  const deadline = Date.now() + timeout;
  let last: unknown;
  do { try { await test(); return; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
  throw last;
}
async function text(target: Locator, expected: string) {
  await eventually(async () => assert.ok((await target.textContent())?.includes(expected), `Missing text: ${expected}`));
}
async function pressed(button: Locator) { await eventually(async () => assert.equal(await button.getAttribute('aria-pressed'), 'true')); }
const article = (page: Page, beat: Beat) => page.locator(`[data-story-beat="${beat}"]`);
const artifact = (page: Page) => page.locator('[data-artifact-id="working-brief"]');
async function noOverflow(page: Page) {
  const size = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, content: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) }));
  assert.ok(size.content <= size.viewport + 1, `Horizontal overflow: ${JSON.stringify(size)}`);
}
async function scrollSettled(page: Page) {
  // Native PageDown animates after its first movement; let the browser finish
  // before making a separate programmatic navigation assertion.
  await page.evaluate(`new Promise((resolve, reject) => {
    let previous = scrollY, stable = 0;
    const timeout = setTimeout(() => reject(new Error('Native scrolling did not settle')), 6000);
    function sample() {
      stable = Math.abs(scrollY - previous) < 0.1 ? stable + 1 : 0;
      previous = scrollY;
      if (stable >= 8) { clearTimeout(timeout); resolve(); }
      else requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  })`);
}
async function progress(page: Page, value: number) {
  await page.locator('#journey').evaluate((section, value) => {
    const bounds = section.getBoundingClientRect();
    window.scrollTo({ top: scrollY + bounds.top + (bounds.height - innerHeight) * value, behavior: 'instant' });
  }, value);
  try {
    await page.waitForFunction(value => Math.abs(Number(document.querySelector('#journey')?.getAttribute('data-journey-progress')) - value) < 0.005, value);
  } catch (error) {
    const state = await page.evaluate(() => ({ y: scrollY, progress: document.querySelector('#journey')?.getAttribute('data-journey-progress'), stage: document.querySelector('#journey')?.getAttribute('data-journey-stage'), focused: document.activeElement?.outerHTML.slice(0, 250) }));
    throw new Error(`Journey failed to reach ${value}: ${JSON.stringify(state)}; ${String(error)}`);
  }
}
async function go(page: Page, beat: Beat) {
  if (await article(page, beat).getAttribute('id') === beat) {
    await article(page, beat).evaluate(el => window.scrollTo({ top: scrollY + el.getBoundingClientRect().top, behavior: 'instant' }));
  } else {
    await progress(page, (BEATS.indexOf(beat) + 0.32) / BEATS.length);
  }
  await page.waitForFunction(beat => document.querySelector('#journey')?.getAttribute('data-journey-stage') === beat, beat);
  await page.waitForFunction(beat => {
    const el = document.querySelector(`[data-story-beat="${beat}"]`);
    return el && getComputedStyle(el).visibility === 'visible' && Number(getComputedStyle(el).opacity) > 0.98 && !el.hasAttribute('inert');
  }, beat);
}
async function clickableCenters(targets: Locator) {
  const hits = await targets.evaluateAll(elements => elements.map(el => {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { label: el.textContent?.trim(), visible: x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight,
      clickable: Boolean(hit && (hit === el || el.contains(hit))) };
  }));
  for (const hit of hits) assert.ok(hit.visible && hit.clickable, `Control center obscured: ${JSON.stringify(hit)}`);
}
async function cameraCaughtUp(page: Page) {
  await page.waitForFunction(() => {
    const source = Number(document.querySelector('#journey')?.getAttribute('data-journey-progress'));
    const world = document.querySelector('[data-world-progress]');
    return world?.getAttribute('data-world-state') === 'ready' && Math.abs(Number(world.getAttribute('data-world-progress')) - source) < .0002;
  }, undefined, { timeout: 6000 });
}
async function chapterLink(page: Page, beat: Beat) {
  const nav = page.getByRole('navigation', { name: 'Journey chapters' });
  const picker = nav.getByRole('combobox', { name: 'Jump to chapter' });
  const beforeHash = new URL(page.url()).hash;
  if (await picker.isVisible()) await picker.selectOption(beat);
  else await nav.locator(`a[href="#${beat}"]`).click();
  await scrollSettled(page);
  try {
    await page.waitForFunction(beat => document.querySelector('#journey')?.getAttribute('data-journey-stage') === beat, beat);
  } catch {
    const state = await page.evaluate(beat => ({ hash: location.hash, stage: document.querySelector('#journey')?.getAttribute('data-journey-stage'), y: scrollY, targetTop: document.getElementById(beat)?.getBoundingClientRect().top, focused: document.activeElement?.outerHTML.slice(0, 220) }), beat);
    throw new Error(`Chapter navigation to ${beat} failed from ${beforeHash}: ${JSON.stringify(state)}`);
  }
  await eventually(async () => {
    assert.equal(new URL(page.url()).hash, `#${beat}`);
    assert.ok(await article(page, beat).isVisible());
    assert.equal(await article(page, beat).getAttribute('inert'), null);
  });
}
async function readablePanel(panel: Locator, pinned: boolean) {
  const problems = await panel.evaluate((panel, pinned) => {
    const failures: string[] = [];
    const texts = panel.querySelectorAll('h2, h3, p, blockquote, li, label');
    for (const el of texts) {
      if (!(el instanceof HTMLElement) || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.left < -1 || r.right > innerWidth + 1) failures.push(`Outside width: ${el.textContent?.trim().slice(0, 70)}`);
      if (pinned && (r.top < -1 || r.bottom > innerHeight - 55)) failures.push(`Outside pinned reading area: ${el.textContent?.trim().slice(0, 70)} [${r.top}, ${r.bottom}]`);
      for (let parent = el.parentElement; parent && parent !== panel.parentElement; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (['hidden', 'clip'].includes(style.overflowY)) {
          const clip = parent.getBoundingClientRect();
          if (r.top < clip.top - 1 || r.bottom > clip.bottom + 1) failures.push(`Clipped text: ${el.textContent?.trim().slice(0, 70)}`);
        }
      }
    }
    return failures;
  }, pinned);
  assert.deepEqual(problems, [], 'Content must remain readable without clipping');
}
async function usableControls(page: Page, panel: Locator, viewport: typeof VIEWPORTS[number]) {
  const flow = await page.locator('#journey').getAttribute('data-layout') === 'flow';
  for (const control of await panel.locator('button, select, a[href]').all()) {
    if (!await control.isVisible()) continue;
    if (flow) await control.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await clickableCenters(control);
    const size = await control.boundingBox();
    assert.ok(size && size.width >= (viewport.width < 800 ? 44 : 24) && size.height >= (viewport.width < 800 ? 44 : 30), `Undersized control: ${await control.getAttribute('aria-label') || await control.textContent()} ${JSON.stringify(size)}`);
  }
}
async function interactions(page: Page, viewport: typeof VIEWPORTS[number], reduced: boolean) {
  const prefix = `${viewport.name}${reduced ? ' reduced-motion' : ''}`;
  await check(`${prefix}: entry, downloads and footer access`, async () => {
    assert.equal(await page.locator('h1').count(), 1); await text(page.locator('h1'), 'Clem.');
    const hero = page.locator('section[aria-labelledby="hero-title"]');
    await eventually(async () => assert.ok(await hero.getByRole('link', { name: /Bring Clem home/ }).isVisible()));
    await eventually(async () => assert.ok(await hero.locator('img').first().evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)));
    assert.equal(await page.locator('main a[href="/api/download?arch=arm64"]').count(), 2);
    assert.equal(await page.getByRole('link', { name: 'Download for Intel Mac' }).getAttribute('href'), '/api/download?arch=intel');
    assert.ok((await page.locator('.site-footer').textContent())?.includes('Open source'));
    assert.equal(await page.locator('.site-footer').getByRole('link', { name: 'MIT license' }).getAttribute('href'), 'https://github.com/Natebreynolds/clemmy/blob/main/LICENSE');
    await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
    assert.equal(await page.locator('.site-footer > div a').count(), 3);
    await eventually(() => clickableCenters(page.locator('.site-footer > div a')));
    await noOverflow(page);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  });
  await check(`${prefix}: native navigation and mobile Escape`, async () => {
    if (viewport.width < 800) {
      const toggle = page.locator('#menu-toggle');
      await toggle.click(); assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await page.getByRole('button', { name: 'Close menu' }).click(); assert.equal(await page.locator('#mobile-nav').count(), 0);
      await toggle.click(); await page.keyboard.press('Escape');
      assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
      assert.ok(await toggle.evaluate(el => el === document.activeElement));
      await toggle.click();
      await page.getByRole('navigation', { name: 'Mobile navigation' }).getByRole('link', { name: 'Memory', exact: true }).click();
      assert.equal(await page.locator('#mobile-nav').count(), 0);
    } else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Memory', exact: true }).click();
    await eventually(async () => assert.equal(new URL(page.url()).hash, '#memory'));
    if (!reduced) await page.waitForFunction(() => document.querySelector('#journey')?.getAttribute('data-journey-stage') === 'memory');
    await eventually(async () => assert.ok(await article(page, 'memory').isVisible())); await noOverflow(page);
  });
  await check(`${prefix}: six loop choices, System One and review`, async () => {
    await go(page, 'loop');
    const group = page.getByRole('group', { name: 'Explore the agent loop' });
    for (const [name, evidence] of [['Understand', 'project context'], ['Discover', 'inspect'], ['Act', 'write the brief'], ['Verify', 'missing evidence'], ['Learn', 'future work'], ['Jev', 'when connected']]) {
      const button = group.getByRole('button', { name, exact: true }); await button.click(); await pressed(button);
      assert.equal(await group.locator('[aria-pressed="true"]').count(), 1);
      await text(article(page, 'loop').locator('[aria-live="polite"]'), evidence);
    }
    await text(article(page, 'loop'), 'System One'); await text(article(page, 'loop'), 'Completion review');
    await text(artifact(page), 'Typed decisions'); await noOverflow(page);
  });
  await check(`${prefix}: memory choices carry into the brief`, async () => {
    await go(page, 'memory');
    for (const [name, retained] of [['Preference', 'Concise briefs. Source links included.'], ['Correction', 'Updated context replaces the old decision.'], ['Experience', 'A useful procedure, available for recall.']]) {
      const button = page.getByRole('group', { name: 'Explore how Clementine learns' }).getByRole('button', { name, exact: true });
      await button.click(); await pressed(button); await text(article(page, 'memory'), retained); await text(artifact(page), retained);
    }
    await noOverflow(page);
  });
  await check(`${prefix}: connected, local and extensible tools`, async () => {
    await go(page, 'tools');
    for (const [name, capability] of [['Composio', 'Search messages'], ['Local tools', 'Read project files'], ['MCP & skills', 'Discover MCP tools']]) {
      const button = page.getByRole('group', { name: 'Explore Clementine’s tools' }).getByRole('button', { name, exact: true });
      await button.click(); await pressed(button); await text(article(page, 'tools'), capability); await text(artifact(page), name);
    }
    await text(article(page, 'tools'), 'configured permissions'); await noOverflow(page);
  });
  await check(`${prefix}: recording transcript, summary and actions`, async () => {
    await go(page, 'recording');
    const tabs = article(page, 'recording').getByRole('tablist', { name: 'Explore the recording example' });
    for (const [name, evidence] of [['Transcript', '08:42'], ['Summary', 'source review on Wednesday'], ['Actions', 'Check the source links']]) {
      const tab = tabs.getByRole('tab', { name, exact: true }); await tab.click();
      assert.equal(await tab.getAttribute('aria-selected'), 'true');
      assert.equal(await tabs.locator('[aria-selected="true"]').count(), 1);
      await text(article(page, 'recording').getByRole('tabpanel'), evidence);
    }
    const actions = tabs.getByRole('tab', { name: 'Actions', exact: true }); await actions.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await tabs.getByRole('tab', { name: 'Transcript', exact: true }).getAttribute('aria-selected'), 'true');
    assert.ok(await tabs.getByRole('tab', { name: 'Transcript', exact: true }).evaluate(el => el === document.activeElement));
    await page.keyboard.press('End');
    assert.equal(await actions.getAttribute('aria-selected'), 'true');
    await text(article(page, 'recording'), 'not automatically executed');
    await noOverflow(page);
  });
  await check(`${prefix}: projects and independent model pins persist`, async () => {
    await go(page, 'agents');
    for (const [name, file] of [['Product launch', 'launch-brief.md'], ['Research desk', 'research-notes.md'], ['Build room', 'implementation-plan.md']]) {
      await page.getByRole('combobox', { name: 'Example project', exact: true }).selectOption({ label: name });
      await text(artifact(page), file);
    }
    for (const [role, model] of [['Researcher', 'Grok 4.6'], ['Builder', 'GLM 5.3 Flash'], ['Reviewer', 'Kimi K2.6']]) {
      const select = page.getByRole('combobox', { name: `Model for ${role}` }); await select.selectOption(model); assert.equal(await select.inputValue(), model);
      await text(article(page, 'agents').locator('[aria-live="polite"]'), `${role} is pinned to ${model}`);
    }
    for (const beat of ['memory', 'agents'] as const) await chapterLink(page, beat);
    for (const [role, model] of [['Researcher', 'Grok 4.6'], ['Builder', 'GLM 5.3 Flash'], ['Reviewer', 'Kimi K2.6']]) {
      assert.equal(await page.getByRole('combobox', { name: `Model for ${role}` }).inputValue(), model); await text(artifact(page), model);
    }
    await text(artifact(page), 'implementation-plan.md');
    await text(article(page, 'agents'), 'each specialist keeps its own instructions'); await noOverflow(page);
  });
  await check(`${prefix}: Space filtering and source evidence`, async () => {
    await go(page, 'spaces');
    const space = article(page, 'spaces');
    await space.getByRole('tab', { name: 'Space', exact: true }).click();
    const filters = space.getByRole('group', { name: 'Filter the example launch board' });
    await pressed(filters.getByRole('button', { name: 'Open', exact: true }));
    assert.equal(await space.getByRole('button', { name: /^Preview / }).count(), 2);
    await filters.getByRole('button', { name: 'All', exact: true }).click();
    assert.equal(await space.getByRole('button', { name: /^Preview / }).count(), 3);
    const completed = space.getByRole('button', { name: 'Preview agree on the launch date', exact: true });
    await completed.click(); assert.equal(await space.getByRole('button', { name: 'Close source preview', exact: true }).getAttribute('aria-expanded'), 'true');
    await text(space, 'Launch sync · 08:42');
    await text(space, 'Let’s move the launch to Thursday.');
    await usableControls(page, space, viewport);
    await filters.getByRole('button', { name: 'Open', exact: true }).click();
    assert.equal(await space.getByRole('button', { name: /^Preview / }).count(), 2);
    assert.equal(await space.getByRole('button', { name: 'Close source preview', exact: true }).count(), 0);
    const source = space.getByRole('button', { name: 'Preview review the source links', exact: true });
    await source.click(); await text(space, 'Launch sync · 09:06');
    const close = space.getByRole('button', { name: 'Close source preview', exact: true }); await close.click();
    assert.equal(await source.getAttribute('aria-expanded'), 'false');
    await noOverflow(page);
  });
  await check(`${prefix}: reusable workflows keep their configured trigger`, async () => {
    await go(page, 'spaces');
    const space = article(page, 'spaces');
    const workflowTab = space.getByRole('tab', { name: 'Workflow', exact: true }); await workflowTab.click();
    for (const [name, trace, retained] of [['On demand', 'Your request', 'Run when you ask'], ['On a schedule', 'Scheduled check-in', 'Reuse on a schedule'], ['On an event', 'Connected event', 'Start from a connected event']]) {
      const button = space.getByRole('group', { name: 'Example workflow trigger' }).getByRole('button', { name, exact: true });
      await button.click(); await pressed(button); await text(space, trace); await text(space, retained);
    }
    await text(space, 'answer or approval'); await usableControls(page, space, viewport);
    await workflowTab.focus(); await page.keyboard.press('Home');
    assert.equal(await space.getByRole('tab', { name: 'Space', exact: true }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('End');
    await pressed(space.getByRole('button', { name: 'On an event', exact: true }));
    await go(page, 'recording'); await go(page, 'spaces');
    await pressed(space.getByRole('button', { name: 'On an event', exact: true }));
    await space.getByRole('tab', { name: 'Space', exact: true }).click();
    await noOverflow(page);
  });
  await check(`${prefix}: real console screen assets`, async () => {
    for (const [name, file] of [['Chat', 'dashboard.png'], ['Memory', 'memory.jpg'], ['Automate', 'automate.png'], ['Connect', 'connect.png']]) {
      const button = page.locator('.console-tabs').getByRole('button', { name, exact: true }); await button.click(); await pressed(button);
      const image = page.locator('.console-frame img');
      await eventually(async () => { assert.equal(await image.getAttribute('src'), `/screenshots/${file}`); assert.ok(await image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)); });
      await text(page.locator('.console-bar'), name);
    }
    await noOverflow(page);
  });
  await check(`${prefix}: six reachable chapters, native scrolling and readable layout`, async () => {
    assert.equal(await artifact(page).count(), 1);
    const flow = await page.locator('#journey').getAttribute('data-layout') === 'flow';
    assert.equal(flow, reduced || viewport.width < 800 || viewport.height < 760, 'Unexpected responsive reading mode');
    await go(page, 'loop');
    const initialScroll = await page.evaluate(() => scrollY);
    await page.mouse.move(viewport.width / 2, viewport.height / 2); await page.mouse.wheel(0, 250);
    await page.waitForFunction(start => scrollY > start + 50, initialScroll); await scrollSettled(page);
    const afterWheel = await page.evaluate(() => scrollY);
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    await page.keyboard.press('PageDown'); await page.waitForFunction(start => scrollY > start + 50, afterWheel); await scrollSettled(page);
    for (const beat of BEATS) {
      await go(page, beat); await noOverflow(page);
      assert.equal(await page.locator('#journey').getAttribute('data-journey-stage'), beat);
      if (!flow) {
        const top = await page.locator('#journey > div').first().evaluate(el => el.getBoundingClientRect().top);
        assert.ok(Math.abs(top) < 2, `Pinned viewport drifted at ${beat}: ${top}`);
      }
      await readablePanel(article(page, beat), !flow);
      await usableControls(page, article(page, beat), viewport);
    }
    // Real chapter controls must also work for the two newly added destinations.
    for (const beat of ['recording', 'spaces', 'loop'] as const) await chapterLink(page, beat);
    await page.locator('#console').evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const release = await page.evaluate(() => ({ journey: document.querySelector('#journey')!.getBoundingClientRect().bottom, console: document.querySelector('#console')!.getBoundingClientRect().top }));
    assert.ok(release.console >= -2 && release.console <= 100 && release.journey <= release.console + 2, `Journey did not release into the app: ${JSON.stringify(release)}`);
    await noOverflow(page);
  });
  await check(`${prefix}: hidden focus and readable pause/reduced fallback`, async () => {
    await go(page, 'loop');
    if (!reduced) {
      for (const hidden of await page.locator('[data-story-beat][aria-hidden="true"]').all()) {
        assert.equal(await hidden.getAttribute('inert'), '');
        const control = hidden.locator('button, select').first();
        if (await control.count()) assert.equal(await control.evaluate((el: HTMLElement) => { el.focus({ preventScroll: true }); return document.activeElement === el; }), false, 'An inactive scene accepted focus');
      }
      await page.getByRole('button', { name: 'Pause immersive motion', exact: true }).click();
    }
    await page.waitForFunction(() => document.querySelector('#journey')?.getAttribute('data-motion') === 'off');
    if (reduced) assert.ok(await page.getByRole('button', { name: 'Pause immersive motion', exact: true }).isDisabled());
    for (const beat of BEATS) {
      await go(page, beat);
      assert.notEqual(await article(page, beat).getAttribute('aria-hidden'), 'true');
      assert.equal(await article(page, beat).getAttribute('inert'), null);
      const control = article(page, beat).locator('button, select').first(); await control.focus();
      assert.ok(await control.evaluate(el => document.activeElement === el));
      await noOverflow(page);
    }
    const camera = await page.locator('[data-world-progress]').getAttribute('data-world-camera');
    await page.evaluate(() => window.scrollBy({ top: -200, behavior: 'instant' }));
    await scrollSettled(page);
    assert.equal(await page.locator('[data-world-progress]').getAttribute('data-world-camera'), camera, 'Paused world kept moving');
    assert.ok(await page.locator('video').evaluateAll(elements => elements.every(el => (el as HTMLVideoElement).paused)));
    if (!reduced) { await page.getByRole('button', { name: 'Resume immersive motion', exact: true }).click(); await page.waitForFunction(() => document.querySelector('#journey')?.getAttribute('data-motion') === 'on'); }
  });
}
async function main() {
  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    for (const { viewport, reduced } of [...VIEWPORTS.map(viewport => ({ viewport, reduced: false })), { viewport: VIEWPORTS[0], reduced: true }]) {
      if (selectedCases && !selectedCases.includes(`${viewport.name}${reduced ? '-reduced' : ''}`)) continue;
      const context = await browser.newContext({ viewport, reducedMotion: reduced ? 'reduce' : 'no-preference' });
      const page = await context.newPage(); page.setDefaultTimeout(10000); const errors = new Set<string>();
      page.on('console', message => { if (message.type() === 'error') errors.add(`console: ${message.text()} (${message.location().url})`); });
      page.on('pageerror', error => errors.add(`page: ${error.message}`));
      page.on('response', response => { if (response.status() >= 400) errors.add(`HTTP ${response.status()}: ${response.url()}`); });
      page.on('requestfailed', request => {
        if (request.resourceType() === 'media' && /\/media\/(?:clem-hero-loop|clem-handoff)\.mp4(?:\?|$)/.test(request.url()) && request.failure()?.errorText === 'net::ERR_ABORTED') return;
        errors.add(`request: ${request.url()} — ${request.failure()?.errorText}`);
      });
      try {
        await page.goto(`${BASE.replace(/#.*$/, '')}#recording`, { waitUntil: 'networkidle', timeout: 60000 }); await page.evaluate(() => document.fonts.ready);
        // Next's development toolbar overlaps the mobile footer; it is absent
        // from production and is not part of the product's hit-test surface.
        await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
        await page.waitForFunction(reduced => document.querySelector('#journey')?.getAttribute('data-motion') === (reduced ? 'off' : 'on'), reduced);
        await check(`${viewport.name}${reduced ? ' reduced-motion' : ''}: recording deep link survives responsive hydration`, async () => {
          await page.waitForFunction(() => document.querySelector('#journey')?.getAttribute('data-journey-stage') === 'recording');
          const target = article(page, 'recording');
          await eventually(async () => {
            assert.ok(await target.isVisible());
            assert.equal(await target.getAttribute('inert'), null);
            const bounds = await target.boundingBox();
            assert.ok(bounds && bounds.y < viewport.height * .5 && bounds.y + bounds.height > 0, `Deep link missed the recording chapter: ${JSON.stringify(bounds)}`);
          });
          if (!reduced) {
            await cameraCaughtUp(page);
            const recordingCamera = await page.locator('[data-world-progress]').getAttribute('data-world-camera');
            await chapterLink(page, 'spaces'); await cameraCaughtUp(page);
            assert.notEqual(await page.locator('[data-world-progress]').getAttribute('data-world-camera'), recordingCamera, 'Rendered camera stayed in the old world after a native chapter jump');
          }
        });
        await page.evaluate(() => { history.replaceState(null, '', location.pathname + location.search); window.scrollTo({ top: 0, behavior: 'instant' }); });
        await page.waitForFunction(() => ['idle', 'static'].includes(document.querySelector('section[aria-labelledby="hero-title"]')?.getAttribute('data-hero-phase') ?? ''));
        await interactions(page, viewport, reduced);
        const mediaErrors = await page.locator('video').evaluateAll(elements => elements.map(el => (el as HTMLVideoElement).error?.message).filter(Boolean));
        assert.deepEqual(mediaErrors, [], 'Hero decoder errors');
      } catch (error) { failures.push(`${viewport.name}${reduced ? ' reduced' : ''}: ${error instanceof Error ? error.message : String(error)}`); }
      finally { if (errors.size) failures.push(`${viewport.name}: browser errors\n${[...errors].join('\n')}`); await context.close(); }
    }
    if (!selectedCases || selectedCases.includes('seam')) {
    const seamContext = await browser.newContext({ viewport: { width: 1440, height: 780 }, reducedMotion: 'no-preference' });
    try {
      const page = await seamContext.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle' }); await page.evaluate(() => document.fonts.ready);
      await check('desktop 780px: hero paper and journey paper align during the handoff', async () => {
        const hero = page.locator('section[aria-labelledby="hero-title"]');
        await page.waitForFunction(() => document.querySelector('section[aria-labelledby="hero-title"]')?.getAttribute('data-hero-phase') === 'idle');
        await hero.evaluate(el => { const r = el.getBoundingClientRect(); window.scrollTo({ top: scrollY + r.top + (r.height - innerHeight) * .9727, behavior: 'instant' }); });
        await page.waitForFunction(() => Math.abs(Number(document.querySelector('section[aria-labelledby="hero-title"]')?.getAttribute('data-hero-progress')) - .9727) < .0002);
        const from = await page.locator('[data-artifact-id="hero-handoff"]').boundingBox();
        const to = await artifact(page).boundingBox();
        assert.ok(from && to, 'Both paper objects must have a visible handoff pose');
        for (const key of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(from[key] - to[key]) < 1, `Paper ${key} mismatch: ${JSON.stringify({ from, to })}`);
        await noOverflow(page);
      });
    } finally { await seamContext.close(); }
    }
  } finally { await browser.close(); }
  if (failures.length) { console.error(`\n${failures.length} failures (${passed} checks passed):\n${failures.map(f => `- ${f}`).join('\n')}`); process.exitCode = 1; }
  else console.log(`\nAll ${passed} immersive interaction checks passed. No screenshots saved.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
