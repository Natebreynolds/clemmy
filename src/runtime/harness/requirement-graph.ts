/**
 * What an accepted task actually owes, as evidence obligations.
 *
 * Progress used to mean "a tool call succeeded". That is a statement about a
 * call, not about the work, so a task could make ten successful calls and
 * satisfy nothing — and a task that changed one argument could claim a new step
 * it had not taken. Obligations fix the unit: a requirement is satisfied once,
 * by evidence, and only the first time.
 *
 * These are shapes of work, not phases and not provider rules. Nothing here
 * names a vendor, a tool or a user; a task that reads from somewhere and writes
 * somewhere else owes the same five things whichever systems those are.
 */
import { appendEvent, listEvents } from './eventlog.js';

export type RequirementKind =
  /** A bounded, COMPLETE snapshot of the source — not a first page. */
  | 'source_snapshot'
  /** The requested representation, derived from that snapshot. */
  | 'derive_representation'
  /** The external effect actually committed. */
  | 'commit_effect'
  /** The committed content read back and matched. */
  | 'verify_committed'
  /** Every execution opened for this task closed. */
  | 'close_execution';

export interface Requirement {
  id: string;
  kind: RequirementKind;
  /** Human-readable, for traces and for what Clem tells the user. */
  description: string;
  /** Requirements that must be satisfied before this one can be. */
  dependsOn: string[];
  satisfied: boolean;
}

export interface RequirementGraph {
  requirements: Requirement[];
}

export interface CompileRequirementGraphInput {
  objective: string;
  /** True when the task commits an external effect. */
  mutating?: boolean;
}

/**
 * Does this objective move data from somewhere to somewhere else?
 *
 * Deliberately structural: a source-to-artifact shape is "obtain something,
 * then record it". The signal is the presence of BOTH a retrieval sense and a
 * persistence sense, not any particular noun — so a new connector needs no
 * change here.
 */
function looksSourceToArtifact(objective: string): boolean {
  const text = objective.toLowerCase();
  const retrieves = /\b(pull|read|list|fetch|get|export|collect|gather|retrieve|query)\b/.test(text);
  const persists = /\b(put|write|save|record|store|add|append|create|update|populate|into|onto)\b/.test(text);
  return retrieves && persists;
}

/**
 * Compile the obligations an accepted task carries.
 *
 * A read-only ask owes a complete snapshot and nothing else. A task that also
 * commits an effect owes the derivation, the commit, the verification, and a
 * closed execution — because "I sent it" is a claim about a request, and the
 * user asked about a result.
 */
export function compileRequirementGraph(
  input: CompileRequirementGraphInput,
): RequirementGraph {
  const sourceToArtifact = input.mutating ?? looksSourceToArtifact(input.objective);

  const snapshot: Requirement = {
    id: 'req:source_snapshot',
    kind: 'source_snapshot',
    description: 'Obtain a complete bounded snapshot of the source',
    dependsOn: [],
    satisfied: false,
  };
  if (!sourceToArtifact) return { requirements: [snapshot] };

  return {
    requirements: [
      snapshot,
      {
        id: 'req:derive_representation',
        kind: 'derive_representation',
        description: 'Derive the requested representation from that snapshot',
        dependsOn: [snapshot.id],
        satisfied: false,
      },
      {
        id: 'req:commit_effect',
        kind: 'commit_effect',
        description: 'Commit the external effect',
        dependsOn: ['req:derive_representation'],
        satisfied: false,
      },
      {
        id: 'req:verify_committed',
        kind: 'verify_committed',
        description: 'Read back the exact committed content and match it against the derivation',
        dependsOn: ['req:commit_effect'],
        satisfied: false,
      },
      {
        id: 'req:close_execution',
        kind: 'close_execution',
        description: 'Close every execution opened for this task',
        dependsOn: ['req:verify_committed'],
        satisfied: false,
      },
    ],
  };
}

// ── Per-task requirement state ───────────────────────────────────────────────

const graphs = new Map<string, RequirementGraph>();

function key(sessionId: string, sourceUserSeq: number): string {
  return `${sessionId}#${sourceUserSeq}`;
}

export function bindRequirementGraph(
  sessionId: string,
  sourceUserSeq: number,
  graph: RequirementGraph,
): void {
  graphs.set(key(sessionId, sourceUserSeq), graph);
}

export function getRequirementGraph(
  sessionId: string,
  sourceUserSeq: number,
): RequirementGraph | undefined {
  return graphs.get(key(sessionId, sourceUserSeq));
}

/**
 * Mark a requirement satisfied, returning true only the FIRST time.
 *
 * This is what earns progress and discovery authority. Pagination and retries
 * stay attached to an unsatisfied requirement and return false, so neither can
 * manufacture either.
 */
export function satisfyRequirement(
  sessionId: string,
  sourceUserSeq: number,
  requirementId: string,
): boolean {
  const graph = graphs.get(key(sessionId, sourceUserSeq));
  if (!graph) return false;
  const requirement = graph.requirements.find((entry) => entry.id === requirementId);
  if (!requirement || requirement.satisfied) return false;
  // An obligation cannot be satisfied before what it depends on.
  const blocked = requirement.dependsOn.some((id) =>
    !graph.requirements.find((entry) => entry.id === id)?.satisfied);
  if (blocked) return false;
  requirement.satisfied = true;
  return true;
}

