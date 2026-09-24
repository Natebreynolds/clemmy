# Together Flash pilot and repair diagnostics — 2026-09-23

## Verified

User selected a faster Together model. Normal active-brain API selected
`zai-org/GLM-5.3-Flash` globally and for the existing controlled pilot session.
Installed candidate remains 6fdc2703d; no new hotpatch or tag was performed.
Actual usage confirms Flash, Jev and Grok; no Claude/Codex generative testing.

Original accepted source 292990, terminal 293095, attempt
`attempt:desktop:b67d3cb11316391c284e42769147ba7c92d96eda` failed after
177855 ms: Together returned HTTP 402 Credit limit exceeded. Do not automatically
retry or switch providers. This is an observed billing response, not a diagnosis
of subscription exhaustion. The model remains selected as requested.

The exact original proposal was preserved. Flash read its durable state, found
the documentation capability, refreshed acquisition, read the Space, requested
the pilot twice and recalled two historical receipts. Both pilot requests were
refused before approval/dispatch with the same opaque contract mismatch message.
No pilot approval was created by these requests. No source-data pilot ran.

Canonical measurement: 8 top-level tool calls, 18 usage rows, 340822 input tokens,
189696 cached, 151126 uncached, 14974 output; exact attribution certified.
These are failed-work totals, not a speed win. GLM-5.2 source 292863 instead
blocked after 26963 ms, one tool call, 183981 input/76096 cached/3504 output;
the two failed runs do not establish comparative completion performance.

## Framework candidate

The workflow bridge previously collapsed field, identity, outcome-authority,
merge, evidence and bounds mismatches into one generic error. It now preserves
every admission predicate while reporting each failed comparison and its
approved expected value. In this live request, raw `/content` evidence did not
include the projected `records` path and approved prefer-newer fields were absent.
Precise diagnostics let the model repair one input without rediscovering tools
or changing the user's proposal. No provider/model-specific decision was added.

A regression in the original 13-record-to-five-record pilot fixture supplies
both live mismatch classes, requires precise errors, proves no dispatch, then
submits the valid contract and retains the existing execution/replay assertions.
It failed against the old message; both focused files passed (35 checks). Typecheck also passed.
Evidence is under output/harness-acceptance/2026-09-23-pilot-flash/.

## Still owed

Review, candidate build, coordinated Terminal hotpatch and
live acceptance of this diagnostic candidate. Together billing availability is
required before another Together generative run. Output-limit speculation for
GLM-5.2 remains unproven: preserved receipts do not expose finish_reason.
Do not raise caps based only on repeated 998-token outputs.

The full section 6 release scope remains open, including phone approval/restart,
pilot approval/execution/Space rendering and separately approved recurrence,
crash/write canaries, quota review, latency walls, trajectory decision, unfamiliar
tool acceptance, full idle suite and installer/mobile verification. Not tag-ready.
