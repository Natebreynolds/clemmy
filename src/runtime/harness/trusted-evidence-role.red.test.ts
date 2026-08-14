/**
 * Run: npx tsx --test src/runtime/harness/trusted-evidence-role.red.test.ts
 *
 * RED PIN — trusted evidence carries a semantic ROLE, not just a safety class.
 *
 * gatherTrustedEvidence is the ONE ledger every irreversible-write field check
 * stands on. Today it admits any output whose SAFETY class is 'read'|'compute'
 * and exposes only that raw effect string — so a shell carrier's 'compute'
 * (a mutation-safety verdict) silently grants full source authority for
 * recipients, amounts, and destinations it never proved.
 *
 * The invariant: each trusted tool source carries a typed evidence role —
 * source_read | derivation | committed_effect | verification — derived from
 * registered/proven capability metadata and observed settlements, never from
 * the safety class, command text, provider names, or tool-slug token lists.
 * A role-less compute output must not stand as source authority for an
 * irreversible-write field. These tests fail until the typed role exists.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-trusted-evidence-role-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-trusted-role\n', 'utf8');

const { appendEvent, createSession, closeEventLog, writeToolOutput } = await import('./eventlog.js');
const { gatherTrustedEvidence } = await import('./trusted-evidence.js');

test.after(() => {
  closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const EVIDENCE_ROLES = ['source_read', 'derivation', 'committed_effect', 'verification'];

let serial = 0;
function newSession(): string {
  const id = `sess-trusted-role-${++serial}`;
  createSession({ id, kind: 'chat' });
  return id;
}

function addToolOutput(sessionId: string, callId: string, tool: string, effect: string, output: string): void {
  const called = appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'tool_called',
    data: { tool, callId, effect },
  });
  writeToolOutput({ sessionId, callId, invocationNonce: `nonce-${callId}`, tool, output });
  appendEvent({
    sessionId,
    turn: 1,
    role: 'system',
    type: 'tool_returned',
    parentEventId: called.id,
    data: { tool, callId, effect, result: 'ok' },
  });
}

test('every trusted tool source carries a typed evidence role, not just the raw safety class', () => {
  const sessionId = newSession();
  addToolOutput(
    sessionId,
    'call_provider_read',
    'salesforce_query',
    'read',
    JSON.stringify({ successful: true, data: { rows: [{ email: 'blair@harborvale.example' }] } }),
  );

  const source = gatherTrustedEvidence(sessionId).find((row) => row.id === 'call_provider_read');
  assert.ok(source, 'fixture: the provider read is in the trusted set');
  const role = (source as unknown as Record<string, unknown>).evidenceRole;
  assert.ok(
    typeof role === 'string' && EVIDENCE_ROLES.includes(role),
    `a trusted source must carry a typed evidence role (${EVIDENCE_ROLES.join(' | ')}); `
      + `got ${JSON.stringify(role)} — the raw safety effect string is not a role`,
  );
});

test('a role-less shell compute output is not source authority for an irreversible-write field', () => {
  const sessionId = newSession();
  // The real ambiguity: a shell carrier classified 'compute' FOR SAFETY whose
  // stdout happens to contain an address. Nothing proved this output observed
  // any external source of truth.
  addToolOutput(
    sessionId,
    'call_shell_compute',
    'run_shell_command',
    'compute',
    'devon@cedarline.example',
  );

  const shell = gatherTrustedEvidence(sessionId).find((row) => row.id === 'call_shell_compute');
  const role = shell ? (shell as unknown as Record<string, unknown>).evidenceRole : undefined;
  assert.ok(
    shell === undefined || (typeof role === 'string' && EVIDENCE_ROLES.includes(role) && role !== 'source_read'),
    'a shell compute output with no registered capability role and no child settlement must not '
      + `stand as source_read authority; got role ${JSON.stringify(role)} on an admitted source`,
  );
});
