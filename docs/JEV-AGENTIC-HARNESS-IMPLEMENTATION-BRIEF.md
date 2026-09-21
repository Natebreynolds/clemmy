# Implementation prompt: a faster, more capable Clementine harness with Jev

## Latest live-run review — supersedes the original priority order

The initial brief used code and the measurement handoff. A subsequent read-only review inspected the actual live event database and token ledger through event 272517, including the four latest benchmark-shaped turns on September 20, 2026, 10:59–11:07 PM Pacific. No new runs were launched. These are the latest recorded turns, not an assertion that they were manually submitted by the user.

The running packaged daemon reports fingerprint `ad9b61ae6b4bba73badcc82b12b6f22e0d901bed05d5da4a3c35efe7ba12b5c5`, dirty git SHA `603630c1692397b57702875d4824841c041efe10`, and start time `2026-09-21T05:58:36.356Z`, before these four turns. Current roles are Grok 4.6 brain, GLM 4.5 Air worker, and Grok 4.3 judge. The four turns' usage records show Grok and Jev 1.13.0 calls; no GLM worker calls were observed for them.

| Source user event | Task | Event-to-terminal seconds | Recorded model calls, including Jev | Input tokens, including cached |
| --- | --- | ---: | ---: | ---: |
| 272111 | 41 times 19 | 8.292 | 2 | 6,232 |
| 272134 | Calendar tomorrow | 73.672 | 7 | 109,217 |
| 272188 | Tim in Salesforce and calendar this week | 192.614 | 17 | 475,193 |
| 272320 | “can you tidy that up for me” | 214.234 | 14 | 306,095 |

These totals come from the session-linked usage records over each turn, not billed-cost estimates. The input totals include cached tokens. Terminal delivery is not proof of correctness. This review did not independently re-query Salesforce/calendar to certify every factual claim.

### Fix these observed problems before expanding the integration

1. **The labeled no-Jev control is contaminated.** `tools/measurement/ab-runs/no-jev-baseline.json` maps its calendar task to source 271641 and its multi-step task to 271690. Their usage ledgers contain respectively two and three `jev-1.13.0` calls. Do not present this file versus `with-jev.json` as a causal Jev-off/on comparison. Enforce and record effective intervention state, inspect the call ledger, and invalidate mislabeled controls. Preserve the historical files as evidence.
2. **Completion rejection is delivered without actionable recovery.** Source 272188 reached Salesforce and calendar tools, then events 272312 and 272314 recorded `fulfills:false`, judge `jev-1.13.0`, reason “Jev found named work still missing.” The delivered answer appended “Ask me what is missing before relying on it.” Inspect the exact objective, evidence coverage, Jev verdict mapping, continuation decision, and `src/runtime/harness/delivery-committer.ts` warning branch. Determine whether this is a false rejection or an actual missing requirement before changing the judge. Recover the concrete missing work when possible; do not make the user diagnose a generic verdict. Two recorded verdict events alone do not prove two independent judge calls.
3. **Ambiguous references cause broad, expensive exploration.** Source 272320 made 25 top-level tool calls and finally asked what to tidy after 214 seconds. It searched sessions, memory, multiple Spaces, and workspace roots. The previous identical prompt, source 271824, already spent 88 seconds before clarifying. Prioritize resolving the immediate conversational referent; if absent, ask a concise clarification without sweeping unrelated work. This is a relevance/continuation improvement, not a gate on tools or a fixed cap on legitimate long work. The trajectory review at 272506 still called the run on track, so evaluate whether its progress signal actually tracks resolution of the user's ambiguity.
4. **Recovery and result addressing add avoidable work.** Source 272320 returned argument-validation errors for `session_context_read` and an unsupported `limit` on memory recall. Source 272188 event 272280 reported that a calendar call ID was reused by two invocations and could not uniquely address a result. Trace carrier repair, logical versus physical IDs, and result-handle lookup before choosing a fix. Preserve unique provenance through wrappers; do not reinterpret a result-addressing failure as an authentication failure. Eight `tool_output_query` calls occurred in that turn; inspect which were necessary versus recovery overhead.

The immediate implementation order is therefore: trustworthy benchmark labels; actionable completion review and continuation; efficient ambiguous-reference resolution; schema/result-handle recovery; then the broader memory, worker, and proactive improvements below. The latest runs do not yet establish a speed benefit from Jev. Smaller workers are configured but were not exercised by these four turns, so their efficiency benefit remains unmeasured.

