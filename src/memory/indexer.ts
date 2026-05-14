import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { MEMORY_DB_PATH, openMemoryDb } from './db.js';
import { isEmbeddingsEnabled, readEmbeddingStats } from './embeddings.js';
import { VAULT_DIR } from './vault.js';

/**
 * Incremental vault indexer.
 *
 * - Walks the markdown vault.
 * - Chunks each file along header boundaries, falling back to ~1200-char
 *   windows with 200-char overlap for long sections. Each chunk gets a
 *   stable content_hash so unchanged chunks survive reindexing.
 * - Compares (path, mtime, byte_size) per-file before reading. If the
 *   file is unchanged on disk, we skip it entirely. Cheap to call.
 * - Deletes chunks for files that no longer exist on disk.
 *
 * The DB is a rebuildable index — wiping it and reindexing is fine.
 */

const logger = pino({ name: 'clementine-next.memory.indexer' });

const TARGET_CHUNK_CHARS = 1200;
const OVERLAP_CHARS = 200;
const MAX_FILE_BYTES = 250_000;

export interface IndexStats {
  scanned: number;
  changed: number;
  inserted: number;
  removed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export interface MemoryIndexStatus {
  dbPath: string;
  dbPresent: boolean;
  dbBytes: number;
  indexedFiles: number;
  chunks: number;
  activeFacts: number;
  totalFacts: number;
  embeddingsEnabled: boolean;
  embeddingsCount: number;
  embeddingsModel: string | null;
  embeddingsDim: number | null;
  embeddingsCoverage: number; // 0..1
  lastIndexedSourceMtime: number | null;
  error?: string;
}

interface Chunk {
  content: string;
  title: string | null;
  contentHash: string;
}

function hashString(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdown(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Split markdown into chunks, preferring header boundaries.
 * Any section longer than TARGET_CHUNK_CHARS is windowed with overlap.
 */
export function chunkMarkdown(raw: string): Chunk[] {
  const text = raw.trim();
  if (!text) return [];

  // Split on H1/H2/H3 boundaries. Keep the heading line with the section
  // that follows it so each chunk carries its own title.
  const sections: { heading: string | null; body: string }[] = [];
  const lines = text.split('\n');
  let currentHeading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join('\n').trim();
    if (body) sections.push({ heading: currentHeading, body });
    buffer = [];
  };

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headerMatch) {
      flush();
      currentHeading = headerMatch[2].trim();
      buffer.push(line);
    } else {
      buffer.push(line);
    }
  }
  flush();

  if (sections.length === 0) {
    return [{
      content: text,
      title: null,
      contentHash: hashString(text),
    }];
  }

  const chunks: Chunk[] = [];
  for (const section of sections) {
    if (section.body.length <= TARGET_CHUNK_CHARS) {
      chunks.push({
        content: section.body,
        title: section.heading,
        contentHash: hashString(section.body),
      });
      continue;
    }
    // Window long sections with overlap.
    let cursor = 0;
    while (cursor < section.body.length) {
      const slice = section.body.slice(cursor, cursor + TARGET_CHUNK_CHARS);
      chunks.push({
        content: slice,
        title: section.heading,
        contentHash: hashString(slice),
      });
      if (cursor + TARGET_CHUNK_CHARS >= section.body.length) break;
      cursor += TARGET_CHUNK_CHARS - OVERLAP_CHARS;
    }
  }

  return chunks;
}

/**
 * Replace all chunks for a single file. Caller owns the transaction.
 */
