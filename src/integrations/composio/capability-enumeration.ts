/**
 * Connect-time enumeration for Composio toolkits.
 *
 * Provider knowledge lives at the carrier edge; the index it writes into is
 * provider-neutral. When a toolkit becomes connected, its operations are
 * enumerated ONCE and recorded, so the first turn after connecting can
 * retrieve them locally instead of paying a live provider search per role, per
 * turn — the blank-install tax this exists to remove.
 *
 * Everything here is best-effort and background: enumeration must never block,
 * slow, or fail a connection refresh, and a provider outage simply leaves the
 * index cold, which callers already treat as "ask the provider".
 */
import { getMachineId } from '../../runtime/machine-id.js';
import {
  deactivateCapabilityCarrier,
  indexedCapabilityCarriers,
  recordCapabilityOperations,
  type CapabilityEffectClass,
  type CapabilityEffectProvenance,
  type CapabilityOperationRow,
} from '../../memory/capability-index.js';
import { composioSlugEffectEvidence, composioSlugHasCuratedReadRule } from './slug-effect.js';
import { documentedComposioOperationSemantic } from './operation-semantics.js';

/** Operations enumerated per toolkit. Bounded: this is a catalog, not a dump. */
const MAX_OPERATIONS_PER_TOOLKIT = 200;

/** Operations sampled when judging whether a carrier is decorative. */
const DECORATIVE_SAMPLE = 50;

/** One in-flight enumeration per toolkit; a refresh storm must not fan out. */
const inFlight = new Set<string>();

function effectFor(slug: string): {
  effectClass: CapabilityEffectClass;
  effectProvenance: CapabilityEffectProvenance;
} {
  const documented = documentedComposioOperationSemantic(slug);
  if (documented) {
    return {
      effectClass: documented.effect === 'write' ? 'write' : 'read',
      effectProvenance: 'curated',
    };
  }
  if (composioSlugHasCuratedReadRule(slug)) {
    return { effectClass: 'read', effectProvenance: 'curated' };
  }
  const evidence = composioSlugEffectEvidence(slug);
  if (evidence === 'read') return { effectClass: 'read', effectProvenance: 'inferred' };
  if (evidence === 'write') return { effectClass: 'write', effectProvenance: 'inferred' };
  return { effectClass: 'unknown', effectProvenance: 'none' };
}

export interface ComposioToolkitEnumerationInput {
  slug: string;
  accountIdentity?: string;
  /** Test seam: supply the operations instead of calling the provider. */
  listOperations?: (slug: string, limit: number) => Promise<Array<{
    slug: string;
    name: string;
    description?: string;
    /**
     * The operation's frozen input schema, as the provider returned it. It
     * arrives in the SAME response that names the operation — see
     * `client.ts`, which reads `inputParameters ?? input_parameters ??
     * parameters` off every listed tool. Carrying it here costs nothing.
     */
    inputParameters?: unknown;
  }>>;
}

/**
 * CAT-7 — HAND EVERY BIND-REQUIRED FACT TO THE STORE THAT OWNS IT.
 *
 * Enumeration receives the operation's input schema in the same provider
 * response that names the operation, and used to drop it on the floor. The
 * consequence was not a slow path, it was a closed one: every gate on the bind
 * path resolves a schema from the durable contract store, so an install whose
 * store was empty could catalogue thousands of operations and bind none of
 * them. Reachability was then bought back per turn with a live discovery
 * search — the exact tax the index exists to remove.
 *
 * This is NOT the index learning to store schemas. The one-writer rule stands:
 * the index owns "this operation exists and appears to do X", and the contract
 * store owns "here is its frozen input shape". The enumerator simply hands
 * each fact to its owner instead of keeping one and discarding the other.
 *
 * Costs zero additional provider calls — the bytes are already in hand.
 * Best-effort by construction: a schema that will not persist must never fail
 * the enumeration that was only trying to help.
 */
function depositEnumeratedSchemas(
  operations: ReadonlyArray<{ slug?: unknown; inputParameters?: unknown }>,
): void {
  void (async () => {
    try {
      const { rememberToolSchema } = await import('../../tools/composio-schema-cache.js');
      for (const operation of operations) {
        const identifier = typeof operation.slug === 'string' ? operation.slug.trim() : '';
        if (!identifier || operation.inputParameters === undefined) continue;
        // rememberToolSchema itself refuses a non-record and writes through to
        // the durable contract store, so provenance and validation stay owned
        // there rather than being re-implemented at the carrier edge.
        try { rememberToolSchema(identifier, operation.inputParameters); } catch { /* per-operation */ }
      }
    } catch { /* a cold schema store leaves the install exactly as it was */ }
  })();
}

/**
 * Enumerate one connected toolkit into the capability index. Returns the number
 * of operations recorded (0 when the provider is unavailable).
 */
