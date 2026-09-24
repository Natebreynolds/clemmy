# Calendar watch on a heartbeat contract — 2026-09-22

Continues `2026-09-22-next-dependable-state.md`. Twelve commits on shared
`main`, `f8b5ddf8` → `e1011bc8`, accepted in the installed app against the
live home. No release was published.

## What it is

The first watch on the proactivity contract the owner approved: read on a
cadence, detect change deterministically before any model call, raise one
item per meaningful change, let Jev decide only the low-signal cases, retire
items when reality resolves, and measure useful actions rather than
notifications.

- **Read path.** Every tick reads every connected calendar account through
  the same prepared workflow read path a scheduled `call:` step uses
  (live-catalog compile → exact identity → durable activation → kernel), in
  a `workflow`-kind session `watch:calendar`. The raw provider client is
  never dispatched (`calendar-watch.test.ts` pins it). When the catalog holds
  several accounts for the operation, the choice set is walked and each
  account compiles as its own exact selection.
- **Change detection.** A per-account snapshot of the next 24 hours is
  diffed against the previous tick. Classes: `cancelled`, `removed`,
  `conflict` (a NEW firm overlap), `invite_unanswered` (high signal, always
  surface); `moved` ≥ 15 min (low signal, Jev may veto). `starting_soon` is
  implemented but off: a meeting starting is a clock event, not a calendar
  change. A first tick (no snapshot) surfaces only what is actionable on its
  own: existing double-bookings and unanswered invites.
- **One item per change.** Keyed by (account, event, kind[, version]) and by
  an account-independent event key, persisted with the item. The same
  mailbox connected twice (two Outlook connections here return the same nine
  events) yields one item; two open items for one event collapse to the
  earliest and the other retires as `duplicate_account`.
- **Jev.** `tryJevWatchChangeVerdict` (`jev-watch` channel, 1.5 s, veto only
  at confidence ≥ 0.6) is asked only for low-signal changes, at most five per
  tick; unavailable, slow or unsure → the deterministic rule stands. A
  quiet tick makes no model call at all.
- **Retirement.** Invite answered, overlap gone, event passed or started →
  the item retires and its notification is marked read, so Needs you
  follows the calendar without a tap. Acknowledgements (the owner read the
  card) are counted before the watch marks anything read itself.
- **Surfaces.** Items are `needsAttention` notifications marked `inboxOnly`:
  visible on the desktop and mobile Needs-you feeds, never queued for
  external delivery (a `silent` record is hidden from those feeds too, which
  is why the old monitor's cards never showed anywhere). Autonomy → Watches
  shows purpose, cadence, last check, last finding, counters, open items, a
  switch and "Check now"; `GET/PATCH /api/console/watches[/calendar]`,
  `POST /api/console/watches/calendar/tick`.
- **Switch.** `calendarWatchEnabled` (own switch, independent of the global
  "Proactive work" switch because the watch only reads and raises items);
  cadence `calendarWatchMinutes` (30 here); quiet hours respected; a tick
  whose reads all failed retries in 5 minutes. Future Commitments shows the
  calendar watch as an active state watch; the inbox watch stays paused.

## What had to be fixed underneath (all live-found, all pinned)

1. **Operation spelling.** The durable manifest spells the operation
   `OUTLOOK_GET_CALENDAR_VIEW`; catalog identity, acquisition registry and
   compiler match that exact string. The watch now carries the manifest's
   spelling verbatim (`d183ede0`).
2. **Cold-daemon observation.** A Composio manifest becomes a live
   candidate only after this process holds the live schema fingerprint AND
   the attested transport has observed the operation for its account. The
   watch warms the schema (`80629a53`) and asks for the same independent
   observation per account the chat materializer asks for (`d009db12`).
3. **Multi-account transport.** `resolveConnectedAccount` in the attested
   transport required a toolkit to have exactly ONE connection before it
   would observe any account; with three Outlook connections every account
   was `observation_unavailable`. It now confirms the account the caller
   named among the toolkit's connections, refusing exactly as before when
   it is not one (`8a8058fe`, `transport-account-resolution.test.ts`). This
   also unblocks any scheduled Composio call step on a multi-account
   provider.
4. **Duplicate mailbox connections** → event-key dedupe (`2744fdbb`).
5. **Invisible items.** `silent: true` hid the old monitor's cards from
   desktop, mobile and delivery alike; items are now visible in-app and
   `inboxOnly` (`8c31fae6`).
6. **Notification id reuse.** An id derived from the item key alone reused a
   read/silent row from an earlier life of the same change; each occurrence
   now has its own row (`080d9157`).
7. **Wall-clock times.** Graph returns start/end as wall-clock in the
   requested zone; treating them as UTC put every item seven hours early
   ("Tue 2:00 AM" for a 9:00 AM meeting). Converted through Intl with a
   DST second pass; unknown labels mean the zone the read asked for
   (`e1011bc8`).

## Before / after (installed app, live home, 2026-09-22 07:00–08:00Z)

| Measure | Before (ambient calendar monitor) | After (calendar watch, `e1011bc8`) |
|---|---|---|
| Ticks since 2026-08-13 | 0 (never scheduled: raw provider client, no read authority) | 3 in the measurement window: 1 changed, 2 quiet; heartbeat armed every 30 min |
| Read authority | none | prepared workflow read path, 2 accounts per tick, 0 read failures in the window |
| Items on the same 18-event window | would emit 6 cards per scan (3 invites × 2 connections; replayed with the old scorer), all `silent` = visible nowhere, never retired | 3 items (one per event), visible on Home Needs you and mobile, retire on their own |
| Model calls | none (and no change detection: every scan re-scored everything) | 0 on quiet ticks, 0 in the window (no low-signal change occurred); Jev is the only model the watch can call |
| Duplicates across a restart | not applicable | 0: restart → tick C quiet, 3 items still open, none re-notified |
| Wall time per tick | — | 2.6–4.4 s (two attested reads) |
| Truth on screen | "configured but not executing" warning only | Autonomy → Watches card with last finding and counters; `Check now` runs a tick |

Evidence: `output/calendar-watch/autonomy-watches.png`,
`output/calendar-watch/home-calendar-card.png` ("Tue 9:00 AM (in 8h) · 18
attendees · from …"), `output/calendar-watch/home-needs-you.png`, tick
results in the session scratchpad. The three live items are the owner's
real unanswered invites for the day.

## Installed identity

`~/Applications/Clementine.app` sealed 3.18.19, daemon dist hotpatched to
`e1011bc8` (schema 81), console-web dist rebuilt at `f8b5ddf8` (UI unchanged
after), mobile-web dist unchanged. Updater `pending` folder still held
(`pending.held-20260921-215159`). Prior layers retained inside the bundle as
`dist.backup-*` / `apps/*/dist.backup-*`.

## Not done, stated plainly

- Jev has not yet been exercised on a live low-signal change (no meeting
  moved during the window); the veto path is unit-pinned only.
- `starting_soon` is off by default; the owner can ask for it.
- The mobile Needs-you feed carries the items by the same predicate as the
  desktop feed, but the phone UI was not driven (PIN session).
- Google Calendar parsing is implemented and pinned but not live-tested (no
  Google account connected).
- Three dev-window notifications from earlier builds were dismissed (read)
  in the store; the watch state was reset once before the measurement
  window. The old `calendar-monitor.json` file is untouched.
- `goal-resume.ts` still lists the retired `calendar-monitor` source label.
