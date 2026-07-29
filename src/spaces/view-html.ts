/**
 * Insert trusted Workspace bootstrap markup before any normal authored script
 * can execute. Live and published views deliberately share this exact document
 * ordering primitive so their `window.clem` availability cannot drift.
 */
export function injectWorkspaceBootstrap(html: string, snippet: string): string {
  // Capture security-sensitive browser primordials before *any* authored
  // executable content. Searching for a later <head> is unsafe because valid
  // HTML may contain a script before that tag. Preserve only a genuinely
  // leading inert prefix and modern doctype so standards mode is unchanged.
  //
  // In particular, browsers also accept `--!>` and abrupt `<!-->` / `<!--->`
  // comment closes. Detect those alternate closes before accepting a later
  // literal `-->`; otherwise authored script could execute before the bridge
  // while this function still believed it was in a comment.
  let at = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  let consumedDoctype = false;
  while (at < html.length) {
    const whitespace = /^[\t\n\f\r ]+/.exec(html.slice(at));
    if (whitespace) {
      at += whitespace[0].length;
      continue;
    }
    if (html.startsWith('<!--', at)) {
      const end = html.indexOf('-->', at + 4);
      const bangEnd = html.indexOf('--!>', at + 4);
      const abruptEnd = html[at + 4] === '>'
        ? at + 4
        : html.startsWith('->', at + 4)
          ? at + 5
          : -1;
      const alternateEnd = [bangEnd >= 0 ? bangEnd + 3 : -1, abruptEnd]
        .filter((value) => value >= 0)
        .reduce((first, value) => Math.min(first, value), Number.POSITIVE_INFINITY);
      if (end < 0 || alternateEnd < end + 2) break;
      at = end + 3;
      continue;
    }
    if (!consumedDoctype) {
      // Preserve only the modern doctype whose lexical end is unambiguous.
      // Legacy PUBLIC/SYSTEM identifiers can legally contain `>` in quotes,
      // which a regex cannot safely tokenize.
      const doctype = /^<!doctype[ \t\n\f\r]+html[ \t\n\f\r]*>/i.exec(html.slice(at));
      if (doctype) {
        at += doctype[0].length;
        consumedDoctype = true;
        continue;
      }
    }
    break;
  }
  return html.slice(0, at) + snippet + html.slice(at);
}
