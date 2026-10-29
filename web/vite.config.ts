import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));

// a unique id per build — the app checks it to know when a new version is live
const BUILD_ID = String(Date.now());

export default defineConfig({
  plugins: [
    react(),
    { // write dist/version.json after the build so the running app can poll it
      name: "pumpai-version-stamp",
      apply: "build",
      closeBundle() { try { writeFileSync(resolve(ROOT, "dist/version.json"), JSON.stringify({ v: BUILD_ID })); } catch { /* ignore */ } },
    },
  ],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: { output: { manualChunks(id) {
      // charts only on the pages that draw them; framework + icons cached across releases; the rest splits per lazy page
      if (id.includes("node_modules/recharts") || id.includes("node_modules/d3-")) return "charts";
      if (id.includes("node_modules/lucide-react")) return "icons";
      if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return "react";
    } } },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:4000", "/webhooks": "http://localhost:4000" },
  },
});
