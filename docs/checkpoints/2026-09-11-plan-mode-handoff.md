# NEXT ASSIGNMENT — Plan is inventory + publish, not a half-Act

Paste this whole file to the implementing agent. Read it once. Do not start a graph rewrite, a fourth model role, or a Google Docs allowlist.

**Owner intent.** Plan exists so a capable agent can **search whatever toolkit this install actually has** (local MCP, Composio, CLIs) and then **outline an executable path** the owner reviews. Execute is when the work runs. Act remains “just do it” for simple jobs. The toolkit is unknown by construction — if your fix names Salesforce, Apify, or Google Docs as special cases, it is wrong.

**This is not a tag go and not a push.** Prove with isolated tests and a bounded live Plan turn if the owner authorizes one. Do not send mail, create Docs, or mutate customer systems.

---

## 0. Read first (in this order)

1. This file.
2. `docs/EXPLICIT-PLAN-EXECUTE-DESIGN-2026-09-05.md` — product contract. Explicit Plan uses the **configured Clem loop**, not `buildPlannerAgent()` / `MODELS.fast`.
3. `src/runtime/harness/plan-first-contract.ts` — named inputs vs the work; `PLAN_SCOPING_READ_ALLOWANCE = 3`.
4. `src/runtime/harness/accepted-task-mode.ts` `planModeCallRefusal` — effect ceiling. **Dirty uncommitted unwrap is in this file already. Finish it; do not revert it.**
5. `src/tools/publish-plan.ts` — what a published plan actually is.
6. Live failure (read-only): `~/.clementine-next/state/harness.db` session `sess-desktop-fa27e2cb2fbbf09f07b65f4d` (2026-09-11 ~17:29–17:31Z). Packaged daemon SHA `00943a2c`. Do not print user text, URLs, or emails.

Companion context only (do not execute their next-step lists): `docs/checkpoints/2026-09-10-harness-and-graph-findings.md` §8; `docs/GRAPH-DRIVER-SUBTRACTION-BRIEF-2026-09-04.md`.

---

## 1. Product framework (non-negotiable)

```
Act     = do the named job with tools found along the way
Plan    = (1) Ground named inputs
          (2) Discover THIS install's catalogs until each step has an exact identity
          (3) Publish outline + unknowns
Execute = compile admission from that exact revision and run
```

The line is **would Execute do this step?**, not “is it a read?” and not a vendor list.

| Kind | Examples (illustrative — do not encode these names) | In Plan? |
| --- | --- | --- |
| **Ground** | GET on a URL/id the owner pasted; read the attached brief | Yes, unmetered |
| **Inventory** | `tool_search`, schema peek, `mcp_status`, `composio_status`, `composio_search_tools`, `sf org list --json`, `check_capability`, list connected accounts | Yes |
| **Production** | The SERP batch, the 10 Salesforce queries, creating the new Doc, sending mail | No — belongs in the published plan |
| **Publish** | `publish_plan` | The deliverable. A Plan turn that never calls it has failed. |

Host rules that **must not name vendors**:

- Inventory (search, schema, status, list, get-if-the-owner-named-it) is in-plan.
- Production is refused until a plan is published, **even if it is “only a read.”**
- Recovery always names **`publish_plan` or ask**, never retry the wrapper (`call_tool`).
- Success of a Plan turn is a published revision (`publish_plan` `ok:true`), not governor “progress.”
- Discovery walks **all connected surfaces**. Intent may *rank* a server; it must not hide others the owner named or that are connected.
- Classify the **inner** tool, not the carrier. Nested `call_tool(call_tool(X))` is X.

---

## 2. What actually failed (measure, don’t relabel)

Two complementary live bugs. Keep both.

### A. Too closed — cannot inventory (2026-09-11)

Session `sess-desktop-fa27e2cb2fbbf09f07b65f4d`. Plan mode, brain `grok-4.6` BYO. Owner asked: read the Doc I gave you, tell me which tools we can use (Apify + DataForSEO), then we will kick off a plan.

