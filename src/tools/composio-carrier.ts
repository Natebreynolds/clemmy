/**
 * The one deterministic transport adapter for the Composio carrier.
 *
 * WHY THIS EXISTS
 *
 * The carrier's contract is `{ tool_slug: string, arguments: string | null }`
 * where `arguments` is a JSON *string*. That is a transport detail, and the
 * 2026-08-02 calendar incident is what happens when a transport detail is
 * something the model has to keep rediscovering: four consecutive pre-dispatch
 * failures — `arguments` as an object, `slug` instead of `tool_slug`, an
 * `arguments_json` nesting, then an object again — before the right shape
 * landed. None of those were semantic mistakes. Every one of them meant the
 * same call.
 *
 * So representation drift is repaired HERE, once, deterministically, instead of
 * costing a model round trip each time. The internal canonical form is an
 * OBJECT; JSON stringification happens only at the edge that actually needs a
 * string. What the model cannot express, it cannot get wrong.
 *
 * WHAT IS NOT REPAIRED
 *
 * A misspelled key is not silently accepted. `slug` does not become `tool_slug`:
 * that would teach a contract that does not exist and make the next failure
 * harder to diagnose. It is refused — but the refusal carries the authoritative
 * contract, the violated paths, the schema hash, and a canonical retry shape, so
 * one refusal is enough to correct it. Semantic gaps (missing required inner
 * fields, unparseable JSON) always fail closed.
 *
 * This module is pure: no I/O, no network, no store reads. It is imported by
 * the first-class carrier, `call_tool`, pending-action admission, and effect
 * fingerprinting so all four agree on what an invocation IS.
 */
import { createHash } from 'node:crypto';

/**
 * The internal form. An object, always — every consumer reasons about this and
 * only the transport edge sees a string.
 */
export interface CanonicalComposioInvocation {
  toolSlug: string;
  /** Inner action arguments. Placeholders such as `{{start_iso}}` survive. */
  args: Record<string, unknown>;
}

/** A representation difference this adapter repaired mechanically. */
export type CarrierAdaptation =
  | 'arguments_object_serialized'
  | 'arguments_json_alias'
  | 'arguments_double_encoded'
  | 'connection_id_stripped'
  | 'legacy_template_parsed';

export interface CarrierNormalizationOk {
  ok: true;
  canonical: CanonicalComposioInvocation;
  /** Empty when the caller already spoke the authoritative shape. */
  adapted: CarrierAdaptation[];
}

export interface CarrierNormalizationError {
  ok: false;
  /** One sentence a model can act on. */
  error: string;
  /** Exact argument paths that violated the contract. */
  violations: string[];
  schemaHash: string;
  /** The authoritative contract, restated rather than implied. */
  contract: string;
  /**
   * A ready-to-send corrected call when the input carried enough meaning to
   * build one. Null when the input was semantically incomplete — a repair
   * suggestion that invents missing arguments would be a guess wearing the
   * costume of a fix.
   */
  repair: SerializedComposioCarrier | null;
}

export type CarrierNormalization = CarrierNormalizationOk | CarrierNormalizationError;

/** Exactly what goes on the wire. */
export interface SerializedComposioCarrier {
  tool_slug: string;
  arguments: string | null;
}

/** The authoritative field names. Anything else is drift or a mistake. */
const CARRIER_SLUG_FIELD = 'tool_slug';
const CARRIER_ARGS_FIELD = 'arguments';

/** Keys callers have been observed to reach for instead of `tool_slug`. */
const SLUG_DRIFT_KEYS = ['slug', 'toolSlug', 'tool', 'action', 'tool_name', 'name'];
/** Keys callers have been observed to reach for instead of `arguments`. */
const ARGS_DRIFT_KEYS = ['arguments_json', 'argumentsJson', 'args_json', 'args', 'input', 'parameters', 'params'];

/**
 * Volatile identity that must never travel as part of a procedure.
 *
 * Connection ids rotate on re-auth. A stored one silently breaks an entire
 * toolkit, so the canonical form carries the stable account identity instead
 * and the live connection is resolved at dispatch.
 */
const VOLATILE_ARG_KEYS = new Set([
  'connected_account_id',
  'connectedAccountId',
  'connection_id',
  'connectionId',
]);

/**
 * The carrier contract, in the words a caller needs to fix a call.
 *
 * Exported so a refusal can state it rather than gesture at it — a field-less
 * "invalid input" is what turns one mistake into four.
 */
export const COMPOSIO_CARRIER_CONTRACT =
  'composio_execute_tool takes exactly two fields: '
  + '`tool_slug` (string, the exact action slug) and '
  + '`arguments` (a JSON *string* of the inner action arguments, or null when the action takes none). '
  + '`arguments` is a string, not an object.';

/** Stable hash of the carrier contract, so a caller can tell versions apart. */
export const COMPOSIO_CARRIER_SCHEMA_HASH = createHash('sha256')
  .update(`${CARRIER_SLUG_FIELD}:string|${CARRIER_ARGS_FIELD}:json-string-or-null`, 'utf8')
  .digest('hex')
  .slice(0, 16);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Remove volatile connection identity from an argument object.
 *
 * Returns whether anything was removed, because that fact belongs in the
 * adaptation record: a procedure that still carried a baked connection id is
 * one this adapter just made safe, and the store should learn the clean form.
 */
