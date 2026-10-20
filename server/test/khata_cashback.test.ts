/** Khata slip "baqi cash": the parchi bills more litres than the nozzle gave and the driver takes the rest as cash from
 *  the bag. The khata is billed the whole slip, only the pumped litres hit the meter/stock, the cash leaves the drawer,
 *  the CEO is alerted — and every book still ties to the rupee. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";
import { tallyBooks } from "./helpers/tally.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-kcash-"));
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
  for (const who of ["admin", "salesman"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
  db.run("UPDATE shifts SET status='closed', closed_at=? WHERE status='open'", new Date().toISOString());
});
after(() => server?.close());

test("khata slip cash-back: full slip on khata, only pumped litres on the meter, cash out of the bag, CEO alerted, books tally", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  // a khata customer with room for the whole slip
  const cust = db.get("SELECT id, name, balance FROM customers WHERE tenant_id=? AND credit_limit > 0 ORDER BY credit_limit DESC LIMIT 1", t)!;
  db.run("UPDATE customers SET credit_limit=100000000 WHERE id=?", cust.id);
  const balBefore = db.get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance as number;
  const tankBefore = db.get("SELECT COALESCE(SUM(current_l),0) v FROM tanks t JOIN stations s ON s.id=t.station_id WHERE s.tenant_id=? AND t.product='HSD'", t)!.v as number;

  const open = ok(await call("salesman", "POST", "/api/shifts/open", {}), "open");
  const shiftId = open.id;
  const live = ok(await call("salesman", "GET", `/api/shifts/${shiftId}/live`), "live");
  const rate = live.prices.HSD as number;

  // parchi 50 L: 40 L pumped, 10 L (= 10×rate) handed back as cash
  const cashBack = Math.round(10 * rate);
  const sale = ok(await call("salesman", "POST", "/api/sales", {
    station_id: live.shift.station_id, product: "HSD", litres: 40, payment_method: "khata",
    customer_id: cust.id, slip_no: "KB-1", cash_back: cashBack, cash_back_litres: 10,
  }), "khata cash-back sale");
  assert.equal(sale.cash_back, cashBack, "cash_back stored");
  assert.equal(sale.cash_back_litres, 10, "cash_back_litres stored");
  near(sale.amount, 40 * rate, "fuel amount = pumped litres only");
  near(sale.litres, 40, "sale litres = pumped (meter/stock)");

  // khata billed the whole slip: 40 L fuel + 10 L cash = 50×rate
  const balAfter = db.get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance as number;
  near(balAfter - balBefore, 50 * rate, "khata debited the whole 50 L slip");
  // one khata_ledger line carries it, amount = 50×rate
  const kl = db.get("SELECT amount, litres, note FROM khata_ledger WHERE ref=?", `SALE-${sale.id}`)!;
  near(kl.amount, 50 * rate, "one khata line = 50×rate");
  near(kl.litres, 50, "slip litres on the khata line");

  // only 40 L left the tank (the cash-back is not fuel)
  const tankAfter = db.get("SELECT COALESCE(SUM(current_l),0) v FROM tanks t JOIN stations s ON s.id=t.station_id WHERE s.tenant_id=? AND t.product='HSD'", t)!.v as number;
  near(tankBefore - tankAfter, 40, "only pumped litres left the tank");

  // shift bag: cash-back shows as a cash-out and the expected cash drops by it
  const live2 = ok(await call("salesman", "GET", `/api/shifts/${shiftId}/live`), "live2");
  near(live2.summary.khata_cashback, cashBack, "shift khata_cashback bucket");
  // per-fuel breakdown: khata litres are the PUMPED 40, so no false over-bill (khata_l + cash_l ≤ meter)
  const hsd = live2.fuels?.find?.((f: any) => f.product === "HSD");
  if (hsd) near(hsd.khata_l, 40, "khata litres on the meter = pumped only");

  // CEO got an instant alert
  const alert = db.get("SELECT title, body FROM alerts WHERE tenant_id=? AND type='khata_cashback' ORDER BY id DESC LIMIT 1", t);
  assert.ok(alert, "CEO alert raised");
  assert.match(alert!.title as string, /baqi-cash/i);

  // every book ties to the rupee
  await tallyBooks("after khata cash-back");

  // undo reverses the whole slip and the cash leg
  ok(await call("salesman", "POST", `/api/sales/${sale.id}/undo`, {}), "undo");
  const balUndo = db.get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance as number;
  near(balUndo, balBefore, "khata back to where it was");
  const tankUndo = db.get("SELECT COALESCE(SUM(current_l),0) v FROM tanks t JOIN stations s ON s.id=t.station_id WHERE s.tenant_id=? AND t.product='HSD'", t)!.v as number;
  near(tankUndo, tankBefore, "stock back");
  await tallyBooks("after undo");
});
