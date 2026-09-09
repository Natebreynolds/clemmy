import type { Config } from "tailwindcss";

/**
 * The site's Tailwind theme, anchored to the product.
 *
 * The `clem` ramp used to be Tailwind's stock `orange`, renamed: its 500 was
 * #f97316, not Clementine's #f26419. Anyone comparing the site to the app was
 * comparing two different oranges. Every stop below is derived from
 * packages/design-tokens/tokens.css, and the ramp encodes the accent's two
 * roles so a component picks the right one by picking a number:
 *
 *   clem-400/500/600  the orange you look AT   — FILL only (2.97:1 on paper)
 *   clem-700/800      the orange you READ      — text, icons, borders
 *                                                (5.08:1 and 7.05:1 on paper)
 *   clem-300/400      the read role on the dark panel  (9.47:1 / 7.56:1)
 *
 * Ratios were computed from these hex values against --bg #faf7f2 and the
 * dark panel --panel #16140f; the console asserts the same tokens in
 * apps/console-web/src/design-tokens.contrast.test.ts.
 */
const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        clem: {
          50: "#fff4ed", // --clem-primary-tint
          100: "#ffe4d3",
          200: "#ffc7a8",
          300: "#ffa471", // read role on the dark panel — 9.47:1 on --panel
          400: "#ff8442", // --clem-primary-hover  (fill)
          500: "#f26419", // --clem-primary        (fill — the brand hero)
          600: "#de5a12", // --clem-primary-press  (fill)
          700: "#b94300", // --clem-primary-ink    (read — 5.08:1 on paper)
          800: "#963400", // --clem-primary-ink-hover
          900: "#6f2600",
          950: "#4a1900",
        },
        // The label on a filled accent button: warm ink, not white. White is
        // 3.18:1 on the fill at rest and 2.43:1 on hover — the control gets
        // harder to read the moment you touch it.
        "clem-fg": "#1f1b16",
      },
      fontFamily: {
        // The console's face. `var(--font-geist-sans)` resolved to nothing —
        // the variable was never defined and `geist` was never installed.
        sans: [
          '"Plus Jakarta Sans Variable"',
          '"Plus Jakarta Sans"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "sans-serif",
        ],
        mono: ['ui-monospace', '"SF Mono"', "Menlo", "monospace"],
      },
      transitionTimingFunction: {
        // "Things arrive and settle, they do not bounce." --clem-ease.
        clem: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
      transitionDuration: {
        // --clem-dur-fast / -base / -slow. 300ms is the ceiling.
        fast: "120ms",
        base: "180ms",
        slow: "300ms",
      },
      animation: {
        // Was 0.8s — nearly three times the motion ceiling, on the entrance
        // of the first thing anyone sees.
        "fade-in": "fade-in 300ms cubic-bezier(0.22, 1, 0.36, 1)",
        glow: "glow 4s ease-in-out infinite",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        glow: {
          "0%, 100%": { opacity: "0.6" },
          "50%": { opacity: "1" },
        },
      },
    },
  },
  plugins: [],
};

export default config;
