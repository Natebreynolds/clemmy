import { createHash } from 'node:crypto';
import type { ProjectRecord, ProjectResource } from './project-record.js';

export interface ProjectMemoryDirectory {
  text: string;
  revision: string;
  refs: Array<{ type: string; id: string }>;
}

const MAX_DIRECTORY_CHARS = 300;
const LABEL_CHARS = 24;

/** JSON object key order is not a source revision. Saved verification data
 * carries provider metadata; its bytes are hashed, never prompt-injected. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function label(value: string): string {
  const cleaned = value.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[link]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const clipped = cleaned.length > LABEL_CHARS ? `${cleaned.slice(0, LABEL_CHARS - 1)}…` : cleaned;
  return JSON.stringify(clipped);
}

function resourceSource(row: ProjectResource): unknown[] {
  return [row.id, row.projectId, row.kind, row.label, row.toolkit, row.accountId, row.ref,
    row.verifiedAt, row.verification, row.state, row.createdAt, row.updatedAt];
}

function projectSource(row: ProjectRecord): unknown[] {
  // Saved revision numbers normally rise with these bytes. Hash the bytes as
  // well so a same-revision repair/drift cannot keep a derived preview current.
  // Manual context participates in identity, never in the rendered preview.
  return [row.id, row.name, row.purpose, row.goals, row.context, row.status, row.revision,
    row.createdFrom, row.originSessionId, row.createdAt, row.updatedAt, row.archivedAt];
}

/** Read-only preview of one accepted project's saved navigation pointers.
 * Source bodies and provider arguments stay behind project_get. The source
 * revision includes omitted resources; refs name only entries actually shown.
 * This projection grants no authority and must not enter mount identity. */
export function renderProjectMemoryDirectory(
  project: ProjectRecord,
  resources: readonly ProjectResource[],
  options: { maxChars?: number } = {},
): ProjectMemoryDirectory {
  const eligible = resources.filter(row => row.projectId === project.id && row.state === 'active')
    .sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const revision = digest([projectSource(project), eligible.map(resourceSource)]);
  const empty = { text: '', revision, refs: [] };
  const budget = typeof options.maxChars === 'number' && Number.isFinite(options.maxChars)
    ? Math.max(0, Math.min(MAX_DIRECTORY_CHARS, Math.floor(options.maxChars))) : MAX_DIRECTORY_CHARS;
  if (project.status !== 'active' || !project.id || budget === 0) return empty;
  const lines = [
    'Project pointer preview; reopen saved details.',
    `project_get ${JSON.stringify({ project: project.id })} @v${project.revision} ${label(project.name)}`,
  ];
  const omittedLine = (shown: number) => `Resources omitted: ${eligible.length - shown}.`;
  // Reserve the complete omission count before admitting any entries. A tiny
  // budget must not turn a read target or resource id into a partial reference.
  const fits = (candidate: string[], shown: number) => [...candidate, omittedLine(shown)].join('\n').length <= budget;
  if (!fits(lines, 0)) return empty;
  const refs: ProjectMemoryDirectory['refs'] = [{ type: 'project', id: project.id }];
  let shown = 0;
  for (const row of eligible) {
    const line = `- ${row.kind} ${label(row.label)} id=${row.id} r=${digest(resourceSource(row)).slice(0, 12)} saved-check=${row.verifiedAt ? 'verified' : 'unverified'}`;
    if (!fits([...lines, line], shown + 1)) continue;
    lines.push(line);
    refs.push({ type: 'project_resource', id: row.id });
    shown++;
  }
  return { text: [...lines, omittedLine(shown)].join('\n'), revision, refs };
}
