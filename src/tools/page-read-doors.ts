/**
 * A page that could not be read one way comes back saying so, with the other
 * doors this machine has — never as raw bytes the model has to diagnose, and
 * never as a dead end.
 *
 * Live 10-20 (Windows tester, "Summit Invite Outreach"): a firm's website
 * answered a plain fetch with HTTP 403 and a Cloudflare challenge, and the
 * batch stopped; later the event page answered 200 with a 59 KB script shell
 * and no visible text, the brain queried the JavaScript for an agenda, then
 * asked the owner to paste the session names. The browser on that machine
 * refused its debugging connection and the result said only
 * "[WinError 1225] The remote computer refused the network connection".
 * Each time a door existed (the browser, a connected page reader, a skip in
 * a batch) and nothing named it.
 *
 * The decisions here read HTTP status codes, content types and the page's
 * own markup — never the owner's words.
 */

export type UnreadablePageReason = 'blocked_by_site' | 'script_rendered' | 'not_text';

export interface UnreadablePage {
  reason: UnreadablePageReason;
  /** Characters of visible text the page carried once scripts, styles and tags were removed. */
  visibleTextChars: number;
  /** The first lines of that visible text, so a thin page is still quoted honestly. */
  textPreview: string;
  /** What to do instead, in the model's working words: the other doors on this machine. */
  next: string;
}

const BLOCKED_STATUSES = new Set([401, 403, 407, 429, 503]);
const SCRIPT_SHELL_MIN_BYTES = 8_000;
const SCRIPT_SHELL_MAX_VISIBLE_CHARS = 400;
const TEXT_PREVIEW_CHARS = 1_200;

/** Visible text of an HTML document: scripts, styles, templates and tags removed, entities for the common few decoded. */
export function visibleTextOfHtml(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, '\'')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PageReadDoorsOptions {
  /** The browser a page can be opened in: the computer's (on, or once the
   *  owner turns it on), the older choice where it stands, or none. */
  browser: 'computer' | 'computer_off' | 'older' | 'none';
  /** The read happened inside a workflow step over several items, where one item's failure is that item's result. */
  inBatch?: boolean;
}

/** The other doors, in order: the browser when it is offered, then a connected page reader, then the owner. */
export function pageReadDoors(reason: UnreadablePageReason, options: PageReadDoorsOptions): string {
  const why = reason === 'blocked_by_site'
    ? 'The site refused a plain fetch (a sign-in, rate limit or bot check stands in front of it).'
    : reason === 'script_rendered'
      ? 'The page builds its text with scripts, so a plain fetch returns only the shell; the content is not in these bytes.'
      : 'The response is not text.';
  const doors = [
    options.browser === 'computer'
      ? 'open the page in your computer\'s browser and read it there (the computer driver\'s browser_prepare, browser_navigate to this URL, then read the page)'
      : options.browser === 'older'
        ? 'open the page in the browser and read it there (browser_open, browser_navigate to this URL, then browser_read)'
        : null,
    'a connected page-reading app, if one is connected: tool_search "read a web page as text" and call the reader it returns',
  ].filter((door): door is string => door !== null);
  const batch = options.inBatch
    ? ' In a batch, when every door fails for one item, record that item as skipped with this reason and continue with the others; one unreadable page never ends the batch.'
    : '';
  const turnOn = options.browser === 'computer_off'
    ? ' If those fail too, the page needs a browser: ask the owner in your own words whether to turn on your computer (one tap at Connect → Your computer), and open it there once they have.'
    : '';
  return `${why} Do not treat this page as empty or the task as finished. Try the next door: ${doors.join('; or ')}. `
    + 'If none works, tell the owner which doors failed and ask them for the page text.' + turnOn + batch;
}

/**
 * Whether a bounded fetch result is a page that could not be read this way,
 * and what to do instead. Null when the response reads fine.
 */
export function assessUnreadablePage(
  result: { ok: boolean; status: number; contentType: string | null; bytes: number; body?: string; image?: unknown },
  options: PageReadDoorsOptions,
): UnreadablePage | null {
  if (result.image) return null;
  const contentType = (result.contentType ?? '').toLowerCase();
  const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml');
  const text = isHtml ? visibleTextOfHtml(result.body ?? '') : (result.body ?? '').replace(/\s+/g, ' ').trim();
  const preview = text.slice(0, TEXT_PREVIEW_CHARS);
  if (BLOCKED_STATUSES.has(result.status)) {
    return { reason: 'blocked_by_site', visibleTextChars: text.length, textPreview: preview, next: pageReadDoors('blocked_by_site', options) };
  }
  if (isHtml && result.ok && result.bytes >= SCRIPT_SHELL_MIN_BYTES && text.length <= SCRIPT_SHELL_MAX_VISIBLE_CHARS) {
    return { reason: 'script_rendered', visibleTextChars: text.length, textPreview: preview, next: pageReadDoors('script_rendered', options) };
  }
  return null;
}

/**
 * The browser on this machine would not answer. Says what that means in plain
 * words and names the other doors, so a refused debugging connection is a
 * detour, not the end of the request.
 */
export function browserUnavailableDoors(error: string, options: { localChrome: boolean }): string {
  const lowered = error.toLowerCase();
  const refused = lowered.includes('refused') || lowered.includes('econnrefused') || lowered.includes('winerror 1225')
    || lowered.includes('devtoolsactiveport') || lowered.includes('no such file');
  const why = options.localChrome && refused
    ? 'Chrome on this computer is not accepting a debugging connection: it must be running with remote debugging enabled, and its DevToolsActivePort file must be current. The app never starts or repairs Chrome itself.'
    : 'The browser on this machine did not answer.';
  return `${why} Other doors for a page: a plain fetch (http_read) when the page is static; a connected page-reading app, if one is connected: tool_search "read a web page as text". `
    + 'If none works, tell the owner the browser is not reachable and what they can do (start Chrome with remote debugging, or connect a page reader), and ask for the page text only as the last resort.';
}
