# 2026-09-18 (evening) — Host text in owner memory, and codex cache routing

Continues `2026-09-18-efficiency-handoff.md`. Same method: hotpatch the owner's
signed app, drive a live turn, read `host turn efficiency` plus the per-call rows
in `state/token-usage/<date>.ndjson`. Every number below is from a live run.

---

## 1. Result

Same question as the handoff's P1 table — *"What is on my Outlook calendar
today? Just list the events."*

| | frames | input tokens | cached | largest frame | judge | wall |
|---|---|---|---|---|---|---|
| before | 8–16 | 292k–557k | 2–8% | 37–45k | `done:false`, re-ran | 60 s+ |
| after | **4** | **49.4k** | **26%** | **16.9k** | `done:true` first pass | **23–27 s** |

A second shape — *"How many open opportunities do I own in Salesforce right
now?"* — went from 9 calls / 116k input / 86 s to 6 calls / 62.8k / 51 s.

---

## 2. P1 root cause: host text became pinned "owner" memory

The 8–16 frames were not the model deciding badly. It could not see its data.

1. Every Plan → **Execute** turn hands the model a host expansion of the owner's
   one line: the whole reviewed plan (up to ~58 KB). The host_v1 lane's
   auto-capture read `options.input` — that expansion — instead of the accepted
   row's own text. The expansion mentions a mailbox, so the sender-rule
   heuristic stored the entire plan as a pinned, dispatch-enforced
   `Standing rule (enforced): …` bound to the Outlook toolkit. Four such facts
   (17–58 KB each) plus two smaller ones existed; every Execute since 09-15 made
   one.
2. `renderFactsForInstructions` renders dispatch-enforced constraints **in
   full, always** (`dispatchBudget = MAX_SAFE_INTEGER`). One 38.5 KB rule was
   39.9 KB of a 49 KB memory context — ~9.6k tokens on **every frame of every
   turn**, not just Outlook turns.
3. The Outlook toolkit banner prints every bound rule in full on every Outlook
   result, tool description and search result. Host annotations were placed
   before the provider result inside one 20 KB clip, so the banner consumed the
   whole budget: the model received the plan text and **zero calendar events**,
   re-called the read five times, then answered from nothing. The completion
   judge (which reads the stored result) rejected it, and the turn re-ran.

### Fixes (all red-verified; tests named)

- **Capture admits only the owner's words** — `captureMessageIsOwnerAuthored`
  at the one choke point (`captureInteractionSignals`); `loop.ts` now captures
  the accepted row's `displayText`/`text`. A narrower clause (decline + fresh
  task) still passes. `src/memory/owner-words.test.ts`.
- **Self-heal** — `retireAutoCaptureFactsOutsideOwnerWords` runs at boot
  (`daemon/runner.ts`). Retires a fact only when its text is verbatim what
  auto-capture proposed and *every* accepted source that proposed it is on
  record and does not contain the message capture consumed. Soft forget; logs
  each id + source. Live: retired 7 (3206, 3462, 3508, 3518, 3521, 3550, 3689),
  kept 39, left 37 unverifiable alone.
- **Presentation bounds** — each dispatch rule renders within
  `POLICY_LINE_MAX_CHARS` (600; the longest real rule is 408) via
  `presentPolicyText`; the banner uses the same. Budgeted groups no longer
  `break` on the first row that doesn't fit, so one oversized row can't hide the
  rest (it had hidden all 25 standing preferences).
- **Host annotations never displace the provider result** —
  `boundHostAnnotations`: annotations get ≤25% of the result budget.
  `tool-output-annotations.test.ts`.

---

## 3. P3 codex cache: what the backend actually caches

1,228 codex calls over four days: **76% cached nothing**. The most common hit
is exactly 9,728 tokens = instructions + the 16-tool block. When the backend
caches, it caches the `instructions + tools` prefix and almost never the
conversation after it. Consecutive frames with identical instructions and tools
often still got only ~2.5k. So: make that prefix identical as often as
possible, and cut everything after it deterministically.

