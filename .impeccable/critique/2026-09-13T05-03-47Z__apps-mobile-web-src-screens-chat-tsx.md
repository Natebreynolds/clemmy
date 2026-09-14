---
target: mobile chat
total_score: 24
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 4
target_identity: "file:$HOME/clementine-next/apps/mobile-web/src/screens/Chat.tsx"
target_fingerprint: "sha256:78c46420492cd52666ff4e1a54e47297aff78a322b27a6f55f208d6e30fd8331"
target_path: $HOME/clementine-next/apps/mobile-web/src/screens/Chat.tsx
timestamp: 2026-09-13T05-03-47Z
slug: apps-mobile-web-src-screens-chat-tsx
---
# Critique — mobile chat (thread + list)

Target: `apps/mobile-web/src/screens/Chat.tsx` (open thread), plus `Chats.tsx` (list) and `AskCapsule.tsx` (list-only composer).
Mode: Operate. Identity: 100% light warm paper, orange accent, dog mark. Refinement, not rebrand.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|:-----:|-----|
| 1 | Visibility of System Status | 3 | WorkLine, writing caret, sending/retry, typed terminals, reconnect pills. List `active` is an uncolored 6px dot. |
| 2 | Match System / Real World | 2 | “Don’t do this” vs “Empty session.” / “Brain” / “Normal · handle the task” / raw `active`. |
| 3 | User Control and Freedom | 2 | Edge-back works for a tapped thread; composing from capsule/`btn-new` does not register `useBackGesture`. Composer Stop is one tap; WorkLine Stop confirms. |
| 4 | Consistency and Standards | 2 | Two composers, two send glyphs, two stop patterns, four yes/no verb pairs, PlanReview is a striped slab. |
| 5 | Error Prevention | 2 | Empty send disabled; delegated Stop confirms. Enter-to-send on a textarea; no `enterkeyhint`; composer halt unconfirmed. |
| 6 | Recognition Rather Than Recall | 2 | List is title + engine status, no last-message preview. Plan is a mode. Id-less approvals send people to “the menu.” |
| 7 | Flexibility and Efficiency | 3 | Capsule autoSend, dictation (list only), steer-while-busy, last-conversation launch, jump-to-latest. |
| 8 | Aesthetic and Minimalist Design | 3 | Transcript is spare on purpose. Double header + always-on Plan bar + Brain chip tax a 390pt frame. |
| 9 | Error Recovery | 3 | Retry/discard, ScreenNotice, honest boot copy. “Empty session.” is not recovery. |
| 10 | Help and Documentation | 2 | Mode-bar copy tries to teach and reads as jargon. |

**Total: 24 / 40 — Acceptable.** The reading surface is a 3–4. The phone chrome around it is a 2.

## Design Specificity Verdict

**LLM assessment:** Authored in the reading. Interchangeable in the operating. A settled assistant turn is Clem: unboxed `.reply` at 68ch, quiet parchment `.user-said`, one `.work` line, warm-wash `.turn-approval`. That is a person on paper, not a messenger skin. Everything around it is category AI-chat: `.chat-mode-bar` (“Normal · handle the task”), unicode `←` `↑` `■`, a model chip named “Brain,” `.btn-new` fighting AskCapsule, list rows of title + raw `active` + 6px gray `.status-dot`. Screenshot a reply and it is Clementine. Screenshot the composer or the list and it is any 2024 agent PWA.

**Deterministic scan:** `impeccable detect --json` on Chat.tsx, Chats.tsx, and AskCapsule.tsx: exit 0, `[]` findings. TSX is regex mode; markup is almost all `class=`; CSS lives in `styles.css` and was not scanned. Empty CLI result is a likely-true clean for the TSX regex pass, not proof the chat CSS is clean.

**Visual overlays:** No reliable user-visible overlay on Chat. Mutation preflight succeeded, but daemon `:8420` was down so `/m/` and `/m/?tab=chats` both rendered the boot-error login shell (“Can’t reach Clementine right now…”). detect.js was injected on that boot screen only and reported `layout-transition` on `body` — a false positive (author `body` has no `transition`; the only `transition: width` is `.home-progress-fill`, not in that DOM). Chat / Chats list / AskCapsule never mounted.

## Overall Impression

