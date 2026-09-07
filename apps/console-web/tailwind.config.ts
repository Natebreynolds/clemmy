import type { Config } from 'tailwindcss';

/**
 * Clementine console — friendly-premium theme.
 *
 * Colors resolve to CSS variables defined in src/styles.css (`:root`
 * light = default, `.dark` overrides). This keeps components
 * theme-agnostic (e.g. `bg-surface text-fg`) and lets the Light/Dark/
 * System toggle swap one class on <html>. The orange brand stays the
 * hero; the old electric lime/cyan and CRT scanlines are gone.
 */
const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Brand orange — softened toward "clementine" tangerine.
        primary: {
          DEFAULT: 'var(--primary)',
          hover: 'var(--primary-hover)',
          press: 'var(--primary-press)',
          fg: 'var(--primary-fg)',
          tint: 'var(--primary-tint)',
        },
        // Surfaces (warm paper light / warm charcoal dark).
        canvas: 'var(--bg-canvas)',
        surface: 'var(--bg-surface)',
        subtle: 'var(--bg-subtle)',
        hover: 'var(--bg-hover)',
        // One step up the ramp. Elevation is THIS plus a hairline; see the
        // boxShadow note below for why it is not a shadow.
        raised: 'var(--bg-raised)',
        // Text.
        fg: 'var(--text)',
        muted: 'var(--text-muted)',
        faint: 'var(--text-subtle)',
        // Lines.
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        'border-raised': 'var(--border-raised)',
        ring: 'var(--ring)',
        // Semantic (always paired with an icon + label in UI).
        success: { DEFAULT: 'var(--success)', tint: 'var(--success-tint)' },
        info: { DEFAULT: 'var(--info)', tint: 'var(--info-tint)' },
        warning: { DEFAULT: 'var(--warning)', tint: 'var(--warning-tint)' },
        /* Danger is the only status colour that is also a FILL — the delete
           button. It therefore needs the same three-state + label contract the
           primary button has, instead of `text-white hover:opacity-90`, whose
           dark-mode label measured 3.07:1. Asserted in
           design-tokens.contrast.test.ts, both themes, all three states. */
        danger: {
          DEFAULT: 'var(--danger)',
          hover: 'var(--danger-hover)',
          press: 'var(--danger-press)',
          fg: 'var(--danger-fg)',
          tint: 'var(--danger-tint)',
        },
      },
      /* THE ACCENT'S TWO ROLES.
       *
       * `colors.primary` stays the FILL (bg-primary, and the sub-shades a
       * filled control needs). These three overrides redirect the *reading*
       * roles — text, border, ring — to --primary-ink.
       *
       * Why here and not at 161 call sites: Tailwind resolves text-primary,
       * bg-primary, border-primary and ring-primary from one `colors.primary`
       * entry, so rebinding --primary alone could not split them. Overriding
       * the three role scales corrects every `text-primary` (161),
       * `border-primary` (51) and `ring-primary` (8) usage with zero component
       * edits — while `text-primary-fg` (9 sites: a label ON a fill) and
       * `text-primary-hover` (the link hover) keep working, now at values that
       * clear AA instead of 3.18:1 and 2.43:1.
       */
      textColor: {
        primary: {
          DEFAULT: 'var(--primary-ink)',
          hover: 'var(--primary-ink-hover)',
          press: 'var(--primary-press)',
          fg: 'var(--primary-fg)',
          tint: 'var(--primary-tint)',
        },
      },
      borderColor: {
        primary: {
          DEFAULT: 'var(--primary-ink)',
          hover: 'var(--primary-ink-hover)',
        },
      },
      ringColor: {
        primary: {
          DEFAULT: 'var(--primary-ink)',
        },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      /* THE READING FLOOR.
       *
       * Measured, not asserted: of 1,633 typed sites in this app, 1,240 (76%)
       * were `text-small` (13px) or `text-caption` (12px). That is the whole
       * "it reads like a chatbot" complaint in one number — the console was
       * not dense by decision, it was small by default, because the document
       * base was 14px and every quiet thing was written one step below it.
       *
       * Every step below moves up one notch, which lifts the FLOOR from 12px
       * to 13px and the bulk of the UI from 13px to 14px, without renaming a
       * class or touching 1,240 call sites. Prose lands on `body` at a real
       * 16px/1.6; genuinely tabular density still asks for `caption` and
       * still gets 13px, which is a density choice rather than an accident.
       */
      fontSize: {
        display: ['2.5rem', { lineHeight: '1.15', fontWeight: '800', letterSpacing: '-0.02em' }],
        h1: ['1.75rem', { lineHeight: '1.25', fontWeight: '700', letterSpacing: '-0.01em' }],
        h2: ['1.375rem', { lineHeight: '1.3', fontWeight: '700', letterSpacing: '-0.01em' }],
        h3: ['1.125rem', { lineHeight: '1.4', fontWeight: '600' }],
        'body-lg': ['1.0625rem', { lineHeight: '1.6' }],   // 17px — reading surfaces
        body: ['1rem', { lineHeight: '1.6' }],             // 16px — THE body minimum
        small: ['0.875rem', { lineHeight: '1.45' }],       // 14px — secondary UI text
        caption: ['0.8125rem', { lineHeight: '1.4' }],     // 13px — the density floor
        label: ['0.8125rem', { lineHeight: '1.4', fontWeight: '600' }],
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
      },
      /* ELEVATION IS A HAIRLINE PLUS A SURFACE STEP — see --bg-raised and the
       * `.raised` utility in styles.css. A shadow survives here only for the
       * three things that genuinely detach from the page.
       *
       * The old five-step ramp (xs/sm/md/lg) was applied to 47 sites, most of
       * them ordinary cards, which is self-defeating: a lift that every card
       * has distinguishes no card from any other, and the page reads as one
       * soft field instead of a hierarchy. The three names below say what the
       * thing IS, so the wrong one is harder to reach for than the right one.
       *
       * xs/sm/md/lg are kept as aliases because two other lanes still name
       * them, and a class Tailwind does not define fails silently. xs and sm
       * — the card-lift levels — now resolve to `none`, so the flattening
       * lands app-wide rather than only where this lane could edit.
       */
      boxShadow: {
        popover: '0 8px 24px rgba(31,27,22,.10), 0 1px 2px rgba(31,27,22,.06)',
        modal: '0 24px 56px rgba(31,27,22,.16), 0 2px 6px rgba(31,27,22,.08)',
        drag: '0 12px 28px rgba(31,27,22,.16)',
        'warm-halo': '0 8px 28px color-mix(in srgb, var(--primary) 18%, transparent)',
        xs: 'none',
        sm: 'none',
        md: '0 8px 24px rgba(31,27,22,.10), 0 1px 2px rgba(31,27,22,.06)',
        lg: '0 24px 56px rgba(31,27,22,.16), 0 2px 6px rgba(31,27,22,.08)',
      },
      transitionDuration: {
        fast: 'var(--clem-dur-fast)',
        base: 'var(--clem-dur-base)',   // 180ms — the default
        slow: 'var(--clem-dur-slow)',   // 300ms — the ceiling, nothing past it
      },
      /* ONE press, everywhere: scale(0.97). `active:scale-press`. */
      scale: {
        press: 'var(--clem-press)',
      },
      /* Duration was tokenised here; easing never was, so ~95 of 120
         transitions ran Tailwind's default curve. Adopted from mobile, which
         reasoned it out first: "things arrive and settle, they do not bounce."
         Deliberately no overshoot. */
      transitionTimingFunction: {
        DEFAULT: 'var(--clem-ease)',
        out: 'var(--clem-ease)',
      },
      keyframes: {
        breathe: {
          '0%,100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.06)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        breathe: 'breathe 3s ease-in-out infinite',
        // One curve, and inside the budget. Note it fades from opacity 0 —
        // never from scale(0), which reads as an entrance and makes the eye
        // wait for the element to finish arriving before it believes it.
        'fade-in': 'fade-in var(--clem-dur-base) var(--clem-ease)',
      },
    },
  },
  plugins: [],
};

export default config;
