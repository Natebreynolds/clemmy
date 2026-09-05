# Mobile relay + pairing — security review before handing the app to a test user (2026-09-05)

Scope: what a person who installs the Clem app and pairs it can reach, how they get
in, how they stay in, how they are thrown out, and what the wire looks like. Every
statement below was read from the code on `wave/one-gate-and-hardcode-subtraction`
at `b69046aa`+; line numbers drift within days — the function names do not. This
review was done by hand (no adversarial-verifier pass; subagent capacity was
exhausted); the "not verified" items are named as such.

## 1. The one decision that changes everything

A paired phone has **full owner parity** with the desktop. It can answer questions,
approve pending writes and sends, chat as the owner (which drives the agent loop,
which can run shell commands), read and edit memory, run workflows. The session
scopes that exist are `full` and `pin-rotation` (a sandbox that can only set a
stronger PIN) — there is no viewer or limited-device scope
(`src/runtime/mobile-sessions.ts` `MobileSessionScope`).

So: **if a tester pairs to YOUR daemon, they are you.** The safe way to hand the
app to a test user is a tester-owned install (their own daemon, their own
accounts), or a limited device scope — which does not exist yet and is not a
one-evening change. Pairing a tester to the owner's daemon is acceptable only for
a supervised session with revocation ready (one click, §5).

## 2. How a device gets in (verified)

- **QR pairing** (`src/runtime/mobile-pairing.ts`, `/m/auth/pair`): a 256-bit random
  token (`randomBytes(32)`), single use, 10-minute TTL, at most 10 live codes; only
  `SHA-256(token)` is stored, so the state file grants nothing. Minted only from the
  desktop console behind the console secret (`/api/console/mobile-access/qr`,
  `isAuthorized`), and only when the auth-posture gate passes (§4). Re-pairing a
  known phone keeps its device identity.
- **PIN login** (`/m/auth/login`, `src/runtime/mobile-pin.ts`): the fallback when
  no QR is at hand. New PINs are 8–64 chars; a pre-floor weak PIN still logs in but
  lands in the `pin-rotation` sandbox until a stronger one is set. Every attempt
  goes through the two-tier limiter (`mobile-rate-limit.ts`): per-IP lockout and a
  daemon-wide lockout that also notifies the owner. PIN and pairing have separate
  budgets so a PIN storm cannot lock the pairing recovery path.
- **Origin hand-off / adopt** (`/m/auth/origin-handoff*`, `/m/auth/origin-adopt`):
  moving a paired phone to a new origin. Minting requires a live authenticated
  session + device proof and is **LAN-only**; the relay refuses both credential
  ceremonies (`mobile-ingress.ts` `RELAY_FORBIDDEN_PATHS`).
- Admin-only without a phone session: `/m/auth/rotate` (set PIN + revoke every
  session) and `/m/auth/sessions` (list devices) require the console's admin
  authorization (`deps.isAdminAuthorized`).

## 3. How a device stays in, and how a stolen cookie fails (verified)

`src/runtime/mobile-sessions.ts`, `mobile-device-proof.ts`:
- The session token is opaque and random; only its SHA-256 is stored; it travels
  as an HttpOnly cookie.
- Sessions are **device-bound**: the phone generates a non-extractable keypair and
  signs a DPoP-shaped proof over the session fingerprint on every request. A copied
  cookie cannot sign. Sessions rotate every 12 h with a 30-second grace; a device
  presenting a retired token re-authenticates only if it can prove itself with the
  device key, otherwise the whole chain is revoked (the "stolen cookie" reading).
- Sliding TTL 30 days, absolute TTL 90 days, 14-day grace to upgrade legacy
  sessions to key binding. The device-binding kill switch
  (`mobile-device-policy.ts`) is a documented escape hatch; turning it off is a
  blocking posture gap that refuses the QR (§4).

## 4. The doors (verified)

`src/runtime/mobile-ingress.ts` classifies by **socket, never by header**:
- `loopback` — the main listener on this Mac (8520 in dev): full surface.
- `direct-app` — the pinned-TLS listener (8421): the iOS app pins the daemon's own
  certificate fingerprint carried in the QR (`mobile-tls.ts`); Bonjour re-finds the
  daemon after a DHCP change by matching that fingerprint (`mobile-bonjour.ts`).
