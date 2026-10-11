# Direct iPhone widget voice — 2026-10-11

Owner request: Talk and Dictate must start from the widget without navigating the full app. This extends native build14/a1660e9ce; it does not change personal Spaces or integrations.

## Implemented

Build15 uses iOS18+ AudioRecordingIntent/LiveActivityIntent in the app process. Both widget sizes expose Talk and Dictate. One-time foreground setup provisions native voice through the authenticated paired web page and requests microphone permission. Local device authentication may be required. URLs only navigate; they never record. iOS17 retains the existing open-app actions.

A visible Live Activity owns exact recording controls and a ten-minute session limit; each utterance is bounded to120seconds. Dictation retains an editable draft. Talk submits a normal voice chat, speaks only its exact committed public terminal, and resumes for completed answers or ordinary questions. Approval/control metadata requires opening the conversation. Native requireIdle fails closed before busy steering or typed controls. Existing web drafts are independent.

Native owns a separate P256 key and proof-bound session in device-only Keychain, bound to the same paired device revocation. Strict TLS pins the paired Mac through LAN or relay, with bounded HTTP framing and no ATS relaxation. No credentials/transcripts/audio enter the widget App Group. Signout/unpair synchronously fences credential saves and detaches state before asynchronous captured-file cleanup. Interrupted or uncertain requests preserve exact immutable retry bodies/keys; confirmed receipts consume their saved drafts. End/cancel, late audio callbacks, pairing changes, and background expiry are fenced. Background execution is bounded by iOS; long Mac tasks may require opening Clem to continue.

## Verification and integration

Mac/web support commit:7e4eba578e1af97afbe6033803ca9107f22bd287 (10 additive files). Authorized installer task “Audit Harness Speed and Token Usage” remains the sole Mac hotpatch/restart owner and received the exact handoff. Preserve its newer stable-root drafts, exact attempt controls, and withheld completion speech. Never install this lane’s older entire daemon over its candidate.

Focused backend/web tests:49 passed (36 session/enrollment/bridge,13 canonical-status/authenticated-route tests); zero provider calls. Mobile web build passed. Backend TypeScript compilation/emission passed, but the candidate fingerprint check correctly rejected concurrent native source edits; this lane’s dist is not an install candidate. The installer’s merged frozen build is authoritative.

Signed Simulator tests:65 passed on the final native source, including the synchronous signout fence; final rerun evidence is output/widget-capture-2026-10-11/native-tests-final.log. Unsigned runs failed existing Keychain fixtures and are not accepted evidence. Targeted render confirmation3/3 passed, with visual review of light/dark, default/xxxLarge, both widget sizes and Live Activity states. Large-type control truncation was corrected once and confirmed. Native iPhone build15 signed successfully and codesign deep/strict verification passed; final frozen build log is device-build-frozen.log in the same directory. Native implementation commit:192dfad7e6400e80a9b6f389f1e274077dac7630.

Installation and actual microphone/LAN/relay/locked-widget results must be recorded separately after they occur. Simulator rendering and source tests do not prove physical widget background recording. The matching Mac support installation is pending at this checkpoint. Its independent review found a preflight/current-head admission race; the sole installer owns the transactional requireIdle correction and exact native terminal binding review before installation. Request its minimal corrective delta for this lane after freeze. No personal data repairs, provider substitutions, live-home resets, or Mac restarts occurred in this lane.

At17:25Z, CoreDevice connected to Nate and immediately disconnected during the pre-install readback. No build15 installation occurred. The owner was asked to cable-connect/unlock the phone; that response is pending. Native build receipt is output/widget-capture-2026-10-11/native-build-receipt.json. Build14 remains the last previously verified phone installation.

## Physical acceptance

Open the updated paired app once and finish widget voice setup. On the Home Screen, tap Dictate, speak a short controlled phrase, finish it, and verify a saved editable draft without an automatic send. Tap Talk and verify the visible recording indicator, silence-to-send, exact reply playback, a second spoken turn, and End. Repeat from a locked device after its requested authentication. Test denied permission, Live Activities disabled, interrupted capture, an unavailable Mac, and an off-LAN paired relay. Verify another existing chat draft remains intact. Only these observed results establish physical acceptance.

Known bounded recovery limitation: a durable request receipt created just before a crash, without a bound admitted source, remains pending/fail-closed. This batch does not invent a second request to bypass that uncertainty.


## Installation update — October11,10:37PDT

Nate reconnected without another permission change. A fresh readback confirmed build14 before installation. The frozen native build15 installed successfully at10:36PDT and independent CoreDevice readback confirmed Clem0.1.0/build15 at10:37PDT. This is installation proof only; microphone capture, device widget execution, native enrollment and actual LAN/relay voice are still unverified. The matching Mac support installation remains in progress under the sole installer.

The installer’s minimal admission correction (SHA2568009213e9b2aaf2e3d638948ecf539259b9f74bf2e70e6e151c5c5e2db7b7ecc) was backported as f958410b3. It changes exactly four backend files and enforces idle/approval holds in the same current-head admission transaction while preserving exact-key replay. Our21focused route/selector/status tests passed, exit0; evidence: output/mobile-voice-2026-10-11/native-idle-admission-owner-patch-tests.log. No native source changed. A separate exact-terminal provenance delta is still requested from the installer for source parity.


## Current installed state — October 11, 10:42 PDT

Both support corrections are retained locally: f958410b3 (transactional idle admission, 21 tests passed) and a59edbf1b (exact committed request/attempt binding, 18 tests passed). The status patch applied verbatim, SHA256 bf1edcc0738210e020a3d91b0f9e970b4055d58817b93e3cf8f9a78d7c42f6ec. Native source/binary remains 192dfad7e, build 15, with 65 final signed Simulator tests passing.

The sole installer authenticated the running installed Mac at 17:40:44Z: fingerprint 31d9061cd3687b75276b9df1f03eb5970ee6ab4b0f6f7c3e5f9b48ca89e7b10d, schema 93, daemon b1746ca2-7360-4c13-ac55-00d45b93d5d1, started 2026-10-11T17:40:09.887Z from the installed Clementine.app entry. The UI lane read the serving receipt and independently checked that installed mobile asset main-C92Ito8m.js contains the native enrollment endpoint/readiness bridge. Claude OAuth brain/writer Opus 5.5 and judge Sonnet 5 were preserved by the installer. This lane performed no Mac restart/install.

Build 15 is installed and read back on Nate. CoreDevice attempted to open Clem at 10:42 PDT; iOS explicitly refused because the phone was locked. Native foreground enrollment, actual microphone capture, widget execution, and LAN/relay voice remain unverified. The owner must unlock the phone, open Clem once, then test Dictate/Talk from the Home Screen widget. Do not report physical capture as passed from source, rendered fixtures, app installation, or Mac serving identity alone. Broader recovered physical retry status also remains unqualified and fails closed.

The exact combined installation/readback/launch limits are recorded in output/widget-capture-2026-10-11/native-build-receipt.json. The earlier disconnected-phone and pending-Mac notes above are historical and superseded by this section.
