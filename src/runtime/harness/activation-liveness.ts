/**
 * Activation owner identity with provable liveness.
 *
 * A graph/node lease is held for a TTL. When a process is SIGKILLed mid-run it
 * cannot release, so its lease stays `released=0` for the remainder of that TTL
 * and every recovering process is refused with `lease-mismatch` — recovery is
 * blocked by a holder that no longer exists.
 *
 * Waiting out the TTL is not a fix: it stalls recovery and, if the TTL is long,
 * hides the crash behind a timeout. Instead the owner token names the host and
 * process that hold it, so a successor can ask whether that process is still
 * alive rather than assuming it is.
 *
 * Taking over a lease is NOT permission to perform provider I/O. The I/O claim
 * is fenced separately on the reservation, so a dead owner that already claimed
 * its crossing still forces the successor down the reconciliation path.
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';

/** `<host>:<pid>:<uuid>` — host and pid make liveness checkable, uuid keeps two activations in one process distinct. */
export function mintActivationOwner(): string {
  return `${os.hostname()}:${process.pid}:${randomUUID()}`;
}

interface ParsedActivationOwner {
  host: string;
  pid: number;
}

function parseActivationOwner(owner: string): ParsedActivationOwner | null {
  const parts = owner.split(':');
  if (parts.length < 3) return null;
  const pid = Number(parts[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { host: parts[0] ?? '', pid };
}

/**
 * True only when the owner is *provably* gone.
 *
 * Every uncertainty answers false, so an unparseable token, another host, or a
 * pid we cannot interrogate all keep the lease held. A recycled pid also
 * answers false, because the probe sees a living process. The cost of a false
 * "gone" is two activations believing they own one crossing; the cost of a
 * false "alive" is only waiting out the TTL.
 */
export function activationOwnerIsGone(owner: string): boolean {
  const parsed = parseActivationOwner(owner);
  if (!parsed) return false;
  // Pids are only comparable on the host that issued them.
  if (parsed.host !== os.hostname()) return false;
  if (parsed.pid === process.pid) return false;
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(parsed.pid, 0);
    return false;
  } catch (error) {
    // ESRCH: no such process. EPERM means it exists but is not ours to signal.
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
}