export function stripVolatileConnectionArgs(
  args: Record<string, unknown>,
): { args: Record<string, unknown>; stripped: boolean } {
  let stripped = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (VOLATILE_ARG_KEYS.has(key)) {
      stripped = true;
      continue;
    }
    out[key] = value;
  }
  return { args: out, stripped };
}

/**
 * Canonical key order, so two spellings of the same call hash identically.
 *
 * Effect classification, approval fingerprinting, and outcome attribution all
 * key off this. If `{a:1,b:2}` and `{b:2,a:1}` produced different digests, the
 * same approved call could be asked for approval twice.
 */
function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalizeValue(value[key]);
    return out;
  }
  return value;
}

/** Deterministic digest of an invocation's meaning, independent of spelling. */
export function composioCarrierDigest(canonical: CanonicalComposioInvocation): string {
  return createHash('sha256')
    .update(JSON.stringify([canonical.toolSlug, canonicalizeValue(canonical.args)]), 'utf8')
    .digest('hex');
}

/** Render the canonical form for the wire. The only place a string appears. */
export function serializeComposioCarrier(
  canonical: CanonicalComposioInvocation,
): SerializedComposioCarrier {
  const hasArgs = Object.keys(canonical.args).length > 0;
  return {
    tool_slug: canonical.toolSlug,
    arguments: hasArgs ? JSON.stringify(canonicalizeValue(canonical.args)) : null,
  };
}

function refuse(
  error: string,
  violations: string[],
  repair: SerializedComposioCarrier | null = null,
): CarrierNormalizationError {
  return {
    ok: false,
    error,
    violations,
    schemaHash: COMPOSIO_CARRIER_SCHEMA_HASH,
    contract: COMPOSIO_CARRIER_CONTRACT,
    repair,
  };
}

/** Parse the `arguments` payload in whichever representation it arrived. */
function readArgsPayload(
  raw: Record<string, unknown>,
): { args: Record<string, unknown>; adapted: CarrierAdaptation[]; violation?: string } {
  const adapted: CarrierAdaptation[] = [];

  let payload = raw[CARRIER_ARGS_FIELD];
  if (payload === undefined) {
    // An alias key means the same thing; repair it and say so.
    for (const alias of ARGS_DRIFT_KEYS) {
      if (raw[alias] !== undefined) {
        payload = raw[alias];
        adapted.push('arguments_json_alias');
        break;
      }
    }
  }

  if (payload === undefined || payload === null || payload === '') {
    return { args: {}, adapted };
  }

  if (isPlainObject(payload)) {
    // The authoritative shape is a string, but an object carries exactly the
    // same meaning — serialize it rather than spend a round trip teaching that.
    adapted.push('arguments_object_serialized');
    return { args: payload, adapted };
  }

  if (typeof payload === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return { args: {}, adapted, violation: `${CARRIER_ARGS_FIELD} is not valid JSON` };
    }
    // Double encoding: a JSON string whose contents are themselves a JSON
    // string. Unwrap one layer, once — not in a loop, because an unbounded
    // unwrap would happily accept nonsense.
    if (typeof parsed === 'string') {
      try {
        const inner = JSON.parse(parsed);
        if (isPlainObject(inner)) {
          adapted.push('arguments_double_encoded');
          return { args: inner, adapted };
        }
      } catch {
        /* fall through to the shape check below */
      }
    }
    if (!isPlainObject(parsed)) {
      return { args: {}, adapted, violation: `${CARRIER_ARGS_FIELD} must decode to a JSON object` };
    }
    return { args: parsed, adapted };
  }

  return { args: {}, adapted, violation: `${CARRIER_ARGS_FIELD} must be a JSON string` };
}

/**
 * Normalize whatever a caller supplied into the canonical invocation, or refuse
 * with everything needed to get it right next time.
 *
 * This is the single entry point. Every surface that can dispatch a Composio
 * action goes through it, so none of them can develop its own opinion about
 * what a valid call looks like.
 */
