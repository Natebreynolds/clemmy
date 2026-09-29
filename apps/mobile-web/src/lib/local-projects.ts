/**
 * Local projects: the code folders on the owner's Mac that a project's work
 * happens in.
 *
 * A project LINKS to local projects; it never becomes one. What a local
 * project is, how it is named, what is said when its folder is gone and how
 * a coding run's phase reads are the shared engine's (@clem/chat-engine), so
 * the phone and the desktop say the same words. What lives here is only what
 * the phone does with what the Mac answers: read the roster for the picker,
 * and turn a refused link into the next thing to ask.
 *
 * Anything in an answer that this build cannot read is left out rather than
 * drawn half-named.
 */
import {
  projectLocalProjectRefusal,
  type ProjectCodingRunView,
  type ProjectLocalProject,
} from '@clem/chat-engine';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function leaf(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** How wide a path may be on a phone row before it is cut in the middle. */
export const PHONE_PATH_CHARS = 36;

/** The roster as the Mac sent it: one row per folder. */
export function readLocalProjects(value: unknown): ProjectLocalProject[] {
  if (!Array.isArray(value)) return [];
  const byPath = new Map<string, ProjectLocalProject>();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const raw = row as Record<string, unknown>;
    const path = text(raw.path);
    if (!path || byPath.has(path)) continue;
    byPath.set(path, {
      name: text(raw.name) || leaf(path),
      path,
      type: text(raw.type),
      description: text(raw.description),
      // Only an explicit yes says coding work can run there.
      git: raw.git === true,
    });
  }
  return [...byPath.values()];
}

export type LocalProjectLinkStep =
  /** What was named means more than one folder: the owner picks. */
  | { step: 'choose'; text: string; localProjects: ProjectLocalProject[] }
  /** What was named is not on the roster: nothing was linked. */
  | { step: 'not_found'; text: string; localProjects: ProjectLocalProject[] }
  /** Refused for another reason; the caller has the words for it. */
  | { step: 'failed' };

/** What a refused link asks of the owner next, in the shared engine's words. */
export function localProjectLinkStep(error: unknown): LocalProjectLinkStep {
  const body = (error as { body?: unknown } | null | undefined)?.body as Record<string, unknown> | null | undefined;
  const code = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
  if (code !== 'LOCAL_PROJECT_CHOICE_REQUIRED' && code !== 'LOCAL_PROJECT_NOT_FOUND') return { step: 'failed' };
  // A path is not a name the owner gave; only a name is quoted back.
  const named = text(body?.named);
  const words = projectLocalProjectRefusal(code, named.includes('/') ? null : named);
  if (!words) return { step: 'failed' };
  return {
    step: code === 'LOCAL_PROJECT_CHOICE_REQUIRED' ? 'choose' : 'not_found',
    text: words,
    localProjects: readLocalProjects(body?.localProjects),
  };
}

/** The coding runs a project's conversations started, in the order the Mac gave. */
export function readCodingRuns(overview: object | null | undefined): ProjectCodingRunView[] {
  const value = (overview as { codingRuns?: unknown } | null | undefined)?.codingRuns;
  if (!Array.isArray(value)) return [];
  const runs: ProjectCodingRunView[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const raw = row as Record<string, unknown>;
    const runId = text(raw.runId);
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    const local = (raw.localProject && typeof raw.localProject === 'object' ? raw.localProject : {}) as Record<string, unknown>;
    const path = text(local.path);
    runs.push({
      runId,
      objective: text(raw.objective) || 'Coding work',
      // Only an explicit "not linked" says so.
      localProject: { name: text(local.name) || leaf(path), path, linked: local.linked !== false },
      branch: text(raw.branch),
      phase: text(raw.phase) as ProjectCodingRunView['phase'],
      originSessionId: text(raw.originSessionId) || null,
      createdAt: text(raw.createdAt),
      updatedAt: text(raw.updatedAt) || text(raw.createdAt),
    });
  }
  return runs;
}
