/**
 * ProjectPlan IR — the executable, provider-neutral description of a project's
 * TOPOLOGY.
 *
 * A read-only planner emits this; `project-compiler.ts` turns it into ordinary
 * `WorkflowDefinition` steps. Nothing here executes, and nothing here can grant
 * authority: a plan may *request* an effect, but the runtime tool boundary
 * remains the only thing that can permit one.
 *
 * WHY AN IR AT ALL
 *
 * The failure this exists to prevent was not a bad model decision. It was that
 * long work had no shape: a whole project was served inside one chat turn until
 * it hit the tool ceiling with nothing durable to resume from. A plan needs to
 * be a value the runtime can validate, hash, split into bounded nodes, and
 * re-enter — before any work starts.
 *
 * WHAT MAKES THIS GENERIC
 *
 * Node *instances* carry specific assignments ("read the records closing this
 * month"). Node *semantics* never do. There is no notion here of any product,
 * provider, or artifact kind. A node is:
 *
 *   a dependency position, an executor, an effect class, an evidence contract,
 *   an approval disposition, a retry/turn budget, and optionally a fan-out
 *   source.
 *
 * Those seven axes are deliberately INDEPENDENT. Collapsing any two of them is
 * how domain assumptions get smuggled in — "this is a publish node, therefore
 * it needs approval, therefore it is last" bakes a use case into the topology.
 *
 * IDENTITY IS CANONICAL, NOT AUTHORED
 *
 * Set-like fields (the node list, dependencies, capability lists, evidence
 * paths) carry no order. They are canonicalized once, and everything
 * downstream — the hash, the compiled definition, the definition hash — is
 * derived from the canonical form. Two plans that differ only in how their
 * author happened to order a set are the same plan, byte for byte.
 */
import { createHash } from 'node:crypto';

import { TOOL_REGISTRY } from '../tools/tool-registry.js';

/**
 * Where a node's work happens.
 *
 * `read` touches nothing outside this machine. `local_write` produces durable
 * local artifacts. `external_write` asks to change state the user does not own
 * exclusively. The class is a REQUEST, never a permission — and see
 * `ExternalWriteBinding` for why `external_write` currently cannot compile.
 */
export type ProjectEffectClass = 'read' | 'local_write' | 'external_write';

/**
 * Whether this node must pause for a human. Declared independently of the
 * effect class so validation can catch a plan whose two claims disagree,
 * instead of silently believing whichever one it read last.
 */
export type ProjectApprovalDisposition = 'not_required' | 'required';

export type ProjectContractType = 'string' | 'number' | 'boolean' | 'object' | 'array';

/**
 * The shape a node occupies in the project, as a scheduling / model-profile
 * hint.
 *
 * `specialist` is one branch of a fan-out; `reducer` converges two or more
 * branches; `brain` is the terminal verification or synthesis node.
 *
 * A role grants NOTHING. It carries no tool, no mutation authority, and no
 * approval — capability lives in `allowedTools` and effect in `effect`, both
 * validated independently. Keeping the role on its own axis is what stops it
 * becoming a back door: "this is a brain node, therefore it may reach more"
 * is exactly the inference this type must never license.
 *
 * Roles are DECLARED by the planner and never inferred from prompt wording.
 */
export type ProjectExecutionRole = 'specialist' | 'reducer' | 'brain';

/**
 * What this node must be able to SHOW for its result to count.
 *
 * Validated deeply, because a contract is only worth the strictness of its
 * weakest field: `[null]`, `['']`, `['a..b']`, and a bare item count are all
 * shapes that LOOK like evidence and prove nothing.
 */
export interface ProjectEvidenceContract {
  type?: ProjectContractType;
  /** Top-level keys that must be present on an object result. */
  requiredKeys?: string[];
  /** Dot-paths whose value must be non-empty. */
  nonEmpty?: string[];
  /**
   * Dot-path → minimum array length.
   *
   * Deliberately never sufficient on its own: an array of N empty objects
   * satisfies a length bound while proving nothing about content.
   */
  minItems?: Record<string, number>;
  /** Concrete handles checked for real existence, not just shape. */
  verify?: {
    pathExists?: string[];
    urlPresent?: string[];
  };
  description?: string;
}

/**
 * How the node does its work.
 *
 * `model` is reasoning under a bounded turn budget and an EXPLICIT capability
 * list. `structured_call` is an exact, pre-named tool invocation with frozen
 * arguments and no model turn at all.
 *
 * Which one a node uses says nothing about its effect class: a structured call
 * can be a pure read, and a model node can request a local write.
 */
