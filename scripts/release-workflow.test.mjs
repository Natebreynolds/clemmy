import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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
const testWorkflow = load(readFileSync(new URL('../.github/workflows/test.yml', import.meta.url), 'utf-8'));
const dispatcherText = readFileSync(new URL('./hotpatch-installed.sh', import.meta.url), 'utf-8');
const dualArchScriptText = readFileSync(
  new URL('../apps/desktop/scripts/release-mac-dual-arch.sh', import.meta.url),
  'utf-8',
);
const desktopPackage = JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf-8'));
const rootPackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const windowsReleaseText = readFileSync(
  new URL('../apps/desktop/scripts/release-windows.mjs', import.meta.url),
  'utf-8',
);
const dmgHookText = readFileSync(
  new URL('../apps/desktop/build/after-all-artifact-build.cjs', import.meta.url),
  'utf-8',
);
const afterPackHookText = readFileSync(
  new URL('../apps/desktop/build/after-pack.cjs', import.meta.url),
  'utf-8',
);
const macNativeDepsText = readFileSync(
  new URL('../apps/desktop/scripts/mac-native-deps.mjs', import.meta.url),
  'utf-8',
);
const desktopReleaseGuideText = readFileSync(
  new URL('../docs/guides/desktop-releases.md', import.meta.url),
  'utf-8',
);
const v3ReleaseNotesPath = new URL('../docs/releases/v3.0.0.md', import.meta.url);

function runScripts(job) {
  return (job?.steps ?? [])
    .map((step) => step?.run)
    .filter((run) => typeof run === 'string')
    .join('\n');
}

function runBash(script, env) {
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf-8',
    env: {
      PATH: process.env.PATH,
      ...env,
    },
  });
}

test('manual desktop candidates require a prerelease version, retain both platforms, and cannot publish', () => {
  const input = workflow.on?.workflow_dispatch?.inputs?.candidate_version;
  assert.equal(input?.required, true);
  assert.match(String(input?.description ?? ''), /prerelease SemVer/i);

  const publisher = workflow.jobs?.['publish-release'];
  assert.match(String(publisher?.if ?? ''), /github\.event_name == 'push'/);
  for (const jobName of ['release-mac', 'release-windows']) {
    const job = workflow.jobs?.[jobName];
    assert.doesNotMatch(runScripts(job), /gh release (?:create|upload|edit)/);
    assert.match(
      (job?.steps ?? []).map((step) => step?.uses ?? '').join('\n'),
      /actions\/upload-artifact@v4/,
    );
  }
  assert.match(String(workflow.jobs?.['release-windows']?.if ?? ''), /workflow_dispatch/);
});

