# Agent System Design — May 2026

A blueprint for moving Clementine from a **prompt-patched agent** to a
**runtime-enforced agent**. The thesis: stop teaching the model how to
behave via more directives, and start *structuring the runtime* so the
desired behavior happens automatically.

This doc is companion to `docs/harness-audit.md` (May 2026). That one
described the harness gaps we closed (planner, intent classifier,
sub-agents, plan-scoped approval, verifier). This one describes the
*next* layer — and explicitly argues for *not* fixing failures with
more instruction text.

---

## Where we are

Today, the agent's behavior is shaped by three layers:

1. **`src/assistant/instructions.ts`** — a ~30-sentence wall of
   directives sent as the system prompt every chat turn. Each
   directive is a reaction to some past failure: "don't re-ask
   clarifications", "for single read-only tool calls just call the
   tool", "never claim a tool is unavailable based on name
   introspection", and so on. Each one was correct in the moment it
   was added. Together they fight each other.
2. **Tool registration** in `src/tools/registry.ts` +
   `src/runtime/mcp-servers.ts` — flat list of SDK-native tools, MCP
   servers wrapped as remote tool providers, passed to
   `new Agent({ tools, mcpServers })`. No metadata about side-effects,
   cost, or risk. The model alone decides which to use and when to
   gate.
3. **Per-tool approval gates** in `src/tools/computer-tools.ts` — only
   `run_shell_command` and `write_file` are gated, via
   `needsApprovalUnlessInPlanScope`. Every other tool is "always
   auto" — including MCP tools that hit paid APIs and external apps
   that mutate state.

The pattern that keeps biting us: **the model is asked to make
decisions the runtime should be making**.

### Concrete failure modes from the last 48 hours

Each one was patched with a new sentence in `instructions.ts`:

| Failure | What the model did | What it should have been |
| --- | --- | --- |
| "Reply with 'run it'" on a SEO keyword lookup | Asked for approval on a read-only DataForSEO call | Tool tagged `read` → no approval needed, just runs |
| "I don't have a callable DataForSEO MCP tool exposed" | Introspected its own tool list, didn't find a `dataforseo_*` prefix, claimed unavailable | System prompt enumerated the live tool list explicitly — model wouldn't have needed to guess |
| `mcp_status` called with `query: "revilllaw.com top 5 keywords"` | Misused the diagnostic — passed user text where a category filter belongs, got 0 matches, concluded server isn't configured | Tool's input schema constrained or the model never had reason to preflight — capability was in the prompt |
| Re-asked clarification user already answered | Ignored the recent transcript when composing the next gate | Transcript-aware gate suppression in the runtime, not a directive |
| Hallucinated "filesystem permissions blocked me" on `sf` shell failure | Translated subprocess exit code 1 into vague text | Real error piped verbatim into the next turn so the model has facts |
| Plowed past plan-scoped approval window | Didn't realize the window had expired | Already structural (plan-scope.ts) — model behavior is downstream of runtime state |

**Pattern**: every entry on the left is "model guessed wrong"; every
entry on the right is "runtime should have already decided."

---

## The cost of staying on the current path

Three real risks if we keep patching instructions:

1. **Brittleness across users.** Every reactive directive in
   `instructions.ts` was shaped by *my* dev failures. When someone
   else installs Clementine, those directives constrain their agent
   for failure modes they may never hit — and miss the failure modes
   they will hit, because their MCP servers, integrations, and asks
   are different.

2. **No regression catch.** The only way I know a directive fix
   "worked" is by typing in Discord and watching. There's no test
   harness. Two days from now a new directive may neutralize an
   older one and we won't know until a user complains.

3. **The pile compounds.** Each new sentence dilutes the others.
   The model's prompt-following is finite — at some point we're
   negotiating with a wall of advice. Today's count is already past
   the point where I can quote what's in there from memory.

The structural fix removes those three risks at once.

---

## The five moves

Each move is independent enough to ship on its own, but they
compound. Recommended order is also dependency order.

### Move 1 — Tool taxonomy

Every tool — SDK-native, MCP-discovered, Composio-bridged, plugin —
gets a typed metadata record:

