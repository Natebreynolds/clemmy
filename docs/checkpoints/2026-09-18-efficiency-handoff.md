# 2026-09-18 — Efficiency handoff: measure live, fix the framework

Audience: the next implementing agent. Read §1 and §2 before touching anything.
Base: `main` at `e2c4f998`, 8 commits ahead of `v3.18.17`, unpushed, untagged.

---

## 1. THE END GOAL

**Clementine is a multi-model personal assistant that beats frontier agent
harnesses on token usage and speed, and gets better the longer one person uses
it.** Persistent memory, minimal turns, non-aggressive tokens. It should feel
better to use than anything else on the market because it *remembers* and
therefore does more with less — not because it tries harder each time.

The owner built a live token meter that makes this measurable against the
competition. Current standing on comparable work:

| | uncached tokens | calls | cache hit | output |
|---|---|---|---|---|
| **Clementine** | **620,700** | 21 | **6%** | 2,550 |
| **Claude Code** | **4,140** | 5 | **100%** | 3,490 |

**That is the scoreboard. Every change must be measured against it.**
Roughly 150× the uncached tokens for comparable work is the gap to close.

---

## 2. HOW TO TEST — THIS IS BINDING

**Do not evaluate work by running unit suites. Hotpatch the owner's real signed
app and make a live call.** Every wrong conclusion in this session came from
trusting a green test, an isolated-home probe, or an inference; every correct
one came from a live run against the real daemon.

### The loop

```bash
cd ~/clementine-next
npm run build
osascript -e 'tell application "Clementine" to quit'
# wait for the process to exit
node --import tsx scripts/hotpatch-daemon.mjs
open -a "/Users/<user>/Applications/Clementine.app"
# wait for: pgrep -f "index.js service"
```

Confirm the daemon is running YOUR build before believing any result:

```bash
grep -a "Clementine daemon build" ~/.clementine-next/logs/desktop/supervisor.log | tail -1
# check gitSha matches HEAD and gitDirty is false
```

### Driving live work

Local doors, authorised by `WEBHOOK_SECRET` from `~/.clementine-next/.env`:

```bash
SECRET=$(grep -oE "^WEBHOOK_SECRET=.*" ~/.clementine-next/.env | cut -d= -f2-)

# a chat turn (ALWAYS pass session_id — the default session can carry stuck state)
curl -s -X POST "http://127.0.0.1:8520/api/message?token=$SECRET" \
  -H "Content-Type: application/json" -H "Idempotency-Key: probe-$(date +%s)" \
  -d '{"text":"...","session_id":"probe-'$(date +%s)'"}'

# a workflow
curl -s -X POST "http://127.0.0.1:8520/dashboard/actions/run-workflow?token=$SECRET" \
  -H "Content-Type: application/json" -d '{"name":"daily-standup-email"}'
```

### Reading the result

```bash
# per-TURN cost (added this session; do not use the session-scoped one for chat)
grep -a "host turn efficiency" ~/.clementine-next/logs/desktop/supervisor.log | tail -1

# codex prefix shape, first 5 frames of a session
grep -a "codex request prefix shape" ~/.clementine-next/logs/desktop/supervisor.log | tail -5

# workflow runs
ls -dt ~/.clementine-next/vault/00-System/workflows/<name>/runs/*/ | head -1
```

### Why not the unit suite

The suite is ~1,513 files and has four known cross-process load flakes
(`store`, `session-transcript`, `accepted-model-batch-checkpoint-process`,
`exact-judge-pin-honoured`) that fail under parallel load and pass alone. Chasing
them wastes hours and proves nothing about live behaviour. Run **targeted** tests
for the file you changed, plus these two gates before any commit:

```bash
npm run check:operation-identity    # no new spelling-based tool identity
node scripts/run-tests-isolated.mjs src/no-hardcoded-provider-pins.test.ts
```

The second was broken **three times in one session** by writing a provider slug
into an explanatory comment. It scans source text. Never write an operation name
out in a comment — describe it instead.

---

## 3. THE PRIORITY LIST

Measured per turn, live, for *"what is on my Outlook calendar today?"*:

```
10 frames · 296,234 input ·  15,872 cached · 5.4%
 9 frames · 292,606 input ·  13,312 cached · 4.5%
16 frames · 557,088 input ·  46,592 cached · 8.4%
 8 frames · 313,363 input ·   6,656 cached · 2.1%
```

~300k input tokens and 8-16 model frames to list six calendar events.
`300k ≈ frames × per-frame prompt`. Cache is a discount on that product; it is
not the product. **Attack in this order.**

### P1 — Frame count (8-16, should be 2-3)
The largest multiplier: every frame re-ships the whole prompt. Find what drives
frames 4-16 on a single-call question. Suspect the model re-deciding something it
already established. Measure with `host turn efficiency` `frames`.

