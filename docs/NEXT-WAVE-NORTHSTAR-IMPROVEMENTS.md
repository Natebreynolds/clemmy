# Next-Wave North-Star Improvements

Status: **Proposal / implementing-agent brief.** Not constitution.
Date: 2026-09-16
Amended: 2026-09-16 — owner direction on conversational consent (stage-then-commit; planning cards only).
Amended: 2026-09-16 — two live defects the sibling agent left open: recovery-mode list narrowing (~10/day) and direct calls off the advertised surface (~9/day). See **W1a** and **W1b**.
Audience: an implementing agent that will land incremental harness PRs against this list.
Parent constitution: [`docs/north-star-unification.md`](north-star-unification.md)
Product purpose: [`PRODUCT.md`](../PRODUCT.md)
Related: [`docs/EXPLICIT-PLAN-EXECUTE-DESIGN-2026-09-05.md`](EXPLICIT-PLAN-EXECUTE-DESIGN-2026-09-05.md), [`docs/DEEPSEEK-HARNESS-RESEARCH-2026-08-22.md`](DEEPSEEK-HARNESS-RESEARCH-2026-08-22.md), [`CLEMENTINE-ONE-SYSTEM-PLAN.md`](../CLEMENTINE-ONE-SYSTEM-PLAN.md)

