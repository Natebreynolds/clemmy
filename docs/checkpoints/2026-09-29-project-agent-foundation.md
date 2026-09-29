# Projects, specialist agents and scoped learning — 2026-09-29

Branch `claude/project-agent-foundation`, worktree `~/clem-worktrees/project-agent-foundation`, based on local main
`22c1cf0f3`. Framework only. Private evidence is under `output/project-agent-foundation-0929/` (ignored).

## Owner direction

2026-09-29: "I organize work into projects, assign specialists, and speak either to Clem or directly to an agent.
Agents have skills and accumulated learning. Clem can delegate tasks, follow their progress, relay my corrections,
and report back. Desktop and mobile show the same work and decisions." "Shared brain means shared infrastructure
and relevant knowledge — not dumping every agent's memory into every prompt." One complete everyday-work
experience for the next release, as the foundation for coding agents later.

## Ownership

Checked before any change: no other agent had uncommitted or newer work in any worktree. The Codex worktrees were
all from 2026-09-25 and clean. This branch also carries graded learning (`claude/graded-learning`), merged so the
two are qualified and installed as one candidate.

## What existed, and what did not

| Area | Existed and live | Missing |
| --- | --- | --- |
| Agents | One saved record; switch mid-conversation with authorship kept per reply; instructions and pinned skills reach chat turns, helper runs and the reviewer | Memory scope, tool list and chat model were stored and did nothing. On the Claude lane the agent's instructions never reached the model. No link to any project |
| Projects | Nothing. The word already meant a local code folder, a workflow's default folder, a fact kind and a compiled plan graph | A record, assignments, bound accounts, a pointer on the conversation |
| Delegation | Background tasks: durable, versioned corrections, stop, resume in place, restart safety, report-back to the conversation that started them | No agent or project on a task; every task ran as Clem on her own model. No owner on the card |
| Memory | Facts, episodes, remembered methods, provenance, correct / forget / pin | No scope on any store or read. The same sentence in two projects was one record |
| Routing | The router picks a remembered method and an operation at turn start | It never picked an agent |
| Cost | Usage per call with attribution; totals per turn | No total for a whole request: helper sessions and delegated tasks were left out of every reader |

## Nouns

| Noun | What it is here |
| --- | --- |
| Project | A durable body of work: purpose, goals, standing context, accounts and resources, assigned agents. `src/projects/project-record.ts` |
| Assignment | One agent in one project: what it answers for there, and context that applies only there |
| Space | A surface. A project may list Spaces among its resources. A Space is not a project |
| Task | One delegated piece of work: the existing background task record, now with an owner and a project |

Nothing that already used the word "project" was changed or given this record's id: the code-folder roster and
`/api/console/projects`, a workflow's `project`, the legacy `project` field on an agent file, the fact kind, the
plan graph.

## Decisions, and why

1. **The project record has its own database and minted ids.** `state/projects/projects.db`. Several agents ship
   builds to the same installed app; two branches that each add the same next schema version skip each other's
   tables. Ids are never derived from a name and never reused, because memory and tasks are scoped by them.
2. **Delegation extends the background task.** It was already the durable owner. A task now carries who it was
   delegated to and which project it works in, frozen when it is created and written on its own run session.
3. **Memory scope is a table beside the records, not a numbered migration.** Two optional ids per scoped record.
   A record with no row is for everywhere, so nothing existing is rewritten and a rolled-back build still opens
   the database.
4. **What is true of the owner, and a rule that must hold, are for everywhere.** Project facts, references and
   corrections take the scope of the session they came from. A rule is kept for one project only by the owner's
   own act.
5. **A correction goes to the owner of the work.** Revised while the task is open; a task that follows it once
   it has ended. See the baseline below for why.
6. **One set of routes for both apps**, mounted under each one's prefix and authorization.

## What was built