Evidence locations: `/Users/nathan.reynolds/.clementine-next/state/harness.db` (`events`, keyed by the source IDs above), `/Users/nathan.reynolds/.clementine-next/state/token-usage/`, and the two existing measurement JSON files. Read them without mutating the live databases. Recheck for newer runs and coordinate current ownership before implementing.

## Mission

Extend the TypeSafe/Jev integration already being built in Clementine. Make Clem faster and more token efficient by improving tool preparation, relevant memory, worker context, recovery, and learning from verified outcomes. Preserve her ability to discover and use unfamiliar tools. Success means correct completed tasks with less elapsed time and actual cost, not merely fewer tokens in one component.

Use Jev for small, well-defined decisions supported by available evidence. Keep the generative brain responsible for reasoning and synthesis. Do not assume a structured answer or high confidence establishes truth.

This is framework work. Do not repair personal Spaces, migrate business data, modify personal integration credentials, or undertake UI changes. Two other agents are implementing Jev and UI/integration work; build on their work rather than creating a competing implementation.

## Start here: checkout, continuity, and ownership

The checkout inspected for this brief is `/Users/nathan.reynolds/clementine-next`, branch `main`. This is an observation, not an instruction to switch branches blindly. Recheck the active agents' actual checkout, branch, changes, and recent commits before editing. Preserve all unrelated edits, especially `apps/usage-sidecar` and UI work. Agree on ownership of overlapping files before changing them; work on independent areas while ownership is being resolved.

Read these first, interpreting dated observations against current code and running configuration:

- `docs/checkpoints/2026-09-19-current-framework-state.md`
- `docs/checkpoints/2026-09-19-active-configuration.md`
- `docs/checkpoints/2026-09-19-weekend-refinements.md`
- `docs/checkpoints/2026-09-19-live-acceptance.md`
- `docs/checkpoints/2026-09-20-salesforce-zero-tool-incident.md`
- `docs/checkpoints/2026-09-21-jev-measurement-handoff.md`

Inspect the existing implementation before deciding what remains. The review behind this brief observed Jev hooks for candidate ranking, memory filtering, completion review, and grounding. Write grounding was running in shadow alongside the existing judge. These may have changed by the time you start. Do not redo resolved fixes or promote shadow decisions without evidence.

### Where to work

Paths below are relative to `/Users/nathan.reynolds/clementine-next`.

| Area | Existing entry points | Ownership guidance |
| --- | --- | --- |
| Jev transport and shared decisions | `src/runtime/jev/client.ts`, `system-one.ts`, `control-plane.ts`, `connect.ts` | Coordinate with the current integration owner; reuse this layer. Do not create a second client or configuration system. |
| Tool discovery and preparation | `src/tools/tool-search-tool.ts`, `src/runtime/harness/loop.ts` | Complement existing ranking; preserve authoritative schemas and discovery reach. Coordinate changes to the main loop. |
| Task memory | `src/memory/turn-primer.ts`, `tool-choice-context-selection.ts`, `tool-choice-resolved-context.ts` | Improve selection and evidence use without deleting user memory. |
| Worker context | `src/agents/worker-job-packet.ts` | A suitable complementary ownership area: bounded packets and reliable return contracts. |
| Recovery and continuation | `src/runtime/harness/host-turn-runner.ts`, `host-no-progress-projection.ts` | Reuse existing continuation machinery; avoid another retry loop. |
| Outcome learning | `src/memory/tool-choice-store.ts`, `recall-auto-credit.ts`, `reflection.ts`, `reflection-candidates.ts` | Extend existing stores and queues; avoid parallel memory systems. |
| Proactive behavior | `src/runtime/prospective-intentions.ts`, `prospective-adapters.ts`, `prospective-sync.ts`, `src/agents/proactivity-policy.ts` | Use existing event and policy machinery; do not enable personal background work globally. |
| Completion and grounding | `src/runtime/harness/objective-judge.ts`, `grounding-gate.ts`, `output-grounding-gate.ts` | Coordinate with the Jev owner; prioritize coverage and false-positive prevention. |
| Measurements and caching | `tools/measurement/ab-harness.mjs`, `src/runtime/harness/model-wire-registry.ts`, `prompt-cache-observation.ts` | Extend existing measurements with their owner. Verify actual provider requests and usage. |

## Implementation order

Deliver bounded, reviewable phases. First identify which items are already implemented by the other agents. Complete the highest-value remaining phase, measure it, and retain it only if quality and measured performance justify it. Do not run an open-ended optimization campaign.

