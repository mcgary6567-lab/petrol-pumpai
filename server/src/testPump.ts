/**
 * "Test pump": a fresh pump with a user of every role and ONE entry of every kind, each with the figure it should produce —
 * so an owner can check the system's arithmetic against a hand calculation. Runs through the public HTTP API exactly as the
 * screens do (nothing bypasses the rules), against this server itself (platform button) or any base URL (tests, scripts).
 *
 * Every step records: what was entered, what we expect (worked out by hand here), what the system shows, and whether they match.
 */
type Res = { status: number; data: any };
export type Step = { n: number; title: string; entry: string; expect: string; actual: string; ok: boolean };
export type TestPumpReport = { pump: { name: string; slug: string | null; url: string | null }; logins: { role: string; name: string; email: string; password: string; pin: string }[]; steps: Step[]; summary: { ok: number; failed: number }; totals: Record<string, number> };

const fmt = (n: number) => Math.round(n).toLocaleString("en-PK");
const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

export async function runTestPump(base: string, opts: { tag?: string; publicUrl?: string } = {}): Promise<TestPumpReport> {
  const tag = opts.tag ?? new Date().toISOString().slice(5, 16).replace(/[-T:]/g, "");
  const tokens: Record<string, string> = {};
  const call = async (who: string, method: string, url: string, body?: unknown): Promise<Res> => {
    const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  const must = async (r: Promise<Res>, what: string) => { const x = await r; if (x.status !== 200) throw new Error(`${what}: ${x.status} ${JSON.stringify(x.data)}`); return x.data; };
  const steps: Step[] = [];
  let n = 0;
  const check = (title: string, entry: string, expect: string, actual: string, ok: boolean) => { steps.push({ n: ++n, title, entry, expect, actual, ok }); };
  const money = async () => (await must(call("admin", "GET", "/api/owner/overview"), "overview")).money;
  const khataBal = async (id: number) => (await must(call("admin", "GET", `/api/customers/${id}`), "customer")).balance as number;
  const supOwed = async (id: number) => { const s = (await must(call("admin", "GET", "/api/suppliers"), "suppliers")).find((x: any) => x.id === id); return { pump: s.owed as number, bypass: s.bypass_owed as number, total: s.total_owed as number }; };
  const clientDue = async (id: number) => (await must(call("wholesale", "GET", `/api/wholesale/clients/${id}`), "client")).summary.due as number;
  const tankL = async (id: number) => { const sts = await must(call("admin", "GET", "/api/stations"), "stations"); return sts.flatMap((x: any) => x.tanks).find((x: any) => x.id === id).current_l as number; };
  const bankBal = async (id: number) => (await must(call("admin", "GET", "/api/bank/accounts"), "banks")).accounts.find((a: any) => a.id === id).balance as number;
  const books = async () => { const r = await must(call("admin", "GET", "/api/books/check"), "books"); return { ok: r.ok as boolean, failed: (r.failed ?? []) as string[] }; };

  // ---------- 1. the pump + one user per role ----------
  const name = `Test Pump ${tag}`;
  const email = (r: string) => `${r}.testpump${tag}@test.pk`;
  const PW = "test1234", PINS: Record<string, string> = { admin: "1111", manager: "2222", cashier: "3333", salesman: "4444", wholesale: "5555" };
  const signup = await must(call("", "POST", "/api/signup", {
    business: { name, owner_name: "Test Owner", owner_phone: "03000000001", biz_city: "Lahore" },
    admin: { name: "Test CEO", email: email("ceo"), password: PW, pin: PINS.admin, phone: "03000000001" },
    stations: [{ name: "Test Station", city: "Lahore", tanks: [
      { name: "Tank-1 Petrol", product: "PMG", capacity_l: 30000, current_l: 10000, nozzles: 2 },
      { name: "Tank-2 Diesel", product: "HSD", capacity_l: 30000, current_l: 8000, nozzles: 2 }] }],
    prices: { PMG: 300, HSD: 280 }, modules: { wholesale: true },
  }), "signup");
  tokens.admin = signup.token;
  const me = await must(call("admin", "GET", "/api/me"), "me");
  const slug = me.tenant?.slug ?? null;
  const st = (await must(call("admin", "GET", "/api/stations"), "stations"))[0];
  const tankP = st.tanks.find((t: any) => t.product === "PMG").id, tankD = st.tanks.find((t: any) => t.product === "HSD").id;
  const logins = [{ role: "CEO (admin)", name: "Test CEO", email: email("ceo"), password: PW, pin: PINS.admin }];
  for (const [role, nm] of [["manager", "Test Manager"], ["cashier", "Test Cashier"], ["salesman", "Test Salesman"], ["wholesale", "Test Wholesale"]] as const) {
    await must(call("admin", "POST", "/api/users", { name: nm, email: email(role), password: PW, role, station_id: st.id, phone: `0300000000${role.length}`, pin: PINS[role] }), `user ${role}`);
    logins.push({ role, name: nm, email: email(role), password: PW, pin: PINS[role] });
  }
  for (const role of ["manager", "cashier", "salesman", "wholesale"]) tokens[role] = (await must(call("", "POST", "/api/auth/login", { email: email(role), password: PW }), `login ${role}`)).token;
  check("Pump aur 5 users", `Pump "${name}", station, 2 tanks (Petrol 10,000 L, Diesel 8,000 L), rates Petrol 300 / Diesel 280; users: CEO, manager, cashier, salesman, wholesale`, "Sab login karein", `5/5 login OK`, true);

  // ---------- 2. opening balances ----------
  await must(call("admin", "POST", "/api/opening/fuel-rates", { rows: [{ product: "PMG", rate: 285 }, { product: "HSD", rate: 265 }] }), "fuel rates");
  const fuelValue = 10000 * 285 + 8000 * 265; // 4,970,000
  const gl = await must(call("admin", "GET", "/api/opening"), "opening");
  const fvSum = (gl.fuel_values ?? []).reduce((a: number, f: any) => a + (f.opening?.amount ?? 0), 0);
  check("Opening fuel cost", "Petrol 10,000 L @ 285, Diesel 8,000 L @ 265", `Stock value ${fmt(fuelValue)}`, `Stock value ${fmt(fvSum)}`, near(fvSum, fuelValue));
  await must(call("cashier", "POST", "/api/cash/count", { amount: 200000, note: "opening cash" }), "cash count");
  const hbl = (await must(call("admin", "POST", "/api/bank/accounts", { bank: "HBL", title: "Test Pump", account_no: "0011223344", kind: "current", opening_balance: 1000000 }), "bank")).id as number;
  const cust = (await must(call("admin", "POST", "/api/customers", { name: "Ali Transport", type: "fleet", phone: "03001234501", credit_limit: 500000 }), "customer")).id as number;
  await must(call("admin", "POST", "/api/opening/khata", { rows: [{ customer_id: cust, amount: 50000 }] }), "khata opening");
  const sup = (await must(call("admin", "POST", "/api/suppliers", { name: "PSO Depot", phone: "03001234502", opening_balance: 100000 }), "supplier")).id as number;
  const m0 = await money();
  check("Opening cash, bank, khata, supplier", "Cash count 200,000; HBL opening 1,000,000; Ali Transport purana baqaya 50,000; PSO Depot ko purana dena 100,000",
    "Office cash 200,000 · bank 1,000,000 · Ali khata 50,000 · PSO owed 100,000",
    `Office cash ${fmt(m0.office_cash)} · bank ${fmt(m0.banks)} · Ali khata ${fmt(await khataBal(cust))} · PSO owed ${fmt((await supOwed(sup)).total)}`,
    near(m0.office_cash, 200000) && near(m0.banks, 1000000) && near(await khataBal(cust), 50000) && near((await supOwed(sup)).total, 100000));

  // ---------- 3. tanker delivery + supplier payment ----------
  await must(call("manager", "POST", "/api/stock/delivery", { tank_id: tankD, invoice_l: 5000, received_l: 5000, supplier_id: sup, purchase_rate: 265, tanker_no: "TLR-100" }), "delivery");
  check("Tanker delivery", "Diesel 5,000 L @ 265 from PSO Depot into Tank-2", "Tank-2 13,000 L · PSO owed 100,000 + 1,325,000 = 1,425,000",
    `Tank-2 ${fmt(await tankL(tankD))} L · PSO owed ${fmt((await supOwed(sup)).total)}`, near(await tankL(tankD), 13000) && near((await supOwed(sup)).total, 1425000));
  await must(call("cashier", "POST", "/api/cashier/pay", { party_type: "supplier", party_id: sup, amount: 400000, method: "Bank transfer", account_id: hbl, ref: "PO-1" }), "pay supplier");
  check("Supplier payment (bank)", "Cashier pays PSO Depot 400,000 by bank transfer (HBL)", "PSO owed 1,025,000 · HBL 600,000",
    `PSO owed ${fmt((await supOwed(sup)).total)} · HBL ${fmt(await bankBal(hbl))}`, near((await supOwed(sup)).total, 1025000) && near(await bankBal(hbl), 600000));

  // ---------- 4. salesman shift: cash, card, khata sale, expense, close, handover ----------
  const sh = await must(call("salesman", "POST", "/api/shifts/open", {}), "open shift");
  await must(call("salesman", "POST", "/api/sales", { station_id: st.id, product: "PMG", litres: 100, payment_method: "cash" }), "cash sale");
  await must(call("salesman", "POST", "/api/sales", { station_id: st.id, product: "HSD", litres: 50, payment_method: "card" }), "card sale");
  await must(call("salesman", "POST", "/api/sales", { station_id: st.id, product: "HSD", litres: 100, payment_method: "khata", customer_id: cust, vehicle_no: "LEA-786" }), "khata sale");
  await must(call("salesman", "POST", `/api/shifts/${sh.id}/expenses`, { category: "Tea & food", new_category: true, amount: 500, note: "chai" }), "shift expense");
  const live = await must(call("salesman", "GET", `/api/shifts/${sh.id}/live`), "live");
  const readings: Record<string, number> = {}; for (const r of live.readings) readings[r.nozzle_id] = Number(r.closing ?? r.opening ?? 0);
  const prev = await must(call("salesman", "POST", `/api/shifts/${sh.id}/preview`, { readings }), "preview");
  check("Shift sales", "Cash Petrol 100 L @300 = 30,000; Card Diesel 50 L @280 = 14,000; Khata Diesel 100 L @280 = 28,000 (Ali Transport); chai kharcha 500 cash se",
    "Cash to hand over 30,000 − 500 = 29,500 · Ali khata 50,000 + 28,000 = 78,000", `Cash expected ${fmt(prev.cash_expected)} · Ali khata ${fmt(await khataBal(cust))}`,
    near(prev.cash_expected, 29500) && near(await khataBal(cust), 78000));
  await must(call("salesman", "POST", `/api/shifts/${sh.id}/close`, { readings, cash_actual: prev.cash_expected }), "close");
  const pend = await must(call("cashier", "GET", "/api/cashier/handovers"), "handovers");
  if ((pend.pending ?? []).some((x: any) => x.id === sh.id)) await must(call("cashier", "POST", `/api/cashier/handovers/${sh.id}`, { amount: prev.cash_expected }), "handover");
  const m1 = await money();
  check("Shift close + handover", "Meter readings close, 29,500 cash counted, cashier ne wasool kiya", "Office cash 200,000 + 29,500 = 229,500 · Tank-1 9,900 L · Tank-2 12,850 L",
    `Office cash ${fmt(m1.office_cash)} · Tank-1 ${fmt(await tankL(tankP))} L · Tank-2 ${fmt(await tankL(tankD))} L`, near(m1.office_cash, 229500) && near(await tankL(tankP), 9900) && near(await tankL(tankD), 12850));

  // ---------- 5. khata receipt ----------
  await must(call("cashier", "POST", "/api/cashier/receive", { party_type: "khata", party_id: cust, amount: 20000, method: "Cash", notify: false }), "khata receive");
  check("Khata wasooli", "Ali Transport ne 20,000 cash diya (cashier)", "Ali khata 58,000 · office cash 249,500", `Ali khata ${fmt(await khataBal(cust))} · office cash ${fmt((await money()).office_cash)}`,
    near(await khataBal(cust), 58000) && near((await money()).office_cash, 249500));

  // ---------- 6. shop: item, stock-in (cash), counter sale ----------
  const oil = (await must(call("admin", "POST", "/api/shop/items", { station_id: st.id, name: "Engine Oil 1L", category: "lubricant", cost: 1000, price: 1300 }), "item")).id as number;
  await must(call("manager", "POST", `/api/shop/items/${oil}/stock-in`, { qty: 10, cost: 1000, paid_by: "cash" }), "stock-in");
  await must(call("admin", "POST", "/api/shop/sales", { station_id: st.id, payment_method: "cash", lines: [{ item_id: oil, qty: 2 }] }), "shop sale");
  check("Shop", "Engine Oil 1L: cost 1,000, price 1,300; 10 stock-in cash se (10,000); 2 bikay cash (2,600)", "Office cash 249,500 − 10,000 + 2,600 = 242,100 · shop munafa 600",
    `Office cash ${fmt((await money()).office_cash)}`, near((await money()).office_cash, 242100));

  // ---------- 7. wholesale: client, trip from our tank, bank receipt ----------
  const ws = (await must(call("admin", "POST", "/api/wholesale/clients", { name: "Khan Filling Station", phone: "03001234503", rates: { HSD: 275 } }), "client")).id as number;
  const trip = await must(call("wholesale", "POST", "/api/wholesale/trips", { station_id: st.id, product: "HSD", vehicle_no: "TLR-200", drops: [{ client_id: ws, litres: 1000, override_limit: true }] }), "trip");
  const billed = trip.drops[0].amount as number;
  await must(call("cashier", "POST", "/api/cashier/receive", { party_type: "wholesale", party_id: ws, amount: 100000, method: "Bank transfer", account_id: hbl, notify: false }), "ws receipt");
  check("Wholesale supply (apne tank se)", "Khan Filling: rate Diesel 275; tanker 1,000 L Tank-2 se; 100,000 bank me aaya", "Billed 275,000 · due 175,000 · Tank-2 11,850 L · HBL 700,000 · munafa (275−265)×1,000 = 10,000",
    `Billed ${fmt(billed)} · due ${fmt(await clientDue(ws))} · Tank-2 ${fmt(await tankL(tankD))} L · HBL ${fmt(await bankBal(hbl))}`,
    near(billed, 275000) && near(await clientDue(ws), 175000) && near(await tankL(tankD), 11850) && near(await bankBal(hbl), 700000));

  // ---------- 8. bypass: depot → client, supplier paid ----------
  const byp = await must(call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st.id, purchases: [{ supplier_id: sup, product: "HSD", litres: 2000, cost_rate: 262, ref: "BILTY-9" }], drops: [{ client_id: ws, product: "HSD", litres: 2000, override_limit: true }] }), "bypass");
  await must(call("wholesale", "POST", `/api/bypass/suppliers/${sup}/payment`, { amount: 200000, mode: "we_pay", method: "Bank transfer", account_id: hbl, ref: "PO-2" }), "pay bypass supplier");
  const so = await supOwed(sup);
  check("Bypass delivery", "PSO Depot se 2,000 L Diesel @262 (524,000) seedha Khan Filling ko @275 (550,000); depot ko 200,000 bank se", "Munafa 26,000 · Khan due 725,000 · PSO: pump 1,025,000 + bypass 324,000 = 1,349,000 · HBL 500,000",
    `Munafa ${fmt(byp.margin)} · Khan due ${fmt(await clientDue(ws))} · PSO ${fmt(so.pump)} + ${fmt(so.bypass)} = ${fmt(so.total)} · HBL ${fmt(await bankBal(hbl))}`,
    near(byp.margin, 26000) && near(await clientDue(ws), 725000) && near(so.total, 1349000) && near(await bankBal(hbl), 500000));

  // ---------- 9. carriage / kiraya ----------
  const thk = (await must(call("wholesale", "POST", "/api/carriage/thekedars", { name: "Bashir Thekedar", phone: "03001234504" }), "thekedar")).id as number;
  await must(call("wholesale", "POST", `/api/carriage/thekedars/${thk}/carriage`, { supplier_id: sup, invoice_ref: "DEP-55", amount: 25000, lines: [{ product: "HSD", litres: 5000 }] }), "kiraya");
  await must(call("wholesale", "POST", `/api/carriage/thekedars/${thk}/payment`, { amount: 10000, method: "Cash", notify: false }), "kiraya receipt");
  const thkDue = (await must(call("wholesale", "GET", `/api/carriage/thekedars/${thk}`), "thekedar")).closing_balance as number;
  check("Carriage (kiraya)", "Bashir Thekedar: 5,000 L Diesel humari depot ID par, kiraya 25,000; 10,000 cash diya", "Baqaya 15,000 · office cash 252,100 · kiraya income 25,000",
    `Baqaya ${fmt(thkDue)} · office cash ${fmt((await money()).office_cash)}`, near(thkDue, 15000) && near((await money()).office_cash, 252100));

  // ---------- 10. expense, staff advance, bank deposit ----------
  await must(call("cashier", "POST", "/api/cashier/pay", { party_type: "other", party_name: "LESCO", category: "Electricity (bijli)", amount: 3000, method: "Cash" }), "expense");
  const smId = (await must(call("admin", "GET", "/api/users"), "users")).users.find((u: any) => u.role === "salesman").id;
  await must(call("manager", "POST", `/api/staff/${smId}/entry`, { type: "advance", amount: 5000, method: "cash", note: "advance" }), "advance");
  await must(call("manager", "POST", "/api/cash/deposits", { amount: 50000, bank: "HBL", account_id: hbl, slip_ref: "DS-1" }), "deposit");
  const m2 = await money();
  check("Kharcha, staff advance, bank deposit", "Bijli 3,000 cash; salesman ko 5,000 advance cash; 50,000 cash bank me jama", "Office cash 252,100 − 3,000 − 5,000 − 50,000 = 194,100 · HBL 550,000 · staff advance 5,000",
    `Office cash ${fmt(m2.office_cash)} · HBL ${fmt(m2.banks)}`, near(m2.office_cash, 194100) && near(m2.banks, 550000));

  // ---------- 11. the whole picture ----------
  const ov = await must(call("admin", "GET", "/api/owner/overview"), "overview");
  const expectMoney = 194100 + 550000;
  check("Aap ka paisa abhi (dashboard)", "Office cash + salesmen + banks", `${fmt(expectMoney)} (194,100 + 0 + 550,000)`, `${fmt(ov.money.total)} (${fmt(ov.money.office_cash)} + ${fmt(ov.money.with_salesmen)} + ${fmt(ov.money.banks)})`, near(ov.money.total, expectMoney));
  const rec = ov.dues.receivable_total, pay = ov.dues.payable_total;
  check("Lena / dena (dashboard)", "Lena: Ali 58,000 + Khan 725,000 + Bashir 15,000 + staff advance 5,000 · Dena: PSO 1,349,000", "Lena 803,000 · dena 1,349,000", `Lena ${fmt(rec)} · dena ${fmt(pay)}`, near(rec, 803000) && near(pay, 1349000));
  const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10);
  const { pl } = await must(call("admin", "GET", `/api/analysis/pl?month=${today.slice(0, 7)}`), "pl");
  // revenue 72,000 retail + 275,000 wholesale + 550,000 bypass + 2,600 shop = 899,600; fuel cost 100×285 + 1,150×265 + 524,000 = 28,500 + 304,750 + 524,000 = 857,250; shop cost 2,000
  const expGross = 899600 - 857250 - 2000; // 40,350
  check("Gross profit (P&L, is mahina)", "Sales 899,600 (fuel 72,000 + wholesale 275,000 + bypass 550,000 + shop 2,600) − fuel cost 857,250 − shop cost 2,000", `${fmt(expGross)}`, `${fmt(pl.gross_profit)}`, near(pl.gross_profit, expGross, 5));
  const expNet = expGross - 3500 + 25000; // expenses 500 + 3,000; kiraya income 25,000
  check("Net profit (P&L)", "Gross 40,350 − kharche 3,500 (chai 500 + bijli 3,000) + kiraya 25,000", `${fmt(expNet)}`, `${fmt(pl.net_profit)}`, near(pl.net_profit, expNet, 5));
  const bk = await books();
  check("Books check (double-entry tally)", "Har balance apne ledger account se", "0 farq, sab OK", bk.ok ? "0 farq, sab OK" : `FAIL: ${bk.failed.join(", ")}`, bk.ok);

  const totals = { office_cash: ov.money.office_cash, banks: ov.money.banks, money_total: ov.money.total, receivable: rec, payable: pay, gross_profit: pl.gross_profit, net_profit: pl.net_profit, fuel_stock_value: fvSum };
  return { pump: { name, slug, url: slug && opts.publicUrl ? `${opts.publicUrl}/p/${slug}` : null }, logins, steps, summary: { ok: steps.filter((s) => s.ok).length, failed: steps.filter((s) => !s.ok).length }, totals };
}
