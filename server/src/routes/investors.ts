/**
 * Investors: people who give the pump capital; we buy fuel with it in "deals" and split each deal's profit.
 *
 *  - Investor ledger (investor_txns) — from the investor's side, what WE OWE THEM:
 *      capital_in (paisa diya)          → Credit   (we owe more)
 *      profit     (their share of a deal) → Credit
 *      payout     (we paid them back / their munafa) → Debit
 *      loss       (their share of a deal's loss)     → Debit
 *    balance = credits − debits = what the pump owes the investor right now.
 *  - Money in / out goes through the same tables as all other money (cashier_vouchers for cash, bank_txns for a bank)
 *    with ref "inv:<txn id>"; ledger.ts books that against "Investors payable", so cash, bank and the books tally.
 *  - A deal: litres × cost rate bought with the investor's money (capped at what of their money is free). When it is
 *    sold, close it: profit = sale − cost − expenses (carriage, staff/bijli share, other) — loss too, shared the same way.
 *    The investor's share is booked Dr "Expense: Investor profit share" / Cr "Investors payable" (a loss the reverse),
 *    so the P&L shows only OUR part of the profit. The investor's share can be paid right away ("har deal ke baad").
 */
import { Router } from "express";
import { z } from "zod";
import { all, get, run, tx, now, pkDate, pkStart } from "../db.js";
import { h, parse, tid, requirePerm } from "../auth.js";
import { AppError, round2, audit, currentPrices } from "../services.js";
import { otherMoney, accountIdField } from "./banks.js";

export const investors = Router();
const P = requirePerm("investors.manage");

const CREDIT = new Set(["capital_in", "profit"]);
/** what the pump owes this investor (credits − debits) */
export function investorBalance(id: number) {
  return round2(get(`SELECT COALESCE(SUM(CASE WHEN type IN ('capital_in','profit') THEN amount ELSE -amount END),0) v FROM investor_txns WHERE investor_id=? AND voided=0`, id)!.v as number);
}
/** capital tied up in deals not closed yet */
const inDeals = (id: number) => round2(get("SELECT COALESCE(SUM(cost_amount),0) v FROM investor_deals WHERE investor_id=? AND status='open' AND voided=0", id)!.v as number);
/** total owed to all investors (Investors payable) */
export function investorsOwed(t: number) {
  return round2(get(`SELECT COALESCE(SUM(CASE WHEN type IN ('capital_in','profit') THEN amount ELSE -amount END),0) v FROM investor_txns WHERE tenant_id=? AND voided=0`, t)!.v as number);
}

function own(t: number, id: number) {
  const r = get("SELECT * FROM investors WHERE id=? AND tenant_id=?", id, t);
  if (!r) throw new AppError(404, "Investor nahi mila");
  return r;
}
const ownDeal = (t: number, id: number) => {
  const d = get("SELECT * FROM investor_deals WHERE id=? AND tenant_id=? AND voided=0", id, t);
  if (!d) throw new AppError(404, "Deal nahi mili");
  return d;
};

/** one investor's numbers */
function figures(i: any) {
  const s = get(`SELECT
      COALESCE(SUM(CASE WHEN type='capital_in' THEN amount END),0) capital_in,
      COALESCE(SUM(CASE WHEN type='payout' THEN amount END),0) paid_out,
      COALESCE(SUM(CASE WHEN type='profit' THEN amount END),0) profit,
      COALESCE(SUM(CASE WHEN type='loss' THEN amount END),0) loss
    FROM investor_txns WHERE investor_id=? AND voided=0`, i.id)!;
  const d = get(`SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN status='open' THEN 1 END),0) open_n,
      COALESCE(SUM(CASE WHEN status='closed' THEN profit END),0) deal_profit, COALESCE(SUM(CASE WHEN status='closed' THEN our_share END),0) our_share,
      COALESCE(SUM(CASE WHEN status='closed' THEN litres END),0) litres
    FROM investor_deals WHERE investor_id=? AND voided=0`, i.id)!;
  const balance = investorBalance(i.id), busy = inDeals(i.id);
  return {
    capital_in: round2(s.capital_in), paid_out: round2(s.paid_out), profit_share: round2(s.profit), loss_share: round2(s.loss),
    balance, in_deals: busy, free: round2(Math.max(0, balance - busy)),
    deals: d.n, open_deals: d.open_n, deal_profit: round2(d.deal_profit), our_share: round2(d.our_share), litres: round2(d.litres),
  };
}

