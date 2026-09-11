# HANDOFF — Plan mode works on grok; account-hint provenance is next

Continuation of the assignment in `docs/checkpoints/2026-09-11-plan-mode-handoff.md`.
Read that file for the product framework (Ground → Inventory → Publish, no vendor
allowlists). This file is the current state, what is proven, and what to do next.

**Do not tag. Do not push a release.** `main` is pushed; no tag was cut.

---

## 0. State as of handoff

| | |
|---|---|
| branch | `main`, pushed, at `becb1319` |
| last tag | `v3.18.5` = `00943a2c` (one commit behind HEAD) |
| `package.json` | `3.18.5` — **a future tag must be ≥ 3.18.6**, and both root and `apps/desktop` must match it exactly or the release gate fails |
| installed app | `3.18.5` + hot-patched daemon/console-web/asar |
| uncommitted | `host-turn-runner.ts`, `host-no-progress-projection.test.ts` — the owner-facing copy fix (§2.1). 302/302. Commit this first. |

`hot-patch.sh` is **gitignored** and gained four fixes today that exist only on
this machine (§5). Consider un-gitignoring it; it is release infrastructure.

---

## 1. What is PROVEN live, and what is not

Session ids are in `~/.clementine-next/state/harness.db`. Do not write that store.

### Proven on a live grok-4.6 Plan turn

| fix | evidence |
|---|---|
| Classify the inner call, not the carrier | `refused_pre_dispatch` went 3-strikes-then-dead → **0**, two consecutive runs |
| Recovery names the inner tool | copy changed from *"Use call_tool to resolve this step"* |
| Plan recovery says publish | **`publish_plan → ok: true`**, `plan-8b51ee8e…` rev 1, session `sess-desktop-5af099f8e9392b3e6717dbbe` |
| Shape-approve → bind | **rev 2** published, same session, converged in 3 attempts |
| Plan card no longer duplicated | rendered once with Execute/Approve visible |
| Blocked terminals record their gate | `host_blocked_terminal_site` named `host-turn-runner.js:2767` and `:6453` — turned an afternoon into minutes, twice |
| Updater self-repairs ownership | owner installed 3.18.5 after four releases stuck |

### Built but NOT proven live

- **Grounding gate** (`ownerNamedInputsStillUnread`) — fixes a regression this
  session caused (§4.1). Blocked from a fair test by §2.2.
- **"composing a reply" vs "no change for 2 min"** — built, never seen.
- **Approval message in the owner's voice** — built, never seen.
- **Named-server scope fix** (`constraint.allow` into `allowedServerSlugs`) —
  unit only. Correct for genuine MCP servers, but it was **not** what hid Apify:
  Apify is a Composio toolkit reached through `tool_search`, not an MCP server.
  The brief's "Apify hidden before the first model step" is true of the MCP
  surface only. Do not carry that claim forward unqualified.

---

## 2. Work queue

### 2.1 Commit the owner-facing copy fix — FIRST, it is done

Uncommitted in the tree. `hostNoProgressBlockedText`'s Plan branch was writing
the MODEL's instruction into the OWNER's card: *"Publish the plan with what you
already gathered, naming anything still missing as needs_input"* — telling a
person to call a tool they never call. Now first-person and owner-actionable.
Pinned: the owner line must not contain `publish_plan` or `needs_input`.

302/302 on `host-no-progress-projection.test.ts` + `host-turn-runner.test.ts`.

### 2.2 Account-hint provenance — THE NEXT REAL PIECE

**A model-supplied identity hint is given the authority of an owner-supplied
one.** Third instance in one day, two different features:

| when | guessed | quoted as evidence | outcome |
|---|---|---|---|
| calendar write | the work account | a message naming no account | `not_entailed` → 45.6 s spent asking which calendar |
| Plan doc read | `<an email>` | the pasted document URL | *"the account this action expects is no longer connected"* → `candidates=0`, document never read |

The entailment check is CORRECT and must not be loosened — a quote that does not
name an account must not bind one. The defect is the **consequence**: a hint the
model invented this turn, matching no connected identity, is converted into
"the account this action expects is gone." It is not what the action expects; it
is what the model guessed. A guess that matches nothing should be **discarded**,
falling back to ordinary resolution (one connected account resolves; several
ask), not promoted into a false claim about the owner's connections.

Provenance is the distinction. These are requirements:
durable alias, the owner's own words, a reply to an offered choice, Tool Memory.
This is a guess: `account_selection.identity` supplied by the model in-turn.

- `src/tools/composio-tools.ts` ~2027 `identity-absent` — the wrong consequence.
  ~1955 composes the false "no longer connected" lead.
- `src/tools/tool-search-provider-sources.ts` ~950 — `identityHint` is built from
  five sources of good provenance; the model's in-turn assertion is not one of
  them and must not be treated as one.
- `src/memory/account-alias-store.ts` — where real provenance lives.

Proof required: a unit pin that a non-matching model-supplied hint resolves a
single connected account instead of reporting it absent; and a live Plan turn
that reads the owner's pasted Doc.

### 2.3 Re-test the grounding gate once 2.2 is fixed

It cannot be exercised while the read it should force is blocked upstream.
Expect: Doc read BEFORE publishing, real themes in the plan rather than
"Plaintext of source Google Doc" in `missing_prerequisites`.

### 2.4 Execute — the last untested surface

Everything proven so far is read-only. Execute exercises the write path,
approval gates, and this session's consent rework. A bound rev-2 plan already
exists in `sess-desktop-5af099f8e9392b3e6717dbbe`.

### 2.5 Deferred, with reasons