export type ProjectExecutor =
  | {
    kind: 'model';
    /** The node's assignment. Specific by nature; the runtime treats it as opaque. */
    instruction: string;
    /**
     * Exact capability list for this node.
     *
     * Omitting it does NOT mean "no tools" — downstream, an omitted or empty
     * list is legacy wildcard authority. So the compiler always emits an
     * explicit, non-empty list: either this one, or the read-only discovery
     * kernel for a node that only reasons over evidence already collected.
     */
    allowedTools?: string[];
  }
  | {
    kind: 'structured_call';
    /** Exact tool identifier. Never a pattern, never templated. */
    tool: string;
    /** Frozen arguments. Templating into upstream outputs is allowed; the
     *  SHAPE is fixed at plan time. */
    args?: Record<string, unknown>;
    /** Optional human-readable note; carries no execution meaning. */
    instruction?: string;
  };

/**
 * Run this node once per item produced by an upstream node.
 *
 * The source must be a declared dependency, so a plan cannot fan out over data
 * that nothing in the graph is responsible for producing.
 */
export interface ProjectFanOut {
  /** Node id whose output supplies the items. */
  fromNode: string;
  /** Optional dot-path into that node's output. Omitted = the output itself. */
  path?: string;
  /** Only items not already processed by a previous run of this workflow. */
  newOnly?: boolean;
}

/**
 * Everything an external provider write would have to prove BEFORE it runs.
 *
 * This type exists to state the requirement precisely rather than gesture at
 * it. It is deliberately not satisfiable by prose: an approval must name the
 * exact operation, the account/resource it acts on, the destination, a digest
 * of the exact arguments, and the plan digest it was granted against — and the
 * readback must be a real provider observation, not a local path or URL string.
 *
 * `WorkflowStepInput` has no field that carries any of this. `requiresApproval`
 * is a boolean, `approvalPreview` is display text, and a mutation receipt is
 * EXECUTION evidence recorded after dispatch, not prior authority. So the
 * compiler refuses `external_write` outright instead of encoding authority in a
 * preview string. See `project-compiler.ts`.
 */
export interface ExternalWriteBinding {
  /** Exact provider operation this approval was granted for. */
  operation: string;
  /** Account or resource identity the operation acts on. */
  accountRef: string;
  /** Destination identity (site, container, record set, …). */
  target: string;
  /** Digest of the exact frozen arguments. */
  argumentsDigest: string;
  /** Plan digest this approval was granted against. */
  planDigest: string;
  /** The approval that already exists. Never minted by a plan. */
  priorApprovalId: string;
  /** Independent provider readback proving the write landed. */
  readback: {
    operation: string;
    expect: ProjectEvidenceContract;
  };
}

export interface ProjectNode {
  /** Stable identity. Becomes the workflow step id, so it must round-trip. */
  id: string;
  /** Short generic label of the node's role, for operators reading a plan. */
  label?: string;
  /** Ids this node waits on. Absent/empty = an entry node. */
  dependsOn?: string[];
  executor: ProjectExecutor;
  effect: ProjectEffectClass;
  evidence?: ProjectEvidenceContract;
  /** Omitted is not "no": the compiler derives the safe default per effect. */
  approval?: ProjectApprovalDisposition;
  /** Shown on the approval card. Never carries authority. */
  approvalPreview?: string;
  /** Required for `external_write`; see ExternalWriteBinding. */
  externalWrite?: ExternalWriteBinding;
  /** Additional attempts after the first failure. */
  retries?: number;
  /** Model turns THIS node may spend. Per node, never a project horizon. */
  maxTurns?: number;
  /** Scheduling / model-profile hint. Grants no authority; see the type. */
  executionRole?: ProjectExecutionRole;
  fanOut?: ProjectFanOut;
}

export interface ProjectPlan {
  /**
   * Stable identity for this plan's lineage; becomes the workflow name.
   * Must already BE its slug — see `planIdError`.
   */
  planId?: string;
  /** What the user asked for, in their terms. Opaque to this module. */
  objective: string;
  nodes: ProjectNode[];
}

/**
 * Hard PER-NODE turn ceiling.
 *
 * This bounds one node's model turns. It is NOT a whole-project horizon and it
 * is NOT the harness `toolCallsPerTurn` limit — a project may contain many
 * nodes each budgeted up to this value, which is exactly how long work stays
 * resumable instead of dying inside one turn.
 */
