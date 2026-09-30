# 2026-09-29 — the shell anywhere

Branch `claude/shell-anywhere` on main `4e2efe15b`. Owner direction: "clem
should be able to run shell or bash when needed anywhere", "she should be
able to do everything that Claude Code and other coding CLIs can do", with
the two modes (Auto = anything non-disruptive runs; Ask = certain external
writes ask; no cards for local work).

## What a shell command does on a chat turn now

| The command | Before | Now |
| --- | --- | --- |
| Reads, computation (`ls`, `grep`, builds, tests, GET) | ran through `work_call` under its compute envelope | unchanged |
| Changes local files (`cp`, `mkdir`, `git commit`, installs, `>`) | refused `work_contract_required`; no path to ask | runs as ordinary accepted work: `cap:local:run_shell_command:ordinary`, reversibility `ordinary_non_destructive` → `exact_ordinary_work`; no plan, no card |
| Leaves the machine (POST, `git push`, deploy, publish) | refused `catalog_entry_or_manifest_missing`, sent to discovery, which cannot publish it | refused with the door named: `pending_action_queue` with the exact arguments (typed edge `queue_for_approval`); the turn opens ONE card whose preview is the command; approving it runs the command once and settles the resume with what landed; no model turn after the approval |

Guards inside the tool are untouched and run on every path: hard blocks,
credential refusal, Clem's own stores, the long-wait refusal, the starting
folder rule. `shell-off-machine-card.integration.test.ts` proves a `cat
.env | curl -X POST …` is still refused after the owner approves its card.

## Defects found on the way (all fixed in `c9397d5b4`)

- `materializeQueuedApprovals` was never called on the host_v1 branch of
  `runConversation`; a `request_now` queue record stayed inert there.
- A desktop-approved pending-action card resumed the model on a synthetic
  `approval_resume` source, which host_v1 priming refuses (`invalid_source`
  → "malformed or ambiguous"); the approved action never ran. It now runs
  directly (`executeApprovedLinkedActionAndSettle`).
- The local lane of `dispatchInnerLocalTool` ignored the approval's
  accepted source, so a local tool's attempt could not settle after a card.

## Still open

- A host consent card for a graphless LOCAL call (a sensitive-path
  `write_file`) resumes with basis `exact_user_grant` and no native token,
  so `work_call` refuses the approved call. Read, not yet tested or fixed.
- Settings trim to the two modes (Auto / Ask); run-limit knobs fixed
  internally.
- Kernel confinement (macOS sandbox) for the command itself.

## Pins

`src/runtime/harness/shell-local-change.integration.test.ts` (21),
`src/runtime/harness/shell-off-machine-card.integration.test.ts` (2),
`chat-approval-resume.test.ts`, `pending-action-transition.test.ts`,
`tool-search-relevance.test.ts`, `local-planning-capability.test.ts`;
484/484 across the touched areas; full suite recorded in
`output/shell-anywhere-0929/qualification/`.