- **P1b — a governor stage per inner operation** (asked for by the earlier
  brief). Implemented, then reverted: it breaks the anti-thrash guard pinned by
  *"host disposition result outranks varied call names"*, whose fixture tool is
  literally `different_name_every_time`. Key a stage on model-supplied names and
  a model that varies them never repeats and never terminalizes. If still
  wanted, key on the host-authored `repairKey`. Once inner-call classification
  is correct the collision mostly disappears anyway.
- **P3 — production reads regardless of carrier.** `planFirstWorkRefusal` still
  only fires for `composioCarrier`; native MCP/CLI production reads skip the
  3-read allowance. Untouched, and verified NOT widened by this session's work.
- **Per-turn prompt-cache reset.** Real and measured (tool schemas grew
  9,530 → 10,539 tokens mid-conversation; one turn's opener paid 44,045 uncached
  tokens 55 s after a live 36 K prefix). **Deprioritised**: on grok the model
  floor is 13–19 s per call and 86 s of a 165 s turn, so cache work buys
  single-digit seconds against that. Worth doing when the brain is faster.
- **Effect taxonomy calling an unknown CREATE "read_only".** NOT A BUG — that
  was a test artifact of feeding a bare operation name, which never reaches the
  classifier. Realistic shapes classify correctly and unknowns fail closed.

---

## 3. grok is not the problem, and the harness must not assume it is

The earlier brief suggested running Plan on a different brain. That is the wrong
instinct and the owner rejected it. grok wraps its calls, sometimes twice, which
is legal; every defect above was the harness punishing that. **grok exposed
these bugs because it wraps — the Claude lane wraps less, so the same defects sat
hidden.** A harness that only works for one model's calling style is not done.

What IS model-bound and has no harness lever: grok runs **13–19 s per call**, and
**173 s / 203 s** on the ~3,000-token turns that write a plan. Measured, only
because BYO calls started recording `durationMs` this session — before that, 139
calls in a day recorded none. Slow is not a defect; expect 2–4 minute Plan turns
and do not diagnose them as stalls.

---

## 4. Traps — including three this session created or fell into

### 4.1 A nudge fires the moment recovery-only engages

The publish nudge was added, and on its first live run it fired after ONE
unproductive repair — before the linked Doc was read. The turn published in 15
calls with the source document listed as a missing prerequisite, where the
previous run had spent 50 calls, read it, and published something real.
Recovery-only mode is reached early and often; anything written there must be
safe to hear on attempt two. Hence the grounding gate.

### 4.2 Never edit source while a suite runs

A full 15,875-test run was started and source was edited mid-flight. Five
failures belonged to a reverted state, and the repo's own build guard caught it:
`source changed during candidate build … rebuild the stable tree`. The run
proved nothing. Slice the suite instead — this machine kills a full run for
memory (2.5 GB free against 3.35 GB of 4 GB swap).

### 4.3 Absence of evidence is not evidence

Two wrong conclusions this session, both from reading silence as fact:
- *"`publish_plan` is missing from the Plan surface"* — it is built as a
  structural tool under `planMode` and was first-class the whole time. Schemas
  are not logged by name, so its absence from the eventlog meant nothing.
- *"Google Docs is disconnected"* — inferred from `composio-account-identities.json`
  (a **Sep 5** cache) and a suppression entry that is a stale July `pg-test-`
  connection. The owner said it showed connected in the UI, and he was right.
  The real cause was §2.2.

Check the live path, not a cache. State a mechanism only when you have watched it.

### 4.4 Environment blocked correct code four different ways today

None of these were the release; the build was valid the whole time.
1. bundle root-owned by `sudo cp` → updater could not write
2. the ownership repair reachable only from a tray menu whose label had changed
3. macOS **App Management** blocks bundle writes from VS Code's shell — use a
   plain Terminal, or grant it
4. `~/.npm` had 334 root-owned files from a previous `sudo npx` → `hot-patch.sh`
   now uses a throwaway cache and needs no `sudo` at all

`/Applications` is `drwxrwxr-x root:admin` and the owner is in `admin`. The
`sudo` was never needed for any of it, and every blockage traced to using it.

---

## 5. hot-patch.sh (gitignored, local only)

Four fixes today. All still only on this machine:
- no `sudo` anywhere (it caused every ownership problem above)
- stamps the real `package.json` version, not a hardcoded `0.4.0` that told the
  updater the app was four years behind
- private npm cache, so a poisoned `~/.npm` cannot break it
- **copies `apps/console-web/dist`**, which it never did — so every chat-surface
  fix was built, "patched", reported as landed, and never reached the window

Patch with: `cd ~/clementine-next && ./hot-patch.sh` from a real Terminal, then
`open -a Clementine`. Verify the daemon restarted AFTER the patch timestamps.

---

## 6. Proof bar

`node scripts/run-tests-isolated.mjs <files>` on every file touched, plus its
consumers. Full-suite runs die for memory here — slice with
`find src apps -name '*.test.ts' | split -l 150`.

Known pre-existing failures, each verified by stashing rather than assumed:
- ~30 in `src/journeys/*` (identical 5 pass / 18 fail with and without changes)
- 1 `fresh-source-session-independence.red.test.ts` — a `.ts` Worker spawned
  with `--import tsx` gets no loader; packaged installs load built `.js`
- a handful of 3 s / 20 s / 40 s timeouts under load that pass in isolation

Run `npm run check:public-hygiene` BEFORE any commit that adds a fixture — it
scans TRACKED files, so a fixture passes every local check until the moment it is
committed. It caught a real person's name and address in test data today.

---

## 7. One-sentence success

A Plan turn on grok reads the document the owner pasted, inventories the toolkits
that are actually connected, publishes a reviewable outline with exact operation
identities and honest gaps, binds it on approval, and Executes — without the
harness refusing its reads, hiding its tools, guessing its accounts, or telling
the owner to call a tool they do not have.
