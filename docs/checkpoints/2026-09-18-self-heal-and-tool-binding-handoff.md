# 2026-09-18 — Self-heal wave, release-publish repair, and the tool-binding brief

Status: **v3.18.10 → v3.18.16 tagged and pushed**. Audience: the next implementing agent.
Read §5 first if you are picking up the next wave.

---

## 1. What shipped, tag by tag

| Tag | Commit | What it fixes |
|---|---|---|
| v3.18.10 | 017af555 | Space preview + image path, W1 carry, canonical-scalar argument repair, committed-write evidence ends recovery, Plan card reply match, refresh row counts |
| v3.18.11 | ffe2b80c | Space wiring step saves (keyed on the SAVED view), sibling requirement id resolves to the named operation, empty CLI sources, stale journey expectations |
| v3.18.12 | — | Cancelled mid-publish; draft deleted. Its content rode into 3.18.13 |
| v3.18.13 | ae34f820 | Release publish uploads every missing asset at once, each with its own retry and size check |
| v3.18.14 | 6d482bac | A CLI can diagnose and repair itself; $PATH scans stop retiring host-provisioned reads; own tools rank first in discovery |
| v3.18.15 | 07bf0121 | A failed declared read has nothing to reconcile |
| v3.18.16 | 2ffea101 | A prohibition is not a request; a named operation is already the decision |

Every tag equals its `origin/main` commit and carries `[mac-only]`. Windows is still skipped by design (§4).

---

## 2. The three defects worth remembering

**A read that fails is not an uncertain write.** A workflow step ran a declared Salesforce read, the CLI exited nonzero on a filter Salesforce rejects (`FieldDefinition … IN (…)` → `INVALID_OPERATION`), and the step ended "the tool stopped after execution may have begun … its effect must be reconciled". The creation test then disabled the whole workflow, and the owner's repair turn could not clear it, because the block was a harness decision rather than workflow content. The old exemption demanded a non-business call with zero physical crossings — which a bound provider read can never be, since every bound operation is a business call and a read that ran has crossed out. The operation's current manifest now decides (`currentManifestOperationContract(...).effect === 'read'`). Pinned in `recovery-not-a-dead-end.test.ts`.

**A $PATH scan was retiring the machine's own reviewed reads.** Reviewed CLI reads are indexed under carrier `reviewed-cli-config`, which is a descriptor registry, not a program, so `indexDiscoveredClis` reconciled them against $PATH and set `active = 0` on every scan. Both Salesforce reviewed reads were inactive on the owner's machine: discovery could never return them, and the model reported it could not inspect or repair the CLI at all. A scan now retires only carriers it owns (a row whose identifier is the command), and the reconciler restores a retired reviewed read. Pinned in `cli-inventory.test.ts`.

**A prohibition read as a request.** `bindDiscussedToolkitsIntoSteps` locked a step to the Composio family because the toolkit name appeared in "use only the authenticated local sf CLI / salesforce_sf_soql_query; **never use Composio Salesforce**". Workflow validation then failed the step for holding that access. The binder now skips a prompt that names an exact operation, and skips a toolkit named inside a prohibition. Pinned in `orchestration-tools.test.ts`.

---

## 3. What is new and reusable

- **A catalog CLI may declare several reviewed reads** (`reviewedReads`) and **bounded repairs** (`repairs`): a fixed argv with `{name}` substitutions, reviewed in source, no shell. Values must be single plain arguments; injection shapes are refused before anything spawns.
- **`cli_setup` gained `repairs` and `repair`.** A planning turn may run a declared repair as preparation (`accepted-task-mode.ts`), because it changes only which account a tool uses and crosses no external boundary. Install, auth and undeclared repairs stay refused in Plan.
- **Sibling operations of one tool are not an ambiguity.** Acquisition keeps the operation whose identity, name and description answer more of the request; two it cannot tell apart still fail closed, and ranking only happens when every candidate is described.
- **The user's own tools answer first** in `searchCapabilityOperations`: a row whose identity carries the request's terms comes first, bounded to three, with ordinary relevance behind it.
- **Salesforce is the first catalog data**: `sf org list --json` as its diagnosis read, `sf config set target-org=<org> --global` as its declared repair, keyed to `NoDefaultEnvError` / `No default environment` / `No default org`. The other 17 catalog CLIs take the same shape with no code change.

---

## 4. Release publishing, after a bad afternoon

GitHub's asset-upload endpoint degraded on 09-17: four publish attempts failed (HTTP 422, 400, 502, 400) on the 400–500 MB macOS assets while the same runner downloaded the same 1.8 GB artifact in 1.4 minutes and small uploads from a workstation returned 201. Effective runner upload throughput fell from ~25 MB/s to ~0.4 MB/s.

