/** Wholesale entries are findable and reversible: IDs for every entry, own-tank unload vouchers, clear full-tank refusal, cascade reversal. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-shoprate-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server; let base = ""; let db: typeof import("../src/db.js");
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, m?: string) => assert.ok(Math.abs(a - b) < 0.05, `${m ?? ""} ${a} ≈ ${b}`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const books = async () => { const b = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(b.ok, true, JSON.stringify(b.checks.filter((c: any) => !c.ok))); };
const cashNow = async () => ok(await call("admin", "GET", "/api/cash"), "cash").cash_in_hand as number;
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman", "wholesale"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("a shop sale can carry its own rate per line: above or below the list price, even below cost — the books follow and the owner is told of a loss", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const i = db.get("SELECT * FROM shop_items WHERE tenant_id=? AND active=1 AND stock>=5 AND cost>0 AND price>cost ORDER BY id LIMIT 1", t)!;
  const sell = (lines: any[]) => call("admin", "POST", "/api/shop/sales", { station_id: i.station_id, payment_method: "cash", lines });
  const cash0 = await cashNow();
  // list price when no rate is typed
  const a = ok(await sell([{ item_id: i.id, qty: 1 }]), "list"); near(a.total, i.price);
  // bargained up, and sold at a loss
  const up = ok(await sell([{ item_id: i.id, qty: 2, price: i.price + 50 }]), "up"); near(up.total, 2 * (i.price + 50)); near(up.lines[0].price, i.price + 50);
  const alerts0 = db.get("SELECT COUNT(*) n FROM alerts WHERE type='shop_below_cost'")!.n as number;
  const low = ok(await sell([{ item_id: i.id, qty: 1, price: i.cost - 10 }]), "loss"); near(low.total, i.cost - 10); near(low.cost_total, i.cost);
  assert.equal(db.get("SELECT COUNT(*) n FROM alerts WHERE type='shop_below_cost'")!.n, alerts0 + 1);
  assert.equal((await sell([{ item_id: i.id, qty: 1, price: 0 }])).status, 400);
  assert.equal(db.get("SELECT price FROM shop_items WHERE id=?", i.id)!.price, i.price, "the list price itself is not changed");
  near(await cashNow(), cash0 + a.total + up.total + low.total, "cash follows what was really charged");
  await books();
});