Keep the transcript. Rebuild the chrome so it belongs to the same product.

The one visual job of mobile chat is: Clem’s answer is the page; everything else recedes. That job is already done in CSS comments and in the reply itself. It is undone by a second title bar, an always-on Plan mode strip in the thumb zone, prototype unicode controls, and a conversation list that looks like an admin table.

## What's Working

1. **The transcript contract is real.** Unboxed 68ch `.reply`, no-gradient `.user-said`, one WorkLine, warm `.turn-approval`. Comments and CSS agree. Do not box Clem.
2. **AskCapsule is the one control that already knows it is a phone.** Blur, lift, `visualViewport` `--kb-inset`, dictation only when the API exists, `enterkeyhint="send"`, autoSend into a new thread, hidden when a thread owns typing (`capsuleShown` in `app.tsx`). That split is correct.
3. **Honesty under stress.** `sending…` / retry / discard, `reconnecting…` / “catching up in the background,” typed terminals (“Stopped here — your work is kept”), delegated “Stop this? / Keep going,” live boot: “Nothing was lost — she’s just not answering yet.”

## Cognitive load

6 of 8 checklist items fail → **high.** Failures: competing primary actions on the list; jargon labels; `status-active` has no color; Plan is a persistent mode; no last-message recognition; chrome louder than content; same action, different controls. Pass: WorkLine progressive disclosure.

## Emotional journey

Arrive on the list: dog empty state is warm, then two start controls and gray engine dots. Open a thread: second title bar, Plan bar explains a mode you did not ask for, edge-back unwired if you came from the capsule. Work is the peak (spinner + unboxed Clem + citrus caret). Decide: warm wash, then verb fight, then PlanReview as a 3px accent rail. Leave: send is the one warm mark wearing a prototype `↑`. Peak is Clem working. End is chrome and jargon. Ends dominate memory.

## Priority Issues

### [P1] The open-thread composer is not the capsule

**Why it matters:** AskCapsule is the designed persistent control. The thread — the place typing is supposed to live — is a generic textarea + unicode `↑` / `■`. It has no `visualViewport` inset, no `enterkeyhint="send"`, `font-size: var(--t-body)` that can sit under 16px and zoom iOS, no dictation, and `padding-bottom: var(--sp-1)` with no `safe-area-inset-bottom` (capsule uses `env(safe-area-inset-bottom)`; thread composer sits on the home indicator). `.chat-jump { bottom: 72px }` does not account for the Plan bar (~44px) + composer stack.

**Fix:** One composer primitive. Thread inherits capsule lift, 16px type, `enterkeyhint`, SVG send, optional mic, keyboard inset, home-indicator padding. Confirm Stop the same way as delegated work. Park “Jump to latest” on the transcript, above the composer — not at a magic `72px`.

**Suggested command:** `/impeccable quieter` (then `/impeccable polish`)

### [P1] Double chrome + accidental page-title + always-on Plan

**Why it matters:** On ~390px an open thread stacks: dog + **Chats** + work chip + Needs-you pill + conn, then `←` + conversation title + `.brain-chip` (max 34vw) + reconnect pill, then transcript, then `.chat-mode-bar` (“Normal · handle the task”), then composer. `.chat-title` sets `font-size: var(--t-body)` but loses to `.app-main h2:not(.section-head)` (`t-title`, weight 800, 12px vertical margin) because Chat is the only screen that uses an `h2` for that class. Title has no `flex: 1; min-width: 0`. Plan is a 44px engineer strip in the thumb zone on every blank composer.

**Fix:** One header while a thread is open: back (SVG), truncated title, optional status. Demote Brain to overflow/sheet. Hide `.chat-mode-bar` until Plan is actually in play (or a quiet text control in the composer). Make `.chat-title` win its own type.

**Suggested command:** `/impeccable distill`

### [P1] Two doors on the list; empty copy points at the wrong one

**Why it matters:** `.btn-new` “New chat” on top. AskCapsule “Ask Clementine…” on the bottom. Empty: “Start one above — she picks up all the context from your Mac.” The product already chose the capsule as the persistent control. `useBackGesture(selectedId !== null)` — composing from capsule or New chat never pushes history.

**Fix:** Delete `.btn-new` (or make it a header icon, not a second ask). Empty copy: “Ask below — she already has your Mac.” Register back for `composing` the same as `selectedId`.

