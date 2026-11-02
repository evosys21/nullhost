import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// The renderer alone in a normal browser, with the in-memory mock API from
// src/renderer/mock.ts (used whenever window.nullhost is missing). For UI review only.
export default defineConfig({
  root: "src/renderer",
  plugins: [vue()],
  server: { port: 5174, strictPort: true },
});
