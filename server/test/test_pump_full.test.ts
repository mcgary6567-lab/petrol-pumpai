/**
 * "Test Pump" from zero: a brand-new SaaS pump, a user of every role, and ONE entry of EVERY kind the app supports.
 * After each module the double-entry books must still tally (GET /api/books/check → ok, 0 farq), and at the end the
 * dashboard (owner overview), the live cash page, the P&L and the balance sheet must all agree with the hand-worked figures.
 *
 * Every figure is tracked by hand in `E` (expected) as the entries are made — nothing is read back from the system to build
 * an expectation.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-testpump-full-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.BACKUP_DIR = path.join(dir, "backups");
process.env.NODE_ENV = "test";
process.env.DEMO_DATA = "0";            // empty db — SaaS signups, no demo pump
process.env.SAAS_MODE = "1";
process.env.TRIAL_DAYS = "7";
process.env.PLATFORM_ADMIN_EMAIL = "owner@petrolpumpai.pk";
process.env.PLATFORM_ADMIN_PASSWORD = "platform-pass-123";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server, base = "";
const tok: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const t = tok[who];
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, m: string, tol = 1) => assert.ok(Math.abs(Number(a) - b) <= tol, `${m}: expected ${b}, got ${a}`);
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const photo = async (who: string) => ok(await call(who, "POST", "/api/ai/read-photo", { kind: "proof", image: PNG }), "photo").photo_id as number;
const today = () => new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);

/** hand-worked running figures */
const E = {
  cash: 0,          // office drawer
  bank: 0,          // HBL
  khata: 0,         // Ali Transport
  supPump: 0,       // PSO Depot — pump (tank) purchases
  supBypass: 0,     // PSO Depot — bypass purchases
  wsDue: 0,         // Khan Filling Station
  thkDue: 0,        // Bashir Thekedar
  staffAdv: 0,      // salesman advance balance
  investor: 0,      // owed to the investor
  coupons: 0,       // unused coupons sold
  wallet: 0,        // Ali's wallet
  tankP: 10000, tankD: 8000,
};
const ids: Record<string, number> = {};

async function booksOk(where: string) {
  const r = ok(await call("admin", "GET", "/api/books/check"), "books");
  const bad = (r.checks as any[]).filter((c) => !c.ok && !c.advisory).map((c) => `${c.label}: book ${c.book} vs ledger ${c.ledger} (diff ${c.diff})`);
  assert.equal(r.ok, true, `books not tallied after ${where}: ${bad.join(" | ")}`);
  assert.ok(r.max_diff <= 1, `max diff ${r.max_diff} after ${where}`);
}
const money = async () => ok(await call("admin", "GET", "/api/owner/overview"), "overview").money;
const khataBal = async (id: number) => ok(await call("admin", "GET", `/api/customers/${id}`), "customer").balance as number;
const supOwed = async (id: number) => (ok(await call("admin", "GET", "/api/suppliers"), "suppliers") as any[]).find((x) => x.id === id);
const clientDue = async (id: number) => ok(await call("wholesale", "GET", `/api/wholesale/clients/${id}`), "client").summary.due as number;
const tankL = async (id: number) => (ok(await call("admin", "GET", "/api/stations"), "stations") as any[]).flatMap((x) => x.tanks).find((x: any) => x.id === id).current_l as number;
async function checkMoney(where: string) {
  const m = await money();
  near(m.office_cash, E.cash, `${where}: office cash`);
  near(m.banks, E.bank, `${where}: banks`);
  near(m.with_salesmen, 0, `${where}: with salesmen`);
}

