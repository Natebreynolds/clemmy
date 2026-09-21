# Jev speed worklist — 2026-09-21

For the agent who owns the harness. Ordered. Every item has a file:line, a
measured number, and the metric that proves it worked.

Two framing facts first, because they decide what is worth building.

**Jev's entire ceiling is 2.0–3.2s of a 54s turn.** Judge work is 27.4% of all
model seconds (4,853 calls, avg 10,760ms in `model-route-metrics.db`), but only
~28% of it is on the user-visible path, and the watcher portion of that blocks
nothing (`host-turn-runner.ts:3408` is `void (async () => {`). What remains is
the completion judge: 402 verdicts over 843 turns (47.7%), 3.7s on grok-4.3 and
6.7s on gpt-5.6-sol. Finish Jev there and you get ~2–3s/turn. There is no
second Jev prize hiding elsewhere.

**Jev's measured net effect today is +0.23s/turn on a 54.3s turn — 0.4%.** It
has been live one day (53 calls, all 09-21). Real latency is 563ms mean / 512ms
median / 1,251ms max; the 352ms figure is roughly a 5th-percentile fixture. A
clean CLEMMY_JEV off/on A/B came back +16.7% wall, but run-to-run spread on the
same prompts is 33–36%, so that number is noise — right sign, wrong magnitude by
~40x. **Nothing on this list can be validated by the 4-shape A/B harness.** Use
the ledger queries named per item instead.

---

## 1. Fix the three Jev instruments — before anything else

Every Jev number anyone has quoted, including all of mine, is survivor-biased.
Until these land you cannot tell a tuning problem from an outage.

**(a) `src/runtime/jev/client.ts:69` — usage is recorded only inside
`if (result.ok)`.** A timeout or a 401 writes no row anywhere, so Jev's hit rate
is uncomputable and there is an invisible 1.2–1.5s tail on every reported mean.
Record the failures too, with the reason.
*Proof: a `jev` usage row exists for every attempt; failures become countable.*

**(b) `client.ts:73` → `usage-log.ts:506` — the per-site `channel` is passed and
never stored.** All 53 rows read `session_row:chat`, so call-site attribution has
to be inferred from `outputTokens`. `operational-telemetry.db` already persists
`channel` at `usage-log.ts:580`; the token-usage NDJSON does not.
*Proof: Jev rows split by site without inference.*

**(c) `judge-family.ts:208` already defines the lane taxonomy and every gate
already passes it — it never reaches durable storage,** because
`recordJudgeMetric` counts per process (a snapshot read `calls:2` after a
restart). All 1,260 judge routing rows carry the single seam `fusion_judge`.
*Proof: judge calls group by lane, which turns a 7,600s pool from unattributed
into rankable.*

These three are the difference between a Jev roadmap and another inconclusive
A/B. (a) is the most important: it is the only one that changes a number you
would act on.

## 2. Un-serialize the Jev completion attempt

`src/runtime/harness/objective-judge.ts:1054`. Proven serialized to the
millisecond: on two traced turns grok-4.3 started **27ms and 30ms** after Jev
returned — and both times rejected Jev's verdict, so the turn paid Jev's full
latency for nothing.

The correct shape already exists 40 lines away in a sibling file:
`grounding-gate.ts:742` starts the Jev call, `:749` collects it after the real
judge returns. `withJudgeHedge` is already the race primitive. **This subtracts a
serialized await; it adds no mechanism.**

Worth ~0.09s/turn on its own — small, but it makes item 3 free instead of a
trade, because a wider Jev acceptance rate stops costing latency when it loses.

*Proof: the gap between a Jev completion row and the next grok-4.3 judge row
stops being ~30ms and becomes negative (they overlap).*

## 3. Widen Jev completion acceptance — coverage is NOT the blocker

Recomputing `assessCompletionEvidenceCoverage` over all 402 recorded verdicts,
`complete` holds on **72.1%** of them. Jev served **8%**. So roughly 64
percentage points of eligible turns are being declined by a confidence threshold,
not by capability.

Find the threshold in `tryJevCompletionVerdict`
(`src/runtime/jev/control-plane.ts:217`) and say what it is, then decide it
deliberately rather than by default. Do item 2 first so a wrong Jev verdict costs
a discarded parallel call instead of serialized seconds.

*Proof: `goal_alignment_judged` by `judgeModelId` — jev's share moves off 8%
toward 72%, and the count of turns where a jev verdict is followed by a second
verdict for the same source stays flat. That second number is the safety check:
if it climbs, the threshold went too far.*

## 4. Delete the two reranks and the primer filter

