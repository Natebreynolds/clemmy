# Browserbase blank desktop viewer — native fix prepared

Updated 2026-10-04 04:35 UTC. This is the owner's explicitly requested browser repair, separate from the paused harness monitor.

## Diagnosis

The owner's screenshot shows an active Browserbase resource and the Instacart title/URL, but no browser pixels. The installed Electron shell applies its ordinary external-navigation guard to the Browserbase iframe. That guard prevents the frame from loading and can pass its private viewer URL to the external browser. Backend success and page metadata therefore do not establish a visible viewer.

The same failure was reproduced with Electron 43 using a local dashboard and a synthetic Browserbase response. The old rule leaves the iframe empty. The new rule renders the controlled viewer. No Browserbase session, model call, personal website interaction, or live-home fixture was created for these checks.

## Source and installed state

- Worktree: `/Users/nathan.reynolds/.codex/worktrees/browserbase-live-view/clementine-next`.
- Branch: `codex/browserbase-live-view`. Changes remain uncommitted for review/integration.
- Base was advanced to the newly installed `633f0094a4373d703043000af5b3c7ca1c33596c`, preserving the other agent's latest runtime changes. There is no desktop-source delta between the earlier `9e14f2c02` base and this commit.
- Latest private authenticated running identity: `633f0094a4373d703043000af5b3c7ca1c33596c`, fingerprint `7a436b8e5de9b567135a274a5ddd0ff3ff793cc02b7f32d64969883c6660d2ae`, schema/expected schema 92, daemon instance `74b02350-44d4-43a3-afe1-d906b5977d04`, no cutover hold.
- Installed native ASAR remains 3.18.24 and lacks the new browser-viewer policy. ASAR SHA-256: `594a3968c994618fe8d750c3d0563ff3e1f3751cec41abe7a900333294aea48f`.
- Native TypeScript compiled successfully. No signed candidate was packaged, no app was installed/restarted, and no live acceptance is claimed.

## Patch

`apps/desktop/src/browser-viewer-navigation-policy.ts` adds a narrow exception for exact HTTPS Browserbase origins in a direct child of the actual trusted dashboard. Electron parent, top frame, and initiator identities must agree. Workspace content and other surfaces cannot acquire this exception. Browserbase is not added to the privileged IPC sender classification.

`apps/desktop/src/main.ts` uses that policy for frame navigation and redirects. Provider viewer URLs are denied as top-level navigation or popups without external-browser handoff. This guarantee covers provider URLs; it does not claim that every possible popup destination from a provider document is blocked.

Redirect permission follows an admitted stable frame identity. A separate deny-only marker survives late failures/cancellation so a stale failure cannot make a replacement frame's redirect fall through to ordinary localhost navigation. Markers disappear when the frame disappears, the main document commits navigation, or the window is destroyed. A late failure can conservatively reject a valid redirect until fresh viewer navigation; it cannot grant access. Missing initiator evidence remains denied.

## Verification

- 17 focused policy and existing Workspace tests passed through the repository's isolated test runner.
- Desktop TypeScript check and compilation passed; whitespace check passed.
- `node apps/desktop/scripts/browser-viewer-navigation-smoke.cjs` passed seven scenarios with real Electron 43 events: old-rule blank reproduction, viewer rendering, provider redirect, in-flight replacement followed by provider redirect, localhost redirect rejection, external redirect rejection, and Workspace mount rejection.
- The smoke script intercepts HTTPS locally and blocks other remote requests. Its disposable Electron profile is separate from the live app. Results explicitly identify `liveProvider: false` and `installedApp: false`.
- Receipts: `output/browserbase-live-view/native-navigation-smoke.json`, `old-rule-blank.png`, and `viewer-renders.png`.

Still untested: actual Browserbase viewer documents/streaming and any provider subframes, installed-app Watch/Take control/renewal, physical mobile rendering, and native signed-candidate installation. The native fix addresses the desktop screenshot; it does not establish that a phone-specific problem is fixed.

## Delivery blocker and safe next step

Disk free space was approximately 2 GB initially and 4.1 GB at the latest check. The owner was asked to free at least 15 GB and unlock the Mac; screen control had reported it locked. No unrelated backups, other-agent worktrees, or personal files were deleted.

This is a native-shell change. The existing daemon/web hotpatch deliberately preserves native ASAR bytes and cannot install it. The documented supported route is a signed, notarized whole-app candidate via `npm --prefix apps/desktop run package:mac`, without publishing. Signing prerequisites appear present, but their use/validity has not been tested.

Do not run that command in this worktree with its current dependency symlinks: the release script vendors Recall and rebuilds SQLite in dependencies. Create private dependency copies/installations first, and recheck the actually installed runtime identity before selecting the candidate base. If installation has advanced again, reconcile this patch without overwriting the newer runtime.

The signed candidate also needs an explicit review of the native delta from installed 3.18.24: the existing update disk-space guard and bounded shutdown changes are in current source but have not been delivered by runtime hotpatches. Preserve those owners' work and record what the candidate includes. Do not patch a freshly signed bundle after signing or bypass signature checks.

Before replacing the app, retain a whole-bundle rollback, verify there are no active runs or starting/recording/stopping local or Recall captures, and account for pending updater/Squirrel staging. Then install the final signed bundle unchanged, verify served and native identities, and validate a named controlled Browserbase fixture in the installed app/live home. Watch, Take control, renewal/reconnection, Stop, and a physical mobile view remain acceptance work. Do not reuse or reset the owner's Instacart session as a fixture.