### 1. Establish trustworthy decisions and measurements

Before expanding Jev usage, check the current completion and grounding paths:

- Preserve the complete accepted objective and evidence needed for every required outcome. If input limits omit required material, mark coverage incomplete and use the existing review path. Never approve the whole task from a truncated subset.
- Distinguish actual execution receipts and verified results from model claims, plans, artifact pointers, or a successful send receipt. A sent message does not prove its contents are true.
- Keep `awaiting user`, `blocked`, and successful completion distinct in both behavior and metrics. Missing tool discovery is not proof that a task is blocked.
- Calibrate thresholds against labeled outcomes for each decision type. Jev confidence describes the output distribution; `0.6` does not establish 60% empirical correctness.
- Keep shadow comparison from unnecessarily extending the foreground turn. Background comparison must still have bounded lifetime, cancellation, and reliable telemetry.

Reuse the current measurement harness. Record task/source identifiers, build fingerprint, effective models, decision versions, elapsed critical-path spans, tool calls, retries, input/output tokens, cache reads/writes where exposed, and actual cost when pricing is known. Include Jev calls and worker/judge work. Report unknown usage explicitly.

### 2. Improve tool preparation without narrowing capability

Let Jev rank observed candidate IDs. Fetch full definitions from the authoritative native registry, local MCP server, Composio connection, or CLI capability source. Jev must never invent executable schemas, account identity, authorization, or tool availability.

Support multi-tool tasks. A single Choice winner is insufficient when a request needs Salesforce and a calendar. Use independent candidate scores, or separate choices for distinct task steps, with an explicit no-match outcome. On uncertain or unavailable ranking, preserve a useful existing ordering and discovery path. Avoid promoting weak candidates merely because one must win.

Prepare independent schema lookups concurrently. Cache schemas using the real tool/server/connection identity and version or refresh mechanism. Handle stale schemas by refreshing the affected definition. Preserve discovery for tools absent from memory, the initial shortlist, or the current lane; use an existing supported route or a truthful actionable explanation if a tool cannot run in that lane.

Never recreate the Salesforce incident where an uncertain conversational classification removed all tools. Ordinary read access must not depend on spelling a vendor name exactly or on Jev certainty. Preserve actual authorization and Plan-mode constraints.

### 3. Build better task memory and smaller worker packets

Assess relevance, scope, freshness, and contradiction separately. An older identity fact can remain useful while a meeting count requires a fresh read. Keep explicit user preferences, corrections, supersession rules, provenance, and cross-project isolation intact. A ranking decision must not delete memory or silently discard a required constraint.

Produce a compact task packet containing the objective, relevant constraints, necessary memory with source references, and the evidence/tool handles needed for the next step. Keep excluded material retrievable. Use deterministic selection when adequate; call Jev only where its decision can improve the result enough to justify the added work.

For workers, send only their bounded objective, relevant evidence, available tools, output contract, and applicable constraints. Default bounded extraction, classification, and lookup work to smaller configured worker models. Escalate difficult or failed work based on evidence, rather than repeatedly retrying an unsuitable small model. Keep synthesis and consequential reasoning with the appropriate brain. Never copy the full chat and entire tool catalog into every worker by default.

Parallelize genuinely independent work. Return concise results with evidence and unresolved issues; do not replace source material with unsupported summaries.

### 4. Recover from failures without repeated reasoning loops

Use observed errors to distinguish argument repair, missing discovery, stale schema, unavailable service, authentication failure, and genuinely missing user information. Prefer deterministic error handling where the source provides a reliable typed error; use Jev for ambiguous classification only.

Attach a concrete next action to recoverable failures. Refresh a stale definition, discover the missing tool, or repair the specific invalid argument. Track attempted actions and changed evidence so an unchanged failure does not trigger the same expensive attempt again. Preserve supported continuation for long tasks; local retry bounds must not become arbitrary global task limits.

Do not diagnose provider exhaustion or credentials from unrelated CLI status. Clementine owns its Claude authentication. Framework error reporting can improve without modifying the user's credentials or business integrations.

### 5. Learn from verified outcomes and become proactive

Credit memory, tool choices, and recovery strategies when downstream evidence verifies their usefulness. Scope learned preferences by task, project/account where appropriate, and tool version. Distinguish observed success from a model's opinion. Handle corrections and invalidate obsolete learned guidance. Build on the existing stores and reflection queues.

