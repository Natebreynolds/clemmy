import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { convertToMarkdown, convertUrlToMarkdown, isConvertibleExtension } from './markitdown.js';
import { describeImage, hasOpenAiKey, isAudioExtension, isImageExtension, transcribeAudio } from './transcribe.js';

/**
 * Unified attachment ingestion — the ONE pipeline every transport (desktop
 * dashboard, Discord, …) funnels file/URL attachments through. Each transport
 * supplies bytes / a local path / a URL; this module saves the original,
 * converts it to Markdown via the markitdown runtime, and hands back a result
 * the caller folds into the user's turn with foldAttachmentsIntoMessage().
 *
 * Storage: ingested attachments live in an INBOX keyed by a generated id, so
 * a file can be attached BEFORE a chat session exists (fresh-chat case). The
 * chat handler resolves ids → markdown at send time.
 */

const MAX_MARKDOWN_CHARS = 24_000;
const INBOX_DIR = path.join(BASE_DIR, 'state', 'attachments-inbox');
/** Drop inbox entries older than this so the dir does not grow unbounded. */
const INBOX_TTL_MS = 24 * 60 * 60 * 1000;
/** Reject attachments larger than this — memory + DoS safety. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Extensions markitdown cannot extract. We return a clear, actionable message
 * instead of feeding the converter (which would error) or emitting binary
 * garbage — so any of these "getting through" never breaks the turn.
 */
const UNSUPPORTED_EXTENSIONS = new Map<string, string>([
  ['.mp4', 'video'], ['.mov', 'video'], ['.avi', 'video'], ['.mkv', 'video'],
  ['.webm', 'video'], ['.wmv', 'video'], ['.flv', 'video'], ['.m4v', 'video'], ['.mpg', 'video'], ['.mpeg', 'video'],
  ['.exe', 'executable'], ['.dmg', 'disk image'], ['.iso', 'disk image'], ['.app', 'application'],
  ['.bin', 'binary'], ['.dll', 'binary'], ['.so', 'binary'], ['.dylib', 'binary'],
]);

export function unsupportedReason(name: string): string | null {
  const kind = UNSUPPORTED_EXTENSIONS.get(path.extname(name).toLowerCase());
  if (!kind) return null;
  if (kind === 'video') {
    return 'Video is not supported yet — markitdown cannot read video files. Extract the audio track (or share a transcript) and I can read that.';
  }
  return `This is a ${kind} file — there is no text content to extract.`;
}

/** A NUL byte in the first chunk is a strong binary-file signal. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

function tooLargeError(bytes: number): string {
  return `File is too large (${Math.round(bytes / 1_000_000)}MB; limit ${Math.round(MAX_ATTACHMENT_BYTES / 1_000_000)}MB). Trim it or share a smaller export.`;
}

export interface IngestInput {
  /** Display name (original filename, or a URL). */
  name: string;
  /** Uploaded file content. */
  bytes?: Buffer;
  /** A file already on disk (e.g. workspace path). */
  sourcePath?: string;
  /** A remote URL — YouTube/web pages convert directly; file URLs are fetched. */
  url?: string;
}

export interface IngestedAttachment {
  name: string;
  markdown?: string;
  error?: string;
  /** For images: the persisted raw file under state/attachments-files, so a
   *  vision-capable brain can LOOK at the actual pixels via view_image
   *  instead of settling for the OCR/description text. */
  imagePath?: string;
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_MARKDOWN_CHARS
    ? `${trimmed.slice(0, MAX_MARKDOWN_CHARS)}\n\n…[truncated ${trimmed.length - MAX_MARKDOWN_CHARS} chars]`
    : trimmed;
}

export function sanitizeAttachmentName(name: string): string {
  const base = path.basename(name).replace(/[^A-Za-z0-9._ -]/g, '_').trim().slice(0, 120);
  return base || 'attachment';
}

function looksLikeMediaPage(url: string): boolean {
  return /(?:youtube\.com\/watch|youtu\.be\/|youtube\.com\/shorts)/i.test(url);
}

/** Extract YouTube URLs from free text so a pasted link auto-ingests. */
export function extractYouTubeUrls(text: string): string[] {
  const re = /https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\?[^\s]*v=[\w-]+|shorts\/[\w-]+)|youtu\.be\/[\w-]+)[^\s]*/gi;
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) seen.add(m[0]);
  return [...seen];
}