before(async () => {
  const { app } = await import("../src/index.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const PW = "test12345";
const email = (r: string) => `${r}@testpump.pk`;

test("1. sign up 'Test Pump' + staff of every role, all log in", async () => {
  const s = ok(await call("", "POST", "/api/signup", {
    business: { name: "Test Pump", owner_name: "Test Owner", owner_phone: "03001234567", biz_city: "Lahore" },
    admin: { name: "Test CEO", email: email("ceo"), password: PW },
    stations: [{ name: "Test Pump Station", tanks: [
      { name: "Tank-1 Petrol", product: "PMG", capacity_l: 30000, current_l: 10000, nozzles: 2 },
      { name: "Tank-2 Diesel", product: "HSD", capacity_l: 30000, current_l: 8000, nozzles: 2 }] }],
    prices: { PMG: 295, HSD: 280 }, modules: { wholesale: true },
  }), "signup");
  assert.equal(s.user.role, "admin");
  tok.admin = s.token;
  const st = ok(await call("admin", "GET", "/api/stations"), "stations")[0];
  ids.station = st.id;
  ids.tankP = st.tanks.find((t: any) => t.product === "PMG").id;
  ids.tankD = st.tanks.find((t: any) => t.product === "HSD").id;
  let n = 1;
  for (const [role, name] of [["manager", "Test Manager"], ["salesman", "Test Salesman"], ["cashier", "Test Cashier"], ["wholesale", "Test Wholesale Officer"]]) {
    ok(await call("admin", "POST", "/api/users", { name, email: email(role), password: PW, role, station_id: st.id, phone: `0300111000${n++}` }), `user ${role}`);
    tok[role] = ok(await call("", "POST", "/api/auth/login", { email: email(role), password: PW }), `login ${role}`).token;
    assert.equal(ok(await call(role, "GET", "/api/me"), `me ${role}`).role ?? role, role);
  }
  ids.salesman = (ok(await call("admin", "GET", "/api/users"), "users").users as any[]).find((u) => u.role === "salesman").id;
  await booksOk("signup");
});

test("2. go-live: opening cash, bank, tank stock rate, khata + supplier openings; fuel price change", async () => {
  const gl0 = ok(await call("admin", "GET", "/api/golive"), "golive");
  assert.ok(Array.isArray(gl0.items) && gl0.items.length > 5, "go-live checklist");
  // opening fuel cost (go-live stock value)
  ok(await call("admin", "POST", "/api/opening/fuel-rates", { rows: [{ product: "PMG", rate: 285 }, { product: "HSD", rate: 265 }] }), "fuel rates");
  const op = ok(await call("admin", "GET", "/api/opening"), "opening");
  near(op.fuel_values.reduce((a: number, f: any) => a + (f.opening?.amount ?? 0), 0), 10000 * 285 + 8000 * 265, "go-live fuel value");
  // opening cash: the first count
  ok(await call("cashier", "POST", "/api/cash/count", { amount: 200000, note: "opening cash" }), "cash count");
  E.cash = 200000;
  // bank account, opening set through the go-live opening screen
  ids.bank = ok(await call("admin", "POST", "/api/bank/accounts", { bank: "HBL", title: "Test Pump", account_no: "0011223344", kind: "current", opening_balance: 0 }), "bank").id;
  ok(await call("admin", "POST", "/api/opening/bank", { id: ids.bank, amount: 1000000 }), "opening bank");
  E.bank = 1000000;
  // khata customer + purana baqaya, vehicle
  ids.cust = ok(await call("admin", "POST", "/api/customers", { name: "Ali Transport", type: "fleet", phone: "03001234501", credit_limit: 500000 }), "customer").id;
  ok(await call("admin", "POST", "/api/opening/khata", { rows: [{ customer_id: ids.cust, amount: 50000 }] }), "khata opening");
  E.khata = 50000;
  ok(await call("admin", "POST", `/api/customers/${ids.cust}/vehicles`, { plate_no: "LEA-786", fuel: "HSD" }), "vehicle");
  // supplier + opening payable through /opening/party
  ids.sup = ok(await call("admin", "POST", "/api/suppliers", { name: "PSO Depot", phone: "03001234502" }), "supplier").id;
  ok(await call("admin", "POST", "/api/opening/party", { kind: "supplier", id: ids.sup, amount: 100000 }), "supplier opening");
  E.supPump = 100000;
  ok(await call("admin", "POST", "/api/golive/letterhead/skip", {}), "skip letterhead");
  // fuel price change: petrol 295 → 300
  ok(await call("admin", "POST", "/api/prices", { prices: { PMG: 300 } }), "price");
  const pr = ok(await call("admin", "GET", "/api/prices"), "prices");
  const pmg = (Array.isArray(pr) ? pr : pr.prices ?? pr.current ?? []).find?.((p: any) => p.product === "PMG");
  if (pmg) near(pmg.price, 300, "PMG price");
  // the salesman (not on shift yet) confirms the dispenser shows the new price — the POS is blocked until then
  const nt = ok(await call("salesman", "GET", "/api/notifications"), "salesman notes");
  const pc = (nt.pending_ack as any[]).find((x) => x.type === "price_change");
  assert.ok(pc, "salesman must confirm the price change");
  ok(await call("salesman", "POST", `/api/notifications/${pc.id}/ack`, {}), "ack price");

  await checkMoney("go-live");
  near(await khataBal(ids.cust), 50000, "Ali opening khata");
  near((await supOwed(ids.sup)).total_owed, 100000, "PSO opening");
  await booksOk("go-live");
});

test("3. supplier: tanker delivery into a tank + supplier payment (bank)", async () => {
  ok(await call("manager", "POST", "/api/stock/delivery", { tank_id: ids.tankD, invoice_l: 5000, received_l: 5000, supplier_id: ids.sup, purchase_rate: 265, tanker_no: "TLR-100" }), "delivery");
  E.tankD += 5000; E.supPump += 5000 * 265;
  ok(await call("cashier", "POST", "/api/cashier/pay", { party_type: "supplier", party_id: ids.sup, amount: 400000, method: "Bank transfer", account_id: ids.bank, ref: "PO-1" }), "pay supplier");
  E.supPump -= 400000; E.bank -= 400000;
  near(await tankL(ids.tankD), E.tankD, "diesel tank");
  near((await supOwed(ids.sup)).total_owed, E.supPump, "PSO owed");
  await checkMoney("supplier");
  await booksOk("supplier");
});

test("4. coupons + wallet sold in advance", async () => {
  const b = ok(await call("manager", "POST", "/api/coupons", { count: 2, value: 3000, product: "PMG", buyer: "Test Traders", method: "cash" }), "coupons");
  assert.equal(b.total, 6000);
  E.cash += 6000; E.coupons += 6000;
  const book = ok(await call("manager", "GET", `/api/coupons/batch/${b.batch}`), "batch");
  ids.couponCode = book.coupons[0].code;
  const w = ok(await call("manager", "POST", `/api/customers/${ids.cust}/wallet/deposit`, { amount: 5600, method: "cash" }), "wallet deposit");
  near(w.wallet_balance, 5600, "wallet");
  E.cash += 5600; E.wallet += 5600;
  await checkMoney("prepaid");
  await booksOk("coupons + wallet");
});

let shiftId = 0;
test("5. shift: open → POS cash / card / khata / coupon / wallet → shift expense → close → cashier handover", async () => {
  const sh = ok(await call("salesman", "POST", "/api/shifts/open", {}), "open shift");
  shiftId = sh.id;
  const sale = async (b: any, m: string) => ok(await call("salesman", "POST", "/api/sales", { station_id: ids.station, ...b }), m);
  const cs = await sale({ product: "PMG", litres: 100, payment_method: "cash" }, "cash sale");                 // 30,000
  near(cs.amount, 30000, "cash sale at the new price");
  await sale({ product: "HSD", litres: 50, payment_method: "card" }, "card sale");                              // 14,000
  await sale({ product: "HSD", litres: 100, payment_method: "khata", customer_id: ids.cust, vehicle_no: "LEA-786" }, "khata sale"); // 28,000
  const cp = await sale({ product: "PMG", payment_method: "coupon", coupon_code: ids.couponCode }, "coupon sale"); // 3,000 = 10 L
  near(cp.amount, 3000, "coupon value"); near(cp.litres, 10, "coupon litres");
  const ws = await sale({ product: "HSD", amount: 2800, payment_method: "wallet", customer_id: ids.cust, vehicle_no: "LEA-786" }, "wallet sale"); // 10 L
  near(ws.litres, 10, "wallet litres");
  E.khata += 28000; E.coupons -= 3000; E.wallet -= 2800;
  ok(await call("salesman", "POST", `/api/shifts/${sh.id}/expenses`, { category: "Tea & food", new_category: true, amount: 500, note: "chai" }), "shift expense");
  const live = ok(await call("salesman", "GET", `/api/shifts/${sh.id}/live`), "live");
  const readings: Record<string, number> = {};
  for (const r of live.readings) readings[r.nozzle_id] = Number(r.closing ?? r.opening ?? 0);
  const prev = ok(await call("salesman", "POST", `/api/shifts/${sh.id}/preview`, { readings }), "preview");
  near(prev.cash_expected, 30000 - 500, "cash to hand over");
  ok(await call("salesman", "POST", `/api/shifts/${sh.id}/close`, { readings, cash_actual: prev.cash_expected }), "close");
  const pend = ok(await call("cashier", "GET", "/api/cashier/handovers"), "handovers");
  if ((pend.pending ?? []).some((x: any) => x.id === sh.id)) ok(await call("cashier", "POST", `/api/cashier/handovers/${sh.id}`, { amount: prev.cash_expected }), "handover");
  E.cash += 29500;
  E.tankP -= 110; E.tankD -= 160;
  near(await tankL(ids.tankP), E.tankP, "petrol tank");
  near(await tankL(ids.tankD), E.tankD, "diesel tank");
  near(await khataBal(ids.cust), E.khata, "Ali khata");
  await checkMoney("shift");
  await booksOk("shift close + handover");
});

test("6. khata payment (cash) + cheque received → deposited → cleared", async () => {
  const r = ok(await call("cashier", "POST", "/api/cashier/receive", { party_type: "khata", party_id: ids.cust, amount: 20000, method: "Cash", notify: false }), "khata cash");
  ids.khataVoucher = r.voucher.id; ids.khataRow = Number(String(r.voucher.src).split(":")[1]);
  E.khata -= 20000; E.cash += 20000;
  const c = ok(await call("cashier", "POST", "/api/cashier/receive", { party_type: "khata", party_id: ids.cust, amount: 10000, method: "Cheque", photo_ids: [await photo("cashier")], cheque: { bank: "MCB", cheque_no: "9001", cheque_date: today() } }), "cheque");
  assert.ok(c.cheque_pending, "cheque in hand, not credited yet");
  near(await khataBal(ids.cust), E.khata, "khata not credited until the cheque clears");
  await booksOk("cheque in hand");
  const q = (ok(await call("cashier", "GET", "/api/cashier/cheques"), "cheques").cheques as any[]).find((x) => x.cheque_no === "9001");
  ok(await call("cashier", "POST", `/api/cashier/cheques/${q.id}/deposit`, { account_id: ids.bank }), "deposit cheque");
  ok(await call("cashier", "POST", `/api/cashier/cheques/${q.id}/clear`, {}), "clear cheque");
  E.khata -= 10000; E.bank += 10000;
  near(await khataBal(ids.cust), E.khata, "Ali khata after cheque");
  await checkMoney("khata");
  await booksOk("khata + cheque");
});

test("7. shop: item, stock-in (cash), counter sale", async () => {
  ids.oil = ok(await call("admin", "POST", "/api/shop/items", { station_id: ids.station, name: "Engine Oil 1L", category: "lubricant", cost: 1000, price: 1300 }), "item").id;
  ok(await call("manager", "POST", `/api/shop/items/${ids.oil}/stock-in`, { qty: 10, cost: 1000, paid_by: "cash" }), "stock-in");
  ok(await call("admin", "POST", "/api/shop/sales", { station_id: ids.station, payment_method: "cash", lines: [{ item_id: ids.oil, qty: 2 }] }), "shop sale");
  E.cash += -10000 + 2600;
  await checkMoney("shop");
  await booksOk("shop");
});

test("8. wholesale: client, supply from our tank, bank + cash payment", async () => {
  ids.ws = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "Khan Filling Station", phone: "03001234503", rates: { HSD: 275 } }), "client").id;
  const trip = ok(await call("wholesale", "POST", "/api/wholesale/trips", { station_id: ids.station, product: "HSD", vehicle_no: "TLR-200", drops: [{ client_id: ids.ws, litres: 1000, override_limit: true }] }), "trip");
  near(trip.drops[0].amount, 275000, "billed");
  E.wsDue += 275000; E.tankD -= 1000;
  ok(await call("cashier", "POST", "/api/cashier/receive", { party_type: "wholesale", party_id: ids.ws, amount: 100000, method: "Bank transfer", account_id: ids.bank, notify: false }), "ws bank receipt");
  E.wsDue -= 100000; E.bank += 100000;
  ok(await call("wholesale", "POST", `/api/wholesale/clients/${ids.ws}/payment`, { amount: 25000, method: "Cash" }), "ws cash payment");
  E.wsDue -= 25000; E.cash += 25000;
  near(await clientDue(ids.ws), E.wsDue, "Khan due");
  near(await tankL(ids.tankD), E.tankD, "diesel tank");
  await checkMoney("wholesale");
  await booksOk("wholesale");
});

