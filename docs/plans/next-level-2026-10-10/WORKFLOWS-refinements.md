# Workflows: visualization, creation, editing and running — refinements

2026-10-11 · status: proposed · read from main `b0612dd` · companion to the plan in this folder

## 1. How it works today (verified in code)

**The file.** A workflow is a directory with `SKILL.md` (or a legacy flat
`<name>.md`; `migrateLegacyWorkflowsOnce`, `src/memory/workflow-store.ts:1125`,
moves flat files into directories without changing their content). The
frontmatter holds `steps:` (ids, `dependsOn`, `call`, `transform`, `forEach`,
`subgraph`, `model`, `intent`, approval fields); the body holds each step's
prompt under `## step: <id>` headings, and everything before the first heading
is `description_body` prose (`parseBody`, `:814`). A frontmatter step whose
body section is missing falls back to its frontmatter `prompt` (`:890`).

**The graph.** `GET /api/console/workflows/:name` (`console-routes.ts:5977`)
returns `graph: buildWorkflowGraph(entry.data.steps, …)`
(`src/dashboard/workflow-graph.ts`): **one node per frontmatter step, one edge per
`dependsOn`**, badges for `forEach`, approval, skill and deterministic, and per-node
readiness, execution-plan and contract projections. Beside it: the plain-English
summary (`describeWorkflowPlainEnglish`), proof, certification, the dry-run
simulation (`WorkflowDryRunStep`: executor, effect, `touches.tools`, `reads`,
`emits`, `gated`, `fanout`, `model`), and the shared layout sidecar.

**The canvas.** `WorkflowPage.tsx` draws that graph with React Flow, lays it out
from the daemon's level/lane plan, keeps positions in the sidecar
(`PUT …/layout`) with a browser fallback, rewires through `PATCH stepEdits`,
and edits "the everyday four" of a step through `POST …/steps/:stepId`
(`editWorkflowStepLive`, with backups and revert). "Test this step" runs one
step. The page's header comment still says the panel is read-only; it is not.

**Runs.** `POST …/run` answers with the real queued, held, duplicate or
readiness-refused receipt (v3.18.32). Run detail is folded from `events.jsonl`
(`buildWorkflowRunDetail`: step, item and attempt events, tokens and cost per
step). A run's step session is a harness session whose id carries
`runId:stepId[:itemKey]` (`parseWorkflowSource`), and `RunThread.tsx` already
renders that session's projected events as writes, deliverables and activity.
The canvas shows a per-step overlay for the shown run (`overlayQuery`).

**Creation.** `AutomateCreate.tsx` is an authoring chat beside a live draft
(`DraftCanvas`: name, schedule, step list, gates, goal). `workflow_create` tells
the model to prefer `call` and `transform` over prompts, to declare `dependsOn`
and side effects, and to use `subgraph read_parallel_v1` for heavy reads.
`workflow_schedule` authors **one** step plus the schedule by design
(`workflow-schedule-tools.ts:175-199`). `POST …/from-session` saves a workflow
from a conversation. Codify-on-author (`workflow-codify.ts`) turns a mechanical
single-tool prompt step with a declared contract into a direct `call`.

**Phone.** List, run, run detail and cancel; no graph; create, edit and enable
say "from the desktop app first". The chat card after a create or update
(`WorkflowCardData`, levels by `dependsOn`) exists on both surfaces.

## 2. Why a legacy workflow shows one block

Three causes, in order of how often they bite. All verified by reading the
builder and the authoring tools; the 10-09 Spaces audit of the live home found
28 of 32 workflows are "one long model step".

1. **The definition really has one step.** Anything authored through
   `workflow_schedule`, `from-session`, or an early `workflow_create` before the
   call/transform guidance is `steps: [{ id: 'main', prompt: <the whole job> }]`.
   The prompt often contains the owner's numbered list ("1. pull the deals,
   2. draft a follow-up, 3. post to Slack") and the runtime does all of it inside
   one harness turn with many tool calls. The canvas is faithful to the
   definition and blind to the work.
