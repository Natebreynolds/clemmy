/**
 * The ONE validator for a stored procedure.
 *
 * Procedural memory failed on 2026-08-03 because its write path used a NEGATIVE
 * heuristic: `evidenceLooksFailedOrBlocked` rejected memos whose prose looked
 * like a failure, and everything else was promoted to "proven". Absence of
 * failure language was treated as proof of success, so a choice whose
 * identifier was the literal token `PLACEHOLDER` — a value the placeholder
 * guard's exact-match list did not contain — was stored as a validated
 * procedure and later sent to the provider verbatim.
 *
 * Two structural rules follow, and this module exists to hold both:
 *
 *   1. A procedure is checked for the SAME properties on the way in and on the
 *      way out, by this function. A store that would refuse to write a record
 *      must never hand that record back — otherwise every guard added to the
 *      write path is silently optional for everything already on disk.
 *   2. Dispatchability is decided by the code that actually dispatches. For
 *      provider carriers that is the transport adapter, so this module defers
 *      to it rather than restating its rules and drifting from them.
 *
 * Severity is deliberately two-tier. A procedure whose IDENTITY cannot dispatch
 * is worthless and is refused. A procedure whose stored TEMPLATE is stale still
 * names a real tool the executor can re-derive a call for, so the template is
 * repaired away and the procedure is kept. Dropping a good identifier because
 * its cached arguments rotted would lose working memory to a cosmetic defect.
 */
import {
  composioSlugIsDispatchable,
  parseLegacyInvocationTemplate,
} from '../tools/composio-carrier.js';

export type ProcedureKind = 'cli' | 'composio' | 'mcp';

export type ProcedureRefusalCode =
  /** The identifier is a filler token, not a tool. Refuses. */
  | 'identifier_placeholder'
  /** The identifier cannot name a real provider action. Refuses. */
  | 'identifier_undispatchable'
  /** The stored template is filler. Repairs (template dropped). */
  | 'template_placeholder'
  /** The stored template cannot be parsed into a call. Repairs. */
  | 'template_unparseable'
  /** The live tool contract no longer matches the validated one. Refuses. */
  | 'schema_drifted';

export type ProcedureSeverity = 'refuse' | 'repair';

export interface ProcedureRefusal {
  code: ProcedureRefusalCode;
  severity: ProcedureSeverity;
  detail: string;
}

export interface ProcedureValidity {
  /** False when any `refuse` finding is present. */
  ok: boolean;
  findings: ProcedureRefusal[];
  /**
   * The template that should be persisted/served. Equal to the input template
   * when clean, `undefined` when a `repair` finding dropped it.
   */
  invocationTemplate?: string;
}

export interface StoredProcedureShape {
  kind: ProcedureKind;
  identifier: string;
  invocationTemplate?: string;
  /** Fingerprint of the tool contract this procedure was validated against. */
  schemaFingerprint?: string;
  /**
   * Fingerprint of the tool contract as it exists NOW. Supplied by a caller
   * that has the live schema in hand; omitted when unknown. Drift is only
   * decidable when both sides are present — an absent fingerprint means
   * "never recorded", which is legacy, not drift.
   */
  liveSchemaFingerprint?: string;
}

/**
 * Filler tokens that are never a tool. The first seven preserve the historical
 * exact-match list so existing behavior is unchanged; the rest close the class
 * that the live incident walked through.
 *
 * Deliberately conservative, and the conservatism is load-bearing. `test` is a
 * real POSIX command and is NOT listed. Neither are the metasyntactic names
 * `foo`/`bar`/`baz`: no incident evidence says a model emits them as tool
 * identifiers, and listing them refused a legitimate write on first contact.
 * A false positive here silently drops a working memo — the same damage this
 * guard exists to prevent, pointed the other way. Every entry below is either
 * a token the historical guard already refused or one a model has actually
 * been observed emitting in place of a tool name.
 */
const PLACEHOLDER_TOKENS = new Set([
  '', 'null', 'undefined', 'none', 'n/a', 'na', 'unknown',
  'placeholder', 'todo', 'tbd', 'fixme', 'xxx', 'changeme', 'change_me',
  'example', 'sample', 'pending', 'unset', 'nil', 'void',
  'string', 'value', 'slug', 'tool_slug', 'toolslug', 'identifier', 'tool_name',
  'command', 'your_tool', 'your_slug', '-', '--', '?', '...', '…',
]);