export const PROJECT_NODE_TURN_CEILING = 64;

/**
 * Default turns per node — deliberately far below the ceiling.
 *
 * A node that genuinely needs dozens of turns is a node that should have been
 * several nodes, so the default stays tight and an author must ask for more in
 * the open, where validation can see it.
 */
export const PROJECT_NODE_DEFAULT_MAX_TURNS = 8;

/**
 * The structural capability universe every workflow step already has.
 *
 * These are the channels the runtime allows for EVERY step regardless of its
 * lock (`makeStepToolAllow`): the output channel a step needs to return at all,
 * the report channel, and the recall/artifact readers. They are declared here
 * rather than imported because this module is deliberately dependency-light —
 * importing the step-agent module pulls the whole agent/SDK graph in and closes
 * an import cycle. `project-plan-ir.test.ts` asserts this list equals
 * `STEP_STRUCTURAL_BASELINE_TOOLS` exactly, so drift breaks loudly instead of
 * silently narrowing or widening what a compiled node may do.
 *
 * The compiler unions this into every node's list rather than relying on the
 * implicit allowance, because a compiled project node's `allowedTools` is also
 * its auto-approval scope — leaving the channels implicit would hand a step a
 * tool it may use but must still stop to approve, and would leave a node with
 * no authored tools holding an EMPTY list, which downstream reads as legacy
 * wildcard authority rather than as "nothing".
 *
 * `workflow_step_result` is intentionally not a catalog tool: it is a
 * per-step structural channel, so registry membership is not required of it.
 * What IS required is that no member is a mutating catalog tool.
 */
export const PROJECT_STRUCTURAL_TOOLS: readonly string[] = Object.freeze([
  'notify_user',
  'read_file',
  'recall_tool_result',
  'tool_output_query',
  'workflow_step_result',
  'workspace_artifact_query',
]);

/**
 * A node that authors no tools receives exactly the structural set: it can
 * reason, read back its upstream artifacts, and publish a result — but cannot
 * dispatch a new provider call.
 */
export const PROJECT_DISCOVERY_KERNEL = PROJECT_STRUCTURAL_TOOLS;

const REGISTRY_BY_NAME = new Map(TOOL_REGISTRY.map((decl) => [decl.name, decl]));

/** A tool the canonical registry classifies as a pure read. */
export function toolIsCanonicalRead(name: string): boolean {
  return REGISTRY_BY_NAME.get(name)?.sideEffect === 'read';
}

/** A tool the canonical registry knows about at all. */
export function toolIsCanonicallyKnown(name: string): boolean {
  return REGISTRY_BY_NAME.has(name);
}

/**
 * The kernel is only usable if the registry still agrees every member is a
 * read. Proven once at module load so a registry change that reclassifies a
 * kernel tool breaks loudly here rather than quietly widening node authority.
 */
export const PROJECT_DISCOVERY_KERNEL_ERRORS: readonly string[] = Object.freeze(
  PROJECT_STRUCTURAL_TOOLS.flatMap((name) => {
    // A structural channel need not be a catalog tool (workflow_step_result is
    // registered per step). But if the registry DOES know it, it must still be
    // read-class — that is the check that stops a reclassification quietly
    // handing every compiled node a mutating capability.
    if (toolIsCanonicallyKnown(name) && !toolIsCanonicalRead(name)) {
      return [`structural tool "${name}" is no longer classified read-only`];
    }
    return [];
  }),
);

const WILDCARD_TOOL = '*';
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** A planId must already be a safe slug: no transformation, no ambiguity. */
const PLAN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
/** Dot/bracket path into an output. No empty segments, no traversal. */
const DOT_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/;

