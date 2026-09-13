# Harness, multi-model, and graph engineering — findings for the next agent

Date: 2026-09-10 (live stores re-read 2026-09-11 UTC)
Audience: the next implementation / qualification agent. Read this once. Do not treat older graph-in-front-of-chat roadmaps as the next step.
Author: research pass over source, tests, direction docs, and the owner's live home. Not a release authorization. Not a tag go.

Recorded identities at write time (re-check; they drift):

| Item | Value |
| --- | --- |
| Checkout | `/Users/nathan.reynolds/clementine-next` |
| Branch | `wave/boot-resilience-and-footprint` |
| HEAD when this file was written | `8a7c68e3` — re-run `git rev-parse --short HEAD` |
| Live daemon | Packaged `/Applications/Clementine.app`, PID observed `28421`, port `8520`, home `~/.clementine-next` |
| Live stores | `~/.clementine-next/state/harness.db` (~1.3 GB), `state/model-route-metrics.db` |
| Related direction (still in force where this file is silent) | [GRAPH-DRIVER-SUBTRACTION-BRIEF-2026-09-04.md](../GRAPH-DRIVER-SUBTRACTION-BRIEF-2026-09-04.md), [BEAT-THE-HARNESSES-DIRECTION-2026-09-04.md](../BEAT-THE-HARNESSES-DIRECTION-2026-09-04.md) |

**How to use this.** Execute the ordered work in §8. Re-measure with §10 before claiming a win. Do not start a graph rewrite, a fourth model role, or a new admission token.

---

## 0. Thesis

The harness today is a **strong effect kernel wrapped in a still-too-expensive control plane**.

- Multi-model is real and used (brain / worker / judge). Do not add a fourth role.
- Intelligence is gated more by **serial discovery round-trips** than by which flagship sits on the composer.
- Accuracy is excellent **after** an external write is admitted, and still uneven **before** the model finds the right call.
- A graph executor now exists. Chat uses it as a **spine wrapper** around the same mega-loop. A graph is justified when work must **outlive the turn**. It is not an entrance exam for ordinary chat writes.

Clem already beats DeepSeek / Hermes / bb at: physical-crossing CAS, never-blind retry of uncertain writes, in-place carrier repair, result handles, exact source/account/schema on a crossing, durable workflow resume.

Clem still loses to them at: finishing an ordinary write without a discovery maze; asking without exiting the turn; publishing first tokens instead of waiting for a full step.

---

## 1. Graph engineering — as it actually is

Two owner-approved documents disagree if you read them as current orders. The later one wins for chat.

| Document | Date | Claim |
| --- | --- | --- |
| [CLEMENTINE-4-GRAPH-RUNTIME.md](../CLEMENTINE-4-GRAPH-RUNTIME.md) | 2026-08-01 | Every accepted chat turn compiles a provider-neutral graph; runtime (not prose) owns routing; `read_parallel_v1` workflow pilot |
| [CLEMENTINE-4-EXECUTION-PLAN.md](../CLEMENTINE-4-EXECUTION-PLAN.md) | 2026-08-03 | **No graph executor existed**; chat graph was observe-and-discard; extract one walker |
| [GRAPH-DRIVER-SUBTRACTION-BRIEF](../GRAPH-DRIVER-SUBTRACTION-BRIEF-2026-09-04.md) | 2026-09-04 | Chat path is DeepSeek/bb/Hermes (claim → model → pre-execute allow\|deny\|ask → execute → append). A graph is a **projection** of work that outlives the turn. Do not grow `graph-neutral` into a second expected-work compiler |

**Measured 2026-09-10:**

| Piece | LOC (approx) | Production role |
| --- | --- | --- |
| `src/runtime/graph/graph-executor.ts` | 796 | **Exists.** `runGraph` is the walker. Does not know node kinds; runners are injected. Failure is an edge. |
| `src/runtime/graph/chat-turn-spine.ts` | 374 | `driveChatTurnSpine` is called from `loop.ts` (~6151 fresh, ~12695 resume). |
| `src/runtime/graph/turn-graph-compiler.ts` | 1104 | Compiles turn IR. Fail-open on compilation: uncompilable turns run legacy order. |
| `src/runtime/graph/` (all) | ~18k including tests | Contracts, admission, resume, journal, artifacts |
| `src/runtime/harness/loop.ts` | 15,728 | Still the real chat engine. Spine comment: provider core remains **one interim node** (`compose_reply` hosts `runConversationCore` / host runner). |
| `src/runtime/harness/host-turn-runner.ts` | 9,557 | Real model↔tool loop |
| `src/execution/workflow-runner.ts` | 16,305 | Still the workflow engine; **does** call `runGraph` (~10645) for executable topology |
| Distinct `CLEMMY_*` keys in non-test `src`+`packages` | **383** | Against the old target of one `RuntimeBudget` |

