/**
 * `clementine mobile` CLI subcommands.
 *
 * Lets the user provision the mobile PWA PIN and drive the Cloudflare
 * Tunnel lifecycle from a terminal — the desktop wizard (Week 2b)
 * calls the same code paths from the dashboard UI.
 *
 * Subcommands:
 *   status                   — PIN configured?, last rotation, sessions, tunnel state
 *   set-pin                  — interactive (or --pin <digits>) PIN provisioning
 *   sessions                 — list active mobile sessions
 *   revoke-all               — invalidate every active mobile session
 *   tunnel detect            — show cloudflared binary path + version
 *   tunnel install           — `brew install cloudflared` on macOS
 *   tunnel login             — start `cloudflared tunnel login` (prints URL)
 *   tunnel list              — list tunnels on the connected CF account
 *   tunnel create <name>     — create a named tunnel
 *   tunnel route <tn> <host> — point hostname at tunnel
 *   tunnel start             — run the configured tunnel in foreground
 *   tunnel info              — show saved mobile-access state
 */

import { password } from '@inquirer/prompts';
import { hasPin, readPinMeta, setPin, validatePinForSet, PIN_MIN_LENGTH, PIN_MAX_LENGTH } from '../runtime/mobile-pin.js';
import { listSessions, revokeAllSessions } from '../runtime/mobile-sessions.js';
import {
  CloudflaredSupervisor,
  createTunnel,
  detectCloudflared,
  installCloudflaredViaBrew,
  listTunnels,
  routeDns,
  startCloudflaredLogin,
} from '../runtime/cloudflared.js';
import {
  readMobileAccess,
  setMobileAccessBinary,
  setMobileAccessStatus,
  setMobileAccessTunnel,
  updateMobileAccess,
  tunnelOriginUrl,
} from '../runtime/mobile-access-state.js';
import { BASE_DIR, WEBHOOK_HOST, WEBHOOK_PORT } from '../config.js';
import path from 'node:path';

function takeFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

export async function runMobileCli(args: string[]): Promise<number> {
  const sub = args[0] ?? 'status';

  if (sub === 'status') {
    const meta = readPinMeta();
    const sessions = listSessions();
    const access = readMobileAccess();
    console.log(`PIN configured: ${hasPin() ? 'yes' : 'no'}`);
    if (meta) console.log(`Last rotated:   ${meta.updatedAt}`);
    console.log(`Active sessions: ${sessions.length}`);
    for (const row of sessions) {
      const label = row.deviceLabel ? ` (${row.deviceLabel})` : '';
      console.log(`  - ${row.deviceId}${label}  last seen ${row.lastSeenAt}`);
    }
    console.log('');
    console.log(`Tunnel binary:  ${access.binary ? `${access.binary.path} (v${access.binary.version})` : 'not detected'}`);
    console.log(`Tunnel:         ${access.tunnel ? `${access.tunnel.name} @ ${access.tunnel.hostname} (${access.tunnel.id})` : 'not configured'}`);
    console.log(`Status:         ${access.status}${access.lastError ? `  — ${access.lastError}` : ''}`);
    console.log(`Auto-start:     ${access.autoStart ? 'yes' : 'no'}`);
    return 0;
  }

  if (sub === 'tunnel') {
    return runTunnelCli(args.slice(1));
  }

  if (sub === 'set-pin' || sub === 'rotate') {
    const inline = takeFlag(args, '--pin');
    let pin = inline;
    if (!pin) {
      try {
        pin = await password({
          message: `New mobile PIN (${PIN_MIN_LENGTH}–${PIN_MAX_LENGTH} chars, letters/digits/symbols):`,
          mask: '*',
          validate: (value) => {
            const err = validatePinForSet(value);
            return err ? err.message : true;
          },
        });
      } catch {
        // User aborted (Ctrl-C inside @inquirer/prompts throws).
        console.error('Aborted.');
        return 1;
      }
    }
    const validation = pin ? validatePinForSet(pin) : { code: 'EMPTY' as const, message: 'PIN is required.' };
    if (validation) {
      console.error(validation.message);
      return 1;
    }
    try {
      await setPin(pin);
    } catch (err) {
      console.error('Failed to set PIN:', (err as Error).message);
      return 1;
    }
    const revoked = await revokeAllSessions();
    console.log(`PIN saved. Invalidated ${revoked} existing session${revoked === 1 ? '' : 's'}.`);
    return 0;
  }

  if (sub === 'sessions') {
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log('No active mobile sessions.');
      return 0;
    }
    for (const row of sessions) {
      const label = row.deviceLabel ? ` (${row.deviceLabel})` : '';
      console.log(`${row.deviceId}${label}`);
      console.log(`  created:   ${row.createdAt}`);
      console.log(`  last seen: ${row.lastSeenAt}`);
      console.log(`  expires:   ${row.expiresAt}`);
      console.log(`  push:      ${row.pushSubscribed ? 'subscribed' : 'no'}`);
    }
    return 0;
  }

  if (sub === 'revoke-all') {
    const revoked = await revokeAllSessions();
    console.log(`Revoked ${revoked} session${revoked === 1 ? '' : 's'}.`);
    return 0;
  }

  console.log('Usage: clementine mobile <status|set-pin|sessions|revoke-all|tunnel> [...]');
  console.log('       clementine mobile tunnel <detect|install|login|list|create|route|start|info>');
  return 1;
}

