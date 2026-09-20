/** Match a whole stored email/domain, not a substring of another identity.
 * A domain may be the host of an email or URL; subdomains are distinct here.
 * A sentence-ending period is punctuation, but .suffix extends a domain.
 */
export function exactGroundedIdentifierMatch(text: string, value: string): boolean {
  const wanted = value.trim();
  if (!wanted) return false;
  const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const left = wanted.includes('@') ? "a-z0-9.!#$%&'*+/=?^_`{|}~@-" : 'a-z0-9_.-';
  return new RegExp(`(^|[^${left}])${escaped}(?![a-z0-9_@-]|\\.[a-z0-9_-])`, 'i').test(text);
}