export async function indexComposioToolkit(
  input: ComposioToolkitEnumerationInput,
): Promise<number> {
  const slug = input.slug.trim().toLowerCase();
  if (!slug || inFlight.has(slug)) return 0;
  inFlight.add(slug);
  try {
    const list = input.listOperations
      ?? (async (toolkit: string, limit: number) => {
        const { listComposioToolkitTools } = await import('./client.js');
        return listComposioToolkitTools(toolkit, limit);
      });
    const operations = await list(slug, MAX_OPERATIONS_PER_TOOLKIT);
    depositEnumeratedSchemas(operations);
    const rows: CapabilityOperationRow[] = operations
      .filter((operation) => typeof operation.slug === 'string' && operation.slug.trim())
      .map((operation) => ({
        identifier: operation.slug.trim(),
        carrierKind: 'composio' as const,
        carrier: slug,
        displayName: operation.name?.trim() || operation.slug.trim(),
        description: operation.description ?? '',
        ...effectFor(operation.slug),
        ...(input.accountIdentity ? { accountIdentity: input.accountIdentity } : {}),
      }));
    return recordCapabilityOperations(rows);
  } catch {
    // A provider outage leaves the index cold; retrieval falls back to live.
    return 0;
  } finally {
    inFlight.delete(slug);
  }
}

/**
 * CAT-8 AS THE TRIGGER FOR CAT-7's BACKFILL.
 *
 * Reconcile skips a carrier it has already indexed, which is right for a
 * catalogue — re-listing a known toolkit every publication would be pure cost.
 * But it means a fix to WHAT enumeration deposits reaches only tools connected
 * AFTER the fix. Every existing install would keep its catalogue and never gain
 * the schemas that make it bindable, so the tool a user connected months ago
 * stays permanently unusable by the typed path while a tool they connect
 * tomorrow works.
 *
 * A carrier is DECORATIVE when it has catalogued operations and none of them
 * resolves a durable contract — the user sees a connected app and the executor
 * sees nothing it can bind. That is precisely CAT-8's release-blocking
 * condition, and it is exactly the population worth spending one re-enumeration
 * on. Self-limiting by construction: once the schemas land the carrier is no
 * longer decorative and is skipped forever after.
 *
 * Reads only local stores — deciding this costs no provider call.
 */
async function carrierIsDecorative(carrier: string): Promise<boolean> {
  try {
    const [{ listCapabilityOperationsForCarrier }, { loadToolContract }] = await Promise.all([
      import('../../memory/capability-index.js'),
      import('../../tools/tool-contract-store.js'),
    ]);
    const operations = listCapabilityOperationsForCarrier('composio', carrier, DECORATIVE_SAMPLE);
    if (operations.length === 0) return false;
    let resolvable = 0;
    for (const operation of operations) {
      try {
        const contract = loadToolContract(operation.identifier);
        if (contract?.schema && typeof contract.schema === 'object') resolvable += 1;
      } catch { /* an unreadable contract is not proof of provisioning */ }
    }
    // A MAJORITY must resolve, not merely one. Measured on a real install, "at
    // least one" was far too lenient: carriers sat at 1 contract out of 134,
    // 1 of 127, 1 of 92 — a single live discovery from a single past turn,
    // which proves a discovery happened and says nothing about whether the
    // carrier is provisioned. Treating those as healthy would strand hundreds
    // of operations permanently unbindable while reporting the app connected.
    return resolvable * 2 < operations.length;
  } catch {
    // Never let this judgement cause work: unknown means leave it alone.
    return false;
  }
}

export interface ConnectedToolkitObservation {
  slug: string;
  accountIdentity?: string;
}

/**
 * Reconcile the index against the toolkits this install currently has
 * connected: enumerate carriers that appeared, deactivate carriers that went
 * away. Safe to call on every connection publication — indexing work happens
 * only for genuinely new carriers.
 */
export async function reconcileComposioCapabilityIndex(
  connected: readonly ConnectedToolkitObservation[],
  options: {
    enumerate?: (input: ComposioToolkitEnumerationInput) => Promise<number>;
  } = {},
): Promise<{ indexedCarriers: number; recordedOperations: number; deactivatedCarriers: number }> {
  const enumerate = options.enumerate ?? indexComposioToolkit;
  const live = new Map<string, string | undefined>();
  for (const observation of connected) {
    const slug = observation.slug?.trim().toLowerCase();
    if (!slug || slug === 'unknown') continue;
    if (!live.has(slug)) live.set(slug, observation.accountIdentity);
  }
  const known = new Set(indexedCapabilityCarriers('composio'));

  let recordedOperations = 0;
  let indexedCarriers = 0;
  for (const [slug, accountIdentity] of live) {
    if (known.has(slug) && !(await carrierIsDecorative(slug))) continue;
    const recorded = await enumerate({
      slug,
      ...(accountIdentity ? { accountIdentity } : {}),
    });
    if (recorded > 0) {
      indexedCarriers += 1;
      recordedOperations += recorded;
    }
  }

  let deactivatedCarriers = 0;
  for (const slug of known) {
    if (live.has(slug)) continue;
    if (deactivateCapabilityCarrier('composio', slug) > 0) deactivatedCarriers += 1;
  }
  return { indexedCarriers, recordedOperations, deactivatedCarriers };
}

/**
 * Fire-and-forget reconcile for the connection-publication hot path. The
 * caller must never await this: a connection refresh is user-visible latency
 * and enumeration is not.
 */
export function scheduleComposioCapabilityIndex(
  connected: readonly ConnectedToolkitObservation[],
): void {
  // Machine identity is resolved eagerly so a failure here cannot surface
  // inside the detached task.
  try { getMachineId(); } catch { return; }
  void (async () => {
    try {
      await reconcileComposioCapabilityIndex(connected);
    } catch { /* connect-time indexing is best-effort by construction */ }
    try {
      const { scheduleConnectionRequestWake } = await import('../../runtime/harness/connection-request.js');
      scheduleConnectionRequestWake();
    } catch { /* parked-task wake must never break a connection refresh */ }
  })();
}
