/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * electron-builder afterSign hook — notarizes the macOS .app via
 * Apple's notarytool service.
 *
 * Required environment variables:
 *   APPLE_ID            - the Apple ID email (e.g. developer@example.com)
 *   APPLE_APP_PASSWORD  - an app-specific password from appleid.apple.com
 *   APPLE_TEAM_ID       - the developer Team ID
 *
 * If APPLE_NOTARIZE_SKIP=true is set, notarization is bypassed
 * (useful for local builds you don't intend to distribute).
 *
 * Notarization can take 30s–10min depending on Apple's queue. The
 * hook waits for the ticket to staple before resolving.
 */

const path = require('node:path');

exports.default = async function notarizing(context) {
  if (process.env.APPLE_NOTARIZE_SKIP === 'true') {
    console.log('  [notarize] APPLE_NOTARIZE_SKIP=true — bypassing notarization');
    return;
  }

  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') {
    return; // Only macOS gets notarized via this hook.
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const appleId = process.env.APPLE_ID;
  const applePassword = process.env.APPLE_APP_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !applePassword || !teamId) {
    throw new Error('[notarize] missing APPLE_ID / APPLE_APP_PASSWORD / APPLE_TEAM_ID; set APPLE_NOTARIZE_SKIP=true only for an explicit unsigned developer build');
  }

  // Lazy-require so dev installs without @electron/notarize don't break
  // the build configuration import.
  let notarizeFn;
  try {
    ({ notarize: notarizeFn } = require('@electron/notarize'));
  } catch (err) {
    console.error('  [notarize] @electron/notarize not installed. Run `npm install --save-dev @electron/notarize` inside apps/desktop/.');
    throw err;
  }

  console.log(`  [notarize] uploading ${appName}.app to Apple notary service (this can take a few minutes)…`);
  const start = Date.now();
  // @electron/notarize v3 removed the legacy `tool` option — notarytool is the
  // only path now; passing the old key throws on validation.
  await notarizeFn({
    appPath,
    appleId,
    appleIdPassword: applePassword,
    teamId,
  });
  console.log(`  [notarize] notarized + stapled in ${Math.round((Date.now() - start) / 1000)}s`);
};
