import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { ChatMessage } from '@/lib/useChat';
import type { PendingActionExecutionPresentation } from '@clem/chat-engine';
const temporary = mkdtempSync(path.join(os.tmpdir(), 'clem-approval-result-render-'));
test.after(() => rmSync(temporary, { recursive: true, force: true }));
const consoleRoot = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = await build({
  stdin: { contents: `
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryRouter } from 'react-router-dom';
    import { ApprovalResult } from './src/components/chat/ApprovalResult';
    export function render(props) {
      const previous = globalThis.fetch;
      globalThis.fetch = () => { throw new Error('Rendering result history cannot request data or execute'); };
      try { return renderToStaticMarkup(<MemoryRouter><ApprovalResult {...props} /></MemoryRouter>); }
      finally { globalThis.fetch = previous; }
    }
  `, resolveDir: consoleRoot, loader: 'tsx', sourcefile: 'approval-result-render-fixture.tsx' },
  tsconfig: path.join(consoleRoot, 'tsconfig.json'), bundle: true, write: false, platform: 'node', format: 'cjs',
  jsx: 'automatic', target: 'node22', logLevel: 'silent',
});
const filename = path.join(temporary, 'render.cjs');
writeFileSync(filename, bundle.outputFiles[0]!.contents);
const { render } = createRequire(import.meta.url)(filename) as {
  render(props: { approval: NonNullable<ChatMessage['approval']>; observed?: PendingActionExecutionPresentation }): string;
};
const record = { id: 'pa-render', approvalId: 'apr-render', payloadHash: 'a'.repeat(16), updatedAt: '2026-10-19T12:00:00.000Z',
  status: 'executing', resultSummary: 'Raw <fixture> evidence.' };
const approval: NonNullable<ChatMessage['approval']> = { subject: 'Controlled fixture', approvalId: record.approvalId,
  ownerSessionId: 'raw-owning-session', pendingActionId: record.id, payloadHash: record.payloadHash,
  recordUpdatedAt: record.updatedAt, resultRecord: record, resolution: 'cancelled' };

test('closed question keeps known running action truth and offers no approval or execution control', () => {
  const html = render({ approval });
  assert.match(html, /Approval closed/);
  assert.match(html, /Running/);
  assert.match(html, /Execution details/);
  assert.match(html, /Raw &lt;fixture&gt; evidence/);
  assert.match(html, /Refresh result/);
  assert.doesNotMatch(html, />Approve<|>Decline<|Execute queued action|Edit by hand|nothing ran/i);
});

test('locally observed uncertainty survives closed approval props with no settled record', () => {
  const html = render({ approval: { ...approval, resultRecord: undefined }, observed: {
    mode: 'durable', phase: 'uncertain', note: 'Exact executor outcome is uncertain.',
  } });
  assert.match(html, /Outcome not confirmed/);
  assert.match(html, /Exact executor outcome is uncertain/);
  assert.doesNotMatch(html, /nothing ran|>Approve<|Execute queued action/i);
});

test('newer compatible full action evidence wins over an earlier captured waiting result', () => {
  const full = { ...record, status: 'executed', updatedAt: '2026-10-19T12:00:01.000Z', resultSummary: 'Completed raw evidence.',
    title: 'fixture', summary: '', kind: 'shell_command', toolName: 'run_shell_command', targetSummary: '', preview: '', risk: '', rollback: '',
    payload: {}, idempotencyKey: 'fixture', createdAt: record.updatedAt };
  const html = render({ approval: { ...approval, resultRecord: { ...record, status: 'approval_requested' }, pendingAction: full, resolution: 'approved' } });
  assert.match(html, /Action completed/);
  assert.match(html, /Completed raw evidence/);
  assert.doesNotMatch(html, /Running<|Waiting to run/);
});

test('legacy slim closed history does not pretend an action finished or borrow a current execution session', () => {
  const html = render({ approval: { subject: 'Legacy fixture', approvalId: 'apr-legacy', resolution: 'cancelled' } });
  assert.match(html, /Approval closed/);
  assert.doesNotMatch(html, /Refresh result|Action completed|nothing ran|>Approve</i);
});

test('authored result wording enriches the same closed card and preserves execution details without live buttons', () => {
  const settled = { ...record, status: 'executed', publicResult: {
    version: 1 as const, pendingActionId: record.id, approvalId: record.approvalId, payloadHash: record.payloadHash,
    recordUpdatedAt: record.updatedAt, status: 'executed' as const, source: 'authored_projection' as const,
    text: 'I completed the approved action. You can see the recorded result below.',
    terminal: { eventId: 'canonical-result-terminal', sourceUserSeq: 48 },
    projection: { id: 'projection-render-fixture', revision: 1 as const, evidenceDigest: 'a'.repeat(64), textDigest: 'b'.repeat(64), publishedAt: record.updatedAt },
  } };
  const html = render({ approval: { ...approval, resultRecord: settled, resolution: 'approved' } });
  assert.match(html, /I completed the approved action/);
  assert.match(html, /Raw &lt;fixture&gt; evidence/);
  assert.doesNotMatch(html, />Approve<|>Decline<|Execute queued action|Edit by hand/);
});
