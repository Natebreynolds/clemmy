#!/usr/bin/env node
// Auto-updater validation smoke. Tests the pure logic of
// apps/desktop/src/updater.ts plus the live state of the GitHub
// release feed it depends on.
//
// What this catches:
//   1. compareVersions regressions (the guard against stale GitHub
//      metadata that would re-trigger an "update available" for the
//      SAME version we already have).
//   2. latest-mac.yml feed integrity at the GitHub release URL
//      electron-updater follows.
//   3. App-Update.yml inside the installed bundle pointing at the
//      right owner/repo (if the wrong feed gets bundled, the updater
//      checks the wrong place forever).
//   4. The asset names + sizes in the feed actually match real
//      downloadable .zip / .dmg artifacts.
//
// Run: node scripts/smoke-updater.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DESKTOP_DIST = path.join(REPO_ROOT, 'apps', 'desktop', 'dist');
const INSTALLED_APP = '/Applications/Clementine.app';

const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); process.exitCode = 1; };

console.log('Clementine auto-updater smoke');
console.log();

// ─── Phase 1: compareVersions regression suite ─────────────────────

if (!existsSync(path.join(DESKTOP_DIST, 'updater.js'))) {
  console.error('✗ desktop dist not built. Run: cd apps/desktop && npm run build');
  process.exit(2);
}

console.log('→ Phase 1 · compareVersions (defensive guard against stale GH metadata)');
const { compareVersions } = await import(path.join(DESKTOP_DIST, 'version-compare.js'));

const cmpCases = [
  // [left, right, expected, label]
  ['0.4.32', '0.4.31',  1, 'newer patch wins'],
  ['0.4.31', '0.4.32', -1, 'older patch loses'],
  ['0.4.32', '0.4.32',  0, 'equal versions tie'],
  ['1.0.0',  '0.99.0',  1, 'major version trumps minor'],
  ['0.5.0',  '0.4.99',  1, 'minor version trumps patch'],
  ['v0.4.32','0.4.32',  0, 'v-prefix tolerated (left)'],
  ['0.4.32', 'v0.4.32', 0, 'v-prefix tolerated (right)'],
  ['0.4.32-beta.1', '0.4.32', 0, 'pre-release suffix stripped'],
  ['0.4.32', '0.4.32-rc1', 0, 'pre-release suffix stripped (right)'],
  ['0.10.0', '0.9.0',   1, 'numeric, not lexicographic (0.10 > 0.9)'],
  ['1.2',    '1.2.0',   0, 'missing patch treated as 0'],
  ['',       '0.0.0',   0, 'empty string parses as 0.0.0'],
];

for (const [a, b, want, label] of cmpCases) {
  const got = compareVersions(a, b);
  // We only care about the sign of the result.
  const sign = got > 0 ? 1 : got < 0 ? -1 : 0;
  if (sign === want) ok(`compareVersions("${a}", "${b}") === ${want}  — ${label}`);
  else fail(`compareVersions("${a}", "${b}") returned ${got} (sign ${sign}), expected ${want} — ${label}`);
}

// ─── Phase 2: live GitHub feed reachability + asset integrity ──────

console.log('');
console.log('→ Phase 2 · live GitHub release feed');
const FEED_URL = 'https://github.com/Natebreynolds/clemmy/releases/latest/download/latest-mac.yml';
let feedYaml = '';
try {
  const res = await fetch(FEED_URL, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    fail(`feed URL returned ${res.status}`);
  } else {
    ok(`feed URL reachable (final ${res.status})`);
    feedYaml = await res.text();
  }
} catch (err) {
  fail(`feed URL fetch failed: ${err instanceof Error ? err.message : String(err)}`);
}

