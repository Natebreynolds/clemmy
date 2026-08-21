# Premium mobile UI for an AI employee — 2026 research synthesis

Research date: 2026-08-20. Three parallel investigations (premium chat features,
2026 visual language, agentic UX), synthesized against the actual state of
`apps/mobile-web` after the Wave 1–3 rework.

---

## The one thing all three reports independently said

They used different vocabularies and reached the same conclusion:

- *Features research*: chat transcripts have hit their ceiling; the leading labs
  converged on structured generated surfaces where "the generated interface IS
  the deliverable."
- *Agentic-UX research*: "a phone-first agent product whose only surface is a
  chat transcript will be graded Level 1 regardless of how good the underlying
  model is." The activity surface must be **structurally separate** from the
  conversation.
- *Visual research*: "Bubbles signal 'messenger' and undermine the tool framing
  users now expect."

**Stop building a chat app that can do work. Build a work surface that happens
to contain a conversation.**

The strongest single number in the whole body of research supports it: agent
sessions with no mid-run visibility produced **3× the user abandonment** of
sessions with a live progress panel — *at identical output quality*
(Augment Code data, via Zylos' 2026 agentic-UX survey). The thing that kills
these products is invisible work, not bad work.

---

## Where Clementine actually stands

Audited against the named 2026 "AI slop" signatures.

### Already right (do not touch)

| Signature | Ours |
|---|---|
| Inter everywhere = the #1 typography tell | We use system SF Pro / `ui-rounded` — not Inter |
| Violet/indigo accent on dark = the #1 color tell | `#ff8a3d` warm orange on warm near-black `#0b0806` |
| Chat bubbles | Removed in Wave 1 — unboxed full-width transcript |
| Colored left borders ("almost as reliable a sign of AI design as em-dashes") | Removed in Wave 3 cleanup |
| Warm-tinted dark for reading-heavy products | Already warm, and the research says warm is *correct* for reading products |
| Per-row editable memory | Shipped — both leaders converged here in 2026 |
| One collapsed activity summary per turn | Shipped — matches Claude Code's Focus view |
| Optimistic send + visible retry that never destroys input | Shipped |

### Tells we still carry

| Tell | Count | Fix |
|---|---|---|
| `box-shadow` where 2026 uses hairlines | 32 | 1px low-alpha borders; elevation via surface lightness (+4–8% L per layer) |
| `text-transform: uppercase` labels | 7 | Sentence case |
| Emoji as UI iconography (📌 etc.) | 10 | Real icon set (we already have an SVG vocabulary in the dock) |
| Gradient text on a heading | 1 (home greeting) | Solid color — gradient-on-heading is explicitly named as a tell |
| Hex palette hand-tuned for warmth | whole file | Rebase in OKLCH: perceptual lightness, no hue drift along the ramp |

### An open question, not a defect

`--font-display: ui-rounded` (SF Pro Rounded). Rounded reads *friendly/consumer*
— Apple uses it for Fitness and Home. For a product positioned as a premium AI
**employee**, a neutral grotesque (Geist is free/OFL; Söhne is the licensed
option) would read more serious. This is a positioning decision, not a bug.

---

## Plan

### Tier A — The run surface (structural, highest leverage)

A *run* is the unit of work in this product and it currently has no home. The
Activity tab is a 77-line list of run names.

1. **Runs become first-class objects.** Phases, current step, elapsed, blocked
   steps, what was produced — surviving app-close and reopen. Everything below
   depends on this existing.
2. **Action receipts on every external write.** What changed, where, under whose
   permission, a diff or confirmation, and a rollback hook. For a product that
   writes to email and CRM this is the trust spine. "Undo is not 'nice to have.'
   It's permission to delegate."
3. **Conceptual breadcrumbs, not mechanics.** "Rejected the first approach after
   50 files," never "read file 245." (Nielsen, on week-long agents.) Cheapest
   item here, biggest perceived-intelligence gain.
4. **Run contract stated up front** — time window, cost ceiling, what it may
   touch — before a long run starts.
5. **Session replay** once A1 + A2 exist: reviewers name replayability, more than
   the live view, as what "solves the black-box problem" (Manus).

### Tier B — Trust and control economics

The counter-intuitive tier. More gates make a product feel *worse*.

6. **DENY / ALLOW / HUMAN risk router replaces the prompt drip.** Score on action
   type, scope, sensitivity, and **novelty** — so a workflow approved five times
   stops asking, with no configuration. Users approve ~93% of prompts and 81%
   use "always allow" purely to dismiss; fatigue is measurable within 60 seconds.
7. **Editable previews at the risk boundary.** A queued email arrives as a draft
   you edit inline on the phone, then send. Converts our riskiest moments into
   our best trust-building ones: "the user feels like a collaborator, not a
   rubber stamp."
8. **Mid-run steering from the phone.** Already exists in the harness (steering
   lane) — needs the mobile surface. Shipped across the entire 2026 field; its
   absence reads as a missing feature.
9. **Agent inbox with three genuinely different item types** — Notify (no
   response needed), Question (blocks the run), Review (opens an editor).
   Collapsing them into one "notification" is the common costly mistake.
10. **Binary confidence, never percentages.** "I'm confident" / "I'm not sure" —
    users decide faster than with "73%."
11. **Three-part failure reporting**, with partial success as its own state:
    "refreshed 8 of 11" offers to finish 3, not redo 11.

Guardrail from the research: verification has a real cost — workers under
high-monitoring AI tools spent **14% more mental effort**, and humans
rubber-stamp incorrect suggestions ~80% of the time. Detail must be *available
and scannable*, never mandatory reading.

### Tier C — Visual finish (all daemon-side, ship tonight)

12. Shadows → hairlines; elevation as surface lightness.
13. OKLCH palette rebase, warm hue held constant along the ramp; off-white text
    (`#E6E1E5`-ish), never pure white.
14. Motion budget as tokens: 180ms default, 300ms ceiling, one custom ease-out
    cubic-bezier, `scale(0.97)` press, never animate from `scale(0)`,
    `prefers-reduced-motion` → fades. **Delete motion from high-frequency
    interactions** (send, tab switch) — they feel faster without it.
15. Sentence case; real icons; solid greeting.
16. Reading measure 65–72ch, line-height 1.6, 16px minimum body.
17. Cards → lists wherever content is scanned rather than browsed.

### Tier D — Native (needs TestFlight)

18. **Live Activity / Dynamic Island for every run over ~30s.** Compact state
    only (phase, step N of M, status), server-pushed on meaningful transitions,
    under the 4KB payload cap, four events: finished · needs input · blocked ·
    ready for review. Include a disable control *in the first notification*
    (GitHub Mobile's pattern). The most distinctly premium mobile-native win
    available, and it maps onto step events our harness already emits.
19. Voice input (both majors went full-duplex in 2026).

---

## Recommended order

1. **Tier C** first — one evening, entirely daemon-side, and it changes how
   every screen feels immediately.
2. **Tier A1–A3** next — the run surface is the structural unlock and the
   best-evidenced win in the research.
3. **Tier D18** with the next TestFlight build (rides alongside the off-wifi
   handoff already waiting in build 10).
4. **Tier B** as an ongoing arc — it's where "AI employee" separates from
   "chatbot with tools."

---

## Sourcing notes

- The visual researcher caught a **fabricated statistic** circulating in design
  SEO blogs: a claimed "NN/g January 2026 study, hairline borders 1.6× more
  trustworthy than shadows." No such study exists on nngroup.com. The
  borders-over-shadows shift is real and observable in shipped products (Linear,
  Vercel, Stripe, Anthropic) — but the number is invented. Treat AI-generated
  design advice with the same suspicion we'd want users to apply to us.
- **APCA is not "WCAG 3."** It was removed from WCAG 3 in July 2023 and the
  April 2026 draft still lists the contrast algorithm as undetermined. Ship
  WCAG 2 AA; use APCA as a tuning instrument for the dark ramp only.
- **Do not adopt Liquid Glass.** NN/G documented text-on-text illegibility and
  sub-guideline touch targets; adoption ran far behind prior releases; at
  WWDC 2026 Apple itself shipped a transparency slider to opt out. Blur earns
  its place in exactly one spot: a floating composer over scrolling content.

## The through-line

> Slop is the absence of a decision. The cure is a visible decision, not more
> polish.

We already made three good ones — warm dark, orange accent, unboxed transcript.
The work is to be consistent about them everywhere and to make the *run* as
first-class as the conversation.