So: the missing walker from August **was written**. Chat **does** walk context → capability → compose_reply → publish. The work inside `compose_reply` is still the host mega-loop. Workflows that outlive a turn are the legitimate graph. Ordinary “five drafts / read then write” does **not** earn a compiled DAG as a license to mutate.

**Do not:**

- Put a graph compiler in front of every chat message as a consent subject
- Add a third admission token or a second expected-work compiler (`graph-neutral` projector)
- Enumerate node kinds inside `graph-executor.ts` (that file’s charter: new capability = new runner, never a new branch here)
- Treat shadow `recordTurnGraphShadow` call sites as execution authority (many still observation / tests)
- Start V31 or revive `host_owned_single_action_plan` / `configured_plan_task_missing`

**Do:** keep graph for saved workflows, recurrence, restart-at-an-item, fan-out that must resume. Keep chat as one loop with allow\|deny\|ask on the existing consent reducer (`interactive-consent-policy.ts`).

---

## 2. Multi-model architecture

Three roles, one resolver: `src/runtime/harness/model-roles.ts` `resolveRoleModel(role, intent?)`.

Precedence: durable `CLEMMY_MODEL_ROLES` binding (intent slug, then role-wide) → session brain pin (`CLEMMY_SESSION_BRAIN_PIN`, default on) → learned route policy (hot path **off** by default) → provider-derived default.

Wire: `RouterModelProvider` (`router-model.ts`) — `claude-*` → Claude OAuth, `gpt-5*`/`o*` → Codex, else BYO. `MODEL_ROUTING_MODE=all_in` collapses undeclared ids onto BYO.

Fresh turns: `CLEMMY_TURN_ENGINE` default `host_v1`. `legacy_sdk` is resume-only. Interactive Claude Agent SDK brain is retired as a production execution owner (test override remains). Claude **workers** may still use the Agent SDK (`CLEMMY_CLAUDE_AGENT_SDK_WORKER`).

Composer Act/Plan is **not** a second engine. `taskMode.kind` `normal` | `plan` | `execute`. Plan is read-only + `publish_plan`; Execute rewrites to the accepted plan text.

### Live last 7 days — brain routes (`turn_model_routed`)

Claude 240, Codex 142, BYO 54. Models served: `claude-sonnet-5`, `gpt-5.6-terra`, `claude-opus-5`, `grok-4.6`, `glm-5.2`. Transport: `host_harness`. Fallover **does fire**: Codex→BYO rate limit, Claude→Codex auth expiry, BYO→Codex empty completion.

### Live last 7 days — workers (`worker_model_routed`)

1,600 / 1,652 were `grok-4.6` from **settings**. Fleet: orchestrator on Sonnet/Terra/Opus, grunt on Grok. That is correct **if** the packet is the job. It is not always: `src/agents/worker-packet-lane-parity.red.test.ts` is still **red** (live 2026-08-11: workers quit with zero calls because the orchestrator inline lane forwarded the packet blind).

### Live metrics — `state/model-route-metrics.db`

Successful brain latency (avg / max):

| Model | n | avg ms | max ms | policy score |
| --- | --- | --- | --- | --- |
| `gpt-5.6-terra` | 1860 | **6,769** | 131,680 | 0.82 |
| `claude-sonnet-5` | 2577 | 10,571 | 145,471 | 0.78 |
| `claude-opus-5` | 791 | 12,407 | 123,959 | 0.79 |
| `glm-5.3` | 580 | 14,319 | 406,893 | 0.81 |
| `grok-4.6` as **brain** | 738 | **33,551** | **660,092** | 0.77 |
| `glm-5.2` as brain | 613 | 37,267 | 558,118 | 0.77 |
| `gpt-5.4` | 171 success / **74 failed** | — | — | **0.18 below_floor** |
| `gpt-5.6-sol` | mixed | — | — | **0.54 below_floor** |

Judge: Terra 3.7s (best). Opus-5 6.4s. Grok 21s. GLM-5.2 23s. **Haiku-4-5 46s avg, max 163s** — do not use as the cheap default judge.

