// Keep the previous builds' page scripts next to the new ones for a few updates.
//
// A phone or tablet that had the app open during an update still runs the old version; when it opens a page it asks
// for that version's script (/assets/Page-<old hash>.js). If the new build no longer has it, that page cannot open.
// So each build carries over the files of the last few builds (never overwriting a new file). A list in
// assets/.kept.json counts how many builds ago each old file was made; after KEEP builds it is dropped.
//
// usage: node deploy/hostinger/keep-old-assets.mjs <previous-build-assets-dir> <new-build-assets-dir>
import fs from "node:fs";
import path from "node:path";

const KEEP = 5;
const [prev, next] = process.argv.slice(2);
if (!prev || !next || !fs.existsSync(prev) || !fs.existsSync(next)) { console.log("[keep-old-assets] nothing to carry"); process.exit(0); }
let kept = {};
try { kept = JSON.parse(fs.readFileSync(path.join(prev, ".kept.json"), "utf8")); } catch { /* first time */ }
const now = new Set(fs.readdirSync(next));
const out = {};
let carried = 0;
for (const f of fs.readdirSync(prev)) {
  if (f.startsWith(".") || now.has(f)) continue;
  const age = (kept[f] ?? 0) + 1;
  if (age > KEEP) continue;
  fs.copyFileSync(path.join(prev, f), path.join(next, f));
  out[f] = age; carried++;
}
fs.writeFileSync(path.join(next, ".kept.json"), JSON.stringify(out));
console.log(`[keep-old-assets] carried ${carried} file(s) from earlier builds`);
