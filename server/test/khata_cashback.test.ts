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

  // parchi 50 L: 40 L pumped, 10 L baqi billed at rate (= 10×rate), but only PART handed as cash — the rest is Khareed
  const baqiValue = Math.round(10 * rate);
  const cashBack = baqiValue - 500;         // driver takes Rs 500 less than the baqi value
  const expectKhareed = baqiValue - cashBack; // = 500
  const sale = ok(await call("salesman", "POST", "/api/sales", {
    station_id: live.shift.station_id, product: "HSD", litres: 40, payment_method: "khata",
    customer_id: cust.id, slip_no: "KB-1", cash_back: cashBack, cash_back_litres: 10,
  }), "khata cash-back sale");
  assert.equal(sale.cash_back, cashBack, "cash_back (cash di) stored");
  assert.equal(sale.cash_back_litres, 10, "cash_back_litres stored");
  near(sale.khareed, expectKhareed, "khareed = baqi value − cash di");
  near(sale.amount, 40 * rate, "fuel amount = pumped litres only");
  near(sale.litres, 40, "sale litres = pumped (meter/stock)");

  // khata billed the whole slip: 40 L fuel + 10 L baqi value = 50×rate (regardless of the cash actually handed)
  const balAfter = db.get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance as number;
  near(balAfter - balBefore, 50 * rate, "khata debited the whole 50 L slip (fuel + baqi value)");
  // one khata_ledger line carries it, amount = 50×rate
  const kl = db.get("SELECT amount, litres, note FROM khata_ledger WHERE ref=?", `SALE-${sale.id}`)!;
  near(kl.amount, 50 * rate, "one khata line = 50×rate");
  near(kl.litres, 50, "slip litres on the khata line");
  // the Khareed profit lands in the ledger as income
  const { journal } = await import("../src/routes/ledger.js");
  const J = journal(t, "2000-01-01", new Date(Date.now() + 29 * 3600_000).toISOString().slice(0, 10));
  const khareedAcc = J.trial_balance.find((x: any) => x.account === "Khareed");
  assert.ok(khareedAcc, "Khareed income account exists in the ledger");
  near(-(khareedAcc!.balance as number), expectKhareed, "Khareed income = profit");

  // only 40 L left the tank (the cash-back is not fuel)
  const tankAfter = db.get("SELECT COALESCE(SUM(current_l),0) v FROM tanks t JOIN stations s ON s.id=t.station_id WHERE s.tenant_id=? AND t.product='HSD'", t)!.v as number;
  near(tankBefore - tankAfter, 40, "only pumped litres left the tank");

  // shift bag: cash-back shows as a cash-out and the expected cash drops by it
  const live2 = ok(await call("salesman", "GET", `/api/shifts/${shiftId}/live`), "live2");
  near(live2.summary.khata_cashback, cashBack, "shift khata_cashback bucket = cash handed");
  near(live2.summary.khareed, expectKhareed, "shift khareed (munafa) bucket");
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

test("poora parcha cash: no fuel pumped, whole slip billed to khata as cash, stock/meter untouched, tally holds", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cust = db.get("SELECT id, balance FROM customers WHERE tenant_id=? AND credit_limit > 0 ORDER BY credit_limit DESC LIMIT 1", t)!;
  db.run("UPDATE customers SET credit_limit=100000000 WHERE id=?", cust.id);
  const balBefore = db.get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance as number;
  const tankBefore = db.get("SELECT COALESCE(SUM(current_l),0) v FROM tanks tk JOIN stations s ON s.id=tk.station_id WHERE s.tenant_id=? AND tk.product='HSD'", t)!.v as number;
  const sh = db.get("SELECT id, station_id FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1") ?? ok(await call("salesman", "POST", "/api/shifts/open", {}), "open");
  const live = ok(await call("salesman", "GET", `/api/shifts/${sh.id}/live`), "live");
  const rate = live.prices.HSD as number;

  // parchi 50 L, nothing pumped: cash di = 50×rate − 500 (so Khareed 500); no litres/amount sent
  const baqiValue = Math.round(50 * rate);
  const cashBack = baqiValue - 500;
  const sale = ok(await call("salesman", "POST", "/api/sales", {
    station_id: live.shift.station_id, product: "HSD", payment_method: "khata", customer_id: cust.id,
    slip_no: "FC-1", cash_back: cashBack, cash_back_litres: 50,
  }), "full-cash parchi");
  near(sale.litres, 0, "no fuel pumped");
  near(sale.amount, 0, "no fuel revenue");
  near(sale.cash_back, cashBack, "cash di stored");
  near(sale.khareed, 500, "khareed = value − cash di");

  // khata billed the whole parchi (50 L × rate), stock/meter untouched
  const balAfter = db.get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance as number;
  near(balAfter - balBefore, baqiValue, "khata debited the whole parchi value");
  const tankAfter = db.get("SELECT COALESCE(SUM(current_l),0) v FROM tanks tk JOIN stations s ON s.id=tk.station_id WHERE s.tenant_id=? AND tk.product='HSD'", t)!.v as number;
  near(tankAfter, tankBefore, "no fuel left the tank");

  await tallyBooks("after poora parcha cash");
});

