import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkspaceRpcBootstrapEvent,
  parseWorkspaceRpcEvent,
  parseWorkspaceRpcRequest,
  workspaceRpcCorrelation,
  workspaceRpcFailure,
  workspaceRpcOpAllowed,
  workspaceRpcSuccess,
  WORKSPACE_IFRAME_SANDBOX,
  WORKSPACE_RPC_CHANNEL,
} from './workspace-rpc';

const source = {};

function event(data: unknown, overrides: { source?: unknown; origin?: string } = {}) {
  return {
    data,
    source: Object.prototype.hasOwnProperty.call(overrides, 'source') ? overrides.source : source,
    origin: overrides.origin ?? 'null',
  };
}

function request(op: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    channel: WORKSPACE_RPC_CHANNEL,
    version: 1,
    kind: 'request',
    workspaceId: 'social-calendar',
    id: 'req_123',
    op,
    payload,
    ...overrides,
  };
}

test('Workspace iframe privilege is exactly scripts in an opaque origin', () => {
  assert.equal(WORKSPACE_IFRAME_SANDBOX, 'allow-scripts');
  assert.doesNotMatch(WORKSPACE_IFRAME_SANDBOX, /same-origin|forms|popups|top-navigation/);
});

test('Workspace RPC accepts a well-formed request from only the expected opaque frame', () => {
  const parsed = parseWorkspaceRpcEvent(
    event(request('action', { actionId: 'approve-post', args: { postId: 'p1' } })),
    source,
    'social-calendar',
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.request.op, 'action');
  assert.deepEqual(parsed.request.payload, { actionId: 'approve-post', args: { postId: 'p1' } });
});

test('Workspace RPC bootstraps one opaque document identity before moving requests onto its port', () => {
  const bootstrap = parseWorkspaceRpcBootstrapEvent(
    event({
      channel: WORKSPACE_RPC_CHANNEL,
      version: 1,
      kind: 'bootstrap',
      workspaceId: 'social-calendar',
      documentId: 'doc_7QY6nP',
    }),
    source,
    'social-calendar',
  );
  assert.deepEqual(bootstrap, {
    ok: true,
    bootstrap: {
      channel: WORKSPACE_RPC_CHANNEL,
      version: 1,
      kind: 'bootstrap',
      workspaceId: 'social-calendar',
      documentId: 'doc_7QY6nP',
    },
  });

  const overPort = parseWorkspaceRpcRequest(
    request('data', {}),
    'social-calendar',
  );
  assert.equal(overPort.ok, true);
});

test('Workspace RPC accepts the bridge\'s optional undefined fields without broadening their schema', () => {
  const note = parseWorkspaceRpcEvent(
    event(request('note', { text: 'Looks good', kind: undefined, meta: undefined })),
    source,
    'social-calendar',
  );
  assert.equal(note.ok, true);
  const compose = parseWorkspaceRpcEvent(
    event(request('compose', { instructions: 'Draft this', context: undefined, maxChars: undefined })),
    source,
    'social-calendar',
  );
  assert.equal(compose.ok, true);
});

test('Workspace RPC rejects sibling, same-origin, and cross-workspace confused-deputy messages', () => {
  assert.deepEqual(
    parseWorkspaceRpcEvent(event(request('data', {}), { source: {} }), source, 'social-calendar'),
    { ok: false, reason: 'wrong_source' },
  );
  assert.deepEqual(
    parseWorkspaceRpcEvent(event(request('data', {}), { origin: 'http://127.0.0.1:8520' }), source, 'social-calendar'),
    { ok: false, reason: 'non_opaque_origin' },
  );
  assert.deepEqual(
    parseWorkspaceRpcEvent(event(request('data', {}, { workspaceId: 'executive-board' })), source, 'social-calendar'),
    { ok: false, reason: 'wrong_workspace' },
  );
});

