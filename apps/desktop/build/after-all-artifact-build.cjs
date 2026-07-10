/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * electron-builder afterAllArtifactBuild hook — signs, notarizes, and
 * staples the produced macOS .dmg artifacts.
 *
 * Why this hook exists:
 *   The `afterSign` hook in notarize.cjs notarizes the .app bundle
 *   inside the DMG. electron-builder then packages that .app into
 *   the .dmg wrapper — but the DMG itself is not signed by default
 *   on modern electron-builder/macOS combos, so the DMG hits
 *   Gatekeeper as "code object is not signed at all". On macOS
 *   Sequoia + recent Sonoma releases that means a fresh download
 *   shows "damaged, move to trash" before the user ever sees the
 *   .app inside.
 *
 *   This hook:
 *     1. Code-signs each .dmg with the Developer ID Application cert
 *        (notarytool requires a signed artifact).
 *     2. Submits the signed DMG to Apple's notarytool service.
 *     3. Staples the ticket onto the DMG so Gatekeeper works offline.
 *
 *   After this runs each DMG is Gatekeeper-clean on a fresh Mac and
 *   passes `spctl --assess --type open --context context:primary-signature`.
 *
 * Required environment variables (same set as notarize.cjs):
 *   APPLE_ID
 *   APPLE_APP_PASSWORD
 *   APPLE_TEAM_ID
 *
 * Optional:
 *   APPLE_SIGNING_IDENTITY — full common name of the Developer ID
 *     Application cert (defaults to the team-id-derived form
 *     "Developer ID Application: <name> (<teamId>)"). Set this
 *     explicitly when the cert in the keychain has a non-default
 *     common name.
 *
 * If APPLE_NOTARIZE_SKIP=true is set, the whole pipeline is bypassed
 * (matches the .app-level hook behavior for local dev builds).
 *
 * .zip artifacts are NOT processed: a zip of a notarized + stapled
 * .app is Gatekeeper-clean because the staple lives inside the
 * .app, not on the container. Only the DMG wrapper needs its own
 * signature + staple.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with status ${result.status}`);
  }
}

function findSigningIdentity(teamId) {
  if (process.env.APPLE_SIGNING_IDENTITY) return process.env.APPLE_SIGNING_IDENTITY;
  const result = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf-8' });
  if (result.status !== 0) return null;
  const re = new RegExp(`"(Developer ID Application:[^"]*\\(${teamId}\\))"`);
  const match = result.stdout.match(re);
  return match ? match[1] : null;
}

exports.default = async function afterAllArtifactBuild({ artifactPaths }) {
  if (process.env.APPLE_NOTARIZE_SKIP === 'true') {
    console.log('  [notarize-dmg] APPLE_NOTARIZE_SKIP=true — bypassing DMG sign+notarize');
    return [];
  }

  // electron-builder targets multiple platforms; only act on macOS.
  // Easiest check: is there at least one .dmg in the artifact set?
  const dmgs = artifactPaths.filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) {
    return [];
  }

  const appleId = process.env.APPLE_ID;
  const applePassword = process.env.APPLE_APP_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !applePassword || !teamId) {
    throw new Error('[notarize-dmg] missing APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID; set APPLE_NOTARIZE_SKIP=true only for an explicit unsigned developer build');
  }

  const identity = findSigningIdentity(teamId);
  if (!identity) {
    throw new Error(`[notarize-dmg] no Developer ID Application certificate for team ${teamId} was found in the keychain`);
  }

  let notarizeFn;
  try {
    ({ notarize: notarizeFn } = require('@electron/notarize'));
  } catch (err) {
    console.error('  [notarize-dmg] @electron/notarize not installed. Run `npm install --save-dev @electron/notarize` inside apps/desktop/.');
    throw err;
  }

  for (const dmgPath of dmgs) {
    const filename = path.basename(dmgPath);

    console.log(`  [notarize-dmg] signing ${filename} with "${identity}"…`);
    run('codesign', ['--sign', identity, '--timestamp', '--force', dmgPath]);
    run('codesign', ['--verify', '--verbose=2', dmgPath]);

    console.log(`  [notarize-dmg] uploading ${filename} to Apple notary service (this can take a few minutes)…`);
    const start = Date.now();
    await notarizeFn({
      appPath: dmgPath,
      appleId,
      appleIdPassword: applePassword,
      teamId,
    });
    // @electron/notarize calls `xcrun stapler staple` for .app and .pkg,
    // but on some versions it skips DMGs. Run it explicitly so the
    // ticket is embedded in the DMG header — required for Gatekeeper
    // when the user is offline.
    run('xcrun', ['stapler', 'staple', dmgPath]);
    run('xcrun', ['stapler', 'validate', dmgPath]);
    console.log(`  [notarize-dmg] ${filename} signed + notarized + stapled in ${Math.round((Date.now() - start) / 1000)}s`);
  }

  return [];
};
