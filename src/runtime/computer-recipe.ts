/**
 * Repeat a computer task without the model.
 *
 * A computer task Clem finished is a trace of driver calls: reads she made to
 * find her way (window snapshots, searches) and the few actions that did the
 * work. A recipe keeps only the actions, each in terms that can be found again
 * on a later day: the app by its bundle id, the window by its title, a button
 * by its role, label and accessibility id. Process ids, window ids and element
 * tokens change every run, so none of them is kept.
 *
 * Replay re-finds each target with fresh reads and acts on it; no model is
 * asked anything. The first target it cannot find exactly once stops the
 * replay at that step, so Clem can take over from there instead of acting on
 * a guess.
 */

export type ComputerRecipeStepV1 =
  | { kind: 'launch'; bundleId?: string; name?: string }
  | { kind: 'window'; app: string; title: string }
  | { kind: 'press'; role: string; label: string; axId?: string }
  | { kind: 'type'; text: string }
  | { kind: 'hotkey'; keys: string[] };

export interface ComputerRecipeV1 {
  version: 1;
  steps: ComputerRecipeStepV1[];
}

/** One driver call as the trace recorded it, in order. */
export interface ComputerTraceCall {
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export type ComputerRecipeExtraction =
  | { status: 'ready'; recipe: ComputerRecipeV1 }
  | { status: 'not_repeatable'; reason: string };

interface SnapshotElement { role: string; label: string; axId?: string }
interface Snapshot { snapshotId: string; elements: Map<number, SnapshotElement> }

const DRIVER_PREFIX = 'cua-driver__';
/** Calls that only look: replay makes its own fresh reads. */
const READS = new Set(['list_apps', 'list_windows', 'get_window_state', 'get_browser_state', 'page', 'start_session', 'get_screen_size']);

function bare(tool: string): string {
  return tool.startsWith(DRIVER_PREFIX) ? tool.slice(DRIVER_PREFIX.length) : tool;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The MCP result object, from either `{result: {...}}` or the bare result. */
function mcpResult(value: unknown): Record<string, unknown> | null {
  let current: unknown = value;
  if (typeof current === 'string') {
    try { current = JSON.parse(current) as unknown; } catch { return null; }
  }
  const outer = record(current);
  if (!outer) return null;
  return record(outer.result) ?? outer;
}

function structured(value: unknown): Record<string, unknown> | null {
  return record(mcpResult(value)?.structuredContent);
}

function failed(value: unknown): boolean {
  return mcpResult(value)?.isError === true;
}

const TREE_LINE = /^\s*-\s*\[(\d+)\]\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+\[([^\]]*(?:\[[^\]]*\][^\]]*)*)\])?/;

