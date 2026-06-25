/**
 * Workspace runner declarations are filenames under data/, not paths. Keeping
 * this strict makes save-time validation and runtime execution agree, and avoids
 * accidentally executing files from served view/ assets or other workspace dirs.
 */
export function runnerFilenameError(runner: string): string | null {
  const name = runner.trim();
  if (!name) return 'runner filename is empty';
  if (
    name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\\')
    || name.includes('\0')
  ) {
    return `runner must be a filename under data/ (for example "refresh.mjs"), not a path: ${runner}`;
  }
  return null;
}
