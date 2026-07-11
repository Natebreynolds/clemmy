export function updaterErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isMissingReleaseMetadataError(err: unknown): boolean {
  const message = updaterErrorMessage(err);
  return /No published versions on GitHub/i.test(message)
    || (/latest(?:-[a-z0-9_-]+)?\.ya?ml/i.test(message)
      && /(?:cannot find|not found|404)/i.test(message));
}
