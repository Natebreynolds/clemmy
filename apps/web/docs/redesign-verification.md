> This is the prior four-chapter candidate. The current refinement is documented in [mobile and feature verification](mobile-features-verification.md).

# Immersive website verification — 2026-10-02

## Current revision

The user's latest direction replaces separate cinematic headers with one continuous
scroll-controlled experience. Clem appears only in the hero. A seven-second idle
loops while the visitor reads; scrolling scrubs a 9.79-second bounce, document
pickup, and offer toward the camera. The film's blank paper becomes an HTML brief,
which recedes to a fixed position as the 3D world appears around it.

The same paper and request persist through the loop, memory archive, tool gateways,
and project team. Real controls cover six loop topics including Jev/System One,
completion review, preferences/corrections/experience, Composio/local/MCP tools,
projects, independent specialist model pins, Spaces, and workflow triggers. Real
console screenshots, MIT/open-source links, and Mac downloads remain accessible.
Examples are illustrative and do not invoke the live daemon or change user data.

## Visual and behavior evidence

- A bounded desktop/mobile visual pass covered all four architecture zones and
  the hero. The corrective batch fixed the old chapter-link offset, shortened
  headings, labeled the physical architecture, matched the document seam, and
  expanded the mobile handoff film to fill the viewport.
- Confirmation captures cover the desktop seam and mobile handoff/team. At hero
  progress 0.9727, both papers have identical bounds: x=1019.203125,
  y=611.40625, width=320, height=228.59375 at a 1440×1000 viewport. There is no
  separate section edge or differently sized duplicate paper during the fade.
- Independent finish review found no material remaining issue. This is internal
  review, not final user approval or deployment authorization.
- Development acceptance passed 40 interaction checks and 24 actual media/render
  checks. These exercise natural idle looping, forward/reverse seeking, actual
  WebGL camera progression and reversal, native scrolling, preserved selections,
  focus safety, hidden documents, pause, playback faults, and static alternatives.
- Reduced motion and data saving attach no MP4 sources; very short viewports use
  a full document layout. Manual pause freezes spatial movement without collapsing
  the scroll layout. WebGL failure keeps a dog-free poster and usable HTML.

Captures are in `.impeccable/review/immersive-v2/` at the repository root. The
older `desktop-seam.png` and `mobile-handoff.png` show defects before their fixes;
`*-confirmed.png` records the corrected states. `production-hero.png` captures the
standalone build at the restored preview viewport.

## Media and cost

Current videos total 5,990,337 bytes: idle 1,833,229 and handoff 4,157,108. Both fully
decoded successfully, use silent H.264, and have faststart metadata. The handoff
uses quarter-second keyframes for responsive seeking. The loop's measured wrap
RGB difference is 0.70/255, below the internal-frame 95th percentile of 1.26/255.

The new document shot used 14 existing Higgsfield credits. The hop prelude and
idle loop are editorial derivatives of the previously accepted real-Clem film.
The observed balance is 898.5; cumulative production use is 101.5 credits including
the earlier rejected intro. No credits were purchased. Exact prompts, references,
job IDs, derivations, hashes, and receipts are in `docs/assets/cinematic/`.

## Production candidate

An isolated apps/web-only TypeScript check and production build passed. The
homepage reports 57.2 kB and 160 kB first-load JavaScript (103 kB shared). Three.js
is separately loaded in chunks totaling 755,216 raw bytes / 188,879 gzip bytes;
its import begins when the world mounts, not only when it enters view.

The exact standalone build passed all 40 interaction checks and all 24 real-media
checks (64 total). No unexpected browser, resource, or decoder errors remained.
Footer link center hit-tests passed on desktop, tablet, mobile, and reduced motion.
The final persistence check uses the site's native chapter links; separate checks
still verify exact forward/reverse camera continuity.

The production candidate and raw evidence are in
`/var/folders/2p/26lnqgjn0jg78_wwpg2y4l1c0000gp/T/clementine-immersive-final-h0a91i9d/`.
Its standalone server is the current local preview. A production handoff capture
and restored opening capture confirm that the delivered preview includes both
hero films and the continuous journey.

The local standalone preview is http://127.0.0.1:3011. Railway has not been updated.
No Git commit/push, desktop release, installed-app hotpatch, live-home mutation,
Space migration, or personal integration change was performed.

The production-only audit retains one existing high-severity transitive finding
in nanoid 3.3.16 (GHSA-2v37-7h3g-55p8, custom generator indefinite loop at zero size;
fixed in 3.3.18). This design revision adds Three.js and its type package, but does
not resolve that pre-existing finding. Functional acceptance is not a security audit.

## Scope and previous candidate

Browser acceptance uses installed Chrome at desktop/tablet/mobile viewports, not
every physical device or Safari version. The architecture is an illustrative
physical model; the HTML carries the exact product explanations. The unchanged
Mac download routes retain request-time GitHub Release resolution.

The rejected seven-film candidate and its earlier checks are preserved separately
in [the first candidate record](first-cinematic-candidate-verification.md).