Grok as **worker**: 12.4s avg. Seat it there, not on the composer.

`objective_met` is **never recorded** (`obj_n = 0` on every outcome). Route policy therefore cannot score “did the job succeed.” `CLEMMY_ROUTE_POLICY` hot-path default is **off**. 8,517 brain decisions are `source=explicit`. Policy version 2344 is observe-only.

Session pin exists because concurrent sessions used to steal each other’s brain (2026-08-26). `codexSafePrimary` exists because `OPENAI_MODEL_PRIMARY=glm-5.2` used to run “Codex” on GLM (2026-06-29). Keep both.

`CLEMMY_BRAIN_FALLOVER` must default **on** for runtime lanes (`brain-fallover-default.test.ts`). Boot-time `CLEMMY_AUTH_FALLOVER` must stay **off**.

---

## 3. Latency

Host compute is ~2% of wall clock. A measured 221s resume (2026-09-04 P2) was 90.5% brain, 8% tools, 2% host. **11 of 17 steps were `tool_search` = 137s (62%).**

Sept 8 live Act turns (`docs/checkpoints/2026-09-08-harness-latency.md`): clean native read 22.5s / 3 brain / 3 tools; unused discovery search 13.3s and +12k tokens on a 44.5s local edit; social first-use miss 26s / 6 brain / 8 calls / 0 metrics, then 20.2s after discovery enumerated connected MCP.

**Amplifiers, in order:**

1. **Serial `tool_search` / discovery.** Each miss is a full model step (6–40s). Connected tools sitting in `tools/list` have been missed by natural-language search.
2. **No public tokens until the step finishes.** `host-turn-runner.ts` sets `stream: true` for stall/activity only. `codex-one-step.ts` drains until `response_done`. UI sees activity rows, not first tokens. Interactive pre-actionable stall is **off**.
3. **Extra model calls:** completion judge (default on for chat; Opus ~6s, sometimes 20s+), account reviews, compaction Layer 2, optional watcher. Judge continuations used to reset on recovery.
4. **Cache-busting tool arrays.** Recovery that shrinks tools to “the thing just refused” kills Anthropic prefix cache. Sonnet caches ~15k of 34k input; Terra only ~4k of 18k.
5. **Silence walls.** Stream stall 600s (`CLEMMY_MODEL_STREAM_STALL_MS`), first-byte 300s, response wall 900s. Documented live hangs 630s and 662s. Unlimited budget has **no wall clock**. UI “no update in Nd” is **8 hours**.
6. **Fan-out.** Parent `run_worker` waits; session semaphore 6, global 12, BYO 3/6. `run_worker` tool timeout 5 min.

Compaction is working: 85 times in 7 days, always L1+L2+L3, p50 51,532 → 20,913 tokens, budget p50 128k (BYO-window honest). Over-clipping caused 44× `recall_tool_result` (2026-08-05).

`restart_recovery_decision` 17,950 vs `turn_started` 1,267 in 7 days — polling tax, not 14 real recoveries per turn.

Default budget preset is **unlimited** (`budget-settings.ts`): no wall clock, 500 orchestrator turns, auto-continue cap 200.

---

## 4. Accuracy

**Once a write is admitted, the kernel is honest.** Last 7 days: 66 `external_write`, 65 succeeded, 1 failed, 0 orphaned. Carrier repair 237. Physical-crossing CAS and never-blind retry are load-bearing — do not weaken them.

**Getting to the write is where runs die.** `conversation_completed` last 7 days (n=497):

| Outcome | Count |
| --- | --- |
| success + delivered | 320 (64%) |
| blocked | 79 |
| awaiting_user_input | 25 |
| verification_required | 23 |
| success but **not** delivered | 12 |
| failed | 11 |
| cancelled | 10 |
| other | 17 |

**58 of 79 blocks are `control_no_progress_exhausted`.** Same class as the 2026-09-04 audit (D2). Partial progress since then: `retriesRemaining=3` now appears 1,386 times (Sept 4 measured it stuck at 0). `last_word_turn` still exists (21). Guardrail actions: 1,843 continue, 43 terminalize. No-progress events 1,886.

Vs Sept 4 scoreboard (2/30 write tasks, 6.7%): ordinary completed work is healthier. The remaining accuracy problem is not “she lies about sends.” It is “she cannot find the operation, burns the governor, dead end.”

**Still in source (not hypothetical):**