test("khata parchi against shop goods: full slip on khata, shop stock untouched, only the margin is Khareed, books tally", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cust = db.get("SELECT id, balance FROM customers WHERE tenant_id=? AND credit_limit > 0 ORDER BY credit_limit DESC LIMIT 1", t)!;
  db.run("UPDATE customers SET credit_limit=100000000 WHERE id=?", cust.id);
  const balBefore = db.get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance as number;
  const shopBefore = db.get("SELECT COALESCE(SUM(stock),0) v FROM shop_items WHERE tenant_id=?", t)!.v as number;
  const tankBefore = db.get("SELECT COALESCE(SUM(current_l),0) v FROM tanks tk JOIN stations s ON s.id=tk.station_id WHERE s.tenant_id=? AND tk.product='HSD'", t)!.v as number;
  const sh = db.get("SELECT id, station_id FROM shifts WHERE status='open' ORDER BY id DESC LIMIT 1") ?? ok(await call("salesman", "POST", "/api/shifts/open", {}), "open");
  const live = ok(await call("salesman", "GET", `/api/shifts/${sh.id}/live`), "live");
  const rate = live.prices.HSD as number;

  // parchi 50 L, nothing pumped: handed shop goods costing Rs 2,000; Khareed = full value − items cost
  const baqiValue = Math.round(50 * rate);
  const itemsCost = 2000;
  const sale = ok(await call("salesman", "POST", "/api/sales", {
    station_id: live.shift.station_id, product: "HSD", payment_method: "khata", customer_id: cust.id,
    slip_no: "SG-1", cash_back_litres: 50, items_cost: itemsCost, items_note: "2 L engine oil",
  }), "parchi against shop goods");
  near(sale.litres, 0, "no fuel pumped");
  near(sale.amount, 0, "no fuel revenue");
  near(sale.items_cost, itemsCost, "items cost stored");
  near(sale.cash_back, 0, "no cash handed");
  near(sale.khareed, baqiValue - itemsCost, "khareed = full value − items cost");

  // khata billed the whole parchi value; shop stock & fuel stock both untouched
  const balAfter = db.get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance as number;
  near(balAfter - balBefore, baqiValue, "khata debited the whole parchi value");
  near(db.get("SELECT COALESCE(SUM(stock),0) v FROM shop_items WHERE tenant_id=?", t)!.v as number, shopBefore, "shop stock untouched");
  near(db.get("SELECT COALESCE(SUM(current_l),0) v FROM tanks tk JOIN stations s ON s.id=tk.station_id WHERE s.tenant_id=? AND tk.product='HSD'", t)!.v as number, tankBefore, "fuel stock untouched");

  // the goods cost sits in its own off-P&L account; only the margin is Khareed income
  const { journal } = await import("../src/routes/ledger.js");
  const J = journal(t, "2000-01-01", new Date(Date.now() + 29 * 3600_000).toISOString().slice(0, 10));
  const items = J.trial_balance.find((x: any) => x.account === "Shop items given (khata)");
  assert.ok(items, "Shop items given (khata) account exists");
  near(-(items!.balance as number), itemsCost, "shop items account = goods cost");

  await tallyBooks("after parchi against shop goods");

  // undo reverses the whole slip
  ok(await call("salesman", "POST", `/api/sales/${sale.id}/undo`, {}), "undo");
  near(db.get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance as number, balBefore, "khata back");
  await tallyBooks("after undo (shop goods)");
  // fuel pumped AND shop goods against the rest of the parchi (the POS "saman" mode with a nozzle amount): both legs book
  const balMid = db.get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance as number;
  const mixed = ok(await call("salesman", "POST", "/api/sales", {
    station_id: live.shift.station_id, product: "HSD", payment_method: "khata", customer_id: cust.id, litres: 20,
    slip_no: "SG-2", cash_back_litres: 10, items_cost: 1000, items_note: "1 L oil",
  }), "fuel + shop goods");
  near(mixed.litres, 20, "nozzle litres kept"); near(mixed.amount, 20 * rate, "fuel revenue kept");
  near(mixed.items_cost, 1000); near(mixed.khareed, Math.round(10 * rate) - 1000, "khareed on the baqi part only");
  near((db.get("SELECT balance FROM customers WHERE id=?", cust.id)!.balance as number) - balMid, 20 * rate + Math.round(10 * rate), "khata billed fuel + baqi");
  await tallyBooks("fuel + shop goods");
});
