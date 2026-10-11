# Mobile composer corners — 2026-10-11

The user's physical-iPhone screenshot identified visible square gray corners
behind the rounded New chat input. Reproduced in the real built mobile web UI
using synthetic fixture data at 390 × 844; this was a visual defect that earlier
horizontal-overflow checks missed.

## Change

Source commit: `27406d1c91d771dea5690e776147dfe1f30b2b68`, on
`codex/mobile-shell`, based on `b7e1793453e96c10cf01d168ceb856fd953cd03d`.

- The scrolling chat dock and home Ask capsule now own their rounded surface,
  border and light shadow. The inner form no longer casts a shadow that gets
  clipped by a rectangular scroller, or applies a separate backdrop filter.
- Voice and typing share one surface. Removed the redundant idle voice-route
  instruction; kept the explicit Talk to Clem action and dictation guidance.
- Kept viewport limits, keyboard/safe-area offsets, 44px controls and measured
  bottom clearance. No voice controller, sending, connection or native changes.

Only `apps/mobile-web/src/styles.css` and `apps/mobile-web/src/screens/Chat.tsx`
changed. Preserve the installer's newer Chat behavior by applying the exact
additive patch, never by replacing its entire file.

## Evidence and handoff

Evidence directory: `output/mobile-composer-2026-10-11/`.

- Production TypeScript/Vite build passed (`build.log`). Existing chunk-size
  warning remains. Candidate assets: `main-CG2B7QsR.js`, `main-BFapUaiR.css`.
- Existing shell and compose-route checks: 19/19 passed (`shell-tests.log`).
- Independent source review found no concrete regressions. Removing the form's
  backdrop filter also removes a fixed-position containing block for its sheet.
- The fixture reproduced the supplied screenshot in `voice-390-before.png`.
  Root reviewed `voice-390-after.png`; square corners are gone. All six bounded
  browser cases passed (`verification.json`): initial voice route, full-width
  attachment sheet, 320px width with 200% text, multiline unsent draft, 260px
  viewport with scroll reachability, and Home capsule. Additional saved images
  include `voice-320-large-after.png` and `attachment-390-after.png`.
- `composer-additive.patch` SHA-256:
  `b1010422670126cdb8fbced0caad5edff31a5dacb320495a9a6036a900df4ec6`.
  `handoff-manifest.json` records base/candidate file hashes and limits.
- Read-only apply check passed against the active Mac installer's dirty
  `81b0e6316` checkout. That lane remains the sole hotpatch/restart owner.

Exact patch and evidence were sent to the authorized Mac installation task,
“Audit Harness Speed and Token Usage,” for its next safe hotpatch. No local
runtime was restarted by this lane.

Not installed at this checkpoint. Latest installed Mac is batch6 `57a4df00`,
with the prior mobile assets. This web refinement needs no new native binary.
Browser fixture acceptance does not prove physical iPhone keyboard behavior or
widget voice/dictation capture. Native build16 signing/device acceptance remains
separate and pending; no live-home data, settings or provider calls were changed.

## Additive integration independently checked — 20:03 UTC

The installer has integrated the exact patch into its newer Chat source.
Read-only verification confirmed its integration receipt SHA-256
`91faad178b38b48c07f112b52c3fccfe8d0ddbf918da2cfe773a2139818a2f55`, both
announced merged-file hashes, exact candidate CSS bytes, and a successful
reverse-patch check. Evidence: `integration-verification.json` in the same output
directory. This verifies source integration only: installed fingerprint remains
batch6 `57a4df00`; the next build/hotpatch and physical phone acceptance are pending.

## Installed and served verification passed — 20:21 UTC

Supersedes the pending-install status above. Mac owner installed/reopened batch7,
fingerprint `e5ca57396d4c9613f7df4f895bffc396760dd1ca28fe2ffff63b473d6b36d527`,
schema93. This lane independently verified receipt SHA-256
`c3c191f4bbf07fd7dd2a3d60335bc9429a16bf87b6ae26ed6af196ce84830953`, installed
build stamp, full mobile tree against built tree/receipt, and HTTP 200 served
index/CSS/JS bytes against the actual installed bundle at port8520.

Served assets are `main-Cll_Bgp1.js` (newer installer Chat preserved) and
`main-BFapUaiR.css` (byte-identical to the visually reviewed candidate). A separate
read-only reviewer confirmed all intended composer styles and voice/dictate copy
conditions in those installed bundles. Full hashes and limits are recorded in
`output/mobile-composer-2026-10-11/installed-served-verification.json`.

The web change is available for the iPhone's next page load. Physical iPhone
corners, safe area and keyboard verification remain pending, as does native widget
voice/dictation capture acceptance. This check performed no app lifecycle action,
live-home write, microphone capture or provider request.
