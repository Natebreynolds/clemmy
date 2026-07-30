import type { UserProfile } from './memory';

/**
 * The casual name to greet with — empty when Clem doesn't know one yet.
 * preferredName is already the user's chosen casual name; displayName/name may
 * be a full name, so only the first word is used. Never hardcoded anywhere.
 */
/** Placeholder identities that mean "no name known" — greeting with their
 *  first word produced the live "Good afternoon, the" (from "the user"). */
const GENERIC_NAME_RE = /^(the\s+user|user|owner|there|unknown|n\/?a)$/i;

export function greetingName(profile: UserProfile | null | undefined): string {
  const pick = profile?.preferredName?.trim()
    || profile?.displayName?.trim()
    || (typeof profile?.name === 'string' ? profile.name.trim() : '');
  if (!pick || GENERIC_NAME_RE.test(pick)) return '';
  return profile?.preferredName?.trim() ? pick : pick.split(/\s+/)[0];
}

export function timeGreeting(hour: number, name = ''): string {
  const base = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return name ? `${base}, ${name}` : base;
}
