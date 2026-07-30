/**
 * `clementine mobile` CLI subcommands.
 *
 * Provisions the mobile PIN and inspects pairing state from a terminal —
 * the desktop panel calls the same code paths from the dashboard UI. The
 * phone connects through the pinned-TLS direct-app door; there is no
 * tunnel to manage.
 *
 * Subcommands:
 *   status                   — PIN configured?, last rotation, sessions, door state
 *   setup                    — render the derived setup view (same as the panel)
 *   set-pin                  — interactive (or --pin <digits>) PIN provisioning
 *   sessions                 — list active mobile sessions
 *   revoke-all               — invalidate every active mobile session
 */

import { password } from '@inquirer/prompts';
import { hasPin, readPinMeta, setPin, validatePinForSet, PIN_MIN_LENGTH, PIN_MAX_LENGTH } from '../runtime/mobile-pin.js';
import { listSessions, revokeAllSessions } from '../runtime/mobile-sessions.js';

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
    console.log(`PIN configured: ${hasPin() ? 'yes' : 'no'}`);
    if (meta) console.log(`Last rotated:   ${meta.updatedAt}`);
    console.log(`Active sessions: ${sessions.length}`);
    for (const row of sessions) {
      const label = row.deviceLabel ? ` (${row.deviceLabel})` : '';
      console.log(`  - ${row.deviceId}${label}  last seen ${row.lastSeenAt}`);
    }
    return 0;
  }

  /**
   * One-tap setup from the terminal. Renders the same derived view the desktop
   * panel does, so the two surfaces cannot disagree about what state you are in.
   */
  if (sub === 'setup') {
    const { ensureMobileAccess } = await import('../integrations/mobile-setup.js');
    console.log('Setting up mobile access…');
    const result = await ensureMobileAccess();
    const view = result.view;
    console.log('');
    console.log(view.headline);
    if (view.detail) console.log(view.detail);
    if (view.failure) {
      console.log('');
      console.log(`  ${view.failure.message}`);
      const remedy = view.failure.remedy;
      if (remedy.url) console.log(`  → ${remedy.label}: ${remedy.url}`);
      else if (remedy.command) console.log(`  → ${remedy.label}: ${remedy.command}`);
      else console.log(`  → ${remedy.label}: clementine mobile setup`);
      return 1;
    }
    if (view.url) {
      console.log('');
      console.log(`  ${view.url}`);
      console.log('');
      console.log('  Open the desktop Mobile panel and scan the pairing QR from the Clem app.');
    }
    return result.ok ? 0 : 1;
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

  console.log('Usage: clementine mobile <status|setup|set-pin|sessions|revoke-all>');
  return 1;
}