test("9. bypass: depot → client (purchase + drop) + bypass supplier payment", async () => {
  const byp = ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: ids.station, purchases: [{ supplier_id: ids.sup, product: "HSD", litres: 2000, cost_rate: 262, ref: "BILTY-9" }], drops: [{ client_id: ids.ws, product: "HSD", litres: 2000, override_limit: true }] }), "bypass");
  near(byp.margin, 2000 * (275 - 262), "bypass margin");
  E.wsDue += 550000; E.supBypass += 524000;
  ok(await call("wholesale", "POST", `/api/bypass/suppliers/${ids.sup}/payment`, { amount: 200000, mode: "we_pay", method: "Bank transfer", account_id: ids.bank, ref: "PO-2" }), "pay bypass supplier");
  E.supBypass -= 200000; E.bank -= 200000;
  const so = await supOwed(ids.sup);
  near(so.owed, E.supPump, "PSO pump owed"); near(so.bypass_owed, E.supBypass, "PSO bypass owed");
  near(await clientDue(ids.ws), E.wsDue, "Khan due");
  await checkMoney("bypass");
  await booksOk("bypass");
});

test("10. carriage / thekedar: kiraya entry + payment", async () => {
  ids.thk = ok(await call("wholesale", "POST", "/api/carriage/thekedars", { name: "Bashir Thekedar", phone: "03001234504" }), "thekedar").id;
  ok(await call("wholesale", "POST", `/api/carriage/thekedars/${ids.thk}/carriage`, { supplier_id: ids.sup, invoice_ref: "DEP-55", amount: 25000, lines: [{ product: "HSD", litres: 5000 }] }), "kiraya");
  ok(await call("wholesale", "POST", `/api/carriage/thekedars/${ids.thk}/payment`, { amount: 10000, method: "Cash", notify: false }), "kiraya receipt");
  E.thkDue += 15000; E.cash += 10000;
  near(ok(await call("wholesale", "GET", `/api/carriage/thekedars/${ids.thk}`), "thekedar").closing_balance, E.thkDue, "Bashir due");
  await checkMoney("carriage");
  await booksOk("carriage");
});

