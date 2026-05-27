/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    borderRadius: {
      none: '0',
      sm: '0',
      DEFAULT: '0',
      md: '0',
      lg: '0',
      xl: '0',
      '2xl': '0',
      '3xl': '0',
      full: '0',
    },
    extend: {
      fontFamily: {
        sans: ['Outfit', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      colors: {
        // Theme-aware tokens resolve to CSS variables defined in index.css.
        // `<alpha-value>` + `rgb(... / ...)` keeps Tailwind's `/50` opacity
        // modifiers (e.g. `bg-tagma-bg/50`, `text-tagma-muted/70`) working.
        // Dark is the default (:root); `html.light` overrides for light mode.
        'tagma-bg': 'rgb(var(--tagma-bg) / <alpha-value>)',
        'tagma-surface': 'rgb(var(--tagma-surface) / <alpha-value>)',
        'tagma-elevated': 'rgb(var(--tagma-elevated) / <alpha-value>)',
        'tagma-border': 'rgb(var(--tagma-border) / <alpha-value>)',
        'tagma-text': 'rgb(var(--tagma-text) / <alpha-value>)',
        'tagma-muted': 'rgb(var(--tagma-muted) / <alpha-value>)',
        'tagma-muted-dim': 'rgb(var(--tagma-muted-dim) / <alpha-value>)',
        'tagma-accent': 'rgb(var(--tagma-accent) / <alpha-value>)',
        'tagma-success': 'rgb(var(--tagma-success) / <alpha-value>)',
        'tagma-error': 'rgb(var(--tagma-error) / <alpha-value>)',
        'tagma-warning': 'rgb(var(--tagma-warning) / <alpha-value>)',
        'tagma-info': 'rgb(var(--tagma-info) / <alpha-value>)',
        'tagma-ready': 'rgb(var(--tagma-ready) / <alpha-value>)',
      },
      boxShadow: {
        // Drive all themed shadows through the same CSS vars that power the
        // tagma-* Tailwind colors so the light-mode override in index.css
        // produces the correct tint instead of the dark-mode-baked rgba.
        // The panel shadow's inset ring and drop intensities match the
        // original dark-mode values (1px@0.6 + 24px@0.4) so the dark theme
        // renders identically to before.
        'glow-accent': '0 0 12px -2px rgb(var(--tagma-accent) / 0.25)',
        'glow-success': '0 0 12px -2px rgb(var(--tagma-success) / 0.25)',
        'glow-error': '0 0 12px -2px rgb(var(--tagma-error) / 0.25)',
        panel: '0 0 0 1px rgb(var(--tagma-border) / 0.6), 0 8px 24px -4px rgba(0, 0, 0, 0.4)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'fade-in': 'fadeIn 0.2s ease-out both',
        'slide-in-right': 'slideInRight 0.15s ease-out both',
        'slide-in-left': 'slideInLeft 0.12s ease-out both',
        'slide-in-down': 'slideInDown 0.12s ease-out both',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(8px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        slideInLeft: {
          '0%': { opacity: '0', transform: 'translateX(-6px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        slideInDown: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
