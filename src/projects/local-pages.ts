/**
 * The pages made in a project: HTML files that work in the project wrote into
 * one of its linked local projects, as things the owner can look at.
 *
 * A page is listed because the work recorded writing it (the index of saved
 * files) and because it lies inside a folder the owner linked. It is found
 * again from its id each time it is read, so a link that was removed or a file
 * that moved stops being readable at once. Nothing here writes to the folder.
 *
 * A page is shown two ways. On the desktop the document itself is framed, in
 * a sandbox with no origin: its scripts run and public libraries load, and it
 * cannot call anything, submit anything or reach the app that frames it. On
 * the phone the page is rendered on the Mac at the phone's width and sent as
 * an image, so nothing a page contains ever runs on the phone.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { listFileDeliverablesUnder } from '../memory/deliverable-index.js';
import { isSensitivePath } from '../runtime/security.js';
import { getProject, listProjects, listResources } from './project-record.js';

const PAGE_EXTENSIONS = new Set(['.html', '.htm']);
const MOST_PAGES = 50;
/** A page larger than this is opened in a browser, not framed or rendered here. */
export const LARGEST_PAGE_BYTES = 8_000_000;

export interface ProjectPageView {
  id: string;
  /** The file's name, and the folder it lies in when that says more. */
  name: string;
  folder: string;
  /** Where it is inside the local project. */
  relativePath: string;
  localProject: { name: string; path: string };
  madeAt: string;
  /** The conversation or task that wrote it, when the record names one. */
  sessionId: string | null;
}

interface FoundPage { view: ProjectPageView; file: string }

function pageId(file: string): string {
  return `pg_${createHash('sha256').update(file).digest('hex').slice(0, 24)}`;
}

function real(target: string): string | null {
  try { return realpathSync(target); } catch { return null; }
}