```ts
interface ToolMetadata {
  kind: 'read' | 'write' | 'execute' | 'send' | 'admin';
  sideEffects: boolean;
  network: boolean;
  cost: 'free' | 'metered' | 'paid';
  category: string;        // e.g. 'memory', 'seo', 'cloud', 'shell'
  destructive: boolean;    // delete/overwrite/rm — escalates approval
  description: string;
}
```

- `read` — pure lookup; never mutates anything observable. Approval:
  never (regardless of policy).
- `write` — local mutation (file write, memory remember, task add).
  Approval: per scope policy (`strict` asks, `workspace`/`yolo`
  auto).
- `execute` — runs a subprocess. Same gating as `write` plus the
  hard danger denylist already in
  `src/tools/computer-tools.ts:assertCommandAllowed`.
- `send` — external recipient (Discord DM, email, Slack channel,
  HTTP POST to a non-localhost endpoint). Always asks, even on
  YOLO, unless inside an approved plan-scope.
- `admin` — destructive or irreversible (workflow delete, credential
  reset, secret rotation). Always asks, even on YOLO.

**Where it lives:**
- Add the metadata field to `tool()` calls in `src/tools/*.ts`.
- MCP-discovered tools get classified at register time by the
  runtime, based on a tiny rules table (`*_search`, `*_query`,
  `*_list`, `*_get` → `read`; `send_*` → `send`; etc.) plus an
  override file (`~/.clementine-next/mcp/tool-overrides.json`) the
  user can edit.
- `src/agents/plan-scope.ts:evaluateAutoApprove` is rewritten to
  take the metadata, not just the name. The current name-based
  gating is the entire reason DataForSEO read calls hit the same
  approval gate as `rm -rf`.

**What this kills:**
- "For single read-only tool calls just call the tool" — directive
  becomes unnecessary, runtime enforces it
- "Don't ask for run it on lookups" — same
- "Confirmation is for mutations only" — same

That's three sentences out of `instructions.ts` because they're now
structural facts, not advice.

### Move 2 — Live capability injection

The single highest-leverage fix. On every chat turn, the runtime
prepends a deterministic block to the system prompt:

```
AVAILABLE TOOLS (live snapshot)

SDK (built-in): memory_recall, memory_remember, task_add, task_list,
  goal_create, goal_update, note_take, ask_user_question,
  notify_user, draft_plan, surface_plan, check_capability,
  list_capabilities, write_file [approval], run_shell_command [approval],
  read_file, git_status, list_files (...)

MCP servers (connected, tools usable now):
  dataforseo (63 tools):
    serp_organic_live_advanced, dataforseo_labs_google_ranked_keywords,
    keywords_data_*, backlinks_*, domain_analytics_* (... 58 more)
  hostinger-mcp (118 tools): hosting_importWordpressWebsite, ...
  supabase (29 tools): list_projects, query_database, ...
  Bright Data (71 tools): scrape_as_markdown, search_engine, ...
  ElevenLabs (24 tools): text_to_speech, speech_to_text, ...
  apify (8 tools): call-actor, search-actors, ...

Composio: not configured (set up at https://composio.dev to add Gmail,
  Slack, Linear, Notion, etc.)

The list above is the ground truth. Do not assume a tool is missing
based on its name not matching the server's name. If a tool appears
above it is callable now.
```

This is enumerated from the actual connected MCP servers at run time
(I already proved the connection works — `scripts/probe-mcp-tools.ts`
lists all 63 DataForSEO tools when run directly). The model never
needs to guess what's available, never needs `mcp_status` to
"check," never has a reason to say "I don't have that tool."

**Cost:** ~300–500 prompt tokens per turn, depending on how many MCP
servers are connected. Worth it. Today's prompt has ~1500 tokens of
behavioral directives; replacing some of those with the capability
block is a net wash or even a win.

**Where it lives:**
- New `src/runtime/capability-prompt.ts` builds the block once per
  agent run, using the same `createConfiguredMcpServers()` shape +
  the tool taxonomy from Move 1.
- `src/assistant/core.ts` prepends it before `instructions`.
- Cached per `mcpServers` fingerprint so we don't rebuild on every
  turn.

