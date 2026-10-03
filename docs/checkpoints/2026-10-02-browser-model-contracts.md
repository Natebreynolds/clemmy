# Browser execution and exact model selection — 2026-10-02

## Ownership and acceptance boundary

This framework candidate starts at `79733bdec`, the current
`claude/blank-state-quiet` integration branch, in its own managed worktree at
`$HOME/.codex/worktrees/browser-model-contracts/clementine-next`, branch
`codex/browser-model-contracts`. The other agent retains its worktree and
installation cycle. Primary `main` and unrelated UI/marketing/token-meter work
are untouched. This wave has not hotpatched, changed credentials or live
settings, set up a cloud-browser account, or launched generative benchmarks.

Implementation and deterministic regression pins are being completed here.
They do not establish installed-app/live-home acceptance. The owner requires
that acceptance after one reviewed combined candidate is built and installed
through the coordinated guarded Terminal/signing recipe.

## Live failure that drives the change

Bounded evidence is in the primary checkout's
`output/browser-latency-review-2026-10-02/REVIEW.md` and
`browser-run-metadata.json`. The two matched mobile requests ran on served
source `89e97b606`; exact session/source identities remain in those private
evidence files rather than in this tracked checkpoint.

| Measurement | Initial browser request | Blank-tab answer |
|---|---:|---:|
| Source to terminal | 87.093 s | 49.805 s |
| Brain frames | 7 | 6 |
| Sum recorded brain durations | 55.249 s | 29.649 s |
| Discovery wall | 21.559 s | 9.552 s |
| Actual browser execution | None | None |

Durations overlap; do not add phase columns. Both turns ran Luna on Codex,
settled needing input, and had unavailable completion review. This is neither
browser-backend performance evidence nor a successful reviewed browser task.

Discovery disclosed raw Python execution as unmaterialized, without an
execution reference/example. No browser dispatch was attempted or denied.
The installed mobile picker also discarded exact GPT-6 choices through a
GPT-5-only primary-slot check and confirmed success from the clicked label.
The retained selection timestamp follows both requests, so it does not prove
the ordering of an earlier selection. The source defect remains independently
reproducible.

Recorded ledger usage was 223,891 tokens, including cached input. A separate
clarification interpretation reported another 6,915 tokens outside the exact
accepted-source ledger. Two failed Jev calls had unknown spend. Preserve that
uncertainty; do not present the historical total as a certified complete bill.

## Implemented framework changes

- Exact model choice: both settings carriers use one provider-resolved slot
  update contract, without a generation-prefix gate. Success requires a
  receipt matching requested model, effective model and conversation pin.
  Both composer carriers read the same agent/session/global precedence;
  failed or stale reads cannot substitute the global model label for a
  conversation's model. Existing agent precedence and provider-only selectors
  remain supported. The receipt proves configuration and scope, not that an
  account can execute the model. Pins remain process-local; picker reopen is
  tested within the same daemon, not across a daemon restart.
- Supported browser operations: `browser_open` creates one blank tab;
  `browser_tabs` lists pages; `browser_read` observes bounded visible DOM text;
  `browser_navigate` navigates an exact target to an HTTP(S) URL. Current
  schemas, planning references and invocation examples are disclosed together
  through ordinary discovery. Reads and mutations use the existing reviewed
  host carrier, planning, authority and effect machinery.
- Exact browser identity: the fixed Python program uses the installed Browser
  Harness venv's CDP client directly. It does not run upstream editable helper
  imports, bootstrap/repair a daemon, choose another profile/remote browser,
  execute caller code, or replay a mutation. Browser identity is the hashed
  local Chrome websocket endpoint; reads/navigation also require the exact
  target handle. The connector disables proxies, binds the exact loopback
  host/port and refuses websocket redirects. `session_name` is only a task
  label, not an isolation claim. A trusted pre-mutation refusal reaches the
  kernel as no dispatch; an interrupted or missing mutation outcome stays
  uncertain. Canonical URL bounds are checked before navigation.
- Token accounting: clarification interpretation enters the exact accepted
  task's accounting scope before adapter dispatch. Already-recorded calls are
  not counted twice; missing/failed usage remains unknown, not certified zero.
  This corrects attribution. It does not itself reduce provider spend.
- Honest discovery/status: installation and connection are separate
  observations. Saved browser prose is a proposed playbook, not a verified
  execution receipt or automatically consumed skill. The generic lexical
  ranker now applies action precedence only to an actual opening action in
  its candidate corpus, so new browser metadata does not hide an existing
  screenshot/preview operation. Raw Python remains a separate opaque tool;
  these bounded declarations grant it no additional authority.

Clicks, forms, external sends, uploads, screenshots through the new CDP
adapter, automatic verified-playbook retrieval, and a Browserbase adapter are
outside this bounded wave. Existing tools remain separately governed.

## Coordination findings in the newer agent lane

The other agent's `e1869de38` adds subscription-catalog provenance and model
refusal handling; later `c5ec4f2be` adds its checkpoint. No overlapping source
file has been edited by this wave. Two integration findings need their owner's
attention before treating that combined candidate as qualified:

1. `model-refusal.ts` currently treats any provider 400/404 mentioning the
   requested model as account ineligibility. An unsupported parameter,
   invalid image/input, excessive context, or tool-schema error that names the
   same model would receive the wrong terminal explanation and bypass normal
   recovery. Require explicit model eligibility/refusal evidence, using
   structured provider fields when present. Pin negative examples containing
   the requested model ID, not just parameter errors that omit it.
2. Subscription discovery currently loses whether an empty result was a
   successful empty catalog, a failed fetch, or no subscription. With no
   subscription marks the brain list falls back to the API union. Preserve
   source readiness/uncertainty rather than certify API-only models for an
   OAuth account. Recheck these findings against the latest agent revision;
   they are review findings, not installed-run evidence.

