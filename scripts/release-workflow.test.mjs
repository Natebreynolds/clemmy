import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import {
  assertValidCandidateVersion,
  compareSemVer,
  defaultCandidateVersion,
  parseSemVer,
} from './release-candidate-version.mjs';

const workflowPath = new URL('../.github/workflows/release-desktop.yml', import.meta.url);
const workflowText = readFileSync(workflowPath, 'utf-8');
const workflow = load(workflowText);
const dispatcherText = readFileSync(new URL('./hotpatch-installed.sh', import.meta.url), 'utf-8');
const dualArchScriptText = readFileSync(
  new URL('../apps/desktop/scripts/release-mac-dual-arch.sh', import.meta.url),
  'utf-8',
);
const desktopPackage = JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf-8'));
const dmgHookText = readFileSync(
  new URL('../apps/desktop/build/after-all-artifact-build.cjs', import.meta.url),
  'utf-8',
);

function runScripts(job) {
  return (job?.steps ?? [])
    .map((step) => step?.run)
    .filter((run) => typeof run === 'string')
    .join('\n');
}

test('manual desktop candidates require a prerelease version and cannot publish', () => {
  const input = workflow.on?.workflow_dispatch?.inputs?.candidate_version;
  assert.equal(input?.required, true);
  assert.match(String(input?.description ?? ''), /prerelease SemVer/i);

  const publisher = workflow.jobs?.['publish-release'];
  assert.match(String(publisher?.if ?? ''), /github\.event_name == 'push'/);
  assert.doesNotMatch(runScripts(workflow.jobs?.['release-mac']), /gh release (?:create|upload|edit)/);
  assert.match(
    (workflow.jobs?.['release-mac']?.steps ?? []).map((step) => step?.uses ?? '').join('\n'),
    /actions\/upload-artifact@v4/,
  );
});

test('candidate dispatcher defaults to the next patch prerelease and rejects downgrade candidates', () => {
  assert.equal(defaultCandidateVersion('1.4.4'), '1.4.5-rc.1');
  assert.equal(defaultCandidateVersion('1.4.5-rc.9'), '1.4.6-rc.1');
  assert.equal(assertValidCandidateVersion('1.4.5-rc.1', '1.4.4'), '1.4.5-rc.1');
  assert.equal(assertValidCandidateVersion('1.5.0-alpha.1+candidate.2', '1.4.4'), '1.5.0-alpha.1+candidate.2');
  assert.throws(() => assertValidCandidateVersion('1.4.4-rc.99', '1.4.4'), /must be newer/);
  assert.throws(() => assertValidCandidateVersion('1.4.4', '1.4.4'), /prerelease identifier/);
  assert.throws(() => assertValidCandidateVersion('1.04.5-rc.1', '1.4.4'), /Invalid SemVer/);
  assert.throws(() => parseSemVer('1.4.5-01'), /Invalid SemVer/);
  assert.equal(compareSemVer('1.4.5-rc.10', '1.4.5-rc.2'), 1);
  assert.match(dispatcherText, /release-candidate-version\.mjs default/);
  assert.match(dispatcherText, /release-candidate-version\.mjs validate/);
  assert.match(runScripts(workflow.jobs?.preflight), /release-candidate-version\.mjs validate/);
});

test('unsigned macOS rehearsal overrides the configured production signing identity', () => {
  assert.match(dualArchScriptText, /if ! is_signed_release/);
  assert.match(dualArchScriptText, /--config\.mac\.identity=null/);
});

test('DMGs are signed before electron-builder disposes its temporary keychain', () => {
  assert.equal(desktopPackage.build?.dmg?.sign, true);
  assert.doesNotMatch(dmgHookText, /find-identity|\['--sign'/);
  assert.match(dmgHookText, /TeamIdentifier=/);
  assert.match(dualArchScriptText, /refresh-notarized-dmg-metadata\.mjs/);
});

test('production desktop publishing is gated on exact-main preflight', () => {
  const preflight = workflow.jobs?.preflight;
  const scripts = runScripts(preflight);
  assert.match(scripts, /npm test/);
  assert.match(scripts, /npm run test:release-assets/);
  assert.match(scripts, /npm run typecheck/);
  assert.match(scripts, /npm run bench:gates/);
  assert.match(scripts, /npm run eval:passk/);
  assert.match(scripts, /npm run eval:jobs/);
  assert.match(scripts, /refs\/remotes\/origin\/main/);
  assert.match(scripts, /tag_sha.*main_sha/s);
  assert.equal(workflow.jobs?.['release-mac']?.needs, 'preflight');
  assert.equal(workflow.jobs?.['release-windows']?.needs, 'preflight');
  assert.equal(workflow.concurrency?.['cancel-in-progress'], false);
});

test('one tag-only publisher owns GitHub Release mutation', () => {
  const mutationJobs = Object.entries(workflow.jobs ?? {})
    .filter(([, job]) => /gh release (?:create|upload|edit)/.test(runScripts(job)))
    .map(([name]) => name);
  assert.deepEqual(mutationJobs, ['publish-release']);
  assert.match(String(workflow.jobs?.['release-windows']?.if ?? ''), /github\.event_name == 'push'/);
});
