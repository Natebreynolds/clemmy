import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export interface MeetingRecordMetadata {
  id: string;
  windowId: string;
  recordingId?: string;
  sdkUploadId?: string;
  status: string;
  startedAt: string;
  segmentCount: number;
}
type IndexKey = 'id' | 'windowId' | 'recordingId' | 'sdkUploadId';
export interface MeetingRecordInventoryEntry {
  readonly filePath: string;
  readonly generation: string;
  readonly metadata: Readonly<MeetingRecordMetadata>;
}
interface CachedEntry { generation: string | null; entry: MeetingRecordInventoryEntry | null }
export type MeetingRecordReadObserver = (input: { filePath: string; kind: 'inventory' | 'selected' }) => void;

function generation(filePath: string): string {
  const stat = lstatSync(filePath, { bigint: true });
  if (!stat.isFile() && !stat.isDirectory()) throw new Error('Unsupported meeting record generation.');
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function metadata(value: unknown): MeetingRecordMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id || typeof row.windowId !== 'string' || !row.windowId
    || typeof row.startedAt !== 'string' || !Array.isArray(row.segments)
    || !['detected', 'recording', 'completed', 'cancelled'].includes(String(row.status))
    || (row.recordingId !== undefined && typeof row.recordingId !== 'string')
    || (row.sdkUploadId !== undefined && typeof row.sdkUploadId !== 'string')) return null;
  return { id: row.id, windowId: row.windowId, startedAt: row.startedAt, status: row.status as string,
    segmentCount: row.segments.length,
    ...(row.recordingId === undefined ? {} : { recordingId: row.recordingId as string }),
    ...(row.sdkUploadId === undefined ? {} : { sdkUploadId: row.sdkUploadId as string }) };
}

/** Metadata only: full meeting records are never cached. Every lookup checks
 * file generations, decodes changed files, then freshly reads its selected
 * record. An unreadable generation cannot silently become an absent identity. */
export class MeetingRecordInventory {
  private files = new Map<string, CachedEntry>();
  private indexes: Record<IndexKey, Map<string, Set<string>>> = {
    id: new Map(), windowId: new Map(), recordingId: new Map(), sdkUploadId: new Map(),
  };
  private directoryGeneration: string | null = null;
  private observer: MeetingRecordReadObserver | undefined;

  constructor(private readonly directory: string) {}

  /** Known pathname changes must not depend on filesystem timestamp granularity.
   * Retain per-file metadata; the next lookup only re-enumerates the directory. */
  invalidateDirectory(): void {
    this.directoryGeneration = null;
  }

  observeReadsForTests(observer: MeetingRecordReadObserver | undefined): () => void {
    const previous = this.observer;
    this.observer = observer;
    return () => { this.observer = previous; };
  }

  private parse(filePath: string, kind: 'inventory' | 'selected'): unknown {
    this.observer?.({ filePath, kind });
    return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  }

  private replace(filePath: string, next?: CachedEntry): void {
    const previous = this.files.get(filePath)?.entry;
    if (previous) for (const key of Object.keys(this.indexes) as IndexKey[]) {
      const value = previous.metadata[key];
      if (!value) continue;
      const paths = this.indexes[key].get(value);
      paths?.delete(filePath);
      if (!paths?.size) this.indexes[key].delete(value);
    }
    if (!next) this.files.delete(filePath);
    else {
      this.files.set(filePath, next);
      if (next.entry) for (const key of Object.keys(this.indexes) as IndexKey[]) {
        const value = next.entry.metadata[key];
        if (!value) continue;
        let paths = this.indexes[key].get(value);
        if (!paths) { paths = new Set(); this.indexes[key].set(value, paths); }
        paths.add(filePath);
      }
    }
  }

  private refresh(): boolean {
    let directoryGeneration: string;
    try { directoryGeneration = generation(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      for (const filePath of this.files.keys()) this.replace(filePath);
      this.directoryGeneration = null;
      return true;
    }
    if (directoryGeneration !== this.directoryGeneration) {
      let names: string[];
      try { names = readdirSync(this.directory).filter((name) => name.endsWith('.json')); }
      catch { return false; }
      const paths = new Set(names.map((name) => path.join(this.directory, name)));
      for (const filePath of this.files.keys()) if (!paths.has(filePath)) this.replace(filePath);
      for (const filePath of paths) if (!this.files.has(filePath)) this.files.set(filePath, { generation: null, entry: null });
      // Recheck after enumeration: a concurrent rename may have changed the
      // directory while readdir ran. Never certify an incomplete generation.
      try { if (generation(this.directory) !== directoryGeneration) { this.directoryGeneration = null; return false; } }
      catch { this.directoryGeneration = null; return false; }
      this.directoryGeneration = directoryGeneration;
    }
    let certain = true;
    for (const [filePath, cached] of this.files) {
      let stamp: string;
      try { stamp = generation(filePath); }
      catch (error) {
        this.replace(filePath, { generation: null, entry: null });
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.invalidateDirectory();
        certain = false;
        continue;
      }
      if (stamp !== cached.generation) {
        try {
          const row = metadata(this.parse(filePath, 'inventory'));
          if (generation(filePath) !== stamp) throw new Error('Meeting record changed during inventory read.');
          this.replace(filePath, { generation: stamp, entry: row ? Object.freeze({ filePath, generation: stamp, metadata: Object.freeze(row) }) : null });
        } catch {
          let stable = false;
          try { stable = generation(filePath) === stamp; } catch { /* unknown generation */ }
          this.replace(filePath, { generation: stable ? stamp : null, entry: null });
        }
      }
      if (!this.files.get(filePath)?.entry) certain = false;
    }
    // A new/removed pathname during the file scan is also unknown until the
    // next refresh; do not permit an exact lookup from a partial inventory.
    try { if (generation(this.directory) !== this.directoryGeneration) { this.directoryGeneration = null; return false; } }
    catch { this.directoryGeneration = null; return false; }
    return certain;
  }

  lookup(key: IndexKey, value: string): { certain: boolean; entries: MeetingRecordInventoryEntry[] } {
    const certain = this.refresh();
    const entries = [...(this.indexes[key].get(value) ?? [])].flatMap((filePath) => {
      const entry = this.files.get(filePath)?.entry;
      return entry ? [entry] : [];
    });
    return { certain, entries };
  }

  readSelected(entry: MeetingRecordInventoryEntry): unknown | null {
    try {
      if (generation(this.directory) !== this.directoryGeneration || generation(entry.filePath) !== entry.generation) throw new Error('Unknown meeting record generation.');
      const value = this.parse(entry.filePath, 'selected');
      if (generation(this.directory) !== this.directoryGeneration || generation(entry.filePath) !== entry.generation || JSON.stringify(metadata(value)) !== JSON.stringify(entry.metadata)) {
        throw new Error('Meeting record changed during selected read.');
      }
      return value;
    } catch {
      this.replace(entry.filePath, { generation: null, entry: null });
      return null;
    }
  }

  matchesGeneration(entry: MeetingRecordInventoryEntry): boolean {
    try { return generation(entry.filePath) === entry.generation; } catch { return false; }
  }

  hasUniqueCaptureIdentity(entry: MeetingRecordInventoryEntry): boolean {
    return (['id', 'recordingId', 'sdkUploadId'] as const).every((key) => {
      const value = entry.metadata[key];
      const paths = value ? this.indexes[key].get(value) : undefined;
      return !value || (paths?.size === 1 && paths.has(entry.filePath));
    });
  }
}
