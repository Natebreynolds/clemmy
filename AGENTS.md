# Clementine project continuity

Before diagnosing or changing this harness, read:
- `docs/checkpoints/2026-09-19-current-framework-state.md`
- `docs/checkpoints/2026-09-19-active-configuration.md`
- `docs/checkpoints/2026-09-19-weekend-refinements.md`

These contain user-requested memory and dated findings. Recheck the running
configuration and other active agent's branch before relying on them.

The user requires installed-app hotpatch and live-home acceptance, not isolated
home acceptance. Never aim destructive fixture resets at the live home. Preserve
other agents' edits and the user's token-meter work.

Clementine owns its Claude OAuth authentication and supplies it to the SDK.
Standalone CLI login status is not the authority for Clem's Claude connection.
Verify actual served models and judge results; substitutions and failed-open
reviews are not successful validation of the requested provider.

User scope clarification (2026-09-19): framework work only. Do not repair or
migrate personal/business Spaces or tune personal integrations. Validate shared
framework changes with named controlled fixtures in the installed app/live home.
See the explicit scope correction in docs/checkpoints/2026-09-19-live-acceptance.md.