export interface ProjectPlanValidation {
  ok: boolean;
  errors: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function effectIsExternal(effect: ProjectEffectClass): boolean {
  return effect === 'external_write';
}

/** The approval disposition an effect class implies when the plan omits one. */
export function defaultApprovalFor(effect: ProjectEffectClass): ProjectApprovalDisposition {
  return effectIsExternal(effect) ? 'required' : 'not_required';
}

/** Why this planId is unusable, or null. */
export function planIdError(planId: unknown): string | null {
  if (!nonEmptyString(planId)) return 'planId must be a non-empty string.';
  const trimmed = planId.trim();
  if (!PLAN_ID_RE.test(trimmed)) {
    return `planId "${trimmed}" is not a safe identity; use lowercase letters, digits and inner dashes (max 48), already in slug form.`;
  }
  return null;
}

/**
 * Sorted, de-duplicated copy of a set-like string list.
 *
 * Deliberately does NOT coerce. An earlier version mapped entries through
 * String(), which turned `[null]` into `["null"]` — a perfectly valid-looking
 * dot-path — so canonicalization laundered invalid input past validation.
 * Anything that is not already a clean list of strings is returned untouched,
 * so the validator sees exactly what the author wrote and can reject it.
 */
function canonicalStringSet(values: readonly unknown[]): unknown[] {
  if (!values.every((entry) => typeof entry === 'string')) return [...values];
  return [...new Set(values as string[])].sort();
}

/**
 * Canonicalize every set-like field.
 *
 * The node list is a set keyed by id; dependencies, capability lists, and
 * evidence path lists are all sets. `args` and `minItems` are objects, whose
 * key order is normalized by the canonical encoder rather than here — their
 * VALUES are author payload and are never rewritten.
 */
export function canonicalProjectPlan(plan: ProjectPlan): ProjectPlan {
  const canonicalEvidence = (evidence?: ProjectEvidenceContract): ProjectEvidenceContract | undefined => {
    if (!isPlainObject(evidence)) return evidence;
    const next: ProjectEvidenceContract = { ...evidence };
    if (Array.isArray(evidence.requiredKeys)) next.requiredKeys = canonicalStringSet(evidence.requiredKeys) as string[];
    if (Array.isArray(evidence.nonEmpty)) next.nonEmpty = canonicalStringSet(evidence.nonEmpty) as string[];
    if (isPlainObject(evidence.verify)) {
      const verify = evidence.verify as NonNullable<ProjectEvidenceContract['verify']>;
      next.verify = {
        ...(Array.isArray(verify.pathExists) ? { pathExists: canonicalStringSet(verify.pathExists) as string[] } : {}),
        ...(Array.isArray(verify.urlPresent) ? { urlPresent: canonicalStringSet(verify.urlPresent) as string[] } : {}),
      };
    }
    return next;
  };

  const nodes = [...(plan.nodes ?? [])]
    .sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')))
    .map((node) => {
      if (!isPlainObject(node)) return node;
      const next: ProjectNode = { ...node };
      if (Array.isArray(node.dependsOn)) next.dependsOn = canonicalStringSet(node.dependsOn) as string[];
      const executor = node.executor as ProjectExecutor | undefined;
      if (executor && executor.kind === 'model' && Array.isArray(executor.allowedTools)) {
        next.executor = { ...executor, allowedTools: canonicalStringSet(executor.allowedTools) as string[] };
      }
      const evidence = canonicalEvidence(node.evidence);
      if (evidence !== undefined) next.evidence = evidence;
      return next;
    });
  return { ...plan, nodes };
}

/** Deep validation of one evidence contract. Returns error fragments. */
function evidenceErrors(evidence: ProjectEvidenceContract | undefined, where: string): string[] {
  if (evidence === undefined) return [];
  if (!isPlainObject(evidence)) return [`${where} evidence must be an object.`];
  const errors: string[] = [];

  const pathList = (values: unknown, field: string): void => {
    if (values === undefined) return;
    if (!Array.isArray(values) || values.length === 0) {
      errors.push(`${where} evidence.${field} must be a non-empty array of dot-paths.`);
      return;
    }
    for (const entry of values) {
      if (!nonEmptyString(entry)) {
        errors.push(`${where} evidence.${field} contains a non-string or empty entry.`);
      } else if (!DOT_PATH_RE.test(entry.trim())) {
        errors.push(`${where} evidence.${field} entry "${String(entry)}" is not a valid dot-path.`);
      }
    }
  };

  if (evidence.verify !== undefined && !isPlainObject(evidence.verify)) {
    errors.push(`${where} evidence.verify must be an object.`);
  }

  pathList(evidence.requiredKeys, 'requiredKeys');
  pathList(evidence.nonEmpty, 'nonEmpty');
  if (isPlainObject(evidence.verify)) {
    pathList(evidence.verify.pathExists, 'verify.pathExists');
    pathList(evidence.verify.urlPresent, 'verify.urlPresent');
  }

  if (evidence.minItems !== undefined) {
    if (!isPlainObject(evidence.minItems)) {
      errors.push(`${where} evidence.minItems must be an object of dot-path → count.`);
    } else {
      for (const [key, count] of Object.entries(evidence.minItems)) {
        if (!DOT_PATH_RE.test(key)) errors.push(`${where} evidence.minItems key "${key}" is not a valid dot-path.`);
        if (!Number.isSafeInteger(count) || (count as number) < 0) {
          errors.push(`${where} evidence.minItems["${key}"] must be a non-negative integer.`);
        }
      }
    }
  }
  if (evidence.type !== undefined
    && !['string', 'number', 'boolean', 'object', 'array'].includes(evidence.type as string)) {
    errors.push(`${where} evidence.type is not a supported contract type.`);
  }
  return errors;
}

/** Deep validation of an external-write binding, when one is supplied. */
function externalWriteBindingErrors(node: ProjectNode, where: string): string[] {
  const binding = node.externalWrite;
  if (binding === undefined) {
    return [`${where} requests an external write without an externalWrite binding (operation, accountRef, target, argumentsDigest, planDigest, priorApprovalId, readback).`];
  }
  if (!isPlainObject(binding)) return [`${where} externalWrite must be an object.`];
  const errors: string[] = [];
  for (const field of ['operation', 'accountRef', 'target', 'argumentsDigest', 'planDigest', 'priorApprovalId'] as const) {
    if (!nonEmptyString(binding[field])) errors.push(`${where} externalWrite.${field} is required.`);
  }
  for (const field of ['argumentsDigest', 'planDigest'] as const) {
    if (nonEmptyString(binding[field]) && !/^[a-f0-9]{64}$/.test(binding[field].trim())) {
      errors.push(`${where} externalWrite.${field} must be a sha256 digest.`);
    }
  }
  if (!isPlainObject(binding.readback) || !nonEmptyString(binding.readback?.operation)) {
    errors.push(`${where} externalWrite.readback.operation is required — a provider observation, not a local handle.`);
  } else {
    errors.push(...evidenceErrors(binding.readback.expect, `${where} externalWrite.readback`));
    const expect = binding.readback.expect;
    const provesContent = (expect?.requiredKeys?.length ?? 0) > 0 || (expect?.nonEmpty?.length ?? 0) > 0;
    if (!provesContent) {
      errors.push(`${where} externalWrite.readback.expect must assert content, not merely a shape or a count.`);
    }
  }
  return errors;
}

/** Depth-first cycle detection over the declared dependency edges. */
function findCycle(nodes: readonly ProjectNode[]): string[] | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const current = state.get(id);
    if (current === 'done') return null;
    if (current === 'visiting') {
      const start = stack.indexOf(id);
      return [...stack.slice(start >= 0 ? start : 0), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue; // dangling edges are reported separately
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}

/**
 * Topology invariants, expressed as REACHABILITY rather than adjacency.
 *
 * The previous version demanded that an immediate child join every sibling,
 * which is a template, not an invariant: it rejected perfectly sound graphs
 * that converge further downstream (a → {b,c} → {d,e} → f). What actually
 * matters is that the project has ONE answer and that no work is stranded —
 * both of which are reachability questions:
 *
 *   - exactly one terminal sink, and
 *   - every node can reach it.
 *
 * That is deliberately weaker than the old rule and strictly more correct. It
 * still rejects an orphan branch (its own sink) and two competing answers, and
 * it never prescribes a shape.
 */
function topologyErrors(nodes: readonly ProjectNode[]): string[] {
  const errors: string[] = [];
  const ids = nodes.map((node) => node.id);
  const dependentsOf = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      dependentsOf.get(dep)?.push(node.id);
    }
  }

