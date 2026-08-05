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
import type { BudgetMeter, DebitResult } from '../budget-contract.js';
import type { createSpanRecorder } from '../trace-envelope.js';
import type { DurableReceiptRecord, ReceiptResolver } from '../../memory/procedure-receipts.js';
import {
  promoteFromVerifiedReceipt,
  resolveActiveProcedure,
  type TransactionalResolution,
} from '../../memory/procedure-receipts.js';
import type { ProcedureScope } from '../../memory/procedure-artifact.js';
import type { ProcedureKind } from '../../memory/procedure-validity.js';
import { boundDispatchFor, laneAdmitsDispatch, type BoundReadDispatch, type ReadLaneEnvelope } from './read-envelope.js';
import { recordWarmProcedureUse } from '../../memory/procedure-receipts.js';
import {
  consumePendingCapabilityTurn,
  persistPendingCapabilityTurn,
} from '../../memory/pending-capability-turns.js';

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
  /** Dispatch the selected read exactly once, under the FULL bound-dispatch
   *  identity (F26); returns the durable receipt id. */
  dispatch(bound: BoundReadDispatch): Promise<{ receiptId: string } | { error: string; transient: boolean }>;
  receipts: ReceiptResolver;
  /**
   * Produce the evidence-grounded PRESENTATION INPUT (a draft, never a
   * terminal). Actual success/needs-input/failure flows through the existing
   * typed TurnOutcome/commit machinery at the consumer (F29) — this port has
   * no terminal authority.
   */
  present(evidence: DurableReceiptRecord): Promise<{ draft: string }>;
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
  /** Injected monotonic clock for the elapsed-time debit. */
  clock?: () => number;
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
  const clock = run.clock ?? (() => 0);
  const startedAt = clock();
  /** Every owned resource debits at its boundary (F19): tokens from port
   *  usage reports, elapsed time at exit. A refused debit parks the lane. */
  const debitUsage = (usage?: { uncachedInputTokens?: number; outputTokens?: number }): Extract<DebitResult, { ok: false }> | undefined => {
    if (!usage) return undefined;
    if (usage.uncachedInputTokens) {
      const tokens = budget.debit('uncachedInputTokens', usage.uncachedInputTokens);
      if (!tokens.ok) return tokens;
    }
    if (usage.outputTokens) {
      const out = budget.debit('outputTokens', usage.outputTokens);
      if (!out.ok) return out;
    }
    return undefined;
  };
  const withElapsed = <T extends ReadLaneOutcome>(outcome: T): T => {
    budget.debit('elapsedMs', Math.max(0, clock() - startedAt));
    return outcome;
  };
  // F21: lane and scope are ONE sealed authority. A byte-for-byte mismatch
  // refuses before intent, discovery, or dispatch.
  if (run.scope.tenant !== run.lane.identity.tenant
    || run.scope.workspace !== run.lane.identity.workspace
    || run.scope.accountIdentity !== run.lane.identity.accountIdentity) {
    return withElapsed({
      outcome: 'failed',
      reason: 'lane/scope divergence: the run scope does not match the sealed lane identity byte-for-byte',
      transient: false,
      counters: c,
    });
  }

  // 1. Semantic intent resolution against the sealed universe.
  spans.mark('capability_resolution');
  const modelBudget = budget.debit('modelCalls', 1);
  if (!modelBudget.ok) return withElapsed({ outcome: 'failed', reason: modelBudget.reason, transient: false, counters: c });
  const intent = await ports.resolveIntent(run.input);
  spans.finish('capability_resolution');
  const intentUsageRefused = debitUsage((intent as { usage?: { uncachedInputTokens?: number; outputTokens?: number } }).usage);
  if (intentUsageRefused) {
    return withElapsed({ outcome: 'failed', reason: intentUsageRefused.reason, transient: false, counters: c });
  }
  if (intent.kind === 'effectful') {
    // Before authority, before binding, before dispatch: the governed path
    // owns every write and send, confirmation and effect safety untouched.
    return withElapsed({ outcome: 'exits_to_governed_path', counters: c });
  }
  if (intent.kind === 'unresolved') return withElapsed({ outcome: 'declined', counters: c });

  // 2. Exact scoped procedure resolution (the warm hit or the honest miss).
  const resolved = resolveWithLiveFingerprint(run, intent, c);
  if (resolved.outcome === 'unavailable') {
    c.procedure_resolution = 'unavailable';
    return withElapsed({ outcome: 'failed', reason: resolved.reason, transient: true, counters: c });
  }
  if (resolved.outcome === 'needs_slots') {
    c.procedure_resolution = 'hit';
    return withElapsed({
      outcome: 'needs_slots',
      missingSlots: resolved.missingSlots,
      question: `To run this I need: ${resolved.missingSlots.join(', ')}.`,
      counters: c,
    });
  }

  if (resolved.outcome === 'bound') {
    // ── WARM ─────────────────────────────────────────────────────────────────
    c.procedure_resolution = 'hit';
    if (!laneAdmitsDispatch(run.lane, resolved.artifact.identifier)) {
      return withElapsed({ outcome: 'requires_readmission', outside: [resolved.artifact.identifier], counters: c });
    }
    const args = bindSlots(resolved.artifact.template.args, intent.slotValues);
    return withElapsed(await dispatchOnce(run, c, {
      identifier: resolved.artifact.identifier,
      args,
      warm: true,
      artifactId: resolved.artifact.artifactId,
      warmProvider: resolved.artifact.provider,
      warmOperation: resolved.artifact.operation,
      provenSchemaFingerprint: resolved.artifact.schemaFingerprint,
    }));
  }

  // ── COLD ───────────────────────────────────────────────────────────────────
  c.procedure_resolution = resolved.outcome === 'stale' ? 'stale'
    : 'quarantined' in resolved && resolved.quarantined ? 'quarantined' : 'miss';
  const discoveryBudget = budget.debit('discoveryCalls', 1);
  if (!discoveryBudget.ok) return withElapsed({ outcome: 'failed', reason: discoveryBudget.reason, transient: false, counters: c });
  spans.mark('discovery');
  c.schema_discovery_calls += 1;
  c.tool_discovery_calls += 1;
  const acquired = await ports.discover(intent.provider, intent.operation);
  spans.finish('discovery');
  if (!acquired) {
    return withElapsed({ outcome: 'failed', reason: 'discovery found no dispatchable capability for the resolved operation', transient: false, counters: c });
  }
  if (!laneAdmitsDispatch(run.lane, acquired.identifier)) {
    return withElapsed({ outcome: 'requires_readmission', outside: [acquired.identifier], counters: c });
  }
  spans.mark('slot_binding');
  const coldArgs = bindSlots(acquired.templateArgs, intent.slotValues);
  const missingSlots = unboundSlots(coldArgs);
  spans.finish('slot_binding');
  if (missingSlots.length > 0) {
    // F30: the acquisition is DURABLE — the next answer joins it
    // structurally instead of rerunning discovery.
    try {
      persistPendingCapabilityTurn({
        version: 1,
        acceptedSource: run.lane.identity.acceptedTurnId,
        scope: { ...run.scope },
        provider: intent.provider,
        operation: intent.operation,
        identifier: acquired.identifier,
        schemaFingerprint: acquired.schemaFingerprint,
        kind: acquired.kind,
        templateArgs: acquired.templateArgs,
        missingSlots,
        knownSlotValues: intent.slotValues,
        authorityDigest: run.lane.laneDigest,
        createdAt: new Date().toISOString(),
      });
    } catch { /* the question still goes out; persistence is best-effort-loud elsewhere */ }
    return withElapsed({
      outcome: 'needs_slots',
      missingSlots,
      question: `To run this I need: ${missingSlots.join(', ')}.`,
      counters: c,
    });
  }
  return withElapsed(await dispatchOnce(run, c, {
    identifier: acquired.identifier,
    args: coldArgs,
    warm: false,
    promote: { intent, acquired },
  }));
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
  if (live === undefined) {
    // No live schema means no warm dispatch (F22): typed cold reacquisition.
    return {
      outcome: 'stale',
      artifactId: preliminary.artifact.artifactId,
      reason: 'live schema fingerprint unknown — cold reacquisition required before dispatch',
    };
  }
  if (live === preliminary.artifact.schemaFingerprint) return preliminary;
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
    /** The warm artifact's logical operation, for the bound dispatch. */
    warmProvider?: string;
    warmOperation?: string;
    /** The schema the WARM artifact was proven under. */
    provenSchemaFingerprint?: string;
    promote?: {
      intent: Extract<IntentResolution, { kind: 'read' }>;
      acquired: DiscoveryAcquisition;
    };
  },
): Promise<ReadLaneOutcome> {
  const { ports, budget, spans } = run;
  const toolBudget = budget.debit('toolCalls', 1);
  if (!toolBudget.ok) return { outcome: 'failed', reason: toolBudget.reason, transient: false, counters: c };

  // F26: the dispatch is a typed BOUND contract, never a bare name.
  const bound = boundDispatchFor(run.lane, {
    identifier: input.identifier,
    provider: input.promote?.intent.provider ?? input.warmProvider ?? '',
    operation: input.promote?.intent.operation ?? input.warmOperation ?? '',
    args: input.args,
  });
  if (!bound.ok) {
    return { outcome: 'requires_readmission', outside: [input.identifier], counters: c };
  }

  spans.mark('tool_provider');
  c.provider_dispatches += 1;
  let dispatched: Awaited<ReturnType<ReadLanePorts['dispatch']>>;
  try {
    dispatched = await ports.dispatch(bound.dispatch);
  } catch (error) {
    spans.finish('tool_provider');
    return { outcome: 'failed', reason: `dispatch port threw: ${error instanceof Error ? error.message : String(error)}`, transient: true, counters: c };
  }
  spans.finish('tool_provider');
  if ('error' in dispatched) {
    // Transient provider trouble never poisons a structurally valid artifact.
    return { outcome: 'failed', reason: dispatched.error, transient: dispatched.transient, counters: c };
  }

  // ONE receipt verifier for cold and warm (F20): the durable record must
  // prove THIS provider, operation, identifier, schema, scope, and the read
  // effect class — a succeeded send from anywhere composes nothing.
  spans.mark('verification');
  const record = ports.receipts.resolve(dispatched.receiptId);
  spans.finish('verification');
  const expectSchema = input.warm ? input.provenSchemaFingerprint : input.promote?.acquired.schemaFingerprint;
  const verifyFailure = verifyReadReceipt(record, {
    provider: bound.dispatch.provider,
    operation: bound.dispatch.operation,
    identifier: input.identifier,
    schemaFingerprint: expectSchema,
    scope: run.scope,
  });
  if (verifyFailure) {
    return { outcome: 'failed', reason: verifyFailure, transient: false, counters: c };
  }

  if (!input.warm && input.promote) {
    // Verified cold success promotes exactly ONE content-addressed artifact,
    // under the schema the ACQUISITION proved (F23).
    const promoted = await promoteFromVerifiedReceipt({
      scope: run.scope,
      provider: input.promote.intent.provider,
      operation: input.promote.intent.operation,
      effectClass: 'read',
      kind: input.promote.acquired.kind,
      identifier: input.identifier,
      templateArgs: input.promote.acquired.templateArgs,
      receiptId: dispatched.receiptId,
      acquiredSchemaFingerprint: input.promote.acquired.schemaFingerprint,
    }, ports.receipts);
    if (!promoted.ok) {
      return {
        outcome: 'failed',
        reason: `verified dispatch could not promote its procedure: ${promoted.errors.join('; ')}`,
        transient: false,
        counters: c,
      };
    }
    consumePendingCapabilityTurn({
      scope: run.scope, provider: input.promote.intent.provider, operation: input.promote.intent.operation,
    });
  }
  if (input.warm && input.artifactId) {
    // E3.5: credit the EXACT artifact that carried the warm hit.
    recordWarmProcedureUse(input.artifactId);
  }

  spans.mark('terminal_commit');
  let presentation: { draft: string };
  try {
    presentation = await ports.present(record!);
  } catch (error) {
    spans.finish('terminal_commit');
    return { outcome: 'failed', reason: `presentation port threw: ${error instanceof Error ? error.message : String(error)}`, transient: false, counters: c };
  }
  spans.finish('terminal_commit');
  c.public_terminals += 1;
  return { outcome: 'terminal', text: presentation.draft, counters: c, warm: input.warm };
}

