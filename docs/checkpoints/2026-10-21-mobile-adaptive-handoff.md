# Mobile adaptive layout — 2026-10-21

## Outcome and integration

This pass addresses the owner's disappearing Send button, mobile responsiveness, narrow outside-screen use and wider unfolded-window use. It is an implementation candidate with source/test/build evidence; it is **not installed-app, physical iOS, or full iPhone Duo acceptance**.

- Branch: `codex/mobile-adaptive-2026-10-21`
- Worktree: `/Users/nathan.reynolds/.codex/worktrees/mobile-adaptive/clementine-next`
- Base: `1443b1fc921778f8ab0ed72571fad3b8113200f8`, rechecked clean in the active `claude/r45-efficiency` checkout.
- Native assessment: commit `0a71b0318`; [assessment and platform sources](2026-10-21-mobile-native-assessment.md).
- Memory UI work remains on its separate branch, `codex/memory-workspace-2026-10-21`; it is not a dependency of this mobile change.

The owner already assigned integration before the next tag to the other task. No shared-checkout edits, runtime restart/hotpatch, native installation, tag, provider request, or personal data changes were performed here. Integrate only this branch's commits after the base into the current release tree; preserve the other agent's later changes and token-meter work. Rebuild and verify served assets from the integrated tree before accepting it.

## Confirmed findings and changes

| Priority | Finding | Result |
| --- | --- | --- |
| P1 | The entire composer was scrollable, including Send. Context, voice status, files and a long draft could push controls beyond the clipped dock. | The draft/context/status body scrolls independently. Send and Stop sit in a nonshrinking action row. The 120px minimum dock-height floor is removed. All errors, context and voice controls remain accessible in the scroll body. |
| P1 | Window/visual-viewport events synchronously updated App and Chat component state during keyboard animation. | A shared observer coalesces resize/pan events to one measurement per frame; unchanged bounds do not notify. CSS geometry updates directly, without a top-level App or Chat state subscription. Sheets retain their own visible-viewport measurement. |
| P1 | Dock, fade, last-message spacing and navigation did not consistently share visible-height geometry. | They use one inset and bottom gap. Covered viewports reduce the excess resting home-indicator gap. The drawer fits the visible viewport. Native safe-area ownership remains unchanged, avoiding a second keyboard lift. |
| P2 | Wider mobile windows retained the phone menu and column. | At 880 CSS pixels, existing destinations become persistent navigation beside the current screen. Narrow windows keep the drawer. CSS alone changes the arrangement, preserving component/draft identity through resizing. Home uses two columns only when enough content width remains. |
| P2 | Every screen and the old developer preview loaded up front. | Secondary screens and preview are deferred. Loading is announced, failures retain the shell and provide retry without a full-page reload. Primary chat/decision surfaces remain eager. |
| P2 | Unchanged assistant Markdown was parsed again during draft typing and unrelated stream updates. | Parsing is memoized by role/text; decision controls and permissions remain live. This is not whole-row freezing. |
| P2, deferred | Closed cloud-browser controls still poll; overlapping slow responses may be discarded by generation logic. | Recorded for a separate transport/ownership test. Polling semantics were not changed opportunistically. |

The existing warm mobile visual language, navigation destinations, chat engine, approvals, uploads, retry semantics, voice permissions and provider selection remain in place. No new dependency or lockfile change was needed.

## Measurements and checks

Production build: `npm --prefix apps/mobile-web run build` passed, including TypeScript and service-worker checks. Existing >500kB bundle advisory remains. Final assets:

- `assets/main-BBJBLebA.js`: 561,225 bytes; local gzip 173,529 bytes.
- `assets/main-DK0ONltX.css`: 189,102 bytes; local gzip 32,304 bytes.

The comparable baseline installed-source mobile JavaScript was 725,175 bytes, local gzip 216,959 bytes. The initial compressed JavaScript is about **20% smaller**. There are no static child-module imports from the new entry. This measures built asset sizes, **not network timing, frame rate, interaction latency, or physical-device speed**. An unvisited deferred destination needs network access initially; previously visited hashed chunks retain the service worker's existing cache behavior. CSS increased by approximately 1.1kB compressed.

Focused tests: **39 passed** across viewport geometry/frame batching/cancellation, draft/file lifecycle, compose routes, lazy-loader failure/retry/current props, and existing chat chrome guards. The three lazy checks are included in that total, not counted twice. No browser DOM renderer was available in existing dependencies, so no invented DOM/layout pass is reported.

- `output/mobile-adaptive/geometry-draft-tests.log`: 30 passed.
- `output/mobile-adaptive/lazy-screen-chat-chrome-tests.log`: 9 passed.
- `output/mobile-adaptive/build.log`: production build.
- `output/mobile-adaptive/bundle-comparison.json`: raw size evidence.
- `output/mobile-adaptive/design-detect.json`: mechanical detector returned `[]`.
- `git diff --check`: passed.

The isolated runner's live-home sentinel reported **NOT PERFORMED** because the concurrently running daemon changed `secretsMeta`. The tests passed; this does not prove live-home or installed-app acceptance. The daemon was not stopped for tests.

## Visual and device acceptance still required

The UI tool reported that the Mac was locked and automatic unlocking failed. The owner was asked to unlock while source work continued. **No browser, simulator, or physical keyboard acceptance was performed in this pass.** Do not promote the source fix or arithmetic tests into a claim that the reported iPhone bug has been physically reproduced and resolved.

Use the actual built UI and controlled synthetic records for this bounded matrix:

1. Compact widths 320, 375, 430 and 466; larger windows 626, 768, 890 and 1024 CSS pixels. These are coverage widths, not certified Duo logical dimensions. Include short landscape and 180/260px visible-height cases.
2. Long draft, file context, attachment/error notices, busy Stop, and large text. Send/Stop must be inside the visible viewport and usable without scrolling the draft body first.
3. Open/close keyboard, pan the visual viewport, rotate and resize narrow/wide repeatedly. Preserve selected conversation, text, attachments and focus; avoid duplicate keyboard compensation and horizontal page overflow.
4. Open attachment and navigation sheets while the keyboard is present. Confirm close/recovery controls, focus return and scrolling.
5. Load a deferred screen, simulate one chunk-load failure and retry, and follow a direct project/Space link. Verify data loads in the correct destination.
6. Check light UI at larger text settings, including idle slim Home composer and the busy conversation composer.

Then verify the installed native build, served mobile asset identities and real keyboard behavior on the phone using named controlled tasks. Preserve the live home; do not reset or migrate personal Spaces/memories. No provider execution was required by this UI fixture; a fixture response is not provider assurance.

## Native direction

Keep hybrid for the immediate fixes. Native voice/widgets/pairing/system integration already exist. A full conversation rewrite would duplicate mature engine, approval, artifact and recovery behavior before it solves the observed layout defect.

Full Duo adaptation is an additional platform step. Apple's preparation guidance documents compatibility limits for Xcode 26-and-earlier builds; the installed toolchain is 26.6 with only iOS 26.3/26.5 simulators. Apple's reserved-region APIs are documented for iOS 27.1+. Custom HTML cannot be assumed to receive native split-view, fold and camera avoidance automatically. Use a compatible newer toolchain and actual reserved geometry before implementing a narrow native adapter; do not hardcode a hinge from physical display pixels. See the linked assessment for primary sources and a safe simulator plan.

Window-local draft continuity on resize is distinct from persistence after reload or process termination. This pass does not implement the latter. True fold-posture handling, newer SDK build qualification, actual widgets on both displays, accessibility/VoiceOver and physical performance remain unqualified.
