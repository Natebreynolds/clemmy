/**
 * Pure version-comparison helpers. Extracted from updater.ts so they
 * can be exercised by smoke tests in plain Node (the updater module
 * itself imports `electron` and won't load outside Electron).
 *
 * Behavior:
 *   - Strips a leading `v` / `V`.
 *   - Drops any pre-release / build suffix after `-` (so `0.4.32-beta.1`
 *     compares equal to `0.4.32`). This is intentional — the auto-
 *     updater's guard is about "is this strictly newer", and we don't
 *     want a stale GitHub metadata `0.4.32-rc1` to ratchet over `0.4.32`.
 *   - Parses each dot-separated segment as an integer; non-numeric
 *     segments resolve to 0.
 *   - Missing trailing segments are treated as 0 (`1.2` === `1.2.0`).
 */
export function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersionParts(left);
  const rightParts = normalizeVersionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

export function normalizeVersionParts(version: string): number[] {
  const clean = version.trim().replace(/^v/i, '');
  const [core] = clean.split('-', 1);
  return core.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}
