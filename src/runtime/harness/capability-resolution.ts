/**
 * Typed capability resolution — the runtime resolves what this turn's ask can
 * rely on BEFORE the model speaks, so alignment is grounded in facts instead
 * of optimism.
 *
 * The live 2026-08-05 shape this exists for: the user asked for a scrape into
 * a sheet; the model asked ONE good user-question ("which metro?") — with
 * completely unverified capability. Its own memory held a proven procedure
 * for exactly that work, auto-invalidated three weeks earlier after three
 * failures, and nothing surfaced either fact. The user was about to approve a
 * plan the runtime already knew was shaky.
 *
 * Structural sources only — nothing in this control flow names a provider,
 * service, or task domain:
 *   • proven procedures  — the tool-choice store's advertise-tier matches
 *     against the user's OWN taught/learned memos;
 *   • failure history    — the same store's invalidated records (choice
 *     removed after repeated failures), matched by the same token machinery;
 *   • connection registry — the cached connected-toolkit snapshot, joined by
 *     the identifier's toolkit prefix. A missing registry is UNKNOWN, never
 *     "disconnected": absence of the registry is not absence of the account.
 *
 * The output is DATA: a typed table, persisted as a `capability_resolution`
 * event (UI + graph consumers) and rendered into the model context as facts
 * with a deterministic floor (re-verify failed paths; surface disconnected
 * toolkits). It grants nothing and blocks nothing — binding authority stays
 * with the live schema fetch and the effect gates at the tool boundary.
 */
import {
  matchToolChoicesForStep,
  matchInvalidatedToolChoices,
  type ToolChoiceKind,
} from '../../memory/tool-choice-store.js';
import { peekConnectedToolkits } from '../../integrations/composio/client.js';
import { appendEvent } from './eventlog.js';

export type CapabilityStatus = 'proven' | 'previously_failed';
export type ConnectionState = 'active' | 'missing' | 'unknown' | 'not_applicable';

export interface CapabilityResolutionEntry {
  intent: string;
  kind: ToolChoiceKind;
  identifier: string;
  status: CapabilityStatus;
  /** Joined from the connection registry for composio-kind capabilities. */
  connection: ConnectionState;
  accountIdentity?: string;
  /** previously_failed only. */
  failedAt?: string;
  failureReason?: string;
}

export interface CapabilityResolution {
  entries: CapabilityResolutionEntry[];
  /** True when the registry snapshot was available for connection joins. */
  registryAvailable: boolean;
}

/** Toolkit slug implied by a composio identifier (`GOOGLESHEETS_BATCH_GET` →
 *  `googlesheets`). Purely lexical; used only to JOIN against the registry. */
function toolkitPrefix(identifier: string): string {
  return identifier.split('_')[0]?.toLowerCase() ?? '';
}

function connectionStateFor(
  kind: ToolChoiceKind,
  identifier: string,
  registry: ReadonlyArray<{ slug: string; status: string }>,
  registryAvailable: boolean,
): ConnectionState {
  if (kind !== 'composio') return 'not_applicable';
  if (!registryAvailable) return 'unknown';
  const prefix = toolkitPrefix(identifier);
  if (!prefix) return 'unknown';
  const forToolkit = registry.filter((c) => c.slug.toLowerCase() === prefix);
  if (forToolkit.length === 0) return 'missing';
  return forToolkit.some((c) => /active/i.test(c.status)) ? 'active' : 'missing';
}

/**
 * Resolve the turn's ask against the three structural sources. Synchronous
 * and cheap (store reads are mtime-cached; the registry is a peek) so both
 * brain lanes can run it at preflight without a network round trip.
 */
export function resolveTurnCapabilities(message: string): CapabilityResolution {
  const text = (message ?? '').trim();
  if (!text) return { entries: [], registryAvailable: false };
  let registry: ReturnType<typeof peekConnectedToolkits> = [];
  try {
    registry = peekConnectedToolkits();
  } catch {
    registry = [];
  }
  const registryAvailable = registry.length > 0;
  const entries: CapabilityResolutionEntry[] = [];
  const seen = new Set<string>();
  try {
    for (const m of matchToolChoicesForStep(text, { purpose: 'advertise', limit: 4 })) {
      const key = `${m.kind}:${m.identifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        intent: m.intent,
        kind: m.kind,
        identifier: m.identifier,
        status: 'proven',
        connection: connectionStateFor(m.kind, m.identifier, registry, registryAvailable),
        ...(m.accountIdentity ? { accountIdentity: m.accountIdentity } : {}),
      });
    }
  } catch { /* resolution is additive context, never turn authority */ }
  try {
    for (const m of matchInvalidatedToolChoices(text, { limit: 3 })) {
      const key = `${m.kind}:${m.identifier}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({
        intent: m.intent,
        kind: m.kind,
        identifier: m.identifier,
        status: 'previously_failed',
        connection: connectionStateFor(m.kind, m.identifier, registry, registryAvailable),
        ...(m.failedAt ? { failedAt: m.failedAt } : {}),
        ...(m.reason ? { failureReason: m.reason } : {}),
      });
    }
  } catch { /* resolution is additive context, never turn authority */ }
  return { entries, registryAvailable };
}

/**
 * Persist the resolution as a typed event — the UI's live "what Clem knows
 * going in" frame and the graph's future admission input. One helper so both
 * brain lanes record identically. Best-effort: telemetry never breaks a turn.
 */
export function recordCapabilityResolution(
  sessionId: string,
  resolution: CapabilityResolution,
  sourceUserSeq?: number,
): void {
  if (resolution.entries.length === 0) return;
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'capability_resolution',
      data: {
        entries: resolution.entries,
        registryAvailable: resolution.registryAvailable,
        ...(Number.isSafeInteger(sourceUserSeq) && (sourceUserSeq ?? 0) > 0 ? { sourceUserSeq } : {}),
      },
    });
  } catch { /* resolution telemetry must never break the turn */ }
}

/**
 * Render the resolution as a DATA block for the model. Facts first, then the
 * deterministic floor. Empty resolution renders nothing — no prompt tax on
 * turns with no capability history.
 */
export function renderCapabilityResolutionForContext(resolution: CapabilityResolution): string {
  if (resolution.entries.length === 0) return '';
  const lines: string[] = ['[capability resolution — runtime-resolved facts about THIS request]'];
  for (const e of resolution.entries) {
    const conn = e.connection === 'active' ? 'connection active'
      : e.connection === 'missing' ? 'NO ACTIVE CONNECTION'
        : e.connection === 'unknown' ? 'connection unverified'
          : null;
    if (e.status === 'proven') {
      lines.push(`✓ proven: ${e.intent} — ${e.kind}:${e.identifier}`
        + `${e.accountIdentity ? ` (${e.accountIdentity})` : ''}${conn ? ` [${conn}]` : ''}`);
    } else {
      lines.push(`✕ previously failed: ${e.intent} — ${e.kind}:${e.identifier}`
        + `${e.failedAt ? ` (failed ${e.failedAt.slice(0, 10)}` : ''}`
        + `${e.failureReason ? `; ${e.failureReason}` : ''}${e.failedAt ? ')' : ''}${conn ? ` [${conn}]` : ''}`);
    }
  }
  lines.push(
    'Floor: a previously-failed path must be re-verified with a cheap probe before you rely on it '
    + 'or ask for a go-ahead that assumes it — and say so. A toolkit with no active connection must be '
    + 'surfaced to the user, never worked around silently. Capabilities not listed are ordinary discovery.',
  );
  return lines.join('\n');
}
