# Mobile clipping and widget connection recovery — October 11, 2026

User reports that mobile areas still cut off and widget Talk/Dictate do not connect. Build 15 installation was verified in the earlier direct-widget checkpoint, but enrollment, microphone capture, and actual widget execution never passed physical acceptance. Do not treat its source tests or installation as proof of operation.

## Findings and changes

- A warm intent could request setup after foreground/unlock transitions without presenting the native sheet. RootView now observes each setup request, including repeated requests after dismissal, while retaining paired/unlocked/foreground gates.
- Native setup previously returned silently when readiness was missing and JavaScript optional chaining reported success without a callback. Explicit reconnect now probes the current page; missing support has an explicit Reload Clem action. Reload retains pairing and browser storage.
- Settings now exposes Widget voice on native builds that advertise the setup handler. Opening setup does not begin recording.
- Reconnect remains reachable beside retained drafts, recordings, and uncertain request receipts. Authentication failures revoke displayed readiness. Permission and Live Activity errors have bounded recovery messages; private diagnostics persist only stage, issue, and time.
- Native requests refresh discovered LAN/relay origins for the same pinned Mac. Credentials never cross a changed pairing.
- Enrollment failures preserve request correlation and communicate bounded reasons only; no raw server errors or secrets enter diagnostics. Cancellation does not reopen setup.
- Repeated reconnect attempts cannot let an obsolete enrollment success or failure overwrite a newer connection. Transport returns an obsolete outcome, and a separate provisioning generation fences UI callbacks across actor hops.
- Narrow Project, Space, and Agent detail headers put their full wrapping title below navigation/actions. Reproduced Project issue at 320px and 200% text: title was squeezed to 59px. Native recovery button rows use vertical fallbacks when needed.

## Verification

Final signed Simulator suite: 78 tests passed, zero failures. This includes synthetic native Keychain enrollment, correlated failed enrollment receipts, actual JavaScript dispatch, same-pin origin refresh, repeated Combine setup events, and privacy/recovery gates. The final added regression exercises enrollment A, reconnect/accept B, then late success and failure receipts from A; B remains ready. No provider calls or personal data changes.

Evidence: `output/mobile-recovery-2026-10-11/native-tests-reconnect.xcresult` and `native-tests-reconnect.log`, exit 0. Earlier runs passed 75 and 77 tests before the repeated-presentation and obsolete-enrollment regressions were added. Web native bridge suites passed 14 tests combined. Mobile TypeScript/Vite build passed: `main-BqDDq1fS.js`, `main-DgoBjwze.css`.

Actual Chrome rendering of production components with controlled data passed the final visual check: Project title at 320px/200% text now measures 288px without truncation; Settings native setup entry at 375px fits and dispatches; Project at 390px fits; landscape drawer scrolls with reachable controls; short-height sheets keep their controls reachable. Coverage and limits: `output/mobile-fit-2026-10-11/verification.json`. Before/after and Settings screenshots are saved beside it. This is browser fixture evidence, not physical WKWebView keyboard/safe-area acceptance. Fixture server stopped after verification.

## Installation and acceptance limits

Native source commit is `da3d85139`, project version 16. The physical build failed in codesign with `errSecInternalComponent`; it is not a signed install candidate. User was asked to unlock the Mac login keychain without sharing a password. CoreDevice currently reports Nate unavailable; user was asked to cable-connect/unlock/open Clem. Build 16 has not been installed. Last verified phone build remains 15. Do not change Keychain ACLs or pairing to work around this.

Mac installer task “Audit Harness Speed and Token Usage” remains the sole hotpatch/restart owner. Its optimization batch2 installation is in progress; no Mac installation or restart occurred in this lane. The eight-file mobile-only additive patch passes `git apply --check` against that worktree. Patch: `output/mobile-recovery-2026-10-11/mobile-recovery-additive.patch`, SHA256 `14db79a440b200a66dd207b89ae54633ede54627b7e3a24a98c50985414737db`. It contains no backend changes and must preserve the installer's newer mobile conversation/draft/control fixes.

Web commit: `06e05d069`. The exact patch and completed visual evidence were sent to the authorized installer for integration after its current batch acceptance. Installation of this patch is not yet confirmed; current serving identity must be read from its new receipt before physical acceptance.

Installer handoff received after source freeze: optimization batch2 is installed, authenticated fingerprint `3fe66c0a094b070592e64743a3bb5ac200c1c3de21fe54be0ec3b5062d7aeaac`, schema 93, daemon `0f267590-e05d-41bf-9b1c-d3d96961e0d0`, started `2026-10-11T18:21:14.283Z`. This is still before the queued eight-file mobile recovery patch. Installer receipt SHA256 `ba97bbfc60c5ca51e35f977e298d505c09072c0419141f5606954799158b1eef`; its controlled read and Stop/Continue acceptance is in progress. This lane has not authenticated the server independently or claimed phone acceptance against it.

Later installer handoff: the exact eight-file web patch is applied additively to its next candidate, with five bridge tests passing. This lane independently confirmed `git apply --reverse --check` succeeds for the frozen patch. It is not installed yet; the controlled Stop/Continue task still owns the running batch2 daemon, so no restart was performed. A fresh CoreDevice read still reports Nate unavailable. Native signing, installation, and physical acceptance remain pending.

Physical acceptance remains required: open Settings → Widget voice, verify successful enrollment, then use actual Home Screen Dictate and Talk, including a saved draft, actual reply, cancellation, locked-device authentication, and off-LAN relay. Bind observations to the authenticated served Mac identity and phone build. If it fails, read Voice connection details for the bounded stage/issue code. Do not claim that source changes established the user's exact failure cause or that actual background recording now works.
