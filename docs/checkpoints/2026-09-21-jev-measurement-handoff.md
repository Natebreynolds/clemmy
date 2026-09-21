# Jev measurement handoff — 2026-09-21

For the agent wiring Jev. Four things to fold into the next live pass, a control
run you can diff against, and one fix I'd do before spending another fixture.

Everything below is measured on the installed app against `~/.clementine-next`,
not inferred. Where I'm inferring, I say so.

---

## 1. You have no Jev-OFF control. Here is one.

`28.6s` wall and `352ms` completion are Jev-ON absolute numbers. Without a
control they can't answer "is this faster", only "this is how long it took".

Committed at `tools/measurement/ab-harness.mjs`, with a captured baseline at
`tools/measurement/ab-runs/no-jev-baseline.json`:

```
node tools/measurement/ab-harness.mjs capture with-jev
node tools/measurement/ab-harness.mjs compare no-jev-baseline with-jev
```

It refuses to compare runs whose shape sets differ, so the numbers can't quietly
drift into being incomparable.

The baseline, captured 2026-09-21 ~05:1x on the installed app with no Jev key in
the vault or `.env`:

| shape | wall | uncached | tool_search rounds | terminal |
|---|---|---|---|---|
| zero-tool (`what is 41 times 19`) | 8.2s | 5,528 | 0 | done |
| one-read (`what is on my calendar tomorrow`) | 57.8s | 67,588 | 1 | done |
| multi-step (salesforce + calendar) | 194.8s | 249,442 | 2 | done |
| ambiguous (`can you tidy that up for me`) | 88.4s | 118,840 | 0 | needs_input |

Totals: **wall 349.2s · model 344.5s · tool 12.3s · gap 4.4s · uncached 441,398 ·
cached 421,952 · output 3,744 · 36 model calls · 4/4 terminals.**

## 2. The single number that should shape every Jev decision

**98.7% of wall clock is model time.** Tool dispatch is 12.3s (3.5%). Total
harness gap across four turns is **4.4 seconds**.

There is no plumbing left to optimise and there is no dead time for an added
round trip to hide in. Concretely:

- Jev **replacing** a model call is a pure win.
- Jev **added** alongside one is pure latency, at full price.

That is why the completion-judge skip is the right first placement and why the
~910ms `tool_search` rank is correctly named a tax. It also means a Jev call
placed anywhere new needs to delete a model call to break even.

Corollary worth keeping: 863k input for 3,744 output across four turns is a
**230:1 input:output ratio**. Clem reads enormously and says very little. That
ratio, not latency, is where spend lives.

## 3. Size the completion-judge prize correctly: it's latency, not tokens

Verified from the event log — completion judge model over the last 40 verdicts:

```
grok-4.3        36
jev-1.13.0       1   (your proven skip)
(unrecorded)     3
```

And from the usage ledger, last 3 days, chat lane:

| model | calls | input | avg s |
|---|---|---|---|
| `claude-opus-5` | 564 | **33.1M** | 11.0 |
| `gpt-5.6-terra` | 654 | 14.1M | 0.0 |
| `grok-4.6` | 236 | 9.9M | 19.6 |
| `gpt-5.6-sol` | 675 | 7.4M | 0.0 |
| `grok-4.3` | 292 | 2.4M | 4.6 |

So the judge you're skipping is **2.4M of 67M chat input — 3.6% of spend**.
Skipping it buys roughly **4.3s per turn** and very little money. Worth doing;
just don't expect the token curve to move.

If you want Jev's token prize, it's `claude-opus-5`: **58,630 input tokens per
call, 564 calls, 11s average**. I have not established what share of those are
judgments rather than generation — that's the next thing worth knowing, and it
decides whether Jev is a latency story or an economics story.

**Meter gap that blocks this:** `gpt-5.6-sol` and `gpt-5.6-terra` report
**avg 0.0s across 1,329 calls** — 21.5M input tokens with no latency recorded.
Either they're genuinely sub-100ms or `durationMs` isn't captured on that lane.
Same class as `prompt_composition`'s `toolCount: 0`. You cannot A/B Jev against
a lane that doesn't report its own time.