test("11. cashier pay voucher (expense) + approved expense + CEO other income / other expense", async () => {
  ok(await call("cashier", "POST", "/api/cashier/pay", { party_type: "other", party_name: "LESCO", category: "Electricity (bijli)", amount: 3000, method: "Cash" }), "bijli voucher");
  E.cash -= 3000;
  // a big expense by the manager goes for approval; the CEO approves it
  const ex = ok(await call("manager", "POST", "/api/expenses", { category: "Maintenance & repairs", amount: 45000, paid_to: "Dispenser mechanic", method: "cash" }), "expense");
  if (ex.status === "pending") {
    await booksOk("expense pending");
    const ap = ok(await call("admin", "POST", `/api/expenses/${ex.id}/approve`, {}), "approve");
    assert.equal(ap.status, "approved");
  } else assert.equal(ex.status, "approved");
  E.cash -= 45000;
  ok(await call("admin", "POST", "/api/other-entries", { kind: "income", party_type: "other", party_name: "Scrap wala", reason: "Purana saman becha", amount: 4000, method: "cash" }), "other income");
  ok(await call("admin", "POST", "/api/other-entries", { kind: "expense", party_type: "other", party_name: "Mosque", reason: "Chanda", amount: 1500, method: "cash" }), "other expense");
  E.cash += 4000 - 1500;
  await checkMoney("expenses");
  await booksOk("expenses + other entries");
});

