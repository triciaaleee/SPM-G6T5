/** @type {import('tailwindcss').Config} */
// Colours/radius are mapped straight onto the CSS custom properties in
// src/styles/tokens.css (sourced from Style.md) so Tailwind utilities and
// the existing hand-written views stay on the same design tokens. Spacing
// is intentionally left on Tailwind's default rem scale rather than aliased
// to --spacing-*, which would silently break the numeric step ordering —
// use arbitrary values like p-[var(--spacing-24)] where a token value matters.
export default {
  content: ["./index.html", "./src/**/*.{vue,ts}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["var(--font-family-lato)"],
      },
      colors: {
        base: {
          white: "var(--color-base-white)",
          black: "var(--color-base-black)",
        },
        grey: {
          25: "var(--color-grey-25)",
          50: "var(--color-grey-50)",
          75: "var(--color-grey-75)",
          100: "var(--color-grey-100)",
          200: "var(--color-grey-200)",
          300: "var(--color-grey-300)",
          400: "var(--color-grey-400)",
          500: "var(--color-grey-500)",
          600: "var(--color-grey-600)",
          700: "var(--color-grey-700)",
          800: "var(--color-grey-800)",
          900: "var(--color-grey-900)",
        },
        purple: {
          100: "var(--color-purple-100)",
          200: "var(--color-purple-200)",
          300: "var(--color-purple-300)",
          600: "var(--color-purple-600)",
          700: "var(--color-purple-700)",
          800: "var(--color-purple-800)",
        },
        error: {
          200: "var(--color-error-200)",
          600: "var(--color-error-600)",
        },
        warning: {
          400: "var(--color-warning-400)",
          600: "var(--color-warning-600)",
        },
        success: {
          600: "var(--color-success-600)",
        },
      },
      borderRadius: {
        xs: "var(--radius-xs)",
        sm: "var(--radius-sm)",
        lg: "var(--radius-lg)",
        full: "var(--radius-full)",
      },
    },
  },
  plugins: [],
};