2. **Structure the engine knows is not drawn.** A `subgraph` fan-out is
   compiled into specialist nodes by the engine (`compileWorkflowStepsToGraph`,
   `workflow-graph.ts:190`) but the dashboard builder draws only the reducer
   step. `forEach` is a badge, not a stack. `description_body` prose, which in
   legacy files is where the steps are described, is not drawn at all.
3. **Edges only come from `dependsOn`.** Legacy files that used the deprecated
   `orderingOnlyDeps` get no edges (the builder reads only `dependsOn`), so a
   sequence draws as unconnected nodes. Worth checking separately: the runner
   does not read `orderingOnlyDeps` either (only the validator warns), so such a
   workflow now runs its steps concurrently. That is a semantic drift from the
   older ordering model, not just a drawing gap.

"Sometimes" is cause 1: the same owner has workflows from both authoring paths,
and only the scheduled or chat-saved ones are one block.

## 3. Refinements, ranked

Each is framework-level, provider-neutral, and changes nothing about how a run
executes unless the owner takes the action. Byte-identical rendering when the
feature has nothing to show.

### R1. Draw what a step does, not only what it is (desktop and phone)

**Why.** For a one-step workflow the interesting structure is inside the step.
Two sources already exist and neither is on the canvas: the dry run's per-step
`touches.tools`, `reads`, `emits`, `effect` and `gated`; and the last run's
observed activity for that step's session (reads, writes, sends, apps, files),
which `RunThread` already folds from projected events.

**What.** A node gains an "inside" strip: up to four chips from the dry run
(executor, effect, apps or tools touched, gated), and after a run an observed
line ("read calendar, drafted 3 emails, sent 0"). Expanding a node shows the
observed sub-steps of the last run as a vertical list inside the node, derived
from the same `runActivityItems` fold, labelled "what it did last time", never
drawn as edges. The step panel's "What this step does" section shows the same
list with the receipt line and links to the run thread.

**Where.** `src/dashboard/workflow-graph.ts` (dry-run fields onto `meta`),
`apps/console-web/src/lib/workflow-step-view.ts`, `WorkflowPage.tsx` node
component, a presenter in `packages/chat-engine/src/` so the phone's levels
renderer shows the same chips.

**Tests.** Builder: dry-run fields map onto nodes, unknown stays empty. Fold:
a fixture step session yields the observed list; no run yields nothing. Parity
fixture for the presenter.

### R2. "Split into steps", with Clem

**Why.** A one-block workflow should become a real graph, but only the model can
turn prose into `call`, `transform` and prompt steps with `dependsOn`, and the
owner must see the result before it is saved.

**What.** On a single-step workflow, or any step whose prompt carries three or
more numbered actions, the page offers "Split into steps". It opens the existing
Ask-Clementine conversation (`askAboutStepPrompt`) with a structured ask: keep
the trigger, inputs, body and goal; author the steps with the executor rule
`workflow_create` already states; preserve approvals; name each step from the
owner's own words. The result lands as a `workflow_update` proposal shown as a
diff on the canvas, using the added/changed/removed step ids the chat card
already carries, with "Apply" running the normal update path, creation test
included, and "Keep as one step" dismissing it. Nothing is saved until Apply.

**Where.** `WorkflowPage.tsx` header action and step panel, `workflow-step-view.ts`
(the detection is a count of numbered lines, not a parser of intent),
`src/tools/orchestration-tools.ts` (no schema change; the ask is a prompt),
`packages/chat-engine` card for the diff.

**Tests.** Detection fires at three numbered actions and not at two; a
proposed update renders as a diff with the right id sets; Apply goes through the
same handler the chat's `workflow_update` uses; dismiss writes nothing.

**Do not.** Do not split by regex and save; the model authors, the owner applies.

### R3. Draw the structure the engine already has

**What.** The dashboard builder projects `subgraph` specialists as nodes under
their reducer, reusing the engine's own node derivation so the two graphs cannot
disagree; `forEach` steps draw as a stacked node with the last run's item counts
(`items.started/completed/failed`); deprecated `orderingOnlyDeps` draw as dashed
"after" edges with the validator's deprecation note on hover.

