/**
 * Run: npx tsx --test src/runtime/boundary-error.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { BoundaryError } = await import('./boundary-error.js');
const {
  renderBoundaryErrorForUser,
  renderBoundaryErrorForOps,
} = await import('./boundary-error-renderer.js');

test('BoundaryError carries init fields verbatim', () => {
  const err = new BoundaryError({
    kind: 'codex.http_5xx',
    retryable: true,
    userMessage: 'Backend is having trouble; retrying.',
    operatorMessage: 'codex 503 status=503 retries=2',
    context: { status: 503, retries: 2 },
    cause: new Error('socket hang up'),
  });
  assert.equal(err.kind, 'codex.http_5xx');
  assert.equal(err.retryable, true);
  assert.equal(err.userMessage, 'Backend is having trouble; retrying.');
  assert.equal(err.operatorMessage, 'codex 503 status=503 retries=2');
  assert.equal(err.context.status, 503);
  assert.equal((err.cause as Error).message, 'socket hang up');
  // Error.message should be the operator message so console.error works.
  assert.equal(err.message, 'codex 503 status=503 retries=2');
  // instanceof check survives the super() boundary.
  assert.ok(err instanceof BoundaryError);
  assert.ok(err instanceof Error);
});

test('BoundaryError.from wraps unknown errors without losing the cause', () => {
  const original = new Error('ECONNRESET');
  const wrapped = BoundaryError.from(original, {
    kind: 'codex.http_5xx',
    userMessage: 'Network blip; retrying.',
    retryable: true,
  });
  assert.equal(wrapped.kind, 'codex.http_5xx');
  assert.equal(wrapped.retryable, true);
  assert.equal(wrapped.cause, original);
  assert.match(wrapped.operatorMessage, /codex\.http_5xx.*ECONNRESET/);
  assert.equal(wrapped.context.rawMessage, 'ECONNRESET');
});

test('BoundaryError.from passes through existing BoundaryErrors', () => {
  // Boundaries must not re-wrap each other — inner classifier wins.
  const inner = new BoundaryError({
    kind: 'mcp.server_unavailable',
    retryable: false,
    userMessage: 'DataForSEO is offline.',
    operatorMessage: 'mcp dataforseo unreachable for 5min',
  });
  const wrapped = BoundaryError.from(inner, {
    kind: 'codex.http_5xx',
    userMessage: 'wrong',
  });
  assert.equal(wrapped, inner);
  assert.equal(wrapped.kind, 'mcp.server_unavailable');
});

test('BoundaryError.isTransient flags retry-worthy kinds even when retryable=false', () => {
  // The retryable flag is the boundary author's call; isTransient also
  // checks the kind so callers can do "I'll retry on kind even though
  // the author didn't mark it retryable" (e.g. SSE truncation always).
  const ssetrunc = new BoundaryError({
    kind: 'codex.sse_truncated',
    retryable: false, // author didn't claim retryable
    userMessage: 'cut short',
    operatorMessage: 'sse cut',
  });
  assert.equal(BoundaryError.isTransient(ssetrunc), true);

  const auth = new BoundaryError({
    kind: 'codex.auth_expired',
    retryable: false,
    userMessage: 're-auth',
    operatorMessage: '401 no refresh',
  });
  assert.equal(BoundaryError.isTransient(auth), false);

  // A non-BoundaryError is never transient.
  assert.equal(BoundaryError.isTransient(new Error('foo')), false);
  assert.equal(BoundaryError.isTransient('string'), false);
});

test('BoundaryError.toJSON shape is stable for pino', () => {
  const err = new BoundaryError({
    kind: 'state.write_failed',
    retryable: false,
    userMessage: 'Disk full.',
    operatorMessage: 'ENOSPC on usage-log/2026-05-18.ndjson',
    context: { path: '/tmp/foo', errno: -28 },
    cause: new Error('ENOSPC'),
  });
  const json = err.toJSON();
  assert.deepEqual(json, {
    name: 'BoundaryError',
    kind: 'state.write_failed',
    retryable: false,
    userMessage: 'Disk full.',
    operatorMessage: 'ENOSPC on usage-log/2026-05-18.ndjson',
    context: { path: '/tmp/foo', errno: -28 },
    cause: { name: 'Error', message: 'ENOSPC' },
  });
});

test('renderBoundaryErrorForUser returns title + body + actionHint per kind', () => {
  const err = new BoundaryError({
    kind: 'codex.auth_expired',
    retryable: false,
    userMessage: 'Codex auth expired. Re-authenticate to keep going.',
    operatorMessage: '401 + refresh failed',
  });
  const dashboardRender = renderBoundaryErrorForUser(err, 'dashboard');
  assert.equal(dashboardRender.title, 'Codex auth expired');
  assert.equal(dashboardRender.body, 'Codex auth expired. Re-authenticate to keep going.');
  assert.match(dashboardRender.actionHint ?? '', /Settings/);

  // CLI surface gets a concrete command instead of a UI path.
  const cliRender = renderBoundaryErrorForUser(err, 'cli');
  assert.match(cliRender.actionHint ?? '', /clementine auth login/);
});

test('renderBoundaryErrorForOps assigns severity per kind', () => {
  const transient = new BoundaryError({
    kind: 'codex.sse_truncated',
    retryable: true,
    userMessage: 'cut short',
    operatorMessage: 'sse',
  });
  assert.equal(renderBoundaryErrorForOps(transient).severity, 'warn');

  const authBroken = new BoundaryError({
    kind: 'codex.auth_expired',
    retryable: false,
    userMessage: 'auth',
    operatorMessage: 'auth',
  });
  assert.equal(renderBoundaryErrorForOps(authBroken).severity, 'critical');

  const toolBroken = new BoundaryError({
    kind: 'mcp.tool_call_failed',
    retryable: false,
    userMessage: 'tool',
    operatorMessage: 'tool',
  });
  assert.equal(renderBoundaryErrorForOps(toolBroken).severity, 'error');
});

test('renderBoundaryErrorForOps logFields are pino-friendly', () => {
  const err = new BoundaryError({
    kind: 'mcp.server_unavailable',
    retryable: true,
    userMessage: 'DataForSEO offline.',
    operatorMessage: 'mcp dataforseo unreachable failureCount=3',
    context: { slug: 'dataforseo', failureCount: 3 },
  });
  const { logFields } = renderBoundaryErrorForOps(err);
  assert.equal(logFields.kind, 'mcp.server_unavailable');
  assert.equal(logFields.retryable, true);
  assert.equal(logFields.msg, 'mcp dataforseo unreachable failureCount=3');
  assert.deepEqual(logFields.context, { slug: 'dataforseo', failureCount: 3 });
});

test('renderer covers every BoundaryErrorKind (exhaustiveness guard)', () => {
  // Snapshot-style guard: enumerate every kind and render both
  // surfaces. If a new kind is added without updating the renderer,
  // titleForKind / severityForKind will fall through and return
  // undefined — this test catches it.
  const ALL_KINDS = [
    'codex.http_4xx', 'codex.http_5xx', 'codex.sse_truncated',
    'codex.auth_expired', 'codex.wall_clock', 'codex.grace_turn_failed',
    'mcp.server_unavailable', 'mcp.tool_call_failed',
    'mcp.approval_blocked', 'mcp.unknown_tool',
    'notification.delivery_failed', 'notification.partial_chunk',
    'state.write_failed', 'state.read_corrupted',
    'runtime.deserialize', 'runtime.unknown',
  ] as const;
  for (const kind of ALL_KINDS) {
    const err = new BoundaryError({
      kind,
      retryable: false,
      userMessage: 'test',
      operatorMessage: 'test',
    });
    const userRender = renderBoundaryErrorForUser(err, 'dashboard');
    assert.ok(userRender.title && userRender.title.length > 0, `missing title for ${kind}`);
    assert.ok(userRender.body && userRender.body.length > 0, `missing body for ${kind}`);
    const opsRender = renderBoundaryErrorForOps(err);
    assert.ok(
      ['warn', 'error', 'critical'].includes(opsRender.severity),
      `bad severity for ${kind}`,
    );
  }
});