export function unsatisfiedRequirements(
  sessionId: string,
  sourceUserSeq: number,
): Requirement[] {
  return (graphs.get(key(sessionId, sourceUserSeq))?.requirements ?? [])
    .filter((requirement) => !requirement.satisfied);
}

/**
 * Durability.
 *
 * A process-local Map forgets everything on restart — and a restart mid-task is
 * exactly when a task most needs to remember what it already proved, because
 * otherwise it redoes committed work or reports done on evidence it no longer
 * holds. State is persisted as a typed event and rehydrated from the log.
 */
export function persistRequirementState(sessionId: string, sourceUserSeq: number): void {
  const graph = graphs.get(key(sessionId, sourceUserSeq));
  if (!graph) return;
  try {
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'requirement_state',
      data: {
        sourceUserSeq,
        requirements: graph.requirements.map((r) => ({ id: r.id, kind: r.kind, satisfied: r.satisfied })),
      },
    });
  } catch { /* durability is best-effort; the in-process view still holds */ }
}

export function rehydrateRequirementState(
  sessionId: string,
  sourceUserSeq: number,
): RequirementGraph | undefined {
  const live = graphs.get(key(sessionId, sourceUserSeq));
  if (live) return live;
  try {
    const events = listEvents(sessionId, { types: ['requirement_state'] })
      .filter((event) => (event.data as Record<string, unknown>)?.sourceUserSeq === sourceUserSeq);
    const latest = events.at(-1);
    if (!latest) return undefined;
    const persisted = (latest.data as Record<string, unknown>).requirements as Array<{
      id: string; kind: RequirementKind; satisfied: boolean;
    }>;
    const graph: RequirementGraph = {
      requirements: persisted.map((r) => ({
        id: r.id,
        kind: r.kind,
        description: r.id,
        dependsOn: [],
        satisfied: r.satisfied,
      })),
    };
    graphs.set(key(sessionId, sourceUserSeq), graph);
    return graph;
  } catch {
    return undefined;
  }
}

/** Test seam; production state is bounded by process lifetime. */
export function _resetRequirementGraphsForTests(): void {
  graphs.clear();
}

// ── Evidence-bearing satisfaction ────────────────────────────────────────────

export interface ObligationEvidence {
  sessionId: string;
  sourceUserSeq: number;
  /** Immutable graph the obligation belongs to. */
  graphId: string;
  nodeId: string;
  obligation: string;
  /** Redeemable reference — a result handle, receipt, or artifact id. */
  evidenceRef: string;
  physicalAttemptId: string;
}

/**
 * Satisfy an obligation AND persist the transition, atomically at the
 * linearization point.
 *
 * Two properties the previous version lacked. First, satisfaction requires a
 * redeemable evidence reference: a bare boolean is the thing being audited, and
 * an audit that believes it proves nothing. Second, persistence happens here
 * rather than in a separate call a caller must remember — and if persistence
 * fails, the in-memory state is NOT left authoritative, because a satisfaction
 * that only exists in this process can permit `done` and then vanish.
 */
export function satisfyRequirementWithEvidence(evidence: ObligationEvidence): boolean {
  if (!evidence.evidenceRef?.trim()) return false;
  try {
    appendEvent({
      sessionId: evidence.sessionId,
      turn: 0,
      role: 'system',
      type: 'requirement_state',
      data: {
        sourceUserSeq: evidence.sourceUserSeq,
        graphId: evidence.graphId,
        nodeId: evidence.nodeId,
        obligation: evidence.obligation,
        evidenceRef: evidence.evidenceRef,
        physicalAttemptId: evidence.physicalAttemptId,
        satisfiedAt: new Date().toISOString(),
      },
    });
  } catch {
    // Durable record failed: refuse the satisfaction rather than hold an
    // authoritative one that cannot survive a restart.
    return false;
  }
  return true;
}

/** Obligations with redeemable evidence, folded from durable transitions. */
export function redeemedObligations(
  sessionId: string,
  sourceUserSeq: number,
): Array<{ obligation: string; evidenceRef: string; nodeId: string }> {
  try {
    return listEvents(sessionId, { types: ['requirement_state'] })
      .map((event) => event.data as Record<string, unknown>)
      .filter((data) => data?.sourceUserSeq === sourceUserSeq && typeof data?.evidenceRef === 'string')
      .map((data) => ({
        obligation: String(data.obligation ?? ''),
        evidenceRef: String(data.evidenceRef ?? ''),
        nodeId: String(data.nodeId ?? ''),
      }))
      .filter((entry) => entry.obligation && entry.evidenceRef);
  } catch {
    return [];
  }
}

/** Obligations the task incurred that have no redeemable evidence yet. */
export function outstandingObligations(
  sessionId: string,
  sourceUserSeq: number,
): string[] {
  const satisfied = new Set(redeemedObligations(sessionId, sourceUserSeq).map((e) => e.obligation));
  const graph = graphs.get(key(sessionId, sourceUserSeq));
  if (!graph) return [];
  return graph.requirements
    .map((requirement) => requirement.id)
    .filter((id) => !satisfied.has(id));
}
