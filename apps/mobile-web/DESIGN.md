---
name: Clem on the phone
description: One screen that is Clem's; everything else in the Your stuff sheet. Apple's structure, Clementine's colours, always light.
colors:
  clementine: "#f26419"
  clementine-press: "#de5a12"
  clementine-tint: "#fff4ed"
  clementine-ink: "#b94300"
  clementine-ink-deep: "#963400"
  live-halo: "rgba(242, 100, 25, 0.18)"
  ink: "#1f1b16"
  ink-muted: "#5c564b"
  ink-subtle: "#75644f"
  cream-canvas: "#faf7f2"
  card-white: "#ffffff"
  pressed-cream: "#f4f0e9"
  quiet-mark: "#e4ddd1"
  hairline: "rgba(63, 42, 22, 0.1)"
  hairline-strong: "rgba(63, 42, 22, 0.16)"
  card-edge: "rgba(63, 42, 22, 0.08)"
  fill-quiet: "rgba(63, 42, 22, 0.07)"
  scrim: "rgba(31, 27, 22, 0.32)"
  leaf-success: "#2e7d46"
typography:
  large-title:
    fontFamily: "ui-rounded, -apple-system, BlinkMacSystemFont, 'SF Pro Rounded', sans-serif"
    fontSize: "2.125rem"
    fontWeight: 700
    lineHeight: 1.12
    letterSpacing: "-0.02em"
  sheet-title:
    fontFamily: "ui-rounded, -apple-system, BlinkMacSystemFont, 'SF Pro Rounded', sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "ui-rounded, -apple-system, BlinkMacSystemFont, 'SF Pro Rounded', sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.22
    letterSpacing: "-0.015em"
  section-title:
    fontFamily: "ui-rounded, -apple-system, BlinkMacSystemFont, 'SF Pro Rounded', sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  nav-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    letterSpacing: "-0.01em"
  row-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "1rem"
    fontWeight: 400
  callout:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 500
  footnote:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 400
rounded:
  glyph-tile: "8px"
  segment: "9px"
  sm: "10px"
  field: "11px"
  button: "12px"
  md: "14px"
  lg: "16px"
  sheet: "22px"
  composer: "26px"
  pill: "999px"
spacing:
  sp-1: "4px"
  sp-2: "8px"
  sp-3: "12px"
  sp-4: "16px"
  sp-5: "22px"
  sp-6: "30px"
  gutter: "calc(16px + env(safe-area-inset-left))"
components:
  button-primary:
    backgroundColor: "{colors.clementine}"
    textColor: "{colors.ink}"
    typography: "{typography.callout}"
    rounded: "{rounded.button}"
    padding: "9px 12px"
    height: "42px"
  button-primary-press:
    backgroundColor: "{colors.clementine-press}"
    textColor: "{colors.ink}"
  button-quiet:
    backgroundColor: "{colors.fill-quiet}"
    textColor: "{colors.ink}"
    typography: "{typography.callout}"
    rounded: "{rounded.button}"
    padding: "9px 12px"
    height: "42px"
  button-start:
    backgroundColor: "{colors.fill-quiet}"
    textColor: "{colors.clementine-ink}"
    typography: "{typography.callout}"
    rounded: "{rounded.pill}"
    padding: "7px 14px"
    height: "36px"
  link-text:
    textColor: "{colors.clementine-ink}"
    typography: "{typography.callout}"
    height: "44px"
  nav-back:
    textColor: "{colors.clementine-ink}"
    typography: "{typography.nav-title}"
    height: "44px"
  grouped-card:
    backgroundColor: "{colors.card-white}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  grouped-row-pressed:
    backgroundColor: "{colors.pressed-cream}"
  sheet:
    backgroundColor: "{colors.cream-canvas}"
    rounded: "{rounded.sheet}"
    padding: "8px 16px 20px"
  sheet-row:
    textColor: "{colors.ink}"
    height: "52px"
    padding: "8px 14px"
  stuff-glyph:
    backgroundColor: "{colors.clementine-tint}"
    textColor: "{colors.clementine-ink}"
    rounded: "{rounded.glyph-tile}"
    size: "30px"
  stuff-glyph-needs-you:
    backgroundColor: "{colors.clementine}"
    textColor: "{colors.ink}"
    rounded: "{rounded.glyph-tile}"
    size: "30px"
  badge-count:
    backgroundColor: "{colors.clementine}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "22px"
    padding: "0 7px"
  status-chip:
    backgroundColor: "{colors.pressed-cream}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: "3px 8px"
  status-chip-needs-you:
    backgroundColor: "{colors.clementine-tint}"
    textColor: "{colors.clementine-ink}"
    rounded: "{rounded.pill}"
    padding: "3px 8px"
  segmented-control:
    backgroundColor: "{colors.fill-quiet}"
    rounded: "{rounded.field}"
    padding: "2px"
  segmented-control-active:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.segment}"
  search-field:
    backgroundColor: "{colors.fill-quiet}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.field}"
    height: "38px"
    padding: "0 10px"
  composer:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.composer}"
  send-button:
    backgroundColor: "{colors.clementine}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    size: "44px"
  stuff-button:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    size: "52px"
  clem-avatar:
    backgroundColor: "{colors.card-white}"
    rounded: "{rounded.pill}"
    size: "46px"
