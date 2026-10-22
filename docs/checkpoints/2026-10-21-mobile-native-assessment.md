# Mobile layout and native assessment — 2026-10-21

## Status and scope

The immediate recommendation is to repair the shared mobile layout, then qualify it in WKWebView and on the user's phone. Keep the current hybrid architecture for this pass. A newer native SDK and a bounded native adaptation are a separate step for iPhone Duo's reserved regions; a full SwiftUI rewrite is not justified by this audit.

This is a source and platform assessment, not a passing acceptance report. The parent task is still implementing and testing the web layout. No native source, signing, account, pairing, runtime, or device state was changed for this assessment. No simulator was booted, and no build, installation, microphone capture, or model request was performed.

The required September continuity checkpoints and AGENTS.md were reviewed. Their configuration snapshots are historical, not current authority. Personal/business Spaces and integrations remain outside this framework task. Do not aim fixture resets at the live home.

## Source, ownership, and installed identity

- Audited baseline: `1443b1fc921778f8ab0ed72571fad3b8113200f8`, clean branch `claude/r45-efficiency` in the peer `scratchpad/r45` checkout. It was rechecked during this assessment.
- Implementation checkout: `/Users/nathan.reynolds/.codex/worktrees/mobile-adaptive/clementine-next`, branch `codex/mobile-adaptive-2026-10-21`, created from that baseline. Other agents' mobile edits are in progress; this assessment owns only this document. Baseline line references below describe the pre-fix source, not completed changes.
- Installed daemon: `~/Applications/Clementine.app/Contents/Resources/daemon`. On 2026-10-22 around 03:40 UTC (October 21 local), its build stamp and authenticated, first-party `GET /api/console/build-info` agreed: version **3.18.49**, full SHA above, `gitDirty=false`, fingerprint **b73fb1b0856e5c21ca8ebeb38e556b9447717cf2725554f061cbd97b788bc604**, expected/actual schema **99/99**, process start `2026-10-22T03:32:03.224Z`.
- A read-only `GET /api/console/settings` reported active mode `api_key`; model backend `all_in`, primary/judge/worker strings `glm-5.2`, label `GLM (Z.ai)`, configured true; Claude vault configured true; fusion off, separately configured judge role `claude-sonnet-5`. These are configuration observations, not evidence of an actual served model or provider validation. No credentials or personal profile data were output or saved.

The installed Mac daemon identity does not identify the native app currently installed on the iPhone. Native build 17 is declared by this source's `apps/ios/project.yml`; physical installation/version was not checked here.

## Confirmed source constraints

| Area | Evidence at baseline | Consequence |
| --- | --- | --- |
| Native keyboard ownership | `apps/ios/Clem/RootView.swift:214–215` uses `PinnedWebView(...).ignoresSafeArea()`; `PinnedWebView.swift:319` sets `contentInsetAdjustmentBehavior = .never`. | The shell delegates avoidance to web geometry. The unqualified SwiftUI modifier ignores keyboard safe area too. Leave this unchanged in the current pass, so two owners do not both compensate. |
| Web keyboard geometry | `apps/mobile-web/src/lib/use-keyboard-inset.ts:4–5` reads `innerHeight` and `visualViewport`; `visible-viewport.ts` derives visible top/height/bottom inset. `styles.css:135` retains a `100dvh` root and `1943` lifts a fixed dock. | Correct arithmetic alone does not establish keyboard-animation correctness on WKWebView. Explicit visible bounds and a stable action row need runtime checks. |
| Send can scroll away | `Composer.tsx:324–388` places context, attachments, growing text and optional chips before Send; `styles.css:6022–6033` gives the whole dock `overflow-y:auto` and a height cap with a 120px floor. | A short available height plus additional content can hide the action row inside the dock. This is a structural layout defect independent of a claim that every keyboard event is mismeasured. |
| Wide layout | `styles.css:450–461` caps main content at 760px; `1949` caps the dock at 728px. | The current phone column does not automatically become a useful master/detail workspace on a larger display. Breakpoints should follow actual available CSS dimensions, not physical-pixel device specifications. |
| Orientation and device family | `apps/ios/Clem/Info.plist:40–45` supports portrait and both landscapes; `project.yml:56,92` targets iPhone; minimum iOS is 17. | No orientation-plist change is required for this repair. An unfolded Duo remains an iPhone; adding iPad support is a separate product decision, not a necessary foldable fix. |
| Resizing continuity | `RootView.swift:9,18–20` retains its model; `PinnedWebView.swift:1394–1395` returns the existing WKWebView and has an empty update method. No orientation handler reloads it. | Ordinary resizing should retain the document and conversation. This is an architectural expectation to test, not physical-device proof. Do not recreate the web view or re-key Chat at a width breakpoint. |
| Draft limits | `apps/mobile-web/src/lib/file-context.ts:46–52` and `chat-location.ts` explicitly use window-local stores; `Chat.tsx:178,253,427` scopes and promotes drafts. | Resizing within the same document differs from reload/process termination. Do not promise recovery of unsent text/context/uploads after either event. Pending-request receipt storage is not general draft persistence. |

Existing native features are substantial: certificate-pinned pairing and transport, biometric access, system sharing/downloads, WidgetKit, Live Activities, and app-process voice recording. `ClemWidgets/ClemWidgets.swift` already provides native widget/control families; widget snapshots are separate from the web composer. Rewriting the main conversation UI is not required to keep these capabilities.

## What Apple's current documentation changes