**What this kills:**
- "NEVER claim a tool is unavailable based only on introspecting
  tool names" — unnecessary, the names are *given*
- "MCP servers expose tools under their bare names" — unnecessary,
  the bare names are listed
- "Use `mcp_status` before saying an integration is unavailable" —
  unnecessary, status is in the block

That's three more sentences gone.

### Move 3 — Real error surfacing

When a tool fails, the runtime currently swallows the actual error
and passes a paraphrase to the model. Result: the model invents
plausible-sounding rationales ("filesystem permissions blocked me")
when the real failure was something completely different.

The fix is structural and small:

- `runStreamed` and tool-call result handlers in `src/runtime/openai.ts`
  capture `stderr`, exit codes, and exception messages verbatim.
- Each failed tool call becomes a structured message in the next
  agent turn: `tool_error: { tool, args, stderr, exitCode,
  durationMs }`.
- The model's instructions reduce to: *when a tool fails, report
  the real error to the user; don't paraphrase.*

That's a one-line directive replacing whatever ad-hoc behavior the
model is improvising today. Plus the user gets useful diagnostics.

**Where it lives:**
- `src/runtime/openai.ts` — extend `toolActivityFromRunItem` to also
  emit `tool_error` events.
- `src/runtime/run-events.ts` — already supports event types; add
  `tool_error` as a first-class kind.
- The agent's input on the next turn includes a compact
  `RECENT TOOL ERRORS` block instead of letting the model guess.

### Move 4 — Behavior test harness

A YAML catalog of canonical scenarios, run via CI:

```yaml
# tests/agent-scenarios/seo-keywords.yaml
name: "Top keywords lookup via DataForSEO"
setup:
  mcp_servers: [dataforseo]  # mocked or real
  user_profile: nathan
messages:
  - role: user
    text: "top 5 ranked keywords for revilllaw.com"
expect:
  tool_calls:
    - name: dataforseo_labs_google_ranked_keywords  # OR serp_*
      args_include:
        - "revilllaw.com"
  no_clarification: true
  no_unsupported_claim: true
  approval_required: false
```

A test runner (`scripts/run-agent-scenarios.ts`) loads each scenario,
spins up the agent in a sandbox, sends the messages, and asserts:

- Expected tool was called (by name or by metadata kind)
- No "I can't" / "tool not available" hallucination
- Approval only fires when `approval_required: true`

**Where it lives:**
- `tests/agent-scenarios/*.yaml` — the catalog. ~20 scenarios at
  launch covering: SEO lookup, Salesforce query, file edit, plan
  approval flow, casual greeting, multi-step task.
- `scripts/run-agent-scenarios.ts` — the runner, callable from CI.
- GitHub Actions step: runs scenarios on every PR.

This is where the project transitions from "I tested it in Discord"
to "behavior is testable and regressions are caught at merge time."

### Move 5 — Slim `instructions.ts`

Final move, only after 1–4 are in place. The instruction file gets
pruned to its essentials:

- Identity: who Clementine is, what tone, how to talk to the user
- High-leverage operating principles: be concrete, lead with the
  answer, no preamble
- A pointer to the runtime: *"Your available tools and approval
  policy are enforced by the runtime. Trust them."*

Target: under 12 sentences. Right now it's around 30+ and growing.

The reactive directives — "don't re-ask clarifications", "for
single read-only tools just call them", "never claim a tool is
unavailable" — all get deleted because they're no longer needed.
The runtime is doing that work.

---

## Grounded in the SDK — what we already have to work with

The five moves above are strategic. Before any code, here's the
mapping from each move to the **OpenAI Agents SDK primitive** that
implements it. Verified against
`node_modules/@openai/agents-core/dist/*.d.ts` and the corresponding
`.js` implementation files. This is the unlock — most of what we
want is already in the SDK; we've been writing custom layers next to
it instead of using it.

### Plug-and-play MCP is two problems, both SDK-shaped

**Problem A — MCP tool names collide and the SDK throws.** From
`mcp.js:300`, when two installed MCP servers expose tools with the
same name, `getAllMcpTools` raises `UserError("Duplicate tool names
found across MCP servers: …")`. That kills any aspiration of "auto-
discover whatever the user has installed" — names like `search`,
`read_file`, `list`, `get` collide in practice.