test('Workspace RPC rejects unknown operations, malformed ids, extra authority fields, and oversized/cyclic payloads', () => {
  assert.deepEqual(
    parseWorkspaceRpcEvent(event(request('adminFetch', { url: '/api/console/approvals' })), source, 'social-calendar'),
    { ok: false, reason: 'invalid_operation' },
  );
  assert.deepEqual(
    parseWorkspaceRpcEvent(event(request('data', {}, { id: '../approve' })), source, 'social-calendar'),
    { ok: false, reason: 'invalid_id' },
  );
  assert.deepEqual(
    parseWorkspaceRpcEvent(
      event(request('action', { actionId: 'send', args: {}, workspaceId: 'other' })),
      source,
      'social-calendar',
    ),
    { ok: false, reason: 'invalid_payload' },
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.deepEqual(
    parseWorkspaceRpcEvent(event(request('note', { text: 'x', meta: cyclic })), source, 'social-calendar'),
    { ok: false, reason: 'invalid_payload' },
  );
  assert.deepEqual(
    parseWorkspaceRpcEvent(
      event(request('compose', { instructions: 'x', context: 'z'.repeat(100_001) })),
      source,
      'social-calendar',
    ),
    { ok: false, reason: 'invalid_payload' },
  );
});

test('a document-pinned port can correlate malformed requests for an immediate failure response', () => {
  const malformed = request('compose', { instructions: '' });
  assert.deepEqual(
    parseWorkspaceRpcRequest(malformed, 'social-calendar'),
    { ok: false, reason: 'invalid_payload' },
  );
  assert.deepEqual(workspaceRpcCorrelation(malformed, 'social-calendar'), {
    workspaceId: 'social-calendar',
    id: 'req_123',
  });
  assert.equal(
    workspaceRpcCorrelation({ ...malformed, workspaceId: 'other' }, 'social-calendar'),
    null,
  );
});

test('trusted-click bridge operations are narrow and payload bounded', () => {
  assert.equal(
    parseWorkspaceRpcRequest(
      request('open_external', { url: 'https://example.com/evidence' }),
      'social-calendar',
    ).ok,
    true,
  );
  assert.equal(
    parseWorkspaceRpcRequest(
      request('download', { filename: 'post.svg', dataUrl: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E' }),
      'social-calendar',
    ).ok,
    true,
  );
  assert.deepEqual(
    parseWorkspaceRpcRequest(
      request('open_external', { url: 'javascript:alert(1)' }),
      'social-calendar',
    ),
    { ok: false, reason: 'invalid_payload' },
  );
  assert.deepEqual(
    parseWorkspaceRpcRequest(
      request('download', { filename: '../escape.svg', dataUrl: 'data:image/svg+xml,%3Csvg%2F%3E' }),
      'social-calendar',
    ),
    { ok: false, reason: 'invalid_payload' },
  );
});

test('gallery policy is read-only while the full Workspace retains fixed bridge operations', () => {
  assert.equal(workspaceRpcOpAllowed('data', true), true);
  for (const op of ['refresh', 'note', 'compose', 'action', 'open_external', 'download'] as const) {
    assert.equal(workspaceRpcOpAllowed(op, true), false, `${op} must be denied in a gallery preview`);
    assert.equal(workspaceRpcOpAllowed(op, false), true, `${op} remains available in the full Workspace`);
  }
});

test('Workspace RPC responses preserve the scoped correlation fields and bound errors', () => {
  const parsed = parseWorkspaceRpcEvent(event(request('data', {})), source, 'social-calendar');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(workspaceRpcSuccess(parsed.request, { rows: [] }), {
    channel: WORKSPACE_RPC_CHANNEL,
    version: 1,
    kind: 'response',
    workspaceId: 'social-calendar',
    id: 'req_123',
    ok: true,
    result: { rows: [] },
  });
  const failure = workspaceRpcFailure(parsed.request, 'x'.repeat(2_000));
  assert.equal(failure.workspaceId, 'social-calendar');
  assert.equal(failure.id, 'req_123');
  assert.equal(failure.error.length, 1_000);
});
