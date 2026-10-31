/**
 * Saved computer tasks: a finished task, kept as a recipe the owner can repeat
 * without the model (see computer-recipe.ts).
 *
 * A recipe is read from one request's own driver calls and their full
 * results, and saved under the owner's words for that request. Repeating it
 * asks Clem's driver directly; nothing is sent to a model.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getToolOutput, listEvents } from './harness/eventlog.js';
import {
  extractComputerRecipe, replayComputerRecipe,
  type ComputerDriverCall, type ComputerRecipeV1, type ComputerReplayOutcome, type ComputerTraceCall,
} from './computer-recipe.js';

export interface SavedComputerTask {
  id: string;
  name: string;
  createdAt: string;
  source: { sessionId: string; sourceUserSeq: number };
  recipe: ComputerRecipeV1;
}

const DRIVER_PREFIX = 'cua-driver__';
const ID = /^ct-[a-f0-9]{12}$/;

function storeDir(): string {
  return path.join(BASE_DIR, 'state', 'computer-tasks');
}

function argsOf(value: unknown): Record<string, unknown> {
  let current = value;
  if (typeof current === 'string') {
    try { current = JSON.parse(current) as unknown; } catch { return {}; }
  }
  return current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
}

/** One request's driver calls in order, with their full stored results. */
export function readComputerTrace(input: { sessionId: string; sourceUserSeq: number }): ComputerTraceCall[] {
  const seen = new Set<string>();
  const trace: ComputerTraceCall[] = [];
  // How each call settled. A call the driver refused (one held for the
  // owner's approval, then asked again) did not do the work: only the call
  // that settled as succeeded belongs in what repeats.
  const settled = new Map<string, string>();
  for (const event of listEvents(input.sessionId, { types: ['tool_attempt_settled'], sinceSeq: input.sourceUserSeq })) {
    if (typeof event.data.callId === 'string' && typeof event.data.kind === 'string') settled.set(event.data.callId, event.data.kind);
  }
  for (const event of listEvents(input.sessionId, { types: ['tool_called'], sinceSeq: input.sourceUserSeq })) {
    if (Number(event.data.sourceUserSeq) !== input.sourceUserSeq) continue;
    const direct = typeof event.data.tool === 'string' && event.data.tool.startsWith(DRIVER_PREFIX) ? event.data.tool : '';
    const carried = event.data.tool === 'work_call' && typeof event.data.effectiveTool === 'string'
      && event.data.effectiveTool.startsWith(DRIVER_PREFIX) ? event.data.effectiveTool : '';
    const tool = direct || carried;
    const callId = typeof event.data.callId === 'string' ? event.data.callId : '';
    if (!tool || !callId || seen.has(callId)) continue;
    seen.add(callId);
    const args = carried ? argsOf(argsOf(event.data.arguments).args_json) : argsOf(event.data.args ?? event.data.arguments);
    const settlement = settled.get(callId);
    if (settlement !== undefined && settlement !== 'succeeded') {
      trace.push({ tool, args, result: { result: { isError: true, content: [{ type: 'text', text: `settled ${settlement}` }] } } });
      continue;
    }
    const output = getToolOutput(input.sessionId, callId);
    trace.push({ tool, args, result: output?.output ?? null });
  }
  return trace;
}

function ownerWords(input: { sessionId: string; sourceUserSeq: number }): string {
  const asked = listEvents(input.sessionId, { types: ['user_input_received'] })
    .find((event) => event.seq === input.sourceUserSeq);
  const text = typeof asked?.data.text === 'string' ? asked.data.text.replace(/\s+/g, ' ').trim() : '';
  return text.length > 80 ? `${text.slice(0, 79)}…` : text || 'Computer task';
}

export type SaveComputerTaskResult =
  | { status: 'saved'; task: SavedComputerTask }
  | { status: 'not_repeatable'; reason: string };

export function saveComputerTask(input: { sessionId: string; sourceUserSeq: number; name?: string }): SaveComputerTaskResult {
  const extracted = extractComputerRecipe(readComputerTrace(input));
  if (extracted.status !== 'ready') return extracted;
  const task: SavedComputerTask = {
    id: `ct-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    name: input.name?.trim().slice(0, 80) || ownerWords(input),
    createdAt: new Date().toISOString(),
    source: { sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq },
    recipe: extracted.recipe,
  };
  mkdirSync(storeDir(), { recursive: true });
  const file = path.join(storeDir(), `${task.id}.json`);
  writeFileSync(`${file}.tmp`, JSON.stringify(task, null, 2));
  renameSync(`${file}.tmp`, file);
  return { status: 'saved', task };
}

export function loadComputerTask(id: string): SavedComputerTask | null {
  if (!ID.test(id)) return null;
  try { return JSON.parse(readFileSync(path.join(storeDir(), `${id}.json`), 'utf8')) as SavedComputerTask; } catch { return null; }
}

export function listComputerTasks(): SavedComputerTask[] {
  if (!existsSync(storeDir())) return [];
  return readdirSync(storeDir()).filter((file) => ID.test(file.replace(/\.json$/, '')))
    .map((file) => loadComputerTask(file.replace(/\.json$/, '')))
    .filter((task): task is SavedComputerTask => task !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function deleteComputerTask(id: string): boolean {
  if (!ID.test(id)) return false;
  const file = path.join(storeDir(), `${id}.json`);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/** Repeat a saved task with the given driver; no model is asked. */
export async function repeatComputerTask(id: string, call: ComputerDriverCall): Promise<ComputerReplayOutcome | null> {
  const task = loadComputerTask(id);
  if (!task) return null;
  return replayComputerRecipe(task.recipe, call, { session: `repeat-${task.id}` });
}
