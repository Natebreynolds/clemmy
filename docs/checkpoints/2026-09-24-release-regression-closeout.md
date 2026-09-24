# Release regression closeout — September 24

The owner prioritized main, the release tag, live workflow authoring/activation,
and a verified run of the existing Platform 49 workflow. Optional optimization
is stopped. Preserve the saved workflow's rules and independently check effects;
a terminal succeeded label is insufficient.

## Full-suite evidence

Clean bb13116fc, installed fingerprint
2a85448cd5125e2d25290630a0f1c13aaff2b4dae81317cebe3982d63011af0b,
completed the serialized isolated suite with the installed app stopped:
17,186 tests, 17,175 passed, five failed, six skipped, no cancellations,
3,153,328 ms. This is not a release pass. The five failures reproduced alone
at bb13116fc and all five passed alone at last tag v3.18.19 (8c11aa3c0).

- Three `production-mcp-read-carrier.test.ts` mixed-discovery cases:
  read, reacquired=false, mixed=true; both literalControls variants when
  retired=false and the retired=true variant.
- `tool-search-namespace-successor.test.ts`: unrelated lifecycle replacements
  do not precede a plain-language local operation.
- `tool-search-tool.test.ts`: first discovery preserves a proven ref when
  Composio fuzzy search and staging both wedge.

Full output and candidate metadata are preserved in the ignored
`output/release-candidate-bb13116/`. Attribution logs are
`/private/tmp/clem-five-failures-{bb13116,v31819}-alone.log`.

The full-suite live-home sentinel also reported a harness shared-memory file
change. Database, WAL, memory, authentication, and contract hashes were unchanged.
Readonly SQLite observations can update its shared-memory bookkeeping, but
the process responsible was not established. Do not call that a clean isolation
pass or dismiss it as proven harmless. Avoid live SQLite inspection during the
next isolated gate; retain the sentinel unchanged.

## Narrow corrections

The ranking adjustment had treated only the first verb as the operation's
purpose, so `append` on a spreadsheet outranked a local file tool whose opening
purpose is `Create, append to, or overwrite`. Recognize the initial action phrase
up to sentence/clause boundaries or an article introducing its object. Later
instructions about other operations remain ordinary searchable text. Ranking
remains advisory; no provider, tool, or model names are added to decisions.
The generic compound-purpose pin checks both candidate orders and retains both
tools. An intermediate whole-first-sentence variant broke reminder discovery;
it was rejected, and the original reminder/schema assertion passes unchanged.

Mixed MCP fixtures create both a broad and an exact manifest for one operation.
Their subsequent operation-name disclosure selected a different manifest than
the plan cited. The removed global-card refill had masked this inconsistency.
Disclose the exact observed manifest ID used by the plan and assert that the
returned reference is identical. Keep original transport execution, dependency,
literal-control, retirement, restart, and physical-call assertions. Do not
restore unrelated global catalog entries to the source's card.

The stalled-source fixture described its healthy operation only as "A separately
proven provider capability" and relied on provider score 1000 to surface it.
Give that fixture its actual read-record purpose. Keep the stalled source,
independent disclosure, deadline, exact returned reference, timeout report,
and no-pagination assertions. This does not claim vague provider metadata is
semantically understood or that source-supplied scores establish authority.

Targeted final catalog/discovery/relevance group: 87/87 passed. Full MCP file
passed within the earlier 94-test discovery run; that run's sole failure was the
intermediate reminder regression, subsequently corrected above. Typecheck passed (`/private/tmp/clem-release-closeout-typecheck.log`). The
new exact-commit full gate, installed live acceptance, journeys, packaging,
merge, and tagging remain required. No release is claimed here.

## Live acceptance and Windows

After rebuilding and hotpatching through the existing Terminal recipe, confirm
served fingerprint. Have Clem author, verify, enable, and run a named controlled
workflow. Then exercise the authorized existing Platform 49 workflow without
editing its definition: verify current headers and owned-cell limits, Slack
read-only behavior, incremental writes/deduplication, truthful report-back,
review verdict, exact settlements, and one terminal with no open owner.

Windows production signing secrets were absent at the last check. Do not bypass
the production signing gate or represent an unsigned private candidate as a
signed Windows release. Recheck availability before publication.
