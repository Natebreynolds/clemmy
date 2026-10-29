/**
 * What a tool saw, kept for the chat. A tool that returns a picture (a page
 * preview, a window the computer driver read, an attachment) already hands
 * the picture to the model; this keeps a copy on disk so the chat can show
 * the same picture under the tool's row, live and after a reload. Copies are
 * working files: a few per call, bounded in size, and swept after a week.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolMediaImageBlocks, type ToolMediaImageBlock } from './harness/tool-media-content.js';

export const CHAT_MEDIA_ROUTE = '/api/console/chat-media';
const MAX_IMAGES_PER_CALL = 2;
const MAX_IMAGE_BYTES = 4_000_000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const KEEP_DAYS = 7;

export interface ChatMediaRef { id: string; path: string; mimeType: string; bytes: number }

function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLEMENTINE_HOME?.trim() || path.join(os.homedir(), '.clementine-next');
}
export function chatMediaRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(homeDir(env), 'state', 'chat-media');
}
const SAFE = /^[A-Za-z0-9._-]{1,120}$/;
export function safeSegment(value: string): string | null {
  return SAFE.test(value) && !value.startsWith('.') ? value : null;
}
/** A chat's folder name: its id with anything a path could misread replaced. Deterministic, so the served path finds it again. */
export function chatFolderName(sessionId: string): string | null {
  return safeSegment(sessionId.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '').slice(0, 120));
}

/** The image blocks a tool's output carries, whether bare or under `content`. */
export function imageBlocksOf(output: unknown): ToolMediaImageBlock[] {
  if (Array.isArray(output)) return toolMediaImageBlocks(output);
  if (output && typeof output === 'object' && Array.isArray((output as { content?: unknown }).content)) {
    return toolMediaImageBlocks((output as { content: unknown[] }).content);
  }
  return [];
}

function extensionFor(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower === 'image/jpeg' || lower === 'image/jpg') return 'jpg';
  if (lower === 'image/webp') return 'webp';
  if (lower === 'image/gif') return 'gif';
  return 'png';
}

/**
 * Keep the pictures in a tool's output for this chat. Returns what the chat
 * row shows; empty when the output carries no picture or the names are unsafe.
 */
export function storeToolMedia(sessionId: string, callId: string, output: unknown, options: { root?: string; nowMs?: number } = {}): ChatMediaRef[] {
  const session = chatFolderName(sessionId);
  const call = safeSegment(callId.replace(/[^A-Za-z0-9._-]/g, '-'));
  if (!session || !call) return [];
  const blocks = imageBlocksOf(output).slice(0, MAX_IMAGES_PER_CALL);
  if (blocks.length === 0) return [];
  const root = options.root ?? chatMediaRoot();
  const dir = path.join(root, session);
  const refs: ChatMediaRef[] = [];
  for (const [index, block] of blocks.entries()) {
    let bytes: Buffer;
    try { bytes = Buffer.from(block.data, 'base64'); } catch { continue; }
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) continue;
    const id = `${call}-${index + 1}.${extensionFor(block.mimeType)}`;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, id), bytes);
    } catch { continue; }
    refs.push({ id, path: `${CHAT_MEDIA_ROUTE}/${session}/${id}`, mimeType: block.mimeType, bytes: bytes.length });
  }
  if (refs.length) sweepChatMedia({ root, nowMs: options.nowMs });
  return refs;
}

/** The file behind a chat-media reference, or null when the names are unsafe or the file is gone. */
export function chatMediaFile(sessionId: string, id: string, root: string = chatMediaRoot()): string | null {
  const session = safeSegment(sessionId);
  const file = safeSegment(id);
  if (!session || !file) return null;
  const full = path.join(root, session, file);
  return existsSync(full) ? full : null;
}

let lastSweepMs = 0;
/** Drop pictures older than a week; once an hour per process, or on demand. */
export function sweepChatMedia(options: { root?: string; nowMs?: number; keepDays?: number; force?: boolean } = {}): number {
  const nowMs = options.nowMs ?? Date.now();
  if (!options.force && nowMs - lastSweepMs < SWEEP_EVERY_MS) return 0;
  lastSweepMs = nowMs;
  const root = options.root ?? chatMediaRoot();
  const cutoff = nowMs - (options.keepDays ?? KEEP_DAYS) * 24 * 60 * 60 * 1000;
  let removed = 0;
  let sessions: string[];
  try { sessions = readdirSync(root); } catch { return 0; }
  for (const session of sessions) {
    const dir = path.join(root, session);
    let files: string[] = [];
    try { files = readdirSync(dir); } catch { continue; }
    for (const file of files) {
      const full = path.join(dir, file);
      try { if (statSync(full).mtimeMs < cutoff) { rmSync(full, { force: true }); removed += 1; } } catch { /* gone */ }
    }
    try { if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  }
  return removed;
}
