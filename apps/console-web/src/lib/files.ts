/**
 * Opening a file the agent produced, from where it was produced.
 *
 * `POST /api/console/files/open` has existed server-side with no client caller:
 * Clem could save a deliverable mid-chat and the only thing the thread offered
 * was a text excerpt. The route is vault-scoped, macOS-only, and returns typed
 * refusals — so this wrapper reports WHY an open did not happen instead of
 * failing silently, which would be the same dead end in a nicer costume.
 */
import { apiGet, apiPost } from './api';

export type OpenFileResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Evidence refs and deliverables carry either a plain absolute path or a
 *  file:// URL. Anything else (http, a bare name) has nowhere local to go. */
export function localPathFromUri(uri: string): string | null {
  const value = uri.trim();
  if (!value) return null;
  if (value.startsWith('file://')) {
    try { return decodeURIComponent(new URL(value).pathname) || null; } catch { return null; }
  }
  return value.startsWith('/') ? value : null;
}

/** Ask the daemon to reveal a file in the OS. Never throws: the caller is a
 *  button in a chat thread, and an unhandled rejection there reads as "nothing
 *  happened". */
export async function openFile(uri: string): Promise<OpenFileResult> {
  const filePath = localPathFromUri(uri);
  if (!filePath) return { ok: false, reason: 'That result does not point at a file on this Mac.' };
  try {
    await apiPost(`/api/console/files/open?path=${encodeURIComponent(filePath)}`);
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The route's own refusals, said the way the owner would ask about them.
    if (/outside vault/i.test(message)) return { ok: false, reason: 'That file lives outside Clementine’s folder, so it can’t be opened from here.' };
    if (/not found/i.test(message)) return { ok: false, reason: 'That file is no longer where it was saved.' };
    if (/only implemented on macOS/i.test(message)) return { ok: false, reason: 'Opening files from here works on macOS only.' };
    return { ok: false, reason: message || 'That file could not be opened.' };
  }
}

interface RecentFile { path: string; relPath: string; name: string; mtimeMs: number }

/**
 * Resolve a deliverable to an exact path.
 *
 * `deliverable_saved` publishes basenames only — the file's name and its
 * parent directory's name — so a surface that wants to open it has to look the
 * path up. `GET /api/console/files/recent` lists the vault newest-first with
 * full paths, which makes an exact (name, parent) match possible.
 *
 * Returns null when nothing matches AND when more than one thing does. Two
 * files legitimately share a name across folders, and quietly opening the
 * newest would eventually open the wrong one in front of the owner — better to
 * offer no button than the wrong file.
 */
export async function resolveDeliverablePath(name: string, dir: string): Promise<string | null> {
  if (!name) return null;
  try {
    const { files } = await apiGet<{ files?: RecentFile[] }>('/api/console/files/recent?limit=200');
    const matches = (files ?? []).filter((file) => {
      if (file.name !== name) return false;
      if (!dir) return true;
      const parent = file.relPath.split('/').slice(-2, -1)[0] ?? '';
      return parent === dir;
    });
    return matches.length === 1 ? matches[0].path : null;
  } catch {
    return null;
  }
}
