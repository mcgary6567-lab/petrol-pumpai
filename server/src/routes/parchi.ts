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
    // saved gaariyan, most used first (khata entries with that plate)
    out.vehicles = all(`SELECT v.id, v.plate_no, v.fuel, v.daily_limit_l, (SELECT COUNT(*) FROM khata_ledger k WHERE k.customer_id=v.customer_id AND UPPER(k.vehicle_no)=UPPER(v.plate_no)) uses
      FROM vehicles v WHERE v.customer_id=? ORDER BY uses DESC, v.plate_no`, c.id);
    // slip nos. already on this khata — the form warns before the same parchi goes on twice
    out.slips = [
      ...all("SELECT slip_no slip, 'PR-'||id ref, parchi_date date FROM parchi_lines WHERE customer_id=? AND voided=0 AND slip_no IS NOT NULL AND TRIM(slip_no)<>'' ORDER BY id DESC LIMIT 5000", c.id),
      ...all("SELECT slip_no slip, 'K-'||id ref, substr(created_at,1,10) date FROM khata_ledger WHERE customer_id=? AND slip_no IS NOT NULL AND TRIM(slip_no)<>'' AND COALESCE(ref,'') NOT LIKE 'PR-%' ORDER BY id DESC LIMIT 5000", c.id),
    ];
  }
  return out;
}));
parchi.get("/parchi/rates", requirePerm("khata.manage"), h((req) => ratesOn(tid(req), parse(z.object({ date: day }), req.query).date)));

const lineSchema = z.object({
  parchi_date: day, slip_no: z.string().trim().max(40).optional().nullable(), vehicle_no: z.string().trim().max(30).optional().nullable(),
  kind: z.enum(["fuel", "shop"]), product: z.string().max(12).optional().nullable(), item_id: z.number().int().optional().nullable(),
  qty: z.number().positive().max(200_000), rate: z.number().positive().max(10_000_000).optional().nullable(), photo_ids: proofPhotos,
  // the parchi says a money amount ("Rs 5,000"): that exact amount goes on the khata; qty is amount ÷ rate
  amount: z.number().positive().max(100_000_000).optional().nullable(),
});

/** One parchi line priced: the khata date (closed day CEO-only, no future), the rate (fuel = that day's, shop = the item's,
 *  unless typed) and the label written on the khata. */
function priceLine(req: Parameters<typeof backdateAt>[0], t: number, l: z.infer<typeof lineSchema>, tag: string, rateCache: Record<string, Record<string, number>> = {}) {
  const at = backdateAt(req, t, l.parchi_date) ?? now(); // a future date is refused; a closed day is CEO-only
  let rate = l.rate ?? null, label: string, product: string | null = null, itemId: number | null = null, itemName: string | null = null;
  if (l.kind === "fuel") {
    if (!l.product || !PRODUCTS[l.product]) throw new AppError(400, `${tag}: fuel chunein`);
    product = l.product;
    rate ??= (rateCache[l.parchi_date] ??= ratesOn(t, l.parchi_date))[l.product] ?? null;
    if (!rate) throw new AppError(400, `${tag}: ${PRODUCTS[l.product]} ka rate nahi mila — rate likhein`);
    label = `${round2(l.qty)} L ${PRODUCTS[l.product]} × ${rate}`;
  } else {
    const it = l.item_id ? get("SELECT id, name, price FROM shop_items WHERE id=? AND tenant_id=?", l.item_id, t) : null;
    if (!it) throw new AppError(400, `${tag}: shop item chunein`);
    itemId = it.id as number; itemName = it.name as string;
    rate ??= Number(it.price) || null;
    if (!rate) throw new AppError(400, `${tag}: ${it.name} ka rate likhein`);
    label = `${round2(l.qty)} × ${it.name} @ ${rate}`;
  }
  return { ...l, at, rate: round2(rate), amount: round2(l.amount ?? l.qty * rate), product, itemId, itemName, label };
}

