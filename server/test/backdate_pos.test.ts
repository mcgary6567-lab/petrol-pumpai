/** Three field fixes: (1) a manager's back-dated POS entry is priced at THAT day's board rate, (2) a khata customer's rate
 *  card applies on every path (POS sending the board rate, a cleared card-pending hold), (3) a bypass purchase line can be edited. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-backdate-"));
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
const books = async () => { const b = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(b.ok, true, JSON.stringify(b.checks.filter((c: any) => !c.ok))); };
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman", "wholesale"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

let t: number, st: number, cust: any, todayHSD: number, oldHSD: number;
test("back-dated POS entry (manager / CEO): dated on that day, priced at that day's board rate; salesman cannot back-date", async () => {
  t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  st = db.get("SELECT id FROM stations WHERE tenant_id=? ORDER BY id LIMIT 1", t)!.id as number;
  cust = db.get("SELECT id, name FROM customers WHERE tenant_id=? AND credit_limit > 0 ORDER BY credit_limit DESC LIMIT 1", t)!;
  db.run("UPDATE customers SET credit_limit=100000000, khata_rates=NULL WHERE id=?", cust.id);
  todayHSD = (db.get("SELECT price FROM prices WHERE tenant_id=? AND product='HSD' ORDER BY effective_from DESC, id DESC LIMIT 1", t)!.price as number);
  // the board 10 days ago was Rs 20 lower; the current price took effect 5 days ago
  oldHSD = Math.round((todayHSD - 20) * 100) / 100;
  db.run("DELETE FROM prices WHERE tenant_id=? AND product='HSD'", t);
  db.run("INSERT INTO prices (tenant_id,product,price,effective_from,created_by) VALUES (?,?,?,?,?)", t, "HSD", oldHSD, new Date(Date.now() - 10 * 86_400_000).toISOString(), "test");
  db.run("INSERT INTO prices (tenant_id,product,price,effective_from,created_by) VALUES (?,?,?,?,?)", t, "HSD", todayHSD, new Date(Date.now() - 5 * 86_400_000).toISOString(), "test");
  // what the POS would show for that day
  const on = ok(await call("admin", "GET", `/api/sales/prices-on?date=${dayAgo(8)}`), "prices-on");
  near(on.prices.HSD, oldHSD, "board 8 days ago");
  near(ok(await call("admin", "GET", `/api/sales/prices-on?date=${dayAgo(0)}`), "prices today").prices.HSD, todayHSD);
  assert.equal((await call("admin", "GET", "/api/sales/prices-on?date=2026-13-45")).status, 400);
  // the entry itself: 100 L khata, 8 days ago
  const s = ok(await call("admin", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 100, payment_method: "khata", customer_id: cust.id, vehicle_no: "LEA-1", slip_no: "OLD-1", entry_date: dayAgo(8) }), "back-dated sale");
  near(s.rate, oldHSD, "priced at that day's rate"); near(s.amount, 100 * oldHSD);
  assert.equal(String(s.created_at).slice(0, 10), dayAgo(8), "dated that day");
  // the same entry today → today's rate
  const s2 = ok(await call("admin", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 100, payment_method: "khata", customer_id: cust.id, vehicle_no: "LEA-1", slip_no: "NEW-1" }), "today sale");
  near(s2.rate, todayHSD);
  // a salesman's entry_date is ignored (their late sales come with offline_at only)
  ok(await call("salesman", "POST", "/api/shifts/open", {}), "open shift");
  const s3 = ok(await call("salesman", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 10, payment_method: "cash", entry_date: dayAgo(8) }), "salesman");
  near(s3.rate, todayHSD, "salesman cannot back-date");
  assert.equal(String(s3.created_at).slice(0, 10), dayAgo(0));
  await books();
});

test("khata rate card applies on every path: board rate sent by the POS, back-dated day, and a cleared card-pending hold", async () => {
  ok(await call("admin", "POST", `/api/customers/${cust.id}/khata-rates`, { rates: { HSD: { mode: "minus", value: 5 } } }), "card: pump − 5");
  // POS-style (no rate) today
  const a = ok(await call("admin", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 50, payment_method: "khata", customer_id: cust.id, vehicle_no: "LEA-2", slip_no: "C-1" }), "khata today");
  near(a.rate, todayHSD - 5, "card applied today");
  // back-dated: card on that day's board
  const b = ok(await call("admin", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 50, payment_method: "khata", customer_id: cust.id, vehicle_no: "LEA-2", slip_no: "C-2", entry_date: dayAgo(8) }), "khata back-dated");
  near(b.rate, oldHSD - 5, "card applied on the old day's board");
  // card-pending hold: no rate now; cleared today at today's board − 5
  const h = ok(await call("admin", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 40, payment_method: "khata", customer_id: cust.id, vehicle_no: "LEA-2", slip_no: "P-1", pending: true }), "pending");
  const cl = ok(await call("admin", "POST", "/api/sales/clear", { ids: [h.id] }), "clear");
  near(cl.cleared[0].rate, todayHSD - 5, "cleared at the card rate");
  near(cl.cleared[0].amount, 40 * (todayHSD - 5));
  // an explicit override rate on clear still wins
  const h2 = ok(await call("admin", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 10, payment_method: "khata", customer_id: cust.id, vehicle_no: "LEA-2", slip_no: "P-2", pending: true }), "pending 2");
  near(ok(await call("admin", "POST", "/api/sales/clear", { ids: [h2.id], rate: 300 }), "clear override").cleared[0].rate, 300);
  await books();
});

test("bypass purchase edit: litres / cost / day change, supplier payable and stock follow, cannot go below what was delivered, client-fuel line refused", async () => {
  const sups = ok(await call("wholesale", "GET", "/api/bypass/suppliers"), "suppliers");
  const S = sups.find((x: any) => !x.client_id) ?? sups[0];
  const owed0 = S.bypass_owed as number;
  const clients = ok(await call("admin", "GET", "/api/wholesale/clients"), "clients");
  const W = (clients.clients ?? clients).find((c: any) => c.rates?.HSD);
  const del = ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st,
    purchases: [{ supplier_id: S.id, product: "HSD", litres: 1000, cost_rate: 250, ref: "INV-9" }],
    drops: [{ client_id: W.id, product: "HSD", litres: 600, override_limit: true }] }), "delivery");
  const pur = db.get("SELECT * FROM bypass_purchases WHERE delivery_id=? AND voided=0", del.id)!;
  // officer (wholesale.manage) has no entries.edit → 403; admin edits
  assert.equal((await call("wholesale", "PATCH", `/api/bypass/purchases/${pur.id}`, { reason: "rate galat", cost_rate: 251 })).status, 403);
  assert.equal((await call("admin", "PATCH", `/api/bypass/purchases/${pur.id}`, { cost_rate: 251 })).status, 400, "reason needed");
  const e1 = ok(await call("admin", "PATCH", `/api/bypass/purchases/${pur.id}`, { reason: "invoice par rate 251", cost_rate: 251 }), "rate edit");
  near(e1.purchase.amount, 1000 * 251); near(e1.bypass_owed, owed0 + 1000 * 251, "payable follows");
  const e2 = ok(await call("admin", "PATCH", `/api/bypass/purchases/${pur.id}`, { reason: "bilty 1200 L", litres: 1200, amount: 300_000, txn_date: dayAgo(3), ref: "INV-9A" }), "litres + amount + day");
  near(e2.purchase.cost_rate, 250); near(e2.purchase.litres, 1200); assert.equal(String(e2.purchase.txn_date).slice(0, 10), dayAgo(3)); assert.equal(e2.purchase.ref, "INV-9A");
  near(e2.bypass_stock.litres, 1200 - 600, "stock follows");
  // 600 L already went to the client: litres cannot drop under that
  const bad = await call("admin", "PATCH", `/api/bypass/purchases/${pur.id}`, { reason: "kam", litres: 500 });
  assert.equal(bad.status, 400); assert.match(bad.data.error, /kam az kam 600/);
  const st2 = ok(await call("wholesale", "GET", `/api/bypass/suppliers/${S.id}/statement`), "statement");
  near(st2.closing_balance, owed0 + 300_000);
  assert.ok(db.get("SELECT 1 x FROM audit_log WHERE tenant_id=? AND action='bypass_purchase_edit'", t), "audited");
  // fuel bought from a client (settled against their khata) is not editable here
  const del2 = ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st, purchases: [{ client_id: W.id, product: "HSD", litres: 100, cost_rate: 240 }] }), "client fuel");
  const pur2 = db.get("SELECT * FROM bypass_purchases WHERE delivery_id=? AND voided=0", del2.id)!;
  assert.equal((await call("admin", "PATCH", `/api/bypass/purchases/${pur2.id}`, { reason: "x", litres: 90 })).status, 400);
  await books();
});

test("bypass payment edit: amount / method / bank / day change on a payment WE made; client legs refused; payable follows", async () => {
  const sups = ok(await call("wholesale", "GET", "/api/bypass/suppliers"), "suppliers");
  const S = sups.find((x: any) => !x.client_id) ?? sups[0];
  const acc = ok(await call("admin", "POST", "/api/bank/accounts", { bank: "Bank Alfalah", account_no: "0101 7766", opening_balance: 5_000_000 }), "bank").id;
  const owed0 = ok(await call("wholesale", "GET", `/api/bypass/suppliers/${S.id}/statement`), "st").closing_balance as number;
  const pay = ok(await call("wholesale", "POST", `/api/bypass/suppliers/${S.id}/payment`, { amount: 100_000, mode: "we_pay", method: "Bank transfer", account_id: acc, ref: "TT-1" }), "pay").payment;
  assert.equal((await call("wholesale", "PATCH", `/api/bypass/payments/${pay.id}`, { reason: "x", amount: 1 })).status, 403, "officer cannot edit");
  const e = ok(await call("admin", "PATCH", `/api/bypass/payments/${pay.id}`, { reason: "slip par 1,20,000", amount: 120_000, txn_date: dayAgo(2), ref: "TT-1A" }), "edit");
  near(e.payment.amount, 120_000); assert.equal(e.payment.ref, "TT-1A"); assert.equal(String(e.payment.txn_date).slice(0, 10), dayAgo(2));
  near(ok(await call("wholesale", "GET", `/api/bypass/suppliers/${S.id}/statement`), "st2").closing_balance, owed0 - 120_000, "payable follows");
  const bank = ok(await call("admin", "GET", `/api/bank/accounts/${acc}/statement`), "bank st");
  near(bank.closing, 5_000_000 - 120_000, "bank book follows the edited amount");
  // to cash: the bank gets its money back, cash goes out
  const e2 = ok(await call("admin", "PATCH", `/api/bypass/payments/${pay.id}`, { reason: "asal me cash diya tha", method: "Cash" }), "to cash");
  assert.equal(e2.payment.account_id, null);
  near(ok(await call("admin", "GET", `/api/bank/accounts/${acc}/statement`), "bank st2").closing, 5_000_000);
  // a client's leg is not editable here
  const clients = ok(await call("admin", "GET", "/api/wholesale/clients"), "clients");
  const W = (clients.clients ?? clients).find((c: any) => c.rates?.HSD);
  const cd = ok(await call("wholesale", "POST", `/api/bypass/suppliers/${S.id}/payment`, { amount: 1000, mode: "client_direct", client_id: W.id }), "client direct").payment;
  assert.equal((await call("admin", "PATCH", `/api/bypass/payments/${cd.id}`, { reason: "x", amount: 1 })).status, 400);
  await books();
});

test("Baqi stock (lots): FIFO per supplier bill, delivered / unloaded taken off oldest first, a bill with fuel already out cannot be voided, over-issue is flagged", async () => {
  const sups = ok(await call("wholesale", "GET", "/api/bypass/suppliers"), "suppliers").filter((x: any) => !x.client_id);
  const [A, B] = sups;
  const clients = ok(await call("admin", "GET", "/api/wholesale/clients"), "clients");
  const W = (clients.clients ?? clients).find((c: any) => c.rates?.PMG) ?? (clients.clients ?? clients).find((c: any) => c.rates?.HSD);
  const prod = W.rates?.PMG ? "PMG" : "HSD";
  const before = ok(await call("admin", "GET", "/api/bypass/lots"), "lots").fuels.find((f: any) => f.product === prod);
  const b0 = before?.balance ?? 0;
  // two bills: A 10,000 (older day), B 10,000 (today); 7,000 delivered → all from A; A left 3,000, B untouched
  const d1 = ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st, txn_date: dayAgo(2), purchases: [{ supplier_id: A.id, product: prod, litres: 10_000, cost_rate: 300, ref: "A-1" }] }), "bill A");
  const d2 = ok(await call("admin", "POST", "/api/bypass/deliveries", { station_id: st, purchases: [{ supplier_id: B.id, product: prod, litres: 10_000, cost_rate: 310, ref: "B-1" }], drops: [{ client_id: W.id, product: prod, litres: 7_000, override_limit: true }] }), "bill B + drop");
  let lots = ok(await call("admin", "GET", "/api/bypass/lots"), "lots").fuels.find((f: any) => f.product === prod);
  near(lots.balance, b0 + 13_000, "balance = bought − delivered");
  const la = lots.lots.find((l: any) => l.ref === "A-1"), lb = lots.lots.find((l: any) => l.ref === "B-1");
  assert.ok(la && lb, "both bills listed while fuel is left");
  // whatever was held before this test is consumed first (FIFO), then bill A, then B
  near(la.left + lb.left, 13_000 + Math.min(0, b0) + Math.max(0, b0) - (lots.lots.filter((l: any) => l.ref !== "A-1" && l.ref !== "B-1").reduce((a: number, l: any) => a + l.left, 0)), "FIFO split");
  assert.equal(la.supplier, A.name); near(lb.cost_rate, 310);
  assert.ok(lots.lots.every((l: any) => l.left > 0), "only open lots listed");
  assert.ok(lots.outs.some((o: any) => o.client === W.name && Math.abs(o.litres - 7_000) < 0.01), "the drop is in the outs");
  // voiding bill A is fine (B still covers the fuel that went out); voiding B after that would drive the stock negative → refused
  const purA = db.get("SELECT id FROM bypass_purchases WHERE delivery_id=? AND voided=0", d1.id)!.id;
  const purB = db.get("SELECT id FROM bypass_purchases WHERE delivery_id=? AND voided=0", d2.id)!.id;
  ok(await call("admin", "POST", `/api/bypass/purchases/${purA}/void`, {}), "void A (stock stays ≥ 0)");
  const r = await call("admin", "POST", `/api/bypass/purchases/${purB}/void`, {});
  assert.equal(r.status, 400, "void refused: fuel already out"); assert.match(r.data.error, /pehle hi/);
  lots = ok(await call("admin", "GET", "/api/bypass/lots"), "lots after void").fuels.find((f: any) => f.product === prod);
  near(lots.balance, b0 + 3_000, "balance after voiding A");
  // unload 2,000 into our tank → comes off the stock too, listed as "unloaded"
  const tank = db.get("SELECT id FROM tanks WHERE station_id=? AND product=? ORDER BY id LIMIT 1", st, prod);
  if (tank) {
    ok(await call("wholesale", "POST", "/api/bypass/to-tank", { product: prod, litres: 2_000, tank_id: tank.id }), "unload");
    lots = ok(await call("admin", "GET", "/api/bypass/lots"), "lots2").fuels.find((f: any) => f.product === prod);
    near(lots.balance, b0 + 1_000); assert.ok(lots.unloaded >= 2_000);
  }
  assert.equal(lots.over.length, 0, "nothing over-issued"); void purB;
  await books();
});

test("own-tank unload edit (officer): litres / tank / day change; bypass stock, tank and stock register follow; sold-out litres refuse", async () => {
  const sups = ok(await call("wholesale", "GET", "/api/bypass/suppliers"), "suppliers").filter((x: any) => !x.client_id);
  const tank = db.get("SELECT * FROM tanks WHERE station_id=? AND product='HSD' ORDER BY id LIMIT 1", st)!;
  ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st, purchases: [{ supplier_id: sups[0].id, product: "HSD", litres: 3_000, cost_rate: 260 }] }), "buy 3000");
  const stock0 = ok(await call("admin", "GET", "/api/bypass/lots"), "lots").fuels.find((f: any) => f.product === "HSD").balance as number;
  const tank0 = db.get("SELECT current_l FROM tanks WHERE id=?", tank.id)!.current_l as number;
  const u = ok(await call("wholesale", "POST", "/api/bypass/to-tank", { product: "HSD", litres: 1_000, tank_id: tank.id, note: "bacha" }), "unload 1000");
  near(db.get("SELECT current_l FROM tanks WHERE id=?", tank.id)!.current_l, tank0 + 1_000);
  assert.equal((await call("wholesale", "PATCH", `/api/bypass/to-tank/${u.id}`, { litres: 1_500 })).status, 400, "reason needed");
  const e = ok(await call("wholesale", "PATCH", `/api/bypass/to-tank/${u.id}`, { reason: "asal 1,500 the", litres: 1_500, txn_date: dayAgo(1), note: "bacha (theek)" }), "officer edits");
  near(e.litres, 1_500);
  near(db.get("SELECT current_l FROM tanks WHERE id=?", tank.id)!.current_l, tank0 + 1_500, "tank follows");
  const lots = ok(await call("admin", "GET", "/api/bypass/lots"), "lots2").fuels.find((f: any) => f.product === "HSD");
  near(lots.balance, stock0 - 1_500, "bypass stock follows");
  assert.equal(db.get("SELECT voided FROM bypass_drops WHERE id=?", u.id)!.voided, 1, "old row reversed");
  const row = db.get("SELECT * FROM bypass_drops WHERE id=?", e.id)!;
  assert.equal(String(row.txn_date).slice(0, 10), dayAgo(1)); assert.equal(row.note, "bacha (theek)");
  assert.ok(db.get("SELECT 1 x FROM deliveries WHERE id=?", row.to_delivery_id), "stock-register row re-made");
  // more than the stock → refused, and the old entry stays as it was
  assert.equal((await call("wholesale", "PATCH", `/api/bypass/to-tank/${e.id}`, { reason: "x", litres: 1_000_000 })).status, 400);
  assert.equal(db.get("SELECT voided FROM bypass_drops WHERE id=?", e.id)!.voided, 0, "tx rolled back");
  await books();
});

test("cashier → Pay → Supplier: a bypass-only supplier shows what we owe and a payment settles the bypass account (then the pump account); void restores", async () => {
  const sups = ok(await call("wholesale", "GET", "/api/bypass/suppliers"), "suppliers").filter((x: any) => !x.client_id);
  const S = sups[sups.length - 1];
  const pump0 = ok(await call("admin", "GET", `/api/suppliers/${S.id}`), "sup").owed as number;
  const byp0 = S.bypass_owed as number;
  // bypass purchase of 14 lakh with no drop (held stock)
  ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st, purchases: [{ supplier_id: S.id, product: "HSD", litres: 1_000, cost_rate: 280 }] }), "buy 2.8 lakh");
  const parties = ok(await call("admin", "GET", "/api/cashier/parties?kind=supplier"), "parties").supplier;
  const row = parties.find((x: any) => x.id === S.id);
  near(row.bypass_owed, byp0 + 280_000, "bypass owed shown"); near(row.balance, pump0 + byp0 + 280_000, "cashier sees pump + bypass");
  // pay 14 lakh cash → all of it on the bypass account
  const pay = ok(await call("admin", "POST", "/api/cashier/pay", { party_type: "supplier", party_id: S.id, amount: 280_000, method: "Cash", note: "Foji ko diya" }), "pay");
  assert.match(String(pay.voucher.src), /^byppay:\d+$/, "settled on the bypass account");
  near(pay.balance_after, pump0 + byp0, "balance after = what was owed before this bill");
  near(ok(await call("wholesale", "GET", `/api/bypass/suppliers/${S.id}/statement`), "byp st").closing_balance, byp0, "bypass account cleared");
  near(ok(await call("admin", "GET", `/api/suppliers/${S.id}`), "sup2").owed, pump0, "pump account untouched");
  await books();
  // void the voucher → the bypass payment is voided, owed comes back
  ok(await call("admin", "POST", `/api/cashier/vouchers/${pay.voucher.id}/void`, { reason: "ghalat entry" }), "void");
  near(ok(await call("wholesale", "GET", `/api/bypass/suppliers/${S.id}/statement`), "byp st2").closing_balance, byp0 + 280_000, "owed is back");
  await books();
  // a payment bigger than the bypass due spills onto the pump account (two legs)
  const pay2 = ok(await call("admin", "POST", "/api/cashier/pay", { party_type: "supplier", party_id: S.id, amount: byp0 + 280_000 + 50_000, method: "Cash" }), "pay over");
  assert.match(String(pay2.voucher.src), /^byppay:\d+\+stx:\d+$/, "two legs");
  near(ok(await call("wholesale", "GET", `/api/bypass/suppliers/${S.id}/statement`), "byp st3").closing_balance, 0, "bypass cleared");
  near(ok(await call("admin", "GET", `/api/suppliers/${S.id}`), "sup3").owed, pump0 - 50_000, "rest on the pump account");
  assert.equal((await call("admin", "POST", `/api/cashier/vouchers/${pay2.voucher.id}/edit`, { reason: "x", amount: 1 })).status, 400, "two-leg voucher: void + re-enter, not edit");
  ok(await call("admin", "POST", `/api/cashier/vouchers/${pay2.voucher.id}/void`, { reason: "test wapas" }), "void 2");
  near(ok(await call("admin", "GET", `/api/suppliers/${S.id}`), "sup4").owed, pump0);
  await books();
});