| Commit | Change |
| --- | --- |
| `bd15efa4a` | Project record, assignments, resources; the conversation's project pointer; project context in the stable prefix after the agent's; project on each turn's route marker and in the reviewer's context; agent context on the Claude lane |
| `850a53bc0` | Delegation on the task record; `dispatch_background_task` gains `agent`, `project`, `artifact_destination`; the router asked which assigned agent is responsible when nobody was named; `delegated_task_state` on the conversation that delegated |
| `a3d5c89d5` | `project_save`, `project_get`, `project_list`; accounts bound only from the live connection list; shared views and routes |
| `f72f56fb1` | A new conversation can open inside a project; a successor conversation keeps it |
| `cf279d737` | Scoped memory on facts, episodes, remembered methods and resolved references; the whole-task cost total |
| `533497c79` | Graded learning merged in: a resolution carries its grade and its scope |
| `9918a21bc` | A correction to finished work becomes a task that follows it |
| `1d29d0c08`, `3104572bf`, `c2586fb46`, `6fae79f57` | What both apps asked for: project labels for waiting items, connected apps, app names, which decisions are decided on a card, the name of an agent that is gone |
| `30f1d2b94`, `a7bd8a950`, `daae8d208`, `99152cc60` | One set of words in the shared chat engine; the desktop and the phone |
| `17e2a29a3` | Review of delegation: stopped work is corrected in place, only finished work is followed, unattended work cannot reorganise a project |
| `cb69249c6` | Review of scoped memory: leaks, promotion and crowding closed; a request keeps the scope it began in |
| `98b48f3cf` | The card says what a correction will do |
| `d74884f68` | Found live: `project_save` is a host control; promoted work finds its agent; each turn is told about delegated work |
| `724a3d569` | Found live: `delegated_task_correct`, a control for handing a correction to the task's owner on an ordinary turn |
| `ec7c91836` | Each chip beside the composer stays whole when the row is short of room |
| `014c96896` | `src/projects` tests join the suite every release runs |
| `69380dcf9` | A workflow does not ask which account when one account was only registered more than once |
| `3028b8bea` | A project links to the local projects its work happens in; coding runs from its conversations are listed with its work |
| `918da9edb`, `69dc284e7`, `cbcd2ec5f` | The words for local projects and coding work in the shared chat engine; the desktop and the phone |
| `4d7c3c6a3` | Test example paths without a home folder, so the public hygiene check passes |

### Who sees what

| Kept for | Seen by |
| --- | --- |
| Everywhere | Every turn |
| A project | Clem and the assigned agents, inside that project |
| An agent, wherever it works | That agent, in any project |
| An agent in a project | That agent in that project, and Clem inside that project |

Work with no turn behind it (maintenance, the owner's own Memory screen) sees everything. When scopes cannot be
read, a turn is shown no scoped knowledge and is held to every standing rule.

### Who does a delegated task

A project named by the caller, otherwise the conversation's own. An agent named by the caller, otherwise the agent
the conversation is already in, otherwise the one assigned to the project that the router is sure is responsible
(0.80), otherwise nobody. A name that is not saved starts nothing; neither does an agent that is not assigned to
the project. A conversation's own agent that is not assigned to the project is set aside and nobody is suggested
in its place. The task runs on the model the agent asks for, otherwise the owner's helper role; a task started
from a conversation already in the agent keeps the model such a task always ran on.

Work moved to the background by any path (`enqueueDurableChatTask`) takes the conversation's project and its own
agent. When nobody was chosen and the project has agents assigned, the task asks the router once, as it starts,
and keeps the answer (`src/projects/inherited-delegation.ts`).

### Correcting delegated work

| The task | A correction from the owner (card) | A correction relayed by the model |
| --- | --- | --- |
| open | the same task, next request version | the same |
| finished | a new task for the same owner that follows it; a second correction goes to that follow-up while it is open | the same |
| stopped, failed or cut off | resumes in place with the correction, same run and receipts | refused: only the owner restarts stopped work |

Each turn of a conversation is told which tasks were delegated from it, or belong to its project, who owns each
and where its result is (`src/projects/delegated-work-pointers.ts`). Clem hands a correction over with
`delegated_task_correct`; the turn ends on the handover.

### Local projects

Owner, 2026-09-29: "project need to be able to link to local projects that clem will work in." A project's
resource of kind `folder` is a link to one of the machine's own local projects (the roster the app already keeps
under Connect), chosen by name or by folder. A folder that is not on that roster is refused with the roster to
choose from, by the routes and by `project_save` alike; a partial name is not guessed. The project's context names
each linked local project and its folder. The overview says whether the folder is still there and whether it is a
git repository, and lists the coding runs started from the project's conversations. Linking grants no access:
what may be read or written in a folder is decided where it always was.

