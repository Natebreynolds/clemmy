---
name: Clementine Website
description: One character handoff, one continuous physical world, and one paper task carried through the work.
colors:
  hero-clay: "#a34521"
  hero-cream: "#fff9ee"
  hero-action: "#fff7e9"
  hero-action-ink: "#4b2516"
  journey-bg: "#24150f"
  world-bg: "#26150f"
  journey-ink: "#fff0dd"
  amber: "#efb576"
  body: "#ead1b6"
  muted: "#c8a687"
  seam: "#735443"
  paper: "#f2e5cf"
  paper-ink: "#523521"
  paper-seam: "#bea98d"
  field: "#38261d"
  field-seam: "#8a6853"
  download: "#e5b17d"
  world-clay: "#9a4c32"
  copper: "#bf7546"
  demo-muted: "#dfbd9c"
  demo-rule: "#84624c"
typography:
  display:
    fontFamily: "Plus Jakarta Sans Variable, sans-serif"
    fontSize: "clamp(100px, 10.6vw, 160px)"
    fontWeight: 520
    lineHeight: 0.86
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Plus Jakarta Sans Variable, sans-serif"
    fontSize: "clamp(38px, 4.2vw, 64px)"
    fontWeight: 450
    lineHeight: 1.055
    letterSpacing: "-0.04em"
  body:
    fontFamily: "Plus Jakarta Sans Variable, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.75
  phone-body:
    fontFamily: "Plus Jakarta Sans Variable, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
  demo:
    fontFamily: "Plus Jakarta Sans Variable, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  demo-phone:
    fontFamily: "Plus Jakarta Sans Variable, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  detail:
    fontFamily: "Plus Jakarta Sans Variable, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.7
  paper-request:
    fontFamily: "Plus Jakarta Sans Variable, sans-serif"
    fontSize: "17px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "-0.02em"
  label:
    fontFamily: "Plus Jakarta Sans Variable, sans-serif"
    fontSize: "11px"
    fontWeight: 400
  action:
    fontFamily: "Plus Jakarta Sans Variable, sans-serif"
    fontSize: "13px"
    fontWeight: 650
rounded:
  paper: "2px"
  control: "5px"
  action: "6px"
  reading-rail: "10px"
  circle: "50%"
spacing:
  tight: "8px"
  control-gap: "12px"
  detail: "18px"
  inset: "24px"
  group: "28px"
  static-chapter-top: "75px"
components:
  button-primary:
    backgroundColor: "{colors.hero-action}"
    textColor: "{colors.hero-action-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.action}"
    padding: "17px 21px"
  button-primary-hover:
    backgroundColor: "#ffffff"
  button-download:
    backgroundColor: "#272a20"
    textColor: "#f4f1e8"
    typography: "{typography.action}"
    rounded: "{rounded.action}"
    padding: "19px 23px"
  button-download-hover:
    backgroundColor: "#3e4333"
  story-choice:
    textColor: "#ceab88"
    typography: "{typography.label}"
    padding: "12px 12px 12px 0"
    height: "44px"
  story-choice-phone:
    padding: "12px 8px 12px 0"
    height: "46px"
  story-choice-selected:
    textColor: "#fff4e3"
  model-select:
    backgroundColor: "{colors.field}"
    textColor: "{colors.journey-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "6px 24px 6px 9px"
    height: "44px"
  model-select-phone:
    height: "46px"
  paper-artifact:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.paper-ink}"
    rounded: "{rounded.paper}"
    padding: "22px 24px"
    width: "320px"
  journey-rail:
    textColor: "#c7a485"
  journey-current:
    textColor: "#fff5e7"
  journey-icon:
    backgroundColor: "#39271b"
    textColor: "#ffe8c9"
    rounded: "{rounded.circle}"
    height: "44px"
    width: "44px"
  demo-tab:
    textColor: "{colors.demo-muted}"
    typography: "{typography.demo}"
    padding: "8px 0 10px"
    height: "44px"
  demo-tab-selected:
    textColor: "{colors.journey-ink}"
  source-preview:
    textColor: "{colors.amber}"
    padding: "8px 0 8px 8px"
    height: "44px"
---

# Design System: Clementine Website

## Overview

**Creative North Star: "One idea, all the way through."**

Clem introduces one task, then the task carries the visitor into her architecture. The character appears only in the hero. The user's actual photo governs her reddish caramel coat, white forehead blaze, white muzzle and chest, upright ears, and expressive eyes. The rest of the site follows the work through one continuous terracotta world.