/** Save many parchiyan for one customer in one go (all or nothing). */
export function saveParchis(req: Parameters<Parameters<typeof h>[0]>[0], customerId: number, lines: z.infer<typeof lineSchema>[], note?: string | null) {
  const t = tid(req);
  staffOnly(req.user!.role);
  const c = own(t, customerId);
  if (!lines.length) throw new AppError(400, "Kam az kam ek parchi likhein");
  const batch = crypto.randomUUID();
  const by = req.user!.name;
  const rateCache: Record<string, Record<string, number>> = {};
  const priced = lines.map((l, i) => priceLine(req, t, l, `Line ${i + 1}`, rateCache));
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

export const bookQuery = z.object({
  customer_id: z.coerce.number().int().optional(), from: day.optional(), to: day.optional(), voided: z.coerce.number().optional(),
  vehicle: z.string().trim().max(30).optional(), slip: z.string().trim().max(40).optional(), kind: z.enum(["fuel", "shop", "other"]).optional(),
  product: z.string().max(12).optional(), status: z.enum(["paid", "part", "unpaid", "open", "void"]).optional(), q: z.string().trim().max(80).optional(),
  min: z.coerce.number().optional(), max: z.coerce.number().optional(), by: z.string().trim().max(60).optional(),
});
export type BookQuery = z.infer<typeof bookQuery>;
const key = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

/** The Parchi Book: every parchi with its status (Paid / part / Unpaid), with every filter (customer, parchi date range,
 *  gaari, slip, fuel / shop, fuel type, status, amount range, entered by, free text). Deleted ones only when asked. */
export function parchiBook(t: number, q: BookQuery) {
  const showVoid = !!q.voided || q.status === "void";
  const rows = all(`SELECT p.*, c.name customer, c.phone customer_phone FROM parchi_lines p JOIN customers c ON c.id=p.customer_id WHERE p.tenant_id=?
      ${q.customer_id ? "AND p.customer_id=?" : ""} ${q.from ? "AND p.parchi_date >= ?" : ""} ${q.to ? "AND p.parchi_date <= ?" : ""} ${showVoid ? "" : "AND p.voided=0"}
      ORDER BY p.parchi_date DESC, p.id DESC LIMIT 5000`, ...[t, ...(q.customer_id ? [q.customer_id] : []), ...(q.from ? [q.from] : []), ...(q.to ? [q.to] : [])]);
  const parts = new Map<number, Map<number, number>>();
  const words = (q.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const list = rows.map((r) => {
    if (r.voided) return { ...r, unpaid: 0, status: "void" };
    if (!parts.has(r.customer_id)) parts.set(r.customer_id, openParts(r.customer_id));
    const left = parts.get(r.customer_id)!.get(r.khata_id) ?? 0;
    return { ...r, unpaid: left, status: left <= 0.5 ? "paid" : left >= r.amount - 0.5 ? "unpaid" : "part" };
  }).filter((r) => (!q.vehicle || key(r.vehicle_no).includes(key(q.vehicle))) && (!q.slip || String(r.slip_no ?? "").toLowerCase().includes(q.slip.toLowerCase()))
    && (!q.kind || r.kind === q.kind) && (!q.product || r.product === q.product) && (q.min == null || r.amount >= q.min) && (q.max == null || r.amount <= q.max)
    && (!q.by || String(r.created_by ?? "").toLowerCase().includes(q.by.toLowerCase()))
    && (!q.status || (q.status === "open" ? r.status === "unpaid" || r.status === "part" : r.status === q.status))
    && (!words.length || words.every((w) => [r.customer, r.customer_phone, r.slip_no, r.vehicle_no, r.item_name, r.product ? PRODUCTS[r.product] : "", r.note, r.created_by, `pr-${r.id}`, `k-${r.khata_id}`, r.amount]
      .filter((v) => v != null).join(" ").toLowerCase().includes(w))));
  const live = list.filter((r) => r.status !== "void");
  const sum = (xs: any[], f: (r: any) => number) => round2(xs.reduce((a, r) => a + f(r), 0));
  const byFuel: Record<string, { product: string; n: number; litres: number; amount: number }> = {};
  for (const r of live.filter((x) => x.kind === "fuel")) { byFuel[r.product] ??= { product: r.product, n: 0, litres: 0, amount: 0 }; byFuel[r.product].n++; byFuel[r.product].litres = round2(byFuel[r.product].litres + r.qty); byFuel[r.product].amount = round2(byFuel[r.product].amount + r.amount); }
  return { rows: list, totals: { n: live.length, amount: sum(live, (r) => r.amount), unpaid: sum(live, (r) => r.unpaid), paid: sum(live, (r) => r.amount - r.unpaid),
    fuel: sum(live.filter((r) => r.kind === "fuel"), (r) => r.amount), shop: sum(live.filter((r) => r.kind === "shop"), (r) => r.amount), other: sum(live.filter((r) => r.kind === "other"), (r) => r.amount),
    litres: sum(live.filter((r) => r.kind === "fuel"), (r) => r.qty), by_fuel: Object.values(byFuel), vehicles: new Set(live.map((r) => key(r.vehicle_no)).filter(Boolean)).size,
    customers: new Set(live.map((r) => r.customer_id)).size, deleted: list.length - live.length } };
}
parchi.get("/parchi/book", requirePerm("khata.manage"), h((req) => parchiBook(tid(req), parse(bookQuery, req.query))));

/** The parchi day of a khata row (Pakistan date). */
const khataDay = (at: string) => new Date(Date.parse(at) + 5 * 3600_000).toISOString().slice(0, 10);

/** Edit one parchi: date, slip, gaari, fuel / item, qty, rate — the khata entry (amount, date, note) and the balance follow.
 *  An old-style parchi (amount only, from "Sirf parchi entry") can be fixed too: kind "other" with the amount as rate. */
parchi.patch("/parchi/:id", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  staffOnly(req.user!.role);
  const b = parse(lineSchema.extend({ kind: z.enum(["fuel", "shop", "other"]), reason: z.string().trim().max(200).optional().nullable(), customer_id: z.number().int().optional().nullable() }), req.body);
  const p = get("SELECT * FROM parchi_lines WHERE id=? AND tenant_id=?", Number(req.params.id), t);
  if (!p) throw new AppError(404, "Parchi not found");
  if (p.voided) throw new AppError(400, "Ye parchi delete ho chuki hai");
  const k = p.khata_id ? get("SELECT * FROM khata_ledger WHERE id=?", p.khata_id) : null;
  if (k) { const d = khataDay(k.created_at); backdateAt(req, t, d === pkDate() ? null : d); } // the old day closed: CEO only
  // a parchi written on the wrong customer moves to the right one (his khata, his balance)
  const to = b.customer_id && b.customer_id !== p.customer_id ? own(t, b.customer_id) : null;
  const from = to ? get("SELECT id, name FROM customers WHERE id=?", p.customer_id)! : null;
  let line;
  if (b.kind === "other") {
    if (!b.rate) throw new AppError(400, "Raqam likhein");
    const at = backdateAt(req, t, b.parchi_date) ?? now();
    const amount = round2(b.qty * b.rate);
    line = { ...b, at, rate: round2(b.rate), amount, product: b.product && PRODUCTS[b.product] ? b.product : null, itemId: null, itemName: p.item_name ?? "Parchi", label: p.item_name ?? "Parchi" };
  } else line = priceLine(req, t, b as z.infer<typeof lineSchema>, "Parchi");
  // keep the khata row's time when the day did not change (its place among same-day rows stays)
  const at = k && khataDay(k.created_at) === b.parchi_date ? k.created_at : line.at;
  const diff = round2(line.amount - (k?.amount ?? p.amount));
  const before = { parchi_date: p.parchi_date, slip_no: p.slip_no, vehicle_no: p.vehicle_no, kind: p.kind, product: p.product, item: p.item_name, qty: p.qty, rate: p.rate, amount: p.amount };
  tx(() => {
    run(`UPDATE parchi_lines SET customer_id=?, parchi_date=?, slip_no=?, vehicle_no=?, kind=?, product=?, item_id=?, item_name=?, qty=?, rate=?, amount=? WHERE id=?`,
      to ? to.id : p.customer_id, b.parchi_date, b.slip_no || null, b.vehicle_no || null, b.kind, line.product, line.itemId, line.itemName, round2(b.qty), line.rate, line.amount, p.id);
    if (k) {
      run("UPDATE khata_ledger SET amount=?, note=?, vehicle_no=?, slip_no=?, created_at=? WHERE id=?", line.amount,
        ["🎫 Parchi", line.label, p.note].filter(Boolean).join(" · "), b.vehicle_no || null, b.slip_no || null, at, k.id);
      if (to) {
        run("UPDATE khata_ledger SET customer_id=? WHERE id=?", to.id, k.id);
        run("UPDATE customers SET balance = balance - ? WHERE id=?", k.amount, p.customer_id);
        run("UPDATE customers SET balance = balance + ? WHERE id=?", line.amount, to.id);
      } else if (diff) run("UPDATE customers SET balance = balance + ? WHERE id=?", diff, p.customer_id);
      if (b.photo_ids?.length) linkPhotos(t, b.photo_ids, `khata:${k.id}`);
    }
    audit(t, req.user!, "parchi:edit", `PR-${p.id}`, { before: { ...before, customer: from?.name }, after: { customer: to?.name, parchi_date: b.parchi_date, slip_no: b.slip_no, vehicle_no: b.vehicle_no, kind: b.kind, product: line.product, item: line.itemName, qty: b.qty, rate: line.rate, amount: line.amount }, reason: b.reason ?? null });
  });
  const c = get("SELECT name, balance FROM customers WHERE id=?", to ? to.id : p.customer_id)!;
  if (to) createAlert(t, { type: "khata_parchi", severity: "info", title: `Parchi customer badla: PR-${p.id} — ${from!.name} → ${to.name}`,
    body: `${req.user!.name} ne PR-${p.id} (${pkr(line.amount)}) ${from!.name} ke khate se hata kar ${to.name} ke khate mein daali. ${to.name} ka naya balance ${pkr(round2(c.balance as number))}.${b.reason ? ` Wajah: ${b.reason}` : ""}` });
  else if (diff) createAlert(t, { type: "khata_parchi", severity: "info", title: `Parchi badli: PR-${p.id} — ${c.name} (${diff > 0 ? "+" : "−"}${pkr(Math.abs(diff))})`,
    body: `${req.user!.name} ne PR-${p.id} badli: ${pkr(p.amount)} → ${pkr(line.amount)}. Naya balance ${pkr(round2(c.balance as number))}.${b.reason ? ` Wajah: ${b.reason}` : ""}` });
  return { ok: true, id: p.id, amount: line.amount, diff, moved: !!to, customer: c.name, balance: round2(c.balance as number) };
}));

