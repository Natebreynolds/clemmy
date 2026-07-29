/**
 * A proof request must outlive the daemon's own long-turn/recovery window.
 *
 * The exact-brain matrix intentionally disables provider fallover. A provider
 * can therefore consume the full ten-minute server-side turn budget before
 * infra recovery produces a valid answer. The client owns only the outer HTTP
 * deadline, so give the recovery turn, completion checks, and response flush
 * explicit headroom instead of racing the daemon at the same deadline.
 *
 * These are proof-harness limits only; they do not change production latency
 * or model/provider timeout policy.
 */
export const PROOF_SERVER_TURN_BUDGET_MS = 10 * 60_000;
export const PROOF_TURN_COMPLETION_HEADROOM_MS = 5 * 60_000;
export const PROOF_CLIENT_COMPLETION_TIMEOUT_MS =
  PROOF_SERVER_TURN_BUDGET_MS + PROOF_TURN_COMPLETION_HEADROOM_MS;
