/**
 * Assemble the Hostinger build (run after `npm run build` at the repo root): a folder with everything the live app needs
 * and nothing it does not — no TypeScript, no tests, no dev tools — so the shared host only runs `npm install` and starts.
 *   node deploy/hostinger/build.mjs [outDir=dist-hostinger]
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const out = path.resolve(root, process.argv[2] ?? "dist-hostinger");
const need = (p) => { if (!fs.existsSync(path.join(root, p))) { console.error(`missing ${p} — run "npm run build" first`); process.exit(1); } };
need("server/dist/index.js"); need("web/dist/index.html");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(root, "server/dist"), path.join(out, "server/dist"), { recursive: true });
fs.cpSync(path.join(root, "web/dist"), path.join(out, "web/dist"), { recursive: true });
fs.copyFileSync(path.join(root, "deploy/hostinger/app.cjs"), path.join(out, "app.js")); // CommonJS (no "type": "module" at the root below)
fs.copyFileSync(path.join(root, "HOSTINGER.md"), path.join(out, "HOSTINGER.md"));

const server = JSON.parse(fs.readFileSync(path.join(root, "server/package.json"), "utf8"));
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
fs.writeFileSync(path.join(out, "server/package.json"), JSON.stringify({ name: "pumpai-server", private: true, type: "module" }, null, 2) + "\n");
fs.writeFileSync(path.join(out, "package.json"), JSON.stringify({
  name: "pumpai-hostinger", private: true, version: rootPkg.version, // CommonJS root: app.js loads with require() too; server/ is ESM via its own package.json
  description: "Petrol PumpAI — ready-built for Hostinger Node.js hosting (entry file: app.js). Built from main; do not edit here.",
  main: "app.js",
  scripts: { start: "node app.js", build: "echo already built" },
  engines: { node: "22.x" },
  dependencies: server.dependencies,
}, null, 2) + "\n");
fs.writeFileSync(path.join(out, ".gitignore"), "node_modules/\n.env\n");
console.log(`Hostinger build ready in ${path.relative(root, out)}/`);