test("12. staff: advance, repayment, salary with deduction", async () => {
  const sm = ids.salesman;
  ok(await call("manager", "POST", `/api/staff/${sm}/entry`, { type: "advance", amount: 5000, method: "cash", note: "advance" }), "advance");
  E.staffAdv += 5000; E.cash -= 5000;
  ok(await call("manager", "POST", `/api/staff/${sm}/entry`, { type: "repayment", amount: 2000, method: "cash", note: "wapsi" }), "repayment");
  E.staffAdv -= 2000; E.cash += 2000;
  ok(await call("manager", "PATCH", `/api/staff/${sm}`, { salary: 30000 }), "set salary");
  const pay = ok(await call("manager", "POST", `/api/staff/${sm}/pay-salary`, { photo_ids: [await photo("manager")], deduct: 1000, absence_cut: 0, commission: 0 }), "salary");
  near(pay.net, 29000, "net salary paid");
  near(pay.balance, 2000, "advance left");
  E.staffAdv -= 1000; E.cash -= 29000;
  await checkMoney("staff");
  await booksOk("staff");
});

test("13. property rent", async () => {
  ids.rental = ok(await call("admin", "POST", "/api/rentals", { name: "Tyre Shop", kind: "shop", tenant_name: "Aslam", monthly_rent: 15000 }), "rental").id;
  ok(await call("cashier", "POST", `/api/rentals/${ids.rental}/pay`, { amount: 15000, method: "cash" }), "rent received");
  E.cash += 15000;
  await checkMoney("rent");
  await booksOk("rent");
});

