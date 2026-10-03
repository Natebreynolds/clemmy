import { z } from 'zod';

const session = z.string().regex(/^[A-Za-z0-9_-]{1,48}$/).nullable().optional()
  .describe('Optional task label echoed in the receipt. Browser identity is the returned browser_id, not this label.');
const target = z.string().min(1).max(128).describe('Exact target_id returned by browser_tabs or browser_open. Never a tab position or page title.');
const browser = z.string().regex(/^[a-f0-9]{64}$/).describe('Exact browser_id returned by browser_tabs or browser_open. Refuses a restarted/replaced browser; never silently reattaches.');
export const BROWSER_HTTP_URL = z.string().max(8000).refine((value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}, 'Use an http(s) URL without embedded username or password.');

export const BROWSER_OPERATION_PARAMETERS = {
  browser_tabs: { session_name: session },
  browser_open: { session_name: session },
  browser_read: {
    target_id: target, browser_id: browser, session_name: session,
    max_chars: z.number().int().min(100).max(16000).nullable().optional().describe('Bounded visible page text, default 8000 characters.'),
  },
  browser_navigate: { target_id: target, browser_id: browser, session_name: session, url: BROWSER_HTTP_URL },
} as const;
export type BrowserOperationName = keyof typeof BROWSER_OPERATION_PARAMETERS;
export function browserOperationName(value: string): value is BrowserOperationName {
  return Object.hasOwn(BROWSER_OPERATION_PARAMETERS, value);
}
export function parseBrowserOperationArguments(name: BrowserOperationName, args: unknown): Record<string, unknown> {
  const parsed: Record<string, unknown> = z.strictObject(BROWSER_OPERATION_PARAMETERS[name]).parse(args);
  if (name === 'browser_navigate') parsed.url = BROWSER_HTTP_URL.parse(new URL(String(parsed.url)).href);
  return parsed;
}
