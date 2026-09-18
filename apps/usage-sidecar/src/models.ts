/** Strip date suffixes and vendor noise so sonnet-5 and sonnet-5-20250514 match. */
export function normalizeModel(id: string | undefined | null): string {
  if (!id) return '';
  return id
    .trim()
    .toLowerCase()
    .replace(/:\w+$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/[^a-z0-9.+-]+/g, '-');
}

export function modelsComparable(a: string | undefined, b: string | undefined): boolean {
  const na = normalizeModel(a);
  const nb = normalizeModel(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.startsWith(`${nb}-`) || nb.startsWith(`${na}-`);
}

export function primaryModel(models: string[]): string | null {
  const counts = new Map<string, number>();
  for (const model of models) {
    const key = normalizeModel(model) || model;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [model, count] of counts) {
    if (count > n) {
      best = model;
      n = count;
    }
  }
  return best;
}
