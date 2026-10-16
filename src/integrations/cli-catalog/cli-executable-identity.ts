import path from 'node:path';

/** Path identity only: never a content signature or account/operation grant.
 * Missing/relative paths cannot establish sameness. Windows rooted paths still
 * have an ambient drive, so require an explicit drive or complete UNC share. */
export function cliHealthExecutableIdentity(binaryPath: string | undefined, platform: NodeJS.Platform = process.platform): string | null {
  if (!binaryPath || binaryPath !== binaryPath.trim() || /[\u0000-\u001f\u007f]/.test(binaryPath)) return null;
  if (platform === 'win32') {
    const normalized = path.win32.normalize(binaryPath);
    const fullyQualified = /^[A-Za-z]:\\/.test(normalized)
      || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(normalized);
    return fullyQualified ? normalized.toLowerCase() : null;
  }
  return path.posix.isAbsolute(binaryPath) ? binaryPath : null;
}
