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
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
    // Elevation moved from a drop shadow to a hairline plus a surface step, so
    // "raised" is now a real surface that real text sits on — every card in the
    // app. A new surface that no test measures is exactly how --text-subtle
    // spent months at 3.77:1, so it joins the list on the day it is introduced.
    ['raised', vars['--bg-raised']],
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

  /**
   * THE ONE THIS FILE DEMONSTRABLY DID NOT COVER.
   *
   * Every test above walks the ink ramp, the accent and the status/tint pairs.
   * None of them looked at a status colour used as a FILL, so the destructive
   * button — `bg-danger text-white hover:opacity-90` — shipped a 3.07:1 label
   * in dark mode, on the one control in the product that deletes things, and
   * `opacity-90` made it worse at the moment of the click. The primary button
   * had exactly this test and danger did not; that asymmetry is the bug.
   */
  test(`${theme}: the destructive button's label clears AA in all three fill states`, () => {
    const fg = tok['--clem-danger-fg'];
    for (const state of ['--clem-danger', '--clem-danger-hover', '--clem-danger-press'] as const) {
      const r = ratio(fg, tok[state]);
      assert.ok(
        r >= AA_TEXT,
        `--clem-danger-fg (${fg}) on ${state} (${tok[state]}) is ${r.toFixed(2)}:1, needs ${AA_TEXT}`,
      );
    }
  });

  test(`${theme}: the destructive button's own edge clears SC 1.4.11 on every surface`, () => {
    // The fill IS this control's boundary — it carries no border — so the
    // button must be findable against the page before its label is read.
    for (const [name, bg] of surfacesFor(surf)) {
      const r = ratio(tok['--clem-danger'], bg);
      assert.ok(
        r >= AA_NONTEXT,
        `--clem-danger (${tok['--clem-danger']}) on ${name} (${bg}) is ${r.toFixed(2)}:1, needs ${AA_NONTEXT}`,
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

/**
 * The ratios above are only true of the shipped button if the button actually
 * asks for those tokens. It did not: `text-white` bypassed the palette and
 * `hover:opacity-90` expressed a state as a filter, which no contrast test can
 * follow. Assert the wiring, or the measured fix decays the first time someone
 * reaches for a literal again.
 */
test('the destructive button reads its label and its states from the token layer', () => {
  const button = readFileSync(path.join(here, 'components/ui/Button.tsx'), 'utf8');
  const danger = /danger:\s*'([^']*)'/.exec(button);
  assert.ok(danger, 'no danger variant found in components/ui/Button.tsx');
  const classes = danger[1];

  assert.ok(
    !/text-white|text-\[#/.test(classes),
    `the danger button's label must come from --danger-fg, not a literal: "${classes}"`,
  );
  assert.ok(
    !/opacity-\d/.test(classes),
    `a fill state expressed as opacity cannot be measured; use --danger-hover/-press: "${classes}"`,
  );
  for (const required of ['bg-danger', 'text-danger-fg', 'hover:bg-danger-hover', 'active:bg-danger-press']) {
    assert.ok(classes.includes(required), `the danger button is missing ${required}: "${classes}"`);
  }
});

/**
 * THE SAME DEFECT, EVERYWHERE ELSE.
 *
 * The test above reads exactly one file, so it pinned exactly one button —
 * and the app shipped three more of the identical pairing behind a green
 * suite: the STOP control on a live recording (LocalRecordingBanner, 3.07:1
 * dark), the destructive toast (BackgroundTasks, 3.07:1), and the Slack "step
 * done" marker (SlackConnect, 3.18:1 light / 2.59:1 dark). One instance is not
 * the class, so this walks every .tsx in the app.
 *
 * The rule, stated in full: an OPAQUE danger/primary fill may not carry a
 * literal label colour, and may not express an interaction state as opacity.
 *  - a literal label bypasses --danger-fg/--primary-fg, which is what the
 *    measured ratios above are ratios OF;
 *  - a state written as `hover:opacity-N` is a state no contrast test can
 *    follow, and it always makes the label worse at the moment of the click.
 *
 * Deliberately NOT flagged, so the exclusions are stated rather than accidental:
 *  - alpha fills (`bg-danger/5`, `bg-primary/10`) — those are tints, read with
 *    `text-danger`/`text-primary` ink, and are covered by the tint tests;
 *  - `disabled:opacity-*` — dimming a disabled control is intentional, is what
 *    Button.tsx's own base does, and WCAG exempts disabled controls;
 *  - a static `opacity-*` on a text-free decoration (the banner's ping ring);
 *  - `text-white` over `bg-black/*` (KnowledgeGraph3D's 3D overlay), which is
 *    not a token fill at all.
 */
const APP_SRC = here;

function tsxFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFilesUnder(full));
    else if (full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Comments quote the old, broken class strings on purpose — including in this
 *  repo's own explanatory notes — so strip them before reading class strings. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\w])\/\/[^\n]*/g, '$1 ');
}

const OPAQUE_FILL = /(?:^|[\s'"`{])(?:hover:|active:|focus:|group-hover:)?bg-(?:danger|primary)(?![\w/-])/;
const LITERAL_LABEL = /(?:^|[\s'"`{])text-(?:white|black|\[#)/;
const STATE_AS_OPACITY = /(?:hover|focus|active|group-hover):opacity-\d/;

/** Every quoted string in the file; a class list is always one of these. */
export function illegalFillPairings(src: string): string[] {
  const found: string[] = [];
  for (const literal of stripComments(src).match(/'[^']*'|"[^"]*"|`[^`]*`/g) ?? []) {
    if (!OPAQUE_FILL.test(literal)) continue;
    const faults: string[] = [];
    if (LITERAL_LABEL.test(literal)) faults.push('a literal label colour instead of --danger-fg/--primary-fg');
    if (STATE_AS_OPACITY.test(literal)) faults.push('an interaction state expressed as opacity');
    if (faults.length > 0) found.push(`${faults.join(' and ')} — ${literal.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return found;
}

test('no .tsx in the app pairs an opaque danger/primary fill with a literal label or an opacity state', () => {
  const offences: string[] = [];
  for (const file of tsxFilesUnder(APP_SRC)) {
    for (const offence of illegalFillPairings(readFileSync(file, 'utf8'))) {
      offences.push(`${path.relative(APP_SRC, file)}: ${offence}`);
    }
  }
  assert.deepEqual(offences, [], `filled controls must read their label from the token layer:\n${offences.join('\n')}`);
});

test('the scan is not vacuous — it reproduces the three defects it was written for', () => {
  // Verbatim from the tree before this fix. If a refactor makes the scanner
  // stop seeing these, the green suite above means nothing.
  assert.equal(
    illegalFillPairings(
      'className="flex shrink-0 items-center gap-1 rounded-md bg-danger px-2 py-1 text-white transition-opacity hover:opacity-90 disabled:opacity-50"',
    ).length,
    1,
    'the recording banner\'s stop button no longer trips the scan',
  );
  assert.equal(illegalFillPairings("tone === 'danger' ? 'bg-danger text-white' : 'bg-fg text-canvas'").length, 1);
  assert.equal(illegalFillPairings("`${done ? 'bg-primary text-white' : 'bg-subtle text-muted'}`").length, 1);
  // And it does not fire on the shapes it deliberately allows.
  assert.deepEqual(illegalFillPairings("'border-danger/30 bg-danger/5 text-danger'"), []);
  assert.deepEqual(illegalFillPairings("'bg-danger text-danger-fg hover:bg-danger-hover disabled:opacity-50'"), []);
  assert.deepEqual(illegalFillPairings("'animate-ping rounded-full bg-danger opacity-60'"), []);
  assert.deepEqual(illegalFillPairings("'border-white/15 bg-black/50 text-white/80'"), []);
});

/**
 * A CLASS THIS ROUND FOUND THE HARD WAY: a token that is READ but never
 * DECLARED. `var(--missing)` does not warn — the declaration goes invalid at
 * computed-value time, so `color` silently becomes `inherit` and
 * `background-color` silently becomes `transparent`. A control can lose its
 * fill on hover with a green suite and a clean tsc behind it.
 *
 * Every --clem-* a component reaches for by name is checked against the shared
 * layer here. (The console's own --danger-fg / --primary-fg alias layer lives
 * in styles.css and is NOT covered by this file — see the note in the lane
 * report; that gap is what this test was written after.)
 */
test('every --clem-* token a component names is declared in the shared layer', () => {
  const declared = new Set(Object.keys(light));
  const missing: string[] = [];
  for (const file of tsxFilesUnder(APP_SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const [, name] of src.matchAll(/var\((--clem-[\w-]+)/g)) {
      if (!declared.has(name)) missing.push(`${path.relative(APP_SRC, file)}: ${name}`);
    }
  }
  assert.deepEqual(missing, [], `these resolve to nothing at runtime:\n${missing.join('\n')}`);
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

/**
 * THE GAP THIS CLOSES. The test above catches a `var(--clem-*)` written by
 * hand in a component. It cannot see the other half: a TAILWIND UTILITY NAME.
 * `Button.tsx` shipped `bg-danger text-danger-fg hover:bg-danger-hover`, which
 * the config turns into `var(--danger-fg)` / `var(--danger-hover)` — and
 * styles.css declared neither. An undefined var() is invalid-at-computed-value
 * time, so the label fell back to `inherit` and the hover fill to TRANSPARENT
 * on all six destructive controls, while this suite stayed green. A contrast
 * fix that renders nothing is worse than the 3.07:1 it replaced.
 */
test('every semantic colour utility a component uses resolves to a declared property', () => {
  const css = readFileSync(path.join(APP_SRC, 'styles.css'), 'utf8');
  const declared = new Set<string>();
  for (const [, name] of css.matchAll(/(--[\w-]+)\s*:/g)) declared.add(name);

  // The semantic families the app namespaces into its own custom properties.
  const FAMILIES = 'primary|danger|success|warning|info';
  const utility = new RegExp(
    String.raw`(?:^|[\s"'\`:])(?:bg|text|border|ring|from|to|via)-((?:${FAMILIES})(?:-[a-z]+)*)\b`,
    'g',
  );

  const missing: string[] = [];
  for (const file of tsxFilesUnder(APP_SRC)) {
    const src = readFileSync(file, 'utf8');
    for (const [, token] of src.matchAll(utility)) {
      // `bg-danger` → --danger; `text-danger-fg` → --danger-fg.
      const property = `--${token}`;
      if (declared.has(property)) continue;
      // A bare family name always exists; a sub-shade may legitimately be a
      // Tailwind DEFAULT rather than a property, so only flag sub-shades.
      if (!token.includes('-')) continue;
      missing.push(`${path.relative(APP_SRC, file)}: ${token} → ${property}`);
    }
  }
  assert.deepEqual(
    [...new Set(missing)],
    [],
    `these utilities compile to an undefined var() and render nothing:\n${[...new Set(missing)].join('\n')}`,
  );
});
