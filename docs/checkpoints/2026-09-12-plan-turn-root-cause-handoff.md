# HANDOFF — A Plan turn went 33 min → 7m32s, and the cause was one boolean

Continues `docs/checkpoints/2026-09-11-plan-mode-continuation-handoff.md`.
That file's product framework still holds. This one is the night's root cause,
what is proven, and what is owed.

**Do not tag. Nothing is pushed.**

---

## 0. State

| | |
|---|---|
| branch | `main` at `74868758` — **11 commits UNPUSHED** (`origin/main` = `449f369a`) |
| last tag | `v3.18.5`; `package.json` 3.18.5 both roots. A future tag must be ≥ 3.18.6 |
| installed app | hot-patched **09-11 23:20** — carries 10 of 11 commits, NOT `74868758` |
| uncommitted, NOT MINE | `PRODUCT.md`, `apps/console-web/src/app.tsx`, `Home.tsx`, `Home.test.ts`, untracked `assets/`, `components/home/mock/`, `HomeMock.tsx` — someone is mid-build on a Home mock. Left untouched. |

Design doc written alongside this one:
`docs/checkpoints/2026-09-11-tool-result-and-routing-framework.md` (staged, not
committed — its §4.3 and §5 were rewritten twice as hypotheses died).

---

## 1. The through-line

This is the part that will be obvious today and invisible tomorrow.

```
model-wire-registry said grok: supportsPromptCache = false
  → inFlightCompactionThresholds kept the ABSOLUTE 32k trigger
    (it scales with the window only on a caching wire)
  → a 256k-window brain compacted at 13% of context
    → compaction replaced her tool results with [clipped: …] stubs
      → she lost her INDEX of the capabilities she still held
        → re-searching costs 1 call; recall costs a call PLUS knowing the call_id
          → six near-identical DataForSEO searches against NINE proven
            DataForSEO operations
            → 33 minutes, or no plan at all
```

The flag was a 2026-08-20 judgement — *"no server-side prompt cache contract we
can rely on"* — never a measurement. The machine's own usage log
(`~/.clementine-next/state/token-usage/*.ndjson`) had the answer all along:

```
grok usage events        690
calls reporting cache    673   (97.5%)
input tokens          11,449,913
cached tokens          3,457,024   (30.2% hit rate)
cacheDialect          'inclusive' on all 690
smallest cached prompt     1,093 tokens
```

The owner challenged the flag on instinct ("are you sure grok doesn't cache? it
should"). He was right and the registry was wrong.

---

## 2. Proven live

One task, four runs, same prompt, same document:

| run | compactions | pairs collapsed | recalls | calls | time | plan |
|---|---|---|---|---|---|---|
| `e61923ac` 02:20 | 10 | 945 | 78 | ~117 | 33 min | published |
| `f19ba387` 04:38 | 4 | 126 | 27 | — | 22.5 min | none (cancelled) |
| `03fef66e` 05:21 | 1 | 7 | 7 | 48 | 16 min | none (cancelled) |
| **`35263df7` 06:21** | **0** | **0** | **0** | **26** | **7m32s** | **published, first attempt** |

`refusedAttempts` 10 → 1. **Zero recall calls** is the clean confirmation:
nothing was collapsed, so she never re-read her own work, so she never
re-searched.

And the 7-minute plan is **better** than the 33-minute one, not thinner:
it names the exact Apify actor (`apify/website-content-crawler`), binds
Firecrawl search to FIND the four URLs the brief never gave (the 33-min plan
just declared that step Blocked), and discloses what it could not bind
(*"DataForSEO live SERP / LLM-citation endpoints were not bindable this turn"*).
Speed cost nothing.

Also proven: **`providerSourceCount = 3`** with `planningDisclosureWired = 1` on
a Plan turn — which KILLED the `carrierWork` hypothesis (§4.2).

---

## 3. Built, NOT proven live

Everything below fired zero times in the successful run, because compaction
never happened. They are the safety net beneath the cache fix, not the fix.

- **`turn-steer.ts`** — host-computed publish-or-ask nudge delivered into a tool
  result at the decision. Fired once, live, on `f19ba387` at 9m43s; she attempted
  publish 5m12s later. So the channel works; the condition is now different
  (§4.3) and has never fired since.
- **`held-inventory.ts`** — the map that rides inside the collapse summary.
  Never exercised live because nothing collapsed.
- **`next-edge.ts`** — every `retry:'replan'` disposition and the `publish_plan`
  validation refusal now carry a typed next move. The `publish_partial` edge has
  never been handed to a model.
- **`run-progress.ts`** inventory line — committed but **not in the installed
  app**.

---

## 4. Traps — five of tonight's six are mine

### 4.1 Read `tool_outputs`, never the `tool_returned` event

`hooks.ts:635` caps the eventlog's copy of a result at **8,000 chars** inside
`appendEvent`. The model gets the full payload. I measured "65% of tool_search
results clipped" off that cap and proposed relevance-aware clipping for a
problem that did not exist. The full 15,469-char payload for the live failure
contained the named operation **nowhere at all** — it was a sourcing failure, not
truncation.

### 4.2 Absence in the log is not absence in the world

`tool_search_scope` recorded no source counts, `tool_policy_resolved` records
counts and never tool NAMES, and `prompt_composition` records token buckets and
never instruction text. Three separate hypotheses could not be confirmed or
killed because of this. `a5379af4` fixes the first; the other two remain —
**you still cannot tell from the ledger which tools a turn was given.**

### 4.3 A pin on the helper is not a pin on the connection

`4af5c9fc` gave `recordTurnSteer` an optional window and never passed it at the
only call site, so the first live firing recorded no `quietCalls` — the one
field whose purpose was tuning the threshold. The test passed because it called
the helper directly WITH a window. Fixed in `bc0d9808`, which pins the call
site. **Assert the recorded event, not the function's return.**

### 4.4 A green test keeps a wrong fact alive

`compaction.test.ts` listed `grok-4.6` among wires that "cache nothing",
encoding the same error as the registry. The measurement contradicted both. When
a fact is wrong, look for the test defending it.

### 4.5 Do not hand-roll a watcher filter

Three monitors wrote themselves blind: a cutoff typed as `06:15` when it was
`05:32` UTC; a `publish_plan` match on the event EXISTING rather than `ok:true`
(which made me report "published at 14m55s" when the publish had been REFUSED);
and a derived cutoff that landed 7 seconds after the session started. Pin the
session id you already know; match on the field that carries the verdict.

### 4.6 `hot-patch.sh` is not safe to interrupt (pre-existing)

It `rm -rf`s the installed daemon dist BEFORE copying. macOS App Management
blocks the copy from Claude Code's shell (same as VS Code's, §4.4 of the prior
handoff) — so a patch attempted from here deletes the daemon and cannot restore
it. **It left the owner's app unrunnable once tonight.** Staging the copy and
swapping at the end would make it atomic. Still gitignored.