**Problem B — the SDK ships the MCP tool description verbatim.**
From `mcp.js:340-355`, the tool description the model sees comes
**from the MCP server itself**. Every line of system prompt we've
written explaining "DataForSEO is for SEO data" or "supabase is a
database" is duplicating what the SDK already passes through.

The fix is one wrapper:

- A single synthetic `MCPServer` implementation whose `name` is
  `"clemmy-mcp-namespace"` and whose `listTools()` flattens every
  installed server's tools with renamed identifiers
  (`<server>__<tool>`). `callTool(name, args)` parses the prefix and
  dispatches to the underlying server.
- `Agent({ mcpServers: [<that one shim> ] })` — done. The collision
  goes away. The model sees `dataforseo__serp_organic_live_advanced`
  instead of `serp_organic_live_advanced`, and there's no ambiguity.

Estimated ~80 lines. Lives at `src/runtime/mcp-namespace-shim.ts`,
replaces the direct loop in `src/runtime/mcp-servers.ts:79`.

### Dynamic tool filtering — already in the SDK

The SDK exposes `isEnabled?: boolean | (({ runContext, agent }) =>
boolean | Promise<boolean>)` on **every** tool and handoff
(`tool.d.ts`, `handoff.d.ts`, `mcp.d.ts:30` as `MCPToolFilterCallable`).
Evaluated each turn in `Agent.getAllTools()` and
`Agent.getEnabledHandoffs(runContext)`. Tools that resolve `false`
are **omitted from the tool list the model sees** — they don't get
"refused", they're invisible.

This is exactly Move 2 (live capability injection), but flipped:
instead of *adding* a capability block to the prompt, we *prune* the
tool list down to the relevant subset before the model sees it.

Implementation:
- A small relevance predicate runs in each MCP tool's `isEnabled`
  callback. Cheap heuristic (keyword match against recent user
  message), or a tiny fast-model LLM call cached for the turn.
- For the namespaced MCP shim above, the same predicate filters
  which tools land in `listTools()` — same effect.
- Replaces the entire "tool taxonomy with `kind` field" idea for
  the discoverability problem. We still need `kind` for **approval**
  (read vs write), but not for **visibility** — `isEnabled` is the
  visibility primitive.

### Tool taxonomy via `needsApproval` (function form)

`tool()` accepts `needsApproval?: boolean | ((runContext, input,
callId?) => Promise<boolean>)` (`tool.d.ts`, `tool.js:133-200`). The
function receives **parsed input** and the **full run context**.

That's the entire substrate for our "tool kind" idea:

- Wrap MCP tools at register time with a `needsApproval` function
  that consults: (a) static metadata on the tool name (rules:
  `*_search`/`*_list`/`*_get` → never; `*_send`/`*_delete` →
  always), (b) an override file at
  `~/.clementine-next/mcp/tool-overrides.json`, (c) the global
  `autoApproveScope` policy.
- No need to invent a separate `ToolMetadata` record. The
  classification logic lives in one function: input goes in,
  approval boolean comes out.

Replaces `src/tools/computer-tools.ts:needsApprovalUnlessInPlanScope`
which currently hardcodes the wrap only for shell + file-write.
Generalize that pattern; apply it to every tool by default; let MCP
tool names drive classification.

### "Trust this tool for the rest of the run" is built in

`state.approve(interruption, { alwaysApprove: true })`
(`runState.d.ts`, `runState.js:343`) whitelists the **tool name**
for the remainder of the run. Our `plan-scope.ts` is partly a
reimplementation of this — at the run level, the SDK already has
"approve once, trust for the rest of the conversation". Keep our
plan-scope for the **cross-run** case (user approves a plan in turn
3, agent auto-runs in turn 5), but stop hand-rolling the intra-run
case.

### Structured outputs replace "respond in JSON like this" directives

`Agent({ outputType: ZodSchema })` injects the structured-output
contract into the prompt for us and parses + types
`result.finalOutput` on the way out (`agent.d.ts:150`,
`autonomy-v2.ts:582` already does this correctly).

