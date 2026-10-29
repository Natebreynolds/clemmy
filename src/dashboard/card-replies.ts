/**
 * What the owner asked Clem from one of her items on Home, kept so the item
 * itself can show what she is doing about it: on this screen after a reload,
 * and on the phone. One line per reply, recent ones only; the work and its
 * evidence stay in her thread, this only points at the run.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export interface CardReply {
  /** The Home item the owner replied on. */
  rowKey: string;
  /** What the item said when they replied. */
  title: string;
  /** The owner's words, or the choice they tapped. */
  reply: string;
  /** The dispatch the reply started (a From Clem run). */
  runId: string;
  since: string;
}

const KEEP_MS = 48 * 60 * 60 * 1000;
const KEEP_COUNT = 24;

function storeFile(): string {
  return path.join(BASE_DIR, 'state', 'home-card-replies.json');
}

function readAll(): CardReply[] {
  try {
    const file = storeFile();
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { replies?: unknown };
    return Array.isArray(parsed.replies) ? parsed.replies.filter((entry): entry is CardReply => {
      const e = entry as Partial<CardReply>;
      return typeof e?.rowKey === 'string' && typeof e.title === 'string' && typeof e.reply === 'string'
        && typeof e.runId === 'string' && typeof e.since === 'string';
    }) : [];
  } catch {
    return [];
  }
}

export function recordCardReply(reply: CardReply, nowMs = Date.now()): void {
  const kept = readAll().filter((entry) => entry.runId !== reply.runId && nowMs - Date.parse(entry.since) < KEEP_MS);
  const next = [reply, ...kept].slice(0, KEEP_COUNT);
  const file = storeFile();
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, replies: next })}\n`);
  renameSync(temp, file);
}

/** Recent replies, newest first; one per item (the latest reply to it). */
export function listCardReplies(nowMs = Date.now()): CardReply[] {
  const seen = new Set<string>();
  return readAll()
    .filter((entry) => nowMs - Date.parse(entry.since) < KEEP_MS)
    .sort((a, b) => Date.parse(b.since) - Date.parse(a.since))
    .filter((entry) => (seen.has(entry.rowKey) ? false : (seen.add(entry.rowKey), true)));
}