---

## 5. Work queue

### 5.1 Push, and patch `74868758`

Eleven commits unpushed; the installed app is one commit behind. The progress
line has never been seen.

### 5.2 The `●` narration half — measure before building

`conversation_check_in` renders beautifully (dashed aside, muted, half-opacity
dog mark, `ChatBubble.tsx:262`) and fired **once across four runs, ~90 minutes**
— zero times in the run that succeeded. The surface is built and dormant, same
shape as `tool_choice_recall` (3 calls vs 813) and `actions/stream`.

**Do not add a cadence before finding what currently gates it.** At grok's
13–19 s/call a 30-second beat is ~2 model calls apart. Owner's mockup
(reconstructed from `35263df7`) wants narration at **stage transitions** and
**before a known-long silence** — that run had a 3-minute gap at t+4:30→7:00
writing the plan, 40% of the turn, where the card froze. One sentence there
("I have everything I need, writing now, ~2 min") is the highest-value
check-in in the whole run.

### 5.3 Record the tool surface (from §4.2)

`tool_policy_resolved` should carry resolved tool NAMES. It would have answered
"did she even have `publish_plan`?" in one query instead of an hour.

### 5.4 Re-verify the steer condition

`e4b15cbb` changed the predicate to distinct-toolkits after `4af5c9fc`'s version
proved unreachable. Both changes came from a total of two observed stalls.
`quietCalls` is now recorded — read it off a real firing before touching the
number. If it fires too eagerly, raise `CLEMMY_TURN_STEER_QUIET_CALLS`; do not
re-derive the predicate from another single data point.

### 5.5 Deferred with reasons

- **Move 1b (provider-blind lanes).** 37 of 38 exact-slug search misses returned
  zero provider rows, and 67% of those turns never returned one from ANY search.
  Plan mode is NOT the blind lane (§2). Needs `providerSourceCount` from a blind
  turn — only turns after the 21:37 patch carry the field.
- **The result folder / cross-session index** (framework doc moves 4–5). Owner
  approved: projection not source of truth, index crosses sessions, payloads
  LRU. Deliberately last — tonight showed the loop was the lost INDEX, not
  missing storage. `tool_outputs` keeps the results, `memory/tool-contracts`
  holds 2,000 schemas, and the catalog keeps capabilities callable throughout.
- **The judge on the steer channel.** Owner's idea, and the channel now exists
  with three possible sources (host counters = built, user = §5.6, judge).
  Needs a liveness contract: an unavailable judge pin means ZERO judge calls,
  silently, and `completionReview: 'enabled_unavailable'` on the 33-min run
  means nothing independently graded that plan.
- **User steering** (§5.6 of the framework doc). Scoped, not built. A user steer
  must carry NO authority — approvals keep their gated path, or a free-text box
  becomes an approval bypass.

---

## 6. Proof bar

`node scripts/run-tests-isolated.mjs <files>` on every file touched plus its
consumers. Every fix tonight was verified load-bearing by REMOVING it and
confirming a specific test fails. Do that; three of tonight's pins were
decorative until I checked.

`npm run check:public-hygiene` before any commit adding a fixture.

`npm run build` AFTER every commit. I committed `a5379af4` without rebuilding,
so the owner's patch carried 4 of 5 fixes and the telemetry produced nothing.

---

## 7. One-sentence success

A Plan turn reads what the owner gave it, keeps what it has learned in view,
publishes a reviewable plan in single-digit minutes, and the owner can see it
converging while it happens — which as of `35263df7` is true for everything
except the last clause.
