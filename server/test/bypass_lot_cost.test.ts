/** Own-tank unloads are costed and taken from the lots they really come from (that tanker first), not the drifting pooled average. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-byplot-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server;
let base = "";
let db: typeof import("../src/db.js");
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, msg: string) => { assert.equal(r.status, 200, `${msg}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 0.05, `${msg ?? ""} ${a} ≈ ${b}`);
const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "wholesale", "salesman"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => server?.close());
const books = async () => { const b = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(b.ok, true, JSON.stringify(b.checks.filter((c: any) => !c.ok))); };
const dayAgo = (n: number) => new Date(Date.now() + 5 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);

test("unload from tanker 9550 takes that tanker's lot at its own rate; re-cost fixes one booked at a wrong rate", async () => {
  const tank = db.get("SELECT tk.* FROM tanks tk JOIN stations s ON s.id=tk.station_id WHERE s.tenant_id=1 AND tk.product='PMG' ORDER BY tk.id LIMIT 1");
  db.run("UPDATE tanks SET capacity_l = current_l + 50000 WHERE id=?", tank.id);
  const sup = db.get("SELECT id FROM suppliers WHERE tenant_id=1 ORDER BY id LIMIT 1").id;
  const cli = db.get("SELECT id FROM wholesale_clients WHERE tenant_id=1 ORDER BY id LIMIT 1").id;
  db.run("UPDATE wholesale_clients SET credit_limit = credit_limit + 50000000 WHERE id=?", cli);
  // an older lot on another tanker at 400, then tanker 9550's lot at 340 with 5,000 L dropped to a client
  ok(await call("admin", "POST", "/api/bypass/deliveries", { station_id: tank.station_id, txn_date: dayAgo(3), vehicle_no: "LES-1", purchases: [{ supplier_id: sup, product: "PMG", litres: 5000, cost_rate: 400, ref: "OLD" }] }), "old lot");
  ok(await call("admin", "POST", "/api/bypass/deliveries", { station_id: tank.station_id, txn_date: dayAgo(1), vehicle_no: "9550", purchases: [{ supplier_id: sup, product: "PMG", litres: 10000, cost_rate: 340, ref: "NEW" }], drops: [{ client_id: cli, product: "PMG", litres: 5000, rate: 360 }] }), "9550 lot + drop");
  // the pooled average drifts (an out booked at a lower cost than its lot) — the old way would cost the unload at it
  db.run("UPDATE bypass_drops SET cost_amount = cost_amount - 900000, unit_cost = (cost_amount - 900000) / litres WHERE tenant_id=1 AND product='PMG' AND tank_id IS NULL");
  const pooled = ok(await call("admin", "GET", "/api/bypass/stock"), "stock").by_product.find((x: any) => x.product === "PMG").avg_cost;
  assert.ok(pooled > 400, `pooled average drifted up (${pooled})`);

  // 4,000 L unloaded from 9550 (named only in the note, like the officers do): 9550's lot, at 340
  const q = ok(await call("admin", "GET", "/api/bypass/to-tank/quote?product=PMG&litres=4000&tanker_no=9550"), "quote");
  near(q.unit, 340, "quote at the lot rate");
  const u = ok(await call("admin", "POST", "/api/bypass/to-tank", { product: "PMG", litres: 4000, tank_id: tank.id, note: "9550", txn_date: dayAgo(0) }), "unload");
  near(u.unit_cost, 340, "costed at 9550's bill rate, not the drifted average");
  const lots = ok(await call("admin", "GET", "/api/bypass/lots"), "lots").fuels.find((f: any) => f.product === "PMG").lots;
  const newLot = lots.find((l: any) => l.ref === "NEW"), oldLot = lots.find((l: any) => l.ref === "OLD");
  near(newLot?.left ?? 0, 1000, "9550's lot: 10,000 − 5,000 drop − 4,000 unload");
  near(oldLot?.left ?? 0, 5000, "the other tanker's lot is untouched");

  // one booked at a wrong rate (as before the fix) is set right with one click
  const wrong = ok(await call("admin", "POST", "/api/bypass/to-tank", { product: "PMG", litres: 1000, tank_id: tank.id, amount: 567440, tanker_no: "9550" }), "wrong-rate unload");
  near(wrong.unit_cost, 567.44);
  const fixed = ok(await call("admin", "POST", `/api/bypass/to-tank/${wrong.id}/recost`, {}), "recost");
  near(fixed.unit_cost, 340, "re-costed at the lot rate");
  near(fixed.before_cost, 567440);
  const reg = db.get("SELECT purchase_rate FROM deliveries WHERE bypass_drop_id=?", fixed.id);
  near(reg.purchase_rate, 340, "the pump's stock register follows");
  await books();
});