Every place we have a prompt sentence saying *"respond in this
shape"* should become a Zod schema. The Planner already does it
(`agents/planner.ts`). The orchestrator could (action class, tool
intent, confidence). The autonomy loop already does. Extend the
pattern. Every schema we add deletes a directive.

### Lifecycle hooks for observability

`runner.on('agent_tool_start', (ctx, agent, tool, { toolCall }) => …)`
and `agent_tool_end` (`lifecycle.d.ts:14-118`). These give us the
typed `tool` object and the raw `toolCall`. We've been parsing the
stream in `src/runtime/openai.ts:325-364` to extract this — the
hooks are cleaner and typed.

Not strategically critical, but removes ~40 lines of fragile stream
parsing for free.

### Hosted tools — free leverage

`webSearchTool`, `fileSearchTool`, `codeInterpreterTool`,
`imageGenerationTool`, `hostedMcpTool` (`@openai/agents-openai/
dist/tools.d.ts`). Already paid for via OpenAI billing. Run server-
side, lower latency. Worth surfacing the ones our users want before
hand-rolling local equivalents.

`hostedMcpTool` is particularly interesting for remote MCP servers
that publish HTTPS endpoints (GitHub, Atlassian, etc.) — the
Responses API talks to them directly, our daemon doesn't have to
proxy. Cheaper, faster, and approval can be partitioned with
`requireApproval: { never: { toolNames }, always: { toolNames } }`.

### Computer use — `Computer` interface

`computerTool({ computer })` from `@openai/agents-core`
(`computer.d.ts`). Requires a `Computer` impl exposing
`screenshot/click/doubleClick/scroll/type/move/keypress/drag/wait`,
plus `environment` and `dimensions`. The SDK dispatches actions in
`runImplementation.js:551-583`.

No SDK-level approval hook — but since *every action* flows through
our `Computer` methods, we can gate inside them (consult an
approval queue, return early on reject). That's where the per-
action consent for computer-use lives.

For us: implement once against macOS (nut.js / Playwright), wire it
once at agent construction time, and computer-use becomes another
plug-and-play surface — same `isEnabled` and `needsApproval`
patterns apply.

### The summary table

| Move | SDK primitive | Where we are |
| --- | --- | --- |
| MCP plug-and-play | `MCPServer` interface + custom namespace shim | Loop in `mcp-servers.ts` will throw on collisions |
| Dynamic tool surface | `isEnabled` on tools/handoffs/MCP filter | Not used yet |
| Tool kind / approval rules | `needsApproval: (ctx, input) => bool` | Hardcoded only on `run_shell_command` + `write_file` |
| Trust-for-run | `state.approve(item, { alwaysApprove })` | Reimplemented as plan-scope |
| Structured outputs | `outputType: ZodSchema` | Used in autonomy-v2, planner. Should be everywhere. |
| Tool telemetry | `agent_tool_start` / `agent_tool_end` hooks | Replaced by stream parsing today |
| Hosted tools | `webSearchTool`, `hostedMcpTool`, etc. | Not exposed |
| Computer use | `computerTool({ computer })` + `Computer` impl | No implementation yet |

The bottom row is the only "new thing we have to build." The rest is
**replacing custom code with SDK primitives we already pay for via
the dependency**.

### What this means for "no aggressive system prompt"

Every directive in `instructions.ts` that today says one of these is
deletable once the SDK primitive is wired:

| Directive shape | Deleted because… |
| --- | --- |
| "Tool X is for Y" / "Use mcp_status before…" | MCP descriptions ship via the SDK; namespaced naming makes intent obvious |
| "For read-only tools just call them" | `needsApproval` returns `false` for `*_search`, `*_list`, etc. — model never sees a gate |
| "Respond in this JSON shape" | `outputType` is a Zod schema; SDK injects + parses |
| "Stop offering tools you don't have" | `isEnabled` already hid them |
| "Don't claim a tool is unavailable" | The list it sees IS the available list |

`instructions.ts` shrinks to identity, tone, and a single line:
*"Trust the runtime; the tools and approvals you see are the ones
that apply."*

---

## What stays the same