**Where.** `src/dashboard/workflow-graph.ts` (import the specialist derivation
from `src/execution/workflow-graph.ts`), `workflow-canvas.ts` layout (a stacked
node is one node with a count), `WorkflowPage.tsx` edge styles.

**Tests.** `workflow-graph.test.ts` gains: a subgraph step yields reducer plus
specialists with join edges; a forEach step carries counts after a run; an
`orderingOnlyDeps` edge is drawn dashed and never as a dependency.

### R4. Ordering, made explicit and honest

**Why.** N steps with no `dependsOn` run concurrently. Legacy authors who wrote
them as a sequence may not know; the canvas currently shows a pile.

**What.** When a workflow has two or more steps and no dependency edges, the
page shows one line, "These steps run at the same time", and the action "Run
them in order", which writes `dependsOn` chains through the existing
`stepEdits` PATCH (owner action, undoable through the existing step-edit
backups). The validator's `orderingOnlyDeps` warning gets the same action.

**Do not.** Never infer order and write it silently; it changes what runs.

### R5. The live run on the canvas

**What.** The per-step overlay gains the step's model (label), tokens and cost
from the run detail, and the think/work/write/check rail from the step session's
projected phases; clicking a running node opens that step's run thread. This is
the same data `RunThread` and `buildWorkflowRunDetail` already read; nothing new
is recorded.

### R6. The phone sees the graph

**What.** A read-only canvas on the phone from the same `graph` and `layout`,
drawn with the levels renderer the chat card already uses (no React Flow on the
phone); the everyday-four edit and enable on the phone through the same two
routes the desktop uses, replacing "from the desktop app first".

### R7. Creation shows the shape as it forms

**What.** `DraftCanvas` renders the draft's steps as the levels graph while the
model commits them, with the dry run's "would touch" chips as soon as the draft
is saved, so the owner sees a one-block draft for what it is before it is
enabled. Starters come from repeated recent work (`workflow-suggestions.ts`
already finds it) instead of the static list.

### R8. Finish editing on the page

**What.** The step panel already edits the everyday four. Add: `call` tool and
args with the validate route before save; the `transform` expression with a
small expression helper and the same validation; `model` and `intent` with the
model picker's chips (PR-11); `requiresApproval` with its preview. Every edit
stays on `editWorkflowStepLive` so backups and revert cover it. Fix the stale
header comment.

### R9. A health check that names the shape

**What.** `checkWorkflowHealth` gains two advisory items: "one step with several
numbered actions" and "several steps with no order", each pointing at R2 or R4.
Shown on the list card and the page header, never blocking.

## 4. Order and sizing

| Order | Refinement | Size | Touches a run? |
|---|---|---|---|
| 1 | R3 draw the engine's structure | S | no |
| 2 | R1 inside the step | M | no |
| 3 | R9 health check | XS | no |
| 4 | R2 split into steps | M | only on Apply, through `workflow_update` |
| 5 | R4 ordering made explicit | S | only on the owner's action |
| 6 | R5 live run on the canvas | S | no |
| 7 | R8 finish editing | M | through existing step edits |
| 8 | R6 phone graph | M | no |
| 9 | R7 creation shape | S | no |

R3, R1 and R9 are pure drawing and can ship together; they are what makes a
legacy workflow stop looking like one block without touching its definition.
R2 is the real fix and needs the owner's Apply every time.

## 5. Rules

- The canvas never invents an edge or a step that changes what runs; observed
  structure is labelled as observed.
- The definition on disk is the only source of truth for nodes; the sidecar
  holds positions only; raw-subprocess legacy declarations stay parseable.
- Every graph change is pinned in `src/dashboard/workflow-graph.test.ts` and
  `workflow-canvas.test.ts`; every card in the chat-engine presenter with a
  phone parity fixture; live acceptance on a named `clem-fixture` workflow in
  the installed app, never on a personal workflow.