/** `{{slug}}`, `<slug>`, `[slug]`, `${slug}` — a template hole, not a value. */
const WRAPPED_HOLE = /^(?:\{\{.*\}\}|<.*>|\[.*\]|\$\{.*\})$/s;

/**
 * True when a value is filler rather than a real identifier.
 *
 * Note the asymmetry with argument placeholders: `{{start_iso}}` INSIDE a
 * template's arguments is the reusable part of a procedure and must survive.
 * Only a value standing in for the identifier itself is filler.
 */
export function isPlaceholderToken(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (PLACEHOLDER_TOKENS.has(normalized)) return true;
  if (WRAPPED_HOLE.test(trimmed)) return true;
  if (/^your[_\-.]/.test(normalized)) return true;
  // `placeholder` / `todo` as a whole word anywhere: `TOOL_PLACEHOLDER`,
  // `placeholder-slug`. Substring matching would reject a real slug that merely
  // contains the letters, so the boundaries are load-bearing.
  if (/(?:^|[_\-.\s])(?:placeholder|todo|tbd|fixme)(?:$|[_\-.\s])/.test(normalized)) return true;
  return false;
}

function refusal(
  code: ProcedureRefusalCode,
  severity: ProcedureSeverity,
  detail: string,
): ProcedureRefusal {
  return { code, severity, detail };
}

/**
 * Validate a procedure for storage or retrieval. Pure: no I/O, no environment,
 * no clock — so the write path and the read path cannot reach different
 * verdicts about the same record.
 */
export function validateStoredProcedure(input: StoredProcedureShape): ProcedureValidity {
  const findings: ProcedureRefusal[] = [];
  const identifier = typeof input.identifier === 'string' ? input.identifier.trim() : '';

  if (isPlaceholderToken(identifier)) {
    findings.push(refusal(
      'identifier_placeholder',
      'refuse',
      `"${identifier}" is a filler token, not a tool identifier.`,
    ));
  } else if (input.kind === 'composio' && !composioSlugIsDispatchable(identifier)) {
    // The transport adapter owns what a dispatchable slug looks like. Restating
    // its rule here would let the two drift, and the memory layer would start
    // accepting calls the dispatcher refuses.
    findings.push(refusal(
      'identifier_undispatchable',
      'refuse',
      `"${identifier}" cannot name a provider action.`,
    ));
  }

  if (
    input.schemaFingerprint
    && input.liveSchemaFingerprint
    && input.schemaFingerprint !== input.liveSchemaFingerprint
  ) {
    findings.push(refusal(
      'schema_drifted',
      'refuse',
      `Validated against ${input.schemaFingerprint}, live contract is ${input.liveSchemaFingerprint}.`,
    ));
  }

  let template = typeof input.invocationTemplate === 'string' ? input.invocationTemplate : undefined;
  if (template !== undefined) {
    if (isPlaceholderToken(template)) {
      findings.push(refusal('template_placeholder', 'repair', 'Stored template is filler.'));
      template = undefined;
    } else if (input.kind === 'composio' && !parseLegacyInvocationTemplate(template, identifier)) {
      // Parsing preserves `{{var}}` argument holes, so a template only fails
      // here when it genuinely cannot become a call — not merely because it is
      // still parameterized.
      findings.push(refusal(
        'template_unparseable',
        'repair',
        'Stored template cannot be parsed into a provider call.',
      ));
      template = undefined;
    }
  }

  return {
    ok: !findings.some((finding) => finding.severity === 'refuse'),
    findings,
    invocationTemplate: template,
  };
}

/** One actionable line for telemetry and refusal text. */
export function describeProcedureValidity(validity: ProcedureValidity): string {
  if (!validity.findings.length) return 'valid';
  return validity.findings
    .map((finding) => `${finding.code} (${finding.severity}): ${finding.detail}`)
    .join('; ');
}

/** The single blocking reason, when there is one. Used for quarantine records. */
export function blockingRefusal(validity: ProcedureValidity): ProcedureRefusal | null {
  return validity.findings.find((finding) => finding.severity === 'refuse') ?? null;
}
