/**
 * The contrast gate.
 *
 * This test does NOT restate ratios — it PARSES the token files and recomputes
 * every one from the shipped hex values. That distinction is the entire point.
 * The previous token file carried this comment:
 *
 *     "Contrast targets: text 12.8:1, muted 5.9:1, subtle/placeholder 4.6:1
 *      (all >= WCAG AA on the cream canvas)"
 *
 * for a --text-subtle that measured 3.77:1. A prose claim cannot fail, so it
 * was wrong for months across ~468 `text-faint` sites and every placeholder.
 * Anything asserted here is recomputed on every run, so the regression becomes
 * unrepresentable rather than merely unlikely.
 *
 * Scope: the shared layer in packages/design-tokens/tokens.css, checked against
 * the console's own surface ramp. Mobile pins its own light-only invariants in
 * apps/mobile-web/src/lib/mobile-shell.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const TOKENS = path.join(repoRoot, 'packages/design-tokens/tokens.css');
const CONSOLE_CSS = path.join(here, 'styles.css');

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const channel = (raw: number): number => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(h.slice(0, 2), 16));
  const g = channel(parseInt(h.slice(2, 4), 16));
  const b = channel(parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Reads custom properties out of one CSS block. `selector` is matched literally
 * against the text preceding the brace, so `:root` and `.dark` stay distinct
 * even though the dark block also lists `:root.dark`.
 */
function tokensIn(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `no "${selector} {" block found`);
  const end = css.indexOf('\n}', start);
  const block = css.slice(start, end);
  const out: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    out[name] = value.trim();
  }
  return out;
}

const tokensCss = readFileSync(TOKENS, 'utf8');
const consoleCss = readFileSync(CONSOLE_CSS, 'utf8');

const light = tokensIn(tokensCss, ':root');
const lightSurfaces = tokensIn(consoleCss, ':root');

// The dark blocks REDECLARE only what changes; everything else inherits from
// :root through the normal cascade. Model that here, or the test reports a
// missing token where the browser would resolve one -- which is how this
// caught itself on the first run (--clem-focus is declared once, in :root).
const dark = { ...light, ...tokensIn(tokensCss, ':root.dark,\n.dark') };
const darkSurfaces = { ...lightSurfaces, ...tokensIn(consoleCss, '.dark') };

const AA_TEXT = 4.5;   // WCAG 2.2 SC 1.4.3, text under 18.66px
const AA_NONTEXT = 3;  // SC 1.4.11, focus indicators and UI component boundaries

/** Every surface a token may legitimately be read against, per theme. */
function surfacesFor(vars: Record<string, string>): Array<[string, string]> {
  return [
    ['canvas', vars['--bg-canvas']],
    ['surface', vars['--bg-surface']],
    ['subtle', vars['--bg-subtle']],
  ];
}

for (const [theme, tok, surf] of [
  ['light', light, lightSurfaces],
  ['dark', dark, darkSurfaces],
] as const) {
  test(`${theme}: body ink clears AA on every surface`, () => {
    for (const [name, bg] of surfacesFor(surf)) {
      for (const ink of ['--clem-ink', '--clem-ink-muted', '--clem-ink-subtle'] as const) {
        const r = ratio(tok[ink], bg);
        assert.ok(
          r >= AA_TEXT,
          `${ink} (${tok[ink]}) on ${name} (${bg}) is ${r.toFixed(2)}:1, needs ${AA_TEXT}`,
        );
      }
    }
  });

  test(`${theme}: accent-as-text clears AA wherever accent text is read`, () => {
    const ink = tok['--clem-primary-ink'];
    for (const [name, bg] of [...surfacesFor(surf), ['tint', tok['--clem-primary-tint']] as [string, string]]) {
      const r = ratio(ink, bg);
      assert.ok(
        r >= AA_TEXT,
        `--clem-primary-ink (${ink}) on ${name} (${bg}) is ${r.toFixed(2)}:1, needs ${AA_TEXT}`,
      );
    }
  });

  // The one that was actively getting worse under the user's finger: white on
  // --primary-hover measured 2.43:1, so the product's most important control
  // became harder to read at the moment of interaction.
  test(`${theme}: the primary button's label clears AA in all three fill states`, () => {
    const fg = tok['--clem-primary-fg'];
    for (const state of ['--clem-primary', '--clem-primary-hover', '--clem-primary-press'] as const) {
      const r = ratio(fg, tok[state]);
      assert.ok(
        r >= AA_TEXT,
        `--clem-primary-fg (${fg}) on ${state} (${tok[state]}) is ${r.toFixed(2)}:1, needs ${AA_TEXT}`,
      );
    }
  });

  test(`${theme}: status colours clear AA on their own tints`, () => {
    for (const kind of ['success', 'info', 'warning', 'danger'] as const) {
      const fg = tok[`--clem-${kind}`];
      const bg = tok[`--clem-${kind}-tint`];
      const r = ratio(fg, bg);
      assert.ok(r >= AA_TEXT, `--clem-${kind} (${fg}) on its tint (${bg}) is ${r.toFixed(2)}:1, needs ${AA_TEXT}`);
    }
  });

  test(`${theme}: the focus indicator clears SC 1.4.11 on every surface`, () => {
    // --clem-focus is declared as var(--clem-primary-ink); resolve it.
    const focus = tok['--clem-focus'].startsWith('var(')
      ? tok[tok['--clem-focus'].slice(4, -1).trim()]
      : tok['--clem-focus'];
    for (const [name, bg] of surfacesFor(surf)) {
      const r = ratio(focus, bg);
      assert.ok(
        r >= AA_NONTEXT,
        `focus (${focus}) on ${name} (${bg}) is ${r.toFixed(2)}:1, needs ${AA_NONTEXT}`,
      );
    }
  });
}

test('the fill accent is never offered as a text colour by the shared layer', () => {
  // --clem-primary is 3.18:1 on white. It is a fill, and the split into
  // --clem-primary-ink is the only reason 161 `text-primary` sites are legal.
  // If these two ever converge in light mode, the split has been undone.
  assert.notEqual(
    light['--clem-primary'],
    light['--clem-primary-ink'],
    'light mode collapsed the fill and ink accents back into one value',
  );
  assert.ok(
    ratio(light['--clem-primary'], lightSurfaces['--bg-canvas']) < AA_TEXT,
    'if --clem-primary now clears AA as text, re-derive this split rather than deleting the test',
  );
});

test('dark may share one accent because it measurably clears AA as text', () => {
  // Not an oversight: #ff7a45 is ~7:1 on the dark canvas, so dark needs no
  // second role. This asserts the REASON, so the day it stops being true the
  // test fails instead of the theme silently regressing.
  assert.ok(
    ratio(dark['--clem-primary'], darkSurfaces['--bg-canvas']) >= AA_TEXT,
    'dark collapsed fill and ink into one accent that no longer clears AA as text',
  );
});
