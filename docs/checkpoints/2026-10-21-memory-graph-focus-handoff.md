# Memory: restore the graph as the focal point

The owner rejected the previous Memory layout's second left sidebar and the graph hidden behind a disclosure. This follow-up changes that hierarchy while preserving the existing stores, search, correction, assistant, and scrolling behavior.

## Integration

- Branch: `codex/memory-graph-focus-2026-10-21`.
- Worktree: `/Users/nathan.reynolds/.codex/worktrees/memory-workspace/clementine-next`.
- Base: `153e0bdcca5a5f1dc37f871630a49c03b36e4962`, rechecked clean in the integrating agent's `claude/r45-efficiency` checkout. The previous Memory and mobile changes are already in that base; do not replay the old Memory branch.
- Apply only this follow-up to the current integration tree. Release/install ownership remains with the other agent.

## Result

- The landing view immediately shows the existing 3D memory graph. It is no longer hidden beneath learning, saved facts, and a collapsed Knowledge map.
- Memory's secondary vertical navigation is removed. Existing views use a horizontal row above the content; at narrower container widths a labeled View selector keeps all eight destinations accessible.
- The companion panel begins closed at every width. Ask Clem and fact inspection open it on demand. The assistant still stays mounted while hidden, preserving draft/retry ownership.
- The content grid has one column, with an optional inspector column on wide windows. Existing navigation-only scroll resets remain; data refresh does not add a new reset.
- The graph adapts its height to the window. The renderer continues to measure its container with ResizeObserver. The loading/error boxes use the same height contract.
- Existing `tab=overview` and scoped Facts URLs still work. During search, the compact selector shows Search results; selecting any store, including the previous one, returns to that view and clears search.

Graph rendering, data limits, stored-truth defaults, labeled inferred/semantic overlays, camera behavior, memory mutation semantics, and providers are unchanged. No personal memory or integration was modified.

## Verification

- Final production console build, including TypeScript: passed (`output/memory-workspace/graph-focus-build.log`). Existing large-bundle warnings remain. The initial build found an unused icon import; it was removed before the passing builds.
- 13 existing focused tests passed for auxiliary memory assistant state and honest unknown/error handling (`output/memory-workspace/graph-focus-tests.log`). No provider or live-memory calls in those tests.
- Independent source review found the compact selector search-return issue; it was corrected before browser verification. `git diff --check` passed.
- One static design scan reported only the incumbent Plus Jakarta Sans graph-tooltip font. It was retained as the product's existing identity, not changed to satisfy a generic font advisory. Receipt: `output/memory-workspace/graph-focus-design-detect.json`.

Browser verification used the actual production build at `http://127.0.0.1:58921/console/memory` and explicitly synthetic records. The fixture graph was corrected to the real API shape (106 nodes, 178 stored edges; labeled optional overlays). Only the fixture server was restarted; it does not proxy the live daemon.

First batch: 1440×900, 1024×768, and 720×645. The graph rendered without opening a disclosure, the second sidebar was absent, the companion started hidden, and no horizontal document overflow was observed. At 1440 the canvas region was 1144px wide. Ask draft text survived hide/reopen. Search results could return to the same view through the compact selector. A fact opened its inspector with correction/evidence controls. The content scrolled independently with navigation remaining at y=133.

One correction from that batch reduced the minimum/adaptive graph height for short windows. Final confirmation at 720×645 and 1440×900 passed: the compact graph stage ran from y=282.9 to y=619.9, including its caption, with controls visible and no horizontal document overflow. Final desktop graph remained the dominant surface. No browser mutation of personal data, no synthetic provider submission, and no new claim of polling/physical-device performance acceptance.

## Installed acceptance remains separate

Installed files were rechecked as version3.18.49, source153e0bdcc, clean, schema99, fingerprint235f3c7cfd7bff294bb0e4f94b54012737fc0e58c87687b8f814cdf792d31576. The daemon was not listening during the runtime check, so active provider configuration was unavailable. This task did not restart or hotpatch the installed app, and the UI fixture is not installed/live-home acceptance.

The integrating agent should rebuild/install the integrated candidate, verify served bytes, and inspect the desktop graph, view navigation, search-return, Ask hide/reopen, and fact inspector with named controlled records in the live home. Preserve personal memory and the other agents' work. No tag or release was created here.