Use meaningful events to evaluate existing commitments and preferences outside the foreground chat path. Deduplicate events, respect current proactivity settings and quiet policies, and suppress notices when nothing actionable changed. Preserve user control over external writes. Do not add constant model polling or silently turn on personal monitors as part of this framework change.

## Shared Jev engineering requirements

- Batch independent questions about the same evidence state. Questions that depend on earlier answers or later tool results require a subsequent phase. Additional questions still consume tokens.
- Coalesce identical in-flight decisions and cache only when evidence, task, scope, tool/schema version, policy, model, and question version make reuse valid. Do not reuse completion approval across changed objectives, replies, or receipts.
- Propagate turn cancellation; use bounded timeouts and a circuit breaker for repeated service failures. Unavailable, malformed, or missing decisions should fall back to the established path, never become fabricated success or deny ordinary discovery.
- Validate primitive outputs and candidate IDs. Log the actual served model when available; an alias is not proof of a specific served version.
- Avoid accumulating a new serial Jev call at every hook. Measure the combined foreground overhead and eliminate decisions that do not pay for themselves.
- Verify prompt caching at the provider request boundary. Changing a telemetry ordering constant alone does not prove the wire prompt changed. Cached tokens can still cost money; schema churn can affect cache behavior. Optimize measured billed cost and elapsed time.

## Acceptance and stopping criteria

Use focused automated checks for the changed contracts, followed by a bounded installed-app hotpatch acceptance run against the live home. Isolated tests can catch regressions but are not live acceptance. Use named controlled fixtures and never run destructive fixture resets, memory wipes, or business-data cleanup against the live home.

For generative test roles, use Grok or GLM only, including workers and judges. Jev decision calls are part of the requested integration. Do not run Claude or Codex comparison tests, restart the paused 50-firm task, or launch paid research sweeps for this brief. Verify effective served models and record substitutions as deviations, not passes.

Cover the changed behavior with a small, explicit matrix:

| Scenario | Required evidence |
| --- | --- |
| Simple answer and single-tool read | Correct result without an unnecessary decision chain. |
| Salesforce wording regression, including “checking salesfroce” | Tool discovery remains reachable; identity and current facts come from appropriate evidence. Replay against a controlled fixture. |
| Multi-tool task | Both required tool families are discovered and results combined correctly. |
| Tool absent from memory | Authoritative discovery, schema loading, and execution work across applicable native/MCP/CLI/Composio adapters. Use controlled read operations. |
| Old identity plus fresh facts; corrected preference | Relevant durable knowledge survives, fresh facts are fetched, obsolete guidance does not win. |
| Worker task | Smaller packet retains necessary constraints and returns verifiable evidence without unrelated context. |
| Jev timeout, malformed output, or uncertain ranking | Established fallback completes or reports the real limitation; no false success or tool denial. |
| Incomplete/contradictory completion evidence | No premature completion, including when input coverage is truncated. |
| Repeated failure and duplicate proactive event | No unchanged retry loop or duplicate notification. |

Compare Jev off/on using identical task prompts, controlled data, effective generative models, tool access, and known memory/cache conditions. Reuse the existing baseline where valid; separate historical observations from matched measurements. Alternate a bounded number of repetitions and report variation. Do not label a one-run result a reliable p95 or subtract overlapping model durations from wall time to infer overhead.

Agree a small test budget before the benchmark, using existing session authorization and configuration. Report correctness first, then end-to-end latency, model/tool calls, total and uncached tokens, and priced cost. A reduction in one category is not automatically an overall efficiency win. Keep the existing path available when the new behavior regresses quality or adds unjustified cost.

At the stopping point, provide changed files and ownership, completed phases, exact build/hotpatch fingerprint, controlled live receipts, matched measurements and limitations, remaining work, and rollback instructions. Coordinate the clean commit/tag with the agent merging the combined work; do not stage or publish another agent's unfinished changes. Do not claim all phases are complete if only a subset was implemented.

## References

- [TypeSafe introduction](https://docs.typesafe.ai/introduction)
- [Choice primitive](https://docs.typesafe.ai/primitives/choice)
- [Score primitive](https://docs.typesafe.ai/primitives/score)
- [Confidence semantics](https://docs.typesafe.ai/confidence)
- [TypeSafe patterns](https://docs.typesafe.ai/patterns)
- [xAI prompt caching usage and pricing](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing)
- [xAI prompt caching practices](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices)
