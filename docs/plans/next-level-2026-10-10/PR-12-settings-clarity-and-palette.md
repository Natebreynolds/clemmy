# PR-12 — Settings that explain themselves, and a command palette that acts

Size S · risk low (UI) · depends on PR-02 for the "Clem explains" cards; the rest standalone

## Why

The owner's words: "little things in the settings the user has to select
themselves where Clementine should offer suggestions". Beyond models (PR-03/04),
the audit found:

- **Auto/Ask is in two different places.** Desktop keeps the mode under Advanced ›
  Autonomy (`apps/console-web/src/screens/advanced/AutonomyForm.tsx:260-269`,
  behind developer-ish navigation); the phone has it as a top-level Settings row
  (`apps/mobile-web/src/screens/Settings.tsx:223-283`). Working style
  (`watch | balanced | hands_on`), check-in minutes and quiet hours have no
  explanation on either.
- **The command palette only navigates** (`components/AppShell.tsx`,
  `CommandPalette`). The most agentic surface in the app cannot ask Clem, run a
  workflow or answer the waiting card.
- **Quick actions start empty** with no suggestions; the only starters are static
  lists in `AutomateCreate.tsx:30` and `CreateWorkspaceModal`.
- **"Automatic" labels state a fact without a reason** across Settings; the reasons
  exist in code (`checkerSettingsFacts`, `proactivity-policy.ts`).

## Change

1. **Mode moves up.** Settings (desktop) gets an "Approvals" row under the
   Clementine group with the same Auto / Ask control and the same hint text the
   Advanced form shows, reading and writing `PATCH settings/policy` exactly as
   today; Advanced › Autonomy keeps the full form and links back. The learned
   write kinds list ("Changes you've approved once") moves with it. Phone unchanged.
2. **Every automatic choice says why.** A shared `settingReason()` helper in
   chat-engine renders one sentence per automatic setting from the facts the
   daemon already returns (`GET /api/console/settings`): the checker's family
   reason, why quick follows the brain, why memory follows the checker, why the
   mode is Auto. Shown as a muted line under the control on both surfaces.
   Working style and check-in minutes get their hint sentences (from the
   `proactivity-policy` doc comments, not new policy).
3. **The palette acts.** Three verbs, each through an existing path:
   - "Ask Clem: …" (free text → the chat composer's send, same as typing);
   - "Run workflow …" (the list the Automate screen already loads → the same Run
     endpoint, with its queued/held/duplicate receipt shown as a toast);
   - "Answer the waiting card" (jumps to Needs you's first item; the answer itself
     stays on the card).
   No new endpoints; the palette becomes a keyboard door to doors that exist.
4. **Quick-action suggestions.** On a Home with fewer than three quick actions,
   From Clem shows one PR-02 suggestion of kind `quick_action` built from the
   conversation history's three most repeated opening lines (the same signal
   `workflow-suggestions.ts` uses for "save as workflow"); a yes adds it through
   `PATCH settings/home` (`quickActions`, max 24). Never on a blank home.

## Files

- `apps/console-web/src/screens/Settings.tsx`, `screens/advanced/AutonomyForm.tsx`
  (extract the Mode control into a shared component), `components/AppShell.tsx`,
  `components/CommandPalette*.tsx`
- `packages/chat-engine/src/setting-reasons.ts` (new) + test; phone `Settings.tsx`
- `src/agents/workflow-suggestions.ts` (expose the repeated-opening signal),
  `src/dashboard/from-clem.ts`

## Tests

- The Mode control writes the same payload from Settings and from Advanced
  (fixture compares requests).
- Reason sentences pinned for each automatic case; absent facts render nothing.
- Palette: "Ask Clem" produces the composer's request; "Run workflow" shows the
  receipt wording from `workflow` run tests; nothing runs without a selection.
- Quick-action suggestion: fewer than three actions and three repeats ⇒ one
  suggestion; blank home ⇒ none; a yes adds exactly one action.

## Done when

The owner can switch Auto/Ask from Settings on desktop with the same effect as
before, every "Automatic" in Settings → Models and Approvals carries its reason on
both surfaces, and ⌘K can ask Clem or run a workflow.

## Do not

- Do not change what Auto or Ask means, or the learned-kinds policy.
- Do not add palette actions that approve or send; those stay on the card.
- Do not seed quick actions from a static list.