Ours to fix, and fixed: `gh release upload --clobber` re-sent every asset on each retry, so one flaky file cost 1.8 GB per attempt. The publish step now uploads each missing asset in its own process with its own retry and size check, skips an asset already uploaded intact, and flips the draft only after every asset matches its local size. v3.18.13 through v3.18.16 published first try, in 22 seconds to a few minutes.

**Windows** stays skipped: every release commit carries `[mac-only]`, `WINDOWS_CSC_LINK` / `WINDOWS_CSC_KEY_PASSWORD` are not configured, and CI's Windows smoke has failed on every run since at least 09-14 — the daemon refuses to boot because the shipped implementation artifacts are hashed as raw bytes and a Windows checkout rewrites their line endings. The repo has no `.gitattributes`. That one-line file is the first step whenever Windows becomes a goal.

---

## 5. NEXT WAVE — Plan binds the tools execution will run

The owner's direction, verbatim in substance: *Clem must be able to bind, review and execute any connected tool — CLI, MCP, Composio — and Plan mode should find and bind the tools execution uses, so she never has to go find them again.*

**The evidence that names the gap.** The published plan for `friday-sales-leadership-email` bound the authoring call and nothing else:

```
step create_friday_leadership_email_workflow → capabilityRef cap:local:workflow_create:reversible
step verify_saved_workflow                   → capabilityRef null
```

The operations the workflow's own steps would run — the Salesforce read, the Outlook send — were bound nowhere. They existed only as prose inside a step prompt, so at run time the toolkit binder guessed, guessed wrong, and validation failed the workflow it had just built. Planning binds the call it makes, never the calls the artifact it authors will make.

**Three parts, in order.**

1. **Citations reach the artifact.** A plan step that authors a workflow should carry, for each authored step doing external work, the exact operation that step will run — the same "discover and cite the exact operation" rule the plan already follows for itself, extended one level down. The citation lands in the authored step's `allowedTools` so nothing infers it later. Start here: it is exactly what broke the owner's Friday workflow, and the run is on disk to test against (`friday-sales-leadership-email`, currently `enabled: false`).
2. **Execution inherits, never rediscovers.** A workflow or Execute step whose scope names exact operations should have them materialized at step start through the acquisition registry's exact-identifier path (improved in 3.18.14). No `tool_search` at run time.
3. **One bind-review-execute contract for all three sources.** CLI, MCP and Composio reach execution by different paths today. The uniform shape: an operation is cited, its current manifest is reopened, consent reads that manifest, execution runs it.

Do not start part 1 by loosening `workflowAutoApprovalTools`: an empty `allowedTools` currently means the wildcard, so narrowing it from prose without the citation would silently restrict working steps.

---

## 6. Also owed, smaller

- **Space edit round trips.** `space_edit_view` needs byte-exact `find` strings, so a whitespace near-miss costs a re-read plus a retry; adding a source still means save → edit view → save; wiring an action means hand-editing the view's JavaScript. A one-button edit took 15 tool calls, about 7 of them avoidable.
- **Two bugs from the 3.18.10/3.18.11 wave**, seen live in a My Day edit: a false "the saved file no longer matches the receipt" when one request saves, edits, then saves again; and `Workspace saved authoring fields changed before delivery proof` ending a turn whose save had actually landed.
- **Completion review cannot fit large Space data.** A Space holding 703 calendar events estimated 1.24M tokens against a 712.8K window, so the result delivered unreviewed. Owner decision pending: review a Space's data through its record digest (counts, fields, samples) instead of whole bytes, and/or let a source declare the fields it stores.
- **Plan turn cost.** A step whose operation was already exercised in this same planning turn still fails publication with "discover and cite its exact operation"; and the in-flight condenser budget (32K) evicts skill reference files the turn still needs, so the model re-reads each one.
- **`friday-sales-leadership-email` is disabled.** Its scope is now correct; with 3.18.15 its creation test should pass the Salesforce step. It needs a re-run and, if clean, `workflow_set_enabled`.
- **CI `test.yml` is red for infrastructure**, not for this wave: a unit-test watchdog on `constraint-guard.test.ts`, the Windows daemon boot, an unreadable iOS project, and runner shutdowns.
- **Journeys**: `positive_host_wall_p95_le_50ms` measures 58–77 ms on a loaded laptop at 3.18.9 and now; the causal CPU gate passes. Needs a quiet machine or CI to settle.

---

## 7. Traps worth keeping

- Quitting the desktop app can trigger the Squirrel auto-updater; the hotpatch script then refuses while ShipIt runs. Wait, quit again, re-apply.
- The full isolated suite does **not** include `src/journeys/*`. Run `npm run journeys` separately; the release gate expects it.
- Each harness DB copy is ~4.7 GB. Copy once, query, delete — the scratch volume filled twice during this session.
- The packaged upgrade rehearsal needs a clean commit **and** a rebuild after any `scripts/` change, because the source fingerprint covers scripts.
- `tracked-test-references` fails locally only on the gitignored `scripts/memory-graph-snapshot.json`; it passes in CI.
