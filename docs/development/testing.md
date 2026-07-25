# Testing Clementine

Clementine uses Node's built-in test runner through `tsx`. The repository test
wrapper gives the suite a disposable `CLEMENTINE_HOME`, so ordinary automated
tests cannot bind to a developer's real Clementine data.

## Requirements

- Node.js `>=22.15.0`
- npm
- macOS for native permission, signing, Recall, and notch integration checks

Install only the packages needed for the surface you are changing:

```bash
npm ci
npm --prefix apps/console-web ci
npm --prefix apps/mobile-web ci
npm --prefix apps/desktop ci
npm --prefix apps/web ci
```

## Core checks

Run the root typecheck and isolated test suite:

```bash
npm run check:public-hygiene
npm run typecheck
npm test
```

The public-hygiene gate scans existing Git-tracked files, not ignored local
artifacts, and reports only filenames and finding categories.

Run one or more test files by passing their paths after `--`:

```bash
npm test -- src/memory/recall.test.ts
npm test -- apps/desktop/src/notch-preferences.test.ts
```

The wrapper in `scripts/run-tests-isolated.mjs` creates and removes a temporary
home automatically. It also strips inherited credential variables, blocks real
model transports, and prevents macOS Keychain fallback, so a unit test cannot
silently spend quota or pass because of a developer login. Transport tests must
use their injected fake seams. Tests that need narrower fixtures should still
create their own temporary directories and set `CLEMENTINE_HOME` before
importing modules that read configuration at module load.

## Application checks

Check each application independently when its code changes:

```bash
npm --prefix apps/console-web run typecheck
npm --prefix apps/console-web run build

npm --prefix apps/mobile-web run typecheck
npm --prefix apps/mobile-web run build

npm --prefix apps/desktop run typecheck
npm --prefix apps/desktop run build

npm --prefix apps/web run typecheck
npm --prefix apps/web run build
```

The desktop build compiles the Electron main process and preload bundles. A
successful cross-platform TypeScript build does not replace macOS validation of
native permissions, signing, meeting capture, or notch behavior.

## Release and reliability gates

These commands match the focused gates used by CI and release preflight:

```bash
npm run test:release-assets
npm run bench:gates
EVAL_PASSK_STRICT=on npm run eval:passk
EVAL_JOBS_STRICT=on npm run eval:jobs
```

Job-evaluation fixtures are hand-authored, synthetic scenarios. Never generate
or refresh them from a real Clementine session, event store, connected account,
customer record, message, or meeting transcript.

Use `npm run eval:memory` when memory retrieval, migration, consolidation, or
evidence reconciliation changes. The proof harness is available through
`npm run proof:selftest` and the provider-specific `proof:*` scripts.

Before tagging, commit the exact candidate source (the live proof refuses a
dirty source tree), build it, and run the Fusion-off long-horizon gate:

```bash
npm run proof:critical:codex
npm run proof:endurance:codex
npm run proof:critical
npm run proof:fusion:codex
```

`proof:critical:codex` is the first canary. The endurance leg raises the
manifest to 120 items. `proof:critical` then runs every configured brain and
records SKIP, rather than a false failure, for a brain whose local sign-in is
absent. The Fusion canary is separate and opt-in: Codex remains the author while
a distinct connected model must return the bounded accept/correct contract; the
gate rejects checker timeouts, legacy full rewrites, same-family self-checks,
protocol leakage, and output beyond the correction ceiling. A green proof is
release evidence for that commit; it does not create a tag.

## Live and manual testing

Do not point an automated or destructive test at a real
`~/.clementine-next`. Create a disposable home instead:

```bash
export CLEMENTINE_HOME="$(mktemp -d)"
npm run init-home
```

Live provider checks may incur cost or touch connected accounts. Keep them
read-only unless the test explicitly requires a mutation, use test accounts,
and verify the selected account and destination before continuing.

For desktop development, quit the installed Clementine app first so two shells
do not compete for native shortcuts or meeting-capture resources. Build the web
surfaces and daemon before launching Electron:

```bash
npm run build
npm run build:console-web
npm run build:mobile-web
npm --prefix apps/desktop run build
npm --prefix apps/desktop start
```

Signed and notarized packaging is a maintainer release operation, not a routine
contributor test. See [the desktop release guide](../guides/desktop-releases.md).
