# Read-lane live canary plan (v3.8.0 — REQUIRES EXPLICIT APPROVAL)

Status: PROPOSED. Nothing here is authorized by the v3.8.0 implementation
prompt. No live connected read runs until Nathan/Codex approve this plan
verbatim or amended.

## What is already proven without live runs

The deterministic shim matrix (`src/runtime/read-path/read-lane.test.ts`)
proves the STRUCTURAL warm gate for three unrelated operations on both brain
shims:

```text
procedure_resolution = hit
schema_discovery_calls = 0
tool_discovery_calls = 0
provider_dispatches = 1
validation_repairs = 0
public_terminals = 1
external_write_or_send_dispatches = 0
```

plus restart/compaction/brain-switch identity, schema-drift quarantine with
cold fallback, scope isolation, account reconnect, slot questioning without
poisoning, transient-failure tolerance, and concurrent-promotion atomicity.

What deterministic shims CANNOT certify: wall-clock latency percentiles and
live uncached-token deltas. Those claims stay uncertified until the canary
below runs — no percentile from anecdotes, per the C2 certification rule
(missing spans/cohorts = uncertifiable, never silently improved).

## The measured targets (from the release prompt)

- warm connected-read p50 ≤ 12 s under a healthy provider;
- warm uncached input ≥ 50% below the comparable cold/legacy fixture;
- ≥ 30 successful attempted samples per declared p50/p90 cohort;
- no p95 claim without 100 attempted samples;
- timeouts and provider failures stay in attempted/error-rate reporting —
  never dropped to improve a percentile.

## Canary protocol (opt-in, read-only, Nathan present)

1. Environment: Nathan's daemon, one connected account per carrier family,
   `CLEMENTINE_HOME` untouched (reads only; the lane cannot dispatch a write
   or send by construction — sealing refuses the capability class).
2. Operations: three real read operations in different carrier families,
   chosen at canary time (the mechanism is generic; the fixtures in the shim
   matrix are NOT the required operations).
3. Cohorts, per operation, per brain (Claude and Codex):
   - COLD cohort: 30 attempted paraphrased runs with the procedure store
     empty for the logical key (reset between samples via a scratch
     CLEMENTINE_HOME per sample, never the live home);
   - WARM cohort: 30 attempted paraphrased runs against the promoted
     artifact.
4. Every sample records: the trace envelope, the C2 spans
   (`capability_resolution`, `discovery` where cold, `tool_provider`,
   `verification`, `terminal_commit`), the C1 canonical token accounting
   (adapter-declared dialects), the structural counters, and
   success/timeout/error class. A sample missing a required span is counted
   attempted and marked uncertifiable.
5. Report: per cohort — attempted, succeeded, errored, timed out, p50, p90
   (p95 only if a 100-sample extension is separately approved), certified
   sample count, warm-vs-cold uncached-input delta from canonical
   accounting.
6. Abort conditions: any external write/send dispatch observed (impossible
   by construction — treat as a P0 and stop), provider health degradation,
   or Nathan's call.

## What the canary explicitly does NOT do

- No tag, push, deploy, daemon swap, or Platform 49 change.
- No writes or sends of any kind, including "harmless" test events.
- No production activation of the durable graph executor (unrelated lane).
