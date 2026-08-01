import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    container: {
      center: true,
      padding: {
        DEFAULT: "1.25rem",
        sm: "1.5rem",
        lg: "2.5rem",
        xl: "3rem",
      },
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        ink: "rgb(var(--ink) / <alpha-value>)",
        paper: "rgb(var(--paper) / <alpha-value>)",
        mist: "rgb(var(--mist) / <alpha-value>)",
        lake: "rgb(var(--lake) / <alpha-value>)",
        forest: "rgb(var(--forest) / <alpha-value>)",
        sand: "rgb(var(--sand) / <alpha-value>)",
      },
      borderRadius: {
        "4xl": "2rem",
      },
      boxShadow: {
        soft: "0 24px 70px rgba(20, 49, 44, 0.10)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(18px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        drift: {
          "0%, 100%": { transform: "translate3d(0, 0, 0) scale(1.02)" },
          "50%": { transform: "translate3d(0, -8px, 0) scale(1.035)" },
        },
      },
      animation: {
        "accordion-down": "accordion-down 250ms ease-out",
        "accordion-up": "accordion-up 250ms ease-out",
        "fade-up": "fade-up 700ms ease-out both",
        drift: "drift 14s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
