/**
 * The greeting on Home. Mirrors the desktop console's rule so the two
 * surfaces speak the same way: the name is resolved at runtime from the
 * user profile and degrades to a plain greeting when Clem doesn't know one.
 */

/** Placeholder identities that mean "no name known" — greeting with their
 *  first word once produced a live "Good afternoon, the" (from "the user"). */
const GENERIC_NAME_RE = /^(the\s+user|user|owner|there|unknown|n\/?a)$/i;

export function greetingName(raw: string | null | undefined): string {
  const pick = (raw ?? '').trim();
  if (!pick || GENERIC_NAME_RE.test(pick)) return '';
  // A profile name may be a full name; only the first word is casual enough.
  return pick.split(/\s+/)[0];
}

export function timeGreeting(hour: number, name = ''): string {
  const base = hour < 5 ? 'Still up'
    : hour < 12 ? 'Good morning'
    : hour < 18 ? 'Good afternoon'
    : 'Good evening';
  return name ? `${base}, ${name}` : base;
}
