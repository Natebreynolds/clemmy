import type { BrainKind, ScenarioStatus } from './types.js';

const ALL_BRAINS: readonly BrainKind[] = ['claude', 'codex', 'glm'];

/** Parse the explicit fail-closed brain contract used by release matrices. */
export function parseRequiredBrains(raw: string | undefined): BrainKind[] {
  if (raw === undefined || raw.trim() === '') {
    throw new Error('--require-brains requires a comma-separated list of claude,codex,glm');
  }

  const values = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) {
    throw new Error('--require-brains requires at least one of claude,codex,glm');
  }
  const unknown = values.filter((value) => !ALL_BRAINS.includes(value as BrainKind));
  if (unknown.length > 0) {
    throw new Error(`--require-brains contains unknown brain(s): ${[...new Set(unknown)].join(', ')}`);
  }

  return [...new Set(values as BrainKind[])];
}

/** A required lane cannot be omitted with a narrower --brain selection. */
export function assertRequiredBrainsSelected(
  selectedBrains: readonly BrainKind[],
  requiredBrains: readonly BrainKind[],
): void {
  const missing = requiredBrains.filter((brain) => !selectedBrains.includes(brain));
  if (missing.length > 0) {
    throw new Error(`Required proof brain(s) not selected: ${missing.join(', ')}`);
  }
}

export interface UnavailableBrainDisposition {
  status: Extract<ScenarioStatus, 'FAIL' | 'SKIP'>;
  error: string;
}

/**
 * Generic matrices preserve credential-related SKIPs. An explicitly required
 * lane is instead a report-visible failure, so the same report and exit code
 * cannot look green without executing every contracted provider.
 */
export function unavailableBrainDisposition(
  brain: BrainKind,
  reason: string,
  requiredBrains: readonly BrainKind[],
): UnavailableBrainDisposition {
  if (requiredBrains.includes(brain)) {
    return {
      status: 'FAIL',
      error: `required brain unavailable: ${reason}`,
    };
  }
  return { status: 'SKIP', error: reason };
}
