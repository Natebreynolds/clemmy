/**
 * Process-lifetime release cutover hold.
 *
 * This value is intentionally captured once, at module initialization. A live
 * daemon must never enter or leave the hold because a settings file changed
 * underneath it; changing the boundary requires a fresh process and therefore
 * a fresh singleton lease.
 */
export const CUTOVER_HOLD_ENV_KEY = 'CLEMMY_CUTOVER_HOLD' as const;

export function parseCutoverHold(value: string | undefined): boolean {
  return /^(?:1|true|on|yes)$/i.test(value?.trim() ?? '');
}

const CUTOVER_HOLD_AT_PROCESS_START = process.env[CUTOVER_HOLD_ENV_KEY];

export const CUTOVER_HOLD = parseCutoverHold(CUTOVER_HOLD_AT_PROCESS_START);

const CUTOVER_HOLD_TURN_ENGINE_AT_PROCESS_START =
  (process.env.CLEMMY_TURN_ENGINE ?? '').trim().toLowerCase();

/** The held process reports the frozen selector honestly. Startup separately
 * requires host_v1, so a stale read-only/legacy shell can never masquerade as
 * the production-engine candidate. */
export function cutoverHoldFreshTurnEngine(): 'host_v1' | 'host_v1_read_only' | 'invalid' {
  if (CUTOVER_HOLD_TURN_ENGINE_AT_PROCESS_START === 'host_v1') return 'host_v1';
  if (CUTOVER_HOLD_TURN_ENGINE_AT_PROCESS_START === 'host_v1_read_only') return 'host_v1_read_only';
  return 'invalid';
}

export function requireValidCutoverHoldConfiguration(): void {
  if (!CUTOVER_HOLD) return;
  const engine = cutoverHoldFreshTurnEngine();
  if (engine !== 'host_v1') {
    throw new Error(
      `Cutover hold requires CLEMMY_TURN_ENGINE=host_v1; observed ${JSON.stringify(CUTOVER_HOLD_TURN_ENGINE_AT_PROCESS_START || '(empty)')}.`,
    );
  }
}

/** Ordinary daemon ticks run every 15 seconds. Isolated integration tests can
 * shorten only the inert hold heartbeat so they can prove multiple cycles
 * without making the suite sleep for half a minute. */
function cutoverHoldHeartbeatMsAtProcessStart(): number {
  if (process.env.CLEMMY_TEST_ISOLATED_HOME !== '1') return 15_000;
  const parsed = Number.parseInt(process.env.CLEMMY_CUTOVER_HOLD_HEARTBEAT_MS ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 10 ? Math.min(parsed, 15_000) : 15_000;
}

export const CUTOVER_HOLD_HEARTBEAT_MS = cutoverHoldHeartbeatMsAtProcessStart();

let heartbeatCount = 0;

export function recordCutoverHoldHeartbeat(): number {
  heartbeatCount += 1;
  return heartbeatCount;
}

export function getCutoverHoldHeartbeatCount(): number {
  return heartbeatCount;
}
