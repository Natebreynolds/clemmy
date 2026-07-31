/**
 * Incident-narrative quarantine (2026-07-31 live poison): reflection turned a
 * bad afternoon into durable character — "Nate's tool environment is
 * persistently unreliable, with expired Composio connections…" — and that
 * remembered PREJUDICE primed the very misdiagnosis it described ("Salesforce
 * expired, reconnect Composio") months later. A complaint about a MOMENT must
 * never become a durable belief about the user or their systems.
 *
 * The lesson is not lost: the reflection episode store already retains the
 * bounded raw source (14-day retention) — transient trouble stays episodic and
 * decays, exactly as it should. If the trouble encodes a durable RULE ("access
 * X via Y"), the rule is what belongs in memory, and the constraint-capture
 * steer owns that path.
 *
 * Pure and conservative: both a trouble word AND an infrastructure noun are
 * required, so "the client is unreliable about replying" or "the token budget"
 * alone never quarantine.
 */

const TROUBLE_RE =
  /\b(?:unreliable|flaky|unstable|persistently|repeatedly|keeps?\s+(?:fail|expir|break|disconnect)|expired?|broken|failing|outage|down(?:time)?|not\s+working|requir(?:es|ing)\s+(?:re-?auth|reconnect))/i;

const INFRA_RE =
  /\b(?:connections?|integrations?|composio|oauth|tokens?|credentials?|auth|cli|daemons?|mcp|api|sessions?|environment|infrastructure|tool(?:ing|s)?)\b/i;

export function looksLikeIncidentNarrative(text: string): boolean {
  const t = (text ?? '').trim();
  if (t.length < 12) return false;
  return TROUBLE_RE.test(t) && INFRA_RE.test(t);
}