test('Windows production builds fail closed without signing secrets while private candidates may remain unsigned', () => {
  const windowsJob = workflow.jobs?.['release-windows'];
  const signingGate = (windowsJob?.steps ?? []).find(
    (step) => step?.name === 'Verify production Windows signing secrets',
  );
  assert.ok(signingGate, 'release-windows must verify signing credentials before building');
  assert.equal(signingGate?.shell, 'bash');
  assert.equal(signingGate?.env?.EVENT_NAME, '${{ github.event_name }}');
  assert.equal(signingGate?.env?.WINDOWS_CSC_LINK, '${{ secrets.WINDOWS_CSC_LINK }}');
  assert.equal(
    signingGate?.env?.WINDOWS_CSC_KEY_PASSWORD,
    '${{ secrets.WINDOWS_CSC_KEY_PASSWORD }}',
  );

  const gateScript = String(signingGate?.run ?? '');
  assert.match(gateScript, /EVENT_NAME.*workflow_dispatch/s);
  assert.match(gateScript, /WINDOWS_CSC_LINK/);
  assert.match(gateScript, /WINDOWS_CSC_KEY_PASSWORD/);
  assert.match(gateScript, /Missing required Windows signing secrets/);
  assert.match(gateScript, /exit 1/);

  const privateCandidate = runBash(gateScript, { EVENT_NAME: 'workflow_dispatch' });
  assert.equal(privateCandidate.status, 0, privateCandidate.stderr);
  assert.match(privateCandidate.stdout, /may be unsigned/);

  const unsignedProduction = runBash(gateScript, { EVENT_NAME: 'push' });
  assert.equal(unsignedProduction.status, 1);
  assert.match(
    `${unsignedProduction.stdout}\n${unsignedProduction.stderr}`,
    /WINDOWS_CSC_LINK.*WINDOWS_CSC_KEY_PASSWORD/,
  );

  const partiallySignedProduction = runBash(gateScript, {
    EVENT_NAME: 'push',
    WINDOWS_CSC_LINK: 'private-certificate',
  });
  assert.equal(partiallySignedProduction.status, 1);
  assert.match(
    `${partiallySignedProduction.stdout}\n${partiallySignedProduction.stderr}`,
    /WINDOWS_CSC_KEY_PASSWORD/,
  );

  const signedProduction = runBash(gateScript, {
    EVENT_NAME: 'push',
    WINDOWS_CSC_LINK: 'private-certificate',
    WINDOWS_CSC_KEY_PASSWORD: 'private-password',
  });
  assert.equal(signedProduction.status, 0, signedProduction.stderr);

  const signingGateIndex = windowsJob.steps.indexOf(signingGate);
  const checkoutIndex = windowsJob.steps.findIndex((step) => step?.name === 'Checkout');
  const buildIndex = windowsJob.steps.findIndex((step) => step?.name === 'Build Windows installer');
  assert.ok(signingGateIndex < checkoutIndex);
  assert.ok(signingGateIndex < buildIndex);
  const buildStep = windowsJob.steps[buildIndex];
  assert.equal(buildStep?.env?.CSC_LINK, '${{ secrets.WINDOWS_CSC_LINK }}');
  assert.equal(
    buildStep?.env?.CSC_KEY_PASSWORD,
    '${{ secrets.WINDOWS_CSC_KEY_PASSWORD }}',
  );

  const jobCondition = String(windowsJob?.if ?? '');
  assert.match(jobCondition, /workflow_dispatch/);
  assert.match(jobCondition, /github\.event_name == 'push'/);
  assert.match(jobCondition, /needs\.preflight\.outputs\.mac_only != 'true'/);
  assert.doesNotMatch(jobCondition, /head_commit/);

  const preflight = workflow.jobs?.preflight;
  assert.equal(preflight?.outputs?.mac_only, '${{ steps.release-metadata.outputs.mac_only }}');
  const metadataScript = String(
    (preflight?.steps ?? []).find((step) => step?.id === 'release-metadata')?.run ?? '',
  );
  assert.match(metadataScript, /git log -1 --format=%B "\$tag_sha"/);
  assert.match(metadataScript, /grep -Fq '\[mac-only\]'/);
  assert.match(metadataScript, /mac_only=true/);
  assert.match(metadataScript, /mac_only=false/);
  assert.match(metadataScript, /mac_only=\$mac_only.*GITHUB_OUTPUT/);
});

