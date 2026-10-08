/**
 * The local projects a project's work happens in.
 *
 * A local project is a folder on this machine that the owner already keeps
 * among their workspace folders: the roster the app lists under Connect. A
 * project (a body of work) links to one by its path. Nothing is linked from
 * a name alone: the name has to be one folder on the roster, and when it is
 * not, the owner is shown the roster and asked.
 *
 * Linking grants nothing. What may be read or written in a folder is decided
 * where it always was; the link says where this project's work is.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { addWorkspaceDir, listDiscoverableProjects, listWorkspaceProjects, type WorkspaceProject } from '../tools/shared.js';

export interface LocalProject {
  name: string;
  path: string;
  /** What kind of code it holds, as the roster detects it. */
  type: string;
  description: string;
  /** Whether it is a git repository, which coding work needs. */
  git: boolean;
  /** Found on this computer but not yet among the workspace folders.
   *  Linking it adds that one folder. */
  found?: true;
}

export type LocalProjectChoice =
  | { kind: 'found'; project: LocalProject }
  | { kind: 'choose'; named: string; choices: LocalProject[] }
  | { kind: 'not_found'; named: string; choices: LocalProject[] };

type Roster = () => LocalProject[];
let rosterForTests: Roster | null = null;
let foundForTests: Roster | null = null;

/** Test seam. Null restores the machine's own roster and discovery. */
export function _setLocalProjectsForTests(roster: Roster | null, found: Roster | null = null): void {
  rosterForTests = roster;
  foundForTests = found;
}

const asLocalProject = (row: WorkspaceProject, found: boolean): LocalProject => ({
  name: row.name,
  path: row.path,
  type: row.type,
  description: row.description ?? '',
  git: existsSync(path.join(row.path, '.git')),
  ...(found ? { found: true as const } : {}),
});

export function localProjects(): LocalProject[] {
  if (rosterForTests) return rosterForTests();
  return (listWorkspaceProjects() ?? []).map((row) => asLocalProject(row, false));
}

/** Project folders found where people keep them, not yet among the work folders. */
export function foundLocalProjects(): LocalProject[] {
  if (rosterForTests) return foundForTests ? foundForTests() : [];
  return listDiscoverableProjects().map((row) => asLocalProject(row, true));
}

/** The one local project a name or a path means, or the question to ask.
 *  The roster answers first; a folder found on this computer answers only
 *  when the roster has nothing by that name or path. */
export function chooseLocalProject(named: string | null | undefined): LocalProjectChoice {
  const wanted = String(named ?? '').trim();
  const roster = localProjects();
  if (!wanted) return { kind: roster.length === 1 ? 'found' : 'choose', ...(roster.length === 1 ? { project: roster[0]! } : { named: '', choices: roster }) } as LocalProjectChoice;
  const pick = (rows: LocalProject[]): LocalProjectChoice | null => {
    if (path.isAbsolute(wanted)) {
      const resolved = path.resolve(wanted);
      const byPath = rows.find((row) => path.resolve(row.path) === resolved);
      return byPath ? { kind: 'found', project: byPath } : null;
    }
    const lower = wanted.toLowerCase();
    const byName = rows.filter((row) => row.name.toLowerCase() === lower);
    if (byName.length === 1) return { kind: 'found', project: byName[0]! };
    if (byName.length > 1) return { kind: 'choose', named: wanted, choices: byName };
    return null;
  };
  const fromRoster = pick(roster);
  if (fromRoster) return fromRoster;
  const found = foundLocalProjects();
  return pick(found) ?? { kind: 'not_found', named: wanted, choices: [...roster, ...found] };
}

/** Makes a found project a work folder before it is linked. The owner's link
 *  (a click, or asking Clem for it by name or path) is what adds that one
 *  folder; nothing else in the home is added. */
export function admitLocalProject(project: LocalProject): LocalProject {
  if (!project.found) return project;
  addWorkspaceDir(project.path);
  const { found: _found, ...admitted } = project;
  return admitted;
}

/** What a linked folder is now: still there, still a repository. */
export function localProjectAt(folder: string | null | undefined): { present: boolean; git: boolean } {
  const at = String(folder ?? '').trim();
  if (!at || !path.isAbsolute(at)) return { present: false, git: false };
  try {
    const present = existsSync(at);
    return { present, git: present && existsSync(path.join(at, '.git')) };
  } catch {
    return { present: false, git: false };
  }
}
