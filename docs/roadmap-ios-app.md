# Roadmap — iOS Companion App for Clementine

> **Status:** planned, not started. Architecture decided, ready to scope into sprints.
> **Last updated:** 2026-05-23

## Context

Discord is the current "phone surface" for Clementine — messages route through a bot, approvals fire as interactive buttons, notifications land via webhook. It works but it's awkward: you're operating a personal assistant inside someone else's social app, sharing visual space with team chats and notifications, with no native UI for workflows / memory / settings.

A first-class iOS app is the obvious move. The hard work is already done — Clementine's daemon exposes the full surface as a token-authed REST API (`/api/message`, `/api/approvals/*`, `/api/runs/*`, `/api/console/workflows/*`, plus SSE streams). The iOS app is essentially a SwiftUI client over that API, plus a few new daemon-side pieces for device pairing and push.

**Architectural decisions (locked):**
- **Transport:** Tailscale mesh VPN (no public exposure, encrypted end-to-end, works anywhere)
- **Push:** Direct APNs (no third-party relay)
- **Distribution:** Ad Hoc (no App Store review, install via Apple Configurator)
- **Scope:** Full mobile mirror (chat + approvals + workflows + memory + settings)

This is a ~3–4 week solo effort. The plan is broken into four phases so each is independently shippable; you can stop after Phase 1 (chat works on phone) or push through to Phase 4 (everything mirrored).

## Architecture

```
   iPhone (SwiftUI app)                     Mac (Clementine daemon)
   ┌─────────────────────┐                  ┌──────────────────────┐
   │ Chat / Approvals    │                  │ webhook server :8520 │
   │ Workflows / Memory  │                  │ approval-registry    │
   │ Settings / Devices  │  Tailscale       │ notifications queue  │
   │ Keychain: device    │  WireGuard mesh  │ device-token store   │
   │   token (Face ID    │  ─────────────►  │ apns-sender (.p8)    │
   │   gated)            │  100.x.x.x       │                      │
   └─────────────────────┘                  └──────────────────────┘
            ▲                                          │
            │                                          │
            └──── APNs HTTP/2 ◄─── token (.p8) ───────┘
                  push to device token
```

**Network:** Tailscale mesh — no public exposure, encrypted end-to-end, works from anywhere. Free for personal use, ~5 min setup.

**Auth:** Per-device bearer tokens. Desktop shows a QR code (URL + one-time pairing code); phone scans, exchanges for a permanent token, stores in iOS Keychain behind Face ID. Tokens are revocable from a new desktop "Devices" panel.

**Push:** Direct APNs via a `.p8` auth key on the daemon. Daemon hits `https://api.push.apple.com` with a JWT signed by the key. No third-party push relay.

**Distribution:** Ad Hoc — sign with the existing paid Apple Developer account (team `4AR3Y8XD72`), install via Apple Configurator on registered devices (up to 100). No App Store review. Builds don't expire.

## Phases

### Phase 1 — Skeleton + chat (Week 1)

**Deliverable:** iPhone can chat with the daemon over Tailscale and stream replies.

**New code:**
- `apps/mobile/` — Xcode project, SwiftUI app, deployment target iOS 17+ (bundle ID: `com.clemmy.mobile`)
- `apps/mobile/Clementine/Models/` — `Session`, `Message`, `RunEvent` Swift structs matching the daemon's JSON shapes
- `apps/mobile/Clementine/Net/DaemonClient.swift` — async/await HTTP client wrapping `/api/message`, `/api/runs/:id/events`. Stores base URL + token. Uses `URLSession` + `JSONDecoder`.
- `apps/mobile/Clementine/Net/SSEStream.swift` — Server-Sent Events parser for `/api/runs/:id/events` and `/api/console/workflows/events`.
- `apps/mobile/Clementine/Views/PairingView.swift` — QR camera, scans desktop's pairing payload, calls `/api/devices/pair`, stores token.
- `apps/mobile/Clementine/Views/ChatView.swift` — chat bubbles, send box, streaming text.
- `apps/mobile/Clementine/Security/KeychainStore.swift` — read/write the device token in iOS Keychain, gated by `LAContext` (Face ID / Touch ID).