**66% of Jev's calls today go to sites that provably remove zero model rounds
and are awaited before the brain speaks.**

- `src/tools/tool-search-tool.ts:1394` — `tool_searches` was **3 → 3** across
  four live runs, both arms. It reranks an already-truncated 20-row window, so it
  cannot surface an absent candidate (that is how `memory_embed_backfill` stayed
  invisible until its lane was fixed). ~910ms per firing, 39% of one traced
  tool's 1,301ms wall time with the model idle.
- `src/memory/turn-primer.ts:188` — the primer filter is 63–87% of the primer's
  403–670ms blocked segment, and 4–7x the 74–141ms retrieval it filters.
- `src/runtime/harness/loop.ts:11046` — the skill rerank has **never fired**
  (`contextPacket.skills` was 0 on 69 of 69 turns). Neither it nor the batched
  primer+skills path has ever run. Unexercised, not dead — it would fire on the
  ~8.8% of turns with 2+ ranked skills. Leave the code, but know it is unproven.

Subtracting the first two is worth ~0.31s/turn. The owner's rule is to prefer
subtracting a mechanism; these are two mechanisms with no measured effect.

*Proof: Jev call count per turn falls to ~1; `tool_searches` unchanged; primer
blocked segment falls to the retrieval time.*

## 5. The primer's hit count is captured after the Jev filter

`src/memory/turn-primer.ts` — the filter runs at :188 and
`const retrievedHitCount = result.hits.length` is at **:211**. So the counter
reports what *survived* Jev, not what recall retrieved, and `omittedHitCount` is
derived from the same post-filter number.

**A memory that recall found and Jev deleted appears in no counter, no primer
event, and no exposure ledger.** Worse, answerability then computes
`insufficient` and the primer tells the model *"Recall found little for this
ask… call memory_recall_all"* — so a bad Jev drop produces a wrong verdict, a
redundant full recall, and a log saying recall found nothing. That is
undiagnosable, on the subsystem the owner calls the differentiator.

Capture the count before the filter and record the delta. Two lines. Do this
even if item 4 removes the filter, because the same ordering bug will bite the
next thing that edits hits.

*Proof: a primer event carries both retrieved-before-filter and dropped-by-jev.*

## 6. `call_tool` still softens a guardrail escalation

`src/tools/call-tool.ts:893` — add
`if (error instanceof ToolGuardrailEscalated) throw error;` immediately after the
existing `ToolCallsLimitExceeded` line, importing from the `brackets.js` block at
:40-44 that already pulls the sibling.

`errorFunction` stringifies anything it is not told to propagate, so an
escalation becomes a retryable error string. Live 2026-09-18 turn:233895 — the
only escalation in 241,603 events — escalated 12 times over 4 minutes, then ran
90 more model calls, 2,650,221 uncached tokens and 9.4 further minutes until the
owner pressed stop. The re-entry governor does bound the lane at 200 settled
calls (`loop.ts:3902`), so this is "the backstop fires ~10x too late", not
"nothing stops it".

I fixed the `work_call` carrier the same way in `6031f7a1` via the
`propagateInvocationError` hook it already exposed. `call-tool.ts` was yours at
the time. There is a test in
`src/tools/work-call-escalation-propagates.test.ts` that asserts this gap is
still open and **retires itself** when you close it.

## 7. Bound post-rejection work, not rejection count

`MAX_HOST_OBJECTIVE_JUDGE_CONTINUATIONS = 2` bounds the number of judge
rejections, not the work inside one continuation. Six turns spent **4,455,744
uncached tokens** after a final rejection that never received another verdict.

Defensible figure for the whole class: **7.92M uncached over 3.23 days = 2.45M/day**
of spend on turns that never produced a better answer. Two caveats that cap it:
one turn is 26.9% of the cost (top 3 = 40.5%), so it is runaways not a rate; and
97% of it is on the opus side of the 09-20T19:00Z routing flip — post-flip it
measures 3.84%, so do not fund against the 21% headline.

Two changes at `host-turn-runner.ts:3940` (`:3961` in a dirty tree), both
bounding work rather than rejections:

(a) Drop the unconditional `Boolean(planCandidate) ||` bypass, which lets plan
repairs skip the budget entirely — 4 turns took 3 rejections under a budget of 2,
and plan turns are 22% of rejection turns but 31% of post-rejection cost.

(b) Gate `continuation` on convergence using the counter already maintained one
screen below at `:4062`. If a continuation has spent more business calls than the
pre-rejection attempt without reaching a new verdict, stop and deliver with the
reviewer's finding attached.