A copper route joins six chapters: the loop, memory, tools, recording, agents and models, then Spaces and workflows. Native scroll moves a real 3D camera through that same geometry. A persistent HTML paper artifact records what the visitor learns and chooses; readable story panels and direct controls explain the architecture. Warm amber light, tactile cream paper, and self-hosted Plus Jakarta Sans connect the experience to the opening.

**Key Characteristics:**

- Clem appears only in the hero; the task becomes the guide.
- One continuous 3D world and camera route, driven by native scroll.
- The same HTML paper artifact persists across six architecture chapters.
- Comfortable phone reading, direct controls, and static alternatives preserve the explanation.

This records the current local implementation and the authorized interaction direction, not final user design approval or deployment authorization. The prior seven-film chapter composition was rejected; its retained assets and components are archival, not active design authority. No Railway deployment is claimed. The six-chapter/mobile revision has completed browser acceptance; earlier four-chapter results remain historical.

Sources: [direction contract](docs/design-direction.md), [page composition](src/components/experience/ClementineExperience.tsx), [ImmersiveJourney](src/components/experience/ImmersiveJourney.tsx) and [styles](src/components/experience/ImmersiveJourney.module.css), [JourneyWorld](src/components/experience/JourneyWorld.tsx), [camera smoothing](src/components/experience/useSmoothedProgress.ts), [recording and Space demos](src/components/experience/JourneyDemos.tsx) and [styles](src/components/experience/JourneyDemos.module.css), [feature evidence](docs/feature-evidence.md), [hero](src/components/experience/CinematicHero.tsx) and [styles](src/components/experience/CinematicHero.module.css), and [global styles](src/app/globals.css). The [current verification record](docs/mobile-features-verification.md) records the responsive, interaction and real-media results.

## Colors

Frontmatter owns the extracted values. Sidecar tonal ramps are previews, not new production colors.

### Primary

- **Studio Clay and Hero Cream:** the character's warm stage and large opening type.
- **Amber:** the narrative emphasis, progress line, and light connecting the architecture.
- **World Clay and Copper:** rough physical structures and the route through them.

### Neutral

- **Warm Journey Ground and World Ground:** the dark terracotta reading field and depth behind the geometry.
- **Journey Ink, Warm Body, and Muted Copper:** the three levels of text over the scene.
- **Tactile Paper and Paper Ink:** the persistent request and accumulated context.
- **Warm Seams and Field Brown:** quiet control boundaries and native selects.
- **Demo Muted and Demo Rule:** supporting timestamps, ownership, captions, and fine boundaries within recording and Space examples.
- **Closing Sand:** the plain download scene after the real product screenshots.

**The Continuous Material Rule.** Carry terracotta, amber, and paper through the journey; do not restart the visual world at every topic.

## Typography

**Display and Body Font:** self-hosted Plus Jakarta Sans Variable, with sans-serif fallback. The opening's character name increases to weight 600. Journey headings are lighter and more compact than the hero, with upright amber emphasis. Body copy supports reading while labels stay quiet. The paper request has its own compact editorial hierarchy. Real 3D placards repeat the family; the HTML contains the accessible explanation. Phone body copy and native selects use 16px text; demo transcript, summary, source, and board text use the phone demo role. Controls retain at least 44px targets, with 46px story choices and model selects in reading flow.

**The One Family Rule.** Preserve the established typeface and use scale, weight, spacing, and color to establish hierarchy.

## Layout

Desktop pins one viewport inside a native scroll region (820svh). The six chapters are The loop, Memory, Tools, Recording, Agents & models, and Spaces. Narrative text occupies the left side; geometry and the paper artifact occupy the right. The lower rail links directly to all six chapters, exposes pause, and exits to the console.

At phone widths (799px and below) or short heights (759px and below), the journey uses natural document flow. Every chapter has room for its actual content, with a continuous world behind the reading experience. A visible-in-journey mobile rail provides a native chapter selector, chapter count, and pause. It respects the safe area and replaces squeezed desktop navigation.

Reduced motion and data saver use the readable static form: all six explanations appear in order, the background is subdued, and the decorative artifact is hidden. Explicit pause instead freezes rendered camera and paper motion while preserving the current layout and scroll distance. Direct chapter anchors remain available, including bookmarked destinations after responsive layout resolves.

Additional sizing adjustments apply at 1100px and 1600px. Phone content uses 16px body and select text; reading-flow choices and selects are at least 46px high, while demo controls, chapter selection, and pause retain a 44px minimum.

**The Reachable Explanation Rule.** Keep every choice available through native controls and retain the full explanation in static document order.

## Elevation & Depth

