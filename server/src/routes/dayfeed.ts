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
interface FeedRow { id: string; at: string; kind: string; who: string | null; party: string | null; label: string; amount: number; dir: Dir; ref: string | null; ledger_id?: number }

dayfeed.get("/day-feed", requireAny("dashboard.view", "cashier.desk", "reports.view"), h((req) => {
  const t = tid(req);
  const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
  const day = q.date ?? pkDate();
  const from = pkStart(day), to = pkEnd(day);
  const P = [t, from, to] as const;
  const rows: FeedRow[] = [];

  // fuel / shop sales (cash, card, khata, wholesale all in one table) — the billed value incl. any baqi-cash / shop-saman
  for (const s of all(`SELECT s.id, s.created_at, s.product, s.litres, s.amount, s.payment_method, s.cash_back, s.cash_back_litres, s.items_cost, s.khareed,
       u.name who, c.name cust FROM sales s JOIN stations st ON st.id=s.station_id LEFT JOIN users u ON u.id=s.created_by LEFT JOIN customers c ON c.id=s.customer_id
     WHERE st.tenant_id=? AND s.created_at>=? AND s.created_at<?`, ...P)) {
    const litres = round2((s.litres ?? 0) + (s.cash_back_litres ?? 0));
    const amount = round2((s.amount ?? 0) + (s.cash_back ?? 0) + (s.items_cost ?? 0) + (s.khareed ?? 0));
    rows.push({ id: `sale-${s.id}`, at: s.created_at, kind: "sale", who: s.who ?? null, party: s.cust ?? null,
      label: `${PRODUCTS[s.product] ?? s.product}${litres ? ` ${litres} L` : ""} · ${s.payment_method}`, amount, dir: "in", ref: `SALE-${s.id}` });
  }
  // expenses (approved + pending)
  for (const e of all(`SELECT id, created_at, category, paid_to, method, amount, status, created_by who FROM expenses WHERE tenant_id=? AND created_at>=? AND created_at<?`, ...P))
    rows.push({ id: `exp-${e.id}`, at: e.created_at, kind: "expense", who: e.who ?? null, party: e.paid_to ?? null,
      label: `${e.category}${e.paid_to ? ` · ${e.paid_to}` : ""} · ${e.method}${e.status === "pending" ? " (approval me)" : ""}`, amount: round2(e.amount), dir: "out", ref: null });
  // cashier counter vouchers (receive / pay) — not voided
  for (const v of all(`SELECT id, created_at, direction, party_type, party_name, amount, method, category, note, created_by who, voided, src FROM cashier_vouchers WHERE tenant_id=? AND created_at>=? AND created_at<? AND COALESCE(voided,0)=0`, ...P))
    rows.push({ id: `cv-${v.id}`, at: v.created_at, kind: v.direction === "in" ? "receive" : "pay", who: v.who ?? null, party: v.party_name ?? null,
      label: `${v.direction === "in" ? "Received" : "Paid"} · ${v.party_type}${v.category ? ` · ${v.category}` : ""} · ${v.method}`, amount: round2(v.amount), dir: v.direction === "in" ? "in" : "out", ref: v.src ?? null });
  // manual khata charges / payments that are NOT a sale and NOT mirrored by a cashier voucher (so nothing shows twice)
  for (const k of all(`SELECT k.id, k.created_at, k.type, k.amount, k.ref, k.note, c.name cust FROM khata_ledger k JOIN customers c ON c.id=k.customer_id
     WHERE c.tenant_id=? AND k.created_at>=? AND k.created_at<? AND k.ref NOT LIKE 'SALE-%' AND k.ref NOT LIKE 'SHOP-%' AND k.ref NOT LIKE 'LATE-%'
       AND NOT EXISTS (SELECT 1 FROM cashier_vouchers v WHERE v.tenant_id=? AND v.src='khata:'||k.id AND COALESCE(v.voided,0)=0)`, t, from, to, t)) {
    const refund = String(k.ref ?? "").startsWith("refund:");
    rows.push({ id: `khata-${k.id}`, at: k.created_at, kind: refund ? "refund" : k.type === "credit" ? "khata_in" : "khata_charge", who: null, party: k.cust ?? null,
      label: refund ? `Advance wapas · ${k.cust}` : k.type === "credit" ? `Khata payment · ${k.cust}` : `Khata charge · ${k.cust}`, amount: round2(k.amount), dir: refund ? "out" : k.type === "credit" ? "in" : "neutral", ref: `khata:${k.id}`, ledger_id: k.id });
  }
  // tanker deliveries (stock received)
  for (const d of all(`SELECT d.id, d.created_at, d.received_l, d.purchase_rate, k.product, s.name supplier FROM deliveries d JOIN tanks k ON k.id=d.tank_id JOIN stations st ON st.id=k.station_id
       LEFT JOIN suppliers s ON s.id=d.supplier_id WHERE st.tenant_id=? AND d.created_at>=? AND d.created_at<?`, ...P))
    rows.push({ id: `dlv-${d.id}`, at: d.created_at, kind: "supply", who: null, party: d.supplier ?? null,
      label: `Supply aayi · ${PRODUCTS[d.product] ?? d.product} ${round2(d.received_l ?? 0)} L${d.supplier ? ` · ${d.supplier}` : ""}`, amount: round2((d.received_l ?? 0) * (d.purchase_rate ?? 0)), dir: "neutral", ref: null });

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
  return { date: day, is_today: day === pkDate(), rows, totals,
    by_person: [...byPerson.values()].map((p) => ({ ...p, sales: round2(p.sales), expenses: round2(p.expenses), received: round2(p.received), paid: round2(p.paid) })).sort((a, b) => b.sales - a.sales || b.n - a.n) };
}));