/* ---------------- investors ---------------- */
const profile = z.object({
  name: z.string().trim().min(2, "Naam likhein").max(80),
  phone: z.string().trim().max(20).optional().nullable(),
  cnic: z.string().trim().max(20).optional().nullable(),
  address: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().max(60).optional().nullable(),
  bank_name: z.string().trim().max(60).optional().nullable(),
  bank_account: z.string().trim().max(40).optional().nullable(),
  note: z.string().trim().max(300).optional().nullable(),
  /** OUR share of each deal's profit, % (the investor gets the rest) */
  our_pct: z.number().min(0).max(100).default(60),
});

investors.get("/investors", P, h((req) => {
  const t = tid(req);
  const rows = all("SELECT * FROM investors WHERE tenant_id=? ORDER BY active DESC, name", t).map((i) => ({ ...i, ...figures(i) }));
  return rows;
}));

investors.post("/investors", P, h((req) => {
  const t = tid(req), b = parse(profile, req.body);
  if (get("SELECT id FROM investors WHERE tenant_id=? AND LOWER(name)=LOWER(?) AND active=1", t, b.name)) throw new AppError(400, `"${b.name}" naam ka investor pehle se hai`);
  const id = run(`INSERT INTO investors (tenant_id,name,phone,cnic,address,city,bank_name,bank_account,note,our_pct,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    t, b.name, b.phone || null, b.cnic || null, b.address || null, b.city || null, b.bank_name || null, b.bank_account || null, b.note || null, b.our_pct, req.user!.name, now()).id;
  audit(t, req.user!, "investor_add", `investor:${id}`, b);
  return own(t, id);
}));

investors.patch("/investors/:id", P, h((req) => {
  const t = tid(req), i = own(t, Number(req.params.id)), b = parse(profile, req.body);
  run(`UPDATE investors SET name=?, phone=?, cnic=?, address=?, city=?, bank_name=?, bank_account=?, note=?, our_pct=?, updated_at=? WHERE id=?`,
    b.name, b.phone || null, b.cnic || null, b.address || null, b.city || null, b.bank_name || null, b.bank_account || null, b.note || null, b.our_pct, now(), i.id);
  audit(t, req.user!, "investor_edit", `investor:${i.id}`, { before: i, after: b });
  return own(t, i.id);
}));

/** band / dobara chalu — an investor with history is never deleted, only closed */
investors.post("/investors/:id/:state(active|inactive)", P, h((req) => {
  const t = tid(req), i = own(t, Number(req.params.id));
  if (req.params.state === "inactive") {
    if (Math.abs(investorBalance(i.id)) > 0.5) throw new AppError(400, `${i.name} ka hisaab abhi baqi hai (${investorBalance(i.id)}) — pehle hisaab saaf karein`);
    if (inDeals(i.id) > 0) throw new AppError(400, `${i.name} ki deal abhi khuli hai — pehle deal band karein`);
  }
  run("UPDATE investors SET active=?, updated_at=? WHERE id=?", req.params.state === "active" ? 1 : 0, now(), i.id);
  audit(t, req.user!, `investor_${req.params.state}`, `investor:${i.id}`, { name: i.name });
  return own(t, i.id);
}));

investors.delete("/investors/:id", P, h((req) => {
  const t = tid(req), i = own(t, Number(req.params.id));
  const used = get("SELECT (SELECT COUNT(*) FROM investor_txns WHERE investor_id=?) + (SELECT COUNT(*) FROM investor_deals WHERE investor_id=?) n", i.id, i.id)!.n as number;
  if (used) throw new AppError(400, `${i.name} ki entries maujood hain — delete nahi ho sakta. "Band karein" use karein (hisaab mehfooz rahega).`);
  run("DELETE FROM investors WHERE id=?", i.id);
  audit(t, req.user!, "investor_delete", `investor:${i.id}`, i);
  return { ok: true };
}));

/** statement: every credit / debit with the running balance, plus the deals */
export function investorStatement(t: number, id: number, from?: string, to?: string) {
  const i = own(t, id);
  const lo = from ? pkStart(from) : "1970-01-01", hi = to ? new Date(Date.parse(pkStart(to)) + 86_400_000).toISOString() : "9999-12-31";
  const opening = round2(get(`SELECT COALESCE(SUM(CASE WHEN type IN ('capital_in','profit') THEN amount ELSE -amount END),0) v FROM investor_txns WHERE investor_id=? AND voided=0 AND created_at < ?`, id, lo)!.v as number);
  let bal = opening;
  const lines = all(`SELECT x.*, d.product, d.litres, d.sold_litres, d.cost_rate, d.sale_rate, d.profit deal_profit, d.our_pct deal_pct, a.bank acc_bank
      FROM investor_txns x LEFT JOIN investor_deals d ON d.id=x.deal_id LEFT JOIN bank_accounts a ON a.id=x.account_id
      WHERE x.investor_id=? AND x.created_at >= ? AND x.created_at < ? ORDER BY x.created_at, x.id`, id, lo, hi).map((x) => {
    const credit = !x.voided && CREDIT.has(x.type) ? round2(x.amount) : 0, debit = !x.voided && !CREDIT.has(x.type) ? round2(x.amount) : 0;
    bal = round2(bal + credit - debit);
    return { ...x, credit, debit, balance: bal };
  });
  const deals = all("SELECT d.*, s.name supplier FROM investor_deals d LEFT JOIN suppliers s ON s.id=d.supplier_id WHERE d.investor_id=? AND d.voided=0 ORDER BY d.deal_date DESC, d.id DESC", id);
  return { investor: { ...i, ...figures(i) }, opening, closing: bal, lines, deals,
    totals: { credit: round2(lines.reduce((a, l) => a + l.credit, 0)), debit: round2(lines.reduce((a, l) => a + l.debit, 0)) } };
}
investors.get("/investors/:id", P, h((req) => {
  const q = req.query as Record<string, string>;
  const d = /^\d{4}-\d{2}-\d{2}$/;
  return investorStatement(tid(req), Number(req.params.id), d.test(q.from ?? "") ? q.from : undefined, d.test(q.to ?? "") ? q.to : undefined);
}));

/* ---------------- money in / out ---------------- */
const money = z.object({
  dir: z.enum(["in", "out"]),
  amount: z.number().positive().max(10_000_000_000),
  method: z.string().trim().max(30).optional().nullable(),
  account_id: accountIdField,
  /** a payout: "profit" (munafa diya) or "capital" (asal raqam wapas) — only for the statement wording */
  purpose: z.enum(["capital", "profit"]).optional().nullable(),
  note: z.string().trim().max(200).optional().nullable(),
});

/** write one money txn and its cash / bank row (ref inv:<txn>) */
function moneyTxn(t: number, by: string, i: any, m: { dir: "in" | "out"; amount: number; method?: string | null; account_id?: number | null; purpose?: string | null; note?: string | null; deal_id?: number | null }) {
  const amount = round2(m.amount);
  const type = m.dir === "in" ? "capital_in" : "payout";
  const purpose = m.dir === "in" ? "capital" : (m.purpose ?? "profit");
  const id = run(`INSERT INTO investor_txns (tenant_id,investor_id,type,purpose,amount,method,account_id,deal_id,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    t, i.id, type, purpose, amount, m.method || "Cash", m.account_id ?? null, m.deal_id ?? null, m.note || null, by, now()).id;
  const label = m.dir === "in" ? "Investor capital received" : purpose === "capital" ? "Investor capital returned" : "Investor profit paid";
  const src = otherMoney(t, { dir: m.dir, amount, method: m.method ?? "cash", account_id: m.account_id, party: i.name, category: label, note: m.note, ref: `inv:${id}`, by });
  run("UPDATE investor_txns SET src=? WHERE id=?", src, id);
  return id;
}

investors.post("/investors/:id/money", P, h((req) => {
  const t = tid(req), i = own(t, Number(req.params.id)), b = parse(money, req.body);
  if (!i.active) throw new AppError(400, `${i.name} band hai — pehle chalu karein`);
  if (b.dir === "out") {
    // never pay out more than we owe, and never the money still tied up in an open deal
    const free = round2(investorBalance(i.id) - inDeals(i.id));
    if (b.amount > free + 0.5) throw new AppError(400, `Itna nahi de sakte — ${i.name} ka free balance Rs ${Math.round(Math.max(0, free)).toLocaleString("en-IN")} hai${inDeals(i.id) > 0 ? " (baqi deal me laga hai)" : ""}`);
  }
  const id = tx(() => moneyTxn(t, req.user!.name, i, b));
  audit(t, req.user!, b.dir === "in" ? "investor_capital_in" : "investor_payout", `investor:${i.id}`, { txn: id, ...b });
  return { id, balance: investorBalance(i.id) };
}));

/** cancel a money txn: the cash / bank row it made is removed, the record stays voided (shown struck through) */
investors.post("/investor-txns/:id/void", P, h((req) => {
  const t = tid(req);
  const x = get("SELECT * FROM investor_txns WHERE id=? AND tenant_id=? AND voided=0", Number(req.params.id), t);
  if (!x) throw new AppError(404, "Entry nahi mili");
  if (x.type === "profit" || x.type === "loss") throw new AppError(400, "Ye munafa / nuqsan deal ka hai — deal mansookh karein");
  const reason = String(req.body?.reason ?? "").trim();
  if (reason.length < 3) throw new AppError(400, "Wajah likhein (kam se kam 3 harf)");
  if (x.type === "capital_in") {
    const left = round2(investorBalance(x.investor_id) - x.amount - inDeals(x.investor_id));
    if (left < -0.5) throw new AppError(400, "Ye raqam deal me lag chuki hai — pehle deal mansookh karein");
  }
  tx(() => {
    for (const tag of String(x.src ?? "").split("+")) {
      const [kind, sid] = tag.split(":");
      if (kind === "voucher") run("DELETE FROM cashier_vouchers WHERE id=? AND tenant_id=?", Number(sid), t);
      else if (kind === "bank") run("DELETE FROM bank_txns WHERE id=? AND tenant_id=?", Number(sid), t);
    }
    run("UPDATE investor_txns SET voided=1, void_reason=?, voided_by=?, voided_at=? WHERE id=?", reason, req.user!.name, now(), x.id);
  });
  audit(t, req.user!, "investor_txn_void", `investor:${x.investor_id}`, { txn: x.id, type: x.type, amount: x.amount, reason });
  return { ok: true, balance: investorBalance(x.investor_id) };
}));

/* ---------------- deals ---------------- */
const dealBody = z.object({
  product: z.string().trim().min(2).max(10),
  litres: z.number().positive().max(10_000_000),
  cost_rate: z.number().positive().max(100_000),
  supplier_id: z.number().int().positive().optional().nullable(),
  ref: z.string().trim().max(60).optional().nullable(),
  note: z.string().trim().max(200).optional().nullable(),
  deal_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

investors.post("/investors/:id/deals", P, h((req) => {
  const t = tid(req), i = own(t, Number(req.params.id)), b = parse(dealBody, req.body);
  if (!i.active) throw new AppError(400, `${i.name} band hai`);
  if (b.supplier_id && !get("SELECT id FROM suppliers WHERE id=? AND tenant_id=?", b.supplier_id, t)) throw new AppError(404, "Supplier nahi mila");
  const cost = round2(b.litres * b.cost_rate);
  const free = round2(investorBalance(i.id) - inDeals(i.id));
  if (cost > free + 0.5) throw new AppError(400, `${i.name} ka free paisa Rs ${Math.round(Math.max(0, free)).toLocaleString("en-IN")} hai — deal Rs ${Math.round(cost).toLocaleString("en-IN")} ki nahi ho sakti. Pehle paisa (capital) darj karein ya litre kam karein.`);
  const id = run(`INSERT INTO investor_deals (tenant_id,investor_id,product,litres,cost_rate,cost_amount,supplier_id,ref,note,deal_date,our_pct,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    t, i.id, b.product, b.litres, b.cost_rate, cost, b.supplier_id ?? null, b.ref || null, b.note || null, b.deal_date || pkDate(), i.our_pct, req.user!.name, now()).id;
  audit(t, req.user!, "investor_deal", `investor:${i.id}`, { deal: id, ...b, cost });
  return ownDeal(t, id);
}));

/** edit an open deal (litres / rate / supplier / date) */
investors.patch("/investor-deals/:id", P, h((req) => {
  const t = tid(req), d = ownDeal(t, Number(req.params.id)), b = parse(dealBody, req.body);
  if (d.status !== "open") throw new AppError(400, "Band deal edit nahi hoti — mansookh kar ke dobara banayein");
  const cost = round2(b.litres * b.cost_rate);
  const free = round2(investorBalance(d.investor_id) - inDeals(d.investor_id) + d.cost_amount);
  if (cost > free + 0.5) throw new AppError(400, `Investor ka free paisa Rs ${Math.round(Math.max(0, free)).toLocaleString("en-IN")} hai — itni deal nahi ho sakti`);
  run("UPDATE investor_deals SET product=?, litres=?, cost_rate=?, cost_amount=?, supplier_id=?, ref=?, note=?, deal_date=? WHERE id=?",
    b.product, b.litres, b.cost_rate, cost, b.supplier_id ?? null, b.ref || null, b.note || null, b.deal_date || d.deal_date, d.id);
  audit(t, req.user!, "investor_deal_edit", `investor:${d.investor_id}`, { deal: d.id, before: d, after: b });
  return ownDeal(t, d.id);
}));

/** what the deal's fuel sold at: the average rate of that fuel sold since the deal (else today's price) */
investors.get("/investor-deals/:id/suggest", P, h((req) => {
  const t = tid(req), d = ownDeal(t, Number(req.params.id));
  const s = get(`SELECT COALESCE(SUM(s.amount),0) a, COALESCE(SUM(s.litres),0) l FROM sales s JOIN stations st ON st.id=s.station_id
      WHERE st.tenant_id=? AND s.product=? AND s.created_at >= ?`, t, d.product, pkStart(d.deal_date))!;
  const avg = s.l > 0 ? round2(s.a / s.l) : null;
  return { sale_rate: avg ?? currentPrices(t)[d.product]?.price ?? null, from_sales: avg != null, litres_sold_since: round2(s.l) };
}));

const closeBody = z.object({
  sold_litres: z.number().min(0).max(10_000_000),
  sale_rate: z.number().positive().max(100_000),
  exp_carriage: z.number().min(0).max(1_000_000_000).default(0),
  exp_overhead: z.number().min(0).max(1_000_000_000).default(0),
  exp_other: z.number().min(0).max(1_000_000_000).default(0),
  note: z.string().trim().max(200).optional().nullable(),
  /** pay the investor's profit share right now (har deal ke baad) */
  pay_now: z.object({ method: z.string().trim().max(30).optional().nullable(), account_id: accountIdField }).optional().nullable(),
});

/** the split, worked out the same way for the preview and the real close */
export function dealSplit(d: { litres: number; cost_amount: number; our_pct: number }, b: { sold_litres: number; sale_rate: number; exp_carriage?: number; exp_overhead?: number; exp_other?: number }) {
  const sale = round2(b.sold_litres * b.sale_rate);
  const expenses = round2((b.exp_carriage ?? 0) + (b.exp_overhead ?? 0) + (b.exp_other ?? 0));
  const profit = round2(sale - d.cost_amount - expenses);
  const investor = round2(profit * (100 - d.our_pct) / 100);
  return { sale_amount: sale, expenses, profit, investor_share: investor, our_share: round2(profit - investor), shortage_l: round2(Math.max(0, d.litres - b.sold_litres)) };
}

investors.post("/investor-deals/:id/close", P, h((req) => {
  const t = tid(req), d = ownDeal(t, Number(req.params.id)), b = parse(closeBody, req.body);
  if (d.status !== "open") throw new AppError(400, "Ye deal pehle se band hai");
  if (b.sold_litres > d.litres + 0.001) throw new AppError(400, `Deal me sirf ${d.litres} L tha — ${b.sold_litres} L nahi bik sakta`);
  const i = own(t, d.investor_id);
  const s = dealSplit(d, b);
  const by = req.user!.name;
  const out = tx(() => {
    run(`UPDATE investor_deals SET status='closed', sold_litres=?, sale_rate=?, sale_amount=?, exp_carriage=?, exp_overhead=?, exp_other=?, expenses=?,
        profit=?, investor_share=?, our_share=?, close_note=?, closed_by=?, closed_at=? WHERE id=?`,
      b.sold_litres, b.sale_rate, s.sale_amount, b.exp_carriage, b.exp_overhead, b.exp_other, s.expenses, s.profit, s.investor_share, s.our_share, b.note || null, by, now(), d.id);
    let shareTxn: number | null = null, paidTxn: number | null = null;
    if (Math.abs(s.investor_share) >= 0.01) {
      shareTxn = run(`INSERT INTO investor_txns (tenant_id,investor_id,type,amount,deal_id,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)`,
        t, i.id, s.investor_share > 0 ? "profit" : "loss", Math.abs(s.investor_share), d.id,
        `Deal #${d.id} ${s.investor_share > 0 ? "munafa" : "nuqsan"} — ${100 - d.our_pct}% hissa`, by, now()).id;
    }
    // har deal ke baad: the investor's profit share paid out now
    if (b.pay_now && s.investor_share > 0) paidTxn = moneyTxn(t, by, i, { dir: "out", amount: s.investor_share, method: b.pay_now.method, account_id: b.pay_now.account_id, purpose: "profit", note: `Deal #${d.id} ka munafa`, deal_id: d.id });
    return { shareTxn, paidTxn };
  });
  audit(t, req.user!, "investor_deal_close", `investor:${i.id}`, { deal: d.id, ...b, ...s, ...out });
  return { ...ownDeal(t, d.id), ...s, balance: investorBalance(i.id), paid: !!out.paidTxn };
}));

/** cancel a deal: its profit / loss share is reversed (a payout already made stays — cancel that separately) */
investors.post("/investor-deals/:id/void", P, h((req) => {
  const t = tid(req), d = ownDeal(t, Number(req.params.id));
  const reason = String(req.body?.reason ?? "").trim();
  if (reason.length < 3) throw new AppError(400, "Wajah likhein (kam se kam 3 harf)");
  tx(() => {
    run("UPDATE investor_txns SET voided=1, void_reason=?, voided_by=?, voided_at=? WHERE deal_id=? AND type IN ('profit','loss') AND voided=0", `Deal mansookh: ${reason}`, req.user!.name, now(), d.id);
    run("UPDATE investor_deals SET voided=1, void_reason=?, voided_by=?, voided_at=? WHERE id=?", reason, req.user!.name, now(), d.id);
  });
  audit(t, req.user!, "investor_deal_void", `investor:${d.investor_id}`, { deal: d.id, reason });
  return { ok: true, balance: investorBalance(d.investor_id) };
}));

/* ---------------- CEO dashboard ---------------- */
export function investorsSummary(t: number) {
  const list = all("SELECT * FROM investors WHERE tenant_id=? ORDER BY name", t).map((i) => ({ id: i.id, name: i.name, active: i.active, our_pct: i.our_pct, ...figures(i) }));
  const month = `${pkDate().slice(0, 7)}-01`;
  const m = get(`SELECT COALESCE(SUM(profit),0) p, COALESCE(SUM(our_share),0) o, COALESCE(SUM(investor_share),0) i, COUNT(*) n FROM investor_deals
      WHERE tenant_id=? AND status='closed' AND voided=0 AND closed_at >= ?`, t, pkStart(month))!;
  const sum = (k: keyof (typeof list)[number]) => round2(list.reduce((a, x) => a + (Number(x[k]) || 0), 0));
  return {
    count: list.filter((x) => x.active).length,
    capital_in: sum("capital_in"), in_deals: sum("in_deals"), owed: investorsOwed(t),
    deal_profit: sum("deal_profit"), our_share: sum("our_share"), investor_share: round2(sum("deal_profit") - sum("our_share")), paid_out: sum("paid_out"),
    open_deals: sum("open_deals"),
    month: { profit: round2(m.p), our_share: round2(m.o), investor_share: round2(m.i), deals: m.n },
    list: list.filter((x) => x.active || Math.abs(x.balance) > 0.5),
  };
}
investors.get("/investors-summary", P, h((req) => investorsSummary(tid(req))));
