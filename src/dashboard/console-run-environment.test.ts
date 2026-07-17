import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderConsoleHtml } from './console.js';

test('desktop console exposes a global run environment rail with responsive modal accessibility', () => {
  const html = renderConsoleHtml('test-token');

  assert.match(html, /data-run-environment-toggle/);
  assert.match(html, /aria-controls="run-environment-drawer"/);
  assert.match(html, /id="run-environment-drawer"[^>]*data-run-environment-drawer hidden/);
  assert.match(html, /id="run-environment-drawer"[^>]*role="complementary"/);
  assert.doesNotMatch(html, /id="run-environment-drawer"[^>]*aria-modal/);
  assert.match(html, /data-run-environment-backdrop hidden/);
  assert.match(html, /setAttribute\('role', modal \? 'dialog' : 'complementary'\)/);
  assert.match(html, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(html, /event\.key !== 'Tab' \|\| !isRunEnvironmentModal\(\)/);
  assert.match(html, /data-run-environment-status aria-live="polite"/);
  assert.doesNotMatch(html, /data-run-environment-body aria-live=/);
  assert.match(html, /Environment \/ run/);
  assert.match(html, />Plan</);
  assert.match(html, />Helpers</);
  assert.match(html, /Tools &amp; resources/);
  assert.match(html, /<details class="run-env-section"/);
  assert.match(html, /<summary class="run-env-section-head"><span>Details/);
  assert.match(html, /data-run-environment-close/);
  assert.match(html, /data-run-environment-footer hidden/);
});

test('run drawer consumes the compact scoped contract and labels evidence honestly', () => {
  const html = renderConsoleHtml('test-token');

  assert.match(html, /\?view=environment/);
  assert.match(html, /run\.toolSummary/);
  assert.match(html, /countsByName/);
  assert.match(html, /runEnvironmentMeta/);
  assert.match(html, /projectionEventsOmitted/);
  assert.match(html, /artifactsOmitted/);
  assert.match(html, /artifactCoverageStatus === 'unavailable'/);
  assert.match(html, /additional tool name/);
  assert.match(html, /count > 1 \? ' ' \+ count \+ '×'/);
  assert.match(html, /canonicalCallId/);
  assert.match(html, /logical call/);
  assert.match(html, /recorded call event/);
  assert.match(html, /transport_mirror/);
  assert.match(html, /transport mirror event/);

  // Durable artifact rows are presented as authority. URLs/files inferred
  // from event text remain explicitly weaker evidence and render afterward.
  const ledger = html.indexOf('Artifact ledger');
  const observed = html.indexOf('Observed references');
  assert.ok(ledger > 0);
  assert.ok(observed > ledger);
  assert.match(html, /Array\.isArray\(run\.artifacts\)/);
  assert.match(html, /artifact\.bindingVerifiedAt/);
  assert.match(html, /provider verified/);
  assert.match(html, /resource found · verification pending/);
  assert.match(html, /outcome uncertain/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test('run drawer only offers controls backed by exact server-projected endpoints', () => {
  const html = renderConsoleHtml('test-token');

  assert.match(html, /function isRunCancellable\(run\)/);
  assert.match(html, /run\.canCancel === true/);
  assert.match(html, /run\.cancelEndpoint/);
  assert.match(html, /function isRunBackgroundable\(run\)/);
  assert.match(html, /run\.canBackground === true/);
  assert.match(html, /run\.backgroundEndpoint/);
  assert.match(html, /data-run-env-action="cancel"/);
  assert.match(html, /data-run-env-action="background"/);
  assert.doesNotMatch(html, /harness-sessions\/' \+ encodeURIComponent\(run\.id\) \+ '\/cancel/);
  assert.doesNotMatch(html, /api\/runs\/' \+ encodeURIComponent\(run\.id\) \+ '\/cancel/);
});

test('legacy chat Stop carries the exact attempt projected by the accepted 202', () => {
  const html = renderConsoleHtml('test-token');

  assert.match(html, /let __activeHarnessAttempt = null/);
  assert.match(html, /cancelPendingHarnessRequest\(attempt\)/);
  assert.match(html, /postHarnessControlWithRetry\(/);
  assert.match(html, /'\/api\/harness\/chat\/cancel'/);
  assert.match(html, /clientRequestId: attempt\.clientRequestId/);
  assert.match(html, /attemptControl\.cancelEndpoint = typeof body\.cancelEndpoint/);
  assert.match(html, /cancelAcceptedHarnessAttempt\(attemptControl\)/);
  assert.match(html, /data-home-harness-cancel-endpoint/);
  assert.doesNotMatch(
    html,
    /cancelActiveHarnessTurn\(\)[\s\S]{0,1200}fetchWithToken\('\/api\/console\/harness-sessions\/' \+ encodeURIComponent\(sid\) \+ '\/cancel'/,
    'the composer must not fall back to a reusable session-only kill',
  );
});

test('legacy chat retains one request identity across an ambiguous lost-202 retry', () => {
  const html = renderConsoleHtml('test-token');
  const start = html.indexOf('// BEGIN harness request identity helpers');
  const end = html.indexOf('// END harness request identity helpers');
  assert.ok(start >= 0 && end > start, 'request identity helpers are embedded in the client');
  const helperSource = html.slice(start, end);
  const ids = ['request-1', 'request-2', 'request-3'];
  const context = vm.createContext({
    crypto: { randomUUID: () => ids.shift() },
  });
  new vm.Script(`${helperSource}
    const first = acquireHarnessChatRequest('create it', ['attachment-1'], null);
    const lost202BeforeAck = acquireHarnessChatRequest('create it', [], null);
    updateRetryableHarnessChatSession(first.clientRequestId, 'server-session-after-202');
    const lostStreamRetry = acquireHarnessChatRequest('create it', [], 'server-session-after-202');
    const changedSession = acquireHarnessChatRequest('create it', [], 'different-thread');
    clearRetryableHarnessChatRequest(changedSession.clientRequestId);
    const afterTerminal = acquireHarnessChatRequest('create it', [], 'different-thread');
    globalThis.result = { first, lost202BeforeAck, lostStreamRetry, changedSession, afterTerminal };
  `).runInContext(context);
  const result = context.result as {
    first: { clientRequestId: string; attachments: string[]; reused: boolean; sessionId: string | null };
    lost202BeforeAck: { clientRequestId: string; attachments: string[]; reused: boolean; sessionId: string | null };
    lostStreamRetry: { clientRequestId: string; attachments: string[]; reused: boolean; sessionId: string | null };
    changedSession: { clientRequestId: string; reused: boolean };
    afterTerminal: { clientRequestId: string; reused: boolean };
  };
  assert.equal(result.first.clientRequestId, 'request-1');
  assert.equal(result.lost202BeforeAck.clientRequestId, 'request-1');
  assert.equal(result.lostStreamRetry.clientRequestId, 'request-1');
  assert.equal(result.lostStreamRetry.reused, true);
  assert.deepEqual(Array.from(result.lostStreamRetry.attachments), ['attachment-1']);
  assert.equal(result.lostStreamRetry.sessionId, 'server-session-after-202');
  assert.equal(result.changedSession.clientRequestId, 'request-2', 'same text in another thread is new work');
  assert.equal(result.afterTerminal.clientRequestId, 'request-3');

  assert.match(html, /r\.status >= 400 && r\.status < 500\) clearRetryableHarnessChatRequest\(clientRequestId\)/);
  assert.match(html, /!attemptControl\.stopped && \(!streamResult \|\| streamResult\.ok !== false\)/);
  assert.match(html, /attachments: requestIdentity\.attachments/);
});

test('approval resume binds its request id before exposing the Stop control', () => {
  const html = renderConsoleHtml('test-token');
  const start = html.indexOf('async function resumeHarnessApprovalFromButton');
  const end = html.indexOf('function setChatTurnStatus', start);
  assert.ok(start >= 0 && end > start);
  const resume = html.slice(start, end);
  const acquire = resume.indexOf('const requestIdentity = acquireHarnessChatRequest(input, [], sessionId)');
  const requestId = resume.indexOf('const clientRequestId = requestIdentity.clientRequestId');
  const bind = resume.indexOf('__activeHarnessAttempt = attemptControl');
  const exposeStop = resume.indexOf('const thinkTimer = startThinkingButton(send)');
  const dispatch = resume.indexOf("fetchWithToken('/api/harness/chat'");
  assert.ok(acquire >= 0 && acquire < requestId && requestId < bind && bind < exposeStop && exposeStop < dispatch);
  assert.match(resume, /stopped: false,\s+clientRequestId,/);
  assert.match(resume, /cancelRequestPromise: null,\s+cancelRequestConfirmed: false,/);
  assert.match(resume, /if \(attemptControl\.stopped\) return;/);
  assert.match(resume, /r\.status >= 400 && r\.status < 500\) clearRetryableHarnessChatRequest\(clientRequestId\)/);
  assert.match(resume, /updateRetryableHarnessChatSession\(clientRequestId, body\.sessionId \|\| sessionId\)/);
  assert.match(resume, /!attemptControl\.stopped && \(!streamResult \|\| streamResult\.ok !== false\)/);
});

test('run drawer pins its selected run and preserves completed output while polling', () => {
  const html = renderConsoleHtml('test-token');

  assert.match(html, /let runEnvironmentPinnedRunId = null/);
  assert.match(html, /if \(selected\) runEnvironmentPinnedRunId = selected\.id/);
  assert.match(html, /runEnvironmentCurrentRun && runEnvironmentCurrentRun\.id === candidate\.id/);
  assert.match(html, /if \(!candidate\.live && runEnvironmentCurrentRun/);
  assert.match(html, /Live refresh paused; last loaded run context remains visible/);
  assert.match(html, /runEnvironmentReturnFocus/);
  assert.match(html, /run\.runEnvironmentMeta && run\.runEnvironmentMeta\.scopeStartedAt/);
});

test('run environment inline client script compiles', () => {
  const html = renderConsoleHtml('test-token');
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1])
    .filter((script) => script.trim());

  assert.ok(scripts.length > 0);
  scripts.forEach((script, index) => {
    new vm.Script(script, { filename: `console-run-environment-${index}.js` });
  });
});
