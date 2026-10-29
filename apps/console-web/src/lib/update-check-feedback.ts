/** Only a completed, successful native check can claim the app is current. */
export function updateCheckFeedback(result: unknown, version?: string | null): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return 'Clem couldn’t confirm update availability. Try again.';
  }
  const value = result as { state?: unknown; error?: unknown };
  if (typeof value.error === 'string' && value.error.trim()) {
    return 'Couldn’t check for updates right now. Try again, or review the update notice.';
  }
  switch (value.state) {
    case 'no-update': return `You’re on the latest version${version ? ` (v${version})` : ''}.`;
    case 'available': return 'An update is available. Open the update notice to continue.';
    case 'downloading': return 'An update is downloading. The update notice shows its progress.';
    case 'ready-to-install': return 'An update is ready to install. Open the update notice when you’re ready.';
    case 'checking': return 'Checking for updates. The update notice will show the result.';
    case 'error': return 'Couldn’t check for updates right now. Try again, or review the update notice.';
    default: return 'Clem couldn’t confirm update availability. Try again.';
  }
}
