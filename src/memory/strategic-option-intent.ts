/**
 * Host-owned interpretation of visible A/Q/B strategy controls.
 *
 * An A/Q/B prefix is optional: live models often render the same visible
 * controls as plain labels ("Explain the rationale", "Customize"). The label
 * itself must still name an explicit explanation or customization request.
 * This is evaluated when the public ask is sealed; later user prose cannot
 * create or change the intent.
 */
export type StrategicMetaAction = 'explain' | 'customize';

function canonical(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function strategicMetaActionFromVisibleLabel(
  label: string,
): StrategicMetaAction | null {
  const value = canonical(label);
  const semanticLabel = /^(?:[AQB]\)\s*)?(.+)$/i.exec(value)?.[1]?.trim() ?? '';
  const explain = semanticLabel;
  if (explain) {
    if (
      /^(?:explain(?:\s+(?:the|this|your))?|why\b|show\s+(?:the\s+)?(?:rationale|reasoning)\b|tell\s+me\s+why\b|walk\s+me\s+through\s+(?:the\s+)?(?:rationale|reasoning)\b)/i
        .test(explain)
      && !/\b(?:customize|change|adjust|edit|execute|publish|send|delete)\b/i.test(explain)
    ) return 'explain';
  }

  const customize = semanticLabel;
  if (customize) {
    if (
      /^(?:customize\b|change\s+(?:the|this|my)\s+(?:plan|direction|strategy|recommendation)\b|adjust\b|edit\s+(?:the|this|my)\s+(?:plan|direction|strategy|recommendation)\b|set\s+(?:my\s+)?preferences\b|choose\s+my\s+own\b)/i
        .test(customize)
      && !/\b(?:execute|publish|send|delete|approve|permission|secrets?)\b/i.test(customize)
    ) return 'customize';
  }
  return null;
}
