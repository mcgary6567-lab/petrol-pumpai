/** A quantity typed into an item's Unit box is refused; rows already saved that way heal to 'pc' on boot. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-shopunit-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";
let server: Server; let base = ""; let db: typeof import("../src/db.js"); let admin = "";
async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", authorization: `Bearer ${admin}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  admin = (await (await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "admin@pumpai.pk", password: "demo1234" }) })).json() as any).token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("unit must be a word; a numeric unit is refused with a hint; the edit-form stock count adjusts stock", async () => {
  const st = (await call("GET", "/api/stations")).data[0];
  const it = (await call("POST", "/api/shop/items", { station_id: st.id, name: "Unit Test Filter", category: "filter", cost: 480, price: 500 })).data;
  const bad = await call("PATCH", `/api/shop/items/${it.id}`, { unit: "10" });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /Stock in/);
  assert.equal((await call("PATCH", `/api/shop/items/${it.id}`, { unit: "ltr" })).status, 200);
  const adj = await call("POST", `/api/shop/items/${it.id}/adjust`, { counted: 10, reason: "Stock set on edit form" });
  assert.equal(adj.status, 200);
  const items = (await call("GET", `/api/shop/items?station_id=${st.id}`)).data as any[];
  const row = items.find((x) => x.id === it.id);
  assert.equal(row.stock, 10); assert.equal(row.unit, "ltr");
  // rows saved with a numeric unit before this fix heal on boot (same statement the migration runs)
  db.run("UPDATE shop_items SET unit='10' WHERE id=?", it.id);
  db.db.exec("UPDATE shop_items SET unit='pc' WHERE TRIM(COALESCE(unit,''))='' OR unit NOT GLOB '*[A-Za-z]*'");
  assert.equal(db.get("SELECT unit FROM shop_items WHERE id=?", it.id).unit, "pc");
});