async function runTunnelCli(args: string[]): Promise<number> {
  const sub = args[0] ?? 'info';

  if (sub === 'detect') {
    const result = await detectCloudflared();
    if (!result.binary) {
      console.log('cloudflared: not found');
      console.log('Install with: clementine mobile tunnel install');
      return 1;
    }
    console.log(`Binary:  ${result.binary}`);
    console.log(`Version: ${result.version ?? 'unknown'}`);
    console.log(`Source:  ${result.source}`);
    await setMobileAccessBinary({ path: result.binary, version: result.version ?? 'unknown' });
    return 0;
  }

  if (sub === 'install') {
    console.log('Running: brew install cloudflared');
    const res = await installCloudflaredViaBrew({
      onLine: (stream, line) => {
        const prefix = stream === 'stderr' ? '  ! ' : '    ';
        console.log(prefix + line);
      },
    });
    if (!res.ok) {
      console.error('Install failed:', res.error);
      return 1;
    }
    const det = await detectCloudflared();
    if (det.binary) {
      await setMobileAccessBinary({ path: det.binary, version: det.version ?? 'unknown' });
      console.log(`Installed: ${det.binary} (v${det.version ?? 'unknown'})`);
    }
    return 0;
  }

  if (sub === 'login') {
    const session = startCloudflaredLogin();
    await setMobileAccessStatus('awaiting-login');
    try {
      const url = await Promise.race([
        session.url,
        new Promise<string>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for cloudflared login URL')), 15_000)),
      ]);
      console.log('');
      console.log('Open this URL in your browser to authorize cloudflared:');
      console.log('');
      console.log(`  ${url}`);
      console.log('');
      console.log('Waiting for login to complete (up to 10 minutes)…');
      const outcome = await session.done;
      if (outcome.ok) {
        console.log(`Login complete. Cert saved to ${outcome.certPath}.`);
        await setMobileAccessStatus('configuring');
        return 0;
      }
      console.error('Login failed:', outcome.error);
      await setMobileAccessStatus('error', outcome.error);
      return 1;
    } catch (err) {
      session.cancel();
      console.error((err as Error).message);
      await setMobileAccessStatus('error', (err as Error).message);
      return 1;
    }
  }

  if (sub === 'list') {
    try {
      const tunnels = await listTunnels();
      if (tunnels.length === 0) {
        console.log('No tunnels found on this Cloudflare account.');
        return 0;
      }
      for (const t of tunnels) {
        console.log(`${t.id}  ${t.name}  (created ${t.created_at})`);
      }
      return 0;
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }

  if (sub === 'create') {
    const name = args[1];
    if (!name) {
      console.error('Usage: clementine mobile tunnel create <name>');
      return 1;
    }
    try {
      const tunnel = await createTunnel(name);
      console.log(`Created tunnel ${tunnel.name} (${tunnel.id})`);
      if (tunnel.credentialsFile) {
        console.log(`Credentials: ${tunnel.credentialsFile}`);
      }
      await updateMobileAccess((current) => ({
        ...current,
        tunnel: {
          id: tunnel.id,
          name: tunnel.name,
          hostname: current.tunnel?.hostname ?? '',
          credentialsFile: tunnel.credentialsFile,
        },
        status: 'configuring',
      }));
      return 0;
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }

  if (sub === 'route') {
    const tunnelArg = args[1];
    const hostname = args[2];
    if (!tunnelArg || !hostname) {
      console.error('Usage: clementine mobile tunnel route <tunnel-name-or-id> <hostname>');
      return 1;
    }
    try {
      await routeDns(tunnelArg, hostname);
      console.log(`Routed ${hostname} → tunnel ${tunnelArg}`);
      await updateMobileAccess((current) => ({
        ...current,
        tunnel: current.tunnel
          ? { ...current.tunnel, hostname }
          : { id: tunnelArg, name: tunnelArg, hostname },
      }));
      return 0;
    } catch (err) {
      console.error((err as Error).message);
      return 1;
    }
  }

  if (sub === 'start') {
    const access = readMobileAccess();
    if (!access.binary?.path) {
      console.error('cloudflared not detected. Run: clementine mobile tunnel detect');
      return 1;
    }
    if (!access.tunnel?.id) {
      console.error('No tunnel configured. Run: clementine mobile tunnel create <name>');
      return 1;
    }
    const localUrl = tunnelOriginUrl();
    const logFile = path.join(BASE_DIR, 'logs', 'cloudflared', 'tunnel.log');
    const supervisor = new CloudflaredSupervisor({
      binary: access.binary.path,
      tunnelNameOrId: access.tunnel.id,
      localUrl,
      logFile,
      onEvent: (event) => {
        if (event.type === 'log') {
          if (event.stream === 'stderr' || /error|err\b/i.test(event.line)) {
            console.error(`[${event.stream}] ${event.line}`);
          } else {
            console.log(`[${event.stream}] ${event.line}`);
          }
        } else if (event.type === 'connected') {
          console.log('Tunnel connected.');
          void setMobileAccessStatus('running').catch(() => undefined);
        } else if (event.type === 'restart-scheduled') {
          console.log(`Tunnel exited; restart attempt ${event.attempt} in ${Math.round(event.delayMs / 1000)}s`);
        } else if (event.type === 'restart-skipped') {
          console.error(`Tunnel restart skipped: ${event.reason}`);
        }
      },
    });
    await supervisor.start();
    console.log(`Cloudflared running for tunnel ${access.tunnel.name} → ${localUrl}`);
    console.log(`Logs: ${logFile}`);
    console.log('Press Ctrl-C to stop.');
    const onSignal = async (sig: NodeJS.Signals): Promise<void> => {
      console.log(`\nReceived ${sig}, stopping cloudflared…`);
      await supervisor.stop();
      await setMobileAccessStatus('inactive');
      process.exit(0);
    };
    process.on('SIGINT', () => { void onSignal('SIGINT'); });
    process.on('SIGTERM', () => { void onSignal('SIGTERM'); });
    await new Promise(() => undefined);
    return 0;
  }

  if (sub === 'info') {
    const access = readMobileAccess();
    console.log(JSON.stringify(access, null, 2));
    return 0;
  }

  console.log('Usage: clementine mobile tunnel <detect|install|login|list|create|route|start|info>');
  return 1;
}
