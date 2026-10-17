import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Relative base so the build works from a root domain
// (e.g. galaxstr.pages.dev) as well as from a subpath, with no
// config changes needed.
export default defineConfig({
  base: './',
  plugins: [vue()]
})
