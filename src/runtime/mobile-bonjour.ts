/**
 * Bonjour advertisement for the direct-app door.
 *
 * The pairing QR bakes in a LAN IP, and DHCP eventually reshuffles it. Rather
 * than making the user re-scan every time the router has an opinion, the
 * daemon advertises `_clemmy._tcp` on the local network with the certificate
 * fingerprint in the TXT record. The iOS app, on connection failure, browses
 * for the service whose fp matches its pinned certificate and follows it to
 * the new address. The fingerprint is already public-by-design (it rides in
 * every TLS handshake); identity proof remains the TLS pin itself, so a
 * spoofed advertisement can redirect the app only into a certificate check it
 * cannot pass.
 *
 * Implementation: spawns macOS's built-in `dns-sd -R`, which registers with
 * mDNSResponder and keeps the registration alive until the process exits. No
 * new dependencies; the child is supervised with bounded backoff and killed
 * on daemon shutdown.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import os from 'node:os';
import pino from 'pino';

const logger = pino({ name: 'clementine-next.mobile-bonjour' });

export const BONJOUR_SERVICE_TYPE = '_clemmy._tcp';

export interface BonjourAdvertisement {
  stop(): void;
}

export interface BonjourOptions {
  port: number;
  fingerprint: string;
  /** Test seam. */
  spawnImpl?: typeof spawn;
  hostname?: string;
}

/** Exported for the arg-shape pin — this exact invocation is the contract. */
export function bonjourArgs(opts: Pick<BonjourOptions, 'port' | 'fingerprint' | 'hostname'>): string[] {
  const host = (opts.hostname ?? os.hostname()).replace(/\.local$/i, '');
  return [
    '-R',
    `Clementine (${host})`,
    BONJOUR_SERVICE_TYPE,
    'local',
    String(opts.port),
    `fp=${opts.fingerprint}`,
  ];
}

const RESPAWN_BASE_MS = 2000;
const RESPAWN_MAX_MS = 60_000;

/**
 * Kill advertisements left behind by daemons that are no longer running.
 *
 * `stop()` below reaps the child on a graceful shutdown, but a daemon that is
 * SIGKILLed, crashes, or is restarted abruptly never reaches it — and mDNS
 * registrations live in the child, so the orphan keeps advertising a
 * fingerprint that no longer matches any running daemon. Measured on a
 * development machine 2026-08-22: 220 orphaned advertisers publishing 17
 * different fingerprints for one service.
 *
 * The discriminator is parentage, not the command line. An advertisement whose
 * parent is init has outlived whoever spawned it; one with a live parent
 * belongs to a running daemon and is left strictly alone, so a second
 * Clementine on the same machine never has its service torn down.
 */
export function orphanedAdvertisementPids(psOutput: string, selfPid: number): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pidText, ppidText, command] = match;
    if (!command?.includes('dns-sd') || !command.includes(BONJOUR_SERVICE_TYPE)) continue;
    if (Number(ppidText) !== 1) continue; // a live daemon still owns this one
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 1 || pid === selfPid) continue;
    pids.push(pid);
  }
  return pids;
}

function reapOrphanedAdvertisements(): number {
  let reaped = 0;
  try {
    const listing = spawnSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf8', timeout: 5_000 });
    if (listing.status !== 0 || !listing.stdout) return 0;
    for (const pid of orphanedAdvertisementPids(listing.stdout, process.pid)) {
      try {
        process.kill(pid, 'SIGTERM');
        reaped += 1;
      } catch { /* already gone, or not ours to signal */ }
    }
  } catch { /* reaping is hygiene, never a reason to fail to advertise */ }
  return reaped;
}

export function startBonjourAdvertisement(opts: BonjourOptions): BonjourAdvertisement {
  const spawnImpl = opts.spawnImpl ?? spawn;
  let child: ChildProcess | null = null;
  let stopped = false;
  let backoffMs = RESPAWN_BASE_MS;
  let respawnTimer: NodeJS.Timeout | null = null;

  const start = (): void => {
    if (stopped) return;
    try {
      child = spawnImpl('dns-sd', bonjourArgs(opts), { stdio: 'ignore' });
    } catch (err) {
      logger.warn({ err }, 'dns-sd unavailable; Bonjour advertisement off (QR still carries the address)');
      return;
    }
    child.on('error', (err) => {
      logger.warn({ err }, 'dns-sd failed to start; Bonjour advertisement off');
      child = null;
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopped) return;
      logger.warn({ code, signal, backoffMs }, 'dns-sd exited; re-advertising after backoff');
      respawnTimer = setTimeout(() => {
        respawnTimer = null;
        start();
      }, backoffMs);
      respawnTimer.unref?.();
      backoffMs = Math.min(backoffMs * 2, RESPAWN_MAX_MS);
    });
    backoffMs = RESPAWN_BASE_MS;
  };

  // Only when this is managing real processes. A test that injects a fake
  // spawn is not responsible for anything on the host's process table.
  if (!opts.spawnImpl) {
    const reaped = reapOrphanedAdvertisements();
    if (reaped > 0) logger.info({ reaped }, 'reaped orphaned Bonjour advertisements from earlier daemons');
  }

  start();

  return {
    stop(): void {
      stopped = true;
      if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
      if (child) {
        try { child.kill(); } catch { /* already gone */ }
        child = null;
      }
    },
  };
}
