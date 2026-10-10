# PR-04 — Clem sets herself up: one plan card after connecting, on first run, on the agent form

Size M · risk additive · depends on PR-03 · ships with PR-03 as one release

## Why

The moments when the owner is deciding how to use their models are exactly the
moments Clem says nothing:

- Right after connecting a provider, `UseItFor` (`ModelProviderForms.tsx:196-244`)
  asks "What should X do?" with four bare buttons (Does the work, Writes the final
  answer, Checks the work, Helps in parallel).
- On first run the wizard's auth step (`apps/desktop/src/setup-window.ts`,
  `setup-state.ts:294-305`) connects an account; the roles fall to compiled-in
  defaults; "Set up next" later offers "second-model" from a fixed list
  (`from-clem-setup.ts:31`).
- The agent form (`AgentForm.tsx:135`) has a model field with no guidance, and a
  pinned model that is unavailable later refuses the run (`router-model.ts:239`).

This PR turns those three moments into one card: Clem's plan for the models the
owner has, every row explained, accepted with one tap or edited row by row.

## Change

### 1. A plan is a suggestion with several rows

Extend PR-02's proposal with `{ type: 'settings_batch', calls: SettingsCall[], undo: SettingsCall[] }`
applied in order through the same handlers, all-or-nothing: if a later call is
refused (an inactive model), the earlier ones are undone and the suggestion stays
open with the refusal in its words. The batch allowlist is the same as the single
call allowlist.

### 2. The plan engine

`src/runtime/harness/model-plan.ts` (new), pure: `proposeModelPlan(input): ModelPlanV1 | null`
over the PR-03 input. It fills every role from what is connected:

| Role | Rule |
|---|---|
| brain | **Never changed by the plan.** The row shows the current brain and why ("You signed in to Claude, so Clem works on Claude Sonnet 5" from `claude-brain-adoption`), with "Change" linking to the existing active-brain switch. |
| judge | A different family from the brain, preferring the measured best (scorecard), else that family's fast tier by capability (PR-11) or the fast preset of the provider when unmeasured. If no second family is connected, the row says so and offers the existing "connect a second model" setup step instead. |
| worker | The cheapest connected model with tool support that is not the brain, measured first; else the brain (today's default). |
| quick | The fast tier of the brain's family when connected, else the worker. |
| writer | The brain (today's default); only measured evidence that another model's writer objective rate is higher proposes a change. |
| memory | A local model when connected (PR-09), else the checker (today's default). |

Each row carries `why` words and evidence lines exactly as PR-03 does. A row that
equals the current resolution is shown as "keeps" and produces no call. A plan with
zero changes is not raised.

### 3. Three doors

- **After connecting** (`ProviderManagePanel` / `UseItFor` moment): the card
  replaces the four buttons as the first thing shown: "Here's how I'd use what you
  connected" with the rows, "Yes, set it up" / "Let me choose" (which reveals the
  existing buttons and selects) / "Not now". The phone shows the same card in its
  models sheet after a sign-in.
- **First run**: the desktop wizard's launch step (`setup-state.ts` step `launch`)
  queries `GET /api/console/models/recommendations?plan=1` once the daemon is up
  and shows the same card as a page; "Yes" applies the batch, "Later" leaves the
  defaults and raises the suggestion in From Clem so it is not lost. The wizard
  never blocks on it.
- **Agent form** (`AgentForm.tsx`, phone agent editor): beside the model field,
  "Clem's pick for this agent" with one line of why (from the scorecard by role and,
  where the agent has an intent word that matches a measured intent in route
  metrics, by intent). Tapping it fills the field; nothing is pinned without the
  owner's save. When a saved agent's pinned model becomes unavailable, the agents
  list shows PR-03's R6 suggestion for that agent instead of waiting for the run to
  refuse.

### 4. Words

The card speaks as Clem and names labels, not ids. Example rows:

- "Checks my work: DeepSeek V4 Flash. A different family than my brain checks
  the work, and DeepSeek has been the fastest of yours."
- "Helps in parallel: Kimi K3. It handles tool calls and you are not paying by the
  token for it."
- "Memory: your local model. Learning runs here for free, overnight."

## Files

- `src/runtime/suggestions/suggestion-record.ts`, `suggestion-apply.ts` (batch)
- new `src/runtime/harness/model-plan.ts` + test
- `src/dashboard/console-routes.ts` (`?plan=1`), `src/channels/mobile-routes.ts`
- `apps/console-web/src/screens/settings/ModelProviderForms.tsx`,
  `apps/console-web/src/components/agents/AgentForm.tsx`
- `apps/desktop/src/setup-window.ts`, `setup-state.ts` (one optional page)
- `apps/mobile-web/src/screens/BrainSheet.tsx`, the agent editor
- `packages/chat-engine/src/suggestion-presentation.ts` (plan rows)

## Tests

- Plan engine: one family connected → judge row says "connect a second model" and
  no judge call; two families → judge is the other family; brain row never
  produces a call; a plan equal to the current resolution is `null`.
- Batch apply: a refused third call undoes the first two and leaves the suggestion
  open; undo of an applied batch restores every previous binding.
- Wizard: the launch step renders without the daemon's answer and never blocks on
  it (timeout fixture).
- Agent form: the pick fills the field only on tap; saving without tapping stores
  nothing new.
- Parity: the plan card renders the same rows on console and phone.
- Byte-identical: with no provider connected since the last plan and no open
  suggestion, `UseItFor` and the wizard render as on main.

## Done when

Connecting a second provider on the installed app shows Clem's plan within the
same screen, one tap sets the checker and helpers through the normal handlers, the
scorecard (PR-01) shows the new models carrying those roles on the next turns, and
Undo restores the previous bindings.

## Do not

- Do not let the plan change the brain or any agent's pinned model.
- Do not auto-apply the plan on first run; "Later" must be a full path.
- Do not hide the manual buttons and selects; "Let me choose" must reach them.