- **Key by prompt role, not session** — `prompt_cache_key = clem:<digest of
  instructions>`. The per-session key made every new conversation start cold
  and changed the key whenever a tool was enabled mid-turn. Roles still shard
  apart. Frame 1 of a fresh session now reuses prior sessions' prefix
  (0 → 4,608 observed).
- **Append-only tool order within a turn** (`host-turn-runner.ts`,
  `inFirstSeenOrder`) — `plan_task` (10 KB) was inserted at position 0 after
  the first `tool_search`, rewriting the whole block.
- **Turn-state tools last** (`turnStateToolsLast`, keyed on the existing
  `descriptionCarriesTurnState` marker) — so frame 1 opens with the same
  14-tool prefix whether or not the carriers are enabled yet.
- Prefix-shape log now records per-tool bytes and the input item layout
  (`kind:bytes:sha6`), which is how the above was found.

## 4. The Salesforce detour

`tool_search` returned the right operation first, but its summary was
`Current attested read capability salesforce_sf_soql_query`. The owner's
standing rule says "use the sf CLI (run_shell_command: sf data query)", so the
model searched twice more, called `run_shell_command`, was refused
(`reviewed_cli_shell_matched`) and only then used the read. The reviewed
descriptor already said "Read-only SOQL via the local Salesforce sf CLI (sf
data query --json)…"; the materializer dropped it. The live-read source now
shows the descriptor's own description (`reviewedReadSummary`). The remaining
extra frame is a model SOQL guess (`$User.Id`) — a failed guess that memory
should learn from.

---

## 5. Next levers, measured (calendar turn, 49.4k)

1. **Trailing context ~4.4k tokens per frame, never cacheable.** Memory (11 KB)
   + turn context (4.1 KB) + primer (1.5 KB) + packet re-appended at the input
   tail every frame. ~13k/turn. The `[action-planning]` mode text (~1.5 KB) is
   static but sits in the volatile block — moving it before the cache boundary
   is a small safe win.
2. **Completion judge 9–14k per turn, 0 cached.** Its evidence includes the
   full successful `tool_search` dump (12.6 KB) although its own label says
   discovery is not business data. A compact list (names + effects) would keep
   capability-availability judgments possible.
3. **`tool_search` output 12.6 KB** for one relevant hit: four unrelated local
   tools (~5.4 KB) plus identical per-result `planArgumentsHint` boilerplate.
   It rides every later frame and the judge.
4. **Pinned memory is ~half junk from capture heuristics** (owner words, so the
   repair correctly keeps them): ~26 of 48 pinned facts are one-off tasks or
   harness nudges pinned as `Standing prohibition` / `User preference` — e.g.
   "just find me 25 non market leader contacts…", "Your previous response did
   not make progress… You MUST call a tool now". The prohibition fallback does
   not exclude one-off task requests. Token cost is bounded by the policy
   budgets; the quality cost is not. Needs a semantic durable-vs-one-off
   decision, not more regex.
5. Memory-assisted turns can skip `tool_search` but then guess arguments
   (`schema_invalid` refusal, one extra frame). The planning card could carry
   the proven schema.

## 6. State

- All changes are **uncommitted** on `main` (27 files incl. 2 new). The
  `apps/usage-sidecar/*` modifications in the tree are not part of this work.
- The owner's app runs this build as a hotpatch (retained backups
  `daemon/dist.backup-*`).
- Targeted suites: memory 1,094/1,094; agents + composio 1,135/1,135;
  host-turn-runner 300/300; codex-model 35/35; tool_search 145/145; plus the
  two gates (`check:operation-identity`, `no-hardcoded-provider-pins`).
  Journeys 172/174 in the chunked run: `automation-partition-ledger` timed out
  at 600 s under chunk load; run alone, the whole file passes on this tree and
  its failing subtest passes on a clean `HEAD` worktree — the known load-flake
  class.
