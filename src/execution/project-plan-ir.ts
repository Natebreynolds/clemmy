/**
 * ProjectPlan IR — the executable, provider-neutral description of a project's
 * TOPOLOGY.
 *
 * A read-only planner emits this; `project-compiler.ts` turns it into ordinary
 * `WorkflowDefinition` steps. Nothing here executes, and nothing here can grant
 * authority: a plan may *request* an external effect, but the runtime tool
 * boundary remains the only thing that can permit one.
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
 * Node *instances* carry specific assignments ("read the opportunity records
 * closing this month"). Node *semantics* never do. There is no notion here of a
 * dashboard, a report, a deploy, a provider, or an app. A node is:
 *
 *   a dependency position, an executor, an effect class, an evidence contract,
 *   an approval disposition, a retry/turn budget, and optionally a fan-out
 *   source.
 *
 * Those seven axes are deliberately INDEPENDENT. Collapsing any two of them is
 * how domain assumptions get smuggled in — "this is a deploy node, therefore it
 * needs approval, therefore it is last" bakes a use case into the topology.
 * Here, effect class does not imply position, executor does not imply effect,
 * and approval is a separate declaration that validation cross-checks rather
 * than infers.
 *
 * WHAT VALIDATION IS FOR
 *
 * Every rule below rejects a plan that would be UNSAFE OR UNRUNNABLE, never one
 * that is merely unfamiliar. An objective this module has never seen must
 * compile exactly like a familiar one; there is no vocabulary to be unfamiliar
 * *to*. Validation fails closed on: identity collisions, dangling or cyclic
 * dependencies, unbounded budgets, fan-out from a source that was never
 * declared, structured calls with no exact tool, external effects with no
 * verification, wildcard tool authority, and approval/effect contradictions.
 */
import { createHash } from 'node:crypto';

/**
 * Where a node's work happens.
 *
 * `read` touches nothing outside this machine. `local_write` produces durable
 * local artifacts. `external_write` asks to change state the user does not own
 * exclusively. The class is a REQUEST, never a permission.
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
 * What this node must be able to SHOW for its result to count. Mirrors the
 * runtime's existing output contract so the compiler can hand it straight
 * through rather than inventing a second evidence language.
 */