This document tells you **what to take** from Qwen 3.8’s self-evolving harness and Block’s [Buzz](https://github.com/block/buzz), **how it maps onto Clem nouns**, **which files to touch**, **what “done” looks like**, and **what you must not copy**. It does not replace the north-star kernel. If this brief and the constitution conflict, the constitution wins.

**Owner product split (2026-09-16).** Planning cards stay. After a task is fired, Clem does **not** mint an approval card per external write. The harness rehearses, stages, and saves the packet, then talks: *I did the work; it is saved here; before I write to X, do you want to review?* That is an agentic assistant. A card per send is a chatbot you hold hands with. See §1 law 9 and **W0**.

---

## 0. How to use this document

Read in this order:

1. §1 Binding laws — if a change violates one, stop. Law 9 (plan card + commit conversation, no per-write cards) is owner direction from this amendment.
2. §5.1 Conversational consent — the product shape. If a change mints a post-Execute write card, it is wrong even if tests pass.
3. §4 Current inventory — do not re-implement what already exists.
4. §6 Workstreams — pick the next **open** workstream in §8 sequence. **Start at W0.**
5. That workstream’s **Files**, **Implementation**, **Tests**, **Done when**, **Do not**.
6. §7 Write-safety overlay — apply to every recovery you add.
7. §9 Acceptance matrix — a PR that cannot tick its row is not done.

Work one workstream per PR unless two are marked as the same slice. Do not open a “become Buzz” or “16-day self-modifying factory” PR.

A workstream is **open** until its Done-when bullets are true in code and tests, not because the idea is written here.

---

## 1. Binding laws

These are already north-star. This wave does not relax them.

1. **One host-owned kernel.**  
   `accepted durable source → admitted graph → exact call authority → fenced physical reservation → receipt/read-back → one Outcome`. Recovery resumes that machine. It is not a second executor.

2. **Reroute, do not bypass.**  
   A gate that cannot be satisfied must name the next legal move. It must never become “skip confirm-first”, “YOLO the send”, or “retry the uncertain write”.

3. **An absent host fact is never a prohibition.**  
   If the host failed to disclose a catalog id, account, or repair key, the host supplies it or states the exact missing fact and the move that would satisfy it. Measured 2026-08-24: 16 `plan_task` refusals that no action available to the model could satisfy.

4. **A refusal is expensive.**  
   Prefer host auto-repair, coercion to a host-owned key, replay of an existing claim, or a typed next-edge. Do not add a new per-call wall the model has to guess around.

5. **Side-effect law.**  
   A send is one attempt. Never auto-retry an external write whose effect state is `unknown`. Never dispatch a late tool call on a revoked lease.

6. **Done is evidence, not prose.**  
   `delivery-committer.ts` does not accept arbitrary model output as terminal. Judges, Fusion, and hook text are advisory. Receipts, read-backs, and the capability’s verification contract are authority.

7. **Altitude chooses orchestration, never safety.**  
   A one-line email still crosses the write kernel. A 16-day coding loop still cannot widen write authority by existing for a long time.

8. **Clem is a personal owner-operator assistant, not a team relay.**  
   Do not import Nostr, channel membership as the product, git-forge-as-workspace, or public agent lobbies. Steal runtime patterns, not the product.

9. **Consent is a plan plus one commit conversation, never a card per write.**  
   The only structured card that remains is the **planning card** (shape, blast radius, Execute). After Execute, the host **rehearses**: reads, drafts, stages payloads, saves artifacts. Zero external crossings until the user has seen one conversational commit: *here is the packet, saved here, about to write to {destinations} — review?* That commit is `needs_input` in the origin chat, bound to an exact staged-bundle digest — not `approval_requested` per call. Dispatch then runs under leases and receipts. A wider blast radius is a **new plan revision**, not a mid-flight card. Credential/account/destination **choice** may still ask once, as a question, not as a tool-approval card. This is the difference between an agentic assistant and a chatbot the user has to hold hands with.

---

## 2. Sources researched

### 2.1 Qwen 3.8 self-evolving harness

Primary: [Qwen3.8-Max: A New Bar for Coding and Cowork](https://qwen.ai/blog?id=qwen3.8) (mirrored at [Alibaba Cloud Community](https://www.alibabacloud.com/blog/qwen3-8-max-a-new-bar-for-coding-and-cowork_603421), 2026-08-03).

What they actually shipped in the demo (`qwen-code-dev-bot/oh-my-cli`, ~16 days, 265 commits / 127 PRs / 151 issues):

| Mechanism | What it is |
|---|---|
| Issue state machine | Work moves `ready → leased → active`. One claim, one body. |
| Dispatcher + monitor + watchdog | Lease supervision, not a prompt that says “keep going”. |
| Self-test after every change | Build, unit, E2E, desktop lifecycle. Failures re-enter the same issue. |
| Multi-source evolution | User feedback + community patterns + self-test failures become executable work. |
| Evidence-driven plan | Overfit → prune; path dependence → extra validation; dead strategy → switch framework. |
| Dynamic Workflows | Freeze orchestration into a program so later turns execute instead of re-planning. |
| Independent verifier | Qwen Code Goal v3: `complete` / `blocked` stay non-terminal until durable `verifier_accept` **and** a terminal write both land. Persist-before-publish. No fixed turn cap. User input beats auto-continue. |
| Adaptive effort | `reasoning_effort`: `xhigh` / `medium` / `low`. `preserve_thinking` on by default. |
| Visual feedback | Inspect own output, revise the plan, do not declare done from generation text. |

The 16-day run is a **sandbox coding factory**. They can merge PRs all night. Clem writes mail, CRM, calendars, and live deploys. Copy the loop shape, not the permission model.

### 2.2 Block Buzz (`github.com/block/buzz`, Apache-2.0)

Primary in-tree docs read 2026-09-16:

- [README](https://github.com/block/buzz/blob/main/README.md)
- [VISION.md](https://github.com/block/buzz/blob/main/VISION.md)
- [VISION_AGENT.md](https://github.com/block/buzz/blob/main/VISION_AGENT.md)
- [VISION_ACTIVITY.md](https://github.com/block/buzz/blob/main/VISION_ACTIVITY.md)
- [VISION_REMOTE_AGENTS.md](https://github.com/block/buzz/blob/main/VISION_REMOTE_AGENTS.md)
- [ARCHITECTURE.md](https://github.com/block/buzz/blob/main/ARCHITECTURE.md)
- [crates/buzz-acp/README.md](https://github.com/block/buzz/blob/main/crates/buzz-acp/README.md)
- [crates/buzz-agent/README.md](https://github.com/block/buzz/blob/main/crates/buzz-agent/README.md)
- [docs/MCP_DRIVEN_HOOKS.md](https://github.com/block/buzz/blob/main/docs/MCP_DRIVEN_HOOKS.md)
- [examples/meadow-core](https://github.com/block/buzz/tree/main/examples/meadow-core)
- Community: [mpiv-ai/buzz-hooks](https://github.com/mpiv-ai/buzz-hooks)
- Block Engineering: [Configuring Agents in Buzz](https://engineering.block.xyz/blog/configuring-agents-in-buzz) (2026-08-10)

What is actually useful for Clem (not the Slack-replacement product):

| Mechanism | What it is | Buzz honesty |
|---|---|---|
| Agent = member with its own key | Identity, membership, audit trail. Scoped like a teammate, not a permission-flag blob. | Product is a team relay. Clem is one owner. Steal identity-per-worker and audit, not public lobbies. |
| Inbound author gate | `owner-only` / `allowlist` / `anyone` / `nobody`. Owner control commands (`!cancel`, `!rotate`, `!shutdown`) are consumed by the harness, never forwarded to the model. | Default `owner-only` is the right personal-assistant default. |
| Per-channel one-in-flight | Mentions queue; at most one prompt in flight per channel; N workers share one identity; a channel is never processed by two bodies at once. | Directly maps to Clem session/task leases. |
| Heartbeat | Lower priority than queued events; skipped when all bodies busy; at most one heartbeat in flight globally; default prompt is “look at needs-action, else stop”. | Autonomy/proactivity currently has duplicate engines. |
| Lazy pool | Connect, subscribe, and queue **before** spawning LLM subprocesses. First accepted event wakes a body. | Speed. |
| Party composition | Orchestrator = deepest model + `xhigh`; executors = cheaper + `medium` + prompt-only difference; reviewer = **different model family**; scout = fast tier. | Clem already has `brain` / `worker` / `judge` roles. Wire effort and cross-family reviewer. |
| Core vs cold memory | `core` injected every session; `mem/<topic>` read on demand. Agent tends core; human authors the job prompt once. | Clem memory already splits; keep recall from authorizing writes. |
| Activity feed | Verb + object + outcome. Mutate in place. Never go dark. Failures rise, reads recede. Semantics over transport. | UI work. Engine already has the events. |
| `_Stop` / `_PostCompact` hooks | MCP tools the LLM cannot see. `_Stop` objects to `end_turn`. `_PostCompact` re-injects after compaction. | **Advisory, fail-open, 3-objection budget.** Fine for todos/CI. **Illegal as the write kernel.** |
| Reply guard | If a turn did work and never published, remind at most twice, then end. Recognizes **attempt**, not success. | Maps to Clem report-back. Must not claim a send succeeded. |
| YAML workflows + `request_approval` | Intended: suspend, persist token, resume from step. | **Not wired.** Runs that hit approval are marked Failed (WF-08). Do not copy the bug. Copy the intended persist-and-resume. |
| Remote agents | Identity lives on the log. Body is disposable. After deploy, no extra control plane. Agent self-reaps after silence. Presence is a lease. | Clem daemon is already the body. Steal “identity survives, scratch dies, inactivity ends the body”. |
| Bounded everything | Process-group kill, frame caps, tool-result elision, dead-server restart, cancel wins every race. | Align Clem child-tool teardown with this. |
| JSON-in / JSON-out CLI | `buzz-cli` is the agent surface. Human GUI is a projection. | Clem tools are already JSON; keep protocol out of user bubbles. |

Known Buzz gaps you must **not** treat as features: no production rate limiter (trait + test stub only), workflow approval not end-to-end, `send_dm` / `set_channel_topic` stubbed, huddle recording unbuilt, hooks do not run inside Goose/Codex/Claude ACP sessions.

---

## 3. Steal vs refuse

### 3.1 Steal (runtime patterns)

From **Qwen**: leased work, watchdog that resumes, self-test as the next work item, verifier-gated done, evidence can revise a plan, adaptive effort, outer loop that turns failures into durable work.

From **Buzz**: identity-scoped workers, inbound author/owner commands, one-in-flight + queue, heartbeat that yields to real work, party split by model+effort+prompt, verb-object-outcome feed, host-owned stop objection for *evidence* (not MCP advisory for writes), reply/report-back reminder, bounded child lifetime, persist-and-resume for approval-shaped workflow steps.

### 3.2 Refuse (product and permission)

| Do not take | Why |
|---|---|
| Nostr / signed-event product surface | Clem’s log is the eventlog. Adding a second identity system is a fork. |
| Agents as public channel members | Clem is one owner-operator. Inbound default is the owner. |
| Git forge, branch-as-channel, NIP-34 | Out of product scope (`PRODUCT.md` binding: first-party surfaces only). |
| Model edits gate code in the live write process | HASE / oh-my-cli self-modify is sandbox-only, behind tests, never on the process holding Salesforce/mail leases. |
| Fail-open `_Stop` as write enforcement | Buzz says this out loud. Relay policy enforces merges; hooks only shape behavior. Clem write gates **are** the relay policy. |
| Second-attempt destination skip as “keep going” | `destination-gate.ts` is already a one-shot nudge. Do not turn it into a bypass. |
| Replay of `effectState: unknown` external writes | Side-effect law. |
| `buzz-agent` “no persistence” | Clem’s moat is durable settlement across restart. |
| Buzz WF-08 (approval marks the run failed) | We already have durable approval cards. Make resume work; do not fail the run. |
| Training-time RL / universal reward system | Vendor work. Not a Clem runtime change. |

---

## 4. Current Clem inventory

Implementing agents: if the file already does the job, extend it. Do not add a parallel primitive.

| Need | Already in tree | Gap this wave fills |
|---|---|---|
| Typed next move after a refusal | `src/runtime/harness/next-edge.ts` (`reissue_unstarted`, `repair_arguments`, `discover_capability`, `choose_account`, `publish_partial`, `ask_user`, `choose_other_capability`) | Wired on `publish-plan` and host receipts. **Not** on every recoverable gate. Live 2026-09-11: stuck turn told “Use `call_tool` to resolve this step” — named the envelope, not the inner tool. |
| No-progress backstop | `no-progress-governor.ts` (`repair_model` / `retry_host` / `ask_user` / `stop_factual` / `reconcile`), budgets 3 retries / 6 stage transitions | Recovery surface still collapses wrappers; see `host-no-progress-projection.ts` comments. |
| Auto-continue through ceilings | `continue-directive.ts` (checkpoint, not ending; cap 200) | Watchdog often observes rather than resumes. |
| Write gates | execution-wrap, confirm-first, grounding, constraint, send, destination | Edges missing; some gates fail-open by design on unparseable commands (keep that, do not widen). |
| Per-call consent | `interactive-consent-policy.ts`: ordinary create/update with coverage **proceeds**; send/delete/admin/irreversible/sealed bulk **`needs_user` approval** (a card). Plan mode refuses business writes. | **Wrong product shape after Execute.** High-consequence work still mints a card per crossing. Owner direction: stage the bundle, one conversational review, then dispatch. Keep the policy module; change *when* it asks and *what* the subject is (bundle digest, not each call). |
| Planning cards | `publish_plan`, reviewed-plan runtime, explicit Plan → Execute (`docs/EXPLICIT-PLAN-EXECUTE-DESIGN-2026-09-05.md`) | Keep. This is the robust consent surface. Do not wire Execute to blanket send scopes (`approvePlanAndQueueBackgroundTask` anti-pattern in that design). |
| Recovery tool selection | `hostNoProgressRecoveryToolNames` in `host-turn-runner.ts`; pins in `recovery-not-a-dead-end.test.ts`. Offline, the rule is correct (admits tools its own advice names; keeps writes out). | **Live ~10/day still dies.** Sibling agent: the carrier is missing from **that step’s `tools` array**, so a correct filter over an incomplete list cannot save the turn. Logging added on `recovery_surface_reprompt` (`attempted`, `permitted`, `available`, `consequenceStage`). Recovery still **shrinks advertised schemas** (`recoveryTools = tools.filter(...)` then `modelStepSchemas = serializedTools(recoveryTools)` ~8448). `docs/BEAT-THE-HARNESSES-DIRECTION-2026-09-04.md` item 5 claimed “advertise one tool array per accepted turn and enforce at pre-dispatch” — that shrink is the regression. **W1a.** |
| Off-surface direct calls | Admission `toolByName.get(call.name)` miss → prose “Tool X not found. Use tool_search… through the advertised carrier” (`host-turn-runner.ts` ~5689). Carrier path `call_tool` already has reachability (`src/tools/call-tool.ts`). Inverse unwrap `resolveCarriedHostControl` exists (carrier → direct control when the control is on the surface). | **Live ~9/day.** Model calls a reachable tool by its **direct** name when that name is not in this step’s advertised list. Naive remap of `call.name` to `call_tool` breaks sealed identity: the host ties receipts to the model’s original sealed call (`logicalToolCallId` + authored name + args). Sibling agent: this is a **design change at admission**, not a dispatch patch. **W1b.** |
| Lease / generation | `dispatch-lease.ts`, `external-write-admission.ts` | Stall + late dispatch still a known class (`INTEGRITY-AUDIT-2026-06-29.md`). |
| Host-owned turn | `host-turn-runner.ts` | Completion still has `verifyDelivered` shadows in `loop.ts`. |
| Native arg repair | `src/tools/native-argument-repair.ts` (wrap list item; rename field on **reads** only) | Sends/admin stay refused — keep that. Extend coverage, do not widen to sends. |
| Brain fallover | `fallback-model.ts` (only before actionable output) | No effort routing for cheap vs expensive frames. |
| Roles | `model-roles.ts` (`brain` / `worker` / `judge`) | No Buzz-style party: effort per role, cross-family reviewer as default. |
| Done / Outcome | `delivery-committer.ts`, `turn-outcome.ts`, north-star Outcome | Local/Space/code work does not always schedule a verifier as expected work. |
| Correction / learn | `correction-hook.ts`, `/learn` skill, reflection | Failed gates do not reliably become durable follow-up work. |
| Watchdogs | `src/execution/workflow-watchdog.ts`, background-task watchdog | `recommendedRecoveryForStalledRun` exists; many paths still alert-only. |
| Fusion / debate | `debate-model.ts` (advisory verifier, never executor) | Keep advisory. Use as Buzz “Thufir”: different family, cannot authorize. |

North-star already named the feed and the silent-end watchdog (`north-star-unification.md` Move 4: “if a run produces no Outcome, the watchdog emits a `failed`/`blocked` one”). This wave is the implementation push, not a new doctrine.

---

## 5. The one law, with Buzz and Qwen folded in

```
gate refuses
  → if host-owned fact is missing, host supplies it
  → else emit HostNextEdgeV1 (never prose-only)
  → if the edge is host-executable (wrap args, reissue unstarted, readback)
        host does it without a model round trip
  → else model takes the named edge
  → write kernel still runs on the next physical crossing
  → if progress is zero, no-progress governor stages repair → ask → stop
  → if a body is silent, watchdog resumes / reconciles / parks
  → terminal Outcome only after the lane’s evidence contract
```

Buzz’s `_Stop` is the **evidence** objection: “you may not end_turn until the contract is met.”  
Qwen’s issue machine is the **work** objection: “a failed test is the next leased item.”  
Neither is permission to skip the plan card or the commit conversation.

### 5.1 Conversational consent — stage, then commit

This is the product law that every workstream below has to obey. It is not a UI skin on today’s cards.

```
plan card (only structured card)
  → Execute
  → REHEARSE (reads, drafts, local/Space saves, verifiers)
       zero external_write / admin crossings
  → COMMIT CONVERSATION in the origin chat
       "I did the work. Packet saved at {artifact}.
        About to write to {X}. Review?"
  → user: send / change N / stop
  → DISPATCH staged calls under leases
       receipts in the feed, no more cards
  → if blast radius would widen: new plan revision card
```

**What a planning card is for.** Shape, operations, accounts, destinations, cardinality, verification. Execute binds that revision. It does **not** open a standing “approve every send as it happens” scope, and it does **not** silently authorize the physical crossings. That is why `docs/EXPLICIT-PLAN-EXECUTE-DESIGN-2026-09-05.md` forbids wiring Execute to `approvePlanAndQueueBackgroundTask()`.

**What rehearsal is.** Host-owned. Workers may compose payloads; they may not cross. Drafts, sheets, Space records, local files, preview artifacts are `local_write` / `host_only`. The packet gets a digest. If rehearsal cannot finish (missing account, missing fact), that is `needs_input` **choice/credential/essential_input** or a next-edge — still not a per-write card.

**What the commit conversation is.** One `TurnNeed` on the origin session, presentation-first: Clem’s voice, artifact links, destination list, counts. Durable grant is the **staged-bundle digest** (operations + args + destinations + account). User “looks good” / “send it” / “change the third row” is conversation. Host records `exact_user_grant` (or a new `staged_bundle_commit` basis) covering that digest. Drift after grant is `scope_mismatch` repair, not a new card and not a silent send.

**What dispatch is.** The write kernel you already have: lease, one attempt, never-blind retry, readback. The feed shows “Sent mail to X → receipt”. The user is not asked again.

**Ad-hoc chat without a plan.** A one-line “email Bob I’ll be late” still rehearses a draft, then one conversational preview if the payload was not already the user’s words. If the user supplied the exact payload and destination in the accepted source, coverage can proceed after staging without a second ask — that is Auto, not a card. “Find 100 accounts and email them” is a plan. Do not mint 100 cards. Do not send 100 without the commit conversation.

**Still not cards (questions, not tool-approval chrome):**

- credential missing
- account / destination not unique
- essential input the user never gave

**Still never a question to the user:**

- surprise write with no coverage → `repair` to the model (coverage_missing)
- unknown in-flight write → reconcile, do not replay
- host failed to disclose a fact → host supplies it (law 3)

Today `evaluateInteractiveConsentV1` returns `needs_user` / `approval` for every send/delete/admin/irreversible/sealed set. That is the hand-holding path. After W0, those consequences are **staged**, and `needs_user` fires **once** on the bundle (or not at all when the accepted source already contained the exact payload). Ordinary create/update that already proceeds under coverage stays that way — still after staging if the provider write is external.

---

## 6. Workstreams

Each workstream is a unit another agent can pick up. Status starts **open**. Flip to **landed** in this file only after tests exist on HEAD.

**W0 is not optional.** A PR that adds or preserves a per-write `approval_requested` card on the post-Execute path is regressing the product, even if its own workstream is otherwise green.

### W0. Stage-then-commit: planning cards only, conversational review before X

**Why.** Owner, 2026-09-16: approvals should be conversation; strip cards except planning cards. After a task is fired, Clem should not toss an approval for every external write. Wrap the work, save it, then: *here you go, I did all the work, it’s saved here, before I write to X would you like to review?* That is the assistant. Per-call cards are hand-holding.

Qwen: rehearse (tests, previews, artifacts) then one merge. Buzz: one `request_approval` step in a workflow, not a card per tool — and even they failed to wire it (WF-08). Clem already Auto-proceeds ordinary creates/updates (`exact_ordinary_work`) and already forbids Plan from performing business writes. The remaining defect is **send/delete/admin still minting a card per crossing after Execute**.

**Files.**

- `src/runtime/harness/interactive-consent-policy.ts` — change the *subject* of `needs_user` / `approval` from the call binding to the staged bundle (or proceed on `staged_bundle_commit` / `exact_user_grant` after the conversation). Do not delete the module.
- `src/runtime/harness/approval-card.ts`, `approval-registry.ts` — remain for **plan cards** and for recording the **one** bundle grant. Stop using them as the per-`logicalToolCallId` UI after Execute.
- `src/runtime/harness/pending-action-transition.ts` — pending actions become staged-packet rows, not N cards.
- `src/runtime/harness/confirm-first-gate.ts` — confirm-first is satisfied by the plan card + bundle commit, not a second chrome layer mid-batch.
- `src/runtime/harness/host-turn-runner.ts` — rehearsal vs dispatch phases; workers compose-only until commit (already the worker rule; enforce it).
- `src/runtime/harness/host-local-write-commit.ts`, Space / artifact ledger — where the packet is saved.
- `src/runtime/harness/delivery-committer.ts`, `turn-outcome.ts` — commit is `needs_input` with artifact refs, not `approval_requested` chrome.
- `src/tools/publish-plan.ts`, `reviewed-plan-runtime.ts` — plan card stays; Execute does not grant physical sends.
- Console/mobile plan-card UI — keep. Per-write approve/reject cards — strip from the post-Execute path.
- Tests: `interactive-consent-policy.test.ts`, `auto-mode-interactive-consent.acceptance.test.ts`, `claude-agent-approval.test.ts`, journey tests that currently assert one card per send.

**Implementation.**

1. Split an accepted Execute run into two host phases that the model cannot skip: `rehearse` and `dispatch`.
2. In `rehearse`, high-consequence intended crossings materialize as **staged items** (exact operation, args digest, destination, account, preview bytes) written to durable artifacts. Physical `external_write` / `admin` is refused as `plan_mode_external_effect`-shaped (or a sibling `rehearse_mode_external_effect`) until commit.
3. When the packet is complete (or honestly partial), commit one origin-session turn in Clem’s voice, with artifact links. No Approve chrome required; durable yes is the user’s conversational reply **or** a single “Send packet” action on the **plan/commit** surface — never N tool cards.
4. On commit, mint **one** `ExactUserGrantV1` (or bundle-grant) whose scope is the packet digest. Each staged call proceeds with `basis: 'exact_user_grant'` / `staged_bundle_commit` iff it still matches. Mismatch → repair, not a new card, not dispatch.
5. User “change the third one” revises that staged item, re-digests, and **re-asks the commit conversation** if destinations or cardinality changed; if only copy changed inside the same dest/account/operation, a tighter re-preview is enough — still conversation, still not a card.
6. Ad-hoc exact payload already in the accepted source: stage for the ledger, then dispatch without a second ask (Auto). Ad-hoc implied send without payload: one conversational preview.
7. Inventory live `approval_requested` emitters after Execute. Each one is either deleted, folded into the bundle grant, or justified as plan-revision / credential / choice. “High consequence” is not sufficient justification for a card.

**Tests.**

- Plan → Execute of N emails: zero `approval_requested` events during rehearsal; N local/staged artifacts; one `needs_input` commit turn; after “send”, N leased crossings and N receipts; still zero per-write cards.
- Ordinary CRM updates already under coverage: still no card (existing Auto); still staged if they are external; still receipts.
- Bundle grant + one dest drift: that item does not send; others matching the digest may; no new card; next-edge names the drift.
- Surprise send with no coverage: `repair` / `coverage_missing`, zero cards, zero crossings.
- Credential missing: one `needs_input` choice, not an approval card.
- Widen cardinality (N to N+1 new recipients): new **plan revision** card, not N+1 write cards.
- Daemon kill mid-dispatch: exactly-once (W2); commit grant is not a second fire.
- Browser: plan card still works; post-Execute UI shows packet + conversational review, not a stack of approve buttons. Desktop and mobile.

**Done when.** After Execute, the eventlog of a mixed send/update task contains planning-card events and at most one commit `needs_input`, never a stack of `approval_requested` rows keyed by `logicalToolCallId`. User-visible copy can be Clem’s voice pointing at saved artifacts. Write kernel (lease, one attempt, no blind retry) is unchanged.

**Do not.**

- YOLO the packet because the plan was approved (Execute ≠ dispatch grant).
- Keep per-write cards “just for sends” — that is the behavior being removed.
- Fail-open if staging is incomplete.
- Use Buzz-style 👍 reactions as the grant.
- Let workers dispatch during rehearsal.
- Call a chat bubble with hidden Approve chrome a “conversation”.
- Stage by actually sending a draft to the provider unless the capability is a true reversible draft with a delete/undo contract (Outlook draft-id is a special case: it is still an external create — treat it as staging only if the plan named drafts, and the commit conversation is what **sends**).

---

### W1. Mandatory next-edge on every recoverable refusal

**Why.** This is “never stop at a gate it cannot get around.” The primitive exists. The defect is missing or wrong edges (wrapper named instead of inner tool).

**Steal from.** Qwen: every blocked step is work. Buzz: owner commands and queue never leave the model to guess `!cancel`. Clem: `next-edge.ts` closed set.

**Files.**

- `src/runtime/harness/next-edge.ts` (do not grow the closed set without a new workstream)
- `src/runtime/harness/host-model-result-receipt.ts`
- `src/tools/publish-plan.ts` (already emits; keep as the gold pattern)
- `src/runtime/harness/brackets.ts` (`wrapToolForHarness`)
- `src/runtime/harness/confirm-first-gate.ts`
- `src/runtime/harness/destination-gate.ts`
- `src/runtime/harness/constraint-guard.ts`
- `src/runtime/harness/host-no-progress-projection.ts`
- Call sites that return `retry: 'replan'` without `HostNextEdgeV1`

**Implementation.**

1. Inventory every `retry: 'replan'` / recoverable refusal. A recoverable refusal without an edge is a red test (`isRecoverableWithoutEdge`).
2. Edge `.tool` is the **inner** refused carrier (`unwrapRuntimeEffectiveToolIdentity`), never `call_tool` / `composio_execute_tool` unless that *is* the inner tool.
3. Host-completable edges (`repair_arguments` whose fields the host already knows; native wrap/rename) execute in-process, then re-validate against the tool schema. Sends and admin stay model-facing.
4. User-owned gates (confirm-first, approval, destination explicitness, irreversible batch) emit `ask_user` or “make destination explicit” — never `repair_arguments` that invents consent.
5. Render with `renderNextEdge`. Do not write a sixth sentence in the refusal body.

**Tests.**

- Existing `next-edge.test.ts` stays the contract.
- New: every live refusal fixture in `host-no-progress-governor.integration.test.ts` / gate tests asserts an edge and that the named tool is the inner carrier.
- Red case from 2026-09-11: three distinct inner refusals in one wrapper frame produce three stage keys, not one `call_tool` loop.

**Done when.** `isRecoverableWithoutEdge('replan', edge)` is false on every production refusal path. No user-visible refusal says only “Repair the listed fields” or “Use call_tool”.

**Do not.** Grant authority by naming a tool. Do not add `skip_gate` as an edge. Do not default destination-gate’s second attempt into a silent publish.

---

### W1a. Recovery advertised-list stability (~10 stuck turns/day)

**Why.** Sibling agent, working tree, not fixed: recovery-mode narrowing, ~10 a day. The selection rule is correct when tested offline, so the carrier was missing from that step’s tool list. They added logging so the next occurrence shows exactly where the list narrows. Do not “fix” `hostNoProgressRecoveryToolNames` again.

Live shape (Platform 49 and later): governor says `continue` with budget left; turn ends `recovery_surface_mismatch` / `control_no_progress_exhausted` because the model never saw the carrier the recovery named.

**Steal from.** Qwen: a blocked step is still work. North-star law 3: an absent host disclosure is not a prohibition. BEAT-THE-HARNESSES §11 item 5 (cache-prefix stability): advertise one tool array per accepted turn; constrain effects at pre-dispatch, not by shrinking methods.

**Files.**

- `src/runtime/harness/host-turn-runner.ts` — `hostNoProgressRecoveryToolNames` (leave the rule); the shrink at `recoveryTools` / `modelStepSchemas` (~8448); `journalHostGuide('recovery_surface_reprompt', { attempted, permitted, available, consequenceStage })` (already landed — **read it, do not re-add it**).
- `src/runtime/harness/recovery-not-a-dead-end.test.ts` — selection-rule pins; add advertised-list pins.
- `src/agents/orchestrator.ts` — `effectiveAllowedToolNames` / structural carriers `call_tool` + `work_call` must survive into the step’s `tools`.
- `src/runtime/harness/claude-agent-brain.ts` — JIT advertised set is monotonic (already pinned). Same invariant on the host-turn path.
- Eventlog: `guardrail_tripped` / `kind: recovery_surface_reprompt`.

**Implementation.**

1. On the next live `recovery_surface_reprompt`, read `available` vs `permitted` vs `attempted`:
   - `available` lacks the carrier → the list narrowed **before** the selection rule (assembly, prior recovery shrink, `isEnabled`, JIT). That is the bug.
   - `available` has it, `permitted` lacks it → selection rule (contradicts offline tests; do not start here).
   - `permitted` has it, model called something else → W1 next-edge; not a list bug.
2. Stop replacing the advertised schema array with `recoveryTools` on recovery steps. Keep the **accepted-turn** tool array on the wire (cache-stable). Enforce `permittedNoProgressRecoveryToolNames` at **admission** (already refuses off-permitted frames ~8980). A recovery step that shrinks schemas makes the next step’s `available` lose the carrier — the ~10/day loop.
3. Structural carriers (`call_tool`, `work_call`) and retained-output readers stay in `tools` for the life of the accepted source, including recovery. Plan turns keep `publish_plan` (already in the selection rule).
4. Do not grow the advertised set mid-turn either (JIT monotonic floor). Recovery may not shrink; discovery may not reorder.

**Tests.**

- Existing `recovery-not-a-dead-end.test.ts` stays green (do not churn the rule).
- New: after a `repair_model` consequence, `serializedTools` sent to the model still contains `call_tool` / `work_call` / `tool_search` when those names were on the accepted-turn surface, even if they are not in `recoveryToolNames`.
- New: two consecutive recovery steps; second step’s `available` log equals the first step’s accepted-turn list, not the filtered permitted set.
- Characterization: a fixture where `tools` arriving at `hostNoProgressRecoveryToolNames` omits `call_tool` is **red** (that is the live defect). Do not paper it over by adding `call_tool` inside the filter.

**Done when.** A recovery step does not change the advertised method set. Permitted-set misses are admission refusals with a next-edge, not a smaller tools block. Live `recovery_surface_reprompt` rows with `available` missing the carrier go to ~0/day.

**Do not.**

- Rewrite `hostNoProgressRecoveryToolNames` “one more time.”
- Delete the `recovery_surface_reprompt` log.
- Advertise every installed tool (defeats JIT). The invariant is **stable for the accepted turn**, not global.
- Treat a model calling a non-permitted name as a list bug (that is W1 / W1b).

---

### W1b. Off-surface direct calls carried at admission (~9/day)

**Why.** Sibling agent, working tree, not fixed: direct calls to tools not on the surface, ~9 a day. Fixing this safely means carrying the call at admission with the carrier’s reachability checks. The host ties each result to the model’s original sealed call, so this is a design change, not a quick patch.

Today: model emits `read_file` / `plan_task` / a catalog slug as a **top-level** function call; that name is not in this step’s `toolByName`; admission writes “Tool 'X' not found. Use tool_search… through the advertised carrier.” The model already knew X. The carrier (`call_tool` / `work_call`) would have reached X under its existing checks. The turn burns a zero-crossing repair and often dies at the no-progress floor (same family as live 2026-09-05: told to call a built-in directly, it is not on the surface, retries the wrapper, dies).

**Why not a one-line remap.** Receipts, `tool_output_query`, mirrored transport pairs, and authority seals key off the **authored** `{ callId, name, arguments }`. Rewriting `call.name` to `call_tool` at invoke makes the settlement a different call than the model sealed. `mirrored-call-identity.test.ts` is the cousin: one invocation observed twice is still one invocation — the inverse bug is one invocation rewritten as another.

**Files.**

- `src/runtime/harness/host-turn-runner.ts` — admission around `toolByName.get(call.name)` (~5641) and the “not found” prose (~5689); `exactProductionHostCall` already routes **carrier → direct** via `resolveCarriedHostControl` / `resolveProviderCarrierLocalReadControl`. Need the **direct → carrier** inverse that **keeps the sealed call**.
- `src/runtime/harness/tool-effect.ts` — `resolveCarriedHostControl` (document the inverse; do not overload it into a different meaning).
- `src/tools/call-tool.ts` — reachability (`reachableBuiltinNames`, `firstClassNames`, catalog port). Admission must run **that same function**, not a second copy.
- `src/runtime/harness/authority-argument-seal.ts`, attempt identity, `mirrored-call-identity.test.ts`.
- `src/tools/call-tool.test.ts` — “not on the surface” refusals stay for names the carrier also cannot reach.

**Implementation.**

1. At admission, if `toolByName` misses `call.name`:
   - Project a **carried invocation**: execute through the configured acquisition carrier (`call_tool` for local/control/read, `work_call` for business writes) with inner name = authored name.
   - Run the **carrier’s** reachability, schema, effect, account, and W0 staging checks on the inner call. If the carrier would refuse, return **that** refusal (true next-edge), not “tool not found.”
   - If the carrier would proceed, invoke the carrier body.
2. **Sealed identity stays the model’s.** `logicalToolCallId`, authored `name`, argument digest, and settlement `tool` on the **top-level** pair remain the direct name. A transport_mirror may show the carrier (already the 146537 shape). Occurrence count is one.
3. Do not add the missing name to the advertised list mid-step (breaks W1a / cache). Carrying is host routing, not a surface change.
4. Names the carrier cannot reach (cli-only `cron_list`, denied MCP, unknown slug) keep today’s `not_reachable` / next-edge to `tool_search`. Do not invent reachability.
5. Writes: carrying a send does **not** skip W0. A carried `GMAIL_SEND_EMAIL` during rehearsal stages; it does not cross.

**Tests.**

- Direct `plan_task` / `read_file` / a proven catalog read **not** in `toolByName` but reachable via `call_tool`: one settlement, top-level `tool` = authored name, mirror may be the carrier, `tool_output_query` on that `callId` succeeds, occurrence count 1.
- Direct `cron_list` (never on chat surface): still `not_reachable`; must not claim FIRST-CLASS; must not dispatch.
- Remapping `call.name` in the sealed record to `call_tool` is **red**.
- Two genuine top-level invocations sharing an id still `ambiguous` (existing mirror test).
- Carried send during W0 rehearsal: zero external crossings.

**Done when.** Live “Tool 'X' not found” on a name the carrier would have reached goes to ~0/day. Sealed-call identity tests stay green. Unreachable names still refuse with a true next-edge.

**Do not.**

- `toolByName.set(call.name, …)` to paper over a miss (widens the surface, busts cache, skips carrier checks).
- Rewrite the sealed name.
- Treat this as a prompt (“please use call_tool”). The model already called the operation; the host failed to route it.
- Carry admin/send around W0 or the lease.

---

### W2. Lease watchdog: resume vs reconcile vs park

**Why.** Qwen’s monitor+watchdog is how 16-day runs survive. Buzz remote agents: presence is a lease; a dead body stops renewing. Clem’s failure class is the opposite: watchdog fires, then an approved write dispatches twice (`INTEGRITY-AUDIT-2026-06-29.md`).

**Steal from.** Qwen Goal v3 persist-before-publish; Buzz process-group kill + cancel-wins-every-race; Clem `dispatch-lease.ts`.

**Files.**

- `src/runtime/harness/dispatch-lease.ts`
- `src/runtime/harness/host-turn-runner.ts`
- `src/runtime/harness/continue-directive.ts`
- `src/execution/workflow-watchdog.ts` (`recommendedRecoveryForStalledRun`)
- `src/runtime/harness/model-stall-policy.ts`
- Background-task watchdog sibling

**Implementation.**

A stall may only resolve to one of three host actions, keyed on effect state:

| Effect state | Watchdog action | Next edge |
|---|---|---|
| Unstarted / no provider crossing | `reissue_unstarted` with a **new** call id, same sealed args | `reissue_unstarted` |
| In flight, outcome unknown (especially external_write) | Park. Reconcile/read back. **Never second dispatch.** | `reconcile` / `do_not_retry` |
| Verifying, persistence of terminal failed | Stay in `verifying`. Resume the verifier. Do not invent `done`. | host retry of the **terminal write**, not the business write |

Revoke the lease before any retry path that could overlap a live child. Kill the process group of host-spawned tools on cancel (Buzz `killpg(SIGKILL)` equivalent).

Heartbeat / autonomy ticks: **lower priority than queued user input and in-flight leases.** At most one heartbeat in flight. Skip if any body is busy. Default heartbeat is “scan needs-action; if none, stop” — not “invent work”.

**Tests.**

- Approved external write that emits no stream events for > stall ms: **exactly one** provider crossing.
- Unstarted read after watchdog: second physical call id, same logical call.
- Unknown write: zero additional crossings; Outcome is `blocked` / `needs_input` with reconcile guidance.
- Verifying + failed terminal append: snapshot stays non-terminal; `beginTurn` refuses until resume.

**Done when.** The 2026-06-29 duplicate-write scenario is a green characterization test. Watchdogs emit or resume an Outcome; they do not only notify.

**Do not.** Treat “no stream event” as “safe to replay”. Do not add a second control plane (Buzz remote-agent axiom: after start, conversation is the tether). Do not let heartbeat spawn writes.

---

### W3. Verifier-gated done / self-test as leased work

**Why.** Qwen: after each update, build/unit/E2E/desktop; failure returns to the issue. Buzz `_Stop`: object to `end_turn` while CI is red or todos remain — but their hook is advisory. Clem: **host-owned** evidence contract.

**Steal from.** Qwen self-test loop; Qwen Goal v3 `verifier_accept`; Buzz `_Stop` *idea*; Clem `delivery-committer.ts`.

**Files.**

- `src/runtime/harness/delivery-committer.ts`
- `src/runtime/harness/host-completion-work.ts`
- `src/runtime/harness/accepted-task-terminal-preparation.ts`
- `src/runtime/harness/verify-delivered.ts` (shadow/legacy — do not grow)
- Space preview / local write commit: `src/runtime/harness/host-local-write-commit.ts`, `src/spaces/space-preview.ts`
- `src/runtime/harness/claim-grounding.ts`

**Implementation.**

1. For **local_write / Space build / code** lanes: after the mutation, the host admits a verifier node (readback, test, preview) as expected work on the same accepted task. Failure is `repair_model` or `retry_host`, not `done` with a caveat.
2. For **external_write**: verifier is **readback / receipt**, never a second send. Ambiguous mutation parks (`HOST_TOOL_UNCERTAIN_BLOCKED_TEXT` already exists).
3. `end_turn` / `conversation_completed` is illegal while required verifier nodes are open. This is a host check, not an MCP `_Stop`. If you add a hook-shaped seam, it may only **object**; it may not **allow** a write the kernel would refuse.
4. Keep Fusion/debate as advisory. A green Fusion cannot mint `done`.

**Tests.**

- Local file write without readback → not `done`.
- Space build whose preview fails → new leased repair, same task id.
- Settled send + successful readback → `done` with receipt ids.
- Uncertain send → blocked, zero retries.

**Done when.** No foreground or background lane can publish `status: 'done'` without that lane’s evidence contract. `verifyDelivered` is not the authority (north-star migration step 5).

**Do not.** Implement Buzz-hooks fail-open (timeout = allow). Do not auto-send to “see if it worked”. Do not let `_Stop` MCP servers into the write kernel.

---

### W4. Adaptive depth and party split

**Why.** Speed and accuracy. Qwen `reasoning_effort`. Buzz party: Paul `xhigh` orchestrator, Duncan/Hayt medium executors (prompt-only difference), Thufir **different family** reviewer, Alia fast scout.

**Steal from.** Both. Clem `model-roles.ts` + `fallback-model.ts` + `debate-model.ts`.

**Files.**

- `src/runtime/harness/model-roles.ts`
- `src/runtime/harness/fallback-model.ts`
- `src/runtime/harness/debate-model.ts`
- `src/runtime/harness/host-turn-runner.ts` (frame class → role)
- Config / UI pickers that already write role bindings

**Implementation.**

Frame classes (host-owned, not model-declared):

| Frame | Role | Effort | Notes |
|---|---|---|---|
| Next-edge repair, schema wrap, account choice, readback | worker or current brain at **low** | cheap | Host should have done some of these without a call (W1). |
| Open discovery, plan author, contradictory evidence | brain | high / xhigh | |
| Fan-out item execution | worker | medium | Same model ok; prompt/scope differs. |
| Completion / plan review | judge | high, **cross-family** when available | Advisory only. |

Preserve **decision residues** across frames: refused call, edge issued, write settlement, verifier verdict. Do not dump raw chain-of-thought into the user bubble or into compaction authority.

**Tests.**

- A `repair_arguments` frame with host-known fields does not require the frontier brain.
- Judge family ≠ brain family when `judgeCrossFamilyEnabled` and a second provider exists (already partly true — make it the default path, not a hidden flag).
- Fallover still cannot fire after actionable output (`fallback-model.ts` contract).

**Done when.** Cheap frames are measurably cheaper (token/role metrics) without changing write-kernel outcomes. Role registry remains the only read point.

**Do not.** Add a fourth role enum without need. Do not let the worker role carry a wider write ceiling than the brain. Do not preserve thinking as execution authority.

---

### W5. Evidence may narrow a plan; it cannot widen writes

**Why.** Qwen quant loop: metrics disagree → prune; paths collapse → extra validation; ensemble worse → switch framework. Clem reviewed-plan is a rail. Keep the rail for **what may be written**.

**Files.**

- `src/runtime/harness/reviewed-plan-runtime.ts`
- `src/runtime/harness/accepted-plan-execution.ts`
- `src/runtime/harness/plan-artifacts.ts`
- `src/runtime/harness/confirm-first-gate.ts`
- North-star “course correction versions the task contract” (`north-star-unification.md` Durable long-horizon graph)

**Implementation.**

Host may, without a new approval:

- drop or reorder steps
- mark a step blocked with a next-edge
- add **read/compute** verifier steps (W3)

Host may **not** without a **new plan revision card** (not a per-write card):

- new destination, new send shape, new batch, new account, new irreversible verb

Commit conversation is for the staged packet **inside** the current plan. Widening is a new plan card (W0).

A user steer mid-write takes effect at the next **model** boundary, never by cancelling an in-flight external write ambiguously (already constitution).

**Tests.**

- Plan with 5 sends; evidence kills 2 → remaining 3 keep original approval; no new confirm-first.
- Adding a 6th send or a new recipient → confirm-first / needs_input.
- In-flight send + user “stop” → no second dispatch; partial Outcome.

**Done when.** Plan revision is a versioned contract on the same task id, with explicit evidence-carry policy (preserve / revalidate / invalidate) as the north-star graph already specifies.

**Do not.** Treat “the model changed its mind” as authority. Do not auto-approve a wider blast radius because the original plan was approved.

---

### W6. Failed gates become durable follow-up work

**Why.** Qwen multi-source evolution. Buzz: needs-action feed + heartbeat looks at it. Clem correction-hook + `/learn` exist but do not enqueue work.

**Files.**

- `src/runtime/harness/correction-hook.ts`
- `src/runtime/harness/next-edge.ts`
- Goal / task admission (accepted source, `src/runtime/harness/accepted-task-authority.ts`)
- Memory facts (source-tagged; cannot authorize)
- `src/runtime/harness/no-progress-governor.ts` terminals `ask_user` / `stop_factual`

**Implementation.**

Every terminal `ask_user`, `stop_factual`, confirm-first block, destination nudge, and user correction writes one **de-duplicated** durable item: `{ task-or-goal id, next-edge, evidence refs, source event }`. The same loop may claim it later (heartbeat / next turn / explicit “continue”). Dedup key is the consequence key from the no-progress governor, not the prose.

Learning (`/learn`, reflection) may **edit skills, prompts, ranking** — never gate code, never standing write grants.

**Tests.**

- Two identical schema refusals → one follow-up item.
- User correction of a credited answer → `not_useful` on the fact **and** a follow-up if a write was involved (existing correction-hook send/wrong-target regex stays).
- Claiming the item does not skip confirm-first.

**Done when.** A stuck gate always leaves either a user-visible `needs_input` Outcome **or** a claimable follow-up with an edge. Silent end is a watchdog failure (W2).

**Do not.** Let memory, skills, or learn-traces become execution authority. Do not scrape “community practices” into live write policy.

---

### W7. Activity feed: verb, object, outcome

**Why.** Buzz `VISION_ACTIVITY.md`. North-star Move 4 already wants one Outcome rendered by every transport. The UI still invites decoding transcripts.

**Steal from.** Buzz render classes: Message, File-edit, Shell, Tool lifecycle, Plan/Todo, Permission, Error. Mutate in place. Never go dark. Failures rise, reads recede. Resolve names not hashes.

**Files.**

- Console/mobile task/run views under `apps/console-web`, `apps/mobile-web`
- Event projections already fed by the eventlog — **do not invent a parallel log**
- `src/runtime/harness/delivery-committer.ts` presentation events

**Implementation.**

Every tool/lifecycle row answers: **what did she do, to what, what happened.** Running actions update one row (`pending → executing → done|failed`). Silence, idle, timeout are rendered states. The **Permission** class is the plan card and the one commit conversation — not a stack of per-write approvals. During dispatch, writes are **receipts** (verb + object + outcome), same as Buzz “Sent a message to #design.” Raw rail stays available; it is not the default.

Semantics over transport: a Gmail send via Composio and a send via a future adapter render as the same “Sent mail to X → receipt” card.

**Tests / verification.**

This is UI. Per user rules: exercise in the browser, not a screenshot-only check. Empty, error, running, needs-you, and done states. Desktop and mobile viewports.

**Done when.** A supervising user can judge progress without reading tool JSON. Engine events remain the source of truth; the feed is a projection.

**Do not.** Infer running/done from assistant prose (`PRODUCT.md`). Do not hide errors. Do not add a second activity store.

---

### W8. Identity-scoped workers and inbound owner gate

**Why.** Buzz: each agent has a key, membership, audit; inbound `owner-only` by default; owner commands never reach the model; one identity, N bodies, one-in-flight per channel.

**Files.**

- Worker spawn / `run_worker` session inheritance (`apps/console-web` sessions-api comment: workers inherit parent session)
- `src/runtime/harness/brackets.ts` AsyncLocalStorage
- Autonomy / mention / Discord inbound
- Owner interrupt paths (steer, stop, cancel)

**Implementation.**

1. Workers keep **parent session for gates** (confirm-first batch counts across workers — already the point of ALS). Give each worker a **distinct attempt/lease identity** in the audit trail.
2. A session/task is never processed by two brains at once (Buzz queue invariant). Steers queue; they do not start a second executor.
3. Owner control (`stop`, `cancel`, `continue`, approval) is harness-consumed, exact-match, not interpolated into the model prompt as if it were content.
4. Inbound default remains the owner. Do not add `anyone`. Discord/other transports are still thin I/O on the one core.

**Tests.**

- Two workers, one parent: confirm-first threshold counts both.
- Second `runConversation` on the same accepted source while the first is live: rejected or queued, not parallel writes.
- `stop` during a tool: lease revoked; unknown in-flight write is not retried.

**Done when.** Audit can answer “which worker, which lease, which parent source” for every crossing. Owner stop never depends on the model cooperating.

**Do not.** Mint a second user-visible “agent roster” product. Do not give workers a weaker write kernel.

---

### W9. Host-owned stop / post-compact — not MCP-advisory writes

**Why.** Buzz hooks are the right *lifecycle points* and the wrong *enforcement model*.

**Files.**

- `src/runtime/harness/compaction.ts`
- `src/runtime/harness/delivery-committer.ts`
- `src/runtime/harness/host-turn-runner.ts`

**Implementation.**

Map:

| Buzz hook | Clem host point | Authority |
|---|---|---|
| `_Stop` | before honoring model `done` / `end_turn` | Host evidence contract (W3). Objection is mandatory when evidence is missing. |
| `_PostCompact` | after compaction bracket, before next model request | Re-inject **authority residues only**: accepted goal, graph cursor, open edges, unsettled writes, approvals. Compaction already forbids compacting those (`north-star-unification.md` Compact prose; never compact authority). Make the re-inject explicit and tested. |

Optional later: MCP servers may register **advisory** `_Stop` text (CI red, todos) that is concatenated into the objection **in addition to** the host contract. Advisory timeout = no extra text, **never** an allow. Rejection budget must **not** let the model stop while an external write is unsettled.

**Tests.**

- Compaction crash leaves incomplete bracket, not success (already required).
- Post-compact prompt still contains open approval + unsettled write ids.
- Model `done` with open verifier node → host objects, continues.

**Do not.** Port `buzz-hooks` fail-open into Clem. Do not let a plugin allow a send.

---

### W10. Reply / report-back guard

**Why.** Buzz `BUZZ_AGENT_REQUIRE_REPLY`: a turn that did work and never published is a silent failure. Clem north-star Move 4: no silent end. Buzz is honest that the guard is advisory (at most two reminders) and recognizes **attempt** not success.

**Files.**

- `src/runtime/harness/delivery-committer.ts`
- `src/runtime/harness/host-completion-work.ts`
- Watchdog (W2)

**Implementation.**

If the turn mutated local state or scheduled work and produced no public Outcome, the host:

1. Reminds once with the exact missing evidence / next-edge.
2. If still silent, the **watchdog** publishes `blocked` or `failed` itself (north-star: “if a run produces no Outcome, the watchdog emits one”).

Do not nag a turn that only reasoned, or that correctly waited on `needs_input`. Do not treat a failed send attempt as a successful publish (Buzz inspects command text; Clem inspects settlement).

**Tests.**

- Local writes + no Outcome → reminder then host terminal.
- `needs_input` awaiting the **commit conversation** or a plan card → no reminder.
- `needs_input` awaiting a per-write approval card → that state should not exist after W0; treat as a bug, not a quiet wait.
- Failed send settlement → Outcome `blocked` with receipt, not `done`.

**Done when.** Zero silent ends on accepted sources (restart soak already in the north-star release gate).

---

### W11. Could: JSON agent surface and compiled workflows

**Lower priority.** Do after W1–W10.

- Keep tools JSON-in/JSON-out; never leak protocol into user bubbles (already law).
- Reviewed plan → frozen **read-only** orchestration DAG for later turns (Qwen Dynamic Workflows). Writes still go through the lease.
- Workflow `request_approval`: persist token, `WaitingApproval`, `execute_from_step` on grant. **Do not copy Buzz WF-08.** The grant is the same **bundle commit** as W0, recorded in the approval registry — not a per-step tool card.

**Do not.** Add `buzz-cli` as a product. Do not YAML-ize the host kernel.

---

### W12. Could: disposable bodies, durable identity

**Lower priority.** Buzz remote agents: the log is home; the process is a body; scratch dies; inactivity self-reaps.

Clem already has a daemon body. Steal only:

- Task/session identity survives process restart (already the moat — prove it, do not rebuild it).
- Worker scratch is not authority; receipts on the eventlog are.
- Idle remote/background workers exit after a host timer; the accepted source remains claimable.

**Do not.** Build Kubernetes providers, Nostr presence dots, or a second management plane.

---

## 7. Write-safety overlay (apply to every workstream)

| Situation | Legal recovery | Illegal recovery |
|---|---|---|
| Schema miss on **read** or local write; host can wrap/rename unambiguously | Host auto-repair + schema re-validate | Guessing extra fields |
| Schema miss on **send / admin** | `repair_arguments` back to the model | Host inventing the payload |
| Confirm-first / per-write approval | Plan card + W0 commit conversation | skip, YOLO because the plan was approved, or mint a card per send |
| Staged bundle dest/args drift after grant | repair that item; do not send it | silent send, or a new per-write card |
| Widen blast radius mid-run | new **plan revision** card | per-write cards, or dispatch anyway |
| Credential / account / destination not unique | one conversational `needs_input` choice | approval card, or guess |
| Destination / grounding | make target explicit, or `ask_user` | publish to ambient cwd / implicit upstream |
| Constraint | `choose_other_capability` or `publish_partial` | violate the constraint |
| Uncertain external write | `do_not_retry` + reconcile/readback | replay the same call |
| Known-settled write | continue; never re-dispatch | “retry to be sure” |
| Unstarted call, lease revoked | `reissue_unstarted` new call id | reuse the revoked generation |
| Watchdog stall, no crossing | reissue | — |
| Watchdog stall, unknown write | park + reconcile | second dispatch because no stream event |
| Compaction | summarize prose only | compact leases, receipts, edges, approvals |
| Learn / reflection | skill and ranking updates | standing write grants, gate-code edits |
| Fusion / judge | one evidence-backed correction | second executor, completion authority |
| Heartbeat / autonomy | read needs-action; stop if none | invent sends |
| `_Stop`-shaped objection | block `done` until evidence | timeout = allow write |
| Recovery step | keep accepted-turn advertised tools; refuse off-permitted at admission | shrink `modelStepSchemas` to `recoveryTools` |
| Direct call of a reachable name not in `toolByName` | carry through carrier at admission; sealed name stays | “tool not found”, or rewrite `call.name` |

---

## 8. Sequence

Land in this order. Each step is independently reviewable. Do not skip ahead to W7/W11 because they are more visible.

| Order | Workstream | Depends on | Why this order |
|---|---|---|---|
| 1 | **W0** stage-then-commit | — | Product split. Stop minting per-write cards. Plan card + rehearsal + one conversational review. |
| 2 | **W1** next-edge everywhere | W0 (refusals during rehearsal must name the next legal move, not a card) | Unblocks “never stuck at a gate” without bringing cards back. |
| 3 | **W1a** recovery advertised-list stability | W1 | ~10/day live. Do not shrink the tools block; the selection rule is already correct. |
| 4 | **W1b** off-surface direct calls carried at admission | W1, W1a | ~9/day live. Carry through the carrier at admission; keep the sealed call. |
| 5 | **W2** lease watchdog | W1 (reissue/reconcile edges) | Kills silent stalls **and** duplicate writes **during dispatch**. |
| 6 | **W3** verifier-gated done | W0, W1, W2 | Rehearsal verifiers + dispatch readback. Packet is not “done” until evidence. |
| 7 | **W10** report-back guard | W2, W3 | North-star “no silent end” becomes true. |
| 8 | **W9** post-compact residue inject | W3 | Compaction already has the law; make re-inject testable. Include staged-bundle digest. |
| 9 | **W4** adaptive depth / party | W1 | Speed; cheap frames are mostly W1 repairs. |
| 10 | **W5** plan may narrow | W0, W3 | Intelligence without widening writes; widen → plan card, not write cards. |
| 11 | **W8** worker identity + owner commands | W2 | Parallelism without double brains; workers compose-only until commit. |
| 12 | **W6** failed gates → durable work | W1, W10 | Outer self-improving loop. |
| 13 | **W7** activity feed | W0, W3, W10 | Receipts during dispatch; Permission class is plan + commit only. |
| 14 | **W11** compiled workflows | W5 | Optional. |
| 15 | **W12** disposable bodies | W2, W8 | Optional. |

Do not start W7 before W0 and W3: a pretty feed of approve-buttons is the old product. A pretty feed on polite-fail `done` is a lie.

---

## 9. Acceptance matrix

A workstream PR is not done until its row is green. World-state assertions beat model self-report (north-star release gate).

| ID | World-state assertion |
|---|---|
| W0 | Plan → Execute of N sends: 0 `approval_requested` per `logicalToolCallId`; N staged artifacts; ≤1 commit `needs_input`; after conversational send, N crossings and N receipts. Surprise send: 0 cards, 0 crossings. Widen: plan revision card only. Browser: no post-Execute approve-button stack. |
| W1 | Every `replan` refusal in the characterization suite carries `HostNextEdgeV1`; inner tool ≠ wrapper; 2026-09-11 `call_tool` loop is red if reintroduced. |
| W1a | Recovery steps do not change the advertised method set vs the accepted-turn array. `recovery_surface_reprompt.available` still contains structural carriers. Selection-rule tests unchanged. Fixture where `tools` omits `call_tool` is red. |
| W1b | Direct call of a carrier-reachable name absent from `toolByName`: one settlement, sealed name unchanged, `tool_output_query` works, occurrence count 1. Unreachable names still `not_reachable`. Sealed remap to `call_tool` is red. Carried send in rehearsal: 0 crossings. |
| W2 | Mid-write daemon kill + restart → exactly-once external crossing; stall without stream events → no second send. |
| W3 | Local/Space mutation without verifier ≠ `done`; uncertain send ≠ `done`; settled send + readback = `done` with receipt ids. |
| W4 | Repair frames do not require frontier effort; judge ≠ brain family when a second provider exists; fallover still pre-content only. |
| W5 | Narrowing the staged packet does not mint write cards; widening mint a **plan revision** card, not N write cards. |
| W6 | Duplicate gate failures collapse to one follow-up; follow-up cannot skip write gates. |
| W7 | Feed rows are projections of eventlog; running/done never inferred from chat text; browser-verified empty/error/running/needs-you/done. |
| W8 | Two workers share confirm-first count; one accepted source, one live brain; owner stop revokes lease. |
| W9 | Post-compact prompt still contains unsettled write + staged-bundle digest + open plan/commit need; plugin cannot allow a kernel-illegal send. |
| W10 | Accepted source always reaches exactly one terminal Outcome, including after restart (existing soak). |
| Overlay | Mutation crash/retry tests: zero duplicate external writes (existing north-star tag gate). |

---

## 10. Anti-goals

- Re-architect the loop. One `runConversation` → `runTurn` / host-turn-runner.
- Import Buzz as a dependency, crate, or protocol.
- Add Nostr, git forge, huddles, mesh GPUs, or public agent directories.
- Let the model rewrite `confirm-first-gate.ts` / `dispatch-lease.ts` in the live process.
- New per-call refusal walls without edges (the 44% discovery-denial failure).
- “Keep going” that retries unknown writes.
- Advisory hooks as the security boundary.
- A second Outcome, second activity log, or UI-inferred run state.
- Expanding PRODUCT.md bindings (new channels, hardcoded tool lists).
- Per-write `approval_requested` cards after Execute (“just for sends”, “just for deletes”, “just until Auto is trusted”).
- Treating Execute on a plan card as a standing grant to cross immediately.
- Replacing cards with the same Approve/Reject chrome in a chat bubble.
- Sending first and asking to review after.
- Retuning `hostNoProgressRecoveryToolNames` to paper over a missing carrier in `tools`.
- Rewriting a sealed `call.name` to `call_tool` so receipts no longer match the model’s call.

---

## 11. Noun mapping (so you do not invent a third vocabulary)

| Qwen / Buzz noun | Clem noun | Owner |
|---|---|---|
| Issue `ready → leased → active` | Accepted source + dispatch lease | host |
| Watchdog / monitor | `dispatch-lease` + workflow/background watchdogs | host |
| Self-test / `verifier_accept` | Expected work + readback + delivery-committer | host |
| Next legal move after a block | `HostNextEdgeV1` | host |
| `_Stop` objection | Host evidence contract before `done` | host |
| `_PostCompact` | Compaction residue re-inject | host |
| Heartbeat | Autonomy / goal-resume tick | host; yields to user + in-flight leases |
| `@mention` | User / owner message on origin session | transport |
| `!cancel` / `!shutdown` | Owner stop / cancel; harness-consumed | host |
| Party (Paul/Duncan/Thufir/Alia) | `brain` / `worker` / `judge` + effort | `model-roles.ts` |
| Core memory | Durable facts / session preamble | memory; never authority |
| Cold memory | Recall capability | memory; never authority |
| Activity feed | PresentationEvent / console+mobile projections | UI, read-only |
| Relay | Eventlog + daemon | host |
| Body | Process / worker / daemon instance | disposable |
| Agent identity | Accepted source + session + lease generation | durable |
| `request_approval` | **One** bundle-commit grant (W0), recorded in the approval registry | host; persist and resume; not per-call cards |
| Planning card | `publish_plan` + Execute on an exact revision | the only structured card |
| Staged packet | Artifact ledger + digest; local/Space saves | host; zero external crossings until commit |
| Commit conversation | Origin-session `needs_input` in Clem’s voice | user; one review of the packet |
| Dispatch | Leased physical crossings + receipts | host; no cards |
| Recovery advertised list | Accepted-turn tool array, stable | host; do not shrink on recovery |
| Off-surface direct call | Carried invocation at admission | host; sealed name stays authored; carrier reachability runs |
| `buzz-cli` JSON | Tool invoke JSON | tools; not user-visible |
| Dynamic Workflow | Frozen reviewed-plan DAG | host; writes still leased |

---

## 12. Open questions (do not silently decide)

If an implementing agent hits one of these, stop and ask the owner:

1. **Should cheap-frame routing (W4) be default-on**, or staged behind a kill-switch that soaks then deletes (house law: no permanent flags)?
2. **Follow-up items (W6)** — new goal records, or reuse accepted-task continuation capsules?
3. **Cross-family judge** — require a second configured provider, or skip W4’s reviewer split when only one brain exists?
4. **Heartbeat** — after autonomy v1/v2 collapse (already planned), is the remaining goal-resume tick the only heartbeat, or does chat also idle-scan?

5. **Commit chrome** — is a single “Send packet” control on the commit turn allowed, or must the user type “send it”? Default if unanswered: **one packet control is allowed**; per-item Approve/Reject is not.
6. **Provider drafts** (Outlook draft-id, Gmail draft) — staging or already an external write? Default if unanswered: **external create**. Only use them when the plan named drafts; the commit conversation is what **sends**.

Until answered, implement **W0** with those defaults, then **W1, W1a, W1b**, then W2–W3–W10. Do not wait on W4/W6/W11. W1a/W1b are live ~19 stuck turns/day; they do not need owner product decisions.

---

## 13. Suggested first PR (if you are starting now)

**Title:** `W0: stage the packet, one conversational review, no per-write cards after Execute`

**Scope:**

1. Inventory every post-Execute `approval_requested` emitter. Characterization tests: N planned sends must not mint N cards (red today, green after).
2. Add a host `rehearse` phase: high-consequence intended crossings write staged artifacts (operation, args digest, destination, account, preview). Physical send/admin is refused until commit.
3. When the packet is ready, one origin-session `needs_input` in Clem’s voice with artifact refs. Optional single “Send packet” control. No per-`logicalToolCallId` card.
4. On commit, one grant over the packet digest; matching staged calls dispatch under existing leases; drift repairs that item.
5. Keep the planning card. Do not touch watchdog, effort routing, or the activity-feed redesign.

**Out of scope:** W1 edges (follow immediately after if rehearsal refusals are prose-only), W1a/W1b (own PRs; do not mix sealed-identity work into consent), W7 feed polish, compiling workflows.

That PR is the product in miniature: Clem does the work, saves it, asks once, then writes. The kernel stays leased and one-shot; the user stops holding hands.

**Immediate follow-on (reliability, can run as a second PR while W0 soaks):**

- **W1a:** stop assigning `modelStepSchemas = serializedTools(recoveryTools)`. Keep the accepted-turn array. Use existing `recovery_surface_reprompt` logs; do not retune `hostNoProgressRecoveryToolNames`.
- **W1b:** at `toolByName` miss, carry through `call_tool`/`work_call` with that carrier’s reachability; never rewrite the sealed `{ callId, name, arguments }`.