test("14. investor: capital → deal → close with 60/40 split (paid now) → capital payout", async () => {
  ids.inv = ok(await call("admin", "POST", "/api/investors", { name: "Haji Rasheed", phone: "03001234599", our_pct: 60 }), "investor").id;
  ok(await call("admin", "POST", `/api/investors/${ids.inv}/money`, { dir: "in", amount: 1000000, method: "Cash", note: "capital" }), "capital in");
  E.investor += 1000000; E.cash += 1000000;
  await booksOk("investor capital");
  const deal = ok(await call("admin", "POST", `/api/investors/${ids.inv}/deals`, { product: "HSD", litres: 3000, cost_rate: 255, supplier_id: ids.sup, ref: "BILTY-7" }), "deal");
  near(deal.cost_amount, 765000, "deal cost");
  // sold 3,000 L @ 275 = 825,000; carriage 5,000 → profit 55,000; investor 40% = 22,000 paid in cash now
  const cl = ok(await call("admin", "POST", `/api/investor-deals/${deal.id}/close`, { sold_litres: 3000, sale_rate: 275, exp_carriage: 5000, pay_now: { method: "Cash" } }), "close deal");
  near(cl.profit, 55000, "deal profit"); near(cl.investor_share, 22000, "investor share"); near(cl.our_share, 33000, "our share");
  assert.equal(cl.paid, true);
  E.cash -= 22000;
  ok(await call("admin", "POST", `/api/investors/${ids.inv}/money`, { dir: "out", amount: 200000, method: "Cash", purpose: "capital" }), "capital payout");
  E.investor -= 200000; E.cash -= 200000;
  near(ok(await call("admin", "GET", "/api/investors-summary"), "inv summary").owed, E.investor, "investor owed");
  await checkMoney("investor");
  await booksOk("investor");
});

test("15. meter reset (old meter ran 2 L past the last reading, back at 0)", async () => {
  const hand = ok(await call("salesman", "GET", "/api/shifts/handover"), "handover");
  const noz = hand.nozzles.find((n: any) => n.product === "PMG" && !n.busy);
  const r = ok(await call("manager", "POST", `/api/nozzles/${noz.nozzle_id}/reset`, { old_reading: noz.last_reading + 2, new_reading: 0, reason: "Repair se wapas aaya, 0 par" }), "reset");
  near(r.gap_l, 2, "gap litres");
  E.tankP -= 2;
  near(await tankL(ids.tankP), E.tankP, "petrol tank after reset");
  await booksOk("meter reset");
});

test("16. void one entry + full edit of another", async () => {
  // a duplicate bijli voucher, then voided (void_pin is 0 in tests → no PIN asked)
  const dup = ok(await call("cashier", "POST", "/api/cashier/pay", { party_type: "other", party_name: "LESCO", category: "Electricity (bijli)", amount: 3000, method: "Cash" }), "dup voucher");
  const vid = dup.voucher?.id ?? dup.id;
  near((await money()).office_cash, E.cash - 3000, "cash down by the duplicate");
  ok(await call("admin", "POST", `/api/cashier/vouchers/${vid}/void`, { reason: "double entry" }), "void voucher");
  await checkMoney("void");
  await booksOk("void");
  // full edit: the 20,000 khata cash receipt was really 25,000
  const info = ok(await call("admin", "GET", `/api/corrections/entry/khata/${ids.khataRow}`), "entry info");
  assert.equal(info.kind, "khata");
  ok(await call("admin", "POST", `/api/corrections/entry/khata/${ids.khataRow}/full-edit`, { reason: "raqam galat thi", party_id: ids.cust, amount: 25000, method: "Cash" }), "full edit");
  E.khata -= 5000; E.cash += 5000;
  near(await khataBal(ids.cust), E.khata, "Ali khata after edit");
  await checkMoney("full edit");
  await booksOk("full edit");
});

