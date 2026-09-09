/**
 * The sole provider-neutral work-topology vocabulary.
 *
 * A model may propose this shape, but only the host validator can canonicalize
 * it. Accepted graphs, expected-work contracts, foreground projection, durable
 * manifests, and workflows all carry this exact value or its digest; none may
 * infer a second DAG from prose, returned row count, tool names, or estimates.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { WORK_ID_MAX_CHARS, WORK_ID_PATTERN } from '../../shared/work-id.js';

export const WORK_TOPOLOGY_VERSION = 1 as const;
export const WORK_TOPOLOGY_MAX_OPERATIONS = 32 as const;
export const WORK_TOPOLOGY_MAX_UNIVERSES = 16 as const;
/** Runtime/store ceiling for a sealed member universe. This is deliberately
 * above the foreground budget: cardinality decides disposition, not whether a
 * source happened to return more rows than one chat window can execute. */
export const WORK_TOPOLOGY_MAX_UNIVERSE_MEMBERS = 10_000 as const;
/** Models must describe scalable source universes by producer receipt. They do
 * not echo a 10K member ledger through a tool schema or prompt. */
export const WORK_TOPOLOGY_MAX_INLINE_MODEL_MEMBERS = 256 as const;

export type WorkTopologyEffectV1 =
  | 'read'
  | 'compute'
  | 'local_write'
  | 'external_write'
  | 'admin';

export type WorkTopologyCoverageV1 =
  | 'single'
  | 'accepted_set'
  | 'complete_set'
  | 'resolved_operation';

export type WorkTopologyCardinalityV1 =
  | { kind: 'once' }
  | { kind: 'each'; universeId: string }
  | { kind: 'set'; universeId: string };

export interface WorkTopologyOperationV1 {
  id: string;
  effect: WorkTopologyEffectV1;
  /** Reads state whether one answer or the complete source is owed. */
  coverage?: WorkTopologyCoverageV1;
  dependsOn: string[];
  /** Structural data lineage. Every entry must also be a dependency. */
  dataFrom: string[];
  cardinality: WorkTopologyCardinalityV1;
}

export type WorkTopologyUniverseV1 =
  | {
      id: string;
      seal: 'accepted_input';
      members: string[];
    }
  | {
      id: string;
      seal: 'complete_source_receipt';
      producedBy: string;
      /** RFC 6901 pointer into one producer record; empty means the record. */
      memberIdPointer: string;
    };

export interface WorkTopologyV1 {
  version: typeof WORK_TOPOLOGY_VERSION;
  operations: WorkTopologyOperationV1[];
  universes: WorkTopologyUniverseV1[];
}

export type WorkTopologyValidation =
  | { ok: true; topology: WorkTopologyV1 }
  | { ok: false; errors: string[] };

const ID_PATTERN = WORK_ID_PATTERN;
const MEMBER_PATTERN = /^\S(?:[\s\S]{0,254}\S)?$/;

export const WorkTopologyIdSchema = z.string().min(1).max(WORK_ID_MAX_CHARS).regex(ID_PATTERN);
export const WorkTopologyMemberSchema = z.string().min(1).max(256).regex(MEMBER_PATTERN);
export const WorkTopologyEffectSchema = z.enum([
  'read', 'compute', 'local_write', 'external_write', 'admin',
]);
/** Model-facing coverage. `resolved_operation` is the truthful shape for one
 * bounded, once-cardinality root lookup that promises a grounded result but
 * not provider-wide exhaustion. Expected-work admission separately refuses it
 * for finite/set/count-constrained or dependent reads. */
export const WorkTopologyModelCoverageSchema = z.enum([
  'single', 'accepted_set', 'complete_set', 'resolved_operation',
]);
export const WorkTopologyCoverageSchema = z.enum([
  'single', 'accepted_set', 'complete_set', 'resolved_operation',
]);
export const WorkTopologyCardinalitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once') }).strict(),
  z.object({ kind: z.literal('each'), universeId: WorkTopologyIdSchema }).strict(),
  z.object({ kind: z.literal('set'), universeId: WorkTopologyIdSchema }).strict(),
]);

/** Strict model-facing operation grammar. `coverage:null` is the explicit
 * non-read representation; canonicalization removes it. */