| Beat | Fact |
| --- | --- |
| MCP pre-narrow | `mcp_tool_scope` reason `seo/web-audit intent`, `allowedServerSlugs: ['dataforseo']`, `allowAll: false` — Apify and Google Docs hidden before the first model step |
| Grammar | 18/30 calls were `call_tool` wrappers, including `call_tool(call_tool(composio_search_tools))` |
| Refusals | `focus_set`; then `composio_status` / `mcp_status` / `composio_search_tools`; then `GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT` — all `effect=unknown`, `role=business` |
| Copy | `PLAN_MODE_READ_ONLY: … cannot execute in Plan mode` |
| Recovery | `recoveryToolNames: ['call_tool']` every time; stage stuck `host_disposition:refused_pre_dispatch` |
| Terminal | `control_no_progress_exhausted` after 3 strikes; **zero** `publish_plan`; Doc never read |
| UI | “Next: Use call_tool to resolve this step” — the host coaching the loop that just died |

`GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT` on the URL the owner pasted is **Ground**. Status/catalog search is **Inventory**. Both were treated as production writes because classification saw the wrapper as `unknown`.

### B. Too open — does the work (2026-09-10)

`plan-first-contract.ts` header: `sess-desktop-a6a6a20d`. She read the Doc (correct), then seven Firecrawl searches, 23 `tool_search`, never `publish_plan`. Ceiling was “no external writes,” so running the research as reads looked legal. The 3-read scoping allowance is the start of a fix; it only applies today when `identity.composioCarrier` is set (`accepted-task-mode.ts` ~80). Native MCP / CLI production reads can still skip it.

Do not treat A as “Plan is too strict” or B as “Plan is too loose.” Both are **the job of the turn is wrong**.

---

## 3. What she is compiling vs what she should formulate

`publish_plan` (`src/tools/publish-plan.ts`) currently demands, from the model, a second isomorphic DAG:

- `structured_plan.steps[]` with `capabilityRef`, `effect`, `staticArgumentsJson` (raw provider fields, no `call_tool` wrap), `dynamicBindings`, `dependsOn`, `verification`
- `execution_draft` whose operations / effects / dependsOn / dataFrom **byte-agree** with those steps
- cardinality only `{kind:"once"}` — “one call per prospect” is not expressible
- ready mutating plans **must** include that draft
- live catalog + schema digest + account must still match at publish time

Live 2026-09-09: five identical draft-mismatch refusals, ~10 minutes; the real bug was cardinality and the message never said so.

**For this assignment:** make Plan able to **reach** `publish_plan` with inventory + named-input reads, and make recovery tell her to publish. **Do not** in this wave invent a new plan IR or delete `execution_draft`. If a publish repair is in your path, name the actual disagreement (cardinality, wrapping, missing capabilityRef) in the error — do not add a third copy of the DAG for the model to type.

Execute should eventually compile admission from the outline (design § Execute). That is a later slice unless you can do it as pure subtraction of a duplicate field the host already derives. Default: leave `execution_draft` in place; stop dying *before* publish.

The readable `full_text` is what the owner reviews. The structured steps must cite **exact discovered identities** (slug / local registry name), not “use SEO tools.” Missing toolkit → `readiness: needs_input`, not an invented actor.

---

## 4. Where to look (file map)

### Ceiling and classification (P0)

