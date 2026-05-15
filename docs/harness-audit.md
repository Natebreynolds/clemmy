# Harness Intelligence Audit — May 2026

A strategic look at how Clemmy responds to user requests today, what
best-in-class agentic harnesses (Claude Code, OpenHands, OpenAI Agents
ChatGPT mode) do differently, and the smallest set of changes that
close the biggest gaps without bloating the codebase.

The goal is intelligence, not features. Every gap below has a thin
intervention point — usually one file edit, not a new subsystem.

---

## Where we stand

We have **two response paths**, and they have very different intelligence:

| capability | chat path (`assistant/core.ts`) | autonomy path (`agents/autonomy-v2.ts`) |
| --- | --- | --- |
| handoffs to sub-agents | ❌ none | ✅ orchestrator + 5 sub-agents |
| structured output | ❌ free text | ✅ Zod `outputType` |
| guardrails | ❌ none | ✅ output guardrails |
| tool pruning | ❌ all ~70 tools always | ✅ allowlist per sub-agent |
| planning step | partial (`analyzeExecutionIntent`) | partial (instructions only) |
| verification step | ❌ none | ❌ none |
| feedback loop on past behavior | ✅ proposal feedback block | ✅ proposal feedback block |
| streaming | ✅ deltas + reasoning | n/a (one-shot) |
| run tracking | ✅ via `runId` | ✅ `recordAutonomyDecision` |

The chat path is where **every user message lands**. It is the less
intelligent of the two.

---

## The seven gaps

### Gap 1 — Chat path doesn't route. It dumps.

`runtime/openai.ts:createAgent` constructs an Agent with `tools:
getCoreTools()` — all ~70 tools, every call. No matter whether the user
typed "hi" or "set up a deployment pipeline." There are no handoffs.
The orchestrator + sub-agents you already built (`agents/sub-agents.ts`)
are only wired into autonomy.

**Impact:** every chat turn pays the cost of a 70-tool schema in the
system prompt and asks the model to self-select. The model gets it
right most of the time, but the prompt is bloated and routing is
implicit.

**Best-in-class:** Claude Code uses Plan / Explore / general-purpose
subagents for distinct intelligence shapes. Tools are sometimes
deferred (`ToolSearch`) so they aren't even in the prompt until needed.
A 70-tool prompt is a code smell.

**Thin fix:** add `handoffs: defaultOrchestratorHandoffs(...)` to the
chat-mode `Agent`. ~5 lines in `runtime/openai.ts`. Chat suddenly can
hand off to Researcher for lookup, Executor for action, Reviewer
before risky writes. The sub-agents already exist.

### Gap 2 — Intent detection is one regex.

`assistant/message-intent.ts` is six lines. It tells us "is this a
casual hi?" That's the entire intent layer for chat. There's no signal
distinguishing "answer me from memory" from "set up Discord webhook"
from "review my Friday plans."

**Impact:** every non-casual message gets the same treatment —
vault search, working memory, session brief, full tool list, full
instructions. Most messages don't need most of that.

**Best-in-class:** harnesses classify intent (often via a small LLM
call or a typed first-turn step) and curate context to it. Aider has
`/ask` vs `/code`. Claude Code's Skills system surfaces *only* the
capability the user invoked.

**Thin fix:** expand `message-intent.ts` from a single boolean to a
small enum: `casual | lookup | action | meta_clarify | tool_intent`.
Done locally with regex + heuristics (no extra LLM call). Each class
maps to a context-curation profile (skip vault search on `casual`, skip
tools on `meta_clarify`, etc.). One file, ~50 lines, no new
infrastructure.

### Gap 3 — No planning step before execution.

When the user asks for something multi-step, we ask the LLM to *think
about it inside its reply text*. `analyzeExecutionIntent` decides
whether to wrap the reply in execution tracking based on keyword
matches ("build", "implement", "deploy"). There's no separate planning
turn where the agent thinks out loud, drafts a plan, and the user can
inspect/edit it before action.

**Impact:** for the 80% case, this is fine — the LLM plans inside its
reply. For the 20% case (complex multi-system work), we get
half-thought-through execution. We have a `PlanStore` and
`refineActivePlanFromMessage`, but they're invoked after the response,
not before action.

**Best-in-class:** Claude Code's Plan agent is a separate run that
returns *only* a plan, then the main agent executes against it. The
plan is inspectable. OpenHands' CodeAct is the same pattern.

**Thin fix:** when intent === 'action' and `executionIntent.shouldTrack
=== true`, do a fast pre-flight Plan handoff (already exists as the
Researcher pattern, just needs a planner variant) before the main run.
Surface the plan in the run timeline (already there via `addRunEvent`).
~30 lines.

### Gap 4 — Nothing verifies the work.

After tools run, no agent checks "did this achieve what the user
asked?" The agent runs the loop, writes a reply, done. If the file
write was wrong or the workflow broke a previous step, we find out the
next time the user notices.

**Impact:** the agent declares done too easily. Compound progress
across cycles works for autonomy but not for chat, where the user is
waiting.

**Best-in-class:** the Reviewer pattern. After a multi-step action,
hand off to a read-only auditor that returns "looks good" or "I see
this issue." Claude Code does this implicitly via its own attention to
verification; explicit sub-agents make it audible.

