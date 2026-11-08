/**
 * The marketing site as plain files (for petrolpump.site on ordinary hosting, while the app runs on app.petrolpump.site):
 * index.html = the sales page, plus the pictures it shows. Run after `npm run build`:
 *   PUBLIC_URL=https://app.petrolpump.site SITE_URL=https://petrolpump.site SALES_PHONE=923001234567 node deploy/site/build.mjs [outDir=dist-site]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const out = path.resolve(root, process.argv[2] ?? "dist-site");
process.env.SAAS_MODE ??= "1";
if (!process.env.PUBLIC_URL || !process.env.SITE_URL) { console.error("Set PUBLIC_URL (the app) and SITE_URL (this site)"); process.exit(1); }
const { sellPage } = await import(pathToFileURL(path.join(root, "server/dist/sell.js")).href);
const html = sellPage();
const web = path.join(root, "web/dist");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), html);
// old links to /sell land on the same page
fs.mkdirSync(path.join(out, "sell"), { recursive: true });
fs.writeFileSync(path.join(out, "sell/index.html"), '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><link rel="canonical" href="/"><a href="/">Petrol PumpAI</a>\n');
// every local file the page uses: icons, the social card, the screenshots
const used = new Set(["og.jpg"]);
for (const m of html.matchAll(/(?:src|href|content)="\/?([a-z0-9][^"?#:]*\.(?:jpg|jpeg|png|webp|svg|ico))/gi)) used.add(m[1]);
for (const m of html.matchAll(/["'(](shots\/[^"')?#]+)/g)) used.add(m[1]);
for (const f of used) {
  const src = path.join(web, f);
  if (!fs.existsSync(src)) { console.warn(`missing ${f}`); continue; }
  fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
  fs.copyFileSync(src, path.join(out, f));
}
fs.writeFileSync(path.join(out, "robots.txt"), `User-agent: *\nAllow: /\nSitemap: ${process.env.SITE_URL.replace(/\/+$/, "")}/sitemap.xml\n`);
fs.writeFileSync(path.join(out, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${process.env.SITE_URL.replace(/\/+$/, "")}/</loc></url></urlset>\n`);
console.log(`Site ready in ${path.relative(root, out)}/ — ${used.size} files + index.html`);
