/**
 * Tailwind v4 runs as a PostCSS plugin and nothing else.
 *
 * No `tailwind.config.js`, no `autoprefixer`, no `postcss-import`. v4 folds all
 * three in: the theme lives in `app/globals.css` behind `@theme`, `@import` is
 * resolved by the plugin, and vendor prefixing is handled by Lightning CSS.
 * Adding autoprefixer back is the usual copy-paste mistake — it double-prefixes
 * and quietly breaks `@supports` blocks the plugin already emitted.
 */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
