/** Only a 404 means the conversation is gone. No answer (offline, restarting,
 *  timed out, 5xx) is a daemon that could not be reached, not a missing chat. */
export function isMissingConversation(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404;
}

/** Retry a load that could not reach the daemon; never a missing (404) chat. */
export function shouldRetrySessionLoad(failures: number, error: unknown): boolean {
  return !isMissingConversation(error) && failures < 3;
}