| Failure | Where | Pin |
| --- | --- | --- |
| Narration detector blind after any real tool | `claude-agent-brain.ts` `looksLikeToolNarration`: `if (toolUses.length > 0) return false` | Mixed `memory_search` + fake `Tool: composio_execute_tool` ships |
| Lean rubric is production | 527/527 `rubric_variant` events `lean` | `DONE-STATE SELF-AUDIT` / resource fingerprint live only in 31k rollback head (`clem-rubric.ts`) |
| Completion judge fails open to `done:true` | `objective-judge.ts` ~60–67 | Tagged `failedOpen`, still user-visible Done. 37 Opus judge failures in metrics |
| Plan-first is two regexes + `MODELS.fast` + no Composio | `plan-first.ts`, `planner.ts` | Fresh batch work stays conversational by test |
| Plan mode allows 3 third-party reads before `publish_plan` | `plan-first-contract.ts` `PLAN_SCOPING_READ_ALLOWANCE = 3` | 2026-09-10 Firecrawl-instead-of-plan session |
| Two call grammars | Claude: `tool_search` → `call_tool(name, args_json)`; Codex lean: `work_call` | Frozen argument digest ≠ executed bytes (`call-tool-refined-local-settlement.test.ts`) |
| Worker packet lane split | `worker-packet-lane-parity.red.test.ts` | Still red |

Sept 7 live retained failures (do not relabel green): source 142281 CREATE → duplicate → `workflow_update` changed an existing workflow without a new owner instruction; source 142450 continuation after terminal.

---

## 5. Intelligence

Context injection is good: query-ranked facts, YOLO vs supervised as **state**, local time, same-session writes, STALE focus labeled, deliverable index. Prompt-cache composition (stable identity/tools, variable packet) is the right idea (`prompt-composition.test.ts`).

What makes her look less intelligent:

1. **Discovery as a conversation with herself.** JIT search was meant to shrink the prompt. It became a maze. Show connected MCP/CLI/native names; search is the long tail. Sept 8: exact-name lookup + native schemas for readers; native writes still behind `work_call` (correct for consent, costly for “edit this file”).
2. **Wrong model on the wrong seat.** Grok/GLM as interactive brain adds 20–30s per hop and 10-minute tails. Terra as brain and judge is the latency/intelligence bargain in **this home’s** metrics.
3. **Workers without the contract.** Grok fleet is a lottery until packet assembly is shared.
4. **Lean prompt + JIT tools** asks a strong model to reinvent house style, then charges a search to find `write_file`.
5. **Too many brains in one turn:** orchestrator, planner (`MODELS.fast`), worker, completion judge, optional account review, compaction summarizer. Locally justified; together a committee that only shares lossy transcripts.

Intelligence here is not “needs Opus.” It is “stop making Sonnet take four paid guesses to find a tool she already has.”

Sept 9 live cost warning: one outreach recorded 854,617 Opus prompt tokens, 690,987 uncached; completion call 63,433 uncached; 77,640 of 130,978 evidence bytes were tool-discovery metadata. Do not silently truncate source records to fake a cache win.

---

## 6. What the kernel already wins — protect in every change

| Asset | File | Why it stays |
| --- | --- | --- |
| Physical-crossing CAS | `physical-io-claim.ts` | Crash cannot double-fire a write |
| Never-blind retry | settlement disposition | Uncertain write → reconcile-only |
| Resolved call authority | `resolved-call-authority.ts` | Live schema/account/effect bound to one accepted call |
| Redeemable result handles | `logical-call-settlement-store.ts` | Compaction is not authority |
| One consent reducer | `interactive-consent-policy.ts` | DeepSeek `pre-execute` allow\|deny\|ask |
| In-place carrier repair | carrier-completion path | 237 in 7 days; zero extra model round trips |
| Session brain pin | `model-roles.ts` | Concurrent chats do not steal brains |
| Typed terminals | `delivery-committer.ts` | `blocked` is not `success` |
| Graph walker (workflows / spine) | `graph-executor.ts` | Opaque kinds; injected runners; do not grow it into a mega-loop |

Owner floor, unchanged: exact user grant for send/delete/admin/sealed bulk; no blind replay of uncertain writes; “wrote, could not verify” over refusing a crossed write; migrations immutable.

---

## 7. Competing older advice — ignore unless this file is silent