export interface ProjectEvidenceContract {
  type?: ProjectContractType;
  /** Top-level keys that must be present on an object result. */
  requiredKeys?: string[];
  /** Dot-paths whose value must be non-empty. */
  nonEmpty?: string[];
  /** Dot-path → minimum array length. */
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
 * `model` is reasoning under a bounded turn budget. `structured_call` is an
 * exact, pre-named tool invocation with no model turn at all — the planner
 * already knows the tool and its arguments, so the runtime should not spend a
 * turn rediscovering them. Which one a node uses says nothing about its effect
 * class: a structured call can be a pure read, and a model node can request an
 * external write.
 */
export type ProjectExecutor =
  | {
    kind: 'model';
    /** The node's assignment. Specific by nature; the runtime treats it as opaque. */
    instruction: string;
    /**
     * Optional narrowing of the node's tool surface. Omitted means "inherit
     * whatever the workflow already allows" — it never means "everything".
     */
    allowedTools?: string[];
  }
  | {
    kind: 'structured_call';
    /** Exact tool identifier. Never a pattern, never templated. */
    tool: string;
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
  /** Shown on the approval card. Required when approval is required. */
  approvalPreview?: string;
  /** Additional attempts after the first failure. */
  retries?: number;
  /** Model turns this node may spend. Bounded well under the safety ceiling. */
  maxTurns?: number;
  fanOut?: ProjectFanOut;
}

export interface ProjectPlan {
  /**
   * Stable identifier for this plan's lineage. Used to derive a deterministic
   * workflow name. Omitted = derived from the plan hash.
   */
  planId?: string;
  /** What the user asked for, in their terms. Opaque to this module. */
  objective: string;
  nodes: ProjectNode[];
}

/**
 * The hard per-node turn ceiling. Matches the runtime's own upper bound so a
 * plan can never author a node the harness would refuse to run.
 */
export const PROJECT_NODE_TURN_CEILING = 64;

/**
 * Default turns per node — deliberately far below the ceiling.
 *
 * The point of splitting a project into nodes is that each one is small. A node
 * that genuinely needs dozens of turns is a node that should have been several
 * nodes, so the default stays tight and an author must ask for more in the
 * open, where validation can see it.
 */
export const PROJECT_NODE_DEFAULT_MAX_TURNS = 8;

/** Wildcard tool authority is never expressible in a plan. */
const WILDCARD_TOOL = '*';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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

/**
 * Effect classes that reach outside this machine and therefore may never run
 * unattended on a plan's say-so.
 */
function effectIsExternal(effect: ProjectEffectClass): boolean {
  return effect === 'external_write';
}

/** The approval disposition an effect class implies when the plan omits one. */
export function defaultApprovalFor(effect: ProjectEffectClass): ProjectApprovalDisposition {
  return effectIsExternal(effect) ? 'required' : 'not_required';
}

/**
 * Does this evidence contract actually verify something concrete?
 *
 * Shape alone is not verification: `{required_keys: ['url']}` is satisfied by
 * `{url: ''}`. An external effect must name a handle whose real existence is
 * checked, which is exactly what `verify` is for.
 */
function evidenceVerifiesConcretely(evidence: ProjectEvidenceContract | undefined): boolean {
  const verify = evidence?.verify;
  if (!verify) return false;
  return (verify.pathExists?.length ?? 0) > 0 || (verify.urlPresent?.length ?? 0) > 0;
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
 * Validate a plan. Returns EVERY problem rather than the first, so an author
 * fixes one plan instead of discovering one error per attempt.
 */
export function validateProjectPlan(plan: unknown): ProjectPlanValidation {
  const errors: string[] = [];

  if (!isPlainObject(plan)) {
    return { ok: false, errors: ['Project plan must be an object.'] };
  }
  const candidate = plan as Partial<ProjectPlan>;

  if (!nonEmptyString(candidate.objective)) {
    errors.push('Project plan requires a non-empty objective.');
  }
  if (candidate.planId !== undefined && !nonEmptyString(candidate.planId)) {
    errors.push('Project plan planId, when present, must be a non-empty string.');
  }
  if (!Array.isArray(candidate.nodes) || candidate.nodes.length === 0) {
    errors.push('Project plan requires at least one node.');
    return { ok: false, errors };
  }

  const nodes = candidate.nodes as ProjectNode[];
  const seen = new Set<string>();

  for (const [index, node] of nodes.entries()) {
    const where = nonEmptyString(node?.id) ? `node "${node.id}"` : `node at index ${index}`;

    if (!isPlainObject(node)) {
      errors.push(`${where} must be an object.`);
      continue;
    }
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
        if (!Array.isArray(tools) || tools.some((tool) => !nonEmptyString(tool))) {
          errors.push(`${where} allowedTools must be a list of non-empty tool names.`);
        } else if (tools.includes(WILDCARD_TOOL)) {
          errors.push(`${where} may not request wildcard tool authority ("${WILDCARD_TOOL}").`);
        }
      }
    } else if (executor.kind === 'structured_call') {
      // An exact call is the whole point of this executor: a templated or
      // pattern tool name would put tool SELECTION back inside the runtime,
      // which is what the structured lane exists to avoid.
      if (!nonEmptyString(executor.tool)) {
        errors.push(`${where} structured call requires an exact tool name.`);
      } else if (/[*{}]|\s/.test(executor.tool)) {
        errors.push(`${where} structured call tool "${executor.tool}" must be an exact name, not a pattern or template.`);
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
        // A plan cannot waive the human. This is the contradiction that would
        // otherwise let a planner hand itself unattended external authority.
        errors.push(`${where} requests an external write but declares approval not_required; a plan cannot waive approval.`);
      } else if (!effectIsExternal(effect) && approval === 'required') {
        // Equally a contradiction: there is no external boundary to approve,
        // so the pause would be theatre and would train users to click through.
        errors.push(`${where} declares approval required but its effect (${effect}) crosses no external boundary.`);
      }

      if (effectIsExternal(effect) && !evidenceVerifiesConcretely(node.evidence)) {
        errors.push(`${where} requests an external write without verification evidence; declare evidence.verify.pathExists or evidence.verify.urlPresent.`);
      }
    }

    if (node.approvalPreview !== undefined && !nonEmptyString(node.approvalPreview)) {
      errors.push(`${where} approvalPreview, when present, must be a non-empty string.`);
    }

    // --- budgets ------------------------------------------------------------
    if (node.maxTurns !== undefined) {
      if (!Number.isSafeInteger(node.maxTurns) || node.maxTurns <= 0) {
        errors.push(`${where} maxTurns must be a positive integer.`);
      } else if (node.maxTurns > PROJECT_NODE_TURN_CEILING) {
        errors.push(`${where} maxTurns ${node.maxTurns} exceeds the ${PROJECT_NODE_TURN_CEILING}-turn safety ceiling; split the work into more nodes.`);
      }
    }
    if (node.retries !== undefined && (!Number.isSafeInteger(node.retries) || node.retries < 0)) {
      errors.push(`${where} retries must be a non-negative integer.`);
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
        // Fanning out over a node this one does not wait for would iterate a
        // value that may not exist yet.
        errors.push(`${where} fans out from "${node.fanOut.fromNode}", which is not one of its declared dependencies.`);
      }
      if (node.fanOut && node.fanOut.path !== undefined && !nonEmptyString(node.fanOut.path)) {
        errors.push(`${where} fanOut path, when present, must be a non-empty dot-path.`);
      }
    }
  }

  // --- graph-level ----------------------------------------------------------
  const declared = new Set(nodes.filter((node) => nonEmptyString(node?.id)).map((node) => node.id));
  for (const node of nodes) {
    if (!nonEmptyString(node?.id)) continue;
    for (const dep of node.dependsOn ?? []) {
      if (nonEmptyString(dep) && !declared.has(dep)) {
        errors.push(`Node "${node.id}" depends on "${dep}", which no node declares.`);
      }
    }
    if (node.fanOut?.fromNode && !declared.has(node.fanOut.fromNode)) {
      errors.push(`Node "${node.id}" fans out from "${node.fanOut.fromNode}", which no node declares.`);
    }
  }

  const cycle = findCycle(nodes.filter((node) => nonEmptyString(node?.id)));
  if (cycle) errors.push(`Project plan has a dependency cycle: ${cycle.join(' -> ')}.`);

  return { ok: errors.length === 0, errors };
}