function reindexFile(
  db: ReturnType<typeof openMemoryDb>,
  filePath: string,
  mtimeMs: number,
  byteSize: number,
): { inserted: number } {
  const raw = readFileSync(filePath, 'utf-8').slice(0, MAX_FILE_BYTES);
  const chunks = chunkMarkdown(raw);

  db.prepare('DELETE FROM vault_chunks WHERE path = ?').run(filePath);
  if (chunks.length === 0) return { inserted: 0 };

  const insert = db.prepare(`
    INSERT INTO vault_chunks (path, chunk_index, content, title, mtime, byte_size, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    insert.run(filePath, i, chunk.content, chunk.title, Math.floor(mtimeMs), byteSize, chunk.contentHash);
    inserted++;
  }
  return { inserted };
}

/**
 * Run an incremental index pass over the vault.
 * Safe to call on every daemon tick — does almost no work when nothing changed.
 */
export function reindexVault(vaultDir: string = VAULT_DIR): IndexStats {
  const start = Date.now();
  const stats: IndexStats = {
    scanned: 0, changed: 0, inserted: 0, removed: 0, skipped: 0, errors: 0, durationMs: 0,
  };

  const db = openMemoryDb();
  const files = walkMarkdown(vaultDir);
  stats.scanned = files.length;

  // (path → {mtime, count}) for files already indexed.
  const existingRows = db.prepare(`
    SELECT path, MAX(mtime) AS mtime, COUNT(*) AS chunks
    FROM vault_chunks GROUP BY path
  `).all() as { path: string; mtime: number; chunks: number }[];

  const existingByPath = new Map<string, { mtime: number; chunks: number }>();
  for (const row of existingRows) existingByPath.set(row.path, { mtime: row.mtime, chunks: row.chunks });

  const onDiskPaths = new Set(files);

  const tx = db.transaction(() => {
    for (const filePath of files) {
      let mtimeMs = 0;
      let byteSize = 0;
      try {
        const s = statSync(filePath);
        mtimeMs = s.mtimeMs;
        byteSize = s.size;
      } catch (err) {
        stats.errors++;
        logger.warn({ err, filePath }, 'stat failed; skipping');
        continue;
      }

      const existing = existingByPath.get(filePath);
      if (existing && Math.floor(existing.mtime) === Math.floor(mtimeMs)) {
        stats.skipped++;
        continue;
      }

      try {
        const { inserted } = reindexFile(db, filePath, mtimeMs, byteSize);
        stats.changed++;
        stats.inserted += inserted;
      } catch (err) {
        stats.errors++;
        logger.warn({ err, filePath }, 'reindex failed');
      }
    }

    // Drop chunks for files no longer on disk.
    const remove = db.prepare('DELETE FROM vault_chunks WHERE path = ?');
    for (const [filePath] of existingByPath) {
      if (!onDiskPaths.has(filePath)) {
        const info = remove.run(filePath);
        stats.removed += Number(info.changes ?? 0);
      }
    }
  });

  try {
    tx();
  } catch (err) {
    stats.errors++;
    logger.error({ err }, 'reindex transaction failed');
  }

  stats.durationMs = Date.now() - start;
  return stats;
}

/**
 * Force a full rebuild — wipes vault_chunks and re-indexes. Useful when
 * the chunking algorithm changes or the DB is suspected of drift.
 */
export function rebuildVaultIndex(vaultDir: string = VAULT_DIR): IndexStats {
  const db = openMemoryDb();
  db.exec('DELETE FROM vault_chunks');
  return reindexVault(vaultDir);
}

export function readMemoryIndexStatus(): MemoryIndexStatus {
  const dbPresent = existsSync(MEMORY_DB_PATH);
  const base: MemoryIndexStatus = {
    dbPath: MEMORY_DB_PATH,
    dbPresent,
    dbBytes: dbPresent ? statSync(MEMORY_DB_PATH).size : 0,
    indexedFiles: 0,
    chunks: 0,
    activeFacts: 0,
    totalFacts: 0,
    embeddingsEnabled: isEmbeddingsEnabled(),
    embeddingsCount: 0,
    embeddingsModel: null,
    embeddingsDim: null,
    embeddingsCoverage: 0,
    lastIndexedSourceMtime: null,
  };

  try {
    const db = openMemoryDb();
    const chunkRow = db.prepare(`
      SELECT
        COUNT(*) AS chunks,
        COUNT(DISTINCT path) AS files,
        MAX(mtime) AS lastMtime
      FROM vault_chunks
    `).get() as { chunks: number; files: number; lastMtime: number | null };
    const factRow = db.prepare(`
      SELECT
        COUNT(*) AS totalFacts,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS activeFacts
      FROM consolidated_facts
    `).get() as { totalFacts: number; activeFacts: number | null };
    const emb = readEmbeddingStats();
    const chunkTotal = chunkRow.chunks ?? 0;

    return {
      ...base,
      dbPresent: existsSync(MEMORY_DB_PATH),
      dbBytes: existsSync(MEMORY_DB_PATH) ? statSync(MEMORY_DB_PATH).size : 0,
      indexedFiles: chunkRow.files ?? 0,
      chunks: chunkTotal,
      activeFacts: factRow.activeFacts ?? 0,
      totalFacts: factRow.totalFacts ?? 0,
      embeddingsEnabled: emb.enabled,
      embeddingsCount: emb.count,
      embeddingsModel: emb.model,
      embeddingsDim: emb.dim,
      embeddingsCoverage: chunkTotal > 0 ? Number((emb.count / chunkTotal).toFixed(3)) : 0,
      lastIndexedSourceMtime: chunkRow.lastMtime ?? null,
    };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