### A workflow's account

A scheduled run paused with "N accounts are registered" although one account existed: every disclosure of an
operation in a conversation registers it again under a new capability id, and the compiler counted registrations.
It now asks only when the accounts differ, and otherwise uses the registration issued last. The store still
accumulates registrations and nothing prunes them; a saved choice between real accounts is still invalidated when
the set changes.

## Baseline on the installed build, before this work

`47f192e2d`, fixture `project-agent-foundation-0929`, one run each, 2026-09-29.

| | Background briefing | Correction | Follow-up in a new conversation |
| --- | --- | --- | --- |
| Who did the work | a task as Clem | Clem in the foreground | Clem |
| Reply | 0.2 s | 4 min 53 s | 12.0 s |
| Terminal | done | blocked | done |
| Answer correct | yes | yes | yes |
| Model calls | 13 | 19 | 10 |
| Prompt tokens (cached) | 155,358 (101,888) | 234,958 (165,440) | 103,962 (67,136) |
| Output tokens | 6,196 | 26,388 | 2,509 |

The task ran 50 s and had ended before the correction arrived. The correction was applied to nothing: Clem redid
the work herself, overwrote the draft, and ended unable to verify her own write. The follow-up found the draft
only after five lookups through conversation history.

## Verification before installation

| Check | Result |
| --- | --- |
| Full suite on `4d7c3c6a3` (the final tip, what is installed), two files at a time beside the live app | 18,660 tests, 18,654 pass, 0 fail, 6 skipped. Typecheck, hygiene checker and operation identity check pass |
| Journeys, engine tests and release checks on `4d7c3c6a3` | Still running when the tag was made. Last results on earlier tips are below and in the release notes |
| App, shared chat engine and project tests on `cbcd2ec5f`, run by name | 1,196 tests, 1,195 pass. The one is the TopBar pin |
| Full suite on `3028b8bea`, two files at a time beside the live app | 18,652 tests, 18,575 pass, 70 fail: all in `workflow-run-queue.test.ts`, all "database or disk is full" with 1.3 GB free. After space was freed the file passed alone, 99 of 99 |
| Full suite on a frozen copy of `014c96896` (the first to include `src/projects`) | 18,649 tests, 18,643 pass, 0 fail, 6 skipped |
| Release checks on `014c96896` | typecheck, four builds, hygiene checker, release closure 141 of 141, release assets 59 of 59, packed candidate: all pass. On `2540f9284`: measurement 98 of 98, proof self-tests 239 of 239, gate benchmark, fresh install and its end-to-end, packaged upgrade 22 of 22: all pass |
| Full suite on a frozen copy of `724a3d569` (what is installed) | 18,632 tests, 18,625 pass, 0 fail, 7 skipped |
| Journeys, serial | 200 of 201. The one is the ordinary-conversation benchmark, as at v3.18.22 |
| Shared chat engine tests (run by name: `packages/` is in no gate) | 242 of 243. The one is the TopBar pin, which fails at `78ca875ab` without this work |
| Typecheck: runtime, desktop, phone | clean |
| Public hygiene checker | passes |
| Builds: runtime, desktop, phone | pass; build stamp `724a3d569`, not dirty |
| Earlier tips | `98b48f3cf` 18,621 of 18,629 with 1 timing failure that passes alone; `d74884f68` 18,624 of 18,631, 0 fail |

Two read-only reviews were run on the backend before installation. Neither found a way around authentication or
write authority. Both found defects, fixed in `17e2a29a3` and `cb69249c6` and pinned by tests.

## Installed and live

Four installs on 2026-09-29, each guarded by its predecessor, each leaving the native shell unchanged:
`98b48f3cf` 11:47Z, `99152cc60` 12:55Z, `724a3d569` 13:42Z, `4d7c3c6a3` 16:35Z. The app serves `4d7c3c6a3`. The
second and third were corrections to defects the first and second showed in the installed app; the fourth adds
the chips, the workflow account fix and local project links.