- Do not implement “every chat turn is an executable DAG of specialist nodes.” That is Horizon B of the Aug 1 graph doc. Chat already has a spine; the core is still one node on purpose.
- Do not restore the 31k legacy rubric as production. Copy **two** rules into **code gates** if needed (resource identity, done-means-evidence).
- Do not turn on `CLEMMY_DEBATE_MODE` by default.
- Do not turn on boot `CLEMMY_AUTH_FALLOVER`.
- Do not add Researcher/Writer/Executor specialist agents (removed 2026-05).
- Do not treat `packages/chat-engine` as the harness. It is the UI state machine.

---

## 8. Ordered work

Sequential because each makes the next measurable. One concern per change. Prove with a red journey or live bytes, not by reading code (17 of 30 Sept 4 claims died on measurement).

### P0 — Seat models (hours, config + a pin, almost no product risk)

1. Interactive brain: `gpt-5.6-terra` or `claude-sonnet-5`. Not Grok/GLM on the composer.
2. Workers: keep `grok-4.6`.
3. Judge: Terra (cross-family, 3.7s). Not Haiku. Not Opus-on-Sonnet unless the owner explicitly pins it.
4. Either record `objective_met` on route outcomes **then** consider `CLEMMY_ROUTE_POLICY=on`, or stop writing a policy table nobody reads.
5. Pin: `gpt-5.4` and `gpt-5.6-sol` stay below_floor — do not re-enable as default brain.

### P1 — No-progress and completion are ledger-owned

Killer: 58/79 blocks `control_no_progress_exhausted`.

- Host repair and a **new** typed refusal count as progress (governor v2 already has stage-transition budget 6; host repair still often does not append a progress token).
- Delete `last_word_turn` empty tool surface (21 in 7 days). Compose the terminal from retained work; do not buy a tool-free model step to say blocked.
- A write-shaped objective is `done` iff `external_write_succeeded` exists for the run. Flaky judge → `unverified` / `verification_required`, **never** `done` via fail-open.
- Files: `no-progress-governor.ts`, `host-turn-runner.ts`, `objective-judge.ts`, `delivery-committer.ts`, `completion-verification-gate.ts`.

Proof: same cold write canary reports **blocked** instead of false-green when zero crossings; sheet/draft class reports **done** when the ledger has the write.

### P2 — One bounded discovery step, then the proven catalog

- Connected MCP/CLI/native names visible without a search loop (Sept 8 social fix is the template).
- Exact-slug lookup alongside semantic search (`2026-09-07-harness-simplification.md` §2).
- Cap serial `tool_search` per turn. Search is the long tail.
- Native readers already carry schema; do not hide an already-hot registered read. Writes stay behind `work_call` for consent.

Proof: first-use connected read completes with ≤1 search; unused Drive/Slack account review does not appear on a local file edit.

### P3 — One call grammar: `work_call`

Kill flagship `call_tool({name, args_json})`. Schema-on-demand can stay; invoke shape must not fork by vendor. Frozen digest = executed bytes.

### P4 — Public first action; cut interactive silence

Forward first token or first tool name. Interactive stream-stall well below 600s. The 8-hour “no update” copy is how a live run looks dead. Heartbeat already exists (`withActiveTurnHeartbeat`).

### P5 — Ask inside the turn (bb’s property)

Consent `ask` currently ends the turn (`awaiting_approval`) and re-enters `runHostTurn` cold (2–3 extra model steps). `pendingBatch` already serializes a barrier. Sibling calls before the barrier proceed; the frame resumes where it paused. **Do not start this until P1 terminals are honest** — otherwise you will hide dead ends inside a paused turn.

### P6 — One worker packet assembler

Make `worker-packet-lane-parity.red.test.ts` green. Until then the Grok fleet is a lottery.

### P7 — Two lean-rubric rules as code, not prompt

Resource identity (don’t write the wrong sheet) and “done means evidence.” Do not restore `ORCH_BEHAVIOR_HEAD`.

### Explicitly later / not this wave

- In-turn ask is P5, not P0.
- Graph executor extraction of `compose_reply` internals (context already moved; capability lazy-at-node). Only after discovery and terminals are honest.
- Flag collapse (383 `CLEMMY_*`) is hygiene, not the owner-visible job.
- Combined UI + harness tag is a separate qualification (`2026-09-09-focused-harness-refinements.md`).

---

## 9. Hard do-nots