To be explicit about what we're not changing:

- **OpenAI Agents SDK.** The SDK is doing its job. We're shaping
  what it sees, not replacing it.
- **MCP integration shape.** Auto-discovery + standalone +
  user-managed config in `~/.clementine-next/mcp/servers.json`.
- **Plan-scope approval.** Move 1's tool taxonomy plugs into the
  existing `evaluateAutoApprove` — same flow, just type-checked.
- **Proactivity policy modes** (strict / workspace / yolo). The
  YOLO toggle is now actually meaningful because tool kinds back
  it up.
- **Sub-agent orchestration** (Researcher / Writer / Reviewer /
  Executor / Deployer + Planner-as-tool). Already shipped, working.
- **Memory layer, run events, observability.** All structural;
  none of this disturbs them.

This is a runtime refactor, not a rewrite. The pieces that work
keep working.

---

## What this explicitly is not

A few things I'm not proposing, to bound the scope:

- **No new LLM call for routing.** No "tiny classifier model" or
  separate inference step. Latency and cost matter. Move 1 + 2 are
  pure code; no extra inference.
- **No graph-based agent state machine.** Instructions + handoffs +
  tool taxonomy carry the policy. Adding a graph layer is what we
  do when prompts can't express the routing logic — and we're not
  there.
- **No SDK fork or model swap.** OpenAI Agents SDK + GPT-class
  models stay.
- **No prompt template framework / "agent OS" abstraction.** The
  capability block is a string. The tool taxonomy is a record. No
  abstractions that don't pay their way.

The principle: every line of new code earns its keep. Every line of
old code we delete earns its deletion.

---

## Order of operations

Recommended sequence — each step is grounded in a specific SDK
primitive, not a new abstraction we have to invent.

| # | Move | SDK hook | Sizing | Unlocks |
| --- | --- | --- | --- | --- |
| 1 | MCP namespace shim | `MCPServer` interface | ~80 lines | Unblocks "any installed MCP server" — the collision throw goes away |
| 2 | `needsApproval` per-tool, classified by name + override file | `tool.needsApproval` function form | ~150 lines | Read-only MCP calls stop hitting approval gates; YOLO policy gets real per-tool granularity |
| 3 | `isEnabled` on MCP tools, predicate-driven per turn | `tool.isEnabled` / `MCPToolFilterCallable` | ~120 lines | Hundreds of tools shrink to ~20 relevant per turn — model picks better, no "ignore these" directive |
| 4 | Wire lifecycle hooks for tool telemetry | `runner.on('agent_tool_start'/'agent_tool_end')` | ~50 lines | Remove ~40 lines of fragile stream parsing |
| 5 | Move structured-output prompting → `outputType` Zod schemas | `Agent({ outputType })` | ~80 lines per agent boundary | Every "respond in JSON like this" directive becomes a typed schema |
| 6 | Real tool-error surfacing | tool `errorFunction` + structured `tool_error` events | ~80 lines | "Filesystem permissions blocked me" hallucinations stop |
| 7 | Computer-use via `computerTool` | `computerTool({ computer })` | ~250 lines (mac `Computer` impl) | Plug-and-play computer use, gating via the `Computer` methods |
| 8 | Behavior test harness | scenario runner against the wrapped agent | ~250 lines | Regressions caught at PR time |
| 9 | Slim `instructions.ts` | — | ~40 lines deleted | Less noise, more signal |

Total: roughly **~1100 lines net new code, plus the `Computer`
impl**. About 40 lines deleted from `instructions.ts`. **Move 1
alone unlocks the "plug-and-play MCP" story** — that's the single
highest-leverage change in this list.

Moves 1+2+3 are an afternoon together — they're tight and SDK-
direct. Move 7 is the only big unknown (depends on which `Computer`
backend we pick — Playwright vs nut-tree-fork vs native macOS).

After Move 8 lands, the project crosses a threshold: behavior
changes become safe-to-ship because regressions show up in CI.

---

## What "done" looks like

Concretely, after all five moves:

- `instructions.ts` is ~12 sentences of identity + operating
  principles. No more reactive patches.
