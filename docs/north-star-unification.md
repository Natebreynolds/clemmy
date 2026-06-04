# Clementine — North-Star Unification

*One Clem who lives in the harness: lightweight prompt, code does the heavy lifting, learns forever, handles any task, and always reports back — identically across desktop, Discord, and mobile.*

## The problem in one sentence

Clem is **forked across two cores** — the chat core (`assistant/core.ts` → `instructions.ts`) and the harness core (`runtime/harness/loop.ts` → `agents/harness-context.ts`) — with **duplicated self-assembly**, **per-path report-back**, **two Discord handlers** (`discord.ts` vs `discord-harness.ts`, gated by `DISCORD_HARNESS_ENABLED`), a **dashboard that mixes both cores**, and a habit of **dragging one-off actions through heavyweight machinery** (the live example: a "send a test email" desktop chat self-escalated into tracked execution `T-166`, run by the harness controller, still `active` and queued for re-review — ~56K tokens for one test email).

The result is drift, wasted tokens, inconsistent behavior per surface, and a learning loop that writes everywhere but only surfaces on one path.

What's **already right** (don't touch): the multi-agent / fan-out execution topology, the shared learning *store* (tool-choices remember + recall work on every path), the tool-agnostic substrate (search / recall / skill_read / $PATH / MCP), and the Phase-0 reliability just shipped (wall-clock recovery, honest report-back, between-turn checkpoint).

## Target shape — layers, not forks

```
Transports (thin I/O):   Desktop    Discord    Mobile    CLI    Cron/Webhook
                              \         |         |        |        /
                               ▼        ▼         ▼        ▼       ▼
                     ┌──────────────  ONE INGRESS / GATEWAY  ──────────────┐
                     │   auth · session · transport adapter · streaming     │
                     └───────────────────────┬──────────────────────────────┘
                                             ▼
                     ┌────────────────  ONE AGENT CORE  ────────────────┐
                     │  renderClemContext()   one self-assembler         │  ← constitution (small) + memory (heavy)
                     │  altitude router       ad-hoc · tracked · fan-out │  ← stops over-escalation
                     │  execution loop        parameterized + reliable   │  ← wall-clock recovery, checkpoint
                     │  learning loop         recall→act→remember→reflect │  ← never forgets
                     └───────────────────────┬──────────────────────────┘
                                             ▼ every run produces an
                     ┌────────────────  ONE Outcome  ───────────────────┐
                     │  {status, summary, artifacts, needs, nextStep}    │
                     │  deliverOutcome() → append to ORIGIN session      │  ← always fires; backstopped
                     └───────────────────────┬──────────────────────────┘
                                             ▼ transports render session turns
                              Desktop card · Discord msg · Mobile push  (same structure)
```

The unification is the **self, the entry, and the report-back** layers — **not** the execution topology. Single-loop chat and multi-agent fan-out remain two *modes* of the one core. Fan-out stays.

---

## The six moves (each maps to a goal)

### Move 1 — Prompt = Constitution (small, stable) + Context (learned, dynamic). Behavior lives in code.
*Goal: fast, lightweight, token-efficient; code does the heavy lifting.*

- **Constitution** = a tight system prompt: her voice + the non-negotiables (report back, ask when unsure, approval before irreversible). Small and **stable → prompt-cached** (`prompt_cache_key` already keyed by session).
- **Behavioral RULE prose moves to code** (prompt rules rot — `[[feedback_code_level_over_prompt]]`):

  | Prose in `instructions.ts` today | Code home |
  |---|---|
  | "reached your budget… want me to continue?" | the Outcome / report-back layer (Move 4) |
  | "for large/risky work call surface_plan" | altitude router (Move 3) |
  | "tool behavior — just call them" | tool schemas already enforce this |
  | "sub-agent handoffs (researcher/writer/…)" | the execution loop already routes |
  | "background outcome report-back" (~650 chars) | the Outcome contract makes it structural |

- Net: the prompt drops from ~3.5k of rule-prose + duplicated context to a tight constitution + **one** scoped context block. The personality stays — it just stops being a checklist.

### Move 2 — One self-assembler. Personality & skills come from memory, not prose.
*Goal: she never forgets, always learns, gains personality + skills.*

- Collapse `buildAssistantInstructions` (`instructions.ts`) **and** `renderHarnessMemoryContext` (`harness-context.ts`) into **one** `renderClemContext(params)`. Every entry point and execution mode calls it → identical facts, recently-learned, remembered tool-choices, and voice everywhere. Kills the fork and the drift (today my P1-E ★-ranking only landed on the harness side).
- **Personality** grows from: `SOUL.md` seed + learned user-profile + reflection-captured voice — not a bigger prompt.
- **Skills** grow from the tool-choice store (procedural memory): learn what works for an intent, remember it, recall it.

### Move 3 — One altitude router: ad-hoc · tracked · fan-out.
*Goal: handle any task, however long/hard — without over-escalating the trivial.*

