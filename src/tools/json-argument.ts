/**
 * A tool argument that carries a JSON document.
 *
 * These parameters used to accept only a string, so the model had to embed a
 * whole JSON document inside a JSON string, and when the call travelled
 * through a carrier (work_call / call_tool, whose own arguments are a JSON
 * string) the document was escaped twice. A long document written that way
 * breaks easily, and every malformed attempt costs a whole model round.
 *
 * The same parameter now also accepts the document itself. The model writes
 * native JSON, as it does for every other structured argument, and the tool
 * sees the same text it always did: an object is serialized once, here, and
 * the existing byte limits and shape checks run on that text unchanged. The
 * string form keeps working.
 */
import { z } from 'zod';

/** A JSON object, either as its text or as the object. */
export const jsonObjectArgument = () => z.union([z.string(), z.record(z.string(), z.unknown())]);

/** A JSON value of any shape (object or array), either as its text or as the value. */
export const jsonValueArgument = () => z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);

export type JsonArgument = string | Record<string, unknown> | unknown[] | null | undefined;

/**
 * The document's text: a string as given, a structured value serialized
 * once. Null and undefined pass through so "not provided" stays distinct
 * from an empty document.
 */
export function jsonArgumentText(value: JsonArgument): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}
