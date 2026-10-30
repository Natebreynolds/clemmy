/** Small drawn marks for states, in one stroke weight: a done check, a
 *  failed cross, and the close mark. Text glyphs render in whatever font
 *  the system picks; these render the same everywhere. */
export function CheckMark({ class: extra = '' }: { class?: string }) {
  return (
    <svg class={`glyph ${extra}`.trim()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function CrossMark({ class: extra = '' }: { class?: string }) {
  return (
    <svg class={`glyph ${extra}`.trim()} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
