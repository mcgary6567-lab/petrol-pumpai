/** Installed-app icons: a pump's logo becomes square PNG icons of the asked size (any + maskable); no logo → the generic icon. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-icons-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server; let base = ""; let token = "";
const pngSize = (buf: Buffer) => (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? [buf.readUInt32BE(16), buf.readUInt32BE(20)] : null);

before(async () => {
  const { app } = await import("../src/index.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@pumpai.pk", password: "demo1234" }) });
  token = (await r.json()).token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("logo → 192/512/180/64 square PNGs for the manifest and iOS; manifest lists them; no logo → generic icon", async () => {
  const slug = (await (await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${token}` } })).json()).tenant.slug as string;
  assert.ok(slug, "demo pump has a slug");
  // before any logo: generic icon (a redirect to /icon-192.png)
  const r0 = await fetch(`${base}/branding/icon-192.png?pump=${slug}`, { redirect: "manual" });
  assert.equal(r0.status, 302, "no logo → generic");
  // upload a logo (a non-square JPEG-ish PNG is fine: it is contained on a square canvas)
  const png = fs.readFileSync(path.join(process.cwd(), "..", "web", "public", "icon-512.png"));
  const put = await fetch(`${base}/api/business`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ logo: `data:image/png;base64,${png.toString("base64")}` }) });
  assert.equal(put.status, 200, "logo saved");
  for (const [q, w] of [["icon-192.png?pump=" + slug, 192], ["icon-512.png?pump=" + slug + "&maskable=1", 512], ["icon-180.png?pump=" + slug, 180], ["icon-64.png?pump=" + slug, 64]] as const) {
    const r = await fetch(`${base}/branding/${q}`);
    assert.equal(r.status, 200, q); assert.equal(r.headers.get("content-type"), "image/png", q);
    assert.deepEqual(pngSize(Buffer.from(await r.arrayBuffer())), [w, w], `${q} is ${w}×${w}`);
  }
  const m = await (await fetch(`${base}/manifest.webmanifest?pump=${slug}`)).json();
  assert.ok(m.icons.some((i: any) => /\/branding\/icon-512\.png\?v=\d+&maskable=1/.test(i.src) && i.purpose === "maskable"), "maskable icon from the logo");
  assert.ok(m.icons.some((i: any) => /\/branding\/icon-192\.png\?v=\d+$/.test(i.src) && i.sizes === "192x192"), "192 icon from the logo");
  assert.equal(m.start_url, `/p/${slug}`);
  // by logo id too (what the manifest uses), and a bad id falls back
  const v = m.icons[0].src.match(/v=(\d+)/)![1];
  assert.deepEqual(pngSize(Buffer.from(await (await fetch(`${base}/branding/icon-192.png?v=${v}`)).arrayBuffer())), [192, 192]);
  assert.equal((await fetch(`${base}/branding/icon-192.png?v=999999`, { redirect: "manual" })).status, 302);
});
