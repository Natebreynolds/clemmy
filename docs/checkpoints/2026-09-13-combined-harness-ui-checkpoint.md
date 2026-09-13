# Combined harness and UI checkpoint — 2026-09-13

This checkpoint includes the shared harness refinements and the other agent's desktop/mobile UI work. The owner explicitly requested committing the combined tree after compilation, then starting dev for manual tests across models. Package versions remain3.18.5. This is a local development checkpoint, not a release qualification, tag or push.

## Included work

- Harness: Plan preparation and repair, exact approved Execute bindings, connected-tool discovery and schema retention, relevant memory in review, dependency-aware reads, durable synthesis/file correction, retained MCP-result querying, truthful failure diagnostics, and lossless handling of literal control characters in model argument JSON. The detailed progression, known failures and evidence are in [the harness checkpoint](2026-09-13-plan-continuation-fixes.md).
- Desktop: chat scrolling/column layout, activity presentation, conversation-hook refinements, and the Home design preview with its source assets.
- Mobile: composer and dictation/keyboard behavior, SVG controls, chat back navigation, thread chrome, related screen/CSS refinements, and the explicit chat preview.
- The Home design remains fixture-backed: `/console/dev/home-mock` or `/console/home?mock=populated`. Normal Home and Chat remain live. Do not confuse mock cards with real work or use the mock to qualify task execution.

## Validation before commit

All four builds passed under Node22.22.0:

- root `npm run build` (backend)
- `npm --prefix apps/console-web run build`
- `npm --prefix apps/mobile-web run build`
- `npm --prefix apps/desktop run build`

The affected UI, shared chat engine, hotpatch and dev-launch checks passed **103/103** tests across10 files using the isolated repository runner. The frozen T harness qualification already passed **618/618** across22 files. A byte comparison against T found no source-code difference; only the updated harness checkpoint document and the newly included UI critique differed at that comparison. Three trailing-whitespace/EOF cleanups were then included before finalizing the commit. Build fingerprints include documentation and Git state, so the committed checkpoint gets a new fingerprint on rebuild. These counts overlap earlier testing and are not a full-suite claim.

Build/test logs are retained locally at `output/reviewer-monitor/2026-09-13-combined-checkpoint/`. The prior live reports remain under `output/reviewer-monitor/2026-09-13-plan-continuation-fixes/`. Ignored dist builds, logs, proof homes and credentials remain outside Git. The canonical source execution bundles under `src/runtime/harness/implementation-artifacts/emitted/` are intentionally tracked and are included in the checkpoint. No live-home isolation sentinel pass is claimed while the installed daemon was running.

## Dev launch and repeatability

From this checkout, with Node22.22.0 on PATH:

```bash
export PATH="/Users/nathan.reynolds/.nvm/versions/node/v22.22.0/bin:$PATH"
npm run build:console-web
DEV_DISCORD=false bash scripts/dev-up.sh
```

The existing launcher quits the installed app, starts one source daemon using the real Clementine home and connected accounts, rebuilds backend/mobile, and verifies the exact Git/source/schema identity. It disables proactivity for dev and restores the original policy through `scripts/dev-down.sh`. Discord is explicitly off for these desktop/mobile model tests. Model selections remain user-configured. The freshly built desktop console is served by that daemon at `/console/`; mobile is `/m/`. Do not reopen the installed app while the source daemon is the active owner.

To return to the installed app after completing/stopping active tests:

```bash
bash scripts/dev-down.sh
```

## Qualification still needed

R Sonnet5 + selected Opus5 completed Plan→Execute with verified final bytes and judge-directed correction, but planning took11m50s and the original strict test recorded failures. Q Grok Execute stopped without a retained cause; the new diagnostics and fixes need a fresh replay. Grok's access grant last observed expired at2026-09-13T19:44:55.974Z, so reconnect Grok before that leg. No new failure was attributed to a provider without evidence. Test Plan→Execute and ordinary Act across chosen models before the next tag, including real connected tools and the live desktop/mobile UI.

Dev startup regenerated the tracked source execution bundle and manifest from the already compiled harness. This exposed a stale checked-in transport generation; the current generation matches the compiled T manifest (`ae019266fa28afebb8f284d0154ffe37d10ce98854a706adce4d190c81adfcce`). It is committed in the checkpoint follow-up so another source launch remains clean and reproducible. This is a build-artifact synchronization, not a new harness behavior change.
