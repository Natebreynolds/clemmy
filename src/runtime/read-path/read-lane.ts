/**
 * The generic read-only cold-to-warm lane (v3.8.0/D3) — the user-visible
 * reason this release exists.
 *
 * ONE dispatch loop for every familiar connected read, on every provider,
 * for every paraphrase:
 *
 *   cold:  resolve intent semantically against the sealed capability
 *          universe → exact scoped procedure resolution → on miss/stale, AT
 *          MOST ONE generic discovery/schema acquisition → bind request
 *          slots once → dispatch exactly one selected read → verify the
 *          durable receipt and promote ONE artifact → one public terminal.
 *   warm:  resolve the same scoped logical operation despite a paraphrase →
 *          load the bound artifact and selected schema STRUCTURALLY →
 *          dispatch once with zero rediscovery and zero validation repair →
 *          one terminal.
 *
 * The loop knows nothing about any particular provider, operation, or
 * content domain. Every judgment is an injected port; operations are data
 * flowing through the same mechanism. Tests prove no operation or provider
 * name appears in this module's control flow.
 *
 * Write/send intent EXITS before authority, before binding, before dispatch —
 * back to the existing governed path with its confirmation and effect safety
 * untouched. No write or send capability can even be admitted under the
 * lane's read ceiling (read-envelope.ts refuses at sealing).
 *
 * Budgets (C3) are enforced HERE — the one lane that debits the versioned
 * contract in v3.8.0 — and spans (C2) are measured here, so a warm run's
 * structural gate is deterministic:
 *
 *   procedure_resolution = hit, schema_discovery_calls = 0,
 *   tool_discovery_calls = 0, provider_dispatches = 1,
 *   validation_repairs = 0, public_terminals = 1,
 *   external_write_or_send_dispatches = 0.
 */
import type { BudgetMeter } from '../budget-contract.js';
import type { createSpanRecorder } from '../trace-envelope.js';
import type { DurableReceiptRecord, ReceiptResolver } from '../../memory/procedure-receipts.js';
import {
  promoteFromVerifiedReceipt,
  resolveActiveProcedure,
  type TransactionalResolution,
} from '../../memory/procedure-receipts.js';
import type { ProcedureScope } from '../../memory/procedure-artifact.js';
import type { ProcedureKind } from '../../memory/procedure-validity.js';
import { laneAdmitsDispatch, type ReadLaneEnvelope } from './read-envelope.js';

/** Semantic intent resolution — the ONLY model-shaped judgment in the lane,
 *  injected. It maps a paraphrase onto a logical operation WITHIN the sealed
 *  capability universe, or says it cannot. */
export type IntentResolution =
  | {
      kind: 'read';
      provider: string;
      operation: string;
      slotValues: Record<string, string>;
    }
  | { kind: 'effectful' }   // write/send intent — exits to the governed path
  | { kind: 'unresolved' }; // not a capability read — the lane declines

export interface DiscoveryAcquisition {
  identifier: string;
  schemaFingerprint: string;
  templateArgs: Record<string, unknown>;
  kind: ProcedureKind;
}

export interface ReadLanePorts {
  resolveIntent(text: string): Promise<IntentResolution>;
  /** Live schema fingerprint for a BOUND capability, from the already-loaded
   *  catalog — never a discovery call. Undefined = caller cannot know. */
  liveSchemaFingerprint(identifier: string): string | undefined;
  /** Whether the lane's stable logical account is currently connected (live
   *  verification through the broker; the rotating connection resolves only
   *  at dispatch). */
  accountConnected(): boolean;
  /** The ONE generic discovery/schema acquisition the cold path may make. */
  discover(provider: string, operation: string): Promise<DiscoveryAcquisition | undefined>;
  /** Dispatch the selected read exactly once; returns the durable receipt id. */
  dispatch(input: {
    identifier: string;
    args: Record<string, unknown>;
  }): Promise<{ receiptId: string } | { error: string; transient: boolean }>;
  receipts: ReceiptResolver;
  /** Compose the ONE public terminal from read evidence. */
  compose(evidence: DurableReceiptRecord): Promise<string>;
}

export interface ReadLaneCounters {
  procedure_resolution: 'hit' | 'miss' | 'stale' | 'unavailable' | 'quarantined';
  schema_discovery_calls: number;
  tool_discovery_calls: number;
  provider_dispatches: number;
  validation_repairs: number;
  public_terminals: number;
  external_write_or_send_dispatches: number;
}