  const sinks = ids.filter((id) => (dependentsOf.get(id) ?? []).length === 0);
  if (nodes.length > 1 && sinks.length !== 1) {
    errors.push(
      `Project must converge on exactly one terminal node; found ${sinks.length} (${[...sinks].sort().join(', ')}). `
      + 'Add a reducer or verification sink that every open branch reaches.',
    );
    return errors;
  }

  const sink = sinks[0];
  if (nodes.length > 1 && sink) {
    // Forward reachability from every node to the single sink. A node that
    // cannot reach it is stranded work, whatever its depth.
    const reachesSink = new Set<string>([sink]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of nodes) {
        if (reachesSink.has(node.id)) continue;
        if ((dependentsOf.get(node.id) ?? []).some((child) => reachesSink.has(child))) {
          reachesSink.add(node.id);
          grew = true;
        }
      }
    }
    const stranded = ids.filter((id) => !reachesSink.has(id)).sort();
    if (stranded.length > 0) {
      errors.push(
        `Nodes ${stranded.join(', ')} never reach the terminal node "${sink}"; `
        + 'every branch must feed the project\'s single result.',
      );
    }
  }

  return errors;
}

/**
 * Execution-role invariants.
 *
 * A role is a hint, so these check only that the hint is STRUCTURALLY honest —
 * a node calling itself a reducer that joins nothing would mislead whatever
 * picks a model profile for it.
 */
