# Phone UI polish — 2026-10-21

Follow-up to [mobile adaptive layout](2026-10-21-mobile-adaptive-handoff.md). The owner asked for everyday phone styling before additional Duo work. This is a source candidate; rendered and installed-iPhone acceptance remains outstanding.

## Integration

- Branch: `codex/mobile-adaptive-2026-10-21`.
- Worktree: `~/.codex/worktrees/mobile-adaptive/clementine-next`.
- Parent: `c3ce8cd0f`.
- Integrating peer rechecked clean at `6a22f36ff` on `claude/r45-efficiency`; it already includes the preceding mobile commits and the separate Memory work.
- Apply only this follow-up commit to the current integration tree. No restart, installed hotpatch, release/tag, native packaging, provider request, or live-data modification was performed here.

## Changes

- Screen, conversation, and shared sheet headings use one rem-based toolbar size and a quieter 650 weight. Existing warm colors and system fonts remain.
- Header circles use a soft background instead of individual borders and shadows. Navigation retains its 44px controls and existing destinations.
- Conversation-list names can occupy two lines. Agent/project and outcome metadata wraps instead of disappearing at the edge; More and swipe behavior remain in place.
- Shared sheet header actions use the same quiet treatment. Attach now has a visible heading and Done button outside its scrolling body.
- File actions and toolbars wrap at narrow widths. File metadata is more readable; revision, error, permission, download, and Ask Clem behavior is preserved.
- Idle Talk to Clem uses secondary ink; active voice retains the orange state. Keyboard focus remains visible, and touch no longer inherits its hover background.

This does not change widget connection, microphone ownership, Send/Stop logic, keyboard geometry, or native layout. The previous composer fix remains a dependency. No new dependency or extra overriding stylesheet was introduced.

## Evidence and remaining acceptance

- Production build (TypeScript, service worker, Vite) passed: `output/mobile-adaptive/polish-build.log`. Existing >500kB bundle advisory remains.
- `git diff --check` passed. Independent source review found no blocking cascade, wrapping, or control-access defects.
- One static design scan reported four pre-existing findings outside the edited rules: work-status gradient text and width/height transitions. Recorded in `output/mobile-adaptive/polish-design-detect.json`; not claimed as a clean scan or expanded into an unrelated animation rewrite.
- No tests were added for CSS-only presentation and the attachment sheet's direct close action. The prior behavior tests are documented in the adaptive handoff; they were not rerun or represented as visual evidence.
- UI inspection again reported that the Mac was locked. Browser/WebKit rendering, VoiceOver, Dynamic Type, touch feel, actual iPhone keyboard behavior, and installed/live-home acceptance were not performed.

The existing loopback fixture at `http://127.0.0.1:58931/m/?tab=chats` serves the freshly built candidate. It uses synthetic in-memory data, not the live home, and cannot validate microphone capture. Before release, inspect compact phone and short landscape layouts with long conversation/file names, larger text, keyboard open, Attach/Done, Files/Download/Ask Clem, and active/error voice states. Confirm control access and focus return in the installed app with named controlled records; preserve personal data.

Next design priorities after this candidate: real-device keyboard and transition reliability; consistent loading/offline/retry treatment; useful artifact previews with stable actions; restrained, meaningful native haptics. Additional fold-specific work stays deferred until this phone baseline is accepted.