export type ReadLaneOutcome =
  /** One public terminal, committed. */
  | { outcome: 'terminal'; text: string; counters: ReadLaneCounters; warm: boolean }
  /** Write/send intent: the lane never touched it — governed path owns it. */
  | { outcome: 'exits_to_governed_path'; counters: ReadLaneCounters }
  /** Not a connected-capability read; the ordinary conversation continues. */
  | { outcome: 'declined'; counters: ReadLaneCounters }
  /** ONE concise question, asked once; the artifact is not poisoned. */
  | { outcome: 'needs_slots'; missingSlots: string[]; question: string; counters: ReadLaneCounters }
  /** The intent names capability outside the sealed universe: pause and
   *  re-admit — logging-and-continuing is forbidden. */
  | { outcome: 'requires_readmission'; outside: string[]; counters: ReadLaneCounters }
  /** Typed failure: budget ceiling, provider trouble, unverifiable receipt. */
  | { outcome: 'failed'; reason: string; transient: boolean; counters: ReadLaneCounters };

export interface ReadLaneRun {
  lane: ReadLaneEnvelope;
  input: string;
  scope: ProcedureScope;
  budget: BudgetMeter;
  spans: ReturnType<typeof createSpanRecorder>;
  ports: ReadLanePorts;
}

function counters(): ReadLaneCounters {
  return {
    procedure_resolution: 'miss',
    schema_discovery_calls: 0,
    tool_discovery_calls: 0,
    provider_dispatches: 0,
    validation_repairs: 0,
    public_terminals: 0,
    external_write_or_send_dispatches: 0,
  };
}

export async function runColdToWarmRead(run: ReadLaneRun): Promise<ReadLaneOutcome> {
  const c = counters();
  const { ports, budget, spans } = run;

  // 1. Semantic intent resolution against the sealed universe.
  spans.mark('capability_resolution');
  const modelBudget = budget.debit('modelCalls', 1);
  if (!modelBudget.ok) return { outcome: 'failed', reason: modelBudget.reason, transient: false, counters: c };
  const intent = await ports.resolveIntent(run.input);
  spans.finish('capability_resolution');
  if (intent.kind === 'effectful') {
    // Before authority, before binding, before dispatch: the governed path
    // owns every write and send, confirmation and effect safety untouched.
    return { outcome: 'exits_to_governed_path', counters: c };
  }
  if (intent.kind === 'unresolved') return { outcome: 'declined', counters: c };

  // 2. Exact scoped procedure resolution (the warm hit or the honest miss).
  const resolved = resolveWithLiveFingerprint(run, intent, c);
  if (resolved.outcome === 'unavailable') {
    c.procedure_resolution = 'unavailable';
    return { outcome: 'failed', reason: resolved.reason, transient: true, counters: c };
  }
  if (resolved.outcome === 'needs_slots') {
    c.procedure_resolution = 'hit';
    return {
      outcome: 'needs_slots',
      missingSlots: resolved.missingSlots,
      question: `To run this I need: ${resolved.missingSlots.join(', ')}.`,
      counters: c,
    };
  }

  if (resolved.outcome === 'bound') {
    // ── WARM ─────────────────────────────────────────────────────────────────
    c.procedure_resolution = 'hit';
    if (!laneAdmitsDispatch(run.lane, resolved.artifact.identifier)) {
      return { outcome: 'requires_readmission', outside: [resolved.artifact.identifier], counters: c };
    }
    const args = bindSlots(resolved.artifact.template.args, intent.slotValues);
    return dispatchOnce(run, c, {
      identifier: resolved.artifact.identifier,
      args,
      warm: true,
      artifactId: resolved.artifact.artifactId,
    });
  }

  // ── COLD ───────────────────────────────────────────────────────────────────
  c.procedure_resolution = resolved.outcome === 'stale' ? 'stale'
    : 'quarantined' in resolved && resolved.quarantined ? 'quarantined' : 'miss';
  const discoveryBudget = budget.debit('discoveryCalls', 1);
  if (!discoveryBudget.ok) return { outcome: 'failed', reason: discoveryBudget.reason, transient: false, counters: c };
  spans.mark('discovery');
  c.schema_discovery_calls += 1;
  c.tool_discovery_calls += 1;
  const acquired = await ports.discover(intent.provider, intent.operation);
  spans.finish('discovery');
  if (!acquired) {
    return { outcome: 'failed', reason: 'discovery found no dispatchable capability for the resolved operation', transient: false, counters: c };
  }
  if (!laneAdmitsDispatch(run.lane, acquired.identifier)) {
    return { outcome: 'requires_readmission', outside: [acquired.identifier], counters: c };
  }
  spans.mark('slot_binding');
  const coldArgs = bindSlots(acquired.templateArgs, intent.slotValues);
  const missingSlots = unboundSlots(coldArgs);
  spans.finish('slot_binding');
  if (missingSlots.length > 0) {
    return {
      outcome: 'needs_slots',
      missingSlots,
      question: `To run this I need: ${missingSlots.join(', ')}.`,
      counters: c,
    };
  }
  return dispatchOnce(run, c, {
    identifier: acquired.identifier,
    args: coldArgs,
    warm: false,
    promote: { intent, acquired },
  });
}