test("17. cash count (no variance) + bank deposit", async () => {
  const c = ok(await call("cashier", "POST", "/api/cash/count", { amount: E.cash, note: "evening count" }), "count");
  void c;
  const live = ok(await call("admin", "GET", "/api/cash/live"), "cash live");
  near(live.office.variance, 0, "count variance");
  ok(await call("manager", "POST", "/api/cash/deposits", { amount: 50000, bank: "HBL", account_id: ids.bank, slip_ref: "DS-1" }), "deposit");
  E.cash -= 50000; E.bank += 50000;
  await checkMoney("deposit");
  await booksOk("cash count + deposit");
});

/* ---------------- hand-worked month figures (everything above happened this month) ---------------- */
const H = {
  // fuel revenue: cash 100 L × 300 + card 50 L × 280 + khata 100 L × 280 + coupon 3,000 + wallet 2,800
  retail: 30000 + 14000 + 28000 + 3000 + 2800,                    // 77,800
  wholesale: 1000 * 275 + 2000 * 275,                              // 825,000 (tank trip + bypass)
  shop: 2 * 1300,                                                  // 2,600
  // cost: petrol 110 L @285, diesel retail 160 L + trip 1,000 L @265, bypass 2,000 L @262
  fuelCost: 110 * 285 + 160 * 265 + 1000 * 265 + 2000 * 262,       // 862,750
  shopCost: 2 * 1000,
  // income outside fuel/shop: shop rent 15,000 + kiraya 25,000 + CEO other income 4,000
  otherIncome: 15000 + 25000 + 4000,
  // every cost: chai 500 + bijli 3,000 + repairs 45,000 + salary 30,000 + CEO other expense 1,500 + investor's 40% share 22,000
  expenses: 500 + 3000 + 45000 + 30000 + 1500 + 22000,             // 102,000
};
const revenue = H.retail + H.wholesale + H.shop;                   // 905,400
const gross = revenue - H.fuelCost - H.shopCost;                   // 40,650
const net = gross + H.otherIncome - H.expenses;                    // -17,350

test("18. final cross-check: books, overview, cash live, P&L, balance sheet", async () => {
  await booksOk("final");
  const ov = ok(await call("admin", "GET", "/api/owner/overview"), "overview");
  const live = ok(await call("admin", "GET", "/api/cash/live"), "cash live");
  const { pl, balance_sheet: bs } = ok(await call("admin", "GET", `/api/analysis/pl?month=${today().slice(0, 7)}`), "pl");

  // hand-worked closing position
  assert.deepEqual(E, { cash: 959200, bank: 560000, khata: 43000, supPump: 1025000, supBypass: 324000, wsDue: 700000, thkDue: 15000,
    staffAdv: 2000, investor: 800000, coupons: 3000, wallet: 2800, tankP: 9888, tankD: 11840 });

  // money: overview == cash live == balance sheet == hand
  near(ov.money.office_cash, E.cash, "overview cash"); near(ov.money.banks, E.bank, "overview banks"); near(ov.money.total, E.cash + E.bank, "overview money total");
  near(live.office.cash_in_hand, E.cash, "live cash"); near(live.banks.total, E.bank, "live banks"); near(live.total, E.cash + E.bank, "live total");
  near(live.salesmen.total, 0, "nothing left with salesmen");
  near(live.office.variance, 0, "last count tallied");
  near(bs.assets.cash_in_hand, E.cash, "BS cash"); near(bs.assets.banks, E.bank, "BS banks"); near(bs.assets.cash_with_salesmen, 0, "BS salesmen");

  // receivables
  near(bs.assets.khata_receivable, E.khata, "BS khata"); near(ov.owed_to_us.khata, E.khata, "overview khata");
  near(bs.assets.wholesale_receivable, E.wsDue, "BS wholesale"); near(ov.owed_to_us.wholesale, E.wsDue, "overview wholesale");
  near(bs.assets.carriage_receivable, E.thkDue, "BS carriage");
  near(bs.assets.staff_advances, E.staffAdv, "BS staff"); near(ov.owed_to_us.staff_advances, E.staffAdv, "overview staff");
  near(ov.dues.receivable_total, E.khata + E.wsDue + E.thkDue + E.staffAdv, "dues receivable (760,000)");

  // payables
  near(bs.liabilities.suppliers, E.supPump, "BS suppliers (pump)"); near(bs.liabilities.bypass_suppliers, E.supBypass, "BS bypass suppliers");
  near(bs.liabilities.investors, E.investor, "BS investors"); near(ov.we_owe.investors, E.investor, "overview investors");
  near(bs.liabilities.unused_coupons, E.coupons, "BS coupons"); near(ov.we_owe.unused_coupons, E.coupons, "overview coupons");
  near(ov.dues.payable_total, E.supPump + E.supBypass + E.investor, "dues payable (2,149,000)");
  near((await supOwed(ids.sup)).total_owed, E.supPump + E.supBypass, "PSO total owed");

  // stock
  near(await tankL(ids.tankP), E.tankP, "petrol tank"); near(await tankL(ids.tankD), E.tankD, "diesel tank");
  near(bs.assets.fuel_stock, E.tankP * 285 + E.tankD * 265, "BS fuel stock at cost"); // 5,955,680
  near(bs.assets.shop_stock, 8 * 1000, "BS shop stock"); near(bs.assets.bypass_stock, 0, "bypass stock all dropped");

  // P&L (this month)
  near(pl.income.fuel_retail, H.retail, "P&L retail"); near(pl.income.fuel_wholesale, H.wholesale, "P&L wholesale");
  near(pl.income.shop, H.shop, "P&L shop"); near(pl.income.total, revenue, "P&L income");
  near(pl.cost_of_sales.fuel, H.fuelCost, "P&L fuel cost"); near(pl.cost_of_sales.shop, H.shopCost, "P&L shop cost");
  near(pl.gross_profit, gross, "P&L gross profit");
  near(pl.other_income_ceo, 4000, "P&L CEO other income");
  near(pl.expenses.by_category.find((x: any) => x.category === "Investor profit share")?.amount ?? 0, 22000, "investor share is an expense");
  near(pl.expenses.by_category.find((x: any) => x.category === "Salaries & wages")?.amount ?? 0, 30000, "salary expense (gross)");
  assert.equal(ov.month.gross_profit, pl.gross_profit, "overview month == P&L");
  assert.equal(ov.month.net_profit, pl.net_profit, "overview month == P&L");
  near(ov.investors.owed, E.investor, "overview investors summary"); near(ov.investors.capital_in, 1000000, "investor capital in");
});

