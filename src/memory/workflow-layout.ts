/**
 * Where a workflow's steps sit on the graph: a sidecar beside SKILL.md.
 *
 * Placement is how a person reads a workflow, not what the engine runs, so it
 * lives outside the definition on purpose. Moving a box therefore changes no
 * definition fingerprint, queues no verification test and emits no
 * workflow_changed; the file is written atomically like SKILL.md and read on
 * every device that opens the workflow, so the shape you arranged on one
 * machine is the shape you see on the next.
 *
 * Only step ids the definition still has are kept: a removed step takes its
 * position with it, and a position for a step that never existed is dropped
 * rather than stored.
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { WorkflowEntry } from './workflow-store.js';

export const WORKFLOW_LAYOUT_FILE = 'layout.json';

export interface WorkflowStepPosition {
  x: number;
  y: number;
}

export interface WorkflowLayout {
  positions: Record<string, WorkflowStepPosition>;
}

/** Only a directory-layout workflow has a place for a sidecar. */
export function workflowLayoutPath(entry: Pick<WorkflowEntry, 'dir' | 'layout'>): string | null {
  return entry.layout === 'directory' ? path.join(entry.dir, WORKFLOW_LAYOUT_FILE) : null;
}

/**
 * Positions for the steps the definition has, from any value a caller or a
 * file supplies. Everything malformed is dropped; a finite pair is rounded to
 * whole pixels so the file stays stable across drags that land on the same
 * spot.
 */
export function normalizeWorkflowLayoutPositions(
  value: unknown,
  stepIds: Iterable<string>,
): Record<string, WorkflowStepPosition> {
  const known = new Set(stepIds);
  const out: Record<string, WorkflowStepPosition> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!known.has(id) || !raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const { x, y } = raw as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) continue;
    out[id] = { x: Math.round(x), y: Math.round(y) };
  }
  return out;
}

/** The saved layout, or null when there is none (or it cannot be read). */
export function readWorkflowLayout(entry: WorkflowEntry): WorkflowLayout | null {
  const filePath = workflowLayoutPath(entry);
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
    const positions = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as { positions?: unknown }).positions
      : undefined;
    return { positions: normalizeWorkflowLayoutPositions(positions, entry.data.steps.map((s) => s.id)) };
  } catch {
    return null;
  }
}

export type WriteWorkflowLayoutResult =
  | { ok: true; layout: WorkflowLayout }
  | { ok: false; reason: 'flat_layout' };

/**
 * Replace the saved layout. The whole map is written, so a step dragged back
 * to its computed spot is stored there rather than remembered from before.
 */
export function writeWorkflowLayout(entry: WorkflowEntry, positions: unknown): WriteWorkflowLayoutResult {
  const filePath = workflowLayoutPath(entry);
  if (!filePath) return { ok: false, reason: 'flat_layout' };
  const layout: WorkflowLayout = {
    positions: normalizeWorkflowLayoutPositions(positions, entry.data.steps.map((s) => s.id)),
  };
  writeAtomically(filePath, `${JSON.stringify(layout, null, 2)}\n`);
  return { ok: true, layout };
}

function writeAtomically(filePath: string, bytes: string): void {
  const temporary = `${filePath}.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, bytes, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, filePath);
  } catch (error) {
    if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* already closed */ } }
    try { unlinkSync(temporary); } catch { /* never created */ }
    throw error;
  }
}
