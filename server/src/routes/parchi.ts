/**
 * Parchi Billing: a khata customer brings parchiyan (slips) — he takes neither fuel nor cash at the time; each parchi only
 * goes on his khata. Many parchiyan are entered at once, each with its own date (earlier or the same day), slip no.,
 * vehicle, and either fuel (litres × that day's rate) or a shop item (qty × the item's rate).
 *
 * - Every line is one khata debit (ref PR-n, dated the parchi's day). Nothing else moves: no tank, shop stock, bag or bank.
 * - In the books it is a khata charge — Khata receivable ← Other income (ledger.ts) — so the books stay level.
 * - Litres / item / rate live on the parchi line (and in the khata note), never in the khata litres column, so no fuel
 *   report counts a parchi as fuel sold.
 * - Payment comes later as an ordinary khata payment; the Parchi Book shows each parchi Paid / part / Unpaid, the oldest
 *   charge cleared first.
 * Manager / CEO only. The owner is alerted for every batch.
 */
import crypto from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { all, get, run, tx, now, pkDate, pkStart, pkEnd } from "../db.js";
import { h, parse, tid, requirePerm } from "../auth.js";
import { AppError, audit, createAlert, currentPrices, pkr, round2 } from "../services.js";
import { linkPhotos, proofPhotos } from "./capture.js";
import { backdateAt } from "./backoffice.js";
import { PRODUCTS } from "../config.js";

export const parchi = Router();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const staffOnly = (role: string) => { if (!["admin", "manager"].includes(role)) throw new AppError(403, "Parchi Billing sirf manager ya CEO ke liye hai"); };
const own = (t: number, id: number) => {
  const c = get("SELECT * FROM customers WHERE id=? AND tenant_id=?", id, t);
  if (!c) throw new AppError(404, "Customer not found");
  return c;
};

/** The rate of every fuel on a day (the price in force at that day's end; today = now). */
function ratesOn(t: number, d: string) {
  const at = d >= pkDate() ? now() : pkEnd(d);
  return Object.fromEntries(Object.entries(currentPrices(t, at)).map(([p, v]) => [p, v.price]));
}

/** What the form needs for one customer: the khata, the vehicles, the shop items and today's rates. */
parchi.get("/parchi/meta", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  const q = parse(z.object({ customer_id: z.coerce.number().int().optional(), date: day.optional() }), req.query);
  const items = all(`SELECT i.id, i.name, i.price, i.unit, s.name station FROM shop_items i JOIN stations s ON s.id=i.station_id WHERE i.tenant_id=? AND i.active=1 ORDER BY i.category, i.name`, t);
  const multi = new Set(items.map((i) => i.station)).size > 1;
  const out: Record<string, unknown> = { items: items.map((i) => ({ id: i.id, name: multi ? `${i.name} · ${i.station}` : i.name, price: i.price, unit: i.unit })), rates: ratesOn(t, q.date ?? pkDate()), today: pkDate() };
  if (q.customer_id) {
    const c = own(t, q.customer_id);
    const monthStart = pkStart(`${pkDate().slice(0, 7)}-01`);
    out.customer = { id: c.id, name: c.name, phone: c.phone, city: c.city, balance: round2(c.balance), credit_limit: c.credit_limit,
      month: round2(get("SELECT COALESCE(SUM(amount),0) v FROM khata_ledger WHERE customer_id=? AND type='debit' AND created_at >= ?", c.id, monthStart)!.v as number),
      last_payment: get("SELECT amount, created_at FROM khata_ledger WHERE customer_id=? AND type='credit' ORDER BY created_at DESC, id DESC LIMIT 1", c.id) ?? null,
      recent: all("SELECT id, type, amount, ref, note, product, litres, vehicle_no, slip_no, created_at FROM khata_ledger WHERE customer_id=? ORDER BY created_at DESC, id DESC LIMIT 3", c.id) };
    out.vehicles = all("SELECT id, plate_no, fuel, daily_limit_l FROM vehicles WHERE customer_id=? ORDER BY plate_no", c.id);
  }
  return out;
}));
parchi.get("/parchi/rates", requirePerm("khata.manage"), h((req) => ratesOn(tid(req), parse(z.object({ date: day }), req.query).date)));

const lineSchema = z.object({
  parchi_date: day, slip_no: z.string().trim().max(40).optional().nullable(), vehicle_no: z.string().trim().max(30).optional().nullable(),
  kind: z.enum(["fuel", "shop"]), product: z.string().max(12).optional().nullable(), item_id: z.number().int().optional().nullable(),
  qty: z.number().positive().max(200_000), rate: z.number().positive().max(10_000_000).optional().nullable(), photo_ids: proofPhotos,
});

