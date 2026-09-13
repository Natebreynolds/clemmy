/**
 * The canvas model for a workflow: the node graph the editor draws, and the
 * step patch it saves back.
 *
 * The canvas is deliberately NOT a second source of truth. Reading uses the
 * `graph` the daemon already derives from the workflow's own `steps`
 * (src/dashboard/workflow-graph.ts — nodes = steps, edges = dependsOn), so what
 * is drawn is what the engine compiles. Saving goes back through the
 * PATCH /api/console/workflows/:name `stepEdits` body, which merges each edit
 * over the stored step with the same id and leaves every step the edit does not
 * name alone. The canvas therefore sends `{ id, dependsOn }` and nothing else
 * for a step it did not create: prompt, allowedTools, output contracts,
 * approval gates and every other authored field survive a save untouched
 * because the canvas never names them.
 *
 * Two consequences of the storage format are load-bearing here:
 *
 * 1. Node positions cannot round-trip through the workflow file. Both the read
 *    and the write side of workflow-store.ts allowlist their fields, so an
 *    unknown `ui:`/`position:` key is silently dropped rather than rejected.
 *    Positions are browser-local (`loadPositions`/`savePositions`); anywhere
 *    without them falls back to the deterministic layout derived from the
 *    daemon's own level/lane plan, so a workflow opened on another machine
 *    still reads correctly — it just loses hand-tuned placement.
 *
 * 2. A dependency cycle is refused by the daemon, and again here. The
 *    authoring validator rejects a loop on the way in, so this is no longer the
 *    only thing standing between a drawn cycle and a workflow that can never
 *    become ready. `findCycle` below stays because it is the better message and
 *    the faster one: it names the loop before a round trip, and the editor
 *    refuses to save while it reports one.
 */

/** How a step touches the world. Mirrors FlowNodeSideEffect on the daemon. */
export type CanvasSideEffect = 'read' | 'write' | 'send' | 'unknown';

/** What actually runs a step. Mirrors FlowNodeExecutor on the daemon. */
export type CanvasExecutor = 'model' | 'skill' | 'deterministic' | 'call';

export type CanvasVerdictStatus = 'trusted' | 'attention' | 'blocked';

/**
 * The subset of the daemon's FlowNode the canvas reads. Structural on purpose:
 * the daemon's node carries far more (readiness items, contract fixes, model
 * routes) and is free to grow without this module needing to change.
 */
export interface CanvasGraphNode {
  id: string;
  label?: string;
  dependsOn?: string[];
  flags?: {
    forEach?: boolean;
    approval?: boolean;
    skill?: string | null;
    deterministic?: boolean;
  };
  meta?: {
    sideEffect?: CanvasSideEffect;
    executor?: CanvasExecutor;
    toolCount?: number;
    forEach?: string | null;
  };
  plan?: {
    levelIndex?: number | null;
    laneIndex?: number | null;
  };
  verdict?: {
    status?: CanvasVerdictStatus;
    label?: string;
  };
}

export interface CanvasGraphEdge {
  id: string;
  source: string;
  target: string;
}

export interface CanvasGraph {
  nodes: CanvasGraphNode[];
  edges: CanvasGraphEdge[];
}

export interface CanvasPosition {
  x: number;
  y: number;
}

/**
 * A step as the canvas sends it back. `dependsOn` is the only field the canvas
 * authors for an existing step; the PATCH merge fills the rest from storage.
 * `prompt` is present only for a step the canvas itself created, because a step
 * the daemon has never seen has nothing to merge over.
 */
export interface CanvasStepPatch {
  id: string;
  dependsOn: string[];
  prompt?: string;
}

/** Column pitch (a dependency level) and row pitch (a parallel lane). */
export const CANVAS_COL = 280;
export const CANVAS_ROW = 132;

/** The prompt a canvas-created step carries until someone writes a real one. */
export const NEW_STEP_PROMPT = 'Describe what this step should do.';

function depsOf(node: CanvasGraphNode): string[] {
  return Array.isArray(node.dependsOn) ? node.dependsOn.filter((d) => typeof d === 'string') : [];
}

/**
 * Longest-path levels over the dependency DAG, used when the daemon did not
 * supply a plan (it omits level/lane for steps it could not place, and a
 * freshly added node has no plan at all). Back edges are ignored so a cyclic
 * graph still lays out well enough to SEE the cycle that has to be fixed.
 */
function derivedLevels(nodes: CanvasGraphNode[]): Map<string, number> {
  const known = new Set(nodes.map((n) => n.id));
  const level = new Map<string, number>();
  const visiting = new Set<string>();

  const walk = (id: string): number => {
    const cached = level.get(id);
    if (cached !== undefined) return cached;
    // A node reached again while still on the stack is a back edge; treating it
    // as level 0 keeps the walk finite instead of recursing forever.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = nodes.find((n) => n.id === id);
    const deps = node ? depsOf(node).filter((d) => known.has(d) && d !== id) : [];
    const depth = deps.length === 0 ? 0 : Math.max(...deps.map((d) => walk(d) + 1));
    visiting.delete(id);
    level.set(id, depth);
    return depth;
  };

  for (const node of nodes) walk(node.id);
  return level;
}