export const WorkTopologyOperationSchema = z.object({
  id: WorkTopologyIdSchema,
  effect: WorkTopologyEffectSchema,
  coverage: WorkTopologyModelCoverageSchema.nullable(),
  dependsOn: z.array(WorkTopologyIdSchema).max(WORK_TOPOLOGY_MAX_OPERATIONS),
  dataFrom: z.array(WorkTopologyIdSchema).max(WORK_TOPOLOGY_MAX_OPERATIONS),
  cardinality: WorkTopologyCardinalitySchema,
}).strict();

export const WorkTopologyUniverseSchema = z.discriminatedUnion('seal', [
  z.object({
    id: WorkTopologyIdSchema,
    seal: z.literal('accepted_input'),
    members: z.array(WorkTopologyMemberSchema).min(1).max(WORK_TOPOLOGY_MAX_UNIVERSE_MEMBERS).describe(
      `The member ids inline (up to ${WORK_TOPOLOGY_MAX_INLINE_MODEL_MEMBERS}). Use this seal for a set you already hold — for example ids read in an earlier turn.`,
    ),
  }).strict(),
  z.object({
    id: WorkTopologyIdSchema,
    seal: z.literal('complete_source_receipt'),
    producedBy: WorkTopologyIdSchema.describe(
      'The id of a read operation IN THIS topology with coverage "complete_set" and cardinality once, whose receipt seals the set. A call id or result from an earlier turn is not an operation; either add that read here or use seal "accepted_input" with the ids inline.',
    ),
    memberIdPointer: z.string().max(512).describe(
      'RFC 6901 pointer to one member id inside ONE producer record; empty string when the record is itself the id.',
    ),
  }).strict(),
]);

/** The single strict schema exposed to model-facing tools. Cross-field and DAG
 * checks remain in validateWorkTopology so persisted/replayed unknown input uses
 * the exact same authority boundary. */
export const WorkTopologySchema = z.object({
  version: z.literal(WORK_TOPOLOGY_VERSION),
  operations: z.array(WorkTopologyOperationSchema).max(WORK_TOPOLOGY_MAX_OPERATIONS),
  universes: z.array(WorkTopologyUniverseSchema).max(WORK_TOPOLOGY_MAX_UNIVERSES),
}).strict();

/** Structural shape only — the wire variant. The cross-field/DAG refinements
 *  live on ActionWorkTopologySchema below; a transport that carried them made
 *  every topology mistake THROW inside runner.run as `model_failed`, bypassing
 *  the repair gate that the identical check at admission feeds. */
export const ActionWorkTopologyBaseSchema = WorkTopologySchema.extend({
  operations: z.array(WorkTopologyOperationSchema).min(1).max(WORK_TOPOLOGY_MAX_OPERATIONS),
}).strict();

export const ActionWorkTopologySchema = ActionWorkTopologyBaseSchema.superRefine((topology, ctx) => {
  const validated = validateWorkTopology(topology);
  if (!validated.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: validated.errors.join('; '),
    });
  }
  for (const [index, universe] of topology.universes.entries()) {
    if (
      universe.seal === 'accepted_input'
      && universe.members.length > WORK_TOPOLOGY_MAX_INLINE_MODEL_MEMBERS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['universes', index, 'members'],
        message: `model-authored accepted input is limited to ${WORK_TOPOLOGY_MAX_INLINE_MODEL_MEMBERS} inline members; use a complete_source_receipt universe for scalable sets`,
      });
    }
  }
});

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) errors.push(`${label} contains unknown field ${key}`);
  }
}

function validId(value: unknown, label: string, errors: string[]): value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    errors.push(`${label} must be a bounded stable id`);
    return false;
  }
  return true;
}

export function isBoundedWorkTopologyJsonPointer(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 512
    && (value === '' || value.startsWith('/'))
    && !/(?:~(?![01]))/.test(value);
}

function pointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function resolveWorkTopologyJsonPointer(
  value: unknown,
  pointer: string,
): { ok: true; value: unknown } | { ok: false } {
  if (pointer === '') return { ok: true, value };
  let current = value;
  for (const rawSegment of pointer.slice(1).split('/')) {
    const segment = pointerSegment(rawSegment);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) return { ok: false };
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) return { ok: false };
      current = current[index];
      continue;
    }
    if (!current || typeof current !== 'object' || !(segment in current)) return { ok: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { ok: true, value: current };
}