The exact-selection fixture includes literal subscription provenance to stay
compatible with the newer catalog interface. It makes no availability claim.

Use these negative provider fixtures when repairing refusal handling (each
names the requested model but does not prove account ineligibility):

```text
400: Unsupported parameter temperature for model gpt-6.1-sol
400: input exceeds context length for gpt-6.1-sol
400: Invalid tool schema for model gpt-6.1-sol
```

Preserve the actual positive refusal, and preserve the original request and
completed effects when the owner chooses another available model. Do not
silently substitute a model or issue a new external effect on continuation.

## Commits and verification receipt

Runtime series, in order, from base `79733bdec`:

1. `12c18a220` — clarification usage belongs to the accepted task before
   model adapter dispatch.
2. `b47a6d647` — exact catalog selection, shared selection receipts and
   truthful scoped model readback in desktop/mobile.
3. `be75a4c5c` — bounded browser operations, exact transport/effect receipts,
   usable discovery and generic ranking alignment.

| Verification | Result | What it establishes |
|---|---:|---|
| Semantic usage ownership and related pins | 18/18 | Adapter-recorded and fallback usage attach once to the exact source; failed spend is not zero. |
| Selection, receipt, session, agent and UI pins | 60/60 | The real mobile settings carrier preserves a novel catalog ID; scoped readback and bystander affinity agree. |
| Browser adapter, discovery, registry, ranking and taxonomy pins | 129/129 | Typed operations are disclosed with usable planning examples, exact schema identity and honest effects. |
| Independent fixed-Python adapter rerun | 6/6 | Connection drift, helper isolation, local socket binding, Unicode bounds and exact operations in mock CDP. |
| Backend, mobile and console typechecks | Pass | Source/UI compilation checks. |
| Diff and operation-identity checks | Pass | No whitespace errors or new provider-spelling kernel decisions. |

The selection carrier pin fails on untouched base `79733bdec`: a novel
catalog choice leaves Luna as primary. Two new semantic usage ownership pins
also fail before their attribution fix. Browser pins exercise the actual
fixed Python program against a mock CDP peer and the actual production
discovery/host adapter; they do not operate the owner's browser.

Test logs remain local at `/tmp/clem-brain-selection-final.log` and
`/tmp/clem-browser-model-contracts-final-tests.log`. The isolated runner's
live-home sentinel was **NOT PERFORMED** while the live daemon owned and wrote
the home. No sentinel success or installed-app acceptance is claimed.

The console's first typecheck used a stale dependency directory missing its
already-declared `@xyflow/react`. Only this worktree's ignored dependency link
was corrected to the integration lane's installed dependencies; the clean
rerun passed, with no dependency manifest or other owner's directory edited.
Public hygiene found a personal-home path in the older tracked UI handoff;
this wave changes those two references to `$HOME` without changing its mandate.

The backend and both UI bundles must be built after the final checkpoint
commit. The exact build stamp and any subsequent emitted-artifact checks are
recorded under this worktree's ignored
`output/browser-model-contracts-2026-10-02/`. A build here establishes this
branch's source identity, not the other agent's newer combined candidate.

## Integration procedure and acceptance boundary

Apply the three runtime commits, or reviewed equivalent changes, to the
latest integration source. Preserve the other agent's runtime/UI work; never
replace its newer bundles with this branch's partial candidate. Resolve the
two account-model findings above in that owner's lane, then rerun the shared
carrier and browser/transport checks against the combined revision. Account
for the required full-suite/journey results by name on an otherwise idle
machine; this lane did not launch a competing full-suite run.

Build the combined source and both UIs, regenerate emitted artifacts, verify
the stamp, and use the one coordinated Terminal/signing hotpatch recipe.
Read served source/fingerprint after launch by app path. No merging to main,
push, tag, signing, hotpatch or daemon restart happened in this lane.
Deterministic no-replay coverage uses the existing durable workflow mutation
guard; fresh compiled workflow crash/reopen and live acceptance remain owed.

## Required qualification after integration

1. Select an available exact Sol catalog entry on the physical phone. Confirm
   the server selection receipt, conversation pin and next real wire/usage
   model agree. Reopen the conversation. A bystander conversation retains its
   own pin; an explicit agent override is shown truthfully.
   Availability must come from the same account/wire being exercised. Repeat
   with a rejected choice: no success toast or claimed model execution.
2. Repeat the original two browser requests in a named controlled conversation
   on the installed app/live home. Verify an actual blank-tab action and exact
   browser-session/target receipt; no repeated availability or discovery loop.
3. Read and navigate only the controlled tab. Preserve a neighboring user tab.
   Verify typed failure on a missing target and no automatic mutation replay
   onto another target after connection loss or timeout.
4. Test chat and the supported workflow carrier with the same exact capability,
   preserving planning, approval, effect and terminal receipts. No broad raw
   Python authority is granted by a bounded operation declaration.
   Include a persisted workflow interruption/reopen after a mutation with an
   ambiguous receipt; a completed/uncertain browser mutation is not replayed
   automatically. Test review enabled and disabled with Jev configured, and
   report unavailable judge evidence honestly.
5. Reconcile all model calls, including preparation and failed/unknown-cost
   calls, to the accepted task. Compare total wall, first actual action, calls,
   input/cache/output tokens and accuracy against the baseline. No speed or
   token improvement is claimed before these matched live measurements.

Browserbase remains an optional future adapter evaluation. It cannot repair a
model-selection or unavailable invocation contract by itself. Keep browser
infrastructure separate from any additional model planner; charge each child
model call and preserve explicit local versus cloud session/account choice.
