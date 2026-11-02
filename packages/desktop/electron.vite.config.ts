import vue from "@vitejs/plugin-vue";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

// Default entries: src/main/index.ts, src/preload/index.ts, src/renderer/index.html.
// @nullhost/core is TypeScript source in the workspace, so it is bundled, not externalised.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@nullhost/core"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    plugins: [vue()],
  },
});
