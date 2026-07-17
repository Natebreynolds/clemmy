export function updaterErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isMissingReleaseMetadataError(err: unknown): boolean {
  const message = updaterErrorMessage(err);
  return /No published versions on GitHub/i.test(message)
    || (/latest(?:-[a-z0-9_-]+)?\.ya?ml/i.test(message)
      && /(?:cannot find|not found|404)/i.test(message));
}

/**
 * electron-updater logs an error internally before it emits/rejects the same
 * condition through its public API. Clementine handles missing release
 * metadata as an ordinary "no update" state, so retaining the package's raw
 * stack trace creates a duplicate false alarm in the supervisor log.
 */
export function shouldSuppressUpdaterInternalError(message: unknown): boolean {
  return isMissingReleaseMetadataError(message);
}

/**
 * electron-updater can surface one failed check through both its `error`
 * event and the `checkForUpdates()` rejection. Keep the user-visible state
 * transition idempotent without suppressing a later, genuinely new check.
 */
export function shouldReportUpdaterCondition(
  lastReportedAt: number,
  now: number,
  dedupeWindowMs = 5_000,
): boolean {
  return lastReportedAt <= 0 || now - lastReportedAt >= dedupeWindowMs;
}
