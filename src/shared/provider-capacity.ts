/**
 * One provider-capacity signal shared by every execution lane.
 *
 * Providers do not consistently use HTTP 429 for exhausted subscription
 * allowances. Anthropic, for example, can return HTTP 400 with only
 * "You're out of extra usage" in the body. Keep this classifier textual and
 * side-effect free so chat, workflows, workers, and status guidance cannot
 * drift into different interpretations of the same provider response.
 */
const PROVIDER_CAPACITY_EXHAUSTED_RE =
  /usage[_ ]?limit|plan[_ ]?limit|usage_limit_reached|quota (?:has been )?(?:exceeded|reached)|exceeded your current quota|weekly limit|out of extra usage|extra usage (?:is )?(?:exhausted|unavailable|disabled)|(?:weekly|model)[-_ ]?scoped[^.\n]{0,80}(?:limit|exhausted)/i;

function renderField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Pull only provider-owned error fields, avoiding serialization of an entire
 * request/config object (which may be large or contain credentials). */
export function providerCapacityErrorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    const record = value as Error & {
      bodyText?: unknown;
      responseBody?: unknown;
      error?: unknown;
      errors?: unknown;
    };
    return [
      value.message,
      renderField(record.bodyText),
      renderField(record.responseBody),
      renderField(record.error),
      renderField(record.errors),
    ].filter(Boolean).join(' ');
  }
  if (!value || typeof value !== 'object') return renderField(value);
  const record = value as Record<string, unknown>;
  return [
    renderField(record.message),
    renderField(record.bodyText),
    renderField(record.responseBody),
    renderField(record.error),
    renderField(record.errors),
  ].filter(Boolean).join(' ');
}

/** True for a durable plan/model allowance exhaustion, not a short burst 429.
 * Callers should switch to an independent route (when commit-safe), not retry
 * the same exhausted model. */
export function isProviderCapacityExhausted(value: unknown): boolean {
  return PROVIDER_CAPACITY_EXHAUSTED_RE.test(providerCapacityErrorText(value));
}

/** Preserve the provider's explicitly named allowance in diagnostics. A
 * generic 429 or quota message does not identify this billing scope. */
export function isProviderExtraUsageUnavailable(value: unknown): boolean {
  return /out of extra usage|extra usage (?:is )?(?:exhausted|unavailable|disabled)/i
    .test(providerCapacityErrorText(value));
}

/**
 * A prepaid balance or credit line is used up: the account refuses every call
 * until its owner adds credit. HTTP 402 says exactly that. Providers that use
 * another status say it only in their own error text, so the text is read only
 * for the statuses those refusals arrive on. Unlike a plan window, this does
 * not reset on its own.
 */
const PROVIDER_CREDIT_REFUSED_RE =
  /insufficient[_ ]?(?:quota|balance|credits?|funds)|credit_balance_exhausted|no credits? (?:remaining|left)|out of credits?|credit balance is too low|exceeded your current quota|exceeded_current_quota|check your plan and billing|used all (?:of your |its )?(?:available )?credits|balance (?:is )?(?:insufficient|too low|exhausted|not enough)|"code"\s*:\s*"?1113\b/i;

const CREDIT_REFUSAL_TEXT_STATUSES = new Set([400, 403, 429]);

export function isProviderCreditRefusal(status: number | undefined, value: unknown): boolean {
  if (status === 402) return true;
  if (status !== undefined && !CREDIT_REFUSAL_TEXT_STATUSES.has(status)) return false;
  return PROVIDER_CREDIT_REFUSED_RE.test(providerCapacityErrorText(value));
}
