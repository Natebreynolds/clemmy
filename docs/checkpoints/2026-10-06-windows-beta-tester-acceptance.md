# Windows x64 beta: installation and live acceptance

Owner decision: an Intel/AMD x64 tester installs the beta and sends evidence. Cover Claude OAuth, Codex OAuth and a BYO API key before calling those connections accepted. This is shared framework validation; use new, named test projects and synthetic files. Do not repair or migrate business content.

## Delivery status

The Windows corrections are being prepared from main `1a6810d7aaeb3d00996228f37ff4ff3af921e599` in the separate `windows-beta-readiness` checkout. No Windows installer from this candidate has been built or accepted yet. The candidate version proposed for the Windows build is `3.18.29-windows.1`; the receipt must record its actual source commit, fingerprint, installer SHA-256 and served build identity.

A successful Mac test is preparation evidence. Windows CI must use the actual installer, complete first launch through the real setup window, load the dashboard, persist synthetic work through production APIs and restart. CI uses no model accounts or paid providers. Those checks establish installation and fixture behavior only; the tester's Windows app must provide live model and Browserbase acceptance.

This repository is public. Candidate branches and Actions artifacts are not an access-private distribution channel. The beta workflow does not publish a GitHub Release or update the public release feed. Upload only synthetic qualification receipts. The owner can download a qualified installer and give it to the tester through their chosen channel.

## Tester setup

1. Record the Windows version, Intel/AMD x64 architecture, installer filename and app version. Use the supplied SHA-256 to check that it is the qualified installer.
2. Install into the ordinary user account and launch from the installed app. Record any Windows security message exactly. If Windows policy refuses the unsigned installer, stop and report it; do not disable security protections.
3. Complete setup normally. Claude can be connected afterwards in **Settings → Models & routing**. Use Clementine's own Claude and Codex sign-in controls, and its BYO provider form. A separate terminal login does not prove Clem owns or serves that account.
4. Keep the chosen connection and model explicit for each run. Record a non-secret account label, provider and selected model. Do not share API keys or OAuth credentials. If a provider renames a model, record the requested and actually served identifiers; a known approved alias needs explicit attribution.
5. For Browserbase, use **Connect** and its Browserbase connection card. Configure the tester's own API key and project. Local Chrome backend installation remains a separate Windows path with its own first-use acceptance; Browserbase acceptance cannot establish local Chrome acceptance.

## Short live acceptance sequence

Repeat the same sequence for each connection family, with a distinct new project such as `Windows beta — Claude`, `Windows beta — Codex`, or `Windows beta — BYO`. Avoid concurrent tests while recording this sequence. Stop at the first failure and capture its evidence before trying again.

| Check | Controlled action | Pass evidence |
| --- | --- | --- |
| First real turn | Ask Clem to state which named test project is active, then create `pilot.txt` with exactly `first draft\n` and read it back. | Correct project; exact file content; a completed turn from the chosen provider. |
| Confirmation once | Ask: “Ask me before replacing pilot.txt. After I answer yes, replace it with exactly `confirmed draft\n`, read it back and report the result.” Reply **yes** once. | One useful question, one answer accepted, one replacement, exact readback; no repeat question or unexplained stop. |
| Project continuity | In the same project, ask for `summary.txt` describing the verified content of `pilot.txt`. Then switch to a second test project and ask what files are available there. | Correct project boundaries and use of verified prior work; no borrowed first-project context presented as second-project evidence. |
| Browserbase | Ask Clem to open `https://example.com` and read its page heading. Use the Browser panel to watch, take control, and return control to Clem. Ask her to read the heading again after the handoff. | Visible preview while Clem works, working user control, one owned session, successful resume and correct heading. An open-session card alone is insufficient. |
| Clear pause and restart | Ask Clem to prepare a draft and ask whether to save it. While the question is pending and no task is running, quit Clementine from its tray menu, relaunch, and answer the pending question once. | Conversation and pending decision retained; correct continuation; one saved file and readback; no duplicate effects. |
| Durable result | Quit once all work is idle and relaunch again. Open the same project and conversation, and verify the completed files. | Saved work and conversation survive; dashboard loads; the selected connection remains usable for a new readback turn. |

