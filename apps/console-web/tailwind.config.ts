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
        // Text.
        fg: 'var(--text)',
        muted: 'var(--text-muted)',
        faint: 'var(--text-subtle)',
        // Lines.
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        ring: 'var(--ring)',
        // Semantic (always paired with an icon + label in UI).
        success: { DEFAULT: 'var(--success)', tint: 'var(--success-tint)' },
        info: { DEFAULT: 'var(--info)', tint: 'var(--info-tint)' },
        warning: { DEFAULT: 'var(--warning)', tint: 'var(--warning-tint)' },
        danger: { DEFAULT: 'var(--danger)', tint: 'var(--danger-tint)' },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans Variable"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        display: ['2.5rem', { lineHeight: '2.875rem', fontWeight: '800', letterSpacing: '-0.02em' }],
        h1: ['1.75rem', { lineHeight: '2.125rem', fontWeight: '700', letterSpacing: '-0.01em' }],
        h2: ['1.375rem', { lineHeight: '1.75rem', fontWeight: '700', letterSpacing: '-0.01em' }],
        h3: ['1.125rem', { lineHeight: '1.5rem', fontWeight: '600' }],
        'body-lg': ['1rem', { lineHeight: '1.625rem' }],
        body: ['0.875rem', { lineHeight: '1.375rem' }],
        small: ['0.8125rem', { lineHeight: '1.125rem' }],
        caption: ['0.75rem', { lineHeight: '1rem' }],
        label: ['0.75rem', { lineHeight: '1rem', fontWeight: '600' }],
      },
      borderRadius: {
        sm: '8px',
        md: '12px',
        lg: '16px',
        xl: '24px',
      },
      boxShadow: {
        xs: '0 1px 2px rgba(31,27,22,.06)',
        sm: '0 1px 3px rgba(31,27,22,.08), 0 1px 2px rgba(31,27,22,.05)',
        md: '0 4px 12px rgba(31,27,22,.10), 0 2px 4px rgba(31,27,22,.06)',
        lg: '0 12px 32px rgba(31,27,22,.14), 0 4px 8px rgba(31,27,22,.08)',
        'warm-halo': '0 8px 28px color-mix(in srgb, var(--primary) 18%, transparent)',
      },
      transitionDuration: {
        fast: '150ms',
        base: '200ms',
        slow: '300ms',
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
        'fade-in': 'fade-in 200ms ease-out',
      },
    },
  },
  plugins: [],
};

export default config;
