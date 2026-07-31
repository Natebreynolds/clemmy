# clementine.app — landing page + licensing admin

Marketing site for Clementine plus the hosted licensing admin at `/admin`.
Next.js 15, deployed to Railway.

## Develop

```bash
cd apps/web
npm install
npm run dev
# open http://localhost:3000
```

To work on `/admin` locally, put the variables from the table below in
`.env.local` (gitignored). The session cookie drops its `Secure` flag outside
production so it still works over plain http on localhost.

## Build

```bash
npm run build
npm start
```

## Deploy (Railway)

1. New Railway service → connect this repo.
2. Settings → Root Directory: `apps/web`.
3. Railway picks up `railway.json` automatically (Nixpacks build, standalone Next.js server).

The `/api/download` route fetches the latest Clementine Mac asset from GitHub
Releases and 302s to it. It intentionally avoids caching so release-day
downloads pick up newly published desktop builds immediately.

## Licensing admin (`/admin`)

Generate, inspect, and revoke license keys; manage activations; flip the
per-product enforcement kill switch. Reachable from anywhere, phone included.

### Required environment variables

| Variable | What it is |
| --- | --- |
| `LICENSE_API_URL` | Base URL of the license server, e.g. `https://license.up.railway.app`. No trailing slash needed. |
| `LICENSE_ADMIN_TOKEN` | Bearer token for the license server's `/v1/admin` API. **Server-side only** — it is attached by the proxy and never reaches a browser. |
| `ADMIN_EMAIL` | The one admin login. |
| `ADMIN_PASSWORD_HASH` | scrypt hash as `salt:hash`, both hex. |
| `ADMIN_TOTP_SECRET` | Base32 TOTP secret enrolled in an authenticator app. |
| `ADMIN_SESSION_SECRET` | ≥16 random chars. Keys the digest of session tokens; changing it signs every session out. |

Without the four `ADMIN_*` values, login fails closed with a "not configured"
message. Without the two `LICENSE_*` values, the pages render an error card
instead of data — the panel never falls back to an unauthenticated state.

### Minting the credential

```bash
node scripts/admin-credential.mjs --email you@example.com
# prompts for the password without echoing, then prints all four ADMIN_* values
# plus an otpauth:// URL to add to your authenticator
```

Verify a code from the authenticator works before discarding the old session —
the TOTP secret is printed once and is not recoverable from the hash.

### How it is secured

- `LICENSE_ADMIN_TOKEN` is read only in `src/lib/admin/license-api.ts`, which is
  imported exclusively by server components and route handlers. The browser
  talks to `/api/admin/[...path]`, which requires a session and then attaches
  the bearer token server-side.
- Login needs email + password + TOTP. Password hashing is scrypt
  (N=16384, r=8, p=1) and TOTP is RFC 6238 HMAC-SHA1 with ±1 step of drift
  tolerance — both hand-rolled on `node:crypto`, no added dependencies.
- The session cookie holds a random 32-byte token, HttpOnly, SameSite=Strict,
  Secure in production, 12-hour expiry. The server stores only a keyed digest
  of it.
- Every protected page renders through `app/admin/(protected)/layout.tsx`, which
  checks the session server-side. `src/middleware.ts` bounces cookie-less
  requests earlier, but it is an optimization, not the boundary.
- Login attempts are rate-limited per IP (8 failures per 15 minutes, then a
  15-minute lockout) and all secret comparisons are constant-time.
- Sessions and rate-limit counters are in-memory: a redeploy signs you out.
  That is the intended trade for a single-operator panel with no session store.
- Mutating proxy calls require a same-origin `Origin` header, and every admin
  response is `Cache-Control: no-store`.

A generated key is shown exactly once, on the creation screen. The license
server stores only its hash, so "resend my key" is impossible by design — the
answer is to revoke and issue a new one.

## Hero video

The cinematic `public/hero.mp4` is generated with Higgsfield (Veo 3.1) and re-encoded with `ffmpeg -g 1 -keyint_min 1` so `video.currentTime` can be scrubbed smoothly by scroll position.

To regenerate:

```bash
higgsfield generate create veo3_1 --prompt "..." --duration 8 --aspect_ratio 16:9 --quality high --wait
# download the output URL, then:
ffmpeg -i raw.mp4 -c:v libx264 -preset slow -crf 20 -g 1 -keyint_min 1 -pix_fmt yuv420p -movflags +faststart public/hero.mp4
ffmpeg -i public/hero.mp4 -vframes 1 public/hero-poster.jpg
```
