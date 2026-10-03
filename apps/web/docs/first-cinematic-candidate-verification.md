# Website redesign verification — 2026-10-02

## Implemented candidate

The site now uses seven real film sections across the whole narrative: meet Clem,
enter her world, follow the loop, retain useful memory, reach the tools, assemble
a project/team, and return to Clem. The user's actual photograph establishes the
character's reddish caramel coat, white blaze, white muzzle and chest. The intro
walks, gives a small playful bounce, and settles with a head tilt. An earlier take
with cropped ears was rejected and rerendered; it is not a public website asset.

The full-bleed environments use consistent terracotta, amber light, and physical
materials. Readable HTML and real controls explain the five-stage loop, optional
Jev layer, memory, Composio/local/MCP tools, projects, and model-pinned specialists.
Console screenshots and Mac downloads remain available. Demonstrations are
illustrative and never invoke the live daemon or change user configuration.

## Media and cost

Six accepted Higgsfield Kling Pro source films and one derived closing excerpt
supply seven page films. All are silent H.264 with progressive faststart; total
video size is 12,304,219 bytes. Individual clips fully decoded successfully and
sampled-frame reviews cover their full duration. Intro/world received additional
character/transition inspection. Each scene has a WebP fallback.

The initial 1,000-credit balance became 912.5: observed use 87.5 credits, including
the rejected take. No credits were purchased. Exact prompts, references, jobs,
rejection reason, durations, hashes, and costs are recorded in the
[production manifest](assets/cinematic/production-manifest.json) and its linked
provenance files. Generated text/UI is never used as product evidence.

## Browser and visual acceptance

- Development interaction suite: 36/36 checks passed across desktop, tablet,
  mobile, and reduced motion, with no unexpected browser/resource/decoder errors.
- Development real-media suite: 32/32 checks passed. Every film decoded and its
  currentTime advanced on desktop and mobile; at most one player was active.
- Actual pause/resume, native hidden-document pause, offscreen handoff, reverse
  scroll retention, natural intro completion without replay, and distant-source
  laziness passed. These checks used real clips, not simulated media.
- Reduced motion and data saving caused zero MP4 requests and no video source
  attributes on desktop and mobile. Network failure and rejected autoplay kept
  posters, explanations, controls, and downloads available.
- All 16 desktop/mobile chapter and full-page captures were inspected. A bounded
  fix vertically centers chapter copy by its real height and reserves at least
  760px for desktop cinematic headers. At 700/800/900px viewport heights, the
  longest team copy clears its reading cue by at least 50px after scroll settles.
- Mobile journey controls omit the chapter label to stay compact; controls have
  scroll clearance. Footer padding reserves space beneath its links. At maximum
  scroll, elementFromPoint confirms GitHub, Releases, and MIT-license link centers
  remain clickable on desktop and mobile. Dedicated captures confirm this fix.
- Independent finish review returned `ship` after confirming the footer fix,
  with no remaining material finding. This is not final user design approval.
- Final isolated app-only TypeScript checks and production build passed. The
  production interaction suite passed 36/36 checks and the real-media suite passed
  32/32 checks (68 total), with no unexpected browser/resource/decoder errors.
  Footer link hit-tests passed on desktop, tablet, mobile, and reduced motion.
  First-load JavaScript is 162 kB (59 kB page, 103 kB shared).

Production evidence is saved in
`/var/folders/2p/26lnqgjn0jg78_wwpg2y4l1c0000gp/T/clementine-cinematic-final-xx74hk_8/`:
`QA-SUMMARY.txt`, `qa-interactions.log`, `qa-cinematic.log`, and
`qa-audit-production.json`. The production-only dependency audit reports one
existing high-severity transitive finding in `nanoid` 3.3.16
(`GHSA-2v37-7h3g-55p8`, custom generator indefinite loop at zero size; fixed in
3.3.18). Dependencies were not upgraded as part of this design work. Functional
acceptance does not resolve that audit finding.

The local standalone preview is http://127.0.0.1:3011. The public Railway service
has not been updated. No Git commit/push, Railway deployment, desktop release,
installed-app hotpatch, live-home mutation, or personal integration changes were
performed.

## Railway build repair

The prior failed build imported shared design tokens above `/apps/web`, outside
Railway's root context. Marketing CSS is now self-contained. An app-only build
outside the repository verifies the relevant deployment boundary; Node >=22.15
is declared. The unchanged download routes previously returned HTTP 302 with
no-store to the v3.18.26 Apple Silicon and Intel release ZIPs.

## Scope of validation

Browser acceptance uses installed Chrome with desktop/mobile viewports, not every
physical device or Safari version. The film environments are visual metaphors;
precise product behavior is represented by the labeled HTML examples. Deployment
and the user's final creative review remain separate steps.