- A one-off "send a test email" must **not** spawn a tracked execution + controller + synthesis + scheduled review (what `T-166` did). A single code-level router reads observed signals (mutating? multi-item? long-running? user said "track/schedule this"?) and routes:
  - **Light lane** (default): recall → act (approval if irreversible) → **log** → report. One turn. One-offs stay one-offs (`[[feedback_user_owns_workflow_designation]]`, `[[feedback_no_unrequested_workflow_runs]]`).
  - **Execution lane** (harness): genuinely long / multi-step work; inherits Phase-0 reliability + fan-out for breadth. Any task, however long/hard.
- The "audit record of a mutating send" instinct is **good** — keep it as a **lightweight log line**, not a managed execution.

### Move 4 — One Outcome contract + one `deliverOutcome`.
*Goal: ALWAYS reports back, or asks for clarity — and all three transports share the same structure.*

- Define one type: `Outcome = { status: 'done'|'blocked'|'needs_input'|'failed'|'progress', summary, artifacts[], needs?, nextStep?, evidence }`.
- **Every** lane (chat turn, background task, workflow, cron) produces an `Outcome`.
- **Delivery = append a structured Outcome turn to the ORIGIN session.** The seed already exists: `enqueueWorkflowOutcomeTurn` (`workflow-runner.ts:2241`) + `originSessionId` threading. Transports already *render session turns*, so one structure → desktop card, Discord message, mobile push, with transport-specific formatting only.
- **The guarantees ("ALWAYS"):**
  - *No silent end* — if a run produces no Outcome, the watchdog emits a `failed`/`blocked` one (I just fixed the hollow-`done` form of this in Phase 0).
  - *Gets clarity when off-track* — a `needs_input` Outcome routes back to the origin conversation; she asks instead of guessing.
- This is literally "all 3 paths share the same report-back structure."

### Move 5 — Close the learning loop reliably.
*Goal: never forgets, always learning.*

- **recall-BEFORE-discover** at the decision point, keyed on **toolkit + operation** (not the brittle query string that missed on 06-04: recalled `salesforce.query.email.audit`, memo was `salesforce.accounts.query_…`).
- remember-on-success / invalidate-on-failure (exist) + reflection → facts (exists), default-on, surfaced in the one assembler (Move 2).
- between-turn + cross-run checkpoint (Phase 0 started this) so long / interrupted work resumes from progress.

### Move 6 — Thin transports, one ingress, mobile nearly free.
*Goal: trim code; keep desktop + Discord, add mobile later; all sharing one report-back.*

- Transport adapters become **pure I/O**: receive → call the one core → `deliverOutcome`. No self-assembly, no business logic, no per-path report-back.
- **Retire the dual Discord handler** (`DISCORD_HARNESS_ENABLED`, `discord.ts` vs `discord-harness.ts`) → one Discord adapter on the one core.
- **Collapse the dashboard's mixed cores** → one desktop adapter.
- The **gateway/router** (`gateway/router.ts`) becomes the single ingress; **mobile is just another client of it** → mobile support is mostly free once the core is unified.

---

## More conversational, more personality

With **safety in code** (the gates) and **behavior in the Outcome layer**, the constitution can be **warm and characterful** instead of rule-laden — she reads as an assistant who *gets it*, not one reciting a checklist. **Conversational routing** (`[[project_conversational_routing]]`) — converse → one approval → autonomous run → come back only when irreversible or stuck — falls out of Moves 3 + 4. Personality **deepens over time from memory** (Moves 2 + 5), not from a longer prompt.

## Sequencing — additive, no churn, fan-out untouched

| Phase | Move | Why this order |
|---|---|---|
| **0 (done)** | Reliability: wall-clock recovery, honest report-back, checkpoint, discovery advisory | Foundation; ship + soak |
| **1** | Move 4 — Outcome contract + `deliverOutcome` | Highest leverage; makes "always reports back" structural; unifies the 3 paths first |
| **2** | Move 2 — one self-assembler | Collapse the two; **byte-identical fallback**; migrate per entry point |
| **3** | Move 3 — altitude router | Stop the over-escalation; one-offs stay light |
| **4** | Move 6 — thin transports; retire dual Discord + mixed dashboard; mobile adapter | Once core + report-back are unified |
| **5** | Move 1 — slim the prompt | **Last** — only delete rule-prose once its code home exists |

Each phase: flag-gated → validated with characterization tests → default-on → **flag removed** (no permanent sprawl, `[[feedback_no_rollout_flags]]`). The multi-agent / fan-out topology is untouched throughout (`[[feedback_no_architecture_churn]]`).

## North-star check (the five non-negotiables)

- **Ever-learning** ✓ Move 5
- **Long-running without failing** ✓ Phase 0 + Move 3
- **Token-efficient** ✓ Moves 1 + 2
- **Global / no curated lists** ✓ tool-agnostic substrate (kept)
- **Reports back without fail** ✓ Move 4

> The over-engineering was never her prompts. It was the **machinery she drags a one-liner through**, and the **fork** that makes her two slightly-different people. Unify the self, route by altitude, report back through one structure — and trim the prose only after the code can carry the weight.
