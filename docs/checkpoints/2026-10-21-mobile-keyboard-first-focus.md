# Mobile keyboard first focus and chat space — 2026-10-21

## Integration boundary

- Worktree: `/Users/nathan.reynolds/.codex/worktrees/mobile-adaptive/clementine-next`.
- Branch: `codex/mobile-keyboard-first-focus-2026-10-21`.
- Base: `153e0bdcca5a5f1dc37f871630a49c03b36e4962` (current integration source when this branch began).
- Scope: mobile web shell, shared composer, transcript resize handling, and focused regression tests. No production Swift, widget, authentication, provider, runtime, or personal/business data changes.
- Other agent still owns `claude/r45-efficiency`. Latest ownership recheck found active uncommitted workflow and objective-judge work on the same base. Do not replace that tree, restart its runtime, or treat a quiet process as a handoff.
- This candidate is not yet installed in the user's live app. Merge, installed-app hotpatch, and named live-home/physical-phone acceptance remain integration-owner work before release. Simulator or loopback fixture acceptance does not satisfy that requirement.

## Reproduced defect

The user's screenshot showed the header and composer disappearing on first keyboard focus. A disposable iOS 26.5 simulator WKWebView fixture reproduced it using the actual built Home route and the production wrapper's full-height/`.never` inset behavior. It uses synthetic loopback data, a nonpersistent web store, and no production credentials or provider requests. Simulator interactions use CUA; no test driver changes production UI.

Before correction, the document/native view stayed 874 points high, `innerHeight` and `visualViewport.height` fell to 471, and WebKit panned the page by 403. The old bounds function subtracted that pan from the already-reduced height. The measured composer collapsed to 2 points and the header moved to y=-341. The native adjusted inset was 403 despite an explicit content inset of zero.

The visible origin and visible height must be independent. Clamping the origin to zero fixed composer height but still lost the header, so that intermediate candidate was rejected. The shell now uses the visual viewport origin and height, and composers are absolutely positioned inside that corrected shell. This also avoids a second coordinate mismatch when switching from the hardware-keyboard accessory to the software keyboard (`innerHeight=529`, visual height=471, offset=345).

## Chat space and interaction

- The idle composer is one approximately 58–59 point row with at least 44-point controls. It does not expand or swap layouts merely because focus changes.
- Empty chat uses the trailing action slot for Talk; a draft, attachment, selected context, or busy turn keeps Send in that slot. Dictation remains a separate control, and Stop remains reachable during work.
- The voice controller stays mounted. Real voice status, errors, attachments, and context remain in a bounded scrollable body; an empty body takes no space.
- The textarea grows within a bounded budget, preserving room for the conversation and Send. The home-indicator gap reduces when the keyboard is covering the document.
- Transcript clearance uses the actual composer height. Resizing follows the latest reply only when the reader was already following the end; reading older messages is preserved.
- Chat docks use their content pane as the horizontal reference. Home/list capsules retain the wide-layout navigation offset. Sheets keep their existing viewport geometry; no transform or paint containment was added to the root.

## Validation and evidence limits

Evidence is local under `output/mobile-keyboard/`; output files are not committed.

- Focused regression run: 76 assertions passed, zero failed, exit 0 (`focused-tests.log`). Its live-home sentinel explicitly did **not** establish isolation because a live daemon concurrently owned and changed the monitored files.
- After correcting the recorded native pan, the 10 viewport/observer assertions passed, zero failed (`final-geometry-tests.log`). The runner exited 1 because its sentinel observed live-home changes without recognizing an owner. These pure math/fake-event tests do not import the runtime; the command is nevertheless **not** reported as a fully green run, and no sentinel was bypassed.
- Browser fixture: 320×380 long draft retained a 44-point Send, busy Stop and Send remained reachable, Stop preserved the draft, synthetic sending completed, and the attachment sheet opened and closed. Tail resize retained the latest message; older reading position remained unchanged (`browser-checks.json`). These are browser resizing checks, not a real iPhone keyboard.
- Native baseline and intermediate evidence: `baseline-home-keyboard.png`, `baseline-home-first-focus.jsonl`, `candidate1-home-keyboard.png`, `candidate1-home-first-focus.jsonl`, `candidate2-home-keyboard.png`, `candidate2-home-first-focus.jsonl`.
- Candidate2 ordinary software-keyboard focus retained root y=0/height=471, header y=62, and Send bottom=454 above keyboard top=471. The additional keyboard-mode transition still exposed a 48-point overlap; the final root-local dock correction addresses that separate reference-frame defect but does not yet have passing native transition evidence.
- Final production mobile build (TypeScript, service-worker TypeScript, Vite) passed, exit 0 (`build-web-final.log`). Existing >500 kB bundle-size advisory remains. Assets: `main-CSccGw-U.js` (SHA-256 `78aeebe9a6da865af47fe977d3dc934a4b22f77380029b0bf9059bae555bf002`) and `main-jB3Ui5Q9.css` (`5e2a0e8f0e2e66284597e1a01f6891de1a99b0447bb0e0a6fa97b1d960da4a2b`).
- Final browser correction check (`browser-final-checks.json`): at 320×380, long-draft Send bottom=351, dock bottom=358, no horizontal overflow. At 1000×650, sidebar ends at x=220; both Home and Chat docks span x=246–974 and end at y=628, preserving the content column and 22-point resting gap. The 393×852 idle chat received visual review.
- Independent final source review found no blocking defect. `git diff --check` passed; the earlier mechanical design check returned no findings (`design-detect.json`).
- Candidate3 was cold-loaded in the unchanged native harness with exact final assets. Idle geometry passed: root 402×874 at y=0, header y=62, dock height=59/bottom=830, Send bottom=823 (`candidate3-home-idle-only.png`, `candidate3-home-idle-only.jsonl`). Native first focus, keyboard-mode transition, new-chat draft, and attachment-sheet interaction remain **unverified**: CUA's Simulator coordinate mapping stopped resolving the device window. Bounded rebind/window-recovery attempts failed; no alternative driver or injected focus was used to bypass it. The Candidate2 passing ordinary-focus result is not relabeled as final Candidate3 acceptance. Full chronology and native limits are in `output/mobile-keyboard/RESULTS.md`.

## Required next acceptance

After the integration owner merges this commit and performs the authorized installed-app hotpatch, verify the actual served JS/CSS identity, then use a named controlled chat in the installed/live-home flow. On the user's iPhone: open the keyboard for the first time on Home and in a new chat; enter a short and multiline draft; verify Send, Stop, attachment-sheet dismissal, and keyboard dismissal/refocus. On a suitable native test device also switch hardware/software keyboard modes. Confirm the conversation remains visible and the reader is not pulled away from older messages. Do not reset live-home data or infer success from this checklist.

No new TestFlight binary is produced by this change. The existing iOS wrapper loads the served mobile web UI; integration must verify the actual installed/served asset identity and the user's phone after refresh. This does not claim to repair widget launch, microphone permissions, or every iOS/device configuration.