## 4. Your fixture #1 may measure nothing

A short no-tool question short-circuits: my zero-tool shape came back
`shortCircuit=direct_reply`, `maxTools=0`, 8.2s. Worth confirming the completion
judge even *runs* on a short-circuited turn before spending a fixture on it —
otherwise it measures the skip of something that wasn't executing.

Fixtures 2 (remember + recall) and 3 (numeric reply for output-grounding) both
look well chosen and I'd keep them as-is.

## 5. On ranking: measure rounds, not milliseconds

The 910ms is the visible cost, but the decisive question is whether better
ranking removes a `tool_search` **round**. The baseline records rounds per shape
(0 / 1 / 2 / 0). If Jev ranking takes multi-step from 2 to 1, that deletes an
entire model call — tens of thousands of input tokens and several seconds, which
pays for 910ms many times over. If rounds stay flat, the 910ms is pure loss.

The harness already captures `toolSearches`, so this needs no new
instrumentation.

---

## The one thing I'd fix before another measurement pass

`src/runtime/harness/grounding-gate.ts` (~line 743), current working tree:

```ts
try {
  if (judgeOverride) {
    verdict = await judgeOverride(payload, sources);
  } else {
    const { tryJevGroundingVerdict } = await import('../jev/control-plane.js');
    const jevVerdict = await tryJevGroundingVerdict(payload, sources, { sessionId });
    verdict = jevVerdict ?? await runGroundingJudge(payload, sources);
  }
} catch {
  return { action: 'allow', reason: 'grounding judge unavailable — fail open', ... };
}
```

The Jev call **and its dynamic import** sit inside a catch that returns `allow`
on an irreversible external write. Previously that try held only
`runGroundingJudge`, so fail-open meant "the judge itself was unavailable" — a
deliberate choice. Now a Jev throw, or a failed dynamic import in a packaged
build, opens the gate while `runGroundingJudge` was available and never ran.

This reads as an oversight rather than a decision, because **your own other two
sites already do it right**: `objective-judge.ts` wraps the Jev call in its own
try/catch (*"configured judge remains the backstop"*), and
`output-grounding-gate.ts` falls into a deliberately fail-closed catch. This one
diverged.

Suggested shape — Jev failure falls back to the real judge, not to `allow`:

```ts
let jevVerdict: GroundingVerdict | null = null;
if (!judgeOverride) {
  try {
    const { tryJevGroundingVerdict } = await import('../jev/control-plane.js');
    jevVerdict = await tryJevGroundingVerdict(payload, sources, { sessionId });
  } catch { /* the configured judge remains the backstop */ }
}
try {
  verdict = judgeOverride
    ? await judgeOverride(payload, sources)
    : jevVerdict ?? await runGroundingJudge(payload, sources);
} catch {
  return { action: 'allow', reason: 'grounding judge unavailable — fail open', ... };
}
```

I did not apply it — you have that file dirty and I'm not editing on top of
in-progress work.

### Related, same gate

Jev's grounding criteria drop two rules the real prompt carries:

- *a SUCCESS: send-confirmation proves a send happened, not that its content was correct*
- *two sources contradicting each other = not grounded*

Both were written after the live double-sent wrong-city email. A faster judge
with fewer rules is not the same judge. Jev also sees source excerpts truncated
to 2,000 chars where `rankSources` supplies 5,000.

### Why I'd sequence the fix before the fixtures

Everywhere else a wrong Jev verdict costs a slower path or a worse answer. Here
it costs an outbound write that shouldn't have gone. Measuring how often the
gate skips the real judge, while the skip path can fail open, validates the
wrong thing first.

**Shadow mode is the thing I'd actually argue for on this gate specifically:**
run Jev alongside `runGroundingJudge`, keep the existing judge authoritative,
log both verdicts. Agreement rate then gets measured on real traffic at zero
risk, and Jev gets promoted to authoritative with evidence rather than with
hope. `fastDecisions` tells you how often Jev fires; it does not tell you how
often it was right.