function executionRoleErrors(nodes: readonly ProjectNode[]): string[] {
  const errors: string[] = [];
  const ids = nodes.map((node) => node.id);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const dependentsOf = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) dependentsOf.get(dep)?.push(node.id);
  }

  /** Every node forward-reachable from `from`, excluding itself. */
  const descendantsOf = (from: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [...(dependentsOf.get(from) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(dependentsOf.get(next) ?? []));
    }
    return seen;
  };

  for (const node of nodes) {
    const role = node.executionRole;
    if (role === undefined) continue;
    if (role !== 'specialist' && role !== 'reducer' && role !== 'brain') {
      errors.push(`node "${node.id}" executionRole must be specialist, reducer, or brain.`);
      continue;
    }
    const where = `node "${node.id}"`;

    if (role === 'specialist') {
      const dependents = dependentsOf.get(node.id) ?? [];
      if (dependents.length === 0) {
        errors.push(`${where} is a specialist but is terminal; a specialist is one branch, not the answer.`);
      } else if (![...descendantsOf(node.id)].some((id) => byId.get(id)?.executionRole === 'reducer')) {
        errors.push(`${where} is a specialist but reaches no reducer; a branch must be joined by one.`);
      }
    }

    if (role === 'reducer') {
      const upstream = (node.dependsOn ?? []).length;
      if (upstream < 2) {
        errors.push(`${where} is a reducer but converges ${upstream} upstream branch(es); a reducer joins at least two.`);
      }
    }
  }

  return errors;
}

/**
 * Validate a plan. Returns EVERY problem rather than the first, so an author
 * fixes one plan instead of discovering one error per attempt.
 *
 * Validation runs on the CANONICAL plan, so a caller cannot pass by presenting
 * the same content in a different order.
 */