/** Cancel one parchi (a mistake): its khata charge is removed and the balance comes down. Kept in the book as void. */
parchi.post("/parchi/:id/void", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  staffOnly(req.user!.role);
  const b = parse(z.object({ reason: z.string().trim().min(3, "Wajah likhein").max(200) }), req.body);
  const p = get("SELECT * FROM parchi_lines WHERE id=? AND tenant_id=?", Number(req.params.id), t);
  if (!p) throw new AppError(404, "Parchi not found");
  if (p.voided) throw new AppError(400, "Ye parchi pehle hi delete ho chuki hai");
  const k = p.khata_id ? get("SELECT * FROM khata_ledger WHERE id=?", p.khata_id) : null;
  if (k) { const d = khataDay(k.created_at); backdateAt(req, t, d === pkDate() ? null : d); } // closed day: CEO only
  tx(() => {
    if (k) { run("DELETE FROM khata_ledger WHERE id=?", k.id); run("UPDATE customers SET balance = balance - ? WHERE id=?", k.amount, p.customer_id); }
    run("UPDATE parchi_lines SET voided=1, void_reason=? WHERE id=?", b.reason, p.id);
    audit(t, req.user!, "parchi:void", `PR-${p.id}`, { amount: p.amount, reason: b.reason });
  });
  return { ok: true, balance: round2(get("SELECT balance FROM customers WHERE id=?", p.customer_id)!.balance as number) };
}));
