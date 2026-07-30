# Clem for iOS

The mobile command center. A signed native app that pairs with the Clementine
daemon by scanning the same QR the desktop Mobile panel already shows — and
connects **directly** to the Mac over pinned TLS. No Cloudflare, no tunnel, no
third party in the path.

## How the security model works

1. The daemon mints a self-signed TLS certificate on first boot
   (`src/runtime/mobile-tls.ts`) and opens a LAN HTTPS listener that serves
   only the `/m/*` mobile surface (`direct-app` ingress class — socket-enforced,
   same mechanism that keeps the admin API off the tunnel).
2. The pairing QR encodes `https://<lan-ip>:8421/m/?pair=<one-time>&fp=<sha256>`.
   `fp` is the certificate fingerprint; `pair` is the one-time pairing token
   the mobile surface already uses.
3. The app stores `{origin, fp}` in the Keychain and accepts exactly that
   certificate — nothing else, not even a valid public CA chain. End-to-end
   encryption terminates on your Mac, unlike the tunnel path where a third
   party held the TLS keys.
4. Everything after the TLS layer is the existing hardened mobile stack:
   one-time pairing consumption, device-bound sessions (P-256 proof per
   request), scoped rate limits, default-deny routes.

If the QR has no `fp` (a tunnel-mode QR), the app falls back to normal system
trust — so the same app keeps working if a tunnel ever comes back.

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

- Reachability is whatever network path exists between phone and Mac (same
  Wi-Fi today, plus anything Bonjour can see). A remote path is a deliberate
  fast-follow decision, not an accident of this design.
- Cert rotation (`rotateMobileTlsIdentity`) invalidates every paired app by
  design; recovery is re-scanning a QR.
