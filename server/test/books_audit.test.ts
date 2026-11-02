/** Hisaab audit: drive the API on the seeded demo DB, re-run /books/check after each flow, report farq / 500s. */
import { test, before, after } from "node:test";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync("/tmp/pumpai-audit-");
process.env.DB_PATH = `${dir}/test.db`;
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server, base = "";
const tok: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${tok[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const findings: string[] = [];
const log = (s: string) => { console.log("  >> " + s); };
const flag = (s: string) => { findings.push(s); console.log("  !! " + s); };
const ok = (r: { status: number; data: any }, m: string) => { if (r.status !== 200) flag(`${m}: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); return r.data; };

let db: any;
async function check(label: string) {
  const r = await call("admin", "GET", "/api/books/check");
  if (r.status !== 200) { flag(`${label}: /books/check HTTP ${r.status}`); return; }
  const J = r.data;
  const bad = J.checks.filter((c: any) => !c.ok && !c.advisory);
  const adv = J.checks.filter((c: any) => !c.ok && c.advisory);
  if (bad.length) flag(`${label}: FARQ max_diff=${J.max_diff} -> ${bad.map((c: any) => `${c.label}: book ${c.book} vs ledger ${c.ledger} (diff ${c.diff})${c.note ? " " + c.note : ""}${c.detail ? " " + JSON.stringify(c.detail) : ""}`).join(" | ")}`);
  else log(`${label}: 0 farq (max_diff ${J.max_diff})${adv.length ? ` [advisory: ${adv.map((c: any) => `${c.label} diff ${c.diff}`).join("; ")}]` : ""}`);
  // also the GL per-voucher balance
  const gl = J.checks[0];
  if (Math.abs(gl.diff) > 0.005) flag(`${label}: GL debit≠credit by ${gl.diff}`);
}

before(async () => {
  const { app } = await import("/home/user/petrol-pumpai/server/src/index.ts");
  db = await import("/home/user/petrol-pumpai/server/src/db.ts");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman", "cashier", "wholesale"]) tok[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server.close(); console.log("\n==== FINDINGS ====\n" + (findings.length ? findings.map((f, i) => `${i + 1}. ${f}`).join("\n") : "none")); });

test("0 baseline demo DB", async () => {
  await check("baseline");
  const L = await call("admin", "GET", "/api/ledger");
  ok(L, "GET /ledger");
  log(`ledger month: ${L.data?.voucher_count} vouchers, totals ${JSON.stringify(L.data?.totals)}`);
  // per voucher debit=credit?
  const J = db.default ? null : null;
  const { journal } = await import("/home/user/petrol-pumpai/server/src/routes/ledger.ts");
  const full = journal(1, "2000-01-01", "2099-01-01");
  let unbalanced = 0, maxv = 0;
  for (const v of full.vouchers) { const d = v.lines.reduce((a: number, l: any) => a + l.debit, 0), c = v.lines.reduce((a: number, l: any) => a + l.credit, 0); if (Math.abs(d - c) > 0.004) { unbalanced++; maxv = Math.max(maxv, Math.abs(d - c)); if (unbalanced <= 5) log(`unbalanced voucher ${v.date} ${v.type} ${v.narration}: dr ${d} cr ${c}`); } }
  log(`full journal ${full.vouchers.length} vouchers, unbalanced ${unbalanced} (max ${maxv}), totals ${JSON.stringify(full.totals)}`);
  if (unbalanced) flag(`journal has ${unbalanced} vouchers whose debit≠credit (max ${maxv})`);
  const susp = full.trial_balance.find((x: any) => x.account === "Suspense");
  if (susp) flag(`Suspense present: ${JSON.stringify(susp)}`);
  log("trial balance accounts: " + full.trial_balance.map((x: any) => `${x.account}=${x.balance}`).join("; "));
});

test("1 cashier receive + pay", async () => {
  const kh = ok(await call("admin", "GET", "/api/cashier/parties?kind=khata"), "parties").khata[0];
  const sup = ok(await call("admin", "GET", "/api/cashier/parties?kind=supplier"), "parties").supplier[0];
  ok(await call("cashier", "POST", "/api/cashier/receive", { party_type: "khata", party_id: kh.id, amount: 5000, method: "Cash" }), "receive khata cash");
  await check("after cashier receive");
  const pay = await call("cashier", "POST", "/api/cashier/pay", { party_type: "supplier", party_id: sup.id, amount: 3000, method: "Cash" });
  if (pay.status === 200 && pay.data.held) log("pay held for approval: " + JSON.stringify(pay.data).slice(0, 200)); else ok(pay, "pay supplier cash");
  await check("after cashier pay");
  // pay more cash than in hand?
  const pos = ok(await call("admin", "GET", "/api/cash"), "cash");
  log(`office cash_in_hand ${pos.cash_in_hand} (last_count ${JSON.stringify(pos.last_count)})`);
  const big = await call("admin", "POST", "/api/cashier/pay", { party_type: "supplier", party_id: sup.id, amount: pos.cash_in_hand + 100000, method: "Cash" });
  log(`overdraw cash pay -> HTTP ${big.status} ${JSON.stringify(big.data).slice(0, 160)}`);
  if (big.status === 200 && !big.data.held) { flag("cashier pay allowed MORE cash than in hand (negative office cash not blocked)"); }
});

test("2 shift open/close + khata cash-back sale", async () => {
  // close any open shift of the salesman first
  const sh = await call("salesman", "POST", "/api/shifts/open", {});
  let shiftId: number;
  if (sh.status !== 200) { log(`open shift: ${sh.status} ${JSON.stringify(sh.data).slice(0, 200)}`); const cur = ok(await call("salesman", "GET", "/api/shifts/current"), "current"); shiftId = cur?.shift?.id ?? cur?.id; } else shiftId = sh.data.id;
  await check("after shift open");
  const live = ok(await call("salesman", "GET", `/api/shifts/${shiftId}/live`), "live");
  const stationId = live.shift.station_id;
  const cust = db.all("SELECT * FROM customers WHERE tenant_id=1 AND credit_limit - balance > 200000 ORDER BY credit_limit - balance DESC LIMIT 1")[0];
  const sale = ok(await call("salesman", "POST", "/api/sales", { station_id: stationId, product: "HSD", litres: 20, payment_method: "khata", customer_id: cust.id, slip_no: "AUD-1", cash_back: 1000, cash_back_litres: 10 }), "khata cash-back sale");
  log(`cash-back sale: amount ${sale?.amount} cash_back ${sale?.cash_back} khareed ${sale?.khareed}`);
  await check("after khata cash-back sale (open shift)");
  // cash sale too so the bag isn't negative
  ok(await call("salesman", "POST", "/api/sales", { station_id: stationId, product: "HSD", litres: 30, payment_method: "cash" }), "cash sale");
  // shop parchi_cash inside the shift
  const item = db.all("SELECT * FROM shop_items WHERE tenant_id=1 AND station_id=? AND active=1 AND price>0 ORDER BY price DESC LIMIT 1", stationId)[0];
  if (item) {
    // the parchi cash may not exceed the salesman's bag (shiftSummary.cash_expected) — stay inside it
    const bag = Number((ok(await call("salesman", "GET", `/api/shifts/${shiftId}/live`), "live-bag")).summary?.cash_expected ?? 0);
    const p = ok(await call("salesman", "POST", "/api/shop/sales", { station_id: stationId, lines: [{ item_id: item.id, qty: 2 }], payment_method: "khata", customer_id: cust.id, parchi_cash: true, cash_back: Math.max(0, Math.min(item.price * 2 - 100, Math.floor(bag) - 100)), slip_no: "AUD-P1" }), "shop parchi_cash (shift)");
    log(`shop parchi (shift): total ${p?.total} cash_back ${p?.cash_back} khareed ${p?.khareed} kind ${p?.kind} shift ${p?.shift_id}`);
    await check("after shop parchi_cash in shift");
    const sum = ok(await call("salesman", "GET", `/api/shifts/${shiftId}/live`), "live2");
    log(`shift summary: cash_sales ${sum.summary?.cash_sales} khata_cashback ${sum.summary?.khata_cashback} cash_expected ${sum.summary?.cash_expected} shop_parchi ${JSON.stringify(sum.summary?.shop_parchi)}`);
    // undo parchi
    ok(await call("salesman", "POST", `/api/shop/sales/${p.id}/undo`, {}), "undo parchi");
    await check("after undo shop parchi_cash");
    // redo for the close
    ok(await call("salesman", "POST", "/api/shop/sales", { station_id: stationId, lines: [{ item_id: item.id, qty: 1 }], payment_method: "khata", customer_id: cust.id, parchi_cash: true, slip_no: "AUD-P2" }), "shop parchi_cash 2");
  }
  // close the shift
  const readings: Record<string, number> = {};
  for (const n of live.nozzles ?? live.readings ?? []) readings[String(n.nozzle_id ?? n.id)] = (n.opening ?? 0) + (n.sold_l ?? 0);
  const live3 = ok(await call("salesman", "GET", `/api/shifts/${shiftId}/live`), "live3");
  for (const n of live3.nozzles ?? live3.readings ?? []) readings[String(n.nozzle_id ?? n.id)] = Number(n.current ?? n.expected_closing ?? n.closing ?? (n.opening + (n.litres ?? 0)));
  log(`readings ${JSON.stringify(readings)} nozzle keys ${JSON.stringify(Object.keys((live3.nozzles ?? live3.readings ?? [{}])[0] ?? {}))}`);
  const prev = await call("salesman", "POST", `/api/shifts/${shiftId}/preview`, { readings });
  if (prev.status !== 200) { flag(`shift preview: HTTP ${prev.status} ${JSON.stringify(prev.data).slice(0, 300)}`); return; }
  const closed = ok(await call("salesman", "POST", `/api/shifts/${shiftId}/close`, { readings, cash_actual: Math.max(0, prev.data.cash_expected - 50) }), "close shift");
  log(`closed: expected ${closed?.shift?.cash_expected ?? closed?.cash_expected} actual ${closed?.shift?.cash_actual} variance ${closed?.shift?.variance}`);
  await check("after shift close (short 50)");
  // handover
  // CEO voids the khata cash-back sale that sat on the now-CLOSED shift
  const cv = await call("admin", "POST", `/api/corrections/sale/${sale.id}/void`, { reason: "audit closed-shift cashback void" });
  log(`corrections void of closed-shift cash-back sale -> ${cv.status} ${JSON.stringify(cv.data).slice(0, 200)}`);
  await check("after void of closed-shift khata cash-back sale");
  const hv = ok(await call("cashier", "GET", "/api/cashier/handovers"), "handovers");
  const pend = (hv.pending ?? []).find((s: any) => s.id === shiftId);
  if (pend) { ok(await call("cashier", "POST", `/api/cashier/handovers/${shiftId}`, { amount: Math.max(0, (pend.cash_actual ?? 0) - 20) }), "handover"); await check("after handover (short 20)"); }
  else log("handover mode off or shift not pending: " + JSON.stringify(hv).slice(0, 150));
});

test("3 shop parchi_cash at the counter (no open shift) → office cash", async () => {
  // find a station with no open shift
  const st = db.all("SELECT s.* FROM stations s WHERE s.tenant_id=1 AND NOT EXISTS (SELECT 1 FROM shifts sh WHERE sh.station_id=s.id AND sh.status='open')");
  if (!st.length) { log("every station has an open shift; closing not attempted"); return; }
  const stationId = st[0].id;
  const cust = db.all("SELECT * FROM customers WHERE tenant_id=1 AND credit_limit - balance > 200000 ORDER BY credit_limit - balance DESC LIMIT 1")[0];
  let item = db.all("SELECT * FROM shop_items WHERE tenant_id=1 AND station_id=? AND active=1 ORDER BY price DESC LIMIT 1", stationId)[0];
  if (!item) item = ok(await call("admin", "POST", "/api/shop/items", { station_id: stationId, name: "Audit oil", category: "lubricant", cost: 500, price: 900, stock: 5 }), "item");
  const before = ok(await call("admin", "GET", "/api/cash"), "cash").cash_in_hand;
  const p = ok(await call("admin", "POST", "/api/shop/sales", { station_id: stationId, lines: [{ item_id: item.id, qty: 3 }], payment_method: "khata", customer_id: cust.id, parchi_cash: true, cash_back: item.price * 3 - 50, slip_no: "AUD-C1" }), "shop parchi_cash (counter)");
  log(`counter parchi: total ${p?.total} cash_back ${p?.cash_back} shift_id ${p?.shift_id}`);
  const after = ok(await call("admin", "GET", "/api/cash"), "cash").cash_in_hand;
  log(`office cash before ${before} after ${after} (expected drop ${p?.cash_back})`);
  if (Math.abs((before - after) - (p?.cash_back ?? 0)) > 0.01) flag(`counter shop parchi_cash: office cashPosition moved ${before - after} but cash_back was ${p?.cash_back} — cashFlows ignores shop_sales.cash_back (backoffice.ts:71 only reads sales)`);
  await check("after counter shop parchi_cash");
  const dayb = ok(await call("cashier", "GET", `/api/cashier/daybook?date=${db.pkDate()}`), "daybook");
  log(`daybook counted-diff line present? ${JSON.stringify((dayb.rows ?? []).filter((r: any) => r.dir === "count").slice(-1))} totals ${JSON.stringify(dayb.totals)}`);
  ok(await call("admin", "POST", `/api/shop/sales/${p.id}/undo`, {}), "undo counter parchi");
  await check("after undo counter parchi");
  // over-draw: parchi cash more than office cash?
  const pos = ok(await call("admin", "GET", "/api/cash"), "cash");
  const big = await call("admin", "POST", "/api/shop/sales", { station_id: stationId, lines: [{ item_id: item.id, qty: 1000 }], payment_method: "khata", customer_id: cust.id, parchi_cash: true, cash_back: pos.cash_in_hand + 50000, slip_no: "AUD-C2" });
  log(`parchi cash > office cash -> ${big.status} ${JSON.stringify(big.data).slice(0, 160)}`);
  if (big.status === 200) { flag("counter shop parchi_cash: no check against office cash in hand (negative cash possible)"); ok(await call("admin", "POST", `/api/shop/sales/${big.data.id}/undo`, {}), "undo"); }
});

test("4 investor transfers", async () => {
  const inv = ok(await call("admin", "POST", "/api/investors", { name: "Audit Investor", our_pct: 60 }), "add investor");
  const sups = ok(await call("admin", "GET", "/api/suppliers"), "suppliers");
  const S = (Array.isArray(sups) ? sups : sups.suppliers).sort((a: any, b: any) => (b.owed ?? 0) - (a.owed ?? 0))[0];
  log(`supplier ${S.name} owed ${S.owed}`);
  // with cash
  const x1 = await call("admin", "POST", `/api/investors/${inv.id}/transfer`, { direction: "supplier_to_investor", party_type: "supplier", party_id: S.id, amount: 20_000, with_cash: true, method: "Cash" });
  ok(x1, "supplier_to_investor with cash");
  await check("after investor transfer with cash");
  ok(await call("admin", "POST", `/api/investor-transfers/${x1.data.id}/void`, { reason: "audit void" }), "void with-cash xfer");
  await check("after void of with-cash transfer");
  // without cash (book transfer) — needs owed
  if ((S.owed ?? 0) > 1000) {
    const x2 = ok(await call("admin", "POST", `/api/investors/${inv.id}/transfer`, { direction: "supplier_to_investor", party_type: "supplier", party_id: S.id, amount: Math.min(10_000, Math.floor(S.owed)) }), "supplier_to_investor book");
    await check("after book transfer");
    ok(await call("admin", "POST", `/api/investor-transfers/${x2.id}/void`, { reason: "audit void" }), "void book xfer");
    await check("after void book transfer");
  }
  // with cash + backdated
  const x3 = await call("admin", "POST", `/api/investors/${inv.id}/transfer`, { direction: "supplier_to_investor", party_type: "supplier", party_id: S.id, amount: 5_000, with_cash: true, method: "Cash", txn_date: new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10) });
  ok(x3, "with cash backdated");
  if (x3.status === 200) {
    const rows = db.all("SELECT id, direction, party_type, amount, created_at FROM cashier_vouchers WHERE tenant_id=1 ORDER BY id DESC LIMIT 2");
    log("backdated xfer vouchers: " + JSON.stringify(rows));
    if (rows.length === 2 && rows[0].created_at.slice(0, 10) !== rows[1].created_at.slice(0, 10)) flag(`backdated with-cash investor transfer: the two cash vouchers sit on different days (${rows.map((r: any) => r.created_at.slice(0, 10)).join(" vs ")}) — only the investor leg is backdated (investors.ts:491)`);
    await check("after backdated with-cash transfer");
  }
  // investor_to_client with cash (receive from khata customer, pay investor)
  const cust = db.all("SELECT * FROM customers WHERE tenant_id=1 AND balance > 5000 ORDER BY balance DESC LIMIT 1")[0];
  const x4 = await call("admin", "POST", `/api/investors/${inv.id}/transfer`, { direction: "investor_to_client", party_type: "khata", party_id: cust.id, amount: 4_000, with_cash: true, method: "Cash", purpose: "capital" });
  ok(x4, "investor_to_client with cash");
  await check("after investor_to_client with cash");
  if (x4.status === 200) { ok(await call("admin", "POST", `/api/investor-transfers/${x4.data.id}/void`, { reason: "audit void" }), "void"); await check("after void investor_to_client"); }
});

test("5 bypass delivery + whole-voucher void + to-client + recost", async () => {
  const st = ok(await call("admin", "GET", "/api/stations"), "stations")[0];
  const clients = ok(await call("wholesale", "GET", "/api/wholesale/clients"), "clients").filter((c: any) => c.rates?.HSD);
  const [W1, W2] = clients;
  const bsup = ok(await call("wholesale", "GET", "/api/bypass/suppliers"), "bsup");
  const S = bsup[0], S2 = bsup[1] ?? bsup[0];
  const stock0 = ok(await call("wholesale", "GET", "/api/bypass/stock"), "stock0").total;
  log(`bypass stock before: ${JSON.stringify(stock0)}`);
  const d1 = ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st.id,
    purchases: [{ supplier_id: S.id, product: "HSD", litres: 1000, cost_rate: 250 }],
    drops: [{ client_id: W1.id, product: "HSD", litres: 700, override_limit: true }] }), "bypass delivery 1 (300 L held)");
  await check("after bypass delivery 1");
  // second delivery sells the held 300 L + buys 500 at a different rate
  const d2 = ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st.id,
    purchases: [{ supplier_id: S2.id, product: "HSD", litres: 500, cost_rate: 260 }],
    drops: [{ client_id: W2.id, product: "HSD", litres: 800, override_limit: true }] }), "bypass delivery 2 (uses held 300)");
  await check("after bypass delivery 2");
  const plan1 = await call("admin", "GET", `/api/vouchers/bypass/${d1.id}/plan`);
  log(`plan void d1 (its 300 L already sold in d2): ok=${plan1.data?.ok} blockers=${JSON.stringify(plan1.data?.blockers)}`);
  const v1 = await call("admin", "POST", `/api/vouchers/bypass/${d1.id}/void`, { reason: "audit void" });
  log(`void d1 -> ${v1.status} ${JSON.stringify(v1.data).slice(0, 200)}`);
  if (v1.status === 200) { await check("after void d1 (whose stock was consumed by d2)"); const st1 = ok(await call("wholesale", "GET", "/api/bypass/stock"), "stock").total; log(`bypass stock after void d1: ${JSON.stringify(st1)}`); if (st1.litres < -0.01 || st1.value < -0.5) flag(`whole-voucher void left bypass stock negative: ${JSON.stringify(st1)}`); }
  // void d2 (should be allowed)
  const v2 = await call("admin", "POST", `/api/vouchers/bypass/${d2.id}/void`, { reason: "audit void" });
  ok(v2, "void d2");
  await check("after void d2");
  const st2 = ok(await call("wholesale", "GET", "/api/bypass/stock"), "stock").total;
  log(`bypass stock after void d2: ${JSON.stringify(st2)}`);
  if (v1.status !== 200) { const v1b = await call("admin", "POST", `/api/vouchers/bypass/${d1.id}/void`, { reason: "audit void" }); ok(v1b, "void d1 after d2"); await check("after void d1"); }
  // delivery with own-tank unload then void
  const tank = st.tanks.find((t: any) => t.product === "HSD");
  const d3 = ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st.id,
    purchases: [{ supplier_id: S.id, product: "HSD", litres: 400, cost_rate: 250 }],
    drops: [{ client_id: W1.id, product: "HSD", litres: 300, override_limit: true }], to_tank: [{ tank_id: tank.id, product: "HSD", litres: 100 }] }), "bypass delivery 3 with to_tank");
  await check("after bypass delivery 3 (to_tank)");
  const tankL = db.get("SELECT current_l FROM tanks WHERE id=?", tank.id).current_l;
  ok(await call("admin", "POST", `/api/vouchers/bypass/${d3.id}/void`, { reason: "audit void" }), "void d3");
  await check("after void d3");
  const tankL2 = db.get("SELECT current_l FROM tanks WHERE id=?", tank.id).current_l;
  log(`tank ${tank.name}: ${tankL} -> ${tankL2} after void (expect -100)`);
  // to-client shift
  const d4 = ok(await call("wholesale", "POST", "/api/bypass/deliveries", { station_id: st.id, purchases: [{ supplier_id: S.id, product: "HSD", litres: 200, cost_rate: 250 }], drops: [{ client_id: W1.id, product: "HSD", litres: 200, override_limit: true }] }), "d4");
  const pur = db.get("SELECT id FROM bypass_purchases WHERE delivery_id=?", d4.id);
  const tc = await call("admin", "POST", `/api/bypass/purchases/${pur.id}/to-client`, { client_id: W2.id, reason: "audit shift" });
  ok(tc, "to-client"); log(`to-client: ${JSON.stringify(tc.data).slice(0, 200)}`);
  await check("after to-client shift");
  const v4 = await call("admin", "POST", `/api/vouchers/bypass/${d4.id}/void`, { reason: "audit" });
  log(`void d4 after to-client -> ${v4.status} ${JSON.stringify(v4.data?.plan?.legs ?? v4.data).slice(0, 300)}`);
  await check("after void d4 (to-client)");
  // recost
  const rc = ok(await call("admin", "GET", "/api/bypass/recost"), "recost preview");
  log(`recost preview: drops ${rc?.drops} margin_shift ${rc?.margin_shift}`);
  if (rc?.drops) { ok(await call("admin", "POST", "/api/bypass/recost", {}), "recost apply"); await check("after recost apply"); }
});

test("6 tanker trip + whole-voucher void (pump + depot source)", async () => {
  const dr = ok(await call("wholesale", "POST", "/api/wholesale/drivers", { name: "Audit Driver", phone: "03009998887" }), "driver");
  const tk = ok(await call("wholesale", "POST", "/api/wholesale/tankers", { number: "AUD-1", capacity_l: 20000, driver_id: dr.id }), "tanker");
  const clients = ok(await call("wholesale", "GET", "/api/wholesale/clients"), "clients").filter((c: any) => c.rates?.HSD);
  const [a, b] = clients;
  const st = ok(await call("admin", "GET", "/api/stations"), "stations")[0];
  const trip = ok(await call("wholesale", "POST", "/api/wholesale/trips", { station_id: st.id, product: "HSD", tanker_id: tk.id, drops: [{ client_id: a.id, litres: 300, override_limit: true }, { client_id: b.id, litres: 200, override_limit: true }] }), "pump trip");
  await check("after pump trip");
  ok(await call("admin", "POST", `/api/vouchers/trip/${trip.id}/void`, { reason: "audit void" }), "void pump trip");
  await check("after void pump trip");
  // depot trip with cash freight
  const sups = ok(await call("admin", "GET", "/api/suppliers"), "sups"); const S = (Array.isArray(sups) ? sups : sups.suppliers)[0];
  const dt = await call("wholesale", "POST", "/api/wholesale/trips", { station_id: st.id, product: "HSD", tanker_id: tk.id, source: "depot", supplier_id: S.id, depot_ref: "AUD-BILTY", cost_rates: { HSD: 250 }, invoice_l: { HSD: 520 }, freight: 5000, freight_by: "cash", drops: [{ client_id: a.id, litres: 300, override_limit: true }, { client_id: b.id, litres: 200, override_limit: true }] });
  ok(dt, "depot trip");
  if (dt.status === 200) {
    await check("after depot trip (claim + cash freight)");
    const plan = ok(await call("admin", "GET", `/api/vouchers/trip/${dt.data.id}/plan`), "plan");
    log(`depot trip plan: ok=${plan?.ok} blockers=${JSON.stringify(plan?.blockers)} legs=${plan?.legs?.length}`);
    const v = await call("admin", "POST", `/api/vouchers/trip/${dt.data.id}/void`, { reason: "audit void" });
    ok(v, "void depot trip");
    await check("after void depot trip");
    const leftovers = db.all("SELECT id, status FROM expenses WHERE note LIKE ?", `Trip #${dt.data.id} —%`);
    const pending = db.all("SELECT id, kind, ref_id, status FROM approvals WHERE kind='expense' ORDER BY id DESC LIMIT 3").length;
    log(`after trip void: freight expenses left ${JSON.stringify(leftovers)}`);
  }
});

test("7 wholesale supply/payment, khata flows, expenses backdated vs ledger day", async () => {
  // back-dated expense: expense_date yesterday, created now
  const y = new Date(Date.now() - 86400_000 + 5 * 3600_000).toISOString().slice(0, 10);
  const e = await call("admin", "POST", "/api/expenses", { category: db.get("SELECT name FROM expense_categories WHERE tenant_id=1 LIMIT 1").name, amount: 1500, method: "cash", expense_date: y, note: "audit backdated" });
  log(`backdated expense -> ${e.status} ${JSON.stringify(e.data).slice(0, 160)}`);
  if (e.status === 200) {
    const L = ok(await call("admin", "GET", `/api/ledger?from=${y}&to=${y}`), "ledger yday");
    const inY = L.vouchers.some((v: any) => /audit backdated/.test(v.narration));
    const Lt = ok(await call("admin", "GET", `/api/ledger?from=${db.pkDate()}&to=${db.pkDate()}`), "ledger today");
    const inT = Lt.vouchers.some((v: any) => /audit backdated/.test(v.narration));
    log(`backdated expense in ledger: yesterday=${inY} today=${inT}`);
    if (!inY && inT) flag(`back-dated expense (expense_date=${y}) is booked by ledger.ts:251 on created_at (today) — expense reports (expense_date) and the ledger disagree on the day`);
    await check("after backdated expense");
  }
  // khata manual payment then correction void
  const cust = db.all("SELECT * FROM customers WHERE tenant_id=1 AND balance > 2000 ORDER BY balance DESC LIMIT 1")[0];
  const r = ok(await call("admin", "POST", "/api/cashier/receive", { party_type: "khata", party_id: cust.id, amount: 1000, method: "Cash" }), "receive");
  await check("after khata receive 2");
  ok(await call("admin", "POST", `/api/cashier/vouchers/${r.voucher.id}/void`, { reason: "audit" }), "void receive");
  await check("after void receive");
});

test("8 shop stock-in/sale/undo and cash count", async () => {
  const st = ok(await call("admin", "GET", "/api/stations"), "st")[0];
  const item = ok(await call("admin", "POST", "/api/shop/items", { station_id: st.id, name: "Audit coolant", category: "coolant", cost: 300, price: 450, stock: 0 }), "item");
  ok(await call("admin", "POST", `/api/shop/items/${item.id}/stock-in`, { qty: 10, cost: 333.33, paid_by: "cash" }), "stock-in cash");
  await check("after shop stock-in cash");
  const s = ok(await call("admin", "POST", "/api/shop/sales", { station_id: st.id, lines: [{ item_id: item.id, qty: 3 }], payment_method: "cash" }), "shop sale cash");
  await check("after shop cash sale");
  const cc = await call("admin", "POST", "/api/cash/counts", { amount: ok(await call("admin", "GET", "/api/cash"), "cash").cash_in_hand + 7 });
  log(`cash count -> ${cc.status} ${JSON.stringify(cc.data).slice(0, 120)}`);
  await check("after cash count (over 7)");
});

test("9 negative-cash guards + shift expense rejected after close", async () => {
  const pos0 = ok(await call("admin", "GET", "/api/cash"), "cash");
  const cash = pos0.cash_in_hand;
  log(`office cash now ${cash}`);
  // cash count over by 7
  const cc = await call("admin", "POST", "/api/cash/count", { amount: Math.round(cash) + 7 });
  log(`cash count -> ${cc.status} ${JSON.stringify(cc.data).slice(0, 160)}`);
  await check("after cash count (+7)");
  const cash1 = ok(await call("admin", "GET", "/api/cash"), "cash").cash_in_hand;
  // investor payout in cash beyond office cash
  const inv = ok(await call("admin", "POST", "/api/investors", { name: "Cash Guard Investor" }), "inv");
  ok(await call("admin", "POST", `/api/investors/${inv.id}/money`, { dir: "in", amount: cash1 + 500_000, method: "Bank transfer", account_id: db.get("SELECT id FROM bank_accounts WHERE tenant_id=1 AND active=1 LIMIT 1").id }), "capital in by bank");
  const po = await call("admin", "POST", `/api/investors/${inv.id}/money`, { dir: "out", amount: cash1 + 400_000, method: "Cash", purpose: "capital" });
  log(`investor cash payout > office cash -> ${po.status} ${JSON.stringify(po.data).slice(0, 120)}`);
  if (po.status === 200) { flag(`investors.ts moneyTxn/otherMoney: cash payout of ${cash1 + 400_000} allowed with only ${cash1} in hand (office cash goes negative; cashier doPay would refuse)`); ok(await call("admin", "POST", `/api/investor-txns/${po.data.id}/void`, { reason: "audit" }), "void payout"); }
  await check("after investor cash payout guard test");
  // bypass we_pay cash beyond office cash
  const bs = ok(await call("wholesale", "GET", "/api/bypass/suppliers"), "bs")[0];
  const bp = await call("wholesale", "POST", `/api/bypass/suppliers/${bs.id}/payment`, { amount: cash1 + 300_000, mode: "we_pay", method: "Cash" });
  log(`bypass we_pay cash > office cash -> ${bp.status} ${JSON.stringify(bp.data).slice(0, 120)}`);
  if (bp.status === 200) { flag(`bypass.ts /bypass/suppliers/:id/payment we_pay Cash: no cash-in-hand check (paid ${cash1 + 300_000} with ${cash1} in hand)`); ok(await call("admin", "POST", `/api/bypass/payments/${bp.data.payment.id}/void`, {}), "void bp"); }
  await check("after bypass cash pay guard test");
  // supplier module payment cash beyond office cash
  const sup = (ok(await call("admin", "GET", "/api/suppliers"), "sups"))[0];
  const sp = await call("admin", "POST", `/api/suppliers/${sup.id}/payment`, { amount: cash1 + 200_000, method: "Cash" });
  log(`supplier module cash pay > office cash -> ${sp.status} ${JSON.stringify(sp.data).slice(0, 160)}`);
  if (sp.status === 200 && !sp.data.held) flag(`suppliers.ts /suppliers/:id/payment Cash: no cash-in-hand check`);
  await check("after supplier cash pay guard test");
  // expense cash beyond office cash
  const ex = await call("admin", "POST", "/api/expenses", { category: db.get("SELECT name FROM expense_categories WHERE tenant_id=1 LIMIT 1").name, amount: Math.min(1_000_000, cash1 + 100_000), method: "cash", note: "audit overdraw" });
  log(`expense cash > office cash -> ${ex.status} ${JSON.stringify(ex.data).slice(0, 120)}`);
  // the expense body caps amount at 10 lakh, so the guard can only trip when the office holds less than that
  if (ex.status === 200 && Math.min(1_000_000, cash1 + 100_000) > cash1) { flag(`expenses.ts createExpense cash: no cash-in-hand check`); }
  if (ex.status === 200) ok(await call("admin", "DELETE", `/api/expenses/${ex.data.id}`), "del");
  await check("after expense guard test");
  // shift expense pending (above limit) → close → reject
  const sh = ok(await call("salesman", "POST", "/api/shifts/open", {}), "open shift 2");
  const live = ok(await call("salesman", "GET", `/api/shifts/${sh.id}/live`), "live");
  ok(await call("salesman", "POST", "/api/sales", { station_id: live.shift.station_id, product: "HSD", litres: 100, payment_method: "cash" }), "cash sale");
  const se = ok(await call("salesman", "POST", `/api/shifts/${sh.id}/expenses`, { category: db.get("SELECT name FROM expense_categories WHERE tenant_id=1 LIMIT 1").name, amount: 15000, note: "audit big shift expense" }), "shift expense");
  log(`shift expense status ${se?.expense?.status} cash_expected ${se?.summary?.cash_expected}`);
  const readings: Record<string, number> = {};
  for (const n of live.readings ?? []) readings[String(n.nozzle_id)] = n.opening;
  const l2 = ok(await call("salesman", "GET", `/api/shifts/${sh.id}/live`), "live2");
  for (const n of l2.readings ?? []) readings[String(n.nozzle_id)] = n.opening;
  const prev = ok(await call("salesman", "POST", `/api/shifts/${sh.id}/preview`, { readings }), "preview");
  ok(await call("salesman", "POST", `/api/shifts/${sh.id}/close`, { readings, cash_actual: Math.max(0, prev.cash_expected) }), "close");
  await check("after close with pending shift expense");
  const rj = await call("admin", "POST", `/api/expenses/${se.expense.id}/reject`, {});
  log(`reject pending shift expense after close -> ${rj.status} ${JSON.stringify(rj.data).slice(0, 120)}`);
  await check("after rejecting the closed shift's pending expense");
  const bag = ok(await call("admin", "GET", `/api/shifts/${sh.id}/report`), "report").summary;
  log(`closed shift summary now: expenses_total ${bag.expenses_total} cash_expected(live) ${bag.cash_expected} stored ${db.get("SELECT cash_expected, cash_actual, variance FROM shifts WHERE id=?", sh.id) && JSON.stringify(db.get("SELECT cash_expected, cash_actual, variance FROM shifts WHERE id=?", sh.id))}`);
});