Apple's [Duo design guidance](https://developer.apple.com/design/human-interface-guidelines/designing-for-iphone-duo) recommends compact/regular adaptation with continuous state and hierarchy, not a separate design for each pose. It also describes fold and camera reserved regions. Standard native split views, sheets and navigation components receive adaptations that custom HTML controls do not become merely by being hosted in WKWebView. Generic width and safe-area support should therefore not be advertised as complete partial-fold support.

The [developer preparation overview](https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo) explicitly says Xcode 26-and-earlier builds do not extend under the Duo status bar/camera. A current SDK build is needed to use that additional area. This is a documented compatibility limitation, not proof that it caused the user's hidden Send button.

[UIView.ReservedRegion](https://developer.apple.com/documentation/uikit/uiview/reservedregion) is documented for **iOS 27.1+**. Its frames are in the owning view's points and already include margins. Standard scrolling containers do not automatically divide their content around a fold. A future native adapter must obtain actual regions and convert them into the web view's coordinate system, or put suitable native layout containers around content. Do not infer a center hinge, multiply physical pixels into CSS offsets, or assume `env(safe-area-inset-*)` expresses an interior division.

For the ordinary keyboard, [SwiftUI's safe-area modifier](https://developer.apple.com/documentation/swiftui/view/ignoressafearea(_:edges:)) explains the current all-regions behavior. [UIKit's keyboard layout guide](https://developer.apple.com/documentation/uikit/adjusting-your-layout-with-keyboard-layout-guide) supplies an alternative native source of keyboard geometry, with explicit handling for floating keyboards. Adopting it later must replace or reconcile web compensation, not add another blind lift.

[WKWebView](https://developer.apple.com/documentation/webkit/wkwebview) remains a supported view for embedding interactive web content. The recommendation to retain it is based on this repository's shared behavior and implementation cost, not an Apple claim that hybrid is faster. A native rewrite would require maintaining the conversation receipt, approval, retry, attachment, preview and recovery contracts a second time. There is no measured native-versus-web speed result in this assessment.

## Phased recommendation

1. **Current web repair:** keep keyboard geometry under one owner; keep Send/Stop visible while the draft/context body scrolls; minimize optional status chrome during typing; retain readable controls at short and narrow sizes. Keep the existing drawer. For wider space, expose another level of existing hierarchy only when both panes fit. Preserve the selected conversation, unsent text, context and attachments through resizing.
2. **WKWebView and physical qualification:** run the synthetic layout matrix below, then verify the installed assets on the actual phone and iOS version. Record native app build plus served mobile asset identity. Measure layout and interaction errors before claiming a fix; measure real-device responsiveness before proposing performance work.
3. **Duo-native adaptation:** obtain a compatible newer Xcode/SDK and iOS 27.1/Duo test environment; inspect real reserved regions and system bar behavior. Evaluate a narrow geometry bridge or native navigation/container layer while retaining the shared conversation renderer. Preserve trusted-origin/foreground checks and existing authentication. Do not change native safe-area ownership casually.
4. **Consider a larger native conversion only with evidence:** a persistent keyboard, accessibility, navigation, or rendering issue that survives a sound shared layout can justify converting that surface. Do not make a full rewrite the prerequisite for fixing Send.

## Simulator feasibility and acceptance limits

Read-only inventory found `/Applications/Xcode.app/Contents/Developer`, **Xcode 26.6 (17F113)**, and these installed runtimes:

- iOS **26.3** — runtime OS **26.3.1**, build **23D8133**.
- iOS **26.5** — build **23F77**.

All listed simulators were shut down. Available iPhone models include 17 Pro, 17 Pro Max, 17e, Air and 17 on both runtimes, plus 16e on 26.3; iPad simulators are also available. No iOS 27 runtime or Duo simulator was listed. The user's iOS 27/Duo environment cannot be established by these iOS 26 simulators. Its exact physical OS/build was not independently read here.

A safe next simulator test can use a disposable simulator and a separate test-only WKWebView harness, with a nonpersistent website data store and the built mobile UI pointed at deterministic local fixture responses. Match relevant web-view geometry/configuration without instantiating the paired production RootView. Permit only fixture-origin requests; never copy pairing keys, sessions, the live home, real conversations, or production API credentials into it. Do not run an existing paired simulator or reset one. A fixture harness can test layout and synthetic admission states, but it cannot qualify production TLS, pairing, permissions, or provider execution.

The matrix should assert that the action row remains inside the visible viewport with the software keyboard shown, including long text, attachment/context, pending/error labels, large text, portrait, short landscape, and rapid resizing. Verify focus and draft identity through narrow-to-wide changes, sheet open/close, and keyboard show/hide. Test native WKWebView separately from Safari; neither a desktop browser viewport nor static screenshots recreate a native keyboard. Existing `WidgetRenderingTests.swift` ImageRenderer fixtures only establish rendered widget content, not actual WidgetKit hosting or fold behavior.

For the actual Duo, record outer/fully-open/partly-folded poses, orientation, display zoom, text size, native app build, served asset hashes, CSS visible bounds and measured element rectangles without saving conversation text. Compare the same controlled UI fixture in Safari and the paired native app. Do not convert a passed simulation into physical acceptance or an efficiency claim. Apple's [simulator guidance](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices) explicitly distinguishes simulated behavior/performance from hardware; [release testing guidance](https://developer.apple.com/documentation/xcode/testing-a-release-build) calls for actual-device verification.

No step in this proposed matrix has been executed by the assessment subtask. Installed-app/live-home acceptance remains the final framework requirement and must use named controlled fixtures without destructive resets.
