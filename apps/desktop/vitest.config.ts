import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Renderer test configuration.
 *
 * These tests exercise React components against the `window.multizen` preload
 * contract, NOT the Electron main process: main-process behaviour is covered by
 * the node:test suites under `src/main`. Keeping the two runners separate means a
 * renderer test can never accidentally import Electron or touch the real
 * filesystem.
 *
 * `root` mirrors the renderer root from electron.vite.config.ts so public assets
 * (e.g. the `/logo.png` the Cube atom imports) resolve the same way they do in
 * the app, and the `@` alias behaves identically.
 */
export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  plugins: [react()],
  resolve: {
    alias: { "@": resolve(__dirname, "src/renderer/src") },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: [resolve(__dirname, "src/renderer/src/__tests__/setup.ts")],
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    restoreMocks: true,
  },
});
