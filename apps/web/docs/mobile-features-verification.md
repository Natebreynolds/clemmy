# Mobile and feature revision — 2026-10-02

This follows the accepted direction of the [document-handoff candidate](redesign-verification.md). The user requested better mobile presentation, recording, interactive Spaces, a clearer multi-model/multi-agent explanation, and smoother scrolling. It is a website-only revision.

## Delivered behavior

- Six chapters share the same terracotta world: loop, memory, tools, recording, agents and models, and Spaces. The desktop cinematic region is 820svh.
- At widths up to 799px or heights up to 759px, all chapters appear in natural document order over the shared sticky world. Phone body copy and native selectors are 16px; controls have at least 44px touch height, and short loop choices have at least 44px width. The chapter selector stays available while inside the journey.
- Native scrolling drives a bounded, non-oscillating visual follower. Reversing and interrupting remain possible. No wheel interception or scrolling library was introduced.
- Recording exposes keyboard-accessible Transcript, Summary and Actions examples. Its copy distinguishes local transcription from connected meeting capture; saved actions do not imply automatic execution.
- The agent chapter shows project context, coordination, specialist purposes, independent model pins and completion review. Changing one model preserves the others.
- Spaces exposes a sample launch board with Open/All filtering and a source preview. Workflow controls demonstrate on-demand, scheduled and event starts. These are illustrative local interactions and do not call the live app.
- Clem remains only in the hero, with the existing idle loop, scroll-driven handoff and paper transition. This revision generated no new paid media.

Source evidence and claim boundaries are in [feature-evidence.md](feature-evidence.md).

## Visual review and corrections

The batched review covered 1440×900 desktop, 390×844 phone, 320×740 small phone and 768×1024 tablet. Screenshots are under `.impeccable/review/mobile-features-v3` at the repository root.

The corrective batch moved the portrait world composition above the reading area, preserved paper geometry at the short-desktop boundary, and fixed compact loop touch widths. A cold deep link exposed a renderer visibility defect: progress metadata updated, but a stale negative IntersectionObserver result prevented a visible world from rendering. The renderer now checks current host bounds inside each coalesced animation-frame request. It still skips hidden and offscreen rendering.

The focused confirmation passed on the corrected production build: a cold 390×844 `#recording` load reached rendered progress 0.5552 / room 3; the native Spaces chapter selector reached 0.8881 / room 5. The actual camera and rendered progress agreed with the page state. Final phone captures are `mobile-recording-final.png` and `mobile-spaces-final.png`. Temporary browser sizing was restored.

A full interaction run also reproduced returning to an already-used chapter hash after manually scrolling elsewhere. The native chapter picker now explicitly scrolls its destination into view and only adds a history entry when the hash changes. This preserves back navigation and repeated chapter selection.

The original development server produced a chunk syntax error; production builds were inspected independently. This record does not count that unhydrated development page as acceptance.

## Acceptance

Production TypeScript checking and build passed; first-load JavaScript is 164 kB. There are 79 distinct functional checks satisfied and 26 real-media checks passed. The broad functional matrix passed 74 checks and isolated five failures to the same-hash chapter return. After the picker fix, all five affected cases passed in a 10-check targeted confirmation; unrelated passing coverage was not repeated. The 1440×780 hero/paper seam check passed. The actual cold-link renderer regression also passed.

The matrix covers desktop 1440×900, tablet 768×1024, phone 390×844, narrow phone 320×740, short desktop 1440×640, and desktop reduced motion. Media coverage includes idle wraps, forward/reverse handoff seeking, all six rendered camera regions, pause/resume, hidden tabs, media failures and zero MP4 requests under reduced motion/data saving.

Raw logs are preserved under `output/website-cinematic-2026-10-02/mobile-features-v3/`. The final standalone build ID is `yEMptmvF4uU0tlftTrDxm`; it is served at http://127.0.0.1:3011/ (preview process 9292). The delivered browser was opened on this version's hero and retained for review.

Candidate: `/var/folders/2p/26lnqgjn0jg78_wwpg2y4l1c0000gp/T/clementine-six-chapter-candidate-hgluw9su`.

Browser viewports establish layout behavior in Chromium. They do not establish physical iPhone/Android or Safari performance. No Railway deployment, Git commit/push, installed-app hotpatch, live-home changes, provider calls, or personal integration changes were performed.

## Hero transition repair — follow-up

The user reported a regression in the hero handoff after this revision. The flow layout's opaque outer background covered the hero before its entrance crossfade. Separately, damping only the outgoing hero let the incoming paper appear before the outgoing paper reached its final pose. A restored scroll position could also retain the entrance measurement taken before the hero expanded from its static hydration fallback.

The flow container is now transparent; the hero and entrance follow native scroll geometry directly, while the later world camera retains smoothing. Entrance measurements update on hero/journey size changes as well as scrolling and resizing. Responsive paper dimensions, the footage, and all six chapters remain unchanged.

Typecheck and the production build passed. Twelve focused regression checks passed at 1440×900, 1440×720, 390×844, and 320×740. Across 328 forward/reverse frame samples, visible paper bounds differed by less than 0.001px. Each size also passed restored-position reload, unobstructed hero playback, and working loop controls. The test sampler reads after the render phase; the desktop viewport selector excludes the chapter anchor spans.

A browser confirmation at 946×755 and 390×844 verified the document offer, matching paper positions, reverse scrolling, and a mid-hero reload. Captures are in `.impeccable/review/hero-handoff-repair`; test logs are in `output/website-cinematic-2026-10-02/hero-handoff-repair`. The repaired standalone build is `lHAqfV5ZKYi2yYGhioei3`. This remains a local preview repair, with no Railway deployment.