- Every tool has typed metadata. The approval gate decision is
  three function calls and a switch, not a prompt-following bet.
- The system prompt on every turn includes a fresh capability
  snapshot. The model never needs to introspect or guess.
- When a tool fails, the next turn's input has a structured
  `tool_errors` block with the real stderr / exit code.
- `tests/agent-scenarios/*.yaml` catalogs ~20 canonical user
  requests. CI runs them on every PR. Any model-behavior
  regression is loud and fails the PR.
- The SEO-lookup failure pattern is *structurally impossible*: the
  tool is tagged `read`, listed in the capability block, and the
  agent has no model-level reason to gate it.

That's the shape of "we stopped patching, we built the system."

---

## Open questions worth pre-deciding

A few decisions to make before code lands:

1. **MCP tool kind classification at register time vs lazy.** Lazy
   is simpler (classify on first use) but means the first call of
   a tool might be misclassified for one turn. Register-time
   classification means we have to round-trip every MCP server's
   tool list at startup, which slows boot. Recommendation:
   **register-time, async-prefetched at daemon start**, so the
   first user turn already has the full taxonomy.

2. **Tool override storage location.** `~/.clementine-next/mcp/tool-overrides.json`
   for user edits, or settings panel UI? Recommendation: **start
   with the file**, add a UI in Settings later when needed. Same
   model as other config files (the user can edit; the dashboard
   reads).

3. **Capability block scope.** Should the block include sub-agent
   handoff descriptions too (Researcher / Writer / Reviewer / etc.)?
   Recommendation: **yes**, since handoffs are also discoverable
   capabilities the model might miss.

4. **Test harness sandbox.** Real OpenAI calls or recorded
   replays? Real is honest but slow + costs money. Replays are
   fast but go stale. Recommendation: **hybrid** — record fresh
   replays weekly, use them in CI, run real calls only when
   intentionally re-baselining.

5. **What lives in CLAUDE.md vs `instructions.ts`.** The repo's
   `CLAUDE.md` is what *Claude Code* sees when it's working on
   this codebase. `instructions.ts` is what *Clementine the
   product agent* sees when it's running for the user. These have
   been confused. Recommendation: write a short `AGENTS.md` at
   the repo root documenting both contracts.

None of these are blockers, but worth aligning on before Move 1
lands.

---

## Where to start

**Move 1 first.** The MCP namespace shim is the single block on
"plug-and-play with any installed MCP server" — without it, two
servers exposing similarly-named tools throws on agent
construction. ~80 lines, one new file
(`src/runtime/mcp-namespace-shim.ts`), replaces a loop in
`src/runtime/mcp-servers.ts`. Land that, the SDK stops fighting us.

**Move 2 immediately after.** Once the shim exists, each wrapped
tool gets a `needsApproval` function that consults the name (rules:
`*_search`, `*_list`, `*_get` → never; `*_delete`, `*_send` →
always) plus the override file plus the global `autoApproveScope`.
DataForSEO lookups stop asking. Approval is now genuinely per-
intent, not per-arbitrary-tool-name.

**Move 3 after that.** `isEnabled` on the namespaced shim filters
the tool surface per turn. The model sees the ~20 tools that
matter, not the 300 it has access to. No directive needed to teach
it to ignore the rest.

**Then everything else, incrementally.** Lifecycle hooks (Move 4)
clean up our stream parsing. Structured outputs (Move 5) replace
every "respond like this" directive with a schema. Error surfacing
(Move 6) stops the hallucinated rationales. Computer use (Move 7)
turns the agent into a real desktop operator. Test harness (Move 8)
locks the gains. Slim `instructions.ts` (Move 9) prunes the file
down to identity + tone + one line of trust.

**The thing to *stop*** is adding another sentence to
`instructions.ts` every time the model misbehaves. Every reactive
directive there is debt against future contributors and against
fresh-install users who will hit different failure modes. The SDK
has given us the primitives to enforce the behavior structurally;
we just hadn't been using them.

The plug-and-play story isn't a new framework. It's
**`MCPServer` + `isEnabled` + `needsApproval` + `outputType` +
`computerTool`**. Five SDK primitives, used as the SDK intends them
to be used. That's the architecture.
