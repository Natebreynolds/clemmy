/**
 * Structural parse of an RFC 5322 address-list: the value of a recipient field
 * that names one or more people.
 *
 * One string can hold several mailboxes ("A, B"), and a comma alone cannot
 * split them: a quoted display name may contain one ("Doe, Pat" <p@x.test>),
 * as may a comment. This walks the grammar's delimiters instead: quoted
 * strings with escapes, nested comments, angle addresses, domain literals and
 * group syntax (`Team: a@x.test, b@x.test;`). A top-level semicolon also
 * separates mailboxes, the way recipient fields are commonly written.
 *
 * The answer is the list of addr-specs, lower-cased and de-duplicated in
 * order, or null when any element is not a mailbox. Null means "not an
 * address list", so a caller keeps the value whole rather than guessing at a
 * split.
 */

// RFC 5322 atext, widened by RFC 6532 to any non-ASCII character.
const ATEXT = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~\u0080-￿]+$/;
// A display-name word: anything but whitespace, controls and the specials.
const PHRASE_ATOM = /^[^\s()<>[\]:;@\\,."\u0000-\u001f\u007f]+$/;

type Scan = { parts: string[]; ok: boolean };

/** Split at top-level separators. Group display names are dropped here; the
 *  members they introduce are ordinary elements. */
function splitTopLevel(value: string): Scan {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let comment = 0;
  let angle = false;
  let literal = false;
  let group = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quoted) {
      current += char;
      if (char === '\\' && index + 1 < value.length) {
        current += value[index + 1]!;
        index += 1;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (comment > 0) {
      current += char;
      if (char === '\\' && index + 1 < value.length) {
        current += value[index + 1]!;
        index += 1;
      } else if (char === '(') {
        comment += 1;
      } else if (char === ')') {
        comment -= 1;
      }
      continue;
    }
    if (literal) {
      current += char;
      if (char === ']') literal = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === '(') {
      comment = 1;
    } else if (char === '<') {
      if (angle) return { parts, ok: false };
      angle = true;
    } else if (char === '>') {
      if (!angle) return { parts, ok: false };
      angle = false;
    } else if (char === '[') {
      literal = true;
    } else if (!angle && char === ':') {
      // A group's display name introduces its members; it names no mailbox.
      if (group) return { parts, ok: false };
      group = true;
      current = '';
      continue;
    } else if (!angle && (char === ',' || char === ';')) {
      if (char === ';') group = false;
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quoted || comment > 0 || angle || literal) return { parts, ok: false };
  parts.push(current);
  return { parts, ok: true };
}

/** Remove top-level comments; quoted strings keep their bytes. */
function withoutComments(value: string): string {
  let out = '';
  let quoted = false;
  let comment = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (comment > 0) {
      if (char === '\\') index += 1;
      else if (char === '(') comment += 1;
      else if (char === ')') comment -= 1;
      continue;
    }
    if (quoted) {
      out += char;
      if (char === '\\' && index + 1 < value.length) {
        out += value[index + 1]!;
        index += 1;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') quoted = true;
    if (char === '(') {
      comment = 1;
      out += ' ';
      continue;
    }
    out += char;
  }
  return out;
}

function dotAtom(value: string): boolean {
  return value.split('.').every((atom) => ATEXT.test(atom));
}

function quotedString(value: string): boolean {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index]!;
    if (char === '\\') {
      index += 1;
      if (index >= value.length - 1) return false;
    } else if (char === '"') {
      return false;
    }
  }
  return true;
}

/** An addr-spec: local-part "@" domain, nothing around it. */
function addrSpec(value: string): string | null {
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!dotAtom(local) && !quotedString(local)) return null;
  const domainOk = dotAtom(domain)
    || (domain.startsWith('[') && domain.endsWith(']') && !/[[\]\\]/.test(domain.slice(1, -1)));
  return domainOk ? value.toLowerCase() : null;
}

/** A display name is a phrase: words, each an atom or a quoted string. */
function displayName(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      index += 1;
    } else if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) return false;
      index = end + 1;
    } else {
      let end = index;
      while (end < text.length && !/\s/.test(text[end]!) && text[end] !== '"') end += 1;
      // Obsolete phrases also allow a period inside a name ("J. Doe").
      if (!text.slice(index, end).split('.').every((atom) => atom === '' || PHRASE_ATOM.test(atom))) return false;
      index = end;
    }
  }
  return true;
}

/** One mailbox: a bare addr-spec or [display-name] "<" addr-spec ">". */
function mailbox(element: string): string | null {
  const text = withoutComments(element).trim();
  if (!text) return null;
  const open = text.indexOf('<');
  if (open < 0) return addrSpec(text);
  const close = text.indexOf('>', open);
  if (close < 0 || text.slice(close + 1).trim()) return null;
  if (!displayName(text.slice(0, open))) return null;
  return addrSpec(text.slice(open + 1, close).trim());
}

export function parseAddressList(value: string): string[] | null {
  const scan = splitTopLevel(value);
  if (!scan.ok) return null;
  const addresses: string[] = [];
  for (const part of scan.parts) {
    if (!withoutComments(part).trim()) continue;
    const address = mailbox(part);
    if (!address) return null;
    if (!addresses.includes(address)) addresses.push(address);
  }
  return addresses.length > 0 ? addresses : null;
}