test('production Windows verifies Authenticode after packaging while private candidates remain unsigned-compatible', () => {
  const windowsJob = workflow.jobs?.['release-windows'];
  const signatureStep = (windowsJob?.steps ?? []).find(
    (step) => step?.name === 'Verify production Windows signatures',
  );
  assert.ok(signatureStep, 'release-windows must verify the artifacts actually carry valid signatures');
  assert.equal(signatureStep?.shell, 'pwsh');
  assert.match(String(signatureStep?.if ?? ''), /github\.event_name == 'push'/);
  assert.equal(signatureStep?.env?.VERSION, '${{ needs.preflight.outputs.version }}');

  const script = String(signatureStep?.run ?? '');
  assert.match(script, /Get-AuthenticodeSignature/);
  assert.match(script, /SignatureStatus\]::Valid|Status\s+-ne\s+['"]?Valid/i);
  assert.match(script, /Clementine-Setup-\$env:VERSION\.exe/);
  assert.match(script, /win-unpacked.*Clementine\.exe/s);
  assert.match(script, /SignerCertificate/);

  const buildIndex = windowsJob.steps.findIndex((step) => step?.name === 'Build Windows installer');
  const signatureIndex = windowsJob.steps.indexOf(signatureStep);
  const feedIndex = windowsJob.steps.findIndex(
    (step) => step?.name === 'Verify Windows release assets and updater feed',
  );
  const uploadIndex = windowsJob.steps.findIndex(
    (step) => step?.name === 'Upload private Windows build artifact',
  );
  assert.ok(buildIndex < signatureIndex, 'signature verification must inspect built artifacts');
  assert.ok(signatureIndex < feedIndex, 'signature verification must fail before feed acceptance');
  assert.ok(signatureIndex < uploadIndex, 'unsigned production artifacts must never upload');
});

test('release guide matches fail-closed Windows production signing and the explicit mac-only exception', () => {
  assert.match(desktopReleaseGuideText, /WINDOWS_CSC_LINK/);
  assert.match(desktopReleaseGuideText, /WINDOWS_CSC_KEY_PASSWORD/);
  assert.match(desktopReleaseGuideText, /private manual.*unsigned/is);
  assert.match(desktopReleaseGuideText, /production.*required/is);
  assert.match(desktopReleaseGuideText, /\[mac-only\]/);
  assert.doesNotMatch(desktopReleaseGuideText, /Windows certificate\s+secrets remain optional/i);
});

test('v3.0.0 publishes curated major-release notes and other versions retain generated-note fallback', () => {
  assert.equal(existsSync(v3ReleaseNotesPath), true, 'the required v3.0.0 notes source must be checked in');
  const notes = existsSync(v3ReleaseNotesPath) ? readFileSync(v3ReleaseNotesPath, 'utf-8') : '';
  assert.match(notes, /^# Clementine 3\.0\.0/m);
  assert.match(notes, /long-horizon/i);
  assert.match(notes, /workspace/i);
  assert.match(notes, /memory/i);
  assert.match(notes, /Fusion/i);
  assert.match(notes, /approval/i);

  const publisher = runScripts(workflow.jobs?.['publish-release']);
  assert.match(publisher, /v3\.0\.0/);
  assert.match(publisher, /docs\/releases\/v3\.0\.0\.md/);
  assert.match(publisher, /release_note_args=\(--generate-notes\)/);
  assert.match(publisher, /release_note_args=\(--notes-file "\$curated_notes_file"\)/);
  assert.match(publisher, /gh release create[\s\S]*"\$\{release_note_args\[@\]\}"/);
  assert.match(
    publisher,
    /gh release edit "\$RELEASE_TAG" --notes-file "\$curated_notes_file"/,
    'a retried v3 publication must replace generic notes on an existing release',
  );
  assert.match(publisher, /Missing required curated release notes/);
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

test('desktop releases securely vendor Recall and rebuild self-validating Whisper runtimes', () => {
  assert.match(dualArchScriptText, /vendor:recall-native -- --platform darwin/);
  assert.match(dualArchScriptText, /vendor:whisper -- --target aarch64-apple-darwin --force/);
  assert.match(dualArchScriptText, /vendor:whisper -- --target x86_64-apple-darwin --force/);
  assert.match(dualArchScriptText, /WHISPER_ALLOW_VALIDATED_CACHE/);
  assert.match(dualArchScriptText, /--adopt-validated-cache/);
  assert.match(windowsReleaseText, /vendor:recall-native.*--platform.*win32/);
  assert.match(windowsReleaseText, /vendor:whisper.*x86_64-pc-windows-msvc.*--force/);
  assert.match(String(desktopPackage.scripts?.['package:dist'] ?? ''), /vendor:recall-native/);
  assert.match(String(desktopPackage.scripts?.['package:mac:unsigned'] ?? ''), /WHISPER_ALLOW_VALIDATED_CACHE=true/);
});

test('dual-architecture macOS packages stage and fail-closed verify target native dependencies', () => {
  assert.equal(desktopPackage.build?.afterPack, 'build/after-pack.cjs');
  assert.match(dualArchScriptText, /mac-native-deps\.mjs stage-x64/);
  assert.match(dualArchScriptText, /mac-native-deps\.mjs verify/);
  assert.match(dualArchScriptText, /verify_local_embeddings_packaged/);
  assert.match(afterPackHookText, /preparePackagedMacDaemon/);
  assert.match(macNativeDepsText, /@img\/sharp-darwin-x64/);
  assert.match(macNativeDepsText, /@img\/sharp-libvips-darwin-x64/);
  assert.match(macNativeDepsText, /onnxruntime-node/);
  assert.match(macNativeDepsText, /transformers\.clementine-wasm\.mjs/);
  assert.match(macNativeDepsText, /assertMachOArchitecture/);
});

test('macOS releases build, sign, package, and probe the native notch click helper', () => {
  assert.match(String(desktopPackage.scripts?.build ?? ''), /build:notch-helper/);
  assert.match(String(desktopPackage.scripts?.dev ?? ''), /build:notch-helper/);
  assert.equal(desktopPackage.build?.mac?.minimumSystemVersion, '12.0');
  assert.ok(desktopPackage.build?.mac?.binaries?.includes(
    'Contents/Resources/notch-helper/ClementineNotchHelper',
  ));
  assert.ok(desktopPackage.build?.mac?.extraResources?.some((entry) => (
    entry?.to === 'notch-helper/ClementineNotchHelper'
  )));
  assert.match(dualArchScriptText, /verify_notch_helper_packaged/);
  assert.match(dualArchScriptText, /notch-helper\/ClementineNotchHelper/);
  assert.match(dualArchScriptText, /"\$helper" --probe/);

  const ciJob = testWorkflow.jobs?.['notch-helper-macos'];
  assert.match(String(ciJob?.['runs-on'] ?? ''), /^macos-/);
  assert.match(runScripts(ciJob), /npm run typecheck/);
  assert.match(runScripts(ciJob), /build:notch-helper/);
  assert.match(runScripts(ciJob), /--probe/);

  assert.match(windowsReleaseText, /verifyPackagedPathAbsent\(\s*'notch-helper'/);
});

test('the universal npm package does not publish host-dependent Whisper binaries', () => {
  assert.ok(!rootPackage.files.includes('vendor/whisper'));
  assert.ok(rootPackage.files.includes('vendor/uv'));
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
  assert.match(scripts, /npm run check:public-hygiene/);
  assert.match(scripts, /npm run test:public-hygiene/);
  assert.match(scripts, /npm run test:release-assets/);
  assert.match(scripts, /npm run typecheck/);
  assert.match(scripts, /npm run bench:gates/);
  assert.match(scripts, /npm run eval:memory/);
  assert.match(scripts, /npm run eval:passk/);
  assert.match(scripts, /npm run eval:jobs/);
  assert.match(scripts, /refs\/remotes\/origin\/main/);
  assert.match(scripts, /tag_sha.*main_sha/s);
  assert.match(scripts, /source_version.*package\.json/s);
  assert.match(scripts, /desktop_source_version.*apps\/desktop\/package\.json/s);
  assert.match(scripts, /source_version.*tag_version.*desktop_source_version.*tag_version/s);
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

test('Windows artifacts use updater-safe names and are verified before upload', () => {
  assert.equal(desktopPackage.build?.nsis?.artifactName, '${productName}-Setup-${version}.${ext}');
  assert.match(
    runScripts(workflow.jobs?.['release-windows']),
    /verify-desktop-release-assets\.mjs.*--platform windows/,
  );
});
