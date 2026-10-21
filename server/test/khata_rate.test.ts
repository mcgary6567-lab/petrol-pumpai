/** CEO-set special khata rate per customer: a khata fill bills at the customer's own rate (fixed or pump−X, capped at the
 *  pump rate), not the nozzle rate. Only the CEO/admin may set it, and the books still tally. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";
import { tallyBooks } from "./helpers/tally.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-krate-"));
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

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
  db.run("UPDATE shifts SET status='closed', closed_at=? WHERE status='open'", new Date().toISOString());
});
after(() => server?.close());

test("CEO special khata rate: fixed + pump−X bill at the customer's rate, capped at pump, CEO-only, tally holds", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cust = db.get("SELECT id, name FROM customers WHERE tenant_id=? AND credit_limit > 0 ORDER BY credit_limit DESC LIMIT 1", t)!;
  db.run("UPDATE customers SET credit_limit=100000000 WHERE id=?", cust.id);

  // only the CEO/admin may set a special rate
  assert.equal((await call("salesman", "POST", `/api/customers/${cust.id}/khata-rates`, { rates: { HSD: { mode: "fixed", value: 395 } } })).status, 403, "salesman blocked");

  // admin sets Diesel fixed 395 and Petrol pump−5
  const open = ok(await call("salesman", "POST", "/api/shifts/open", {}), "open");
  const live = ok(await call("salesman", "GET", `/api/shifts/${open.id}/live`), "live");
  const pumpHSD = live.prices.HSD as number, pumpPMG = live.prices.PMG as number;
  ok(await call("admin", "POST", `/api/customers/${cust.id}/khata-rates`, { rates: { HSD: { mode: "fixed", value: 395 }, PMG: { mode: "minus", value: 5 } } }), "set rates");

  // fixed: 10 L Diesel bills at 395 (capped at pump — 395 ≤ pump assumed; if pump < 395 it caps at pump)
  const cappedHSD = Math.min(pumpHSD, 395);
  const s1 = ok(await call("salesman", "POST", "/api/sales", { station_id: live.shift.station_id, product: "HSD", litres: 10, payment_method: "khata", customer_id: cust.id, slip_no: "R1" }), "diesel sale");
  near(s1.rate, cappedHSD, "diesel billed at fixed/capped rate");
  near(s1.amount, 10 * cappedHSD, "diesel amount at special rate");

  // pump−X: 10 L Petrol bills at pump−5
  const s2 = ok(await call("salesman", "POST", "/api/sales", { station_id: live.shift.station_id, product: "PMG", litres: 10, payment_method: "khata", customer_id: cust.id, slip_no: "R2" }), "petrol sale");
  near(s2.rate, pumpPMG - 5, "petrol billed at pump − 5");
  near(s2.amount, 10 * (pumpPMG - 5), "petrol amount at pump − 5");

  // a customer WITHOUT a special rate still bills at the pump rate
  const other = db.get("SELECT id FROM customers WHERE tenant_id=? AND credit_limit > 0 AND id<>? ORDER BY id LIMIT 1", t, cust.id)!;
  db.run("UPDATE customers SET credit_limit=100000000 WHERE id=?", other.id);
  const s3 = ok(await call("salesman", "POST", "/api/sales", { station_id: live.shift.station_id, product: "HSD", litres: 5, payment_method: "khata", customer_id: other.id, slip_no: "R3" }), "other sale");
  near(s3.rate, pumpHSD, "no special rate → pump rate");

  // clearing a product's rate (value 0) reverts it to the pump rate
  ok(await call("admin", "POST", `/api/customers/${cust.id}/khata-rates`, { rates: { HSD: null } }), "clear HSD");
  const s4 = ok(await call("salesman", "POST", "/api/sales", { station_id: live.shift.station_id, product: "HSD", litres: 5, payment_method: "khata", customer_id: cust.id, slip_no: "R4" }), "diesel after clear");
  near(s4.rate, pumpHSD, "after clear → pump rate");

  await tallyBooks("after special-rate khata sales");
});