/**
 * A position for every node, from the daemon's own level/lane plan where it has
 * one so the canvas agrees with the engine's picture of the graph, and from a
 * derived layering where it does not.
 */
export function layoutGraph(graph: CanvasGraph): Record<string, CanvasPosition> {
  const nodes = graph.nodes ?? [];
  const fallback = derivedLevels(nodes);
  const lanesByLevel = new Map<number, number>();
  const out: Record<string, CanvasPosition> = {};

  // Stable order matters: two nodes on the same level must not race for a lane.
  for (const node of nodes) {
    const planLevel = node.plan?.levelIndex;
    const level = typeof planLevel === 'number' && Number.isFinite(planLevel)
      ? planLevel
      : (fallback.get(node.id) ?? 0);

    const planLane = node.plan?.laneIndex;
    let lane: number;
    if (typeof planLane === 'number' && Number.isFinite(planLane)) {
      lane = planLane;
    } else {
      lane = lanesByLevel.get(level) ?? 0;
    }
    lanesByLevel.set(level, Math.max(lanesByLevel.get(level) ?? 0, lane + 1));

    out[node.id] = { x: level * CANVAS_COL, y: lane * CANVAS_ROW };
  }
  return out;
}

/** Saved positions win; anything unplaced falls back to the computed layout. */
export function resolvePositions(
  graph: CanvasGraph,
  saved: Record<string, CanvasPosition> | undefined,
): Record<string, CanvasPosition> {
  const auto = layoutGraph(graph);
  const out: Record<string, CanvasPosition> = {};
  for (const node of graph.nodes ?? []) {
    const s = saved?.[node.id];
    out[node.id] = s && Number.isFinite(s.x) && Number.isFinite(s.y)
      ? { x: s.x, y: s.y }
      : (auto[node.id] ?? { x: 0, y: 0 });
  }
  return out;
}

/** A free spot to the right of everything placed, for a newly added node. */
export function nextFreePosition(positions: Record<string, CanvasPosition>): CanvasPosition {
  const values = Object.values(positions);
  if (values.length === 0) return { x: 0, y: 0 };
  const maxX = Math.max(...values.map((p) => p.x));
  const column = values.filter((p) => p.x === maxX);
  return { x: maxX + CANVAS_COL, y: Math.max(...column.map((p) => p.y)) + CANVAS_ROW };
}

/**
 * A kebab-case step id that does not collide with one already in the graph.
 * Step ids are the join key for the PATCH merge, so a collision would silently
 * overwrite an existing step rather than add one.
 */