/** Save many parchiyan for one customer in one go (all or nothing). */
export function saveParchis(req: Parameters<Parameters<typeof h>[0]>[0], customerId: number, lines: z.infer<typeof lineSchema>[], note?: string | null) {
  const t = tid(req);
  staffOnly(req.user!.role);
  const c = own(t, customerId);
  if (!lines.length) throw new AppError(400, "Kam az kam ek parchi likhein");
  const batch = crypto.randomUUID();
  const by = req.user!.name;
  const rateCache: Record<string, Record<string, number>> = {};
  const priced = lines.map((l, i) => {
    const at = backdateAt(req, t, l.parchi_date) ?? now(); // a future date is refused; a closed day is CEO-only
    let rate = l.rate ?? null, label: string, product: string | null = null, itemId: number | null = null, itemName: string | null = null;
    if (l.kind === "fuel") {
      if (!l.product || !PRODUCTS[l.product]) throw new AppError(400, `Line ${i + 1}: fuel chunein`);
      product = l.product;
      rate ??= (rateCache[l.parchi_date] ??= ratesOn(t, l.parchi_date))[l.product] ?? null;
      if (!rate) throw new AppError(400, `Line ${i + 1}: ${PRODUCTS[l.product]} ka rate nahi mila — rate likhein`);
      label = `${round2(l.qty)} L ${PRODUCTS[l.product]} × ${rate}`;
    } else {
      const it = l.item_id ? get("SELECT id, name, price FROM shop_items WHERE id=? AND tenant_id=?", l.item_id, t) : null;
      if (!it) throw new AppError(400, `Line ${i + 1}: shop item chunein`);
      itemId = it.id as number; itemName = it.name as string;
      rate ??= Number(it.price) || null;
      if (!rate) throw new AppError(400, `Line ${i + 1}: ${it.name} ka rate likhein`);
      label = `${round2(l.qty)} × ${it.name} @ ${rate}`;
    }
    return { ...l, at, rate: round2(rate), amount: round2(l.qty * rate), product, itemId, itemName, label };
  });
  const total = round2(priced.reduce((a, l) => a + l.amount, 0));
  const ids = tx(() => {
    const out: number[] = [];
    for (const l of priced) {
      const pid = run(`INSERT INTO parchi_lines (tenant_id,customer_id,batch_id,parchi_date,slip_no,vehicle_no,kind,product,item_id,item_name,qty,rate,amount,note,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, t, c.id, batch, l.parchi_date, l.slip_no || null, l.vehicle_no || null, l.kind, l.product, l.itemId, l.itemName,
        round2(l.qty), l.rate, l.amount, note || null, by, now()).id as number;
      const k = run("INSERT INTO khata_ledger (customer_id,type,amount,ref,note,vehicle_no,slip_no,created_at) VALUES (?,?,?,?,?,?,?,?)",
        c.id, "debit", l.amount, `PR-${pid}`, ["🎫 Parchi", l.label, note].filter(Boolean).join(" · "), l.vehicle_no || null, l.slip_no || null, l.at).id as number;
      run("UPDATE parchi_lines SET khata_id=? WHERE id=?", k, pid);
      if (l.photo_ids?.length) linkPhotos(t, l.photo_ids, `khata:${k}`);
      out.push(pid);
    }
    run("UPDATE customers SET balance = balance + ? WHERE id=?", total, c.id);
    audit(t, req.user!, "parchi:batch", batch, { customer: c.name, lines: priced.length, total });
    return out;
  });
  const balance = round2(get("SELECT balance FROM customers WHERE id=?", c.id)!.balance as number);
  createAlert(t, { type: "khata_parchi", severity: "info", title: `Parchi Billing: ${pkr(total)} — ${c.name} (${priced.length} parchi)`,
    body: `${by} ne ${c.name} ke khate mein ${priced.length} parchi likhin, kul ${pkr(total)} (na tail diya, na cash). Naya balance ${pkr(balance)}${c.credit_limit > 0 && balance > c.credit_limit ? ` — limit ${pkr(c.credit_limit)} se zyada` : ""}. IDs ${ids.map((i) => `PR-${i}`).join(", ")}.` });
  return { batch_id: batch, ids, entry_ids: ids.map((i) => `PR-${i}`), total, balance, over_limit: c.credit_limit > 0 && balance > c.credit_limit };
}

parchi.post("/parchi/batch", requirePerm("khata.manage"), h((req) => {
  const b = parse(z.object({ customer_id: z.number().int(), note: z.string().trim().max(200).optional().nullable(), lines: z.array(lineSchema).min(1).max(100) }), req.body);
  return saveParchis(req, b.customer_id, b.lines, b.note);
}));

/** Each charge's unpaid part, payments clearing the oldest charge first (an advance paid ahead clears the next ones). */
function openParts(customerId: number) {
  const rows = all("SELECT id, type, amount FROM khata_ledger WHERE customer_id=? ORDER BY created_at, id", customerId);
  const open: { id: number; left: number }[] = [];
  let advance = 0;
  for (const r of rows) {
    if (r.type === "debit") { const use = Math.min(advance, r.amount); advance -= use; open.push({ id: r.id, left: r.amount - use }); }
    else { let pay = r.amount; for (const o of open) { if (pay <= 0) break; const take = Math.min(o.left, pay); o.left -= take; pay -= take; } advance += pay; }
  }
  return new Map(open.map((o) => [o.id, round2(o.left)]));
}

/** The Parchi Book: every parchi with its status (Paid / part / Unpaid). One customer or all; a date range on the parchi date. */
parchi.get("/parchi/book", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  const q = parse(z.object({ customer_id: z.coerce.number().int().optional(), from: day.optional(), to: day.optional(), voided: z.coerce.number().optional() }), req.query);
  const rows = all(`SELECT p.*, c.name customer FROM parchi_lines p JOIN customers c ON c.id=p.customer_id WHERE p.tenant_id=?
      ${q.customer_id ? "AND p.customer_id=?" : ""} ${q.from ? "AND p.parchi_date >= ?" : ""} ${q.to ? "AND p.parchi_date <= ?" : ""} ${q.voided ? "" : "AND p.voided=0"}
      ORDER BY p.parchi_date DESC, p.id DESC LIMIT 1000`, ...[t, ...(q.customer_id ? [q.customer_id] : []), ...(q.from ? [q.from] : []), ...(q.to ? [q.to] : [])]);
  const parts = new Map<number, Map<number, number>>();
  const list = rows.map((r) => {
    if (r.voided) return { ...r, unpaid: 0, status: "void" };
    if (!parts.has(r.customer_id)) parts.set(r.customer_id, openParts(r.customer_id));
    const left = parts.get(r.customer_id)!.get(r.khata_id) ?? 0;
    return { ...r, unpaid: left, status: left <= 0.5 ? "paid" : left >= r.amount - 0.5 ? "unpaid" : "part" };
  });
  const live = list.filter((r) => r.status !== "void");
  return { rows: list, totals: { n: live.length, amount: round2(live.reduce((a, r) => a + r.amount, 0)), unpaid: round2(live.reduce((a, r) => a + r.unpaid, 0)),
    fuel: round2(live.filter((r) => r.kind === "fuel").reduce((a, r) => a + r.amount, 0)), shop: round2(live.filter((r) => r.kind === "shop").reduce((a, r) => a + r.amount, 0)) } };
}));

/** Cancel one parchi (a mistake): its khata charge is removed and the balance comes down. Kept in the book as void. */
parchi.post("/parchi/:id/void", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  staffOnly(req.user!.role);
  const b = parse(z.object({ reason: z.string().trim().min(3, "Wajah likhein").max(200) }), req.body);
  const p = get("SELECT * FROM parchi_lines WHERE id=? AND tenant_id=?", Number(req.params.id), t);
  if (!p) throw new AppError(404, "Parchi not found");
  if (p.voided) throw new AppError(400, "Ye parchi pehle hi mansookh hai");
  const k = p.khata_id ? get("SELECT * FROM khata_ledger WHERE id=?", p.khata_id) : null;
  if (k) backdateAt(req, t, new Date(Date.parse(k.created_at) + 5 * 3600_000).toISOString().slice(0, 10) === pkDate() ? null : new Date(Date.parse(k.created_at) + 5 * 3600_000).toISOString().slice(0, 10)); // closed day: CEO only
  tx(() => {
    if (k) { run("DELETE FROM khata_ledger WHERE id=?", k.id); run("UPDATE customers SET balance = balance - ? WHERE id=?", k.amount, p.customer_id); }
    run("UPDATE parchi_lines SET voided=1, void_reason=? WHERE id=?", b.reason, p.id);
    audit(t, req.user!, "parchi:void", `PR-${p.id}`, { amount: p.amount, reason: b.reason });
  });
  return { ok: true, balance: round2(get("SELECT balance FROM customers WHERE id=?", p.customer_id)!.balance as number) };
}));