**New daemon code:**
- `src/runtime/device-tokens.ts` — SQLite-backed registry: `{id, deviceName, platform, tokenHash, pairedAt, lastSeenAt, revoked}`. Tokens are random 32-byte base64; only the SHA-256 hash is stored (matches the pattern in `approval-registry.ts`).
- `src/channels/webhook.ts` (modify) — add four endpoints:
  - `POST /api/devices/pair` — accepts one-time pairing code from the desktop's QR, returns a permanent device token + suggested name
  - `GET /api/devices` — lists paired devices (for the new Devices panel)
  - `POST /api/devices/:id/rename`
  - `DELETE /api/devices/:id` — revokes
  - Token auth middleware accepts either the existing `WEBHOOK_SECRET` (legacy) OR a valid device token
- `src/dashboard/console.ts` (modify) — new **Devices** subsection of Settings: list paired devices + QR pairing button that calls `POST /api/devices/pair/code` to mint a one-time code, encodes `{baseURL, code}` as QR.

**Reuses (don't reinvent):**
- `/api/message` — already exists, already supports streaming via `onChunk` callback (see `src/channels/discord.ts:437` for the working pattern)
- `WEBHOOK_PORT` binds to `0.0.0.0` already (`src/channels/webhook.ts:1361`) — Tailscale's `100.x.x.x` IP is just another interface; no change needed
- `ClementineGateway.handleMessage()` — the same entry point Discord uses; iOS routes through the same plumbing

**Setup steps (one-time, no code):**
1. Install Tailscale on Mac (`brew install --cask tailscale`) + iPhone (App Store).
2. Sign into both with the same Tailscale account.
3. Apple Developer portal: register `com.clemmy.mobile` App ID under team `4AR3Y8XD72`.
4. Create iOS Distribution certificate + Ad Hoc provisioning profile, register your iPhone UDID.

### Phase 2 — Approvals + push notifications (Week 2)

**Deliverable:** Daemon sends APNs push when an approval is pending; phone shows native banner; tap → approve/reject card.

**New code:**
- `apps/mobile/Clementine/Views/ApprovalsView.swift` — list of pending approvals, each as a card with tool name, args, Approve / Reject buttons. Backed by `GET /api/approvals` + pull-to-refresh + APNs-triggered refresh.
- `apps/mobile/Clementine/Push/PushHandler.swift` — registers for APNs on launch, captures device token, POSTs to `/api/devices/:id/apns-token` so the daemon knows where to push.
- `apps/mobile/Clementine/AppDelegate.swift` — Apple's UIKit delegate plumbing for push.

**New daemon code:**
- `src/runtime/apns.ts` — JWT-signed HTTP/2 POST to `https://api.push.apple.com/3/device/<token>` with payload `{aps: {alert: {title, body}, sound, badge}, clementine: {approvalId, kind}}`. JWT is signed with the `.p8` auth key (cached, expires hourly). Uses Node's built-in `http2` + `crypto`. ~120 lines.
- `src/channels/webhook.ts` (modify) — `POST /api/devices/:id/apns-token` records the APNs device token against the paired device.
- `src/runtime/notifications.ts` (modify) — add `'apns'` to the destination types union; each paired device with an APNs token becomes an implicit destination. Existing notification queue + retry + dedup logic just works.
- `src/runtime/harness/approval-registry.ts` (modify) — on every new approval, emit a notification with `kind: 'approval'` and `payload: {approvalId, toolName, summary}`. This already happens for Discord; add APNs as another destination.

**Reuses:**
- `approval-registry.ts` — addressable approvals (apr-xy7q format) are perfect for mobile; tap a push, jump to `/api/approvals/apr-xy7q`
- `notifications.ts` — the existing queue (`addNotification`, retry, dedup) handles APNs the same way it handles Discord webhooks; register a new sender, not a new queue

**Apple/secrets setup:**
1. Apple Developer portal: create an APNs Auth Key (`.p8`). Note the Key ID + Team ID.
2. Add three new GitHub secrets for CI: `APNS_AUTH_KEY` (base64 `.p8`), `APNS_KEY_ID`, `APNS_TEAM_ID` (already have, same as `APPLE_TEAM_ID`).
3. Local dev: store the `.p8` at `~/.clementine-next/apns/AuthKey_<KEY_ID>.p8` (added to `.gitignore`). Daemon reads it on boot.

### Phase 3 — Workflows (Week 3)

**Deliverable:** Phone sees workflow list, can open a workflow, watch live runs, kick off runs.

**New code:**
- `apps/mobile/Clementine/Views/WorkflowsListView.swift` — list view backed by `GET /api/console/workflows`. Auto-refreshes on the SSE stream from `/api/console/workflows/events` (already live).
- `apps/mobile/Clementine/Views/WorkflowDetailView.swift` — shows steps, last-run status, RUN button. Tapping RUN posts to `/api/console/workflows/:name/run`.
- `apps/mobile/Clementine/Views/RunEventsView.swift` — tails `/api/console/workflows/:name/runs/:runId/events` (already exists, JSON polling — fine for MVP).

**Daemon side:** nothing new. Phase 1+2 already added the auth model and Phase 1 SSE works for any device with a valid token. The workflow endpoints already exist.

**Reuses:**
- The `/api/console/workflows/events` SSE (shipped 2026-05-23) — phone subscribes, list auto-refreshes when anything changes on disk
- `/api/console/workflows/:name/run` — kicks off a run with inputs

### Phase 4 — Memory browser + settings + polish (Week 4)

**Deliverable:** Memory facts visible on phone; settings page for daemon URL / token rotation / push toggle; navigation polish.

**New code:**
- `apps/mobile/Clementine/Views/MemoryView.swift` — calls `GET /api/console/brain/facts`, filter by kind, show searchable list.
- `apps/mobile/Clementine/Views/SettingsView.swift` — daemon URL, paired device info, push enable/disable, token rotate, sign-out.
- `apps/mobile/Clementine/Views/TabBar.swift` — five-tab root: **Chat · Approvals · Workflows · Memory · Settings**.
- Polish: pull-to-refresh everywhere, skeleton loaders, network-failure banners, "daemon unreachable" state with reconnect button.

**Daemon side:** minor — `POST /api/devices/:id/rotate-token` to swap a device's token without re-pairing.

### CI — Ad Hoc build pipeline

**New file:** `.github/workflows/release-ios.yml` — triggers on tags `ios-v*` + manual dispatch. Runs on `macos-14`. Steps:
1. Install Xcode tools, set up keychain
2. Decode `IOS_DISTRIBUTION_P12` from secret, import to temp keychain
3. Decode `IOS_PROVISIONING_PROFILE` from secret, copy to `~/Library/MobileDevice/Provisioning Profiles/`
4. `xcodebuild -archivePath ... archive` with `CODE_SIGN_STYLE=Manual`
5. `xcodebuild -exportArchive` with `ExportOptions.plist` set to `method: ad-hoc`
6. Upload `.ipa` to GitHub Releases (same pattern as `release-desktop.yml`)

**New secrets to add:**
- `IOS_DISTRIBUTION_P12` (base64 of the Distribution cert + key)
- `IOS_DISTRIBUTION_P12_PASSWORD`
- `IOS_PROVISIONING_PROFILE` (base64 of `.mobileprovision`)
- `KEYCHAIN_PASSWORD` (ephemeral, generated per build)

**Existing secrets reused:** `APPLE_ID`, `APPLE_TEAM_ID`.

To install on the phone: download `.ipa` from a Release, use Apple Configurator on the Mac, or use a hosted manifest URL. ~30 seconds per install.

## Critical files (summary)

**New (iOS app):**
- `apps/mobile/Clementine.xcodeproj/` + full SwiftUI tree (~30 Swift files by Phase 4)
- `apps/mobile/ExportOptions.plist`

**New (daemon side):**
- `src/runtime/device-tokens.ts` — per-device token registry
- `src/runtime/apns.ts` — APNs push sender

**Modified (daemon side):**
- `src/channels/webhook.ts` — `/api/devices/*` endpoints + token auth middleware accepts device tokens
- `src/runtime/notifications.ts` — `'apns'` destination type
- `src/runtime/harness/approval-registry.ts` — emit notification on new approval (small addition)
- `src/dashboard/console.ts` — new Devices panel in Settings

**New (CI):** `.github/workflows/release-ios.yml`

## Reuses (do NOT reinvent)

- `/api/message` endpoint with `onChunk` streaming (`src/channels/discord.ts:437` for the working pattern to copy)
- `WEBHOOK_SECRET` query/header auth as the fallback during pairing (`src/channels/webhook.ts:227`)
- `approval-registry.ts` — already produces addressable short IDs perfect for push payloads
- `notifications.ts` — already handles retry / dedup / multi-destination
- `/api/console/workflows/events` SSE (shipped 2026-05-23)
- `/api/console/brain/*` endpoints (shipped 2026-05-23, schema-correct after the `db.js` hot-patch)
- macOS signing pattern in `release-desktop.yml` — copy the structure for `release-ios.yml`

## Security posture

- **Transport:** Tailscale = WireGuard mesh. End-to-end encrypted. Daemon never has a public IP. Only devices in your tailnet can reach it.
- **Token storage:** iOS Keychain, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, Face ID gate on every app open.
- **Token revocation:** desktop Devices panel can revoke any device's token instantly; revoked tokens fail at the auth middleware.
- **APNs payload:** push contains only `{approvalId, kind, brief title}` — no sensitive args. The phone fetches the full approval details via auth'd `GET /api/approvals/:id` after the user taps the push.
- **Pairing window:** the QR code carries a one-time code valid for 5 minutes; expires after use.
- **Phone stolen + unlocked:** Face ID gate prevents app open; even bypassed, attacker reaches your tailnet but the daemon is reachable only at `100.x.x.x` — needs to know the address. Still: rotate the token from desktop and remove the device.
- **Audit log:** every device token use is recorded in `lastSeenAt` so you can spot unexpected activity.

**Honest caveats:**
- Tailscale itself is a trust anchor. If you don't trust Tailscale's control plane, run **Headscale** (self-hosted Tailscale coordination) — same wire protocol, your server.
- APNs metadata (token, timing, payload size) is visible to Apple. Bodies are encrypted in transit.
- This is **not** a multi-user app. The model is single-user. Multi-user mode would require per-user device scoping in `device-tokens.ts`.

## Verification

**Phase 1 done when:**
- Pair phone via QR from desktop's Devices panel; token lands in Keychain.
- Send "hello" from phone chat → daemon receives via `/api/message`, response streams back to the phone token-by-token.
- Kill Tailscale → app shows "daemon unreachable" with a retry button.
- Revoke device from desktop → next phone request returns 401, app prompts re-pair.

**Phase 2 done when:**
- Trigger destructive action from phone chat (e.g. *"create a workflow that sends email"*). Approval card pushes to phone within 2s. Tap → approve → daemon executes.
- Reject path: tap reject → approval-registry marks rejected → action does not execute.
- Receive a proactive brief (the daemon's `proactive-briefs` already fires periodically) — push lands on phone.

**Phase 3 done when:**
- Open Workflows tab → see all existing workflows.
- Tap a workflow → see steps + last-run badge.
- Tap RUN on a manual workflow → live events stream to the phone (step_started, step_completed, run_completed).
- Create a workflow from the desktop while the phone has the list open → list refreshes within 1s via SSE.

**Phase 4 done when:**
- Memory tab shows facts, searchable.
- Settings → rotate token → app re-auths without re-pairing.
- Force-close the app → reopen → Face ID gate prompts → restored to last view.

**Smoke at every phase:**
```bash
npm run typecheck && npm run build
npx tsx --test src/runtime/*.test.ts src/channels/*.test.ts
```

In Xcode: `Cmd+U` runs the test target (Phase 1 adds a `ClementineTests` scheme with at least `KeychainStore` + `DaemonClient` unit tests).

## Out of scope

- **Android.** Same architecture works; add later if needed.
- **Apple Watch.** Push to watch comes free via APNs forwarding from phone — no code.
- **iPad-specific UI.** SwiftUI's adaptive layout will work; no extra effort.
- **Offline mode.** Daemon must be reachable. No queued-send-when-online.
- **Multi-account.** One Tailscale identity = one daemon. Multi-daemon support deferred.
- **App Store distribution.** Ad Hoc is the right call for personal use. If you ever want to ship publicly, that's a separate ~1 week of App Store Connect setup + review prep.

## Honest cost summary

| Item | Cost |
|---|---|
| Apple Developer (already paid) | $0 incremental |
| Tailscale personal (free for ≤100 devices) | $0 |
| APNs (free, included with Developer account) | $0 |
| CI minutes (GitHub Actions, macos-14 ~$0.08/min × 15 min × ~4 builds/week) | ~$20/mo at peak |
| Total ongoing | ~$20/mo CI, otherwise $0 |

**Time:** ~3–4 weeks solo for the full mobile mirror. ~1 week to get Phase 1 working end-to-end and decide if the rest is worth it.