- `relay` — the daemon dials OUT to a relay over TLS pinned to the relay cert
  fingerprint from config, registers its `pairId` with a per-pair 32-byte auth
  token persisted 0600, and phone connections come back as raw TLS byte streams:
  the phone's pinned handshake with THIS Mac passes through untouched, so the relay
  moves ciphertext it cannot read (`mobile-relay.ts`). No inbound port anywhere.
- QR posture gate (`mobile-auth-posture.ts`): the QR is refused while device
  binding is disabled; a weak-PIN-only posture is reported but non-blocking.

**Fixed today:** the mobile TLS private key was written world-readable (0644) on
macOS — `writeFileSync(..., {mode})` only applies on create, so the post-hoc
rewrite never tightened it. Now created 0600 before openssl writes into it and
chmod'd after (`42b09dd3`, verified under umask 022/000/077).

## 5. How a device is thrown out (verified)

- Owner: desktop console → mobile access → revoke one device
  (`DELETE /api/console/mobile-access/sessions/:deviceId`) or all
  (`DELETE …/sessions`); `/m/auth/rotate` revokes everything and sets a new PIN.
- Automatic: token-reuse without device proof revokes the chain; global lockouts
  notify the owner; sessions expire on the TTLs above.
- Phone: `/m/auth/logout` revokes its own session.

## 6. Findings (ranked)

1. **Owner parity is the risk, not the crypto** (§1). Hand the app to a tester on
   their own install, or supervise and revoke. A `viewer`/`limited` device scope is
   the product answer; it belongs to a later phase.
2. **The relay is a public default.** `loadRelayConfig` falls back to a built-in
   relay (`DEFAULT_RELAY_CONFIG`, a Railway-hosted proxy) unless
   `CLEMENTINE_MOBILE_RELAY=off` or self-hosted `CLEMENTINE_RELAY_*` / state-file
   values are set. The relay cannot read traffic (pinned E2E TLS) and cannot
   impersonate the daemon (relay cert pin), but it is an availability and metadata
   dependency (pair ids, timing, client IPs) every install shares by default. A
   tester should know that; the owner can turn it off for a LAN-only test.
3. **Minor disclosure:** `/m/auth/status` tells an unauthenticated caller whether a
   PIN is configured and when it changed. Harmless for a LAN door, slightly helpful
   to an attacker on the relay origin. Low.
4. **`WEAK_PIN_ONLY` is non-blocking** by design (the QR must stay available as the
   recovery path); with a tester in play, set a strong PIN first.
5. **Not verified by hand in this pass:** the iOS app's server-trust evaluation
   (`apps/ios/Clem/ConnectionCoordinator.swift`, `RelayDiscovery.swift`,
   `Pairing.swift`) — that the pin is enforced on every connection including
   relay re-discovery — and the relay server's own behavior under a hostile peer.
   Both should get the adversarial pass when agent capacity returns.

## 7. Turning it on live (the plan)

1. Build the mobile bundle the daemon serves at `/m` (`npm run build:mobile-web` →
   `apps/mobile-web/dist`; the router probes that path, then the packaged
   `resources/mobile-web`, then `CLEMENTINE_MOBILE_WEB_DIST`). Decide whether the
   bundle is the current `main` UI or the `ui/main-window` branch (command-center
   home, floating ask capsule, customize sheet) — the branch is typecheck- and
   test-green but has not had a finish review on a real phone.
2. Start the daemon on the live home (owner's word; nothing about the live home is
   touched by this review), confirm `/m/health` and `/m/relay-info`.
3. Owner sets a strong PIN, then mints the QR from the desktop console (the
   posture gate must pass); pair the phone on the LAN through the pinned door.
4. Test on LAN: Home / Needs-you / approve a reversible draft / answer a question /
   chat / customize; then leave the LAN (cellular) and repeat through the relay.
5. Revoke the device from the console; confirm the phone is back at "scan the QR".
   Re-pair; confirm the device keeps its identity (one row, not a stranger).