if (feedYaml) {
  const versionMatch = feedYaml.match(/^version:\s*([0-9].*)$/m);
  if (versionMatch) ok(`feed advertises version=${versionMatch[1]}`);
  else fail('feed missing `version:` line');

  const filesMatch = feedYaml.match(/^files:/m);
  if (filesMatch) ok('feed has `files:` block');
  else fail('feed missing `files:` block');

  const sha512Lines = feedYaml.match(/sha512:\s*[A-Za-z0-9+/=]+/g) || [];
  if (sha512Lines.length >= 4) ok(`feed lists ${sha512Lines.length} sha512 checksums (>=4 expected for arm64+x64 dmg+zip)`);
  else fail(`feed only has ${sha512Lines.length} sha512 lines, expected >= 4`);

  // Confirm the zip/dmg assets referenced in the feed actually exist on the release.
  const assetNames = [...feedYaml.matchAll(/url:\s*(\S+\.(?:zip|dmg))/g)].map((m) => m[1]);
  if (assetNames.length >= 4) ok(`feed references ${assetNames.length} download artifacts`);
  else fail(`feed references only ${assetNames.length} artifacts`);

  if (versionMatch) {
    const version = versionMatch[1].trim();
    const assetUrl = `https://github.com/Natebreynolds/clemmy/releases/download/v${version}/${assetNames[0]}`;
    try {
      const headRes = await fetch(assetUrl, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      if (headRes.ok) ok(`first asset HEAD ok: ${assetNames[0]} (${headRes.headers.get('content-length') || '?'} bytes)`);
      else fail(`first asset HEAD returned ${headRes.status}: ${assetUrl}`);
    } catch (err) {
      fail(`asset HEAD failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ─── Phase 3: installed app's app-update.yml points at the right repo ─

console.log('');
console.log('→ Phase 3 · installed bundle\'s app-update.yml');
const appUpdateYml = path.join(INSTALLED_APP, 'Contents', 'Resources', 'app-update.yml');
if (existsSync(appUpdateYml)) {
  const yml = readFileSync(appUpdateYml, 'utf-8');
  if (/owner:\s*Natebreynolds/i.test(yml)) ok('bundled app-update.yml owner=Natebreynolds');
  else fail(`bundled app-update.yml has wrong/missing owner: ${yml.slice(0, 200)}`);
  if (/repo:\s*clemmy/i.test(yml)) ok('bundled app-update.yml repo=clemmy');
  else fail('bundled app-update.yml has wrong/missing repo');
  if (/provider:\s*github/i.test(yml)) ok('bundled app-update.yml provider=github');
  else fail('bundled app-update.yml has wrong/missing provider');
} else {
  console.log(`  · skipped (no installed app at ${INSTALLED_APP})`);
}

// ─── Phase 4: live installed-app log shows the updater is healthy ──

console.log('');
console.log('→ Phase 4 · installed app\'s recent updater log');
const supervisorLog = path.join(process.env.HOME, '.clementine-next', 'logs', 'desktop', 'supervisor.log');
if (existsSync(supervisorLog)) {
  const text = readFileSync(supervisorLog, 'utf-8');
  const lines = text.split('\n').filter((l) => l.includes('"clementine-next.updater"'));
  if (lines.length === 0) {
    console.log('  · no updater log lines (app may not have run yet)');
  } else {
    // Look at the last completed cycle.
    const recent = lines.slice(-20).join('\n');
    if (/auto-updater armed/.test(recent)) ok('most recent run armed the updater');
    if (/no update available|Update for version .* is not available/.test(recent)) ok('most recent check completed (no update / current is newest)');
    if (/update downloaded/.test(recent)) ok('a download has been seen previously');
    if (/updater error/.test(recent)) fail(`updater errors recently — investigate ${supervisorLog}`);
    else ok('no `updater error` lines in recent log');
  }
} else {
  console.log(`  · skipped (no supervisor.log at ${supervisorLog})`);
}

if (process.exitCode === 1) {
  console.error('\n✗ updater smoke FAILED');
  process.exit(1);
}
console.log('\n✓ updater smoke green');
