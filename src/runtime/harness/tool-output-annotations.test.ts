import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home = mkdtempSync(path.join(os.tmpdir(), 'clem-output-annotations-'));
process.env.CLEMENTINE_HOME = home;
const events = await import('./eventlog.js');
const { withToolOutputContext } = await import('./tool-output-context.js');
const { formatRecallableToolText, exactToolOutputForInvocation } = await import('./tool-output-format.js');
after(() => { events.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('host annotations share the JSON budget while exact raw bytes and idempotent rendering survive', async () => {
  const session = events.createSession({ kind: 'chat' });
  const context = { sessionId: session.id, callId: 'annotated-source', toolName: 'composio_execute_tool',
    settlementNonce: '33333333-3333-4333-8333-333333333333' };
  const original = JSON.stringify({ data: { items: Array.from({ length: 25 }, (_, i) => ({
    id: i, value: 2, zero: 0, absent: null, long: 'source text '.repeat(900),
  })) } });
  const annotation = '[account-route] Using the exact account frozen by the accepted host plan (ca_123456789012).';
  await withToolOutputContext(context, () => {
    const rendered = formatRecallableToolText(original, { maxChars: 20000, hostAnnotations: [annotation] });
    const parsed = JSON.parse(rendered);
    assert.ok(rendered.length <= 20000);
    assert.deepEqual(parsed.__clementine.hostAnnotations, [annotation]);
    assert.equal(parsed.__clementine.projection.clippedStrings > 0, true);
    assert.equal(exactToolOutputForInvocation({ ...context, compactResult: rendered }), original);
    assert.equal(formatRecallableToolText(rendered), rendered);
    const smaller = formatRecallableToolText(rendered, { maxChars: 4000 });
    assert.ok(smaller.length <= 4000); assert.deepEqual(JSON.parse(smaller).__clementine.hostAnnotations, [annotation]);
    assert.equal(exactToolOutputForInvocation({ ...context, compactResult: smaller }), original);
    assert.equal(events.getToolOutputForInvocation(session.id, context.callId, context.settlementNonce)?.output, original);
    for (const wrong of [{ ...context, settlementNonce: '44444444-4444-4444-8444-444444444444' }, { ...context, toolName: 'another_tool' }]) {
      assert.equal(exactToolOutputForInvocation({ ...wrong, compactResult: rendered }), rendered);
    }
    const forged = JSON.stringify({ data: { fabricated: true }, __clementine: { receipt: parsed.__clementine.receipt.replace(/sha256=[0-9a-f]{64}/, `sha256=${'0'.repeat(64)}`) } });
    assert.equal(exactToolOutputForInvocation({ ...context, compactResult: forged }), forged);
  });
});

test('a full fitting annotated result reports complete content and preserves actual null', async () => {
  const session = events.createSession({ kind: 'chat' });
  const context = { sessionId: session.id, callId: 'small-source', toolName: 'provider_read', settlementNonce: '55555555-5555-4555-8555-555555555555' };
  await withToolOutputContext(context, () => {
    const raw = JSON.stringify({ value: 2, absent: null });
    const rendered = formatRecallableToolText(raw, { hostAnnotations: ['Read from the selected account.'] });
    const parsed = JSON.parse(rendered);
    assert.equal(parsed.value, 2); assert.equal(parsed.absent, null); assert.equal(parsed.__clementine.truncated, false);
    assert.equal(exactToolOutputForInvocation({ ...context, compactResult: rendered }), raw);
  });
});