**Do not move the blocked check.** An audit claimed `:3938` is a separate
"blocked path sitting 124 lines above" the increment. It is not: `!blockedByReview`
is already a conjunct of the boolean the increment is gated on, and 25 of 25
blocked verdicts have `continuation=0`. It works.

*Proof: `goal_alignment_judged` rows with `continuation=1` and no later verdict
for the same `(session_id, sourceUserSeq)` — currently 12 of 89 across 6 turns —
go to 0.*

## 8. The trajectory reviewer's discard rate is a correctness bug

Not a latency item — it is fire-and-forget and blocks nothing. But over 3 days:
**49 reviews found drift and wrote a steer; 28 were injected.** 21 steers — 43% of
everything the reviewer actually found — were computed, paid for, and never
reached the model. Drift that was detected never got corrected.

`shouldStartWatcherCheck` (`watcher-judge.ts:101`) already guards
`injectionsUsed < maxInjections`, so the check should not even start once
injections are exhausted. Either that budget is consumed elsewhere or the drop
happens after the gate. Trace it.

Separately it costs ~1.47M uncached tokens/day and returns `on_track` with an
empty steer on 191 of 240 reviews. That half is a cadence trade, not a bug —
fewer reviews means slower drift detection. The owner should decide it, not us.

*Proof: injected / completed ratio on `guardrail_tripped kind=trajectory_review`
rises toward 1 for drift verdicts.*

## 9. Fix the meter

`loop.ts:11340` stamps ONE per-turn `promptComponents` snapshot onto every call
in the turn, including side-lane calls that never saw those tools. Fleet-wide,
components sum to **1.40x** billed input; **812 rows report a `toolSchemas` value
larger than the entire prompt**; side lanes over-attribute up to 2.94x while
claude-opus-5 under-attributes at 0.74x and produces ~8.7M of the 9.69M
"providerAndToolOverhead" residual alone.

`codex-native-runtime.ts:502` already computes per call from the body. Follow it,
and have `reconcilePromptComponents` (`usage-log.ts:240`) report an explicit
`unattributed` rather than hiding overshoot.

This produced three wrong numbers tonight, including a 25,581-token
`toolSchemas` figure inside a 25,008-token prompt, and a catalog:memory ratio I
quoted to the owner as 7x when the median is 2.99x.

*Proof: attributed/billed → 1.00 per lane; impossible rows → 0.*

---

## What I would NOT fund

**`claude-opus-5` as a Jev classification target.** Only 21 of 564 calls (3.7%)
return ≤60 output tokens — worth ~233k tokens and ~19s per day, under 1% of the
lane. The hypothesis was that opus was doing judgments; it is not, it is brain
turns. Verified and dead.

**Chasing the mid-turn cache collapse as a Jev problem.** Jev does not churn the
tool catalog — `model_request_provenance` digests are identical across arms
(`b699ec79e1`, `1cb541cd28`). Tested and refuted.

**Anything justified by the 4-shape A/B.** Run-to-run spread is 33–36% on wall
and 79–102% on uncached across four runs of identical prompts. It cannot resolve
anything smaller than ~40%. Also note the `ambiguous` shape now measures
`BARE_DEICTIC_FOLLOWUP_RE`, not Jev — 4s and 0 tokens in both arms.

---

## The thing nobody has looked at

**The brain is 12,764 calls averaging 16,323ms** in `model-route-metrics.db` —
and 58,628 input tokens per call on opus. That is where turn time actually
lives. Every item above, done perfectly, moves a 54s turn by about 3 seconds.

Two leads worth an hour before committing to anything else:

- **86% of sessions carry exactly one user message** (168 of 195), and the first
  call of every session caches exactly 512 tokens — the provider floor — despite
  a byte-identical catalog, because `PROMPT_CACHE_LAYER_ORDER` puts `turnContext`
  (3,602B) and `memoryContext` (11,914B) *ahead* of the 72,888B catalog. ~586,807
  tokens over two days. For most traffic the cold first call is the whole bill,
  and cross-turn compounding never happens.
- **The brain's own latency distribution is unexamined.** p50 vs p90 vs max
  (660,092ms!) is in `model_route_outcomes.latency_ms` joined to
  `model_route_decisions.role`. Nobody has asked what the slow tail is.

## One correction to my earlier handoff

I wrote that judge latency was not measurable because `goal_alignment_judged`
carries no `durationMs`. That is true of the eventlog and the token ledger, and
wrong as a conclusion: `model_route_outcomes.latency_ms` has it, joined to role
via `model_route_decisions`. Every latency number in this document comes from
there rather than from an estimate. I also ranked the watcher as the top
replacement target at "3–5s on the critical path" — it is fire-and-forget and
blocks nothing. It is a cost item, not a speed item.
