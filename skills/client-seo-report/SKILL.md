---
name: client-seo-report
description: "Pull a client's (or all clients') organic SEO performance and deliver a trustworthy read-only report: what's working, what isn't, and recommended next steps. Actions: pull, report, summarize, analyze, review, audit, recommend, brief, digest, check. Subjects: client SEO, organic traffic, rankings, ranking keywords, keyword positions, backlinks, referring domains, domain authority, traffic estimate, search visibility, competitors, weekly/monthly SEO report, agency client reporting, marketing performance. Data via DataForSEO (organic traffic/keywords/backlinks) and the CRM/Salesforce for the client list. Read-only: analysis and recommendations only — never sends, publishes, or mutates client data. Use when asked to report on or summarize one client's or every client's SEO/marketing performance."
---
# Client SEO Report (read-only)

Produce a trustworthy, decision-ready SEO performance report for one client or
across all clients. The whole point of this skill is **trust**: every number is
real, nothing is mutated, and a gap in the data is reported honestly rather than
filled with a guess. The harness enforces these as gates (numeric/output
grounding + goal-fidelity); this skill is the procedure that earns a clean pass.

## Defining requirement (do not skip — this is what makes the report trustworthy)

1. **Read-only.** This job analyzes and recommends. It NEVER sends an email,
   publishes, updates a CRM record, or mutates client data. If the user wants the
   report delivered somewhere, draft it and confirm the destination first — the
   send is a separate, explicitly-approved step, not part of this skill.
2. **Every figure must trace to a tool result from THIS run.** Each number in the
   report — traffic, keyword counts, positions, spend, backlinks, % changes — must
   come from a tool you actually called this session. Do NOT estimate from memory,
   round a half-remembered figure, or carry a number across clients. If you state
   "$24.5K spend" or "up 18%", the underlying tool output must support it
   (verbatim, or by an obvious rounding/aggregation you can point to).
3. **Honest partial on a data gap.** If a source hard-fails for a client (e.g.
   DataForSEO errors for a domain), SAY SO for that client — "no ranking data
   retrieved; nothing fabricated" — and keep going for the others. Never invent a
   number to make a row look complete. A partial report reported honestly is
   correct; a complete-looking report with one fabricated figure is a failure.
4. **Discover the client list at runtime.** When asked for "all clients", pull the
   list from the CRM/Salesforce at run time. Never hardcode a client roster.

## Procedure

### 1. Resolve scope
- One client → confirm the domain. All clients → query the CRM/Salesforce for the
  active client accounts + their websites (`sf data query …` or the CRM tool).
- Decide the window (default: last full month; "last week" if asked).

### 2. Pull the data (read-only)
For each client/domain, pull from DataForSEO (or the connected SEO source):
- organic traffic estimate over the window,
- ranking-keywords count + average position,
- top movers (keywords gained/lost) if available,
- backlinks summary (referring domains, total backlinks, spam score) if asked.
Prefer the proven live endpoints already in procedural memory; do not reach for a
`*_TASK_POST` (async, returns a task id, not data) when you need live metrics.

**Multiple clients = fan out, don't serialize.** For 3+ clients, delegate one
`run_worker` per client in waves of up to 8 (each worker: discover → pull →
summarize for its one client), then aggregate. For very large rosters (N>50),
author a workflow with `forEach` so per-client progress survives a restart. Never
loop all clients serially in your own context — their raw tool outputs will pile
up and you'll end up enriching from clipped stubs.

### 3. Synthesize per client
- **What's working:** the metrics that improved + the likely driver, each tied to
  a figure from step 2.
- **What isn't:** declines / weak spots, each tied to a figure.
- **Recommendations:** concrete, prioritized next steps (content, technical,
  backlinks). Recommend; do not execute — applying a change is a separate approved
  task.
- Mark any client whose data failed as a clear "no data this run" row.

### 4. Deliver
- A tight per-client section (working / not working / recommendations) plus a
  one-line portfolio roll-up.
- Keep it scannable. If delivering to chat, lead with the roll-up.
- State the data window and source. If any figure couldn't be verified against the
  pull, flag it rather than presenting it as fact.

## Done when
Every in-scope client has either a grounded summary (every figure traceable to a
tool result) or an honest "no data this run" note — and zero client data was
mutated.