function resolveWithLiveFingerprint(
  run: ReadLaneRun,
  intent: Extract<IntentResolution, { kind: 'read' }>,
  c: ReadLaneCounters,
): TransactionalResolution {
  void c;
  // The pointer names the identifier; the live fingerprint for a BOUND
  // capability comes from the loaded catalog, never a discovery call.
  const preliminary = resolveActiveProcedure({
    scope: run.scope,
    provider: intent.provider,
    operation: intent.operation,
    effectClass: 'read',
    accountConnected: run.ports.accountConnected(),
    slotValues: intent.slotValues,
  });
  if (preliminary.outcome !== 'bound' && preliminary.outcome !== 'needs_slots') return preliminary;
  const live = run.ports.liveSchemaFingerprint(preliminary.artifact.identifier);
  if (live === undefined || live === preliminary.artifact.schemaFingerprint) return preliminary;
  // Drift: re-resolve WITH the fingerprint so the quarantine is durable and
  // typed at the artifact layer (the only place that owns it).
  return resolveActiveProcedure({
    scope: run.scope,
    provider: intent.provider,
    operation: intent.operation,
    effectClass: 'read',
    liveSchemaFingerprint: live,
    accountConnected: run.ports.accountConnected(),
    slotValues: intent.slotValues,
  });
}

async function dispatchOnce(
  run: ReadLaneRun,
  c: ReadLaneCounters,
  input: {
    identifier: string;
    args: Record<string, unknown>;
    warm: boolean;
    artifactId?: string;
    promote?: {
      intent: Extract<IntentResolution, { kind: 'read' }>;
      acquired: DiscoveryAcquisition;
    };
  },
): Promise<ReadLaneOutcome> {
  const { ports, budget, spans } = run;
  const toolBudget = budget.debit('toolCalls', 1);
  if (!toolBudget.ok) return { outcome: 'failed', reason: toolBudget.reason, transient: false, counters: c };

  spans.mark('tool_provider');
  c.provider_dispatches += 1;
  const dispatched = await ports.dispatch({ identifier: input.identifier, args: input.args });
  spans.finish('tool_provider');
  if ('error' in dispatched) {
    // Transient provider trouble never poisons a structurally valid artifact.
    return { outcome: 'failed', reason: dispatched.error, transient: dispatched.transient, counters: c };
  }

  spans.mark('verification');
  const record = ports.receipts.resolve(dispatched.receiptId);
  spans.finish('verification');
  if (!record || record.dispatchOutcome !== 'succeeded' || !record.readEvidenceRef) {
    return {
      outcome: 'failed',
      reason: `dispatch returned receipt "${dispatched.receiptId}" but no durable verified read evidence resolves for it`,
      transient: false,
      counters: c,
    };
  }

  if (!input.warm && input.promote) {
    // Verified cold success promotes exactly ONE content-addressed artifact.
    const promoted = await promoteFromVerifiedReceipt({
      scope: run.scope,
      provider: input.promote.intent.provider,
      operation: input.promote.intent.operation,
      effectClass: 'read',
      kind: input.promote.acquired.kind,
      identifier: input.identifier,
      templateArgs: input.promote.acquired.templateArgs,
      receiptId: dispatched.receiptId,
    }, ports.receipts);
    if (!promoted.ok) {
      return {
        outcome: 'failed',
        reason: `verified dispatch could not promote its procedure: ${promoted.errors.join('; ')}`,
        transient: false,
        counters: c,
      };
    }
  }

  spans.mark('terminal_commit');
  const text = await ports.compose(record);
  spans.finish('terminal_commit');
  c.public_terminals += 1;
  return { outcome: 'terminal', text, counters: c, warm: input.warm };
}

// ── slot binding (pure) ──────────────────────────────────────────────────────

/** Fill `{{slot}}` placeholders from resolved slot values. Structure only —
 *  field names and encoding come from the template, never re-invented. */
export function bindSlots(
  templateArgs: Record<string, unknown>,
  slotValues: Record<string, string>,
): Record<string, unknown> {
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (whole, slot: string) =>
        (slot in slotValues ? slotValues[slot]! : whole));
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, fill(v)]));
    }
    return value;
  };
  return fill(templateArgs) as Record<string, unknown>;
}

/** Slot names still unbound after filling — the one concise question's list. */
export function unboundSlots(args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g)) out.add(match[1]!);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(args);
  return [...out];
}
