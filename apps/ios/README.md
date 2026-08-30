# Clem for iOS

The mobile command center. A signed native app that pairs with the Clementine
daemon by scanning the same QR the desktop Mobile panel already shows — and
reaches the same Mac identity over certificate-pinned TLS. On the same LAN it
connects directly; off-LAN it can use the paired relay as a byte tunnel without
changing the TLS peer it trusts.

## How the security model works

1. The daemon mints a self-signed TLS certificate on first boot
   (`src/runtime/mobile-tls.ts`) and opens a LAN HTTPS listener that serves
   only the `/m/*` mobile surface (`direct-app` ingress class — socket-enforced,
   same mechanism that keeps the admin API off the tunnel).
2. The pairing QR encodes
   `https://<lan-ip>:8421/m/?pair=<one-time>&fp=<sha256>[&relay=<origin>]`.
   `fp` is the certificate fingerprint; `pair` is the one-time pairing token,
   and `relay` is an optional off-LAN door for the same daemon.
3. The app stores the pairing in the Keychain and accepts exactly that
   certificate — nothing else, not even a valid public CA chain. A pairing with
   no fingerprint is refused and must be repaired by scanning a current QR.
4. Direct and relay requests use the same certificate pin. The relay forwards
   the TLS byte stream but does not terminate the app-to-Mac TLS session or hold
   the Mac's certificate key; it can still observe ordinary network metadata.
5. Everything after the TLS layer is the existing hardened mobile stack:
   one-time pairing consumption, device-bound sessions (P-256 proof per
   request), scoped rate limits, default-deny routes.

## Build & install (first time)

Prereqs: Xcode from the App Store (Command Line Tools alone are not enough),
and `brew install xcodegen`.

```bash
cd apps/ios
xcodegen generate          # project.yml is the source of truth
open Clem.xcodeproj
```

In Xcode: plug in the iPhone, trust the Mac on the phone if prompted, select
the *Clem* scheme + your device, press Run. Signing is automatic with team
`4AR3Y8XD72`. First run on a new device: Settings → General → VPN & Device
Management → trust the developer profile.

CLI alternative once a device is known:

```bash
xcodebuild -project Clem.xcodeproj -scheme Clem \
  -destination 'platform=iOS,name=YOUR_IPHONE_NAME' \
  -allowProvisioningUpdates build
xcrun devicectl device install app --device YOUR_IPHONE_NAME \
  $(ls -d ~/Library/Developer/Xcode/DerivedData/Clem-*/Build/Products/Debug-iphoneos/Clem.app | head -1)
```

## Pair

Desktop → Mobile panel → QR. Scan it in the app (or paste the pairing link in
the field under the scanner — handy in the Simulator). Done: the PWA session
machinery takes over inside the pinned web view.

## Rendezvous: surviving IP changes

The daemon advertises `_clemmy._tcp` over Bonjour with the cert fingerprint
in the TXT record (`src/runtime/mobile-bonjour.ts`, via macOS's built-in
`dns-sd`). When the app can't reach its stored address, it browses for the
service whose `fp` matches its pin, resolves the new address, and re-points
itself — no re-pairing when DHCP reshuffles. A spoofed advertisement can only
steer the app into a TLS pin check it cannot pass.

## Push: APNs straight from the daemon

The app requests notification permission after first load, gets its APNs
device token, and hands it to the PWA (`window.clemNative.registerApnsToken`),
which registers it over its own proof-signed session — the native shell never
holds a credential. The daemon sends alerts directly to Apple over HTTP/2
with a provider JWT (`src/runtime/apns.ts`); no gateway, no third party.

To activate push, drop an APNs signing key into the daemon:

1. developer.apple.com → Certificates, Identifiers & Profiles → Keys → add a
   key with the **Apple Push Notifications service (APNs)** capability;
   download the `.p8` (one-time download) and note the Key ID.
2. Write `~/.clementine-next/state/apns.json`:
   ```json
   { "keyId": "<KEY_ID>", "teamId": "<TEAM_ID>", "keyPath": "/path/to/AuthKey_<KEY_ID>.p8" }
   ```
3. Restart the daemon. Already-registered phones start receiving pushes
   immediately — registration is accepted before the key exists.

Environment defaults to `sandbox`, which matches Xcode-installed builds
(`aps-environment: development`). For TestFlight/App Store builds set
`"environment": "production"`.

## Current scope / known gaps

- On Wi-Fi, Clem tries the paired Mac directly before its relay. On cellular
  or another off-LAN path, it probes the paired relay first. The relay is only
  a byte tunnel: the native shell still pins the Mac's TLS identity, and the
  adopted mobile session remains bound to the paired device key.
- After upgrading an older pairing to the relay-capable shell, open Clem once
  while it can still reach the Mac directly so it can persist its first relay
  handoff. A binary downgrade after a v2 handoff has been minted requires the
  documented handoff-state quarantine; it is not an automatic rollback path.
- Cert rotation (`rotateMobileTlsIdentity`) invalidates every paired app by
  design; recovery is re-scanning a QR.
