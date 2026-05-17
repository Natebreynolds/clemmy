/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * electron-builder afterAllArtifactBuild hook — notarizes the
 * produced macOS .dmg artifacts via Apple's notarytool service and
 * staples the resulting ticket in place.
 *
 * Why this hook exists:
 *   The `afterSign` hook in notarize.cjs notarizes the .app bundle
 *   inside the DMG. electron-builder then packages that .app into
 *   the .dmg wrapper — but the DMG itself is not signed, not
 *   notarized, and not stapled. On stricter macOS configurations
 *   (recent macOS, networks that can't reach Apple's notary check
 *   at first launch, etc.) Gatekeeper rejects the unsigned DMG
 *   with "damaged, move to trash" before the user ever sees the
 *   .app inside.
 *
 *   `@electron/notarize` accepts a .dmg path directly. When given
 *   one it uploads the DMG to Apple's notary service, waits for
 *   the ticket, and staples the ticket onto the DMG. After this
 *   runs the DMG is Gatekeeper-clean on a fresh Mac.
 *
 * Required environment variables (same set as notarize.cjs):
 *   APPLE_ID
 *   APPLE_APP_PASSWORD
 *   APPLE_TEAM_ID
 *
 * If APPLE_NOTARIZE_SKIP=true is set, DMG notarization is bypassed
 * (matches the .app-level hook behavior for local dev builds).
 *
 * .zip artifacts are NOT processed: a zip of a notarized + stapled
 * .app is Gatekeeper-clean because the staple lives inside the
 * .app, not on the container. Only the DMG wrapper needs its own
 * staple.
 */

const path = require('node:path');

exports.default = async function afterAllArtifactBuild({ artifactPaths, platformToTargets }) {
  if (process.env.APPLE_NOTARIZE_SKIP === 'true') {
    console.log('  [notarize-dmg] APPLE_NOTARIZE_SKIP=true — bypassing DMG notarization');
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
    console.warn('  [notarize-dmg] missing APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID — skipping DMG notarization.');
    console.warn('  [notarize-dmg] DMGs will go out UNSIGNED — Gatekeeper will mark them "damaged" on fresh Macs.');
    return [];
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
    console.log(`  [notarize-dmg] uploading ${filename} to Apple notary service (this can take a few minutes)…`);
    const start = Date.now();
    await notarizeFn({
      tool: 'notarytool',
      appPath: dmgPath,
      appleId,
      appleIdPassword: applePassword,
      teamId,
    });
    console.log(`  [notarize-dmg] ${filename} notarized + stapled in ${Math.round((Date.now() - start) / 1000)}s`);
  }

  return [];
};