### P2 — Per-frame prompt size (30-50k)
From `prompt_composition` buckets on a live turn: `toolSchemas` ~10k (stable),
`memoryContext` ~12k (variable), `history` growing, `instructions` ~1.4k stable.
Ask why ~10k of tool schemas rides every frame when schema-on-demand exists to
prevent exactly that. **Note:** the bucket array in that event is sorted by size
descending — it is a REPORT order, not the wire order. Do not read it as ordering.

### P3 — Cache hit rate (5-8%, ~37% achievable on codex, 44-59% on anthropic)
Anthropic places explicit `cache_control` breakpoints and does well. Codex has
only OpenAI's implicit longest-identical-prefix. Two fixes landed this session
(`ec5ede4f`): every call now carries a `prompt_cache_key`, sharded by
`(session, shape digest of instructions + tools)`. Live effect was small
(0 → 5,632 cached on a repeated turn), so **this is not finished**. Next: verify
whether the same shape is actually called consecutively, and whether the ~33KB
tool block changes mid-turn when a capability is JIT-provisioned.

### P4 — `daily-standup-email` still does not complete
Root cause fixed (§4) but it now stops later, at `typed_catalog_not_ready:
observation_unavailable`. That may be an artifact of a hotpatched daemon rather
than a product defect — the observation read path requires
`shippedObserverImplementationId()` to resolve. **Verify on a normally-installed
build before treating it as real.**

### P5 — `friday-sales-leadership-email` still does not complete
Executes real SOQL with `exitCode: 0`, then stops on the exact-checkpoint
re-entry budget (`recovery_pending`, `resumable: true`). **Do not raise that
budget** — it is an infinite-loop guard with a daemon-killing incident behind it
and it resets on genuine progress. UNMEASURED: whether a looping drain resumes
the step to completion. The probe at
`scripts/probe-friday-leadership-creation-test.mts` drains ONCE; the daemon loops.
Fix the probe before concluding anything.

### P6 — Opus 5 invisible to some users
`claude-opus-5` is in neither `CLAUDE_MODEL_PRESETS` (`config.ts`) nor the wire
registry, so it only appears when live SDK discovery succeeds. On a machine where
that discovery fails the user sees five presets and no Opus 5. Needs the owner's
confirmed context window before adding a wire row.

---

## 4. WHAT LANDED THIS SESSION (8 commits, all live-proven)

- `ae6dee7a` `4f453c94` `3c63f2e2` `d757ccc8` — **the standup's three-day block,
  fixed at root.** Composio moved Outlook to `20260917_00` while the manifest held
  `20260903_00`. Revalidation proved the move label-only and sanctioned it via
  `reboundFrom`; `publishRevalidatedObservation` refused the same move because it
  did not know `reboundFrom` existed. One comparison sanctioned it, the next
  rejected it, and no retry could break that. Receipt: the stored identity in
  `state/capability-live-identity.json` advanced `20260910_00 → 20260917_00` with
  a fresh `observedAt` — the first published observation since 09-10.
- `b52194eb` `e2c4f998` — **chat turns are now measurable.** Workflow steps have
  logged frames/tokens/cache for months; chat logged nothing. Per-TURN scoping was
  added because the session-scoped helper made a second identical turn look
  unchanged.
- `ec5ede4f` — codex cache routing (see P3).
- `996e997c` — ratchet repair.

**A theme worth inheriting:** four separate places knew exactly why something
failed and threw the reason away. Every one of them was fixed by making the code
say what it already knew, and every diagnosis after that became data instead of
guesswork. When something fails opaquely here, suspect a discarded reason first.

---

## 5. TRAPS

- **Hotpatch breaks the app bundle's code signature.** That is normal and has
  always worked. `codesign --force --deep --sign -` does NOT fix a broken
  Electron bundle — it makes `verify` pass while helper processes still fail.
  If the app launches with no daemon and no logs, look for a **keychain prompt**
  on screen; that was the real cause, and only the owner can clear it.
- **Two Composio identities exist on this machine.** The `composio` CLI is
  authenticated to a different workspace than the daemon's `COMPOSIO_API_KEY`.
  `composio connections list` showed Outlook `EXPIRED` while the daemon's own
  client showed three `ACTIVE`. **Always ask the daemon's client**, never the CLI,
  when reasoning about what Clem can see.
- **`/api/message` defaults to session `webhook:default`,** which can hold a stuck
  continuation that blocks tool-using turns with a message blaming the capability
  catalog. Always pass an explicit `session_id`.
- **`prompt_composition.buckets` is sorted by size, not prompt order.**
- The isolated-home probe drains the workflow queue once; the daemon loops.

---

## 6. STATE

- `main` at `e2c4f998`, **8 commits ahead of origin, unpushed**, nothing tagged
  since `v3.18.17` (which is published and healthy).
- The owner's app currently runs a **hotpatched** daemon. A stock rebuild is
  `dist.backup-*` inside the app bundle, or just reinstall from the published
  release.
- Two workflows heal but do not finish (P4, P5). `platform-49-slack-channel-review`
  completes and satisfies its goal, at 1.2M input tokens / 29 frames — itself a P1
  candidate.
