/** A fuel with no known purchase cost is costed at what it actually sold for (zero margin) — never at today's pump price,
 *  which after a price change inside the period would invent a profit or a loss. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-costassumed-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.SAAS_MODE = "1";
process.env.PUBLIC_URL = "http://localhost:9999";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";
let server: Server; let base = "";
async function call(token: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, m?: string) => assert.ok(Math.abs(a - b) < 1.5, `${m ?? ""} ${a} ≈ ${b}`);
before(async () => {
  const { app } = await import("../src/index.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("no purchase rate + a price rise inside the month → gross profit on that fuel is 0, flagged; a fuel with a rate keeps its real margin", async () => {
  const s = ok(await call("", "POST", "/api/signup", { business: { name: "Haroon Case Pump", owner_name: "Owner", owner_phone: "03001112233" }, admin: { name: "CEO", email: "ceo-cost@test.pk", password: "ceo-pass-123", pin: "1234" },
    stations: [{ name: "Main", tanks: [{ name: "T1", product: "PMG", capacity_l: 20000, current_l: 13000, nozzles: 2 }, { name: "T2", product: "HSD", capacity_l: 20000, current_l: 8000, nozzles: 2 }] }], prices: { PMG: 384, HSD: 398 } }), "signup").token;
  // diesel has an opening purchase rate, petrol has none (like the real pump)
  ok(await call(s, "POST", "/api/opening/fuel-rates", { rows: [{ product: "HSD", rate: 388.7 }] }), "diesel rate");
  const st = ok(await call(s, "GET", "/api/stations"), "stations")[0];
  // sales at the old prices
  ok(await call(s, "POST", "/api/sales", { station_id: st.id, product: "PMG", litres: 1000, payment_method: "cash" }), "petrol sale");
  ok(await call(s, "POST", "/api/sales", { station_id: st.id, product: "HSD", litres: 100, payment_method: "cash" }), "diesel sale");
  // the government raises prices mid-month
  ok(await call(s, "POST", "/api/prices", { prices: { PMG: 390, HSD: 402 }, broadcast: false }), "price rise");
  ok(await call(s, "POST", "/api/sales", { station_id: st.id, product: "PMG", litres: 500, payment_method: "cash" }), "petrol sale at new price");
  const month = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 7);
  const pl = ok(await call(s, "GET", `/api/analysis/pl?month=${month}`), "pnl").pl;
  const m = ok(await call(s, "GET", `/api/analysis/margins?month=${month}`), "margins");
  const pmg = m.products.find((x: any) => x.product === "PMG"), hsd = m.products.find((x: any) => x.product === "HSD");
  assert.equal(pmg.cost_assumed, true, "petrol flagged"); assert.equal(hsd.cost_assumed, false);
  near(pmg.profit, 0, "petrol profit assumed 0, not a loss"); near(pmg.avg_cost, pmg.avg_sale_rate, "petrol cost = its own sale rate");
  near(hsd.profit, (398 - 388.7) * 100, "diesel real margin");
  assert.deepEqual(pl.cost_assumed, ["Petrol (Super)"]); assert.ok(pl.cost_note);
  // P&L: cost of fuel sold = petrol revenue (zero margin) + diesel litres × 388.7
  const petrolRev = 1000 * 384 + 500 * 390;
  near(pl.cost_of_sales.fuel, petrolRev + 100 * 388.7, "cost of fuel sold");
  near(pl.gross_profit, (398 - 388.7) * 100, "gross = diesel margin only");
  assert.ok(pl.gross_profit > 0, "never a fake loss");
  // once the owner enters the petrol rate, the real margin appears everywhere
  ok(await call(s, "POST", "/api/opening/fuel-rates", { rows: [{ product: "PMG", rate: 376 }] }), "petrol rate");
  const pl2 = ok(await call(s, "GET", `/api/analysis/pl?month=${month}`), "pnl2").pl;
  assert.deepEqual(pl2.cost_assumed, []);
  near(pl2.cost_of_sales.fuel, 1500 * 376 + 100 * 388.7, "real costs");
});
