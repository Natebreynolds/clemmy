/**
 * Provider-agnostic subagent-run store — the visibility spine for multi-agent
 * fan-out ("agents you can't see are agents you can't manage").
 *
 * EVERY worker the harness spawns — Claude (SDK worker lane), Codex, or GLM/BYO
 * (@openai/agents cross-provider lane) — funnels through the single `run_worker`
 * choke-point (tools/worker-tools.ts), which records one row here on completion.
 * That gives a unified record of WHO ran (role + provider + model), WHAT they did
 * (the task + the persisted work-product), and their OUTCOME — attributed to the
 * spawning context (a workflow run, or a chat session) — so the console can show
 * every specialized agent in a workflow and the work it produced, across all
 * three brains, with one reader.
 *
 * Keyed by `parentRunId` = the workflow runId when spawned inside a workflow step,
 * else the chat sessionId. Best-effort + fail-open: a store error never breaks the
 * worker (the durable trace is a convenience, not the critical path).
 */
import { existsSync, mkdirSync, appendFileSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export type SubagentProvider = 'claude' | 'codex' | 'glm' | 'unknown';
export type SubagentStatus = 'ok' | 'error' | 'capped';

export interface SubagentRunRecord {
  /** Unique per spawn. */
  id: string;
  /** The workflow runId (workflow lane) or the chat sessionId (session lane). */
  parentRunId: string;
  parentKind: 'workflow' | 'session';
  /** Present when spawned inside a workflow. */
  workflowName?: string;
  stepId?: string;
  /** Specialist role — the fan-out intent/category (or a team-agent name later). */
  role?: string;
  provider: SubagentProvider;
  model?: string;
  /** The single item/task this agent handled. */
  task: string;
  status: SubagentStatus;
  /** First slice of the output for at-a-glance display (full output in outputRef). */
  outputPreview: string;
  /** Relative filename of the persisted full work-product, if any. */
  outputRef?: string;
  startedAt: string;
  finishedAt: string;
}

const PREVIEW_MAX = 600;

/** Classify a worker's provider from its model id (unified across the 3 lanes). */
export function providerClassForModel(model: string | undefined): SubagentProvider {
  const id = (model ?? '').trim().toLowerCase();
  if (!id) return 'unknown';
  if (/^claude|^anthropic|sonnet|opus|haiku|fable/.test(id)) return 'claude';
  if (/glm|zhipu|zai/.test(id)) return 'glm';
  if (/^gpt|^o[134]|^codex|^openai/.test(id)) return 'codex';
  return 'unknown';
}

function safeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_.:-]/g, '-').replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function subagentDir(parentRunId: string): string {
  return path.join(BASE_DIR, 'state', 'subagents', safeSegment(parentRunId, 'run'));
}
function recordsPath(parentRunId: string): string {
  return path.join(subagentDir(parentRunId), 'runs.jsonl');
}
function outputPath(parentRunId: string, id: string): string {
  return path.join(subagentDir(parentRunId), 'outputs', `${safeSegment(id, 'agent')}.txt`);
}

/**
 * Persist one subagent run + its full work-product. Returns the stored record
 * (or null on a store error — fail-open, never throws into the worker path).
 */
export function recordSubagentRun(
  input: Omit<SubagentRunRecord, 'outputPreview' | 'outputRef'> & { output?: string },
): SubagentRunRecord | null {
  try {
    const dir = subagentDir(input.parentRunId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const output = input.output ?? '';
    let outputRef: string | undefined;
    if (output.trim()) {
      const outDir = path.join(dir, 'outputs');
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
      writeFileSync(outputPath(input.parentRunId, input.id), output, 'utf-8');
      outputRef = path.join('outputs', `${safeSegment(input.id, 'agent')}.txt`);
    }
    const record: SubagentRunRecord = {
      id: input.id,
      parentRunId: input.parentRunId,
      parentKind: input.parentKind,
      ...(input.workflowName ? { workflowName: input.workflowName } : {}),
      ...(input.stepId ? { stepId: input.stepId } : {}),
      ...(input.role ? { role: input.role } : {}),
      provider: input.provider,
      ...(input.model ? { model: input.model } : {}),
      task: input.task,
      status: input.status,
      outputPreview: output.slice(0, PREVIEW_MAX).replace(/\s+/g, ' ').trim(),
      ...(outputRef ? { outputRef } : {}),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    };
    appendFileSync(recordsPath(input.parentRunId), JSON.stringify(record) + '\n', 'utf-8');
    return record;
  } catch {
    return null; // durable trace is best-effort
  }
}

/** All subagent runs for a parent (workflow run or chat session), oldest first. */
export function listSubagentRuns(parentRunId: string): SubagentRunRecord[] {
  try {
    const raw = readFileSync(recordsPath(parentRunId), 'utf-8');
    return raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => { try { return JSON.parse(l) as SubagentRunRecord; } catch { return null; } })
      .filter((r): r is SubagentRunRecord => r !== null);
  } catch {
    return [];
  }
}

/** The full persisted work-product for one subagent run, or null. */
export function readSubagentOutput(parentRunId: string, id: string): string | null {
  try {
    return readFileSync(outputPath(parentRunId, id), 'utf-8');
  } catch {
    return null;
  }
}
