/**
 * Invalidation generation for STABLE-context snapshots.
 *
 * The Claude-brain system append freezes its stable memory block per session
 * so the prompt-prefix cache stays byte-stable (a single re-rendered fact was
 * measured busting it down to ~28% hit rate). Freezing is only safe if every
 * EXPLICIT mutation of what that block renders — user-stated facts, profile
 * edits, pins/corrections, skill installs — bumps this generation so the next
 * turn re-renders. Automatic reflection churn deliberately does NOT bump:
 * deferring that churn to session end is the snapshot's whole point; the
 * turn primer (volatile lane) carries fresh reflections to the model.
 *
 * DURABLE + CROSS-PROCESS (COMPOUNDING wave, 2026-08-19): the counter was a
 * module global — it reset to 0 on daemon restart and a `memory_remember`
 * executed in the MCP tool process could never invalidate the brain
 * process's snapshot. It is now a tiny file under the home; reads are
 * OS-cached microseconds, writes happen only on explicit mutations. Still a
 * zero-project-import leaf (env + node:fs only).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

let inMemoryGeneration = 0;

function generationFilePath(): string | null {
  try {
    const home = (process.env.CLEMENTINE_HOME ?? '').trim()
      || join(homedir(), '.clementine-next');
    return join(home, 'state', 'stable-context-generation');
  } catch {
    return null;
  }
}

function readDurable(): number | null {
  const file = generationFilePath();
  if (!file) return null;
  try {
    const raw = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : null;
  } catch {
    return null;
  }
}

/** Call after an EXPLICIT stable-context mutation (never from reflection). */
export function bumpStableContextGeneration(): void {
  const current = readDurable() ?? inMemoryGeneration;
  inMemoryGeneration = current + 1;
  const file = generationFilePath();
  if (!file) return;
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, String(inMemoryGeneration), 'utf8');
  } catch {
    // The in-memory bump still invalidates THIS process; durability is
    // best-effort and self-heals on the next successful write.
  }
}

export function stableContextGeneration(): number {
  const durable = readDurable();
  if (durable !== null) {
    if (durable > inMemoryGeneration) inMemoryGeneration = durable;
    return inMemoryGeneration;
  }
  return inMemoryGeneration;
}
