/**
 * Owner overview: the whole business on one screen — where the money is right now (office cash, with the salesmen,
 * banks, cheques not yet cleared), what others owe and what we owe, today's money in / out across every module,
 * and this month's profit. Every number comes from the same books the cashier, banks and accounts use.
 */
import { investorsOwed, investorBalance, investorsSummary } from "./investors.js";
import { Router } from "express";
import { all, get, pkDate, pkDayStart, pkStart } from "../db.js";
import { h, tid, requirePerm } from "../auth.js";
import { round2 } from "../services.js";
import { cashPosition } from "./backoffice.js";
import { bankAccounts } from "./banks.js";
import { balances, buildReport } from "./reports.js";
import { profitAndLoss } from "./analysis.js";
import { cashierDayBook, onlineToday, cashWithSalesmen } from "./cashier.js";
import { clientDue } from "./wholesale.js";
import { thekedarDue } from "./carriage.js";
import { supplierOwed } from "./suppliers.js";
import { bypassOwed } from "./bypass.js";
import { staffBalance } from "./staff.js";

export const owner = Router();

owner.get("/owner/overview", requirePerm("reports.view"), h((req) => {
  const t = tid(req);
  const today = pkDate(), dayStart = pkDayStart(), nowIso = new Date().toISOString();
  const one = (sql: string, ...a: unknown[]) => round2(get(sql, ...(a as []))!.v ?? 0);
  const cnt = (sql: string, ...a: unknown[]) => Number(get(sql, ...(a as []))!.n ?? 0);

  // ---- where the money is ----
  const cash = cashPosition(t);
  const ws = cashWithSalesmen(t);
  const banks = bankAccounts(t);
  const chqIn = get(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) v FROM (
      SELECT amount FROM wholesale_cheques WHERE tenant_id=? AND status IN ('in_hand','deposited')
      UNION ALL SELECT amount FROM cheques WHERE tenant_id=? AND direction='in' AND status IN ('in_hand','deposited'))`, t, t)!;
  const chqOut = get("SELECT COUNT(*) n, COALESCE(SUM(amount),0) v FROM cheques WHERE tenant_id=? AND direction='out' AND status='issued'", t)!;
  const money = {
    office_cash: cash.cash_in_hand, last_count: cash.last_count,
    with_salesmen: ws.total, open_shifts: ws.open_shifts,
    banks: banks.total, accounts: banks.accounts.filter((a) => a.active).map((a) => ({ id: a.id, bank: a.bank, name: a.name, balance: a.balance })),
    total: round2(cash.cash_in_hand + ws.total + banks.total),
    cheques_in: { n: chqIn.n, amount: round2(chqIn.v) },
  };

  // ---- owed to us / we owe ----
  const b = balances(t);
  const staffAdv = Math.max(0, one(`SELECT COALESCE(SUM(CASE WHEN type IN ('advance','shortage') THEN amount WHEN type IN ('repayment','deduction') THEN -amount ELSE 0 END),0) v FROM staff_ledger WHERE tenant_id=?`, t));
  const owedToUs = { khata: b.receivables.khata_total, wholesale: b.receivables.wholesale_total, staff_advances: round2(staffAdv) };
  const weOwe = {
    suppliers: b.payables.suppliers_total,
    customer_advances: round2(b.payables.total - b.payables.suppliers_total),
    withholding_tax: one("SELECT COALESCE(SUM(amount),0) v FROM tax_withholdings WHERE tenant_id=? AND cpr_no IS NULL", t),
    unused_coupons: one("SELECT COALESCE(SUM(value),0) v FROM fuel_coupons WHERE tenant_id=? AND status='active'", t),
    pending_expenses: b.payables.pending_expenses.amount,
    investors: investorsOwed(t), // investors' capital + profit share not paid yet
  };
  const sum = (o: Record<string, number>) => round2(Object.values(o).reduce((a, v) => a + v, 0));
  const dues = partyDues(t);

  // ---- today ----
  const r = buildReport(t, dayStart, nowIso).summary;
  const book = cashierDayBook(t, today, req.user!.role === "admin");
  // one-glance trend: today's fuel sale (retail + wholesale) vs the same by this time yesterday, and vs the 7-day average
  const saleSince = (from: string, to?: string) => round2(get(
    `SELECT COALESCE(SUM(s.amount),0) v FROM sales s JOIN stations st ON st.id=s.station_id WHERE st.tenant_id=? AND s.created_at >= ?${to ? " AND s.created_at < ?" : ""}`,
    t, from, ...(to ? [to] : []) as [])!.v ?? 0);
  const saleToday = round2(r.retail_sales + (r.wholesale_net ?? 0));
  const saleYest = saleSince(pkDayStart(Date.now() - 86_400_000), dayStart);
  const avg7 = round2(saleSince(new Date(Date.now() - 7 * 86_400_000).toISOString(), dayStart) / 7);
  const today_ = {
    revenue: r.revenue, retail_sales: r.retail_sales, retail_litres: r.retail_litres, retail_txns: r.retail_txns,
    wholesale: r.wholesale_net, wholesale_litres: r.wholesale_litres, shop: r.shop_sales,
    expenses: r.expenses, profit_estimate: r.gross_profit_estimate, cost_assumed: r.cost_assumed_products, cost_missing: r.cost_missing_products,
    money_in: { cash: book.totals.in_cash, bank: book.totals.in_bank }, money_out: { cash: book.totals.out_cash, bank: book.totals.out_bank },
    deposited: book.totals.deposited,
    sale: saleToday, vs_yesterday_pct: saleYest > 0 ? Math.round(((saleToday - saleYest) / saleYest) * 1000) / 10 : null,
    vs_avg7_pct: avg7 > 0 ? Math.round(((saleToday - avg7) / avg7) * 1000) / 10 : null,
  };

  // ---- what every module did today ----
  const activity = [
    { key: "pos", to: "/pos", en: "Fuel sales", ur: "سیل", n: r.retail_txns, v: r.retail_sales },
    { key: "shop", to: "/shop", en: "Shop sales", ur: "دکان", n: cnt("SELECT COUNT(*) n FROM shop_sales WHERE tenant_id=? AND created_at >= ?", t, dayStart), v: r.shop_sales },
    { key: "khata_in", to: "/khata", en: "Khata payments", ur: "کھاتہ وصولی", n: cnt("SELECT COUNT(*) n FROM khata_ledger k JOIN customers c ON c.id=k.customer_id WHERE c.tenant_id=? AND k.type='credit' AND k.created_at >= ?", t, dayStart),
      v: one("SELECT COALESCE(SUM(k.amount),0) v FROM khata_ledger k JOIN customers c ON c.id=k.customer_id WHERE c.tenant_id=? AND k.type='credit' AND k.created_at >= ?", t, dayStart) },
    { key: "khata_out", to: "/khata", en: "Fuel on khata", ur: "ادھار", n: cnt("SELECT COUNT(*) n FROM khata_ledger k JOIN customers c ON c.id=k.customer_id WHERE c.tenant_id=? AND k.type='debit' AND k.created_at >= ?", t, dayStart),
      v: one("SELECT COALESCE(SUM(k.amount),0) v FROM khata_ledger k JOIN customers c ON c.id=k.customer_id WHERE c.tenant_id=? AND k.type='debit' AND k.created_at >= ?", t, dayStart) },
    { key: "ws_supply", to: "/wholesale", en: "Wholesale supply", ur: "ہول سیل سپلائی", n: cnt("SELECT COUNT(*) n FROM wholesale_txns WHERE tenant_id=? AND type='supply' AND voided=0 AND created_at >= ?", t, dayStart), v: r.wholesale_net },
    { key: "ws_pay", to: "/wholesale?tab=collect", en: "Wholesale payments", ur: "ہول سیل وصولی", n: cnt("SELECT COUNT(*) n FROM wholesale_txns WHERE tenant_id=? AND type='payment' AND voided=0 AND LOWER(COALESCE(method,''))<>'paid to depot' AND created_at >= ?", t, dayStart),
      v: one("SELECT COALESCE(SUM(amount),0) v FROM wholesale_txns WHERE tenant_id=? AND type='payment' AND voided=0 AND LOWER(COALESCE(method,''))<>'paid to depot' AND created_at >= ?", t, dayStart) },
    { key: "cashier", to: "/cashier", en: "Cash counter vouchers", ur: "کیشیئر رسیدیں", n: cnt("SELECT COUNT(*) n FROM cashier_vouchers WHERE tenant_id=? AND created_at >= ?", t, dayStart),
      v: one("SELECT COALESCE(SUM(amount),0) v FROM cashier_vouchers WHERE tenant_id=? AND created_at >= ?", t, dayStart) },
    { key: "cheques", to: "/cashier?tab=cheques", en: "Cheques in / out", ur: "چیک", n: cnt(`SELECT (SELECT COUNT(*) FROM cheques WHERE tenant_id=? AND created_at >= ?) + (SELECT COUNT(*) FROM wholesale_cheques WHERE tenant_id=? AND created_at >= ?) n`, t, dayStart, t, dayStart), v: null },
    { key: "suppliers", to: "/suppliers", en: "Paid to suppliers", ur: "سپلائر ادائیگی", n: cnt("SELECT COUNT(*) n FROM supplier_txns WHERE tenant_id=? AND type='payment' AND COALESCE(method,'')<>'WHT' AND LOWER(COALESCE(method,''))<>'paid to depot' AND created_at >= ?", t, dayStart),
      v: one("SELECT COALESCE(SUM(amount),0) v FROM supplier_txns WHERE tenant_id=? AND type='payment' AND COALESCE(method,'')<>'WHT' AND LOWER(COALESCE(method,''))<>'paid to depot' AND created_at >= ?", t, dayStart) },
    { key: "expenses", to: "/expenses", en: "Expenses", ur: "خرچے", n: cnt("SELECT COUNT(*) n FROM expenses WHERE tenant_id=? AND status='approved' AND created_at >= ?", t, dayStart), v: r.expenses },
    { key: "stock_in", to: "/stock", en: "Tankers received", ur: "ٹینکر آئے", n: cnt("SELECT COUNT(*) n FROM deliveries d JOIN tanks k ON k.id=d.tank_id JOIN stations s ON s.id=k.station_id WHERE s.tenant_id=? AND d.created_at >= ?", t, dayStart),
      v: null, l: one("SELECT COALESCE(SUM(d.received_l),0) v FROM deliveries d JOIN tanks k ON k.id=d.tank_id JOIN stations s ON s.id=k.station_id WHERE s.tenant_id=? AND d.created_at >= ?", t, dayStart) },
    { key: "bank", to: "/cash", en: "Put in bank", ur: "بینک میں جمع", n: cnt("SELECT COUNT(*) n FROM bank_deposits WHERE tenant_id=? AND created_at >= ?", t, dayStart), v: book.totals.deposited },
  ];

  // ---- online money: today per method (and where it lands), plus this month's total per method ----
  const onlineMonth = onlineToday(t, pkStart(`${today.slice(0, 7)}-01`));
  const online = { ...onlineToday(t), month: onlineMonth.methods.map((m) => ({ method: m.method, total: m.total })), month_total: onlineMonth.total };

  // ---- this month ----
  const pl = profitAndLoss(t, today.slice(0, 7), req.user!.role === "admin");

  return {
    as_of: nowIso, money,
    owed_to_us: { ...owedToUs, total: sum(owedToUs) },
    we_owe: { ...weOwe, total: sum(weOwe), cheques_issued: { n: chqOut.n, amount: round2(chqOut.v) } },
    dues,
    net_position: round2(money.total + sum(owedToUs) - sum(weOwe)),
    today: today_, activity, online,
    // CEO-only: what the investors' money earned (ours vs theirs) and what we still owe them
    investors: req.user!.role === "admin" && get("SELECT 1 x FROM investors WHERE tenant_id=? LIMIT 1", t) ? investorsSummary(t) : null,
    month: { month: pl.month, income: pl.income.total, gross_profit: pl.gross_profit, expenses: pl.expenses.total, net_profit: pl.net_profit, margin_pct: pl.margin_pct },
  };
}));

/** Business pulse: a 14-day trend of retail fuel sale + expenses, today vs the 7-day average (anomaly flag),
 *  a simple 7-day sale projection, and where the money sits right now. Read-only — nothing is written. */
owner.get("/owner/pulse", requirePerm("reports.view"), h((req) => {
  const t = tid(req);
  const today = pkDate();
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  // pk-day (UTC+5) grouped retail fuel sale (wholesale excluded) + litres
  const salesRows = all(
    `SELECT strftime('%Y-%m-%d', s.created_at, '+5 hours') d, ROUND(SUM(s.amount),2) sales, ROUND(SUM(s.litres),2) litres, COUNT(*) n
     FROM sales s JOIN stations st ON st.id=s.station_id
     WHERE st.tenant_id=? AND s.payment_method <> 'wholesale' AND s.created_at >= ? GROUP BY d`, t, since);
  const since14 = new Date(Date.now() - 14 * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);
  const expRows = all(
    `SELECT expense_date d, ROUND(SUM(amount),2) exp FROM expenses WHERE tenant_id=? AND status='approved' AND expense_date >= ? GROUP BY d`,
    t, since14);
  const salesBy = new Map(salesRows.map((r: any) => [r.d, r]));
  const expBy = new Map(expRows.map((r: any) => [r.d, r.exp]));
  // build an ordered 14-day series (oldest → today), filling gaps with 0
  const days: string[] = [];
  for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10));
  const series = days.map((d) => ({ day: d, sales: round2((salesBy.get(d) as any)?.sales ?? 0), litres: round2((salesBy.get(d) as any)?.litres ?? 0), expenses: round2((expBy.get(d) as number) ?? 0) }));
  // today (partial) vs the average of the 7 complete days before today
  const prev7 = series.slice(-8, -1); // the 7 days before today
  const avg7 = prev7.length ? round2(prev7.reduce((a, x) => a + x.sales, 0) / prev7.length) : 0;
  const todaySales = series[series.length - 1].sales;
  const changePct = avg7 > 0 ? Math.round(((todaySales - avg7) / avg7) * 100) : 0;
  // simple forward look: 7 days at the running 7-day average
  const projection7 = round2(avg7 * 7);
  // where the money sits now
  const cash = cashPosition(t), banks = bankAccounts(t), ws = cashWithSalesmen(t);
  const expAvg7 = prev7.length ? round2(prev7.reduce((a, x) => a + x.expenses, 0) / prev7.length) : 0;
  return {
    as_of: new Date().toISOString(),
    series,
    today: { sales: todaySales, vs_avg7_pct: changePct, avg7, down: avg7 > 0 && changePct <= -20 },
    projection: { next7_sales: projection7, avg_daily_sales: avg7, avg_daily_expense: expAvg7, est_net_7d: round2((avg7 - expAvg7) * 7) },
    money_now: { office_cash: cash.cash_in_hand, with_salesmen: ws.total, banks: banks.total, total: round2(cash.cash_in_hand + ws.total + banks.total) },
  };
}));

/** Every party with a balance, named: who owes us (khata, wholesale, thekedar, staff advance) and whom we owe (suppliers, bypass depots, advances held). */
export function partyDues(t: number) {
  type D = { kind: string; id: number; name: string; amount: number; to: string };
  const rec: D[] = [], pay: D[] = [];
  for (const c of all("SELECT id, name, balance FROM customers WHERE tenant_id=? AND ABS(balance) > 0.5", t)) {
    if (c.balance > 0) rec.push({ kind: "khata", id: c.id, name: c.name, amount: round2(c.balance), to: `/customers/${c.id}` });
    else pay.push({ kind: "khata_advance", id: c.id, name: `${c.name} (advance)`, amount: round2(-c.balance), to: `/customers/${c.id}` });
  }
  for (const w of all("SELECT id, name FROM wholesale_clients WHERE tenant_id=? AND active=1", t)) {
    const d = clientDue(w.id);
    if (d > 0.5) rec.push({ kind: "wholesale", id: w.id, name: w.name, amount: round2(d), to: `/wholesale/${w.id}` });
    else if (d < -0.5) pay.push({ kind: "wholesale_advance", id: w.id, name: `${w.name} (advance)`, amount: round2(-d), to: `/wholesale/${w.id}` });
  }
  for (const k of all("SELECT id, name FROM thekedars WHERE tenant_id=? AND active=1", t)) {
    const d = thekedarDue(k.id);
    if (d > 0.5) rec.push({ kind: "carriage", id: k.id, name: `${k.name} (kiraya)`, amount: round2(d), to: `/carriage/${k.id}` });
    else if (d < -0.5) pay.push({ kind: "carriage_advance", id: k.id, name: `${k.name} (advance)`, amount: round2(-d), to: `/carriage/${k.id}` });
  }
  for (const u of all("SELECT DISTINCT u.id, u.name FROM staff_ledger l JOIN users u ON u.id=l.user_id WHERE l.tenant_id=?", t)) {
    const b = staffBalance(u.id);
    if (b > 0.5) rec.push({ kind: "staff", id: u.id, name: `${u.name} (advance)`, amount: round2(b), to: "/staff" });
  }
  for (const s of all("SELECT id, name, company FROM suppliers WHERE tenant_id=? AND active=1", t)) {
    const o = supplierOwed(s.id) + bypassOwed(s.id);
    if (o > 0.5) pay.push({ kind: "supplier", id: s.id, name: [s.company, s.name].filter(Boolean).join(" — "), amount: round2(o), to: "/suppliers" });
    else if (o < -0.5) rec.push({ kind: "supplier_advance", id: s.id, name: `${[s.company, s.name].filter(Boolean).join(" — ")} (advance)`, amount: round2(-o), to: "/suppliers" });
  }
  for (const i of all("SELECT id, name FROM investors WHERE tenant_id=?", t)) {
    const v = investorBalance(i.id);
    if (v > 0.5) pay.push({ kind: "investor", id: i.id, name: `${i.name} (investor)`, amount: v, to: `/investors?id=${i.id}` });
  }
  rec.sort((a, b) => b.amount - a.amount); pay.sort((a, b) => b.amount - a.amount);
  const tot = (x: D[]) => round2(x.reduce((a, d) => a + d.amount, 0));
  return { receivable: rec, payable: pay, receivable_total: tot(rec), payable_total: tot(pay) };
}