function normalizeProposedOperation(raw: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...raw };
  if (next.effect !== 'read' && Object.prototype.hasOwnProperty.call(next, 'coverage')) {
    delete next.coverage;
  }
  const asIds = (value: unknown): string[] | null => (Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : null);
  const dataFrom = asIds(next.dataFrom);
  if (!dataFrom || dataFrom.length === 0) return next;
  const dependsOn = asIds(next.dependsOn);
  if (next.dependsOn !== undefined && dependsOn === null) return next;
  next.dependsOn = [...new Set([...(dependsOn ?? []), ...dataFrom])];
  if (next.effect === 'read') next.dataFrom = [];
  return next;
}

function stringList(value: unknown, label: string, errors: string[]): string[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return null;
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (!validId(entry, `${label}[${index}]`, errors)) continue;
    result.push(entry);
  }
  if (new Set(result).size !== result.length) errors.push(`${label} contains duplicate ids`);
  return [...result].sort();
}

function hasCycle(operations: readonly WorkTopologyOperationV1[]): boolean {
  const byId = new Map(operations.map((operation) => [operation.id, operation]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return operations.some((operation) => visit(operation.id));
}

/** Validate and canonicalize untrusted topology bytes. */
export function validateWorkTopology(value: unknown): WorkTopologyValidation {
  const errors: string[] = [];
  if (!plainRecord(value)) return { ok: false, errors: ['topology must be an object'] };
  exactKeys(value, ['version', 'operations', 'universes'], 'topology', errors);
  if (value.version !== WORK_TOPOLOGY_VERSION) errors.push('topology version must be 1');
  if (!Array.isArray(value.operations)) errors.push('topology operations must be an array');
  if (!Array.isArray(value.universes)) errors.push('topology universes must be an array');
  const rawOperations = Array.isArray(value.operations) ? value.operations : [];
  const rawUniverses = Array.isArray(value.universes) ? value.universes : [];
  if (rawOperations.length > WORK_TOPOLOGY_MAX_OPERATIONS) {
    errors.push(`topology exceeds ${WORK_TOPOLOGY_MAX_OPERATIONS} operations`);
  }
  if (rawUniverses.length > WORK_TOPOLOGY_MAX_UNIVERSES) {
    errors.push(`topology exceeds ${WORK_TOPOLOGY_MAX_UNIVERSES} universes`);
  }

  // Universe producers, read ahead of the operations so a producer's coverage
  // can be derived (see the read-shape derivation below).
  const completeSourceProducers = new Set<string>(
    rawUniverses.flatMap((universe) => (
      plainRecord(universe) && universe.seal === 'complete_source_receipt' && typeof universe.producedBy === 'string'
        ? [universe.producedBy]
        : []
    )),
  );
  const operations: WorkTopologyOperationV1[] = [];
  for (const [index, rawProposed] of rawOperations.entries()) {
    const label = `operation[${index}]`;
    if (!plainRecord(rawProposed)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const raw = normalizeProposedOperation(rawProposed);
    // Self-healing (live 2026-09-02): a read's coverage is DERIVABLE from what
    // the model already said when the meaning is unambiguous. A per-member
    // read (each) is coverage single; the once-read that produces a
    // complete-source universe is complete_set. The host derives those instead
    // of refusing and naming the fix — a chat turn died on that refusal, twice,
    // with a different guess each time. A finite caller set (set) claiming
    // whole-source exhaustion is NOT derived: that mismatch is a claim about
    // the source, so it still refuses with the fix named.
    if (raw.effect === 'read' && plainRecord(raw.cardinality)) {
      const kind = raw.cardinality.kind;
      if (kind === 'each') raw.coverage = 'single';
      else if (
        kind === 'once'
        && typeof raw.id === 'string'
        && completeSourceProducers.has(raw.id)
        && raw.coverage !== 'resolved_operation'
      ) raw.coverage = 'complete_set';
    }
    exactKeys(raw, ['id', 'effect', 'coverage', 'dependsOn', 'dataFrom', 'cardinality'], label, errors);
    const idOk = validId(raw.id, `${label}.id`, errors);
    const effectOk = raw.effect === 'read'
      || raw.effect === 'compute'
      || raw.effect === 'local_write'
      || raw.effect === 'external_write'
      || raw.effect === 'admin';
    if (!effectOk) errors.push(`${label}.effect is invalid`);
    const hasCoverage = Object.prototype.hasOwnProperty.call(raw, 'coverage');
    const coverageOk = raw.coverage === 'single'
      || raw.coverage === 'accepted_set'
      || raw.coverage === 'complete_set'
      || raw.coverage === 'resolved_operation';
    if (raw.effect === 'read' && !coverageOk) errors.push(`${label}.coverage is required for reads`);
    if (raw.effect !== 'read' && hasCoverage) errors.push(`${label}.coverage is only valid for reads`);
    const dependsOn = stringList(raw.dependsOn, `${label}.dependsOn`, errors);
    const dataFrom = stringList(raw.dataFrom, `${label}.dataFrom`, errors);
    if (!plainRecord(raw.cardinality)) {
      errors.push(`${label}.cardinality must be an object`);
      continue;
    }
    const cardinality = raw.cardinality;
    if (cardinality.kind === 'once') {
      exactKeys(cardinality, ['kind'], `${label}.cardinality`, errors);
    } else if (cardinality.kind === 'each' || cardinality.kind === 'set') {
      exactKeys(cardinality, ['kind', 'universeId'], `${label}.cardinality`, errors);
      validId(cardinality.universeId, `${label}.cardinality.universeId`, errors);
    } else {
      errors.push(`${label}.cardinality.kind is invalid`);
    }
    if (!idOk || !effectOk || !dependsOn || !dataFrom) continue;
    if (raw.effect === 'read' && dataFrom.length > 0) {
      errors.push(`${label}.dataFrom is not valid for a source read`);
    }
    for (const source of dataFrom) {
      if (!dependsOn.includes(source)) errors.push(`${label}.dataFrom ${source} must also be a dependency`);
    }
    if (
      raw.effect === 'read'
      && (
        (raw.coverage === 'accepted_set' && cardinality.kind !== 'set')
        || (cardinality.kind === 'set' && raw.coverage !== 'accepted_set')
        || (raw.coverage === 'complete_set' && cardinality.kind !== 'once')
        || (raw.coverage === 'resolved_operation' && cardinality.kind !== 'once')
        || (cardinality.kind === 'each' && raw.coverage !== 'single')
      )
    ) {
      // Name the fix (self-healing law): live 2026-09-01 a turn resent this
      // shape twice with a different guess each time and the loop floor stopped it.
      errors.push(`${label}.coverage and cardinality describe different read sets (valid pairs: coverage single with cardinality once or each; complete_set with once; resolved_operation with once; accepted_set with set)`);
    }
    if (cardinality.kind !== 'once' && cardinality.kind !== 'each' && cardinality.kind !== 'set') continue;
    operations.push({
      id: String(raw.id),
      effect: raw.effect as WorkTopologyEffectV1,
      ...(raw.effect === 'read' && coverageOk
        ? { coverage: raw.coverage as WorkTopologyCoverageV1 }
        : {}),
      dependsOn,
      dataFrom,
      cardinality: cardinality.kind === 'once'
        ? { kind: 'once' }
        : { kind: cardinality.kind, universeId: String(cardinality.universeId) },
    });
  }

  const universes: WorkTopologyUniverseV1[] = [];
  for (const [index, raw] of rawUniverses.entries()) {
    const label = `universe[${index}]`;
    if (!plainRecord(raw)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    const idOk = validId(raw.id, `${label}.id`, errors);
    if (raw.seal === 'accepted_input') {
      exactKeys(raw, ['id', 'seal', 'members'], label, errors);
      if (!Array.isArray(raw.members) || raw.members.length === 0) {
        errors.push(`${label}.members must contain at least one accepted item`);
        continue;
      }
      if (raw.members.length > WORK_TOPOLOGY_MAX_UNIVERSE_MEMBERS) {
        errors.push(`${label}.members exceeds ${WORK_TOPOLOGY_MAX_UNIVERSE_MEMBERS}`);
      }
      const members: string[] = [];
      for (const [memberIndex, member] of raw.members.entries()) {
        if (typeof member !== 'string' || !MEMBER_PATTERN.test(member)) {
          errors.push(`${label}.members[${memberIndex}] must be a bounded nonblank id`);
        } else {
          members.push(member);
        }
      }
      if (new Set(members).size !== members.length) errors.push(`${label}.members contains duplicates`);
      if (idOk) universes.push({ id: String(raw.id), seal: 'accepted_input', members: [...members].sort() });
    } else if (raw.seal === 'complete_source_receipt') {
      exactKeys(raw, ['id', 'seal', 'producedBy', 'memberIdPointer'], label, errors);
      const producerOk = validId(raw.producedBy, `${label}.producedBy`, errors);
      if (!isBoundedWorkTopologyJsonPointer(raw.memberIdPointer)) {
        errors.push(`${label}.memberIdPointer must be a bounded RFC 6901 pointer into one source record`);
      } else if (idOk && producerOk) {
        universes.push({
          id: String(raw.id),
          seal: 'complete_source_receipt',
          producedBy: String(raw.producedBy),
          memberIdPointer: raw.memberIdPointer,
        });
      }
    } else {
      exactKeys(raw, ['id', 'seal', 'members', 'producedBy', 'memberIdPointer'], label, errors);
      errors.push(`${label}.seal is invalid`);
    }
  }

  const operationIds = new Set<string>();
  for (const operation of operations) {
    if (operationIds.has(operation.id)) errors.push(`duplicate operation id ${operation.id}`);
    operationIds.add(operation.id);
  }
  const universeIds = new Set<string>();
  for (const universe of universes) {
    if (universeIds.has(universe.id)) errors.push(`duplicate universe id ${universe.id}`);
    if (operationIds.has(universe.id)) errors.push(`id ${universe.id} is shared by an operation and universe`);
    universeIds.add(universe.id);
  }
  const byOperation = new Map(operations.map((operation) => [operation.id, operation]));
  for (const operation of operations) {
    for (const dependency of operation.dependsOn) {
      if (!byOperation.has(dependency)) errors.push(`${operation.id} depends on missing operation ${dependency}`);
      if (dependency === operation.id) errors.push(`${operation.id} cannot depend on itself`);
    }
    for (const source of operation.dataFrom) {
      if (!byOperation.has(source)) errors.push(`${operation.id} reads data from missing operation ${source}`);
    }
    if (operation.cardinality.kind !== 'once' && !universeIds.has(operation.cardinality.universeId)) {
      errors.push(`${operation.id} references missing universe ${operation.cardinality.universeId}`);
    }
  }
  if (hasCycle(operations)) errors.push('operation dependencies must be acyclic');

  for (const universe of universes) {
    const consumers = operations.filter((operation) => (
      operation.cardinality.kind !== 'once' && operation.cardinality.universeId === universe.id
    ));
    if (consumers.length === 0) errors.push(`universe ${universe.id} has no cardinality consumer`);
    if (universe.seal === 'complete_source_receipt') {
      const producer = byOperation.get(universe.producedBy);
      if (
        !producer
        || producer.effect !== 'read'
        || producer.coverage !== 'complete_set'
        || producer.cardinality.kind !== 'once'
      ) {
        // Name the fix (live 2026-09-09, explicit Plan mode: the model named an
        // earlier turn's call id as the producer, was refused twice with only
        // the rule, and the turn died at the no-progress floor).
        errors.push(`universe ${universe.id} requires one complete-set source-read producer: set producedBy to a read operation in THIS topology with coverage "complete_set" and cardinality once (a call id or result from an earlier turn is not an operation), or seal the set as "accepted_input" with its member ids inline (up to ${WORK_TOPOLOGY_MAX_INLINE_MODEL_MEMBERS})`);
      }
      if (consumers.some((consumer) => consumer.id === universe.producedBy)) {
        errors.push(`universe ${universe.id} cannot be produced by its own each-cardinality consumer`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors: [...new Set(errors)].sort() };
  return {
    ok: true,
    topology: {
      version: WORK_TOPOLOGY_VERSION,
      operations: [...operations].sort((left, right) => left.id.localeCompare(right.id)),
      universes: [...universes].sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
}

export function canonicalWorkTopologyJson(value: unknown): string {
  return closedCanonicalJson(value, {
    maxDepth: 16,
    maxNodes: 20_000,
    maxStringBytes: 4_096,
    maxTotalBytes: 2_000_000,
  });
}

export function workTopologySha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function workTopologyDigest(topology: WorkTopologyV1): string {
  const validated = validateWorkTopology(topology);
  if (!validated.ok) throw new Error(`invalid work topology: ${validated.errors.join('; ')}`);
  return workTopologySha256(canonicalWorkTopologyJson(validated.topology));
}