/**
 * Canonical JSON: object keys sorted recursively, `undefined` dropped.
 *
 * Two plans that differ only in key order are the same plan, so they must hash
 * identically and compile identically. Array order is preserved — a list is
 * data, not formatting.
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
 * Normalize the SET-valued parts of a plan so two plans that mean the same
 * thing have one representation.
 *
 * A plan's node list is a set keyed by id — the topology lives in `dependsOn`,
 * not in array position, and the compiler re-orders topologically anyway. The
 * same is true of `dependsOn` itself: waiting on [a, b] and on [b, a] is the
 * same constraint. Those two are normalized.
 *
 * Nothing else is. `args`, `requiredKeys`, `nonEmpty`, and `allowedTools` are
 * left exactly as authored, because ordering there can carry meaning and
 * silently rewriting an author's payload would be a worse bug than an
 * order-sensitive hash.
 */
export function canonicalProjectPlan(plan: ProjectPlan): ProjectPlan {
  const nodes = [...plan.nodes]
    .sort((a, b) => String(a?.id ?? '').localeCompare(String(b?.id ?? '')))
    .map((node) => ({
      ...node,
      ...(node?.dependsOn ? { dependsOn: [...node.dependsOn].sort() } : {}),
    }));
  return { ...plan, nodes };
}

/**
 * Deterministic content hash of a plan's MEANING.
 *
 * Key order, node order, and dependency order never change the hash; any change
 * to ids, dependencies, executors, effects, evidence, approval, or budgets does.
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
 * the runtime graph decides readiness from edges, so three independent nodes
 * stay concurrently ready no matter where they land in this list.
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