**Thin fix:** you already have `buildReviewerAgent()`. Add an
end-of-turn handoff: if the orchestrator called write tools or
execution tools, hand off to Reviewer before returning text. ~15 lines
in the orchestrator instructions. Reviewer is cheap (`MODELS.fast`)
so the latency cost is modest.

### Gap 5 — Context assembly always runs full.

`assemblePromptContextAsync` always fetches working memory, session
brief, vault search (FTS + embedding rerank if key present). Even for
"thanks" or "good morning." The casual-checkin branch suppresses
*some* of this but the call still happens.

**Impact:** every message pays ~200ms of memory I/O it usually doesn't
need. More importantly, the LLM gets a wall of "Relevant vault
context" that's often noise.

**Thin fix:** drive memory budget off the intent class from Gap 2.
`casual` → no vault hits, working memory only if it has a brief.
`lookup` → vault search top-3 only. `action` → full. Same function,
different `topK` / `formatBytes` per class. ~20 lines.

### Gap 6 — Clarification is over-discouraged.

The autonomy instructions say "`ask_user_question` ONLY when you
genuinely cannot proceed." Chat instructions don't have a comparable
directive at all — the assistant tries to act on ambiguous input
rather than spending one round on a clarifying question.

**Impact:** the agent ships sub-optimal answers because it didn't
spend one turn asking which of two interpretations the user meant.
You've seen this in practice — it picks the wrong reading and we
backpedal.

**Best-in-class:** Claude Code uses `AskUserQuestion` for branches
where the answer materially changes what gets done. The model is
trained to know when ambiguity is costly enough to warrant a question.

**Thin fix:** in chat instructions, add a directive like: "When the
user's request has two plausible interpretations that lead to
materially different work, ask one short clarifying question before
acting. Avoid asking for confirmation on routine choices with a clear
default." Two lines in `assistant/instructions.ts`.

### Gap 7 — Tool results aren't curated.

Every MCP tool returns whatever it wants. Some return 50 lines, some
return 5KB JSON dumps. These all land in the next-turn context.

**Impact:** for long sessions, the context window fills with raw tool
output. The model loses track of what mattered.

**Thin fix:** add a result-cap wrapper around `textResult()` in
`tools/shared.ts` — anything over N chars gets truncated with a
`(...truncated, N chars total)` marker. ~10 lines in one file. No
behavior change for normal results; safety net for runaway ones.

---

## What we already do well

Worth naming so we don't accidentally regress:

- **Persistent memory with embedding rerank** (`memory/recall.ts`) —
  better than most.
- **Approval interruption flow** (`runtime/approval-store.ts`) —
  clean. The SDK handles state preservation, we resume cleanly.
- **Streaming with reasoning visibility** (`runtime/openai.ts
  runStreamed`) — modern.
- **Sub-agent allowlists per role** (`agents/sub-agents.ts
  SUB_AGENT_TOOL_ALLOWLISTS`) — tools are pruned correctly *if* you go
  through autonomy. Just needs to be wired to chat.
- **Proposal learning loop** (just shipped) — agent reads its own
  approve/reject signal back. Hopefully a template for other learning
  signals.
- **Run events / observability** (`runtime/run-events.ts`) — full
  timeline per run. Most harnesses are blind.
- **Output guardrails** (`agents/autonomy-guardrails.ts`) — autonomy
  has them; chat could borrow the pattern.

---

## The path that does the most with the least

If we picked just three to address now, in order:

1. **Gap 1** (wire sub-agents into chat). This single change cascades.
   Suddenly Gap 4 (verifier handoff) becomes trivial because handoffs
   exist. Gap 3 (planner) becomes a sibling of Researcher rather than
   a new system. ~5 lines + verify in autonomy-v2 prompt already
   teaches the model when to hand off.

2. **Gap 2** (richer intent classifier). Unlocks Gap 5 (context
   curation) and Gap 7 (tool pruning at request time). One file
   touched, no new dependencies.

3. **Gap 6** (clarification directive). Single sentence in
   `instructions.ts`. The lowest-cost intelligence boost — costs zero
   inference time, just shifts the model's bias slightly.

Three changes, ~80 lines total, no new files, no new subsystems. We'd
land within striking distance of Claude Code's intelligence shape for
chat — and the autonomy path is already there.

The harder ones (Gap 3 planner, Gap 4 verifier, Gap 7 truncation) are
all next steps after that, and each is an independent slice.

---

## What we are NOT going to do

- Replace the SDK runtime. The OpenAI Agents SDK is doing its job. The
  intelligence we're missing is in how we use it, not what it is.
- Add a separate LLM call for routing/planning if we can avoid it.
  Latency and cost matter. Heuristic intent + outputType in the main
  run can carry most of this.
- Build a "decision graph" / state machine. The instructions + handoffs
  pattern already encodes decisions. Adding a graph layer is what we
  do when prompts can't carry the policy. They can.
- Introduce another memory store. We have enough memory primitives;
  what we lack is curation discipline (Gap 5).

---

## Next concrete step

Pick which of the three top-priority gaps to ship first. My
recommendation is Gap 1 (wire sub-agents into chat) because it's the
biggest force multiplier — every subsequent intelligence improvement
plugs in along the handoff pattern we'd just enabled.

Each one is a single short PR. None of them adds files or new
patterns. They use what's already here.
