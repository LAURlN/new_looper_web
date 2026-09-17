import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works both at the dev server root and at
  // https://<user>.github.io/<repo>/ on GitHub Pages. `import.meta.env.BASE_URL`
  // stays './', which mic.ts resolves against the page URL for the worklet.
  base: './',
  define: {
    // Shown in Audio Setup so it is obvious which build the phone is running.
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'),
  },
});
