# People lookup as a skill; learned hints keep the shape, not the values — 2026-09-26

Branch `claude/wk-people-hints` (worktree `~/clem-worktrees/wk-people-hints`), based on
`claude/checker-evidence` at 31ffcf4d0. Nothing installed, pushed, tagged or merged. Live home
read only (`harness.db?mode=ro`, `run-strategies.json`, `workflow-suggestions.json`, the pending
plan proposal). This checkpoint holds the provenance the source comments do not carry.

## What we saw live (2026-09-25, Pacific)

- **Two colleagues' addresses for one send: 63 s, 12 model calls, about 595k prompt tokens**
  (seqs 302852–303011). Four memory reads, two of them the same `memory_read` call with invalid
  arguments (302900, 302901); a directory lookup keyed on a constructed address, refused 403
  (302911–302917); two `tool_search` calls and two toolkit searches (302888, 302933, 302951,
  302966); `session_search` (302964); and finally the inbox search by surname that found both
  addresses in the owner's own threads (302987–303001). No procedure existed for "a person's
  address", so the brain improvised, and its first guess was an address.
- **A "similar past run" hint carried an earlier prospect's website into a paid call.** The
  memory context at 302338 quoted the stored request text of strategy `strat-mufu1iy6`
  (`renderRunStrategiesForContext` → "A similar past run ("…https://<firm>/") succeeded
  with…"); the brain added that domain as a second target in the backlinks call at 302386. The
  value was never used.
- **A workflow suggestion said one firm's figure had been asked for "5 times over 2 days"**
  (plan-f4bbda0d, 10:18 PT, pushed to desktop, Discord and Slack). The five turns re-selected the
  same proven strategy about five different firms; the card quoted the first firm's request as if
  it were all of them, and named the workflow after those words.
- **Stored shapes leaked instance paths.** In the live strategy store, `read_file` shapes kept
  the owner's file path literally (`{"path":"~/.clementine-next/output/…/note.txt"}`) because
  `path` was a blanket literal key; only an API route beside a `method` is an operation selector.
- **Provider-carrier shapes had no roles.** A `work_call` → `composio_execute_tool` call
  serializes the operation's arguments once more inside `arguments`; the learned shape recorded
  `"arguments":"string"` and every role was lost (reproduced in the hint-shape pin before the fix).

## Rules that landed

| Rule | Where |
|---|---|
| A hint about a past run names the tools and the role of each argument (`data[].target`), never the earlier request's text, targets, figures or handle | `src/memory/run-strategy-store.ts` (`renderOne`, `describeProvenShapeRoles`), `src/runtime/jev/proven-operation.ts` (`renderProvenOperationGuidance`, restated and routed alike) |
| Only operation selectors stay literal in a shape: `method`, `tool_slug`, and `path`/`endpoint` beside a `method` with resource segments elided; a stored shape is re-read under this rule once and written back | `shapeOfProvenArguments`, `elideRouteResources`, `normalizeProvenShape`, `readStore` |
| A provider carrier's serialized `arguments` are unwrapped before the shape is taken | `src/runtime/harness/host-run-strategy-learning.ts` |
| A workflow suggestion counts repeats by the shape of the work and says so; its card, plan and name describe the tools and roles, never one ask's words; a still-pending legacy card is restated once in place, without a new notification | `src/agents/workflow-suggestions.ts`, `restatePendingPlanProposal` in `src/agents/plan-proposals.ts` |
| People lookup is a built-in skill: memory first, then the owner's own mail threads and contacts, then a readable directory by name; never a constructed address; one plain question when nothing resolves; the found address is remembered with where it was found | `builtin-skills/people-lookup/SKILL.md`, registered in `src/setup/builtin-skills.ts`, shipped by the existing built-in path (`scripts/hotpatch-daemon.mjs`, `scripts/smoke-packed-candidate.mjs`) |

Kept deliberately: Jev's turn-start candidates still see the stored request text (`control-plane.ts`);
that is the relevance judge's input and never reaches the brain or the owner. The strategy record
keeps `objective` and `deliverable` for audit, dedupe and Jev; nothing renders them.

## Pins

- `src/runtime/harness/people-lookup-resolves-from-own-mail.integration.test.ts` — a real host
  turn: the packet names the skill; the brain reads it, searches memory, discovers the mail
  search, reads the thread the person sent, remembers the address with its source; the only
  provider crossing is the search by name; no call carries an address before a source returned
  one. The next turn resolves from the host's memory context with zero tool calls, well under 5 s.
- `src/runtime/harness/learned-hints-keep-shape.integration.test.ts` — a restated run about a
  second target binds before the first frame; the guidance and the memory-context hint name the
  tool and `arguments.target`, `arguments.include_subdomains`, and nothing the brain receives on
  that turn carries the first target.
- `src/agents/workflow-suggestions.test.ts` — five asks about different targets produce a card
  that says "the same kind of request has come up 5 times over 2 days", names tools and roles,
  and never quotes one ask; a pending legacy card is restated once, answered ones are left alone.
- Unit pins in `run-strategy-store.test.ts`, `host-run-strategy-learning.test.ts`,
  `proven-operation.test.ts`, `builtin-skills.test.ts` (the skill surfaces for sends and invites
  naming a person, not for unrelated work).

## Known gaps and decisions for the owner

- `memory_remember`'s best-effort `derivedFrom` link does not bind to a provider read that ran
  through `work_call`: the authority resolver sees the carrier and its transport mirror under one
  call id and treats the id as ambiguous. The remembered fact carries its source in its text. This
  is the authority machinery's seam, not the skill's.
- The skill surfaces through the shared lexical anchors (two independent signals); "email the
  summary to Priya" alone has one signal and is not surfaced, "send Priya the summary by email"
  is. A name detector would be the wrong shape; the model can still `skill_list`.
- A workflow name now comes from the tools ("Sampleseo get backlinks summary"); a model-written
  label for the kind of work would read better and costs one small call per proposal.
- Existing pending suggestion plan-f4bbda0d will be restated in place on the first tick after
  install; its already-delivered notification title cannot be recalled.