/** The one verifier (F20/F22/F23): returns the refusal reason or undefined. */
function verifyReadReceipt(
  record: DurableReceiptRecord | undefined,
  expect: {
    provider: string;
    operation: string;
    identifier: string;
    schemaFingerprint?: string;
    scope: ProcedureScope;
  },
): string | undefined {
  if (!record) return 'dispatch returned a receipt id that resolves to no durable record';
  if (record.dispatchOutcome !== 'succeeded') return `receipt records dispatch outcome "${record.dispatchOutcome}"`;
  if (record.effectClass !== 'read') {
    return `receipt proves a ${record.effectClass} effect — a read lane composes nothing from it`;
  }
  if (!record.readEvidenceRef) return 'receipt carries no verified read evidence';
  if (record.provider !== expect.provider || record.operation !== expect.operation) {
    return `receipt proves ${record.provider}/${record.operation}, not the bound ${expect.provider}/${expect.operation}`;
  }
  if (record.identifier !== expect.identifier) {
    return `receipt proves identifier "${record.identifier}", not the bound "${expect.identifier}"`;
  }
  if (expect.schemaFingerprint !== undefined && record.schemaFingerprint !== expect.schemaFingerprint) {
    return `receipt proves schema ${record.schemaFingerprint}, not the bound ${expect.schemaFingerprint}`;
  }
  if (record.scope.tenant !== expect.scope.tenant
    || record.scope.workspace !== expect.scope.workspace
    || record.scope.accountIdentity !== expect.scope.accountIdentity) {
    return 'receipt scope does not match the lane scope';
  }
  return undefined;
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