async function fetchToBytes(url: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `${res.status} ${res.statusText} fetching ${url}` };
    // Reject early on a declared oversize body.
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > MAX_ATTACHMENT_BYTES) return { ok: false, error: tooLargeError(declared) };
    // Stream-cap in case Content-Length is absent or lies, so a huge body
    // can never balloon the daemon's memory.
    const reader = res.body?.getReader();
    if (!reader) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > MAX_ATTACHMENT_BYTES) return { ok: false, error: tooLargeError(bytes.length) };
      return { ok: true, bytes };
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_ATTACHMENT_BYTES) {
        try { await reader.cancel(); } catch { /* best-effort abort */ }
        return { ok: false, error: tooLargeError(total) };
      }
      chunks.push(Buffer.from(value));
    }
    return { ok: true, bytes: Buffer.concat(chunks) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ingest a single attachment → converted Markdown. Never throws; failures
 * come back as { error } so the caller surfaces them honestly to the user.
 */
export async function ingestAttachment(input: IngestInput): Promise<IngestedAttachment> {
  const name = sanitizeAttachmentName(input.name);
  try {
    // Known-unsupported (video, executables, …): bail with a clear message
    // before fetching/converting anything.
    const unsupported = unsupportedReason(name);
    if (unsupported) return { name, error: unsupported };

    // Pure URL with no bytes/path: YouTube/web convert directly; other URLs
    // (e.g. a Discord-hosted file) get fetched so the extension picks the
    // right converter.
    if (input.url && !input.bytes && !input.sourcePath) {
      if (looksLikeMediaPage(input.url) || !/\.[a-z0-9]{1,5}(?:\?|$)/i.test(input.url)) {
        const res = await convertUrlToMarkdown(input.url);
        return res.ok ? { name, markdown: clip(res.markdown) } : { name, error: res.error };
      }
      const fetched = await fetchToBytes(input.url);
      if (!fetched.ok) return { name, error: fetched.error };
      input = { name, bytes: fetched.bytes };
    }

    let target: string;
    if (input.bytes) {
      if (input.bytes.length === 0) return { name, error: 'File is empty.' };
      if (input.bytes.length > MAX_ATTACHMENT_BYTES) return { name, error: tooLargeError(input.bytes.length) };
      const dir = path.join(BASE_DIR, 'state', 'attachments-files');
      mkdirSync(dir, { recursive: true });
      target = path.join(dir, `${randomUUID()}__${name}`);
      writeFileSync(target, input.bytes);
    } else if (input.sourcePath) {
      if (!existsSync(input.sourcePath)) return { name, error: `File not found: ${input.sourcePath}` };
      const size = statSync(input.sourcePath).size;
      if (size > MAX_ATTACHMENT_BYTES) return { name, error: tooLargeError(size) };
      target = input.sourcePath;
    } else {
      return { name, error: 'No file content provided.' };
    }

    // Audio (and audio extracted from video) → Whisper: cheap, reliable,
    // ~$0.006/min. No ffmpeg needed for plain audio files.
    if (isAudioExtension(target)) {
      const res = await transcribeAudio(target);
      return res.ok ? { name, markdown: clip(`# Transcript — ${name}\n\n${res.text}`) } : { name, error: res.error };
    }
    // Images → vision OCR + description when a key is set (real text
    // extraction); otherwise fall back to markitdown's metadata-only path —
    // and SAY SO, so a no-key user (e.g. codex_oauth, which carries no OpenAI
    // key) isn't silently given metadata-only or a misleading "reinstall" error.
    if (isImageExtension(target)) {
      // The raw pixels are the primary artifact: when the file lives in OUR
      // store (bytes were persisted above), carry its path so a vision brain
      // can view_image it natively — description text becomes supplementary.
      const imagePath = target.startsWith(path.join(BASE_DIR, 'state', 'attachments-files') + path.sep)
        ? target
        : undefined;
      const keyed = hasOpenAiKey();
      if (keyed) {
        const res = await describeImage(target);
        if (res.ok) return { name, markdown: clip(res.text), imagePath };
        // vision failed — fall through to markitdown metadata rather than error
      }
      const res = await convertToMarkdown(target);
      if (res.ok) {
        const note = keyed || imagePath
          ? ''
          : '\n\n> ⚠️ Image metadata only. Full image analysis (text/OCR + description) needs an OpenAI API key — set OPENAI_API_KEY to enable vision.';
        return { name, markdown: clip(res.markdown + note), imagePath };
      }
      // Metadata failed too — with a stored image the native view still works.
      if (imagePath) return { name, markdown: '_(no extractable text)_', imagePath };
      return {
        name,
        error: keyed
          ? res.error
          : `Image analysis needs an OpenAI API key — set OPENAI_API_KEY for text/OCR + description. (Metadata-only fallback also unavailable: ${res.error})`,
      };
    }
    if (isConvertibleExtension(target)) {
      const res = await convertToMarkdown(target);
      return res.ok ? { name, markdown: clip(res.markdown) } : { name, error: res.error };
    }
    // Not a known convertible type: read the bytes and decide. Real text →
    // return it; binary (NUL bytes) → a clean message, never garbage.
    const raw = readFileSync(target);
    if (looksBinary(raw)) {
      return { name, error: `This looks like a binary "${path.extname(name) || 'unknown'}" file with no extractable text. Supported: PDF, Office docs, images, audio, EPub, and YouTube links.` };
    }
    return { name, markdown: clip(raw.toString('utf-8')) };
  } catch (err) {
    return { name, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Fold converted attachments into the agent-facing turn text. Empty/no
 * attachments → message unchanged. Errors are surfaced inline so the agent
 * (and user) see WHY a file could not be read rather than silently dropping it.
 */
export function foldAttachmentsIntoMessage(message: string, attachments: IngestedAttachment[]): string {
  const usable = attachments.filter(Boolean);
  if (usable.length === 0) return message;
  const blocks = usable.map((a) => {
    if (a.error) return `### Attachment: ${a.name}\n\n_Could not read this file: ${a.error}_`;
    const nativeView = a.imagePath
      ? `\n\n> 🖼 This is an IMAGE — call view_image with path "${a.imagePath}" to look at it directly. The text above is only a machine description.`
      : '';
    return `### Attachment: ${a.name}\n\n${a.markdown || '_(no extractable content)_'}${nativeView}`;
  });
  const head = message.trim() || 'The user attached the following file(s) — use their content to answer.';
  return `${head}\n\n---\n\n${blocks.join('\n\n---\n\n')}`;
}

// ── Inbox: persist ingested attachments by id so they survive the gap
// between "attach" and "send" (and a fresh session that has no id yet). ──

export function saveIngestedToInbox(att: IngestedAttachment): string {
  mkdirSync(INBOX_DIR, { recursive: true });
  pruneInbox();
  const id = randomUUID();
  writeFileSync(path.join(INBOX_DIR, `${id}.json`), JSON.stringify(att), 'utf-8');
  return id;
}

export function loadInboxAttachment(id: string): IngestedAttachment | null {
  if (!/^[A-Za-z0-9-]+$/.test(id)) return null; // path-traversal guard
  const file = path.join(INBOX_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf-8')) as IngestedAttachment;
  } catch {
    return null;
  }
}

function pruneInbox(): void {
  try {
    for (const entry of readdirSync(INBOX_DIR)) {
      const full = path.join(INBOX_DIR, entry);
      try {
        if (Date.now() - statSync(full).mtimeMs > INBOX_TTL_MS) {
          rmSync(full, { force: true });
        }
      } catch {
        /* ignore individual entries */
      }
    }
  } catch {
    /* inbox may not exist yet */
  }
}

// ── Native image viewing (2026-08-07): the pixels, not a description ─────────

const VIEWABLE_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Anthropic's per-image API cap is 5MB; stay under it with base64 overhead. */
const MAX_VIEWABLE_IMAGE_BYTES = 3_750_000;

export type ViewableImage =
  | { ok: true; base64: string; mimeType: string; bytes: number; name: string }
  | { ok: false; error: string };

/**
 * Load a stored attachment image for native viewing. Fail-closed guards:
 * the path must resolve INSIDE state/attachments-files (no traversal, no
 * arbitrary filesystem reads through a model-supplied path), must be a
 * supported image type, and must fit the provider's image cap.
 */
export function readImageForViewing(requestedPath: string): ViewableImage {
  try {
    const store = path.join(BASE_DIR, 'state', 'attachments-files');
    const resolved = path.resolve(String(requestedPath ?? ''));
    if (resolved !== store && !resolved.startsWith(store + path.sep)) {
      return { ok: false, error: 'view_image only reads stored attachment images (state/attachments-files).' };
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      return { ok: false, error: 'No stored image at that path — it may have been pruned. Ask the user to re-attach it.' };
    }
    const mimeType = VIEWABLE_IMAGE_MIME[path.extname(resolved).toLowerCase()];
    if (!mimeType) {
      return { ok: false, error: 'Not a viewable image type (png/jpg/gif/webp).' };
    }
    const bytes = statSync(resolved).size;
    if (bytes > MAX_VIEWABLE_IMAGE_BYTES) {
      return { ok: false, error: `Image is ${(bytes / 1_000_000).toFixed(1)}MB — over the ${(MAX_VIEWABLE_IMAGE_BYTES / 1_000_000).toFixed(1)}MB viewing cap. Use the description text instead.` };
    }
    const name = path.basename(resolved).replace(/^[0-9a-f-]{36}__/, '');
    return { ok: true, base64: readFileSync(resolved).toString('base64'), mimeType, bytes, name };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