export function normalizeComposioCarrierInput(raw: unknown): CarrierNormalization {
  if (!isPlainObject(raw)) {
    return refuse('carrier arguments must be an object', ['(root)']);
  }

  const violations: string[] = [];
  const adapted: CarrierAdaptation[] = [];

  // ── the slug ───────────────────────────────────────────────────────────────
  let slug = raw[CARRIER_SLUG_FIELD];
  if (typeof slug !== 'string' || slug.trim().length === 0) {
    const drifted = SLUG_DRIFT_KEYS.find((key) => typeof raw[key] === 'string' && (raw[key] as string).trim());
    if (drifted) {
      // Deliberately NOT accepted. Naming the right field once is what stops a
      // caller from cycling through spellings; silently accepting `slug` would
      // teach a contract that does not exist.
      const candidate = (raw[drifted] as string).trim();
      const payload = readArgsPayload(raw);
      const repairArgs = stripVolatileConnectionArgs(payload.args).args;
      return refuse(
        `"${drifted}" is not a field of this tool — the action slug goes in "${CARRIER_SLUG_FIELD}"`,
        [drifted],
        serializeComposioCarrier({ toolSlug: candidate, args: repairArgs }),
      );
    }
    return refuse(`${CARRIER_SLUG_FIELD} is required and must be a non-empty string`, [CARRIER_SLUG_FIELD]);
  }
  slug = slug.trim();

  // ── the arguments ──────────────────────────────────────────────────────────
  const payload = readArgsPayload(raw);
  adapted.push(...payload.adapted);
  if (payload.violation) {
    violations.push(payload.violation);
    return refuse(payload.violation, [CARRIER_ARGS_FIELD]);
  }

  const { args, stripped } = stripVolatileConnectionArgs(payload.args);
  if (stripped) adapted.push('connection_id_stripped');

  if (violations.length > 0) {
    return refuse(violations.join('; '), violations);
  }

  return { ok: true, canonical: { toolSlug: slug as string, args }, adapted };
}

/**
 * Parse a legacy stored invocation template into canonical arguments.
 *
 * Procedures were saved as free-form prose — `SLUG(arguments={...})`, a bare
 * JSON object, or the serialized carrier itself. All three mean one thing, and
 * a procedure is only executable if that thing can be recovered mechanically.
 * Placeholders such as `{{start_iso}}` are preserved: they are the part a
 * caller fills in, and destroying them would turn a reusable procedure into a
 * single-use recording.
 *
 * Returns null when the template cannot be understood — which is a `stale`
 * signal for the resolver, not something to guess at.
 */
export function parseLegacyInvocationTemplate(
  template: string | undefined,
  expectedSlug?: string,
): { canonical: CanonicalComposioInvocation; adapted: CarrierAdaptation[] } | null {
  if (typeof template !== 'string' || template.trim().length === 0) return null;
  const text = template.trim();
  const adapted: CarrierAdaptation[] = ['legacy_template_parsed'];

  // Placeholders are not JSON. Swap them for typed sentinels so the body parses,
  // then restore them — the alternative is refusing every reusable procedure.
  const placeholders = new Map<string, string>();
  let sentinelIndex = 0;
  const masked = text.replace(/\{\{\s*[\w.]+\s*\}\}/g, (match) => {
    const sentinel = `__CLEM_PH_${sentinelIndex++}__`;
    placeholders.set(sentinel, match);
    return sentinel;
  });

  const restore = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let out = value;
      for (const [sentinel, original] of placeholders) out = out.split(sentinel).join(original);
      return out;
    }
    if (Array.isArray(value)) return value.map(restore);
    if (isPlainObject(value)) {
      const obj: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) obj[key] = restore(inner);
      return obj;
    }
    return value;
  };

  const candidates: string[] = [];
  // `SLUG(arguments={...})` / `arguments={...}` — the observed legacy form.
  const argsMatch = masked.match(/arguments\s*=\s*(\{[\s\S]*\})\s*\)?\s*$/);
  if (argsMatch?.[1]) candidates.push(argsMatch[1]);
  // A bare JSON object.
  const braceStart = masked.indexOf('{');
  const braceEnd = masked.lastIndexOf('}');
  if (braceStart >= 0 && braceEnd > braceStart) candidates.push(masked.slice(braceStart, braceEnd + 1));

  const slugMatch = text.match(/^([A-Z][A-Z0-9_]{2,})\s*\(/);
  const slug = expectedSlug ?? slugMatch?.[1];
  if (!slug) return null;

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      // Templates were written by a model, so trailing commas and single
      // quotes are common. Repair only those two, and only structurally.
      parsed = JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      continue;
    }
    if (!isPlainObject(parsed)) continue;
    const restored = restore(parsed) as Record<string, unknown>;
    // The serialized carrier itself, stored as a template.
    if (typeof restored[CARRIER_SLUG_FIELD] === 'string') {
      const normalized = normalizeComposioCarrierInput(restored);
      if (normalized.ok) return { canonical: normalized.canonical, adapted: [...adapted, ...normalized.adapted] };
      continue;
    }
    const { args, stripped } = stripVolatileConnectionArgs(restored);
    return {
      canonical: { toolSlug: slug, args },
      adapted: stripped ? [...adapted, 'connection_id_stripped'] : adapted,
    };
  }
  return null;
}

/**
 * A structured, actionable refusal for a caller that got the shape wrong.
 *
 * Deliberately not prose: the caller needs the contract, what it violated, and
 * a shape it can send verbatim. One refusal carrying all three replaces the
 * guess-and-retry loop that cost the incident most of its latency.
 */
export function describeCarrierRefusal(error: CarrierNormalizationError): string {
  const lines = [
    `Invalid composio_execute_tool arguments: ${error.error}.`,
    error.contract,
    `Violated: ${error.violations.join(', ') || '(shape)'} (schema ${error.schemaHash}).`,
  ];
  if (error.repair) {
    lines.push(`Send exactly this instead: ${JSON.stringify(error.repair)}`);
  }
  return lines.join(' ');
}