| File | Why |
| --- | --- |
| `src/runtime/harness/accepted-task-mode.ts` | `planModeCallRefusal`. Dirty unwrap of nested `call_tool` is **in the working tree** (`git blame` shows Not Committed Yet). Finish + tests in `accepted-task-mode.test.ts`. Classify inner tool + inner args. `focus_set` is host_only write — refuse as “not a plan step, don’t set focus; publish.” Status/search/get-named-doc must not hit `PLAN_MODE_READ_ONLY`. |
| `src/runtime/harness/tool-effect.ts` | `unwrapRuntimeEffectiveToolIdentity` already recurses (depth 8). Confirm Plan uses **unwrapped** name **and** args for `classifyRuntimeToolEffect`. Outer `call_tool` `effect=unknown` must not win. |
| `src/runtime/harness/plan-first-contract.ts` | Named-input detector (URL / long id in the owner’s text). Apply production-read cap to **any** third-party production read, not only `composioCarrier`. Inventory calls must not consume the allowance. |
| `src/runtime/harness/plan-first-contract.test.ts` | Pins for named URL vs Firecrawl-shaped work. |

### Recovery (P1)

| File | Why |
| --- | --- |
| `src/runtime/harness/host-no-progress-projection.ts` | `recoveryToolNames` for `refused_pre_dispatch` currently uses **carrier** names (`call_tool`). Use inner tool + **`publish_plan`**. A new inner operation must mint a **new stage** (or schemaKeyed repairKey), not three strikes on `host_disposition:refused_pre_dispatch`. |
| `src/runtime/harness/recovery-not-a-dead-end.test.ts` | Existing pin around `host_disposition:refused_pre_dispatch`. Extend, don’t weaken. |
| `src/runtime/harness/no-progress-governor.ts` | v2 budgets. Do not lower them to hide a same-stage loop. |

### Discovery surface (P2)

| File | Why |
| --- | --- |
| `src/runtime/mcp-tool-scope.ts` ~641 | `wantsSeo` → **only** `dataforseo`. Rank, don’t hide. Owner named other systems, or other servers are connected → they stay in scope. |
| `src/agents/external-mcp-scope-lock.test.ts` | Pins the dataforseo-only reason string. Update the contract: SEO **priority**, not exclusive, when the ask also names other systems. |
| `src/agents/orchestrator.ts` / `src/agents/tool-jit.ts` / `src/agents/tool-hotset.ts` | Opening Plan surface should include `publish_plan` as first-class. Search is the long tail. |
| `src/tools/tool-search-tool.ts` | Search results already hint `publish_plan` vs `work_call`. Keep that; don’t make search the only way to see `publish_plan`. |

### Publish path (touch only if Plan still cannot publish after P0–P2)

| File | Why |
| --- | --- |
| `src/tools/publish-plan.ts` | Host-checked artifact. Errors must name the field disagreement. `staticArgumentsJson` = inner provider fields only. |
| `src/runtime/harness/plan-artifacts.ts` | Persistence. |
| `src/runtime/harness/host-turn-runner.ts` ~6608 `publishedPlanTerminal` | Plan turn **ends** when `publish_plan` returns `ok:true`. Keep that. Do not add a last_word empty-tool step. |
| `src/runtime/harness/host-turn-runner.ts` ~9524 | Plan-first nudge copy. Align with “publish or ask.” |

### Do not route through

| File | Why |
| --- | --- |
| `src/agents/planner.ts` | `MODELS.fast`, fixed allowlist, **no Composio**. Not the explicit Plan loop. |
| `src/runtime/harness/plan-first.ts` | Phrase-routed leftover. Explicit `taskMode.kind === 'plan'` must not fall into it. |
| `src/runtime/graph/graph-executor.ts` | Not this assignment. Chat Plan is not “compile a graph as entrance exam.” |

---

## 5. Ordered work

One concern per change. Red test or live bytes before claiming.

### P0 — Classify the call that was named (in progress in the tree)

- Nested `call_tool` / `work_call` → classify innermost name+args.
- Inventory (`tool_search`, status, catalog search, `check_capability`, schema peek) allowed in Plan.
- Ground: `readsAnOwnerNamedInput` stays free (generic URL/id match, **no vendor list**).
- Host_only writes (`focus_set`, `memory_remember`) stay refused; repair is “don’t do that in Plan,” not “retry call_tool.”
- True production (including production **reads**) refused with copy that says **publish_plan**.