- Do not add a graph compiler in front of ordinary chat writes.
- Do not add a fourth model role or specialist agents.
- Do not add `issueHostDirectNestedCallAdmission` or any new authority token.
- Do not special-case Outlook / Sheets / Salesforce / Slack in the host.
- Do not fail-open a missing judge pin into silent self-grade (P3 already pinned this; do not regress).
- Do not replay uncertain writes.
- Do not relabel retained live failures (142281, 142450, Sept 8 social miss, Sept 9 Outlook first-copy miss) as passes because a successor improved.
- Do not claim route-policy intelligence while `objective_met` is unused.
- Do not use Grok/GLM as the interactive brain “to make her smarter.”
- Do not grow `graph-executor.ts` with effect/consent/policy branches.
- Owner approves every `git push` and every tag.

---

## 10. How to re-measure (do this; do not trust this file’s counts after a week)

Live home is `~/.clementine-next/state/`. Open read-only. Do not print user text, emails, or paths.

```python
import sqlite3, json
from collections import Counter
from datetime import datetime, timezone, timedelta
from pathlib import Path
h = sqlite3.connect(f"file:{Path.home()/'.clementine-next/state/harness.db'}?mode=ro", uri=True)
since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
# terminals
c = Counter()
blocked = Counter()
for row in h.execute("select data_json from events where type='conversation_completed' and created_at>=?", (since,)):
    d = json.loads(row[0] or "{}")
    c[f"{d.get('reason')}|delivered={d.get('delivered')}"] += 1
    if d.get("reason") == "blocked":
        blocked[str(d.get("blockedReason") or "")[:80]] += 1
print(c); print(blocked)
# writes
for t in ("external_write", "external_write_succeeded", "external_write_failed", "external_write_orphaned"):
    print(t, h.execute("select count(*) from events where type=? and created_at>=?", (t, since)).fetchone()[0])
```

Route latency:

```python
m = sqlite3.connect(f"file:{Path.home()/'.clementine-next/state/model-route-metrics.db'}?mode=ro", uri=True)
print(list(m.execute("""
  select d.role, d.provider, d.resolved_model, o.status, count(*) c, avg(o.latency_ms)
  from model_route_outcomes o join model_route_decisions d on d.id=o.decision_id
  group by 1,2,3,4 order by c desc limit 20
""")))
```

Isolated tests (never against the live home): `node scripts/run-tests-isolated.mjs <file>`. The live daemon owns `~/.clementine-next`; the isolation sentinel will say so.

Dated evidence to re-read, not copy numbers from:

- `docs/BEAT-THE-HARNESSES-DIRECTION-2026-09-04.md` §1 scoreboard (stale vs this file’s 7-day terminals)
- `docs/P2-FREE-THE-TURN-REPORT-2026-09-04.md`
- `docs/P3-ONE-DOOR-FOR-WRITES-REPORT-2026-09-04.md` (in progress, not a green phase)
- `docs/checkpoints/2026-09-08-harness-latency.md`
- `docs/checkpoints/2026-09-09-focused-harness-refinements.md`
- `docs/checkpoints/2026-09-07-harness-simplification.md`

---

## 11. File index

**Spine:** `respond-bridge.ts` `respondPreferHarness` → `loop.ts` `runConversation` / `driveChatTurnSpine` → `host-turn-runner.ts` `hostRunRunner` → `brackets.ts` `wrapToolForHarness` → `delivery-committer.ts` `commitTurnOutcome`

**Models:** `model-roles.ts`, `router-model.ts`, `fallback-model.ts`, `worker-model-fallover.ts`, `route-policy.ts`, `judge-family.ts`, `objective-judge.ts`

**Graph:** `src/runtime/graph/graph-executor.ts`, `chat-turn-spine.ts`, `turn-graph-compiler.ts`, `graph-admission.ts`; workflow call site `src/execution/workflow-runner.ts` ~10645

**Accuracy:** `no-progress-governor.ts`, `claim-grounding.ts`, `tool-narration-shapes.ts`, `plan-first-contract.ts`, `accepted-task-mode.ts`, `completion-verification-gate.ts`

**Intelligence / prompt:** `src/agents/harness-context.ts`, `src/agents/clem-rubric.ts`, `src/agents/orchestrator.ts`, `src/runtime/harness/compaction.ts`

**Still red:** `src/agents/worker-packet-lane-parity.red.test.ts`

**Consent (do not fork):** `src/runtime/harness/interactive-consent-policy.ts`

---

## 12. One-sentence summary for the other agent

Keep the kernel, seat Terra/Sonnet on the composer and Grok on workers, make no-progress/completion follow the write ledger, show connected tools instead of searching for them, and do not put a graph in front of ordinary chat.
