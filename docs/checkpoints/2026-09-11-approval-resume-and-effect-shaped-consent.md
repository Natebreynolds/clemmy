# 2026-09-11 — the approved write that never happened, and the nouns behind it

Worked from two live mobile runs the owner recorded an hour apart: the same
calendar task on two different brains. Everything below is measured from those
runs' eventlog and usage rows, not inferred.

---

## 1. The one that matters: an approved write silently never ran

Both runs died identically on the approval-resume path:

```
approval_resolved (approve) → run_resumed → turn_engine_selected (resumed)
→ turn_started → run_paused {"bytes": N} → nothing, ever
```

7–12 ms end to end, so no model call happened. One brain sat 36 minutes, the
other 5+, with the approval already **consumed** and no event naming a cause.
The user re-checked the calendar 27 minutes later: still empty.

**Root cause.** A committed `continue` checkpoint is adopted by the NEXT
activation, never re-run in place. `runConversation` takes that hop itself
(`checkpointContinuationIsReady`) "so a committed recovered frame does not wait
for the next restart tick". The approval resume is a **separate entry point**
that never passes through `runConversation`, so its held frame waited for
exactly that tick. `runConversationFromResume` exists because the resume path
bypasses the continuation loop — it closed that gap for the `completed` case
and left `held` open.

**Fix.** The resume takes the same single hop before returning `held`, and a
held resume that cannot hop records `approval_resume_held_without_wake` with the
reason, wake owner and approval id. Model-independent: reproduced on two brains,
which is what ruled the model out.

## 2. A refusal that wrote nothing

`primePrimaryModelPlanningCatalog` had eight `ok: false` exits and not one wrote
anything; both production callers discarded the reason (one generic sentence /
one process log). A scheduled step re-dispatched every 15 s for ten hours and
left **zero** evidence across 1,444 attempts. All eight now route through one
recorder emitting `primary_model_planning_prime_refused {sourceUserSeq, stage,
reason}` — `stage` separates "this source was never readable" from "the frozen
card no longer reopens", which have opposite repairs.

## 3. Omitting effort selected the most expensive setting

`ANTHROPIC_EFFORT_MAP.none` was `null` — "omit so the model uses its adaptive
default". On that wire the default effort is the TOP of the range the same map
deliberately avoids, so the ladder inverted: asking for less cost more.

Measured, one turn, same model, same session:

| tier | wire | output tokens | latency |
|---|---|---|---|
| `none` | *omitted* | **3,817** | **45.6 s** |
| `medium` | `medium` | 227–432/call | 3.3–4.2 s/call |

The 45.6 s call's entire visible output was a 200-character clarifying question.
`none` now maps to the enum floor. Pinned: no effort-capable model may map a
tier to null, and mapped effort may never decrease as the tier rises.

## 4. Consent asked which product, not whether it was reviewable

The one-line consent gate read `label !== 'email'` plus an email-shaped subject
and body, with the label chosen by a regex of vendor and channel nouns held in
the harness. A record, an invite, a row — none carry a "body", so all fell to
the formal card however plainly describable they were, and supporting anything
else meant a branch per service inside a consent path.

The layer below already had this right: the effect taxonomy keys on the verb
plus an externality cue and names no vendor. Consent now asks **one unambiguous
destination + a legible description**, both read from whatever fields the
operation has. Labels come from the operation's own words, so a service the
harness has never heard of works:

```
ACME_CRM_CREATE_RECORD             -> record
BRANDNEW_SAAS_SCHEDULE_APPOINTMENT -> appointment
work_call                          -> send   (degrades neutrally, never wrongly)
```

**Near-miss worth keeping.** `!subject` was doing two jobs — the email shape
(the defect) and a fail-closed ambiguity check (a real property). Removing the
first took the second with it; two existing tests caught it. Both are now
explicit: conflicting subject/body candidates fail closed, and a payload with a
body must also name what it is.

## 5. Conversational consent was reachable from one channel

`autonomousSendConsentPresentation` also requires `userId` + `conversationKey`
on the accepted source, and `conversationKey` was stamped in exactly one
channel's file. Every other surface produced sources with no audience, so the
capability silently degraded to the formal card with no error naming it. Fixed
at the framework level: audience identity is read from the **session**, which
every surface already populates, and stamped on every accepted gateway source.

## 6. An account can be named the way people name it

Turn 1 answered "your <work> calendar"; turn 2 could not reuse it because only
an exact address counted, so Clem asked a question turn 1 had answered —
~80 s and two extra turns.

Labels now count, **but only from Clem's own replies**, where naming an account
is her record of what she did. A label is an ordinary word; over a long
conversation "the <work> deal" would accumulate incidental mentions in user
prose, and one of those must never become the account a write lands in.
Verified against 20+ exchange transcripts: unique across the session or ask —
never most-recent, never a guess.

---

## Still open

- **Prompt cache resets every turn.** Tool schemas grew 9,530 → 10,539 tokens
  between turns as discovery disclosed capabilities. Tools render first in the
  cache hierarchy, and the breakpoint sits on the LAST tool, so growth moves it
  and invalidates everything behind. One turn's opener paid 44,045 uncached
  tokens 55 s after a live 36 K prefix. Fix shape: stable tool core first,
  breakpoint after it, disclosed tools appended behind.
- **The effect taxonomy is noun-sensitive and gates safety.** An unknown
  service's `*_CREATE_RECORD` classifies `external: false, read_only`. Same
  family as §4, one layer down, deciding whether a write is gated at all.
- **The host hands back questions it already answered.** A search result
  carrying `accountSelectionNextStep` disarms the host's own fast path by
  design, after computing the question and both options.
- **Remaining harness vocabulary.** Role nouns, operation verbs and destination
  keys are still word lists. They are generic rather than vendor-specific, and
  every one fails CLOSED (an extra ask, or the formal card) — which is what
  makes them a safe floor for procedural memory to improve on rather than a
  list to keep extending.
- **Account phrasing is narrow.** "<address> is my sending account" establishes;
  "use <address> for this please" does not. Pre-existing, fails closed, pinned
  as a known limit. Switching accounts mid-conversation is also not read as a
  switch — it reads as two accounts named, so she asks again.

## Verification

`tsc --noEmit` clean. Suite run in slices (the full glob exhausted memory):
688 + 3,089 + 2,226 + 1,731 = **7,734 tests, 7,733 pass, 2 skipped**, one
failure — `fresh-source-session-independence.red.test.ts`, a `.ts` Worker
spawned with `--import tsx` not receiving the loader. Confirmed pre-existing by
stashing the change set and reproducing it identically. Packaged installs load
built `.js`, so the shipped app is unaffected.

Three changes want a live look before being trusted, because tests cannot say
they feel right: consent (sentence vs card), the label match (which account a
write binds to), and the gateway audience identity.
