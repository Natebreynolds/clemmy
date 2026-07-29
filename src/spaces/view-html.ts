/**
 * Insert trusted Workspace bootstrap markup before any normal authored script
 * can execute. Live and published views deliberately share this exact document
 * ordering primitive so their `window.clem` availability cannot drift.
 */
export function injectWorkspaceBootstrap(html: string, snippet: string): string {
  const match = /<head[^>]*>/i.exec(html) ?? /<html[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  if (!match) return snippet + html;
  const at = match.index + match[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}