A saved/requested model label or “did the work” label does not independently prove the provider served that model/account. Review the retained run provenance, provider response identity, selected grant and judge verdict. A fallback model, successful save of a failure report, failed-open judge, or component simulation is not a pass for the requested connection. OAuth refresh after genuine expiry remains pending until observed; do not fake expiry by editing the user's auth files.

## Evidence to send when something fails

Send the app version, Windows version, chosen connection/model, test-project name, exact prompt and confirmation, approximate local time and timezone, last visible status, and a screenshot of the failure. Open **Trace Lab** if available and include the displayed session ID and relevant timeline entries. Its **Copy** control copies a replay prompt, not a full trace export; the current Diagnostics screen has no export button.

If startup itself fails, the installed app's tray menu has **Open Log File**. The normal supervisor log is `%USERPROFILE%\.clementine-next\logs\desktop\supervisor.log`. Share only the small relevant time range after checking it for credentials, private content and capability URLs. Never send the secrets vault, `auth.json`, environment files or the full personal database. Do not reset the home to get a cleaner result.

Do not retry a hung action repeatedly: preserve the first failure, whether any file/effect already succeeded, and the next action the UI asks for. That distinguishes a transport failure from lost confirmation, wrong ownership, or a duplicate-effect bug.

## Qualification record

| Connection | Selected and served model/account reviewed | Project write/read | Confirmation | Browser preview/control/resume | Restart/durability | Live judge acceptance |
| --- | --- | --- | --- | --- | --- | --- |
| Claude OAuth | Pending | Pending | Pending | Pending | Pending | Pending |
| Codex OAuth | Pending | Pending | Pending | Pending | Pending | Pending |
| BYO API key | Pending | Pending | Pending | Pending | Pending | Pending |

No Windows end-to-end acceptance, all-model claim or speed/cost improvement is established by this document. Record exact delivered and served identities before updating these statuses.

## Additional feature acceptance

After the short connection sequence succeeds, use a new `Windows beta — features` project and synthetic content. Record each result independently; skip hardware/account-dependent features explicitly instead of marking them passed.

| Feature | Tester action | Required result |
| --- | --- | --- |
| Specialist | Save a specialist with an explicit model/connection, ask it to create a small report from a supplied brief, then request one correction. | Correct role/project, requested and served model/account agree, useful completion evidence, no repeated question or unexplained stop. |
| Computer tools | Create/read/edit a file under a spaced Unicode test path; run a harmless directory/Git check; cancel an owned long-running test command. | Exact bytes and correct path, working command tools, bounded cleanup and clear next action. These tools do not imply arbitrary desktop mouse/keyboard control. |
| Documents | Produce a simple DOCX with a heading, list, Unicode and table; open it in the default document reader. Produce a PDF of the same content. | Both artifacts open correctly, content/formatting retained, visible refusal for unsupported layout rather than a false success. |
| Attachments | Upload a synthetic DOCX/PDF and ask Clem to read, summarize and answer an exact text question. Repeat after restart. | First-use dependency setup succeeds, warmed conversion works, answers use the real content. |
| Local browser | Install the local browser backend through its Connect controls, open a harmless page and generate a local page preview. | Actual browser/CDP works; visible correct preview and owned control. Record separately from Browserbase. |
| Phone | Pair a phone normally and repeat a small file/question/browser handoff through the phone. | Correct TLS pin, usable access through the actual LAN or relay, retained pairing after idle desktop restart. |
| Voice | Record a short synthetic phrase, submit it and verify the transcription. | Microphone permission, capture and actual local transcription work. |
| Meetings | With the tester's configured meeting connection, capture a consented synthetic meeting sample and open its transcript. | Native capture starts/stops cleanly and retained transcript is accessible. |
| Background/schedule | Schedule a named harmless test reminder/file task; let it run and inspect the result. Stop a second owned test while it waits. | One effect at the expected time, correct ownership and a clear stopped/pending status. |
| MCP/skills | Connect a harmless read-only test MCP and run one known tool; acquire and use one reviewed skill in the test project. | Real transport/tool execution, correct connection and scope, actual output and clear failure/recovery. |

Do not treat an unavailable optional dependency as a successful check. Preserve the first failure and its existing successful effects. Genuine OAuth refresh, power-loss durability and arbitrary desktop GUI control are not established by this sequence.
