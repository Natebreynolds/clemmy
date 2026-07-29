import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkspaceGestureRequest,
  parseWorkspaceRpcBootstrapEvent,
  parseWorkspaceRpcEvent,
  parseWorkspaceRpcRequest,
  workspaceGestureAllowed,
  workspaceRpcCorrelation,
  workspaceRpcFailure,
  workspaceRpcOpAllowed,
  workspaceRpcSuccess,
  WORKSPACE_IFRAME_SANDBOX,
  WORKSPACE_GESTURE_CHANNEL,
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

function gesture(op: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    channel: WORKSPACE_GESTURE_CHANNEL,
    version: 1,
    kind: 'gesture',
    workspaceId: 'social-calendar',
    documentId: 'doc_7QY6nP',
    id: 'gesture_123',
    op,
    payload,
    ...overrides,
  };
}

test('Workspace iframe privilege is exactly scripts in an opaque origin', () => {
  assert.equal(WORKSPACE_IFRAME_SANDBOX, 'allow-scripts');
  assert.doesNotMatch(WORKSPACE_IFRAME_SANDBOX, /same-origin|forms|popups|top-navigation/);
});

test('normal RPC and trusted gestures use distinct literal protocol channels', () => {
  assert.equal(WORKSPACE_RPC_CHANNEL, 'clementine.workspace.rpc.v1');
  assert.equal(WORKSPACE_GESTURE_CHANNEL, 'clementine.workspace.gesture.v1');
  assert.equal(
    parseWorkspaceRpcRequest({
      channel: 'clementine.workspace.rpc.v1',
      version: 1,
      kind: 'request',
      workspaceId: 'social-calendar',
      id: 'literal_rpc',
      op: 'data',
      payload: {},
    }, 'social-calendar').ok,
    true,
  );
  assert.equal(
    parseWorkspaceGestureRequest({
      channel: 'clementine.workspace.gesture.v1',
      version: 1,
      kind: 'gesture',
      workspaceId: 'social-calendar',
      documentId: 'doc_7QY6nP',
      id: 'literal_gesture',
      op: 'open_external',
      payload: { url: 'https://example.com/evidence' },
    }, 'social-calendar', 'doc_7QY6nP').ok,
    true,
  );
  assert.deepEqual(
    parseWorkspaceRpcRequest({
      channel: 'clementine.workspace.gesture.v1',
      version: 1,
      kind: 'request',
      workspaceId: 'social-calendar',
      id: 'crossed_rpc',
      op: 'data',
      payload: {},
    }, 'social-calendar'),
    { ok: false, reason: 'invalid_envelope' },
  );
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

test('Workspace RPC history and diff operations are read-only, scoped, and tightly bounded', () => {
  const history = parseWorkspaceRpcRequest(
    request('history', {
      sourceKey: 'google-ads',
      limit: 40,
      cursor: 'obs_google_ads_40',
    }),
    'social-calendar',
  );
  assert.equal(history.ok, true);

  const diff = parseWorkspaceRpcRequest(
    request('diff', {
      sourceKey: 'google-ads',
      from: 'obs_123',
      to: 'obs_124',
    }),
    'social-calendar',
  );
  assert.equal(diff.ok, true);

  for (const malformed of [
    request('history', { limit: 101 }),
    request('history', { sourceKey: ' google-ads' }),
    request('history', { cursor: '../other-workspace' }),
    request('history', { before: 'yesterday' }),
    request('history', {
      cursor: 'obs_google_ads_40',
      before: '2026-07-28T19:00:00.000Z',
    }),
    request('history', { sourceKey: 'google-ads', includeDocuments: true }),
    request('diff', { from: '../other-workspace' }),
    request('diff', { to: 'obs_124', credentials: true }),
  ]) {
    assert.deepEqual(
      parseWorkspaceRpcRequest(malformed, 'social-calendar'),
      { ok: false, reason: 'invalid_payload' },
    );
  }
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

test('a captured general RPC port cannot forge trusted-click operations', () => {
  assert.deepEqual(
    parseWorkspaceRpcRequest(
      request('open_external', { url: 'https://example.com/evidence' }),
      'social-calendar',
    ),
    { ok: false, reason: 'invalid_operation' },
  );
  assert.deepEqual(
    parseWorkspaceRpcRequest(
      request('download', { filename: 'post.svg', dataUrl: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E' }),
      'social-calendar',
    ),
    { ok: false, reason: 'invalid_operation' },
  );
});

test('the private gesture capability accepts only bounded document-pinned link effects', () => {
  assert.equal(
    parseWorkspaceGestureRequest(
      gesture('open_external', { url: 'https://example.com/evidence' }),
      'social-calendar',
      'doc_7QY6nP',
    ).ok,
    true,
  );
  assert.equal(
    parseWorkspaceGestureRequest(
      gesture('download', {
        filename: 'post.svg',
        dataUrl: 'data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E',
      }),
      'social-calendar',
      'doc_7QY6nP',
    ).ok,
    true,
  );

  for (const [input, reason] of [
    [gesture('open_external', { url: 'javascript:alert(1)' }), 'invalid_payload'],
    [gesture('download', {
      filename: '../escape.svg',
      dataUrl: 'data:image/svg+xml,%3Csvg%2F%3E',
    }), 'invalid_payload'],
    [gesture('open_external', { url: 'https://example.com' }, {
      channel: WORKSPACE_RPC_CHANNEL,
    }), 'invalid_envelope'],
    [gesture('open_external', { url: 'https://example.com' }, {
      kind: 'request',
    }), 'invalid_envelope'],
    [gesture('open_external', { url: 'https://example.com' }, {
      workspaceId: 'other-workspace',
    }), 'wrong_workspace'],
    [gesture('open_external', { url: 'https://example.com' }, {
      documentId: 'doc_reloaded',
    }), 'wrong_document'],
    [gesture('open_external', { url: 'https://example.com' }, {
      id: '../gesture',
    }), 'invalid_id'],
    [gesture('action', { actionId: 'send', args: {} }), 'invalid_operation'],
  ] as const) {
    assert.deepEqual(
      parseWorkspaceGestureRequest(input, 'social-calendar', 'doc_7QY6nP'),
      { ok: false, reason },
    );
  }
});

test('gallery policy is read-only while the full Workspace retains fixed bridge operations', () => {
  assert.equal(workspaceRpcOpAllowed('data', true), true);
  assert.equal(workspaceRpcOpAllowed('history', true), true);
  assert.equal(workspaceRpcOpAllowed('diff', true), true);
  for (const op of ['refresh', 'note', 'compose', 'action'] as const) {
    assert.equal(workspaceRpcOpAllowed(op, true), false, `${op} must be denied in a gallery preview`);
    assert.equal(workspaceRpcOpAllowed(op, false), true, `${op} remains available in the full Workspace`);
  }
  assert.equal(workspaceGestureAllowed(true), false);
  assert.equal(workspaceGestureAllowed(false), true);
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