The world uses real Three.js geometry, perspective, rough plaster, copper, translucent archive sheets, grounded shadows, and warm directional light. Scroll controls camera position and the paper's path through bounded exponential smoothing. `useSmoothedProgress` uses damping 22, clamps progress, preserves exact endpoints, and settles without overshoot; reversing scroll retraces the route. Pause freezes the rendered value. The smoothing does not intercept wheel or touch input. It is not a sequence of independently playing environmental films. Rendering responds to scroll, short settling frames, resizing, visibility, and selection rather than an autonomous background animation loop.

The persistent HTML artifact has a fine edge, a modest clip detail, and one physical shadow. Its rotation and position follow the frozen or advancing world progress. A dog-free world poster remains behind the canvas for loading or WebGL failure, while all HTML stays usable.

**The Same Task Rule.** Camera travel, selected detail, and the paper's accumulated context must continue the same request instead of introducing unrelated decorative scenes.

## Shapes

Soft arches, round stations, layered archive sheets, gateways, and work surfaces form the world. A thin copper route connects them. Controls use small corners or simple underlines; pause and exit use compact circles. The HTML artifact remains nearly square-cornered paper. These forms support the physical journey instead of a repeated grid of feature cards.

## Components

### Hero and Handoff

Clem's quiet idle loops while the visitor reads. The approved next action is a scroll-driven bounce, pickup of a blank document, and offer toward the viewer; an HTML document then recedes into the journey's artifact position. Both films and the HTML handoff are integrated. The paper reaches its exact journey geometry by hero progress 0.94 before the overlapping world fades in. On mobile, the handoff film expands to fill the viewport as the introductory copy leaves. The seven-second idle and 9.79-second handoff passed real-playback checks for the current six-chapter/mobile revision; the verification record includes those results.

The hero respects explicit pause, reduced motion, data saver, offscreen visibility, and hidden documents. Outside the hero, use text branding and dog-free scenery; no footer dog, world dog, or repeated logo mascot.

### Actions and Navigation

The hero download is cream with brown text and a white hover state. The closing action is dark on sand. The desktop journey rail uses a fine rule, six chapter links, a visible current step, and circular pause/exit controls. Reading flow uses a native chapter selector with a six-step count and 44px pause control. Header navigation, the focus-revealed skip link, and the Escape-dismissable mobile menu remain available.

### Story Controls

Underlined choices expose six loop topics: Understand, Discover, Act, Verify, Learn, and Jev. Jev is described as built-in System One integration when connected; the review note explains comparison with the request and evidence. Memory and tools each expose three examples. Selected state uses warm white text and an amber underline, with `aria-pressed` and live explanation updates.

### Recording

`RecordingDemo` presents one illustrative launch sync with Transcript, Summary, and Actions tabs. Timestamps, speaker names, decisions, and action owners remain consistent across views; the waveform is decorative. Tabs support arrow keys, Home, and End. No microphone is requested and action items are not executed.

### Agents and Models

The separate Agents & models chapter distinguishes Clementine's orchestration from each specialist's instructions, purpose, and independent model pin. A shared-project select changes context. Researcher, Builder, and Reviewer retain separate native selections, visibly identify the focused role, and announce its chosen pin. Example names do not establish provider availability or imply that every real task uses all roles or different models.

### Spaces and Workflows

`SpaceDemo` is a working local example. Its launch board switches between Open and All, opens a source preview, and restores the prior filter when the preview closes. A separate Workflow tab changes on-demand, scheduled, and event trigger traces. Selected filters, source links, and tabs use warm emphasis, fine underlines, visible focus, and minimum 44px targets. These controls neither refresh live accounts nor create a Space or workflow.

### Persistent Paper

One HTML artifact holds the request, then accumulates memory, tool reach, recording context, model assignments, and a Space destination. A project change updates that same artifact. Its example label remains visible when the artifact is shown; static mode hides this decorative summary, and inactive cinematic story panels are inert. Phone reading keeps full explanations in document flow. Product screenshots appear after the journey with source captions and version caveats.

**The Honest Example Rule.** Keep illustration and interactive examples distinct from actual agent execution and product screenshots.

## Do's and Don'ts

### Do:

- **Do** match the actual dog's markings and confine the character to the hero.
- **Do** preserve one world, one camera route, and one persistent task artifact.
- **Do** keep native scrolling, direct controls, visible focus, and usable static alternatives.
- **Do** give phone copy and native selects 16px text, with control targets at least 44px.
- **Do** distinguish explicit pause from reduced-motion or data-saver document mode.
- **Do** preserve example labels, source captions, and media provenance.

### Don't:

- **Don't** restore the rejected seven-film chapter sequence or repeated dogs.
- **Don't** claim a generated handoff is integrated or accepted without checking the current implementation.
- **Don't** bake the only explanation or controls into 3D imagery or film.
- **Don't** treat illustrative model choices, Spaces, or workflows as live configuration.
