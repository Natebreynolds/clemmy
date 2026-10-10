/**
 * A work carrier's own fields (requirement_id, seal_amendment, source_call_ids,
 * source_record_ids, universe_item_id, universe_selector, and the target's
 * name) belong beside `args_json`, never inside it. A model sometimes nests
 * them in the target's arguments; the target tool then receives fields that
 * are not its own, and the call's bound identity and the arguments the tool
 * actually runs with no longer agree (live 2026-10-09: a curl download sent
 * this way never ran, its settlement could not be found, and the turn ended
 * on "I could not reopen the saved checkpoint").
 *
 * This moves them back out: a field the carrier left empty takes the nested
 * value, and the target's arguments keep only their own. It recognises the
 * shape by the carrier's own field names, never by which tool is called.
 *
 * `args_json` sent as the object itself, rather than as its JSON text, is the
 * same document: it is encoded once here instead of refused, so the call runs
 * in the round it was made.
 *
 * A field the carrier does not have, sent empty (null, [] or ""), carries no
 * information and is dropped. The carrier's schema is strict, and for a local
 * write the host has already opened the inner call when the schema refuses
 * it, so an empty stray field ended the whole turn (live 2026-10-10:
 * `record_ids: null` beside a shell write). A stray field with a value is
 * left for the schema to refuse.
 */

const CARRIER_FIELDS = [
  'requirement_id',
  'seal_amendment',
  'source_call_ids',
  'source_record_ids',
  'universe_item_id',
  'universe_selector',
] as const;

/** Every top-level field a work carrier may carry. */
const CARRIER_OWN_FIELDS = new Set<string>([...CARRIER_FIELDS, 'name', 'args_json', 'proposal']);

const emptyValue = (value: unknown): boolean => value === null || value === undefined || value === ''
  || (Array.isArray(value) && value.length === 0);

export interface LiftedCarrierFields {
  argumentsJson: string;
  target: string;
  changes: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The carrier call with its own fields moved out of `args_json` and the
 *  target's arguments as one JSON string; null when there is nothing to change. */
export function liftNestedCarrierFields(argumentsJson: string): LiftedCarrierFields | null {
  let parsedOuter: Record<string, unknown> | null;
  try { parsedOuter = record(JSON.parse(argumentsJson)); } catch { return null; }
  if (!parsedOuter) return null;
  const strayEmpty = Object.keys(parsedOuter).filter((field) => !CARRIER_OWN_FIELDS.has(field) && emptyValue(parsedOuter![field]));
  const outer: Record<string, unknown> = Object.fromEntries(Object.entries(parsedOuter)
    .filter(([field]) => !strayEmpty.includes(field)));
  const strayChange = strayEmpty.length > 0
    ? [`dropped ${strayEmpty.join(', ')}: not a field of this carrier, and sent empty`] : [];
  const sentAsObject = record(outer.args_json);
  const strayOnly = (): LiftedCarrierFields | null => {
    const target = typeof outer.name === 'string' ? outer.name.trim() : '';
    return strayChange.length > 0 && target
      ? { argumentsJson: JSON.stringify(outer), target, changes: strayChange } : null;
  };
  let inner: Record<string, unknown> | null = sentAsObject;
  if (!inner) {
    if (typeof outer.args_json !== 'string') return strayOnly();
    try { inner = record(JSON.parse(outer.args_json)); } catch { return strayOnly(); }
  }
  if (!inner) return strayOnly();
  const nested = CARRIER_FIELDS.filter((field) => field in inner!);
  // Only the carrier's own fields mark the shape; a target that merely has a
  // `name` parameter is left alone.
  if (nested.length === 0 && !sentAsObject) return strayOnly();
  const outerName = typeof outer.name === 'string' ? outer.name.trim() : '';
  const innerName = nested.length > 0 && typeof inner.name === 'string' ? inner.name.trim() : '';
  if (outerName && innerName && innerName !== outerName) return strayOnly();
  const target = outerName || innerName;
  if (!target) return null;
  const changes: string[] = [...strayChange, ...(sentAsObject
    ? ['encoded args_json once; it takes the target\'s arguments as one JSON string, not the object itself']
    : [])];
  if (nested.length === 0) {
    return { argumentsJson: JSON.stringify({ ...outer, args_json: JSON.stringify(inner) }), target, changes };
  }
  const nextOuter: Record<string, unknown> = { ...outer };
  const nextInner: Record<string, unknown> = { ...inner };
  for (const field of nested) {
    const value = inner[field];
    const outerEmpty = nextOuter[field] === undefined || nextOuter[field] === null
      || (Array.isArray(nextOuter[field]) && (nextOuter[field] as unknown[]).length === 0);
    if (outerEmpty && value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0)) {
      nextOuter[field] = value;
    }
    delete nextInner[field];
  }
  if (innerName) delete nextInner.name;
  if (!outerName) nextOuter.name = target;
  changes.push(`moved ${[...nested, ...(innerName ? ['name'] : [])].join(', ')} out of args_json; the target's arguments are only its own`);
  nextOuter.args_json = JSON.stringify(nextInner);
  return { argumentsJson: JSON.stringify(nextOuter), target, changes };
}
