# Clementine website

Next.js marketing site with a native-scroll journey through one physical 3D
world. Clem appears only in the hero. A paper task carries the visitor through
the loop, memory, tools, recording, agents and models, and Spaces, then into real product
screenshots and Mac download links. Interactive examples do not call the live
daemon or change projects, Spaces, accounts, or provider settings.

The current direction replaces the rejected seven-film chapter composition.
Read [the interaction contract](docs/design-direction.md) and
[the design system](DESIGN.md). This local implementation is not final user design
approval or a Railway deployment. Current browser acceptance is recorded in
[mobile and feature verification](docs/mobile-features-verification.md).
Earlier four-chapter results are historical.

## Current implementation

- `CinematicHero` owns the character performance. Her actual-photo identity is
  reddish caramel fur with a white forehead blaze, white muzzle, and white chest.
  Quiet idle loops while the visitor reads. Native scroll is wired to a manual
  document-handoff film and an HTML paper that recedes toward the journey's
  artifact position. The seven-second idle and 9.79-second handoff are integrated.
  The document reaches its matching position before the world fades in; mobile
  handoff footage expands to the full viewport as the introductory text leaves.
- `ImmersiveJourney` uses one pinned desktop viewport inside an 820svh scroll
  region. Six chapters share the same HTML task artifact: loop, memory, tools,
  recording, agents and models, then Spaces and workflows. Inactive cinematic
  story panels are inert, and direct chapter anchors preserve native navigation.
- Phones at 799px wide or below and viewports 759px high or below use natural
  document flow. Chapters grow with their content; phone body text and native
  selects are 16px. Controls have 44px minimum targets, with 46px reading-flow
  choices and model selects. A native chapter selector and pause replace the
  desktop rail while the journey is visible.
- `JourneyWorld` builds one actual Three.js world. `useSmoothedProgress` applies
  bounded damping to camera progress, settles without overshoot, preserves exact
  endpoints and reverse travel, and freezes on pause. Wheel and touch input stay
  native. A dog-free poster and usable HTML survive WebGL failure.
- The loop retains six choices, including Jev as built-in System One integration
  when connected, and completion-review context. Memory and tools each retain
  three examples. `RecordingDemo` switches a labeled launch sync between
  Transcript, Summary, and Actions; it neither records audio nor executes items.
- Agents & models explains orchestration, specialist instructions, independent
  model pins, and review. Project and role selections persist in the example.
  `SpaceDemo` provides Open/All board filters, source previews, and a separate
  Workflow tab with on-demand, scheduled, and event traces. These are local
  example states. See [feature evidence](docs/feature-evidence.md) for claim limits.
- Explicit pause freezes rendered camera and paper motion without changing the
  layout or scroll distance. Reduced motion and data saver use a complete static
  story with subdued scenery and no decorative paper summary. Hero media also
  respects these preferences, offscreen visibility, and hidden tabs.
- Header and footer branding is text. No dog or logo mascot appears outside the
  hero. The mounted page no longer uses `CinematicChapter`, the seven-film
  environments, or the detached `JourneyControls` bar. Their retained source and
  assets are historical material, not evidence of active playback.

Media availability is checked in `src/app/page.tsx`. The active hero uses
`public/media/clem-hero-loop.mp4`, `clem-hero-loop.webp`, and the conditional
`clem-handoff.mp4`; the corrected `clem-hero-v3.webp` remains a fallback. The world
uses `journey-fallback.webp` as its dog-free architectural fallback.

## Develop

```bash
cd apps/web
npm ci
npm run dev
```

Validate this revision with:

```bash
npm run typecheck
npm run smoke -- http://localhost:3000
npx tsx scripts/cinematic-smoke.ts http://localhost:3000
npm run build
```

The earlier 40 interaction checks and 24 real-media/render checks belong to the
previous four-chapter revision. They are not current six-chapter acceptance. The
recording/Spaces states, explicit model pins, smoothed camera, phone reading flow,
chapter navigation, and static alternatives now have their own checks. See
[the current verification record](docs/mobile-features-verification.md) for the
79 functional and 26 media checks, including the targeted navigation regression.
The subsequent hero repair adds 12 focused forward/reverse handoff checks across
four viewport sizes. Run those alone with
`CLEM_MEDIA_SCOPE=handoff npx tsx scripts/cinematic-smoke.ts http://localhost:3000`.

To serve a newly built standalone output locally:

```bash
npm run build
cp -r public .next/standalone/
cp -r .next/static .next/standalone/.next/
HOSTNAME=0.0.0.0 node .next/standalone/server.js
```

## Railway and downloads

Configured service: `clemmy`; public origin:
`https://clemmy-production.up.railway.app`.

Railway uses repository Root Directory `/apps/web`. Runtime assets and CSS
packages must live within this directory. `railway.json` copies public assets and
Next static files into the standalone output. Node >=22.15 is declared. Set
`NEXT_PUBLIC_SITE_URL` if the public origin changes.

The `/api/download?arch=arm64` and `/api/download?arch=intel` routes resolve the
latest matching GitHub Release asset at request time with no-store caching.
Website work does not publish or replace desktop release binaries.

Generation history, costs, and receipts remain in
[the motion record](docs/motion-assets.md); image prompts, source references, and
provenance remain in `docs/assets/` and media sidecars. Earlier films are retained
for traceability and are not active scene definitions.

Current mobile/features acceptance: [verification record](docs/mobile-features-verification.md). The revised production build passes TypeScript/build checks; 79 distinct functional checks are satisfied and 26 real-media checks pass, including targeted confirmation after the chapter-picker correction.