Tests: nested wrapper status/search allowed; named-doc GET allowed; Firecrawl-shaped batch after allowance refused; `focus_set` refused without naming `call_tool` as recovery.

**Dirty files already:** `accepted-task-mode.ts`, `accepted-task-mode.test.ts`. Diff them first. Complete; don’t parallel-implement a second classifier.

### P1 — Recovery is publish or ask

- `recoveryToolNames` for Plan refusals: `['publish_plan']` (and the inner tool only if a schema repair on an inventory call is actually required).
- Never `['call_tool']` as the Plan repair surface.
- New inner tool / new repairKey = new governor stage. `focus_set` ≠ `GOOGLEDOCS_GET_*` ≠ `composio_status`.
- UI/host “Next:” line must not say Use `call_tool`.

Proof: replay the 2026-09-11 shape in a unit/integration fixture — three different inner names do not terminalize on strike three of the same stage; the blocked copy names `publish_plan`.

### P2 — Scope ranks, it does not hide

- SEO intent may put DataForSEO first and cap payload.
- If the ask names another system, or other MCP/Composio servers are connected, they remain discoverable.
- Plan opening hotset includes `publish_plan`.

Proof: fixture ask mentioning Docs + Apify + DataForSEO → scope is not `{dataforseo}` exclusive. Isolated tests in `external-mcp-scope-lock.test.ts` / `mcp-tool-scope` tests.

### P3 — Production reads are the work (complete the 2026-09-10 contract)

- `planFirstWorkRefusal` must apply to third-party production reads regardless of carrier (Composio, MCP, CLI classified external).
- Inventory must not increment `externalReadsSoFar`.
- Named inputs never increment it.
- After allowance, refusal text already names `publish_plan` — keep it, fire it.

### Not this wave unless the owner expands scope

- Compiling `execution_draft` on the host at Execute from the outline (right direction; large).
- Forcing Terra/Sonnet as Plan brain (seating; settings, not this patch).
- Deleting `planner.ts`.
- Graph-in-front-of-chat.

---

## 6. Proof

Isolated: `node scripts/run-tests-isolated.mjs` on every file you touch. Live daemon owns `~/.clementine-next`; the sentinel will say so. Do not write the live store.

Minimum new pins:

1. Nested `call_tool(call_tool(status))` in Plan is allowed (inventory).
2. Named URL GET in Plan is allowed (ground).
3. Unnamed third-party production read after 3 scoping reads is refused with `publish_plan` in the message.
4. Plan `refused_pre_dispatch` recovery tools include `publish_plan` and not `call_tool`.
5. SEO + other named systems → MCP scope is not DataForSEO-only.

Live (only if the owner says go): same Plan prompt as 2026-09-11, Terra or Sonnet if possible, **not** Grok on the composer. Expect: read named Doc, inventory connected SEO/Docs/Apify-class tools, `publish_plan` with exact capability refs and `needs_input` for anything missing. Zero new Docs. Zero Firecrawl batches. Stop and report if the governor terminalizes.

Do not relabel sessions `fa27e2cb` or `a6a6a20d` as passes.

---

## 7. Hard do-nots

- Do not add allowlists of Google / Salesforce / Apify / Firecrawl tool names.
- Do not revert the uncommitted unwrap in `accepted-task-mode.ts`.
- Do not send Plan through `buildPlannerAgent` / `MODELS.fast`.
- Do not put a graph compiler in front of Plan as a license to mutate.
- Do not add an admission token or a second expected-work compiler.
- Do not fail-open writes in Plan.
- Do not treat HTTP 200 on `tool_search` as plan progress toward publish.
- Do not push or tag.

---

## 8. One-sentence success

A Plan turn on an unknown toolkit reads what the owner named, searches the catalogs that are actually connected, and publishes a reviewable plan with exact operation identities — without doing the work and without being told to retry `call_tool`.