---

## Smaller items from a review pass over the JEV work

Not blockers. Listed because they're cheap now and annoying later.

- **Disconnect is a silent no-op for a `.env` key** (`src/runtime/jev/connect.ts:43`)
  — the path `.env.example` now advertises. Owner clicks Disconnect, gets
  `configured:true`, UI keeps saying Connected, data keeps flowing. No typed
  failure and no next edge.
- **`keySource` reports `'vault'` for an env-only key** (`client.ts:41`), because
  it's computed from `readSecret`, which already includes the env backend. The
  `getRuntimeEnv` fallback beneath it is unreachable.
- **`TYPESAFE_API_KEY` is the one credential `scripts/run-tests-isolated.mjs`
  doesn't strip** (~line 49) — so `npm test` can make live vendor calls on the
  owner's key. Brushes the never-bill-user-keys rule.
- **Consent copy** says "Stored locally on this machine", which is true of the
  key and silent about the payloads: up to 6KB per gated send plus 24KB of
  session sources, and up to 24 memory snippets plus raw query text per turn.
  This is a data-residency change, not a ranking tweak.
- **Model name in user-visible copy** — the `CLEMMY_JEV` dev-flag row mentions
  "Sol", and `gpt-5.6-sol` is a real model id (`src/config.ts:382`). Breaks the
  no-model-names-in-product-code rule. The row also sits physically inside the
  `── Memory ──` section while carrying `category: 'Tools & efficiency'`.
- **`console-jev.test.ts` and `JevConnectForm.test.ts` are `readFileSync` + regex
  source assertions.** They'd stay green if `if (!isAuthorized(req))` were
  dropped from the POST handler, or if the stored key were added to a
  `JevStatus` response for a debug panel. `system-one.test.ts` and
  `connect.test.ts` are genuinely behavioural and good — worth bringing the
  other two up to that bar.
- **`jev-latest` is a moving vendor alias** (`system-one.ts:10`) on the
  write-boundary decider. When the vendor rolls it forward, verdicts shift with
  nothing pinned in source to roll back to.
- **No breaker.** Timeouts and typed errors are right; there's no retry bound or
  circuit breaker, so a slow-but-up vendor costs its full timeout every turn
  indefinitely before the fallbacks run.

## Credit where it's due

The secret plumbing is release-ready and I checked rather than assumed: no
`logger` / `console` / `appendEvent` / `res.json` on any non-test path in
`src/runtime/jev/`; the value appears in exactly one outbound place (the Bearer
header at `system-one.ts:196-198`); status reads return existence only; errors
are built from status/reason; and the console POSTs it in a body rather than a
URL, so the known proxy-logs-leak-the-token trap doesn't apply.

`connectJevKey` probing before persisting, and saving through on an unknown
network error, is the right call in both directions.

Adding `fast?: boolean` and `fastDecisions` to `judge-family.ts` *while* wiring
the prefilter rather than after is the reason any of this is measurable. That's
the habit that makes the rest of this handoff possible.

---

## One unrelated fix I landed in your area

`d932dd4e` — `memory_embed_backfill` carried `lanes: ['cli']`, so it was absent
from the orchestrator catalog chat searches. Asked live to run it, Clem spent
**301s and 70 tool calls** walking the filesystem (`list_files`, `read_file`,
`local_cli_probe`) and never reached a terminal. Added `'orchestrator'`; it's a
safer write than `memory_forget` (a soft-delete) already on that lane.

Your `6778d1b6` couldn't have fixed this — a reranker cannot surface a candidate
that was never in the catalog.

**The general case is still open and belongs to whoever owns `tool_search`:** a
capability that EXISTS but is not in the current lane should say so with a next
edge, rather than leaving the model to improvise. An absent capability doesn't
refuse — it flails, and that's a dead end with a long tail.
