/**
 * The shell's Needs-you chrome, and how old it is allowed to look.
 *
 * "Needs you · 3" appears in three places at once — the header pill, the
 * switcher badge and the drawer badge — and all three are fed by ONE count
 * from /m/api/inbox/summary. That route is in LAST_GOOD_PATHS, so with the Mac
 * asleep the service worker answers it from the shelf: the shell would say
 * "Needs you · 3" in confident chrome while the Inbox underneath correctly
 * said "Can't reach your Mac" and showed nothing.
 *
 * Activity and Run disclose their age with a banner. Chrome has no room for a
 * banner, so it discloses the same fact in the space it has: the pill says how
 * old the number is, and the two numeric badges carry a stale marker plus a
 * label that spells it out. The rule is the binding one — disclose age, never
 * hide it, and never render the confident version of an unknown.
 */
import { ageLabel } from './last-good';

/** Under this, "how old" is noise: the number really is what it just was. */
const DISCLOSE_AFTER_MS = 90_000;

export interface NeedsYouChrome {
  /** False when there is nothing honest to show (unknown, or a real zero). */
  show: boolean;
  /** The header pill's face — carries the age in words when there is one. */
  pillText: string;
  /** The switcher/title badge face (capped at 99+). */
  badgeText: string;
  /** The drawer badge face (capped at 9+). */
  drawerBadgeText: string;
  /** True when this count was not confirmed by a live read just now. */
  stale: boolean;
  /** How old, when that is worth saying out loud; null while essentially now. */
  age: string | null;
  /** The pill's accessible name. */
  pillAriaLabel: string;
  /** What a bare numeral cannot say on its own — used as the badges' label. */
  badgeAriaLabel: string;
}

export function needsYouChrome(input: {
  count: number;
  /** False = never observed. A guessed zero must never reach the chrome. */
  known: boolean;
  /**
   * When this count was last CONFIRMED: the stamp of the remembered copy that
   * answered, or the moment a live read did. Null = unknown provenance.
   */
  asOf: string | null;
  /** Whether the most recent read actually reached the Mac. */
  live: boolean;
  nowMs: number;
}): NeedsYouChrome {
  const count = Number.isFinite(input.count) ? Math.max(0, Math.trunc(input.count)) : 0;
  const stale = !input.live;
  const takenAt = input.asOf ? Date.parse(input.asOf) : NaN;
  const age = stale && Number.isFinite(takenAt) && input.nowMs - takenAt >= DISCLOSE_AFTER_MS
    ? ageLabel(input.asOf as string, input.nowMs)
    : null;
  const noun = count === 1 ? 'item needs' : 'items need';
  const provenance = !stale ? ''
    : age ? `, as of ${age}` : ', not confirmed just now';
  return {
    show: input.known && count > 0,
    pillText: age ? `Needs you · ${cap(count, 99)} · ${age}` : `Needs you · ${cap(count, 99)}`,
    badgeText: cap(count, 99),
    drawerBadgeText: cap(count, 9),
    stale,
    age,
    pillAriaLabel: `${count} ${noun} you${provenance}.${stale ? " Can't reach your Mac." : ''} Open Needs you`,
    badgeAriaLabel: `${count} ${noun} you${provenance}`,
  };
}

function cap(count: number, ceiling: number): string {
  return count > ceiling ? `${ceiling}+` : String(count);
}