export function validateProjectPlan(plan: unknown): ProjectPlanValidation {
  const errors: string[] = [...PROJECT_DISCOVERY_KERNEL_ERRORS];

  if (!isPlainObject(plan)) {
    return { ok: false, errors: ['Project plan must be an object.'] };
  }
  const draft = plan as Partial<ProjectPlan>;

  if (!nonEmptyString(draft.objective)) {
    errors.push('Project plan requires a non-empty objective.');
  }
  if (draft.planId !== undefined) {
    const idError = planIdError(draft.planId);
    if (idError) errors.push(idError);
  }
  if (!Array.isArray(draft.nodes) || draft.nodes.length === 0) {
    errors.push('Project plan requires at least one node.');
    return { ok: false, errors };
  }
  if (!draft.nodes.every((node) => isPlainObject(node))) {
    errors.push('Every project node must be an object.');
    return { ok: false, errors };
  }

  const nodes = canonicalProjectPlan(draft as ProjectPlan).nodes;
  const seen = new Set<string>();

  for (const [index, node] of nodes.entries()) {
    const where = nonEmptyString(node.id) ? `node "${node.id}"` : `node at index ${index}`;

    if (!nonEmptyString(node.id) || !ID_RE.test(node.id)) {
      errors.push(`${where} needs an id of letters, digits, dashes or underscores (max 64).`);
    } else if (seen.has(node.id)) {
      errors.push(`Duplicate node id "${node.id}".`);
    } else {
      seen.add(node.id);
    }

    // --- executor -----------------------------------------------------------
    const executor = node.executor as ProjectExecutor | undefined;
    if (!isPlainObject(executor)) {
      errors.push(`${where} requires an executor.`);
    } else if (executor.kind === 'model') {
      if (!nonEmptyString(executor.instruction)) {
        errors.push(`${where} model executor requires a non-empty instruction.`);
      }
      const tools = executor.allowedTools;
      if (tools !== undefined) {
        if (!Array.isArray(tools) || tools.length === 0 || tools.some((tool) => !nonEmptyString(tool))) {
          errors.push(`${where} allowedTools, when present, must be a non-empty list of tool names.`);
        } else if (tools.includes(WILDCARD_TOOL)) {
          errors.push(`${where} may not request wildcard tool authority ("${WILDCARD_TOOL}").`);
        } else {
          for (const tool of tools) {
            if (!toolIsCanonicallyKnown(tool)) {
              errors.push(`${where} names unknown tool "${tool}"; a capability list must be exact.`);
            }
          }
        }
      }
    } else if (executor.kind === 'structured_call') {
      if (!nonEmptyString(executor.tool)) {
        errors.push(`${where} structured call requires an exact tool name.`);
      } else if (/[*{}]|\s/.test(executor.tool)) {
        errors.push(`${where} structured call tool "${executor.tool}" must be an exact name, not a pattern or template.`);
      } else if (!toolIsCanonicallyKnown(executor.tool)) {
        errors.push(`${where} structured call names unknown tool "${executor.tool}".`);
      } else if (!toolIsCanonicalRead(executor.tool)) {
        // A non-read structured call is the family that would need the prior
        // approval binding the definition cannot carry, so it is refused at the
        // same boundary as external_write rather than compiled hopefully.
        errors.push(`${where} structured call "${executor.tool}" is not a canonical read; only read-class structured calls are supported.`);
      }
      if (executor.args !== undefined && !isPlainObject(executor.args)) {
        errors.push(`${where} structured call args must be an object.`);
      }
    } else {
      errors.push(`${where} has an unknown executor kind.`);
    }

    // --- effect / approval --------------------------------------------------
    const effect = node.effect;
    if (effect !== 'read' && effect !== 'local_write' && effect !== 'external_write') {
      errors.push(`${where} requires an effect of read, local_write, or external_write.`);
    } else {
      const approval = node.approval;
      if (approval !== undefined && approval !== 'required' && approval !== 'not_required') {
        errors.push(`${where} approval must be required or not_required.`);
      } else if (effectIsExternal(effect) && approval === 'not_required') {
        errors.push(`${where} requests an external write but declares approval not_required; a plan cannot waive approval.`);
      } else if (!effectIsExternal(effect) && approval === 'required') {
        // No external boundary to approve: the pause would be theatre and would
        // train users to click through the ones that matter.
        errors.push(`${where} declares approval required but its effect (${effect}) crosses no external boundary.`);
      }

      if (effectIsExternal(effect)) {
        if (isPlainObject(executor) && (executor as { kind?: string }).kind !== 'structured_call') {
          errors.push(`${where} requests an external write from a model executor; an external write must be an exact structured call.`);
        }
        errors.push(...externalWriteBindingErrors(node, where));
      }
    }

    if (node.approvalPreview !== undefined && !nonEmptyString(node.approvalPreview)) {
      errors.push(`${where} approvalPreview, when present, must be a non-empty string.`);
    }

    errors.push(...evidenceErrors(node.evidence, where));

    // --- budgets (each node independently) ----------------------------------
    if (node.maxTurns !== undefined) {
      if (!Number.isSafeInteger(node.maxTurns) || node.maxTurns <= 0) {
        errors.push(`${where} maxTurns must be a positive integer.`);
      } else if (node.maxTurns > PROJECT_NODE_TURN_CEILING) {
        errors.push(`${where} maxTurns ${node.maxTurns} exceeds the ${PROJECT_NODE_TURN_CEILING}-turn per-node ceiling; split the work into more nodes.`);
      }
    }
    if (node.retries !== undefined && (!Number.isSafeInteger(node.retries) || node.retries < 0)) {
      errors.push(`${where} retries must be a non-negative integer.`);
    }
    if (node.executionRole !== undefined
      && !['specialist', 'reducer', 'brain'].includes(node.executionRole as string)) {
      errors.push(`${where} executionRole must be specialist, reducer, or brain.`);
    }

    // --- dependencies -------------------------------------------------------
    if (node.dependsOn !== undefined) {
      if (!Array.isArray(node.dependsOn) || node.dependsOn.some((dep) => !nonEmptyString(dep))) {
        errors.push(`${where} dependsOn must be a list of node ids.`);
      } else if (node.dependsOn.includes(node.id)) {
        errors.push(`${where} depends on itself.`);
      }
    }

    // --- fan-out ------------------------------------------------------------
    if (node.fanOut !== undefined) {
      if (!isPlainObject(node.fanOut) || !nonEmptyString(node.fanOut.fromNode)) {
        errors.push(`${where} fanOut requires a fromNode.`);
      } else if (!(node.dependsOn ?? []).includes(node.fanOut.fromNode)) {
        errors.push(`${where} fans out from "${node.fanOut.fromNode}", which is not one of its declared dependencies.`);
      }
      if (isPlainObject(node.fanOut) && node.fanOut.path !== undefined) {
        if (!nonEmptyString(node.fanOut.path)) {
          errors.push(`${where} fanOut path, when present, must be a non-empty dot-path.`);
        } else if (!DOT_PATH_RE.test(node.fanOut.path.trim())) {
          errors.push(`${where} fanOut path "${node.fanOut.path}" is not a valid dot-path.`);
        }
      }
      // A dynamic aggregate is an ordinary node output: how many consumers it
      // has is a reachability question, handled by topologyErrors. Per-item
      // work that MUTATES is different — it has no per-item approval or receipt
      // story in this IR, so it is refused rather than silently fanned out.
      if (node.effect !== 'read') {
        errors.push(`${where} fans out with effect "${node.effect}"; only read-class per-item work is supported.`);
      }
    }
  }

  // --- graph-level ----------------------------------------------------------
  const declared = new Set(nodes.filter((node) => nonEmptyString(node.id)).map((node) => node.id));
  for (const node of nodes) {
    if (!nonEmptyString(node.id)) continue;
    for (const dep of node.dependsOn ?? []) {
      if (nonEmptyString(dep) && !declared.has(dep)) {
        errors.push(`Node "${node.id}" depends on "${dep}", which no node declares.`);
      }
    }
    if (node.fanOut?.fromNode && !declared.has(node.fanOut.fromNode)) {
      errors.push(`Node "${node.id}" fans out from "${node.fanOut.fromNode}", which no node declares.`);
    }
  }

  const wellFormed = nodes.filter((node) => nonEmptyString(node.id));
  const cycle = findCycle(wellFormed);
  if (cycle) errors.push(`Project plan has a dependency cycle: ${cycle.join(' -> ')}.`);

  // Topology only means anything once the edges are sound.
  const edgesSound = !cycle
    && wellFormed.every((node) => (node.dependsOn ?? []).every((dep) => declared.has(dep)));
  if (edgesSound) {
    errors.push(...topologyErrors(wellFormed));
    errors.push(...executionRoleErrors(wellFormed));
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Canonical JSON: object keys sorted recursively, `undefined` dropped.
 *
 * Array order is preserved here; set-like arrays are already normalized by
 * `canonicalProjectPlan` before this ever sees them.
 */
export function canonicalPlanJson(value: unknown): string {
  const encode = (input: unknown): string => {
    if (input === null) return 'null';
    if (typeof input === 'number') return Number.isFinite(input) ? JSON.stringify(input) : 'null';
    if (typeof input === 'boolean' || typeof input === 'string') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map((entry) => encode(entry ?? null)).join(',')}]`;
    if (!isPlainObject(input)) return 'null';
    const keys = Object.keys(input).filter((key) => input[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(input[key])}`).join(',')}}`;
  };
  return encode(value);
}

/**
 * Deterministic content hash of a plan's MEANING.
 *
 * Key order, node order, dependency order, capability order, and evidence path
 * order never change the hash; any change to ids, edges, executors, effects,
 * evidence content, approval, or budgets does.
 */
export function projectPlanHash(plan: ProjectPlan): string {
  return createHash('sha256')
    .update(canonicalPlanJson(canonicalProjectPlan(plan)), 'utf8')
    .digest('hex');
}

/**
 * Deterministic execution order: dependencies first, ties broken by id.
 *
 * This orders the STEP LIST for stable output. It is explicitly not a schedule:
 * the runtime graph decides readiness from edges, so independent nodes stay
 * concurrently ready no matter where they land in this list.
 */
export function topologicalNodeOrder(nodes: readonly ProjectNode[]): ProjectNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const emitted = new Set<string>();
  const result: ProjectNode[] = [];

  const remaining = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  let progressed = true;
  while (remaining.length > 0 && progressed) {
    progressed = false;
    for (let i = 0; i < remaining.length; i += 1) {
      const node = remaining[i];
      const deps = (node.dependsOn ?? []).filter((dep) => byId.has(dep));
      if (deps.every((dep) => emitted.has(dep))) {
        result.push(node);
        emitted.add(node.id);
        remaining.splice(i, 1);
        progressed = true;
        i -= 1;
      }
    }
  }
  // A validated plan is acyclic, so `remaining` is empty here. Appending any
  // leftovers keeps this total for callers that order before validating.
  return [...result, ...remaining];
}
