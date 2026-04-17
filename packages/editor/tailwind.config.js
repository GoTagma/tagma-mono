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
        'tagma-bg': '#0a0a0a',
        'tagma-surface': '#141414',
        'tagma-elevated': '#1e1e1e',
        'tagma-border': '#2a2a2a',
        'tagma-text': '#e8eaed',
        'tagma-muted': '#b0b8c4',
        'tagma-muted-dim': '#8a919c',
        'tagma-accent': '#d4845a',
        'tagma-success': '#34d399',
        'tagma-error': '#f87171',
        'tagma-warning': '#fbbf24',
        'tagma-info': '#a78bfa',
        'tagma-ready': '#67e8f9',
      },
      boxShadow: {
        'glow-accent': '0 0 12px -2px rgba(212, 132, 90, 0.25)',
        'glow-success': '0 0 12px -2px rgba(52, 211, 153, 0.25)',
        'glow-error': '0 0 12px -2px rgba(248, 113, 113, 0.25)',
        panel: '0 0 0 1px rgba(42, 42, 42, 0.6), 0 8px 24px -4px rgba(0, 0, 0, 0.4)',
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
