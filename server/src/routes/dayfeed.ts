/**
 * "Aaj ki saari entries" — one read-only, chronological feed of every money event of a day across the whole pump, for the
 * dashboard and the cashier desk (the POS already has its own shift feed). It is informational only (no money math, nothing
 * written), so it never affects the books. Each kind is drawn from ONE canonical table to avoid double-counting:
 *   sales (fuel/shop) · approved+pending expenses · cashier vouchers (counter receive/pay) · manual khata charges/payments
 *   that are not a sale and not mirrored by a cashier voucher · tanker deliveries (stock in).
 * A per-person summary (who entered what) gives the "salesman / cashier ki daily report" roll-up.
 */
import { Router } from "express";
import { z } from "zod";
import { all, pkStart, pkEnd, pkDate } from "../db.js";
import { h, parse, tid, requireAny } from "../auth.js";
import { PRODUCTS } from "../config.js";
import { round2 } from "../services.js";

export const dayfeed = Router();

type Dir = "in" | "out" | "neutral";
interface FeedRow { id: string; at: string; kind: string; who: string | null; party: string | null; label: string; amount: number; dir: Dir; ref: string | null; ledger_id?: number; litres?: number; rate?: number }

dayfeed.get("/day-feed", requireAny("dashboard.view", "cashier.desk", "reports.view"), h((req) => {
  const t = tid(req);
  const D = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
  const q = parse(z.object({ date: D, from: D, to: D, scope: z.enum(["all", "pos", "cashier", "supplier", "wholesale"]).optional() }), req.query);
  const scope = q.scope ?? "all"; // all = whole pump; pos = fuel/shop sales + expenses (POS left panel); cashier = counter vouchers; supplier = supplier dealings; wholesale = wholesale client dealings
  // a single day (date=) or a range (from=&to=); reversed dates are swapped so the window is always valid
  const a = q.from ?? q.date ?? pkDate(), b = q.to ?? q.date ?? a;
  const lo = a <= b ? a : b, hi = a <= b ? b : a;
  const from = pkStart(lo), to = pkEnd(hi);
  const P = [t, from, to] as const;
  const rows: FeedRow[] = [];

  // fuel / shop sales (cash, card, khata, wholesale all in one table) — the billed value incl. any baqi-cash / shop-saman
  if (scope === "all" || scope === "pos") for (const s of all(`SELECT s.id, s.created_at, s.product, s.litres, s.rate, s.amount, s.payment_method, s.cash_back, s.cash_back_litres, s.items_cost, s.khareed,
       u.name who, c.name cust FROM sales s JOIN stations st ON st.id=s.station_id LEFT JOIN users u ON u.id=s.created_by LEFT JOIN customers c ON c.id=s.customer_id
     WHERE st.tenant_id=? AND s.created_at>=? AND s.created_at<?`, ...P)) {
    const litres = round2((s.litres ?? 0) + (s.cash_back_litres ?? 0));
    const amount = round2((s.amount ?? 0) + (s.cash_back ?? 0) + (s.items_cost ?? 0) + (s.khareed ?? 0));
    // litres & per-litre rate go in their own fields (separate columns) — label keeps product + payment method
    rows.push({ id: `sale-${s.id}`, at: s.created_at, kind: "sale", who: s.who ?? null, party: s.cust ?? null,
      label: `${PRODUCTS[s.product] ?? s.product} · ${s.payment_method}`, amount, dir: "in", ref: `SALE-${s.id}`,
      litres: litres || undefined, rate: s.rate ? round2(s.rate) : undefined });
  }
  // expenses (approved + pending)
  if (scope === "all" || scope === "pos") for (const e of all(`SELECT id, created_at, category, paid_to, method, amount, status, created_by who FROM expenses WHERE tenant_id=? AND created_at>=? AND created_at<?`, ...P))
    rows.push({ id: `exp-${e.id}`, at: e.created_at, kind: "expense", who: e.who ?? null, party: e.paid_to ?? null,
      label: `${e.category} · ${e.method}${e.status === "pending" ? " (approval me)" : ""}`, amount: round2(e.amount), dir: "out", ref: null });
  // cashier counter vouchers (receive / pay) — not voided
  // the Cashier tab shows only the cashier's OWN counter entries — payments that belong to a party module
  // (khata customer, wholesale client, supplier, staff) are shown in THAT module, not mixed in here.
  const cashierOnly = scope === "cashier"
    ? " AND COALESCE(src,'') NOT LIKE 'khata:%' AND COALESCE(src,'') NOT LIKE 'wtx:%' AND COALESCE(src,'') NOT LIKE 'stx:%' AND COALESCE(src,'') NOT LIKE 'staff:%'"
    : "";
  if (scope === "all" || scope === "cashier") for (const v of all(`SELECT id, created_at, direction, party_type, party_name, amount, method, category, note, created_by who, voided, src FROM cashier_vouchers WHERE tenant_id=? AND created_at>=? AND created_at<? AND COALESCE(voided,0)=0${cashierOnly}`, ...P))
    rows.push({ id: `cv-${v.id}`, at: v.created_at, kind: v.direction === "in" ? "receive" : "pay", who: v.who ?? null, party: v.party_name ?? null,
      label: `${v.direction === "in" ? "Received" : "Paid"} · ${v.party_type}${v.category ? ` · ${v.category}` : ""} · ${v.method}`, amount: round2(v.amount), dir: v.direction === "in" ? "in" : "out", ref: v.src ?? null });
  // manual khata charges / payments that are NOT a sale and NOT mirrored by a cashier voucher (so nothing shows twice)
  if (scope === "all") for (const k of all(`SELECT k.id, k.created_at, k.type, k.amount, k.ref, k.note, c.name cust FROM khata_ledger k JOIN customers c ON c.id=k.customer_id
     WHERE c.tenant_id=? AND k.created_at>=? AND k.created_at<? AND k.ref NOT LIKE 'SALE-%' AND k.ref NOT LIKE 'SHOP-%' AND k.ref NOT LIKE 'LATE-%'
       AND NOT EXISTS (SELECT 1 FROM cashier_vouchers v WHERE v.tenant_id=? AND v.src='khata:'||k.id AND COALESCE(v.voided,0)=0)`, t, from, to, t)) {
    const refund = String(k.ref ?? "").startsWith("refund:");
    rows.push({ id: `khata-${k.id}`, at: k.created_at, kind: refund ? "refund" : k.type === "credit" ? "khata_in" : "khata_charge", who: null, party: k.cust ?? null,
      label: refund ? "Advance wapas" : k.type === "credit" ? "Khata payment" : "Khata charge", amount: round2(k.amount), dir: refund ? "out" : k.type === "credit" ? "in" : "neutral", ref: `khata:${k.id}`, ledger_id: k.id });
  }
  // tanker deliveries (stock received)
  if (scope === "all" || scope === "supplier") for (const d of all(`SELECT d.id, d.created_at, d.received_l, d.purchase_rate, k.product, s.name supplier FROM deliveries d JOIN tanks k ON k.id=d.tank_id JOIN stations st ON st.id=k.station_id
       LEFT JOIN suppliers s ON s.id=d.supplier_id WHERE st.tenant_id=? AND d.created_at>=? AND d.created_at<?`, ...P))
    rows.push({ id: `dlv-${d.id}`, at: d.created_at, kind: "supply", who: null, party: d.supplier ?? null,
      label: `Supply aayi · ${PRODUCTS[d.product] ?? d.product}`, amount: round2((d.received_l ?? 0) * (d.purchase_rate ?? 0)), dir: "neutral", ref: null,
      litres: d.received_l ? round2(d.received_l) : undefined, rate: d.purchase_rate ? round2(d.purchase_rate) : undefined });

  // supplier dealings (purchases on account, payments to suppliers, adjustments) — supplier page feed only; deliveries above cover stock-in
  if (scope === "supplier") for (const x of all(`SELECT x.id, x.created_at, x.type, x.product, x.litres, x.rate, x.amount, x.method, x.note, x.created_by who, s.name supplier
       FROM supplier_txns x JOIN suppliers s ON s.id=x.supplier_id WHERE x.tenant_id=? AND x.created_at>=? AND x.created_at<?`, ...P)) {
    const pay = x.type === "payment";
    rows.push({ id: `stx-${x.id}`, at: x.created_at, kind: pay ? "pay" : x.type === "purchase" ? "supply_bill" : "adjust", who: x.who ?? null, party: x.supplier ?? null,
      label: pay ? `Supplier ko diya${x.method ? ` · ${x.method}` : ""}` : x.type === "purchase" ? `Udhaar maal${x.product ? ` · ${PRODUCTS[x.product] ?? x.product}` : ""}` : `Adjustment${x.note ? ` · ${x.note}` : ""}`,
      amount: round2(x.amount ?? 0), dir: pay ? "out" : x.type === "purchase" ? "neutral" : "neutral", ref: null,
      litres: !pay && x.litres ? round2(x.litres) : undefined, rate: !pay && x.rate ? round2(x.rate) : undefined });
  }

  // wholesale client dealings (supply / return / payment / adjustment) — the wholesale dashboard's own feed
  // only the Wholesale desk's OWN entries — a supply billed through POS (wt.sale_id set) belongs to POS, not here
  if (scope === "wholesale") for (const w of all(`SELECT w.id, w.created_at, w.type, w.product, w.litres, w.rate, w.amount, w.method, w.vehicle_no, w.created_by who, c.name client
       FROM wholesale_txns w JOIN wholesale_clients c ON c.id=w.client_id WHERE w.tenant_id=? AND COALESCE(w.voided,0)=0 AND w.sale_id IS NULL AND w.created_at>=? AND w.created_at<?`, ...P)) {
    const kind = w.type === "payment" ? "khata_in" : w.type === "supply" ? "ws_supply" : w.type === "return" ? "ws_return" : "adjust";
    const dir: Dir = w.type === "payment" ? "in" : w.type === "return" ? "out" : "neutral";
    // litres & rate go in their own fields (separate columns) — label keeps only the action, product and vehicle
    const label = w.type === "payment" ? `Payment aayi${w.method ? ` · ${w.method}` : ""}`
      : w.type === "supply" ? `Supply di${w.product ? ` · ${PRODUCTS[w.product] ?? w.product}` : ""}${w.vehicle_no ? ` · ${w.vehicle_no}` : ""}`
      : w.type === "return" ? "Wapas aaya" : "Adjustment";
    rows.push({ id: `wtx-${w.id}`, at: w.created_at, kind, who: w.who ?? null, party: w.client ?? null, label, amount: round2(w.amount ?? 0), dir, ref: null,
      litres: w.litres ? round2(w.litres) : undefined, rate: w.rate ? round2(w.rate) : undefined });
  }

  // fuel the wholesale officer BUYS from a supplier (bypass purchases — supplier se maal liya, seedha clients ko) + usay di gayi payments
  if (scope === "wholesale") {
    for (const p of all(`SELECT p.id, p.created_at, p.product, p.litres, p.cost_rate, p.amount, p.ref, p.created_by who, s.name supplier
         FROM bypass_purchases p JOIN suppliers s ON s.id=p.supplier_id WHERE p.tenant_id=? AND COALESCE(p.voided,0)=0 AND p.created_at>=? AND p.created_at<?`, ...P)) {
      rows.push({ id: `bpur-${p.id}`, at: p.created_at, kind: "supply_bill", who: p.who ?? null, party: p.supplier ?? null,
        label: `Supplier se maal liya${p.product ? ` · ${PRODUCTS[p.product] ?? p.product}` : ""}`,
        amount: round2(p.amount ?? 0), dir: "neutral", ref: p.ref ?? null,
        litres: p.litres ? round2(p.litres) : undefined, rate: p.cost_rate ? round2(p.cost_rate) : undefined });
    }
    for (const sp of all(`SELECT sp.id, sp.created_at, sp.amount, sp.method, sp.created_by who, s.name supplier
         FROM bypass_supplier_payments sp JOIN suppliers s ON s.id=sp.supplier_id WHERE sp.tenant_id=? AND COALESCE(sp.voided,0)=0 AND sp.mode<>'client_direct' AND sp.created_at>=? AND sp.created_at<?`, ...P)) {
      rows.push({ id: `bspay-${sp.id}`, at: sp.created_at, kind: "pay", who: sp.who ?? null, party: sp.supplier ?? null,
        label: `Supplier ko diya${sp.method ? ` · ${sp.method}` : ""}`, amount: round2(sp.amount ?? 0), dir: "out", ref: null });
    }
  }

  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); // newest first

  // per-person roll-up (who entered what) — the salesman / cashier daily report
  const byPerson = new Map<string, { who: string; sales: number; expenses: number; received: number; paid: number; n: number }>();
  for (const r of rows) {
    const who = r.who || "—";
    const p = byPerson.get(who) ?? { who, sales: 0, expenses: 0, received: 0, paid: 0, n: 0 };
    if (r.kind === "sale") p.sales += r.amount;
    else if (r.kind === "expense") p.expenses += r.amount;
    else if (r.dir === "in") p.received += r.amount;
    else if (r.dir === "out") p.paid += r.amount;
    p.n++; byPerson.set(who, p);
  }
  const totals = {
    sales: round2(rows.filter((r) => r.kind === "sale").reduce((a, r) => a + r.amount, 0)),
    expenses: round2(rows.filter((r) => r.kind === "expense").reduce((a, r) => a + r.amount, 0)),
    received: round2(rows.filter((r) => r.dir === "in" && r.kind !== "sale").reduce((a, r) => a + r.amount, 0)),
    paid: round2(rows.filter((r) => r.dir === "out" && r.kind !== "expense").reduce((a, r) => a + r.amount, 0)),
    count: rows.length,
  };
  return { date: lo === hi ? lo : `${lo} → ${hi}`, from: lo, to: hi, is_today: lo === hi && lo === pkDate(), days: 1 + Math.round((Date.parse(hi) - Date.parse(lo)) / 86_400_000), scope, rows, totals,
    by_person: [...byPerson.values()].map((p) => ({ ...p, sales: round2(p.sales), expenses: round2(p.expenses), received: round2(p.received), paid: round2(p.paid) })).sort((a, b) => b.sales - a.sales || b.n - a.n) };
}));
