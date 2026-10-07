/** Token endpoints can echo credentials in error bodies. Never expose their
 * untrusted text, including SyntaxError causes, through the setup wizard. */
export function parseCodexTokenResponse(text: string, status: number, ok: boolean, operation: 'exchange' | 'refresh'): Record<string, unknown> {
  const label = operation === 'exchange' ? 'token exchange' : 'refresh';
  if (!ok) throw new Error(`OAuth ${label} failed (HTTP ${status}). Retry sign-in from Settings.`);
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`OAuth ${label} returned invalid JSON. Retry sign-in from Settings.`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`OAuth ${label} returned an invalid response. Retry sign-in from Settings.`);
  return parsed as Record<string, unknown>;
}
