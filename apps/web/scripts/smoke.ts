/**
 * Visual smoke test for the landing page. Run with the dev server up:
 *   npx tsx scripts/smoke.ts [baseUrl]
 * Captures /tmp/clem-web-smoke-*.png at three viewports, exercises the
 * channel tabs, the screenshot lightbox, the mobile hamburger, and a
 * reduced-motion pass. Exits non-zero on console errors or missing UI.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const failures: string[] = [];

  for (const vp of VIEWPORTS) {
    const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const url = msg.location()?.url ?? '';
      // LiveAgent probes /clementine-demo.mp4 and falls back by design.
      if (url.includes('clementine-demo.mp4')) return;
      consoleErrors.push(`${msg.text()}${url ? ` (${url})` : ''}`);
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });

    // hero screenshot loaded
    const heroImg = page.locator('img[src*="dashboard.png"]').first();
    if (!(await heroImg.isVisible().catch(() => false))) failures.push(`${vp.name}: hero image missing`);

    if (vp.name === 'mobile') {
      // hamburger menu
      await page.getByRole('button', { name: 'Open menu' }).click();
      const navLink = page.getByRole('navigation').getByText('Capabilities').first();
      if (!(await navLink.isVisible().catch(() => false))) failures.push('mobile: menu sheet did not open');
      await page.getByRole('button', { name: 'Close menu' }).click();
    }

    // channel tabs — click each and confirm aria state flips
    for (const tab of ['Voice', 'Discord', 'Mobile', 'Webhook / API', 'Console']) {
      const btn = page.getByRole('tab', { name: tab });
      await btn.scrollIntoViewIfNeeded();
      await btn.click();
      await page.waitForTimeout(450);
      if ((await btn.getAttribute('aria-selected')) !== 'true') failures.push(`${vp.name}: tab ${tab} did not activate`);
    }

    // lightbox open/close (desktop only — scroll-snap strip)
    if (vp.name === 'desktop') {
      const shot = page.getByRole('button', { name: /Enlarge screenshot: Memory/ });
      await shot.scrollIntoViewIfNeeded();
      await shot.click();
      const dialog = page.getByRole('dialog');
      if (!(await dialog.isVisible().catch(() => false))) failures.push('desktop: lightbox did not open');
      await page.keyboard.press('Escape');
      // AnimatePresence exit animation must fully unmount the dialog
      await dialog.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {
        failures.push('desktop: lightbox did not close on Escape');
      });
    }

    // full-page screenshot for eyeball review
    await page.screenshot({ path: `/tmp/clem-web-smoke-${vp.name}.png`, fullPage: true });

    const realErrors = consoleErrors.filter(
      (e) => !e.includes('favicon') && !e.includes('clementine-demo.mp4'),
    );
    if (realErrors.length) failures.push(`${vp.name}: console errors → ${realErrors.slice(0, 3).join(' | ')}`);
    await context.close();
  }

  // reduced-motion pass
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60_000 });
    await page.screenshot({ path: '/tmp/clem-web-smoke-reduced.png', fullPage: true });
    const heading = await page.locator('h1').first().textContent();
    if (!heading?.includes('always-on')) failures.push('reduced-motion: hero heading missing');
    await context.close();
  }

  await browser.close();

  if (failures.length) {
    console.error('SMOKE FAILURES:');
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('Smoke passed. Screenshots in /tmp/clem-web-smoke-*.png');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