On `4d7c3c6a3`: a local project was linked by name to a fixture project; a folder that is not a local project
and a partial name were refused with the roster; the desktop and the phone (a paired headless phone, revoked by
its own id) show the link; Clem named the linked local project and its folder in a new conversation in the
project. The owner's pending approvals were 7 before and after. The workflow account fix: the state that paused
a run was reproduced (one account, registered 3 more times since the install) and the controlled workflow
`handoff-account-fixture` was started; its result was NOT read in this session, so the fix is proven by its test
and not live.

Results, measurements and the acceptance table are in `output/project-agent-foundation-0929/LIVE-RESULTS.md`
(private). In short: the correction reaches the owner of the work and finishes (59 s, done) where the baseline
redid it in the foreground and ended blocked (4 min 53 s); the first briefing costs more with an agent than
without; one agent in two projects keeps their meanings and their learning apart.

Fixture objects left in the live home, to be removed only after the owner has seen this list: agent
`fixture-analyst`; projects Harbor Sales Fixture, Harbor Hiring Fixture, Harbor Sales Cold Fixture; their
conversations and tasks; the facts and episodes kept for those projects; the link from Harbor Sales Cold Fixture
to a local project; one run of the workflow `handoff-account-fixture`; drafts under the worktree's `output/`.

## Limits

- A request keeps the scope it began in, and a memory settled later takes the scope its episode recorded. A
  request that creates a project began outside it, so what that one request learns is kept for everywhere.
- Asked to hand work to an agent, Clem may use a helper inside her reply (`run_worker`, as the agent) instead of
  a durable task. The work is done by the agent; no task card exists for it. A durable task is certain when the
  owner names the background.
- Work moved to the background by the owner's words is given to the assigned agent the router is sure of. A name
  that is not saved is not detected on that path; it is when Clem delegates.
- Entities, resource pointers, notes, tool contracts and tool choices are not scoped. An entity or a resource
  known only from another scope's facts is withheld at recall; the stores themselves hold everything.
- `shareMethods` is recorded on an assignment. Nothing is promoted across projects yet: a method proved in a
  project stays in it.
- Clem outside a project has no way to ask for one agent's or one project's memory by name.
- There is no pause. Stop and resume in place are what there is.
- Clem does not move a conversation to an agent herself. The router chooses an agent only for a delegated task,
  only among those assigned to the project.
- An agent's tool list is still stored and not enforced.
- Who resolved an approval, and which project a resolver surface belongs to, are recognised by name.
- The ordinary-conversation benchmark still fails as at v3.18.22.

## Owed

- Live: an approval raised by a delegated task and declined; a task that fails on its own; an unavailable model;
  images, meeting capture and a workflow run on this build.
- The completion reviewer timed out on 5 of the first 12 reviews after installation and failed open. This
  work does not change the reviewer. At the baseline the same reviews took 62 to 78 s against a 90 s limit.
- The first task in a project costs more with an agent than without. Not investigated.
- A task started by the owner's words names no request, so its cost is attributed by start time.
- `packages/` is in no test gate, and one test there fails on main. Owner decision.
- `src/projects` was in no test gate until `014c96896`; release qualification found it. The three suites before
  that did not include its 17 tests, which were run by name.
- The result of the controlled workflow run on `4d7c3c6a3`, and a project's coding work seen populated.
- The machine's disk was 99 % full during qualification. A full disk fails tests that open databases.
- The chip that says who answers loses its chevron behind the model chip at 1280 px.
- Promotion of a method across projects (`shareMethods`), a pause, and enforcing an agent's tool list.
- Owner, 2026-09-29: "lets tag 3.18.23 when ready", "push when the tag is ready". Then, with the full suite clean on the final tip and the rest of
  the checks still running: "lets commit push and tag please i think we are in a good spot". Main was
  fast-forwarded to `4d7c3c6a3`, these documents were committed on it, and `v3.18.23` was tagged on the release
  commit and pushed.