export function newStepId(existing: Iterable<string>, base = 'step'): string {
  const taken = new Set(existing);
  const root = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'step';
  if (!taken.has(root)) return root;
  for (let i = 2; ; i += 1) {
    const candidate = `${root}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * The first dependency cycle found, as the id path that closes it, or null.
 * The authoring API accepts a cycle and the run only stalls later, so the
 * editor blocks the save on this rather than letting the daemon decide.
 */
export function findCycle(nodes: CanvasGraphNode[], edges: CanvasGraphEdge[]): string[] | null {
  const known = new Set(nodes.map((n) => n.id));
  const next = new Map<string, string[]>();
  for (const id of known) next.set(id, []);
  // Edges are the authority on the canvas; dependsOn on a node may be stale
  // while the user is mid-edit.
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    next.get(edge.source)!.push(edge.target);
  }

  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const walk = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const to of next.get(id) ?? []) {
      const s = state.get(to) ?? 0;
      if (s === 1) {
        // Report the loop itself, not the tail that led into it.
        const from = stack.indexOf(to);
        return [...stack.slice(from), to];
      }
      if (s === 0) {
        const found = walk(to);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const id of known) {
    if ((state.get(id) ?? 0) === 0) {
      const found = walk(id);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The `stepEdits` body for PATCH /api/console/workflows/:name.
 *
 * Edges are the authority for `dependsOn`, so disconnecting on the canvas
 * actually removes the dependency. Every node on the canvas is sent, because
 * every one of them may have been rewired — but under `stepEdits` that is no
 * longer load-bearing: a step this canvas never knew about is left alone rather
 * than deleted, so a tab that loaded before someone added a step can no longer
 * destroy it. Order is topological with ties broken by the node's current
 * position in the graph, which keeps the stored file readable; the engine
 * derives execution order from dependsOn and does not care about array order.
 */
export function toStepPatch(
  nodes: CanvasGraphNode[],
  edges: CanvasGraphEdge[],
  createdIds: Iterable<string> = [],
): CanvasStepPatch[] {
  const known = new Set(nodes.map((n) => n.id));
  const created = new Set(createdIds);

  const deps = new Map<string, string[]>();
  for (const id of known) deps.set(id, []);
  for (const edge of edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    const list = deps.get(edge.target)!;
    if (!list.includes(edge.source)) list.push(edge.source);
  }

  const order = topologicalOrder(nodes, deps);
  return order.map((id) => {
    const patch: CanvasStepPatch = { id, dependsOn: deps.get(id) ?? [] };
    // Only a step the daemon has never stored needs a body; for everything else
    // the PATCH merge keeps the authored prompt, and sending one would clobber it.
    if (created.has(id)) patch.prompt = NEW_STEP_PROMPT;
    return patch;
  });
}

/**
 * Dependencies first, original order preserved among peers. A cycle cannot be
 * ordered, so anything still unemitted is appended in its original order rather
 * than dropped — callers block on `findCycle` before saving, and losing steps
 * here would be far worse than an odd order.
 */
function topologicalOrder(nodes: CanvasGraphNode[], deps: Map<string, string[]>): string[] {
  const emitted = new Set<string>();
  const out: string[] = [];
  const visiting = new Set<string>();

  const visit = (id: string) => {
    if (emitted.has(id) || visiting.has(id)) return;
    visiting.add(id);
    for (const dep of deps.get(id) ?? []) visit(dep);
    visiting.delete(id);
    if (!emitted.has(id)) {
      emitted.add(id);
      out.push(id);
    }
  };

  for (const node of nodes) visit(node.id);
  for (const node of nodes) {
    if (!emitted.has(node.id)) {
      emitted.add(node.id);
      out.push(node.id);
    }
  }
  return out;
}

/**
 * True when the graph differs from the one the daemon returned — i.e. there is
 * something worth saving. Compared on the step set and each step's dependency
 * set, since those are the only things the canvas writes.
 */
export function graphDiffersFrom(graph: CanvasGraph, patch: CanvasStepPatch[]): boolean {
  const before = new Map((graph.nodes ?? []).map((n) => [n.id, [...depsOf(n)].sort()]));
  if (before.size !== patch.length) return true;
  for (const step of patch) {
    const prior = before.get(step.id);
    if (!prior) return true;
    const now = [...step.dependsOn].sort();
    if (prior.length !== now.length) return true;
    if (prior.some((dep, i) => dep !== now[i])) return true;
  }
  return false;
}

/* ---------- reporting what a save actually did ---------- */

/**
 * The part of a PATCH response that changes what the user should be told.
 * Structural so this module stays free of the API client (which imports types
 * from here).
 */
export interface CanvasSaveResult {
  enabled?: boolean;
  verificationQueued?: boolean;
  message?: string;
  repairs?: string[];
}

export const SAVED_PLAINLY = 'Saved.';

/**
 * What to tell someone after a save.
 *
 * A 2xx does not always mean "written and still running": rewiring a workflow
 * that is ON can turn it OFF and queue a verification test of the new shape,
 * and the daemon may have repaired the definition on the way in. Reporting a
 * flat "Saved" in those cases would leave someone believing a live automation
 * is still live when it is not.
 */
export function saveOutcome(result: CanvasSaveResult | null | undefined): string {
  if (result?.verificationQueued) {
    return (
      result.message?.trim() ||
      'Saved, and this workflow was turned off until a verification test of the new shape passes.'
    );
  }
  if (result?.enabled === false) return 'Saved, and this workflow is currently off.';
  const repairs = (result?.repairs ?? []).filter((r) => typeof r === 'string' && r.trim());
  if (repairs.length > 0) {
    return `Saved, with ${repairs.length} automatic ${repairs.length === 1 ? 'repair' : 'repairs'}: ${repairs.join('; ')}`;
  }
  return SAVED_PLAINLY;
}

/* ---------- browser-local node placement ---------- */

const POSITION_KEY_PREFIX = 'clem:workflow-canvas:positions:';

/** Namespaced per workflow so two workflows never share placement. */
export function positionStorageKey(workflow: string): string {
  return `${POSITION_KEY_PREFIX}${workflow}`;
}

/**
 * Placement is a per-browser convenience, never state the engine depends on, so
 * every failure path here returns "no saved positions" and the caller falls
 * back to the computed layout. Private windows and blocked site data throw on
 * access rather than returning empty.
 */
export function loadPositions(
  workflow: string,
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
): Record<string, CanvasPosition> {
  const store = storage ?? safeStorage();
  if (!store) return {};
  try {
    const raw = store.getItem(positionStorageKey(workflow));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, CanvasPosition> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const { x, y } = value as { x?: unknown; y?: unknown };
      if (typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y)) {
        out[id] = { x, y };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function savePositions(
  workflow: string,
  positions: Record<string, CanvasPosition>,
  storage?: Pick<Storage, 'getItem' | 'setItem'>,
): void {
  const store = storage ?? safeStorage();
  if (!store) return;
  try {
    store.setItem(positionStorageKey(workflow), JSON.stringify(positions));
  } catch {
    // A full or blocked store costs placement only; the canvas still works.
  }
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
