import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * Native modules and Electron itself cannot be bundled — they must be
 * marked external. Pure-JS workspace deps (@multizen/*) get bundled so
 * we can ship .ts source files without a separate build step in dev.
 */
const NATIVE_EXTERNALS = [
  "electron",
  /^node:/,
  "better-sqlite3",
  "chrome-remote-interface",
  "ws",
  "https-proxy-agent",
  "socks-proxy-agent",
  "proxy-chain",
  "extract-zip",
  "@modelcontextprotocol/sdk",
  "uuid",
  "zod",
  // Camoufox (Firefox) engine. These are large node packages that VENDOR their
  // own dependencies: playwright-core bundles `chromium-bidi` internally (its
  // package.json deps are empty), and camoufox-js pulls native impit +
  // better-sqlite3@13. Bundling them breaks their internal bare imports (rollup
  // emits an unresolvable `import 'chromium-bidi'`), so they MUST load from
  // node_modules at runtime. Regexes so subpath imports are external too
  // (FirefoxBrowserDriver imports `camoufox-js`; CamoufoxBootstrap dynamically
  // imports `camoufox-js/dist/pkgman.js`).
  /^playwright-core(\/|$)/,
  /^camoufox-js(\/|$)/,
  "chromium-bidi",
];

const WORKSPACE_DEPENDENCIES = [
  "@multizen/cdp-driver",
  "@multizen/kopia-adapter",
  "@multizen/mcp-gateway",
  "@multizen/mcp-server",
  "@multizen/profile-manager",
  "@multizen/s3-coordinator",
  "@multizen/settings-store",
  "@multizen/sync-core",
  "@multizen/types",
];

export default defineConfig({
  main: {
    resolve: {
      // Packaging removes workspace symlinks from node_modules. Resolve source
      // directly so subsequent builds and dev runs still bundle these packages.
      alias: WORKSPACE_DEPENDENCIES.map((name) => ({
        find: name,
        replacement: resolve(
          __dirname,
          "../../packages",
          name.slice("@multizen/".length),
          "src/index.ts",
        ),
      })),
    },
    build: {
      // Workspace packages ship TypeScript source, so Electron cannot load
      // them as external runtime dependencies. Bundle them into the main entry.
      externalizeDeps: { exclude: WORKSPACE_DEPENDENCIES },
      rollupOptions: {
        external: NATIVE_EXTERNALS,
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        external: ["electron"],
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    // file:// URLs in packaged Electron need relative asset paths.
    // Default base "/" resolves /logo.png to filesystem root and 404s
    // the bundled image. Switching to "./" produces ./logo.png which
    // Vite + Electron resolve correctly in both dev and production.
    base: "./",
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/renderer/index.html") },
      },
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
      },
    },
  },
});