function inside(folder: string, file: string): boolean {
  const relative = path.relative(folder, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function linkedFolders(projectId: string): Array<{ name: string; path: string; real: string }> {
  const folders: Array<{ name: string; path: string; real: string }> = [];
  for (const resource of listResources(projectId)) {
    if (resource.kind !== 'folder' || !resource.ref || !path.isAbsolute(resource.ref)) continue;
    const resolved = real(resource.ref);
    if (!resolved) continue;
    folders.push({ name: resource.label || path.basename(resource.ref), path: resource.ref, real: resolved });
  }
  return folders;
}

/** A recorded file as a page of this project, or null when it is not one now. */
function asPage(target: string, folders: ReturnType<typeof linkedFolders>): { file: string; folder: (typeof folders)[number] } | null {
  if (!PAGE_EXTENSIONS.has(path.extname(target).toLowerCase())) return null;
  const file = real(target);
  if (!file || isSensitivePath(file)) return null;
  // Through the real path: a link inside a linked folder cannot show a file outside it.
  const folder = folders.find((row) => inside(row.real, file));
  if (!folder) return null;
  try { if (!statSync(file).isFile()) return null; } catch { return null; }
  // Nothing under a hidden folder is a page: those hold settings and history.
  if (path.relative(folder.real, file).split(path.sep).some((part) => part.startsWith('.'))) return null;
  return { file, folder };
}

function found(projectId: string): FoundPage[] {
  const project = getProject(projectId);
  if (!project) return [];
  const folders = linkedFolders(project.id);
  if (folders.length === 0) return [];
  const pages: FoundPage[] = [];
  const seen = new Set<string>();
  for (const row of listFileDeliverablesUnder(folders.flatMap((folder) => [folder.path, folder.real]), 400)) {
    const page = asPage(row.target, folders);
    if (!page || seen.has(page.file)) continue;
    seen.add(page.file);
    const relativePath = path.relative(page.folder.real, page.file).split(path.sep).join('/');
    pages.push({
      file: page.file,
      view: {
        id: pageId(page.file),
        name: path.basename(page.file),
        folder: path.basename(path.dirname(page.file)),
        relativePath,
        localProject: { name: page.folder.name, path: page.folder.path },
        madeAt: row.createdAt,
        sessionId: row.sessionId,
      },
    });
    if (pages.length >= MOST_PAGES) break;
  }
  return pages;
}

/** The pages made in a project, newest first. */
export function pagesMadeInProject(projectId: string): ProjectPageView[] {
  try { return found(projectId).map((page) => page.view); } catch { return []; }
}

/**
 * The page a conversation or task wrote, by the name its saved-file card
 * shows: the file's name and the folder it lies in. Found only among pages
 * the record says THAT session wrote, in a project that is still active and
 * still links the folder. More than one match is no match: a card never opens
 * the wrong page.
 */
export function pageMadeBySession(
  sessionId: string | null | undefined,
  name: string | null | undefined,
  folder?: string | null,
): { projectId: string; page: ProjectPageView } | null {
  const session = String(sessionId ?? '').trim();
  const wanted = String(name ?? '').trim();
  const within = String(folder ?? '').trim();
  if (!session || !wanted) return null;
  const matches: Array<{ projectId: string; page: ProjectPageView }> = [];
  const seen = new Set<string>();
  try {
    for (const project of listProjects({ includeArchived: false }).slice(0, 100)) {
      for (const page of pagesMadeInProject(project.id)) {
        if (page.sessionId !== session || page.name !== wanted || (within && page.folder !== within)) continue;
        // Two projects may link the same folder: the page is one page.
        const key = `${page.localProject.path}\n${page.relativePath}`;
        if (seen.has(key)) continue;
        seen.add(key);
        matches.push({ projectId: project.id, page });
      }
    }
  } catch {
    return null;
  }
  return matches.length === 1 ? matches[0]! : null;
}

export type ProjectPageRead =
  | { ok: true; view: ProjectPageView; file: string }
  | { ok: false; reason: 'not_found' }
  /** Still the owner's to open in a browser; too large to frame or render here. */
  | { ok: false; reason: 'too_large'; view: ProjectPageView; file: string };

/** One page by its id, found again from the project as it is now. */
export function pageOfProject(projectId: string, id: string): ProjectPageRead {
  const page = found(projectId).find((row) => row.view.id === id);
  if (!page || !existsSync(page.file)) return { ok: false, reason: 'not_found' };
  try {
    if (statSync(page.file).size > LARGEST_PAGE_BYTES) return { ok: false, reason: 'too_large', view: page.view, file: page.file };
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  return { ok: true, view: page.view, file: page.file };
}

/** The document as it is on disk. */
export function readPageDocument(file: string): string {
  return readFileSync(file, 'utf8');
}

/**
 * What a framed page may do. It has no origin (sandbox without same-origin),
 * so it holds no cookie and no storage of the app. Its own scripts and styles
 * run, and scripts, styles, fonts, images and media load from public https
 * addresses, because pages are written with public libraries. It may not call
 * anything (connect-src), submit a form, frame another page, start a worker,
 * or be framed by anything but the app.
 */
export function localPageContentPolicy(): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    'sandbox allow-scripts',
    "script-src 'unsafe-inline' https:",
    "style-src 'unsafe-inline' https:",
    'img-src data: blob: https:',
    'font-src data: https:',
    'media-src data: blob: https:',
    "connect-src 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "worker-src 'none'",
    "manifest-src 'none'",
  ].join('; ');
}

/**
 * Whether a rendered part of a page shows nothing: every pixel the same
 * colour. A part that starts below the end of a page shows only the page's
 * background, which is how the end of a page is found. An image that cannot
 * be read is not called blank.
 */
export function pageImageIsBlank(png: Buffer): boolean {
  try {
    if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) return false;
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const bitDepth = png[24];
    const colourType = png[25];
    const interlace = png[28];
    if (bitDepth !== 8 || interlace !== 0 || (colourType !== 2 && colourType !== 6)) return false;
    const channels = colourType === 6 ? 4 : 3;
    const chunks: Buffer[] = [];
    for (let offset = 8; offset + 12 <= png.length;) {
      const length = png.readUInt32BE(offset);
      if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
    }
    const raw = inflateSync(Buffer.concat(chunks));
    const stride = width * channels;
    if (raw.length < (stride + 1) * height) return false;
    // Undo each row's filter (PNG section 9) and compare every pixel with the first.
    let above = Buffer.alloc(stride);
    let first: Buffer | null = null;
    for (let row = 0; row < height; row += 1) {
      const start = row * (stride + 1);
      const filter = raw[start]!;
      const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
      for (let index = 0; index < stride; index += 1) {
        const left = index >= channels ? line[index - channels]! : 0;
        const up = above[index]!;
        const upLeft = index >= channels ? above[index - channels]! : 0;
        let predicted = 0;
        if (filter === 1) predicted = left;
        else if (filter === 2) predicted = up;
        else if (filter === 3) predicted = (left + up) >> 1;
        else if (filter === 4) {
          const estimate = left + up - upLeft;
          const nearLeft = Math.abs(estimate - left);
          const nearUp = Math.abs(estimate - up);
          const nearUpLeft = Math.abs(estimate - upLeft);
          predicted = nearLeft <= nearUp && nearLeft <= nearUpLeft ? left : nearUp <= nearUpLeft ? up : upLeft;
        } else if (filter !== 0) return false;
        line[index] = (line[index]! + predicted) & 0xff;
      }
      first ??= Buffer.from(line.subarray(0, channels));
      for (let index = 0; index < stride; index += 1) {
        if (line[index] !== first[index % channels]) return false;
      }
      above = line;
    }
    return true;
  } catch {
    return false;
  }
}
