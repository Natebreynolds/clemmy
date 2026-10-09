/** Host-derived provenance for compact automatic memory lines. Symbols survive
 * internal hit spreads while JSON/model API fields remain exactly unchanged. */
const origin = Symbol('host-bound automatic primer origin');
type Ref = { type: string; id: string | number };
type Origin = Readonly<{ factId: string; sourceUri: string }>;
type Carrier = { [origin]?: Origin };
// A conflicting attachment must not revive its old binding through a spread.
// Disqualifying the shared private value is conservative: all copies keep URI.
const disqualified = new WeakSet<Origin>();

function rejectOrigin(hit: object): void {
  try { const saved = (hit as Carrier)[origin]; if (saved) disqualified.add(saved); } catch { /* raw locator remains */ }
}

function attachOrigin<T extends object>(hit: T, saved: Origin): T {
  try {
    const existing = (hit as Carrier)[origin];
    if (existing) {
      if (existing.factId !== saved.factId || existing.sourceUri !== saved.sourceUri) disqualified.add(existing);
      return hit; // repeated identical binding needs no property mutation
    }
    Object.defineProperty(hit, origin, { enumerable: true, value: saved });
  } catch { rejectOrigin(hit); /* frozen/nonextensible carriers keep raw URI */ }
  return hit;
}

function factId(ref: Ref): string | undefined {
  const id = String(ref.id);
  return (ref.type === 'fact' || ref.type === 'policy') && /^[1-9]\d*$/.test(id)
    && Number.isSafeInteger(Number(id)) ? id : undefined;
}

/** Only the opaque, generated accepted-user-source locator has no account or
 * external navigation information beyond what reopening its fact ref retains. */
function generatedUserSource(source: unknown): source is string {
  if (typeof source !== 'string') return false;
  const seq = source.match(/^conversation:\/\/sess-desktop-[a-f0-9]{24}\/auto-capture%3Auser-source%3A([1-9]\d*)$/)?.[1];
  return Boolean(seq && Number.isSafeInteger(Number(seq)));
}

/** Call only with the source.path of the admitted host fact, never API fields. */
export function retainAutomaticPrimerOrigin<T extends object>(hit: T, ref: Ref, sourcePath: unknown): T {
  const id = factId(ref);
  if (id && generatedUserSource(sourcePath)) {
    return attachOrigin(hit, Object.freeze({ factId: id, sourceUri: sourcePath }));
  }
  rejectOrigin(hit);
  return hit;
}

/** The facade changes object shape; preserve the host binding only for the
 * exact same fact identity (fact and policy projections share that identity). */
export function transferAutomaticPrimerOrigin<T extends object>(from: object, to: T, ref: Ref): T {
  try {
    const saved = (from as Carrier)[origin];
    if (saved && !disqualified.has(saved) && factId(ref) === saved.factId) return attachOrigin(to, saved);
  } catch { /* absent host binding keeps raw locator */ }
  rejectOrigin(to);
  return to;
}

/** The formatter must first select its source by its unchanged source order.
 * Missing or different selected evidence always retains the original locator. */
export function canCompactAutomaticPrimerSource(hit: object, ref: Ref, selectedSource: string): boolean {
  try {
    const saved = (hit as Carrier)[origin];
    return Boolean(saved && !disqualified.has(saved) && factId(ref) === saved.factId && selectedSource === saved.sourceUri);
  } catch { return false; }
}
