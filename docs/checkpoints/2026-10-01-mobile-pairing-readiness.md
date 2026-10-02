# Mobile pairing and shared relay readiness — 2026-10-01

## Owner request and ownership

The owner authorized this task to tackle mobile connection failures alongside the
other agent, including read access through the Railway CLI. The reported tester
was on the same Wi-Fi as their own computer. Different-network first pairing is
therefore not the established cause. Their precise error, app versions and failure
time have not been provided; do not attribute the incident to Railway, iOS
permissions, firewall, expired QR or Wi-Fi isolation without that evidence.

Work is isolated on `codex/mobile-relay-readiness`, based on `claude/premium-ux`
at a2834a951. Its checkout is the Codex-managed mobile-relay-readiness worktree.
The other agent's recent local task log identifies premium-ux as their current
UI lane. Their checkout was clean when inspected. No main edits, tag, push,
Railway deployment, credentials changes, phone unpairing or app restart were
performed by this task. Do not overwrite a newer shipping candidate with this
worktree's full build: integrate the bounded patch first.

## Verified live evidence

- Railway production `clementine-relay` / `relay` has active successful deployment
  a66189bf-0754-47c2-8125-e44d3cc8a501. Logs show several distinct installation
  identities registered, which disproves a single-owner relay limitation. They
  do not identify which one belongs to the reported tester.
- Read-only SSH confirmed the deployed `/app/server.mjs` hash is
  cf317dbbfdbaa3e6448fbfd7db20d97084dc45013717769d693db5a897ef19f5.
  The deployed source contains proof-of-possession registration. Deployment date
  alone is not a reason to infer that the running protocol lacks that protection.
- Two temporary, named synthetic HTTPS identities A and B registered together on
  the actual production relay and each passed the candidate's pinned public
  health check. A route checked against B's certificate was refused before HTTP.
  All temporary clients, listeners and identity directories were cleaned up.
- The installed app/live-home Mac's `/m/health` returned 200 through the public
  relay after its certificate was independently matched to its public local
  certificate. The candidate probe independently passed the same route.
- These checks send no model requests, pairing tokens, PINs, cookies, device
  credentials or business writes. They prove transport, not real iPhone pairing,
  authenticated origin adoption, push delivery or cellular operation.
- The served build-info snapshot during this work was version 3.18.24,
  gitSha 23048dba3ae5d43f7c95fa62ad899615953f78a2, fingerprint
  a7a8798799982915a068d61644ab703734ce7326989ac6e724a2e753e3582d8a,
  process 82125. Another installation cycle changed the running process during
  inspection. This is a served identity observation, not a recommendation to
  replace that candidate. Recheck before any installation or acceptance.

Raw controlled receipts and installed summaries are under this worktree's
`output/mobile-relay-readiness-2026-10-01/`. No secret material is included.

## Framework defects corrected in source

1. A scannable QR no longer means `live`. Setup distinguishes `pairing-ready`
   from `paired`, and remote registration from a verified pinned route. Device
   registration is never represented as a current authenticated phone session.
2. The relay client exposes sanitized lifecycle and failure status. Registration
   is bounded (including TCP/TLS), while established work is not given a new wall.
   Disconnect and stop clear connected state and route-verification evidence.
3. One public health check runs after each successful registration. It enforces
   this Mac's certificate pin before HTTP, sends no credentials, refuses
   redirects, bounds time and response bytes, and verifies the real public route.
   Concurrent explicit checks share the in-flight request. A result from an old
   connection cannot qualify a replacement connection.
4. The setup check verifies the advertised local TLS pairing address, rather than
   qualifying only loopback HTTP. A failed local check returns a named remedy;
   an unavailable relay does not prevent safe local pairing.
5. The desktop Mobile panel shows pairing state and remote check state separately,
   with the check timestamp and a retry action. It states same-Wi-Fi, Local Network
   permission and awake-host requirements. PIN copy no longer promises remote
   enrollment that the ingress correctly refuses. Structured failures reach the
   existing API error parser with a human-readable message.

## Qualification

Verified before the final build:
- 43 focused checks passed: setup/status, access/PIN/QR, relay client, pinned
  health verification, and relay availability/security socket checks.
- Four new setup regression pins fail against the original setup implementation.
- Backend and console TypeScript checks passed.
- Production relay and installed-app health checks above passed with zero model
  token spend.

No full suite or generative acceptance was run; the other agent remains active.
A fresh build and its receipt are recorded separately under output, so updating
this checkpoint does not invalidate a completed source fingerprint.

## Integration and installed acceptance still owed

Combine the bounded commit with the actual shipping branch and rebuild that
combined revision. Backend and console assets must be installed together: the new
setup phases have a coordinated console consumer. Keep the currently paired
phones, TLS identity and sessions; do not reset the live home or redeploy the
relay merely to apply this client/UI patch. Coordinate installation ownership;
this task has not hotpatched its candidate.

After that coordinated installation, inspect the served fingerprint and Mobile
panel. Confirm ready-to-pair versus paired state, automatic remote route check,
explicit Check connection, and reachable failure text. Pair a previously unpaired
real iPhone to a second independent computer on the same local network; record
phone Local Network permission, desktop listener/firewall evidence, QR freshness,
exact failure stage and both served/native build identities. Then switch that
phone to cellular and prove session adoption, chat/attachment receipt and an
approval response with no duplicate action. Reopen both apps and repeat the
handoff. This is required before claiming the tester's incident fixed.

Do not weaken certificate pinning, make PIN login or initial token redemption
public, or require users to create Railway accounts. The shared relay already
supports independent installations; onboarding must expose which stage failed.
