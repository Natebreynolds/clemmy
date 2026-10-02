/**
 * Whether this volume has room to download and install an update.
 *
 * An install holds several copies at once: the downloaded zip, Squirrel's own
 * copy of it, and the unpacked app beside the running one (about three times
 * the zip). Starting that on a nearly full disk does not just fail the update:
 * it fills the disk under everything else running on the machine. So the
 * download waits until the room is there, with a margin left for the rest.
 */
import { statfsSync } from 'node:fs';

const ZIP_MULTIPLE = 6;
const MARGIN_BYTES = 2 * 1024 ** 3;
/** Used when the release metadata carries no size. */
const ASSUMED_ZIP_BYTES = 600 * 1024 ** 2;

export interface UpdateRoomShortfall {
  neededBytes: number;
  freeBytes: number;
}

export function updateRoomShortfall(zipBytes: number | undefined, freeBytes: number): UpdateRoomShortfall | null {
  const zip = zipBytes !== undefined && Number.isFinite(zipBytes) && zipBytes > 0 ? zipBytes : ASSUMED_ZIP_BYTES;
  const neededBytes = zip * ZIP_MULTIPLE + MARGIN_BYTES;
  return freeBytes < neededBytes ? { neededBytes, freeBytes } : null;
}

/** Free bytes available to this user on the volume holding `dir`; null when unknown. */
export function freeDiskBytes(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** The mac zip's size from release metadata, when it is listed. */
export function updateZipBytes(files: ReadonlyArray<{ url?: string; size?: number }> | undefined): number | undefined {
  const zip = files?.find((file) => typeof file.url === 'string' && file.url.endsWith('.zip'));
  return typeof zip?.size === 'number' ? zip.size : undefined;
}

export function gigabytes(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(1);
}