/* ---------------- bugs this test pump found (now fixed): the right figures are asserted ---------------- */
test("fixed: P&L net profit counts shop rent twice", async () => {
  const { pl } = ok(await call("admin", "GET", `/api/analysis/pl?month=${today().slice(0, 7)}`), "pl");
  // system shows -2,350: rent 15,000 is in other_income twice (rentalIncome 15,000 + "Other income" ledger account in MISC)
  near(pl.net_profit, net, "net profit (-17,350)");
});

test("fixed: wholesale margin line costs bypass litres at tank avg cost", async () => {
  const { pl } = ok(await call("admin", "GET", `/api/analysis/pl?month=${today().slice(0, 7)}`), "pl");
  near(pl.wholesale_margin.cost, 1000 * 265 + 2000 * 262, "wholesale cost 789,000");
  near(pl.wholesale_margin.profit, 10000 + 26000, "wholesale margin 36,000");
});

test("fixed: overview owed_to_us / we_owe leave out carriage receivable and bypass supplier payable", async () => {
  const ov = ok(await call("admin", "GET", "/api/owner/overview"), "overview");
  near(ov.owed_to_us.total, E.khata + E.wsDue + E.thkDue + E.staffAdv, "owed to us incl. kiraya 15,000");
  near(ov.we_owe.suppliers + ov.we_owe.bypass_suppliers, E.supPump + E.supBypass, "we owe suppliers incl. bypass 324,000"); near(ov.we_owe.bypass_suppliers, E.supBypass);
});

test("fixed: balance sheet misses unlinked card money, wallet balances and output sales tax", async () => {
  const { balance_sheet: bs } = ok(await call("admin", "GET", "/api/analysis/pl?month=" + today().slice(0, 7)), "pl");
  const a = Object.values(bs.assets as Record<string, number>).reduce((x, v) => x + v, 0);
  near(a, E.cash + E.bank + E.tankP * 285 + E.tankD * 265 + 8000 + E.khata + E.wsDue + E.thkDue + E.staffAdv + 14000, "assets incl. card 14,000");
  near(bs.liabilities.customer_wallets, E.wallet, "wallet 2,800 is owed to Ali"); assert.ok(bs.liabilities.sales_tax_payable > 0, "shop sales tax owed");
});