---

# Design System: Clem on the phone

Scope: `apps/mobile-web` only (the phone app and the iOS shell's web content). The desktop console keeps its own system; nothing here describes or binds it. The brand values come from the shared `packages/design-tokens/tokens.css`; the phone structure lives in `src/clem-standard.css`, which loads last and is the sheet every screen reads.

## Overview

**Creative North Star: "Apple's own apps, in Clementine's colours"**

The phone has one screen, and it belongs to Clem. It opens with a large "Clem" title, her pixel dog avatar, one greeting line, one headline about where things stand, an always-on status line, and then grouped white cards for the conversation waiting on you and the cards that need an answer. Every other place (Chats, Inbox, Spaces, Automations, Work, Tasks & results, Agents, Memory, Apps & devices, Recents) lives in the **Your stuff** sheet. The sheet rises from the round button left of the composer, and each place pushes in with a back link that reads "‹ Clem". The phone has no tab bar and no dashboard of equal tiles.

The structure is iOS played straight: large titles, inset grouped lists with inset hairlines, a bottom sheet with a grabber and a Done link, a segmented control, chevrons on rows that push, and 44px touch targets. The materials are Clementine's own: a cream canvas, white cards drawn by one warm hairline, a warm-brown ink ramp, and warm translucent fills where iOS would use gray. Clementine orange is scarce on purpose. You see it only where something needs you or where Clem is alive.

The density is calm. Each screen gets one large title, section heads are short sentence-case phrases, and secondary text drops to the muted ink, never to a second hue. The phone is always light.

**Key Characteristics:**
- One Clem screen. Every other place sits in the Your stuff sheet and pushes with "‹ Clem".
- Large titles, inset grouped white cards, inset hairlines, a bottom sheet.
- Cream canvas (#faf7f2), white cards, one warm hairline instead of a shadow.
- Clementine fills carry the ink label, never white. Orange you read is the deeper ink orange.
- Orange marks only "needs you" or "Clem is alive".
- 100% light. There is no dark phone.

## Colors

The palette is restrained: warm neutrals do almost all the work, and one brand orange plays two strictly separated roles.

### Primary
- **Clementine** (`clementine`): the orange you look AT. It fills the action that acts on a Needs-you card ("Review and approve", "Look into it"), the send circle when there is something to send, the Inbox glyph tile and its count badge in Your stuff, Clem's live dot, her breathing avatar ring, and the pulse on a running step. It is a fill or a mark, never text (3.18:1 on white).
- **Clementine Press** (`clementine-press`): the pressed state of every clementine fill. It was deepened so the ink label still clears AA under the finger (4.55:1).
- **Clementine Ink** (`clementine-ink`): the orange you READ (5.08:1 on the canvas, 5.43:1 on white). It colours the "‹ Clem" back link, Done, text links ("Reply in your words", "See all", "Create an automation"), the "N things need you" headline, "Waiting on your answer" notes, the Needs-you count in the segmented control, the "Needs a connection" gap, and focus outlines.
- **Clementine Ink Deep** (`clementine-ink-deep`): the pressed or hovered state of orange text. Text darkens on interaction and never brightens.
- **Clementine Tint** (`clementine-tint`): the tile behind each place glyph in Your stuff, the "Needs you" status chip, and text selection.
- **Live Halo** (`live-halo`): the soft ring around Clem's live dot and the pulse on a running step.

### Neutral
- **Warm Ink** (`ink`): titles, row titles, body text, and the label on every clementine fill (5.39:1 on clementine).
- **Muted Ink** (`ink-muted`): the greeting, meta lines ("Work review · 9h ago"), the idle status line, secondary actions ("Later", "Dismiss"), section intros, and timestamps.
- **Subtle Ink** (`ink-subtle`): the smallest captions, such as the conflict line under a card record. It passes AA (5.32:1 on the canvas). Don't use anything lighter for text.
- **Cream Canvas** (`cream-canvas`): the ground of every screen and of the Your stuff sheet. The place bar sits on it too.
- **Card White** (`card-white`): grouped cards, the composer, the round Your stuff button, the avatar disc, and the active segment.
- **Pressed Cream** (`pressed-cream`): a row under the finger, the row for the place you are in, and the neutral status chip ("Off", "On demand").
- **Quiet Mark** (`quiet-mark`): non-text marks only. It covers the sheet grabber, row chevrons, and the idle status dot.
- **Hairline / Hairline Strong** (`hairline`, `hairline-strong`): the place bar's bottom rule (0.5px) and the inset row separators inside grouped cards.
- **Card Edge** (`card-edge`): the 1px ring that draws every white card on the canvas.
- **Fill Quiet** (`fill-quiet`): the quiet button, the "Since you last looked" digest pill, the segmented-control track, and the search field. It is warm, never gray.
- **Scrim** (`scrim`): the ink-tinted dim behind the Your stuff sheet.

### Status
- **Leaf** (`leaf-success`): done check marks in a card record, an answered receipt, and the "On" chip on a 10% leaf wash. Success is the only status hue a calm screen shows.

### Named Rules
**The Two-Role Orange Rule.** Clementine (#f26419) fills things and #b94300 colours words. A filled clementine control always carries the warm-ink label (#1f1b16), never white. Orange text is always the ink orange.

**The Needs-You-Or-Alive Rule.** Orange appears only on what needs the owner (the headline, the acting answer, "Waiting on your answer", the Inbox tile and badge, the Needs-you chip and count) and on Clem being alive (the live dot, the breathing ring, the running pulse). Links and the back button use the ink orange because they are iOS's tint colour. That is the one other place orange text appears.

**The Always Light Rule.** The phone is 100% light by standing owner directive. Nothing on this surface reads a dark theme.

## Typography

**Display Font:** the system rounded face (ui-rounded / SF Pro Rounded, falling back to -apple-system)
**Body Font:** the system text face (-apple-system / SF Pro Text, with Helvetica Neue)

**Character:** the faces of Apple's own apps, used on purpose because this world is iOS played straight. The rounded display face sets the large titles and section heads and gives Clem a softer voice. SF Text carries everything you read and tap.

### Hierarchy
The ramp follows iOS Dynamic Type sizes at the default setting.
- **Large Title** (700, 34px, 1.12): "Clem" on her screen. Only one appears per screen.
- **Sheet Title** (700, 28px, 1.15): "Your stuff" at the top of the sheet.
- **Headline** (700, 22px, 1.22): the one line of where things stand. It turns ink orange when something needs you.
- **Section Title** (700, 20px, 1.2): "Pick up a conversation", "Waiting on you", "Recents", and chat-list heads. Sentence case, with the count in 16px muted ink beside it.
- **Nav Title** (600, 17px): the centred place name in the place bar, the "‹ Clem" back label, Done, and sheet row labels (400 there).
- **Row Title** (600, 16px, 1.3): the first line of a grouped row and Clem's question on a Needs-you card.
- **Body** (400, 16px): card record words and composer text.
- **Callout** (500–600, 15px): button labels, text links, the greeting, and section intros.
- **Footnote** (400, 13px): meta lines, timestamps, and the "Since you last looked" pill.
- **Caption** (400, 12px): status chips and the card record's smallest lines.

### Named Rules
**The Sentence-Case Rule.** Section heads and group labels are short sentence-case phrases ("Waiting on your OK · 2"). They never use uppercase tracking or a label that sits above the title.

**The Tabular Time Rule.** Elapsed times and counts that update in place use tabular numerals so they don't jitter.

## Layout

The phone is a single column inside a 16px gutter (`sp-4`). Beside a system rail or a notch, the gutter becomes `calc(16px + env(safe-area-inset-left/right))`, so content never sits under the rail. The Duo front-screen capture with a simulated right rail confirms this. The sheet, the composer capsule, and toasts all use the same gutter formula. Content tops out at 760px and the capsule at 728px.

The rhythm runs on a 4px base: 4 / 8 / 12 / 16 / 22 / 30. Clem's screen spaces its sections 28px apart. The Your stuff sheet spaces its groups 18px apart, and place lists leave 22px below each group. A grouped row is 12px × 16px inside (14px × 16px for a Needs-you card). Rows that push are at least 52–64px tall, and every tap target is at least 44px.

The composer floats at the bottom, `max(22px, safe-area-bottom + 10px)` up from the edge, with a cream fade beneath it so the page visibly continues. The round Your stuff button sits to its left. Both lift with the keyboard, and the Your stuff button hides while you type so the composer takes the whole width.

At 880px and wider (an unfolded or wide window), a sidebar of 180–224px replaces the sheet. The back link and the Your stuff button disappear, and the place title moves to the left in the headline size. Opened across a vertical fold, the sidebar fills the first page, with sections in two columns and recents below them. The open screen fills the second page, and nothing crosses the crease.

## Elevation & Depth

Depth here is mostly tonal: white cards on a cream canvas, drawn by a ring instead of a drop shadow. Only things that float above the page get a real shadow: the composer, the Your stuff button, Clem's avatar, the sheet, and the active segment.

### Shadow Vocabulary
- **Card Edge** (`box-shadow: 0 0 0 1px rgba(63, 42, 22, 0.08)`): every grouped card, the live group, Your stuff groups, and recents.
- **Floating Control** (`box-shadow: 0 1px 2px rgba(63, 42, 22, 0.08), 0 8px 24px rgba(63, 42, 22, 0.1)`): the composer and the round Your stuff button.
- **Avatar Lift** (`box-shadow: 0 1px 2px rgba(63, 42, 22, 0.1), 0 4px 14px rgba(63, 42, 22, 0.08)`): Clem's avatar disc.
- **Sheet** (`box-shadow: 0 -12px 40px rgba(63, 42, 22, 0.16)`): the Your stuff sheet over the scrim.
- **Selected Segment** (`box-shadow: 0 1px 3px rgba(63, 42, 22, 0.12)`): the active segment in a segmented control.

### Named Rules
**The One Warm Hairline Rule.** A card on the canvas is drawn by one warm ring. It has no border plus shadow, no gray shadow, and no lift at rest. Every shadow is tinted with the warm brown (63, 42, 22).

**The Only-Floaters-Lift Rule.** A real shadow means the thing floats over content you can still see. Cards never get one.

## Shapes

The corners are gently continuous and follow iOS proportions. Grouped cards use 16px. Answer buttons use 12px. The search field and segmented track use 11px, with 9px segments inside. Place glyphs sit on 8px tiles, the sheet's top corners are 22px, and the composer is a 26px capsule. Count badges, status chips, the digest pill, and the start button are full pills. The avatar, the Your stuff button, the send button, and the live dots are circles.

Row separators are 0.5px hairlines inset from the leading edge: 16px in grouped cards, and 56px in Your stuff so they start where the label starts. The first row of a card has no separator. The state marks (done check, failed cross) are drawn SVG strokes sized to 1em of the text around them, so they look the same in every font.

## Components

### Buttons
Answers on a card sit side by side at equal width. The answer that acts is filled, and everything else is quiet or plain words.
- **Shape:** gently rounded (12px), 42px tall, 9px × 12px padding.
- **Primary:** clementine fill with the warm-ink label, callout 600. Pressed, it turns to Clementine Press and scales to 0.97.
- **Quiet:** Fill Quiet with the ink label, same shape. It holds the second answer ("Run it again").
- **Words:** remaining choices sit in a row of plain text links, 18px apart. "Reply in your words" is ink orange, and "Later" and "Dismiss" are muted ink.
- **Start:** a place's "one way to start" is a 36px quiet pill with an ink-orange label.
- **Focus:** a 2px ink-orange outline with a 2–3px offset, never a glow.

### Chips
- **Status chip:** a full pill with 3px × 8px padding and a 12px caption at heavy weight. It is neutral on Pressed Cream ("Off", "On demand"), Leaf on a leaf wash ("On"), and ink orange on Clementine Tint ("Needs you").
- **Count badge:** a 22px clementine pill with an ink label in tabular numerals ("9+"). It appears only on the place that holds what needs you.

### Cards / Containers
- **Corner Style:** 16px.
- **Background:** Card White on the Cream Canvas.
- **Shadow Strategy:** the Card Edge ring only (see Elevation & Depth).
- **Border:** none. Rows inside are separated by inset 0.5px hairlines.
- **Internal Padding:** 12px × 16px per row, 14px × 16px for Needs-you rows and card records.
- **Pressed:** the row takes Pressed Cream, and the live rows dim to 0.6 opacity.

### Inputs / Fields
- **Composer:** a white 26px capsule with the Floating Control shadow. It holds +, the "Ask Clem…" placeholder in muted ink, the mic, and a 44px send circle. The send circle is clementine with an ink arrow when there is something to send, and quiet and disabled when there is nothing.
- **Search:** a 38px Fill Quiet field with an 11px radius and a muted placeholder.
- **Focus:** an ink-orange caret plus the ink-orange outline.

### Navigation
- **Place bar:** a 48px three-column grid on the canvas with a 0.5px hairline beneath. "‹ Clem" sits on the left (a 26px chevron plus a 17px ink-orange word, at 0.5 opacity when pressed), and the place name is centred in the 17px/600 nav title. On Clem's own screen the bar steps away and the large title leads.
- **Your stuff sheet:** it rises from the bottom (0.46s, ease-out, no overshoot) over the scrim. It has a 36 × 5px grabber, the "Your stuff" sheet title, and a Done link. Places sit in inset grouped white groups: New chat; Chats + Inbox; Spaces + Automations; Work + Tasks & results + Agents; Memory + Apps & devices. Recents follow below. Each row is 52px with a 30px glyph tile, a 17px label, and a quiet chevron. The place you are in reads as a pressed row, never a second colour. The sheet closes by pulling down or tapping Done, and the exit mirrors the entrance. With reduced motion, the sheet fades instead of travelling.
- **Segmented control:** iOS's control on a Fill Quiet track. The active segment is white with the Selected Segment shadow, and each label has its count beneath. Only the Needs-you count is ink orange.

### Clem's Lead (signature)
The top of the one screen has three parts:
- **Title row:** the large title "Clem" and the 46px white avatar disc with the pixel dog (rendered pixelated). While she works, a 2px clementine ring breathes around the disc (2.2s ease-in-out, opacity 0.35 to 1, scale 0.97 to 1.03).
- **Text lines:** the muted greeting, then the headline (ink orange when something needs you). Under it sits the always-on status line: a 7px dot (Quiet Mark when idle, a pulsing clementine dot with the halo while she works), then the muted line, which turns ink and medium weight while she works.
- **Digest pill:** the optional "Since you last looked" pill comes last.

### The Live Group (signature)
"What Clem is doing" is a white grouped card headed by an 8px clementine dot with a 4px halo. Each running item is a 60px row with a pulsing dot, the task in row-title weight, the current step in muted 14px, and the elapsed time in tabular numerals.

### Card Record (signature)
Under an answered or pending Needs-you card, the record reads in this order: what Clem needs (row title), the filled action, "You asked:" in muted footnote, the steps with drawn leaf checks, and a subtle caption with the finding.

## Do's and Don'ts

### Do:
- **Do** put every new place in the Your stuff sheet and push it with "‹ Clem". Clem's screen stays the only root.
- **Do** draw cards as white on the Cream Canvas with the Card Edge ring (`0 0 0 1px rgba(63, 42, 22, 0.08)`) and inset 0.5px hairlines between rows.
- **Do** label every clementine fill with warm ink (#1f1b16), and press it to Clementine Press.
- **Do** colour words orange only with Clementine Ink (#b94300), and only for links, the back and Done links, and what needs you.
- **Do** use the gutter `calc(16px + env(safe-area-inset-*))` on any edge that can meet a system rail or notch.
- **Do** keep every tap target at least 44px, and give pushing rows a quiet chevron.
- **Do** use the warm translucent Fill Quiet for quiet buttons, tracks, and fields, and Pressed Cream for pressed and current rows.
- **Do** draw state marks as SVG strokes (the check and cross glyphs), sized to 1em.
- **Do** let motion arrive and settle (`cubic-bezier(0.22, 1, 0.36, 1)`, 180ms default, 300ms ceiling except the sheet's rise). Press with scale 0.97, and fall back to opacity or none under reduced motion.

### Don't:
- **Don't** add a tab bar, a second root screen, or a dashboard of equal tiles.
- **Don't** put white text on clementine, or set any text in #f26419.
- **Don't** spend orange on decoration, categories, or brand flourishes. It means "needs you" or "Clem is alive".
- **Don't** introduce a dark theme or dark surfaces on the phone.
- **Don't** use gray: no cool-gray fills, neutral shadows, or blue system tint. Every neutral is warm.
- **Don't** give resting cards a drop shadow, or stack a border and a shadow on the same card.
- **Don't** set section heads in uppercase tracking or put a small label above a title.
- **Don't** use text characters (✓, ✕, →) as state icons.
- **Don't** set text lighter than Subtle Ink (#75644f). Quiet Mark is for chevrons, grabbers, and idle dots only.