/** Elements of a window snapshot, by row number. */
export function parseWindowSnapshot(value: unknown): Snapshot | null {
  const content = structured(value);
  const snapshotId = typeof content?.snapshot_id === 'string' ? content.snapshot_id : '';
  const tree = typeof content?.tree_markdown === 'string' ? content.tree_markdown : '';
  if (!snapshotId || !tree) return null;
  const elements = new Map<number, SnapshotElement>();
  for (const line of tree.split('\n')) {
    const match = TREE_LINE.exec(line);
    if (!match) continue;
    const axId = /(?:^|\s)id=(\S+)/.exec(match[4] ?? '')?.[1];
    elements.set(Number(match[1]), { role: match[2]!, label: (match[3] ?? '').replace(/\\"/g, '"'), ...(axId ? { axId } : {}) });
  }
  return { snapshotId, elements };
}

/** The repeatable steps of a finished computer task, or why it cannot repeat
 *  without the model. */
export function extractComputerRecipe(calls: readonly ComputerTraceCall[]): ComputerRecipeExtraction {
  const steps: ComputerRecipeStepV1[] = [];
  const snapshots = new Map<string, Snapshot>();
  const windowTitles = new Map<number, { app: string; title: string }>();
  let currentWindow: number | null = null;
  for (const call of calls) {
    const tool = bare(call.tool);
    if (failed(call.result)) continue;
    if (tool === 'list_windows') {
      const windows = structured(call.result)?.windows;
      for (const window of Array.isArray(windows) ? windows : []) {
        const entry = record(window);
        const id = Number(entry?.window_id);
        const title = typeof entry?.title === 'string' ? entry.title : typeof entry?.window_title === 'string' ? entry.window_title : '';
        const app = typeof entry?.app_name === 'string' ? entry.app_name : '';
        if (Number.isSafeInteger(id) && title && app) windowTitles.set(id, { app, title });
      }
      continue;
    }
    if (tool === 'get_window_state') {
      const snapshot = parseWindowSnapshot(call.result);
      if (snapshot) snapshots.set(snapshot.snapshotId, snapshot);
      const content = structured(call.result);
      const id = Number(content?.window_id);
      const title = typeof content?.window_title === 'string' ? content.window_title : '';
      const app = typeof content?.app_name === 'string' ? content.app_name : '';
      if (Number.isSafeInteger(id) && title && app) windowTitles.set(id, { app, title });
      continue;
    }
    if (READS.has(tool)) continue;
    if (tool === 'launch_app') {
      const bundleId = typeof call.args.bundle_id === 'string' ? call.args.bundle_id : undefined;
      const name = typeof call.args.name === 'string' ? call.args.name : typeof call.args.app === 'string' ? call.args.app : undefined;
      if (!bundleId && !name) return { status: 'not_repeatable', reason: 'an app was opened without a name or bundle id' };
      const previous = steps.at(-1);
      const step = { kind: 'launch' as const, ...(bundleId ? { bundleId } : {}), ...(name ? { name } : {}) };
      if (!(previous?.kind === 'launch' && JSON.stringify(previous) === JSON.stringify(step))) steps.push(step);
      continue;
    }
    // Every acting call targets a window: name it before the first action in it.
    const windowId = Number(call.args.window_id);
    if (Number.isSafeInteger(windowId) && windowId !== currentWindow) {
      const known = windowTitles.get(windowId);
      if (!known) return { status: 'not_repeatable', reason: `a window was used before its title was read (window ${windowId})` };
      steps.push({ kind: 'window', app: known.app, title: known.title });
      currentWindow = windowId;
    }
    if (tool === 'click') {
      const token = typeof call.args.element_token === 'string' ? call.args.element_token : '';
      const [snapshotId, row] = token.split(':');
      const element = snapshotId ? snapshots.get(snapshotId)?.elements.get(Number(row)) : undefined;
      if (!element) return { status: 'not_repeatable', reason: 'a click targeted something the trace does not name' };
      if (!element.label && !element.axId) {
        return { status: 'not_repeatable', reason: `a click targeted an unnamed ${element.role}, which cannot be found again` };
      }
      steps.push({ kind: 'press', role: element.role, label: element.label, ...(element.axId ? { axId: element.axId } : {}) });
      continue;
    }
    if (tool === 'type_text') {
      if (typeof call.args.text !== 'string' || !call.args.text) return { status: 'not_repeatable', reason: 'text was typed without its words' };
      steps.push({ kind: 'type', text: call.args.text });
      continue;
    }
    if (tool === 'hotkey') {
      const keys = Array.isArray(call.args.keys) ? call.args.keys.filter((key): key is string => typeof key === 'string') : [];
      if (keys.length === 0) return { status: 'not_repeatable', reason: 'a shortcut was pressed without its keys' };
      steps.push({ kind: 'hotkey', keys });
      continue;
    }
    return { status: 'not_repeatable', reason: `it used ${tool}, which does not repeat without the model yet` };
  }
  if (!steps.some((step) => step.kind === 'press' || step.kind === 'type' || step.kind === 'hotkey')) {
    return { status: 'not_repeatable', reason: 'it only looked; there is nothing to repeat' };
  }
  return { status: 'ready', recipe: { version: 1, steps } };
}

/** Calls one driver tool (by its bare name) and returns its MCP result. */
export type ComputerDriverCall = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export type ComputerReplayOutcome =
  | { status: 'done'; steps: number }
  | { status: 'needs_clem'; at: number; step: ComputerRecipeStepV1; detail: string };

function sameTarget(element: SnapshotElement, step: Extract<ComputerRecipeStepV1, { kind: 'press' }>): boolean {
  return element.role === step.role && element.label === step.label;
}

/** Run a recipe with fresh reads for every target. Stops, never guesses. */
export async function replayComputerRecipe(recipe: ComputerRecipeV1, call: ComputerDriverCall,
  options: { session: string }): Promise<ComputerReplayOutcome> {
  let pid: number | null = null;
  let windowId: number | null = null;
  const stop = (at: number, detail: string): ComputerReplayOutcome => ({ status: 'needs_clem', at, step: recipe.steps[at]!, detail });
  for (const [at, step] of recipe.steps.entries()) {
    if (step.kind === 'launch') {
      const result = await call('launch_app', { ...(step.bundleId ? { bundle_id: step.bundleId } : { name: step.name }), session: options.session });
      const launched = Number(structured(result)?.pid);
      if (failed(result) || !Number.isSafeInteger(launched)) return stop(at, 'the app did not open');
      pid = launched;
      continue;
    }
    if (pid === null) return stop(at, 'no app was opened first');
    if (step.kind === 'window') {
      const result = await call('list_windows', { app: step.app, pid, session: options.session });
      const windows = structured(result)?.windows;
      const matches = (Array.isArray(windows) ? windows : []).map(record).filter((window) => {
        const title = typeof window?.title === 'string' ? window.title : window?.window_title;
        return title === step.title;
      });
      if (failed(result) || matches.length !== 1) {
        return stop(at, matches.length === 0 ? `no "${step.title}" window is open` : `${matches.length} windows are titled "${step.title}"`);
      }
      windowId = Number(matches[0]!.window_id);
      continue;
    }
    if (windowId === null) return stop(at, 'no window was chosen first');
    if (step.kind === 'press') {
      const result = await call('get_window_state', { pid, window_id: windowId, session: options.session, tree_format: 'markdown',
        query: step.label || step.role, include_screenshot: false });
      const snapshot = parseWindowSnapshot(result);
      if (!snapshot) return stop(at, 'the window could not be read');
      const candidates = [...snapshot.elements.entries()].filter(([, element]) => sameTarget(element, step));
      const byId = step.axId ? candidates.filter(([, element]) => element.axId === step.axId) : [];
      const chosen = byId.length === 1 ? byId : candidates;
      if (chosen.length !== 1) {
        return stop(at, chosen.length === 0 ? `no ${step.role} "${step.label}" is showing` : `${chosen.length} matches for ${step.role} "${step.label}"`);
      }
      const pressed = await call('click', { pid, window_id: windowId, element_token: `${snapshot.snapshotId}:${chosen[0]![0]}`, session: options.session });
      if (failed(pressed)) return stop(at, `pressing ${step.role} "${step.label}" was refused`);
      continue;
    }
    const sent = step.kind === 'type'
      ? await call('type_text', { pid, window_id: windowId, text: step.text, delivery_mode: 'foreground', session: options.session })
      : await call('hotkey', { pid, window_id: windowId, keys: step.keys, delivery_mode: 'foreground', session: options.session });
    if (failed(sent)) return stop(at, step.kind === 'type' ? 'the typing was refused' : 'the shortcut was refused');
  }
  return { status: 'done', steps: recipe.steps.length };
}
