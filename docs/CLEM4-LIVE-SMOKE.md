# Clem 4 live smoke — the ten-minute gate

Branch: `codex/monday-chat-settlement` · validates the chat-spine conversion
(`7068265d` + `70174bfc`) on real surfaces before interior extraction, U2–U6,
or the tag build on top of it.

This runbook exists so the smoke is ten minutes of looking, not thirty of
figuring out what to look at. Everything below was prepared offline; the one
thing it cannot contain is the result.

## What this smoke proves (and what it does not)

Proves: production chat turns on real surfaces are driven by their compiled
graph — fresh turns and approval resumes — with no user-visible change: same
answers, same latency class, no legacy-order fallbacks, exactly one terminal.

Does not prove: the full release matrix (per-brain demo replay, measured
latency/token ceilings, cross-surface byte-parity audits). Those are the
charter's M-gates and come after this smoke, before the tag.

## Setup (2 min)

Run the branch build as the daemon via your usual signed-candidate flow.
Constraints that matter:

- The packaged app owns the daemon — do not run a second daemon against the
  live home alongside the installed app. Replace, don't race.
- No env flags to set: the spine is default-on with no rollout gate. The only
  fallback is per-turn, automatic, and LOUD (the log line below).
- Rollback = relaunch the installed release build. The branch changes no
  storage schema; a rollback is a binary swap.

Tail the daemon log in a terminal you can see during the smoke:

```bash
# The ONE red-flag string. Zero hits = the graph drove every turn.
tail -f <daemon log> | grep --line-buffered "fell back to legacy order"
```

## The four turns (6 min)

Do these on desktop, then repeat turn 1 on Discord.

| # | Say | Green looks like | Red looks like |
|---|---|---|---|
| 1 | anything conversational ("morning — what's on today?") | normal answer, normal speed, no grep hit | grep hit (turn still ANSWERS on fallback — red here means "graph didn't drive", not breakage) |
| 2 | a retrieval ask grounded in your data ("what's the current status of the Acme account?") | grounded answer, one terminal bubble, no grep hit | double/missing terminal bubble; grep hit |
| 3 | a fan-out-shaped ask ("research these 3 firms: A, B, C — quick take each") | one coherent reply (interior fan-out is NOT yet active — this validates the planner-contract path compiles + the spine drives it; parallel workers come with interior extraction) | error/blank turn; grep hit |
| 4 | anything that requests an approval, then approve it | the resume completes normally after approval; no grep hit | resume hangs or double-publishes; grep hit |

Turn 4 matters most: the approval-resume spine was converted last (`70174bfc`)
and has the least soak.

## Verdict (2 min)

- **All green:** reply here with "smoke green" (+ surfaces used). That
  unblocks: interior extraction (context/capability nodes), U2–U6, and the
  M-gate sequence toward the tag.
- **Any red:** paste the grep line(s) and which turn. A `legacy order`
  fallback includes the compile error inline — that string is the diagnosis.
  The turn still answered (fallback preserves exact legacy behavior), so a
  red smoke is information, not an incident.
- **Rollback anytime:** relaunch the installed build. Nothing durable changed.

## What the branch already proved offline

30+ commits, 8,887 tests / 0 fail: five lanes converted to executor dispatch
with loop cores deleted; both effect ledgers unified with the graph contract
by per-state agreement proofs; fallover audited brain-blind at the tool
boundary; admission/procedure/projection/effect/fallover contracts landed and
pinned; graph-layer architecture made directory law. The conversion map with
evidence per row: `docs/CLEMENTINE-4-EXECUTION-PLAN.md` §3b.