**Suggested command:** `/impeccable quieter`

### [P1] Four ways to say yes; PlanReview is a foreign object

**Why it matters:** Tool approval = Approve / Don’t do this. Plan proposal = Approve & Proceed / Reject. Plan artifact = Execute plan / Revise in Plan mode. Id-less approval = “Open ‘Needs you’ from the menu.” `PlanReview` is `border-top: 3px solid var(--accent)` — the slab + stripe `.turn-approval` was written to avoid. Markup still uses desktop Tailwind (`bg-primary`, `text-muted`, `list-disc`) that does not exist in mobile CSS.

**Fix:** One pair of verbs everywhere that matches Needs you: **Approve** / **Don’t do this**. Warm-wash the plan card like `.turn-approval`. Port PlanReview off dead utilities. If the approval has no id, deep-link to that Inbox row.

**Suggested command:** `/impeccable clarify`

### [P2] The list is not glanceable

**Why it matters:** `SessionStatus` is `active | paused | completed | failed | cancelled`. Dots color `completed` / `failed` / `cancelled` (and unused `running` / `awaiting_*`). **`active` — the common live state — is unstyled gray.** Copy is `status.replace(/_/g, ' ')`. No snippet. `session.kind` is unused.

**Fix:** Human labels (“Working,” “Paused,” “Done”). Color `active` with the accent pulse language already used on live cards. One line of last durable state, not a second title.

**Suggested command:** `/impeccable layout`

## Persona Red Flags

**Casey (distracted, phone):** Gray `active` dots. No snippet. Two start buttons. Keyboard vs composer. `↑`/`■` as halt/send. Jump overlapping Plan. Needs-you in the header *and* in the thread. Composer has no home-indicator inset.

**Jordan (first-timer):** “Normal · handle the task.” “Brain.” “Empty session.” Approve vs Approve & Proceed vs Execute plan. Empty list says start *above* while the designed control is *below*.

**Riley (stress tester):** Composer Stop unconfirmed vs WorkLine confirmed. New-chat path has no back entry. `.chat-title` overflow with Brain + “catching up in the background.” Settled WorkLine elapsed uses mount `Date.now()`, not turn duration — reopen an old thread and “Worked 47m” can lie. `.conn-pill` is defined twice (header ~L300, chat ~L1707). PlanReview utilities are dead.

**Owner-operator (PRODUCT.md):** Glanceable first: the list does not answer “what’s running / what needs me.” One truth, one door: New chat vs capsule; transcript vs Needs you. Render the ledger: “Worked 12s · 4 steps” is effort, not effect. Familiar over clever: unicode prototype controls next to SVG chrome.

## Minor Observations

- Boot/error identity is right (live 390×844): dog, orange pill, “she’s just not answering.” Canvas is `#ffffff`; warmth is accent + parchment pills, not a cream wash.
- `.brain-chip` has `title=` but not `aria-haspopup` / `aria-expanded`.
- Transcript `role="log"` with `aria-live="off"` — streaming Clem is invisible to AT.
- Work carets `›` / `⌄` vs SVG chevrons everywhere else.
- Placeholder split (“Ask Clementine…” vs “Message Clem…”) is fine; dictation only on the list is not.
- `.inbox-empty` for thread empty is hint-gray; list empty correctly uses `.empty-body`.
- `phoneHeaderChrome` still puts work chip + Needs-you pill on Chats — correct for the *list*, noise once a thread is open.
- Reduced motion is actually wired. Keep that.
- Do not box assistant replies. Do not introduce a dark theme. `docs/mobile-premium-ui-2026.md` “already right / do not touch” for unboxed chat still holds; its dark `#0b0806` section does not.

## Questions to Consider

1. If AskCapsule is “the app’s one persistent control,” what job is `.btn-new` still doing besides teaching people to ignore the capsule?
2. If Plan is the exception, why does every blank composer open in a 44px mode named **Normal**?
3. If the reply is the product, why is the conversation title an overflow casualty of **Chats** + **Brain** + **Needs you** + a work chip?
4. Why does Stop next to `↑` fire in one tap when Stop in the WorkLine asks **Stop this?**
5. Is “Worked 12s · 4 steps” the ledger — or a spinner’s ghost?
