/**
 * Hard sender-identity gate for email sends under a standing email-account
 * constraint.
 *
 * Born from the 2026-06-11 wrong-mailbox incident: 17 outreach emails left
 * via `user_id: 'me'` — which silently resolved to the wrong connected
 * Outlook account. Pattern-matching args can never catch that, because the
 * offending arg ("me") looks innocent. The only honest check is to ask the
 * provider WHO "me" actually is (OUTLOOK_GET_PROFILE) and compare against
 * the constraint's required mailbox BEFORE the send dispatches.
 *
 * Fail-closed: if the profile lookup fails, the send is blocked — a delayed
 * email is recoverable, 17 emails from the wrong identity are not.
 */

import type { EmailSendConstraint } from './constraint-guard.js';

export interface SenderVerification {
  ok: boolean;
  /** Model-facing block message when !ok. */
  message?: string;
}

/** Shape-agnostic executor: (slug, args) → composio result. Injected so this
 *  module stays free of the composio client (no import cycle, unit-testable). */
export type ProfileFetcher = (slug: string, args: Record<string, unknown>) => Promise<unknown>;

const PROFILE_SLUG = 'OUTLOOK_GET_PROFILE';
const CACHE_TTL_MS = 10 * 60 * 1000; // one profile call per batch, not 17

const verifiedMailboxCache = new Map<string, { emails: string[]; at: number }>();

export function clearSenderVerificationCache(): void {
  verifiedMailboxCache.clear();
}

function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/^smtp:/, '');
}

/** Pull every mailbox identity out of a profile result, tolerating both the
 *  structured shape ({data: {mail, userPrincipalName, proxyAddresses}}) and
 *  wrapper drift — falls back to scanning the JSON for email literals. */
export function extractMailboxEmails(profileResult: unknown): string[] {
  const emails = new Set<string>();
  const root = (profileResult ?? {}) as Record<string, unknown>;
  const data = (root.data ?? root) as Record<string, unknown>;
  const profile = (data.response_data ?? data) as Record<string, unknown>;

  for (const field of [profile.mail, profile.userPrincipalName]) {
    const v = normalizeEmail(field);
    if (v.includes('@')) emails.add(v);
  }
  const proxies = profile.proxyAddresses;
  if (Array.isArray(proxies)) {
    for (const p of proxies) {
      const v = normalizeEmail(p);
      if (v.includes('@')) emails.add(v);
    }
  }
  if (emails.size === 0) {
    try {
      const text = JSON.stringify(profileResult ?? '');
      for (const m of text.matchAll(/[\w\-.+]+@[\w\-.]+\.[a-z]{2,}/gi)) {
        emails.add(normalizeEmail(m[0]));
      }
    } catch { /* unstringifiable result — treated as no identity found */ }
  }
  return [...emails];
}

function blockMessage(rule: EmailSendConstraint, detail: string): string {
  return [
    `🛑 SEND BLOCKED — standing sender constraint enforced. Nothing was sent.`,
    ``,
    `Constraint: "${rule.constraint.content}"`,
    `Required sending mailbox: ${rule.allowedAccount}`,
    detail,
    ``,
    `Do NOT retry this send as-is. Either (a) connect/select the account for ` +
      `${rule.allowedAccount}, re-verify, and retry, or (b) stop and report this ` +
      `blocker to the user. ONLY if the user explicitly directed sending from a ` +
      `different mailbox in this conversation, retry with ` +
      `"sender_override_confirmed": true added to the arguments (it is stripped ` +
      `before dispatch and logged).`,
  ].join('\n');
}

/**
 * Verify that the mailbox this send would actually leave from matches the
 * constraint's required account. Outlook sends resolve `user_id` through a
 * real OUTLOOK_GET_PROFILE call (cached ~10 min per connected account);
 * non-Outlook toolkits cannot be verified against an Outlook-mailbox
 * constraint and are blocked unless overridden.
 */
export async function verifyOutlookSender(opts: {
  rule: EmailSendConstraint;
  toolSlug: string;
  userId: string;
  connectedAccountId?: string;
  fetchProfile: ProfileFetcher;
}): Promise<SenderVerification> {
  const { rule, toolSlug, userId, connectedAccountId, fetchProfile } = opts;

  if (!toolSlug.toUpperCase().startsWith('OUTLOOK')) {
    return {
      ok: false,
      message: blockMessage(
        rule,
        `This ${toolSlug} call sends through a non-Outlook toolkit, so its sending ` +
          `identity cannot be verified against the required mailbox.`,
      ),
    };
  }

  const cacheKey = `${connectedAccountId ?? 'default'}:${userId}`;
  const cached = verifiedMailboxCache.get(cacheKey);
  let emails: string[];
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    emails = cached.emails;
  } else {
    let result: unknown;
    try {
      result = await fetchProfile(PROFILE_SLUG, { user_id: userId, include_proxy_addresses: true });
    } catch (err) {
      return {
        ok: false,
        message: blockMessage(
          rule,
          `The sending mailbox could NOT be verified (profile lookup failed: ` +
            `${err instanceof Error ? err.message : String(err)}). Fail-closed.`,
        ),
      };
    }
    const successful = (result as { successful?: boolean } | null)?.successful;
    if (successful === false) {
      return {
        ok: false,
        message: blockMessage(
          rule,
          `The sending mailbox could NOT be verified (${PROFILE_SLUG} returned an error). Fail-closed.`,
        ),
      };
    }
    emails = extractMailboxEmails(result);
    if (emails.length === 0) {
      return {
        ok: false,
        message: blockMessage(
          rule,
          `The sending mailbox could NOT be verified (profile returned no mailbox identity). Fail-closed.`,
        ),
      };
    }
    verifiedMailboxCache.set(cacheKey, { emails, at: Date.now() });
  }

  if (emails.includes(rule.allowedAccount)) return { ok: true };

  return {
    ok: false,
    message: blockMessage(
      rule,
      `Actual connected Outlook mailbox (verified via ${PROFILE_SLUG}): ${emails[0]}` +
        (emails.length > 1 ? ` (aliases: ${emails.slice(1).join(', ')})` : ''),
    ),
  };
}
