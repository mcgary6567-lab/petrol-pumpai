/** Go-live fuel cost: opening litres × purchase rate → "Fuel stock (go-live)" in the ledger, cost per litre before the first tanker, profit = margin only. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-fuelcost-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server; let base = ""; let db: typeof import("../src/db.js"); let ledger: typeof import("../src/routes/ledger.js"); let fc: typeof import("../src/fuelCost.js");
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, m?: string) => assert.ok(Math.abs(a - b) < 0.6, `${m ?? ""} ${a} ≈ ${b}`);
const tb = (acct: string) => ledger.journal(1, "2000-01-01", "2100-01-01").trial_balance.find((x: any) => x.account === acct)?.balance ?? 0;

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js"); ledger = await import("../src/routes/ledger.js"); fc = await import("../src/fuelCost.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "salesman"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("opening fuel rate books Fuel stock (go-live), gives the cost per litre, follows the litres, and the books stay balanced", async () => {
  // a fuel nobody has bought yet in this book: strip the demo's HOBC purchases so the opening rate is the only cost source
  const P = "HOBC";
  db.run("DELETE FROM supplier_txns WHERE tenant_id=1 AND product=?", P);
  const tanks = db.all("SELECT tk.id, tk.capacity_l FROM tanks tk JOIN stations s ON s.id=tk.station_id WHERE s.tenant_id=1 AND tk.product=? AND COALESCE(tk.active,1)=1", P) as any[];
  assert.ok(tanks.length >= 1, "an HOBC tank");
  assert.equal(fc.fuelCostPerL(1, P), null, "no purchase, no opening → cost unknown");

  // opening litres: 3,000 L in the first tank, 0 in the rest
  for (const [i, tk] of tanks.entries()) ok(await call("admin", "POST", "/api/opening/stock", { tank_id: tk.id, litres: i === 0 ? 3000 : 0 }), "opening litres");
  const o = ok(await call("admin", "GET", "/api/opening"), "opening state");
  const fv = o.fuel_values.find((f: any) => f.product === P);
  near(fv.litres_now, 3000, "litres in tanks"); assert.equal(fv.opening, null); assert.equal(fv.last_purchase_rate, null);
  const before = tb("Fuel stock (go-live)");

  // the rate it was bought at → value booked
  const r1 = ok(await call("admin", "POST", "/api/opening/fuel-rates", { rows: [{ product: P, rate: 280 }] }), "set rate");
  const v1 = r1.fuel_values.find((f: any) => f.product === P).opening;
  near(v1.litres, 3000); assert.equal(v1.rate, 280); near(v1.amount, 840000, "3000 × 280");
  near(tb("Fuel stock (go-live)") - before, 840000, "ledger carries the opening value");
  near(fc.fuelCostPerL(1, P)!, 280, "cost per litre = opening rate");

  // report: avg cost known, profit on a sale is margin only
  const rep = ok(await call("admin", "GET", "/api/reports"), "report");
  const row = rep.stock.products.find((p: any) => p.product === P);
  near(row.avg_cost, 280, "report avg_cost");

  // the litres change → value follows at the same rate; the old row is voided, never edited
  ok(await call("admin", "POST", "/api/opening/stock", { tank_id: tanks[0].id, litres: 2500 }), "re-enter litres");
  const rows = db.all("SELECT * FROM fuel_opening_values WHERE tenant_id=1 AND product=? ORDER BY id", P) as any[];
  assert.equal(rows.length, 2); assert.equal(rows[0].voided, 1); assert.equal(rows[1].voided, 0); near(rows[1].amount, 700000, "2500 × 280");
  near(tb("Fuel stock (go-live)") - before, 700000, "ledger follows the new value");

  // weighted with a purchase: 1,000 L bought at 300 → (2500×280 + 1000×300) / 3500
  const sup = db.get("SELECT id FROM suppliers WHERE tenant_id=1 AND active=1 LIMIT 1") as any;
  db.run("INSERT INTO supplier_txns (tenant_id,supplier_id,type,product,litres,rate,amount,created_by,txn_date,created_at) VALUES (1,?,'purchase',?,1000,300,300000,'t',?,?)", sup.id, P, new Date().toISOString(), new Date().toISOString());
  near(fc.fuelCostPerL(1, P)!, (2500 * 280 + 1000 * 300) / 3500, "weighted average with the purchase");

  // go-live checklist knows
  const gl = ok(await call("admin", "GET", "/api/golive"), "golive");
  const item = gl.items.find((i: any) => i.key === "fuel_cost");
  assert.ok(item, "fuel_cost item"); assert.ok(item.fuels.some((f: any) => f.product === P && f.rate === 280));

  // rate 0 clears the value (voids the row) and the ledger drops it again
  ok(await call("admin", "POST", "/api/opening/fuel-rates", { rows: [{ product: P, rate: 0 }] }), "clear rate");
  assert.equal(db.get("SELECT COUNT(*) n FROM fuel_opening_values WHERE tenant_id=1 AND product=? AND voided=0", P).n, 0);
  near(tb("Fuel stock (go-live)") - before, 0, "ledger back to before");

  // nothing fell out of balance
  const chk = ok(await call("admin", "GET", "/api/books/check"), "books check");
  const bad = chk.checks.filter((r: any) => !r.ok && !r.advisory);
  assert.deepEqual(bad.map((r: any) => `${r.label}: ${r.diff}`), [], "books tally");
});
