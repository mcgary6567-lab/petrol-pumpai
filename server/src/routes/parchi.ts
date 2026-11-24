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
import { AppError, audit, createAlert, currentPrices, khataSpecialRate, pkr, round2 } from "../services.js";
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

/** The rate of every fuel on a day (the price in force at that day's end; today = now). With a customer: his khata rate
 *  card (fixed, or pump − X, the card in force that day) — the same rate his POS khata fills get, never above the board. */
function ratesOn(t: number, d: string, customerId?: number | null) {
  const at = d >= pkDate() ? now() : pkEnd(d);
  return Object.fromEntries(Object.entries(currentPrices(t, at)).map(([p, v]) => [p, customerId ? khataSpecialRate(t, customerId, p, v.price, at) : v.price]));
}

/** What the form needs for one customer: the khata, the vehicles, the shop items and today's rates. */
parchi.get("/parchi/meta", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  const q = parse(z.object({ customer_id: z.coerce.number().int().optional(), date: day.optional() }), req.query);
  const items = all(`SELECT i.id, i.name, i.price, i.unit, s.name station FROM shop_items i JOIN stations s ON s.id=i.station_id WHERE i.tenant_id=? AND i.active=1 ORDER BY i.category, i.name`, t);
  const multi = new Set(items.map((i) => i.station)).size > 1;
  const out: Record<string, unknown> = { items: items.map((i) => ({ id: i.id, name: multi ? `${i.name} · ${i.station}` : i.name, price: i.price, unit: i.unit })), rates: ratesOn(t, q.date ?? pkDate(), q.customer_id), board_rates: ratesOn(t, q.date ?? pkDate()), today: pkDate(),
    // tags used before (newest first), for the batch tag box
    tags: all("SELECT tag, MAX(id) m FROM parchi_lines WHERE tenant_id=? AND tag IS NOT NULL AND TRIM(tag)<>'' GROUP BY tag ORDER BY m DESC LIMIT 30", t).map((r) => r.tag) };
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
parchi.get("/parchi/rates", requirePerm("khata.manage"), h((req) => {
  const q = parse(z.object({ date: day, customer_id: z.coerce.number().int().optional() }), req.query);
  return ratesOn(tid(req), q.date, q.customer_id);
}));

const lineSchema = z.object({
  parchi_date: day, slip_no: z.string().trim().max(40).optional().nullable(), vehicle_no: z.string().trim().max(30).optional().nullable(),
  kind: z.enum(["fuel", "shop"]), product: z.string().max(12).optional().nullable(), item_id: z.number().int().optional().nullable(),
  qty: z.number().positive().max(200_000), rate: z.number().positive().max(10_000_000).optional().nullable(), photo_ids: proofPhotos,
  // the parchi says a money amount ("Rs 5,000"): that exact amount goes on the khata; qty is amount ÷ rate
  amount: z.number().positive().max(100_000_000).optional().nullable(),
});

/** One parchi line priced: the khata date (closed day CEO-only, no future), the rate (fuel = that day's, shop = the item's,
 *  unless typed) and the label written on the khata. */
function priceLine(req: Parameters<typeof backdateAt>[0], t: number, l: z.infer<typeof lineSchema>, tag: string, rateCache: Record<string, Record<string, number>> = {}, customerId?: number) {
  const at = backdateAt(req, t, l.parchi_date) ?? now(); // a future date is refused; a closed day is CEO-only
  let rate = l.rate ?? null, label: string, product: string | null = null, itemId: number | null = null, itemName: string | null = null;
  if (l.kind === "fuel") {
    if (!l.product || !PRODUCTS[l.product]) throw new AppError(400, `${tag}: fuel chunein`);
    product = l.product;
    rate ??= (rateCache[l.parchi_date] ??= ratesOn(t, l.parchi_date, customerId))[l.product] ?? null;
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
export function saveParchis(req: Parameters<Parameters<typeof h>[0]>[0], customerId: number, lines: z.infer<typeof lineSchema>[], note?: string | null, tag?: string | null) {
  const t = tid(req);
  staffOnly(req.user!.role);
  const c = own(t, customerId);
  if (!lines.length) throw new AppError(400, "Kam az kam ek parchi likhein");
  const batch = crypto.randomUUID();
  const by = req.user!.name;
  const rateCache: Record<string, Record<string, number>> = {};
  const priced = lines.map((l, i) => priceLine(req, t, l, `Line ${i + 1}`, rateCache, c.id));
  const total = round2(priced.reduce((a, l) => a + l.amount, 0));
  const ids = tx(() => {
    const out: number[] = [];
    for (const l of priced) {
      const pid = run(`INSERT INTO parchi_lines (tenant_id,customer_id,batch_id,parchi_date,slip_no,vehicle_no,kind,product,item_id,item_name,qty,rate,amount,note,tag,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, t, c.id, batch, l.parchi_date, l.slip_no || null, l.vehicle_no || null, l.kind, l.product, l.itemId, l.itemName,
        round2(l.qty), l.rate, l.amount, note || null, tag?.trim() || null, by, now()).id as number;
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
  const b = parse(z.object({ customer_id: z.number().int(), note: z.string().trim().max(200).optional().nullable(), tag: z.string().trim().max(60).optional().nullable(), lines: z.array(lineSchema).min(1).max(200) }), req.body);
  return saveParchis(req, b.customer_id, b.lines, b.note, b.tag);
}));

/** Each charge's unpaid part. A payment tied to chosen parchiyan (parchi_alloc) pays those first; the rest of it — and every
 *  other payment — clears the oldest charge first (an advance paid ahead clears the next ones). */
function openParts(customerId: number) {
  const rows = all("SELECT id, type, amount FROM khata_ledger WHERE customer_id=? ORDER BY created_at, id", customerId);
  const tied = new Map<number, { khata: number; amount: number }[]>();
  for (const a of all("SELECT a.khata_id pay, p.khata_id target, a.amount FROM parchi_alloc a JOIN parchi_lines p ON p.id=a.parchi_id WHERE a.customer_id=? AND p.voided=0 ORDER BY a.id", customerId))
    tied.set(a.pay as number, [...(tied.get(a.pay as number) ?? []), { khata: a.target as number, amount: a.amount as number }]);
  const open: { id: number; left: number }[] = [];
  const byId = new Map<number, { id: number; left: number }>();
  let advance = 0;
  for (const r of rows) {
    if (r.type === "debit") { const use = Math.min(advance, r.amount); advance -= use; const o = { id: r.id, left: r.amount - use }; open.push(o); byId.set(r.id, o); continue; }
    let pay = r.amount;
    for (const t of tied.get(r.id) ?? []) { const o = byId.get(t.khata); if (!o || pay <= 0) continue; const take = Math.min(o.left, t.amount, pay); o.left -= take; pay -= take; }
    for (const o of open) { if (pay <= 0) break; const take = Math.min(o.left, pay); o.left -= take; pay -= take; }
    advance += pay;
  }
  return new Map(open.map((o) => [o.id, round2(o.left)]));
}

/** Tie a khata payment to chosen parchiyan: its money (what is not tied already) goes to them in the order given, each up
 *  to what it still owes. Nothing about the money changes — the khata balance, cash and books stay as they are; only which
 *  parchi shows Paid. */
export function allocatePayment(t: number, customerId: number, khataId: number, parchiIds: number[], by: string) {
  const k = get("SELECT k.* FROM khata_ledger k JOIN customers c ON c.id=k.customer_id WHERE k.id=? AND k.customer_id=? AND c.tenant_id=?", khataId, customerId, t);
  if (!k || k.type !== "credit") throw new AppError(400, "Ye is customer ki payment nahi");
  let free = round2(k.amount - (get("SELECT COALESCE(SUM(amount),0) v FROM parchi_alloc WHERE khata_id=?", khataId)!.v as number));
  if (free <= 0.5) throw new AppError(400, "Is payment ki poori raqam pehle hi parchiyon par lag chuki hai");
  const parts = openParts(customerId);
  const out: { parchi_id: number; amount: number }[] = [];
  tx(() => {
    for (const pid of parchiIds) {
      if (free <= 0.005) break;
      const p = get("SELECT * FROM parchi_lines WHERE id=? AND customer_id=? AND tenant_id=? AND voided=0", pid, customerId, t);
      if (!p) throw new AppError(400, `PR-${pid} is customer ki parchi nahi`);
      const owed = parts.get(p.khata_id) ?? 0;
      const take = round2(Math.min(owed, free));
      if (take <= 0.005) continue;
      run("INSERT INTO parchi_alloc (tenant_id,customer_id,khata_id,parchi_id,amount,created_by,created_at) VALUES (?,?,?,?,?,?,?)", t, customerId, khataId, pid, take, by, now());
      free = round2(free - take); out.push({ parchi_id: pid, amount: take });
    }
  });
  return { allocated: out, left: free };
}

export const bookQuery = z.object({
  customer_id: z.coerce.number().int().optional(), from: day.optional(), to: day.optional(), voided: z.coerce.number().optional(),
  vehicle: z.string().trim().max(30).optional(), slip: z.string().trim().max(40).optional(), kind: z.enum(["fuel", "shop", "other"]).optional(),
  product: z.string().max(12).optional(), status: z.enum(["paid", "part", "unpaid", "open", "void"]).optional(), q: z.string().trim().max(80).optional(),
  min: z.coerce.number().optional(), max: z.coerce.number().optional(), by: z.string().trim().max(60).optional(),
  tag: z.string().trim().max(60).optional(), older: z.coerce.number().int().min(0).max(3650).optional(), // older = unpaid for more than N days
});
/** days from a parchi date to today (Pakistan) */
const ageDays = (d: string) => Math.max(0, Math.round((Date.parse(pkDate()) - Date.parse(d)) / 86_400_000));
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
  // the payments tied to each parchi (K-ids), shown next to its status
  const tiedTo = new Map<number, string>();
  for (const a of all(`SELECT parchi_id, GROUP_CONCAT('K-'||khata_id, ', ') ks FROM parchi_alloc WHERE tenant_id=? ${q.customer_id ? "AND customer_id=?" : ""} GROUP BY parchi_id`, ...[t, ...(q.customer_id ? [q.customer_id] : [])]))
    tiedTo.set(a.parchi_id as number, a.ks as string);
  const words = (q.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const list = rows.map((r) => {
    if (r.voided) return { ...r, unpaid: 0, status: "void", age: null };
    if (!parts.has(r.customer_id)) parts.set(r.customer_id, openParts(r.customer_id));
    const left = parts.get(r.customer_id)!.get(r.khata_id) ?? 0;
    const status = left <= 0.5 ? "paid" : left >= r.amount - 0.5 ? "unpaid" : "part";
    return { ...r, unpaid: left, status, age: status === "paid" ? null : ageDays(r.parchi_date), paid_by: tiedTo.get(r.id) ?? null };
  }).filter((r) => (!q.tag || String(r.tag ?? "").toLowerCase() === q.tag.toLowerCase()) && (q.older == null || (r.age != null && r.age > q.older)) && (!q.vehicle || key(r.vehicle_no).includes(key(q.vehicle))) && (!q.slip || String(r.slip_no ?? "").toLowerCase().includes(q.slip.toLowerCase()))
    && (!q.kind || r.kind === q.kind) && (!q.product || r.product === q.product) && (q.min == null || r.amount >= q.min) && (q.max == null || r.amount <= q.max)
    && (!q.by || String(r.created_by ?? "").toLowerCase().includes(q.by.toLowerCase()))
    && (!q.status || (q.status === "open" ? r.status === "unpaid" || r.status === "part" : r.status === q.status))
    && (!words.length || words.every((w) => [r.customer, r.customer_phone, r.slip_no, r.vehicle_no, r.item_name, r.product ? PRODUCTS[r.product] : "", r.note, r.tag, r.created_by, `pr-${r.id}`, `k-${r.khata_id}`, r.amount]
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

/** This customer's payments, newest first, with how much of each is already tied to parchiyan (for "purani payment se jorein"). */
parchi.get("/parchi/payments", requirePerm("khata.manage"), h((req) => {
  const q = parse(z.object({ customer_id: z.coerce.number().int() }), req.query);
  own(tid(req), q.customer_id);
  return all(`SELECT k.id, k.amount, k.ref method, k.note, k.created_at, COALESCE((SELECT SUM(a.amount) FROM parchi_alloc a WHERE a.khata_id=k.id),0) tied
    FROM khata_ledger k WHERE k.customer_id=? AND k.type='credit' AND COALESCE(k.ref,'') NOT LIKE 'xfer:%' ORDER BY k.created_at DESC, k.id DESC LIMIT 60`, q.customer_id)
    .map((r) => ({ ...r, tied: round2(r.tied as number), free: round2((r.amount as number) - (r.tied as number)) }));
}));
parchi.post("/parchi/allocate", requirePerm("khata.manage"), h((req) => {
  staffOnly(req.user!.role);
  const b = parse(z.object({ customer_id: z.number().int(), khata_id: z.number().int(), parchi_ids: z.array(z.number().int()).min(1).max(500) }), req.body);
  const r = allocatePayment(tid(req), b.customer_id, b.khata_id, b.parchi_ids, req.user!.name);
  audit(tid(req), req.user!, "parchi:allocate", `K-${b.khata_id}`, { customer_id: b.customer_id, ...r });
  return r;
}));
/** Untie a payment from its parchiyan (they go back to oldest-first). */
parchi.post("/parchi/allocate/:khataId/clear", requirePerm("khata.manage"), h((req) => {
  staffOnly(req.user!.role);
  const t = tid(req), id = Number(req.params.khataId);
  const n = run("DELETE FROM parchi_alloc WHERE khata_id=? AND tenant_id=?", id, t).changes;
  audit(t, req.user!, "parchi:unallocate", `K-${id}`, { rows: n });
  return { ok: true, removed: n };
}));

/* ---------------- 29: one parchi's history ---------------- */
parchi.get("/parchi/:id/history", requirePerm("khata.manage"), h((req) => {
  const t = tid(req), id = Number(req.params.id);
  const p = get("SELECT p.*, c.name customer FROM parchi_lines p JOIN customers c ON c.id=p.customer_id WHERE p.id=? AND p.tenant_id=?", id, t);
  if (!p) throw new AppError(404, "Parchi not found");
  const ev: { at: string; by: string | null; what: string; data?: unknown }[] = [];
  ev.push({ at: p.created_at, by: p.created_by, what: "Banai gayi", data: { customer: p.customer, batch: p.batch_id } });
  for (const a of all("SELECT action, user_name, data, created_at FROM audit_log WHERE tenant_id=? AND ref=? ORDER BY id", t, `PR-${id}`)) {
    let d: any = null; try { d = JSON.parse(a.data as string); } catch { /* text */ }
    const what = a.action === "parchi:edit" ? "Badli gayi" : a.action === "parchi:void" ? "Delete ki gayi" : a.action === "parchi:bulk" ? "Ek saath badli" : a.action === "parchi:reprice" ? "Naya rate laga" : a.action;
    ev.push({ at: a.created_at as string, by: a.user_name as string, what, data: d });
  }
  for (const a of all("SELECT a.khata_id, a.amount, a.created_by, a.created_at, k.ref method FROM parchi_alloc a LEFT JOIN khata_ledger k ON k.id=a.khata_id WHERE a.parchi_id=? AND a.tenant_id=? ORDER BY a.id", id, t))
    ev.push({ at: a.created_at as string, by: a.created_by as string, what: `Payment K-${a.khata_id} se jori`, data: { amount: a.amount, method: a.method } });
  ev.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  return { parchi: p, events: ev };
}));

/* ---------------- 28: change many at once (date / tag / gaari); delete many is /parchi/bulk/void (PIN like any cancel) ---------------- */
parchi.post("/parchi/bulk", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  staffOnly(req.user!.role);
  const b = parse(z.object({ ids: z.array(z.number().int()).min(1).max(500), field: z.enum(["date", "tag", "vehicle"]), value: z.string().trim().max(60).nullable() }), req.body);
  if (b.field === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(b.value ?? "")) throw new AppError(400, "Tareekh chunein");
  const rows = b.ids.map((id) => { const p = get("SELECT * FROM parchi_lines WHERE id=? AND tenant_id=? AND voided=0", id, t); if (!p) throw new AppError(400, `PR-${id} nahi mili`); return p; });
  const at = b.field === "date" ? (backdateAt(req, t, b.value) ?? now()) : null; // the new day: closed day CEO-only, no future
  tx(() => {
    for (const p of rows) {
      if (b.field === "date") {
        const k = p.khata_id ? get("SELECT created_at FROM khata_ledger WHERE id=?", p.khata_id) : null;
        if (k) { const d = khataDay(k.created_at); backdateAt(req, t, d === pkDate() ? null : d); } // its old day closed: CEO only
        run("UPDATE parchi_lines SET parchi_date=? WHERE id=?", b.value, p.id);
        if (p.khata_id) run("UPDATE khata_ledger SET created_at=? WHERE id=?", at, p.khata_id);
      } else if (b.field === "tag") run("UPDATE parchi_lines SET tag=? WHERE id=?", b.value || null, p.id);
      else { run("UPDATE parchi_lines SET vehicle_no=? WHERE id=?", b.value?.toUpperCase() || null, p.id); if (p.khata_id) run("UPDATE khata_ledger SET vehicle_no=? WHERE id=?", b.value?.toUpperCase() || null, p.khata_id); }
      audit(t, req.user!, "parchi:bulk", `PR-${p.id}`, { field: b.field, before: b.field === "date" ? p.parchi_date : b.field === "tag" ? p.tag : p.vehicle_no, after: b.value });
    }
  });
  return { ok: true, changed: rows.length };
}));
parchi.post("/parchi/bulk/void", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  staffOnly(req.user!.role);
  const b = parse(z.object({ ids: z.array(z.number().int()).min(1).max(500), reason: z.string().trim().min(3, "Wajah likhein").max(200) }), req.body);
  let total = 0;
  tx(() => {
    for (const id of b.ids) {
      const p = get("SELECT * FROM parchi_lines WHERE id=? AND tenant_id=? AND voided=0", id, t);
      if (!p) continue;
      const k = p.khata_id ? get("SELECT * FROM khata_ledger WHERE id=?", p.khata_id) : null;
      if (k) { const d = khataDay(k.created_at); backdateAt(req, t, d === pkDate() ? null : d); run("DELETE FROM khata_ledger WHERE id=?", k.id); run("UPDATE customers SET balance = balance - ? WHERE id=?", k.amount, p.customer_id); total += k.amount as number; }
      run("UPDATE parchi_lines SET voided=1, void_reason=? WHERE id=?", b.reason, p.id);
      run("DELETE FROM parchi_alloc WHERE parchi_id=?", p.id);
      audit(t, req.user!, "parchi:void", `PR-${p.id}`, { amount: p.amount, reason: b.reason, bulk: true });
    }
  });
  if (total > 0.5) createAlert(t, { type: "khata_parchi", severity: "info", title: `${b.ids.length} parchi delete — ${pkr(total)}`, body: `${req.user!.name} ne ${b.ids.length} parchi ek saath delete kin (${pkr(total)}). Wajah: ${b.reason}` });
  return { ok: true, deleted: b.ids.length, amount: round2(total) };
}));

/* ---------------- 33: the customer's rate card changed — which fuel parchiyan would bill differently now ---------------- */
function newRateFor(t: number, p: any) {
  const at = p.parchi_date >= pkDate() ? now() : pkEnd(p.parchi_date);
  const board = currentPrices(t, at)[p.product]?.price;
  if (!board) return null;
  const r = get("SELECT khata_rates FROM customers WHERE id=?", p.customer_id)?.khata_rates;
  let card: { mode: string; value: number } | null = null; try { card = r ? JSON.parse(r)[p.product] ?? null : null; } catch { /* none */ }
  const special = card ? (card.mode === "minus" ? board - card.value : card.value) : board;
  return round2(special > 0 ? Math.min(board, special) : board); // today's card on that day's board rate, never above the board
}
parchi.get("/parchi/rate-review", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  const q = parse(z.object({ customer_id: z.coerce.number().int(), from: day.optional(), to: day.optional() }), req.query);
  own(t, q.customer_id);
  const rows = all(`SELECT * FROM parchi_lines WHERE tenant_id=? AND customer_id=? AND kind='fuel' AND voided=0 ${q.from ? "AND parchi_date >= ?" : ""} ${q.to ? "AND parchi_date <= ?" : ""} ORDER BY parchi_date, id`,
    ...[t, q.customer_id, ...(q.from ? [q.from] : []), ...(q.to ? [q.to] : [])]);
  const out = rows.map((p) => { const nr = newRateFor(t, p); return nr == null ? null : { id: p.id, parchi_date: p.parchi_date, slip_no: p.slip_no, vehicle_no: p.vehicle_no, product: p.product, qty: p.qty, rate: p.rate, amount: p.amount, new_rate: nr, new_amount: round2(p.qty * nr), diff: round2(p.qty * nr - p.amount) }; })
    .filter((x): x is NonNullable<typeof x> => !!x && Math.abs(x.rate - x.new_rate) >= 0.005);
  return { rows: out, diff: round2(out.reduce((a, x) => a + x.diff, 0)) };
}));
parchi.post("/parchi/reprice", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  staffOnly(req.user!.role);
  const b = parse(z.object({ ids: z.array(z.number().int()).min(1).max(1000), reason: z.string().trim().max(200).optional().nullable() }), req.body);
  let diff = 0, n = 0, customerId = 0;
  tx(() => {
    for (const id of b.ids) {
      const p = get("SELECT * FROM parchi_lines WHERE id=? AND tenant_id=? AND voided=0 AND kind='fuel'", id, t);
      if (!p) continue;
      const nr = newRateFor(t, p); if (nr == null || Math.abs(nr - p.rate) < 0.005) continue;
      const k = p.khata_id ? get("SELECT * FROM khata_ledger WHERE id=?", p.khata_id) : null;
      if (k) { const d = khataDay(k.created_at); backdateAt(req, t, d === pkDate() ? null : d); }
      const amount = round2(p.qty * nr), dd = round2(amount - p.amount);
      run("UPDATE parchi_lines SET rate=?, amount=? WHERE id=?", nr, amount, p.id);
      if (k) { run("UPDATE khata_ledger SET amount=?, note=? WHERE id=?", amount, ["🎫 Parchi", `${round2(p.qty)} L ${PRODUCTS[p.product] ?? p.product} × ${nr}`, p.note].filter(Boolean).join(" · "), k.id); run("UPDATE customers SET balance = balance + ? WHERE id=?", dd, p.customer_id); }
      audit(t, req.user!, "parchi:reprice", `PR-${p.id}`, { before: { rate: p.rate, amount: p.amount }, after: { rate: nr, amount }, reason: b.reason ?? null });
      diff += dd; n++; customerId = p.customer_id;
    }
  });
  if (n && Math.abs(diff) > 0.5) { const c = get("SELECT name FROM customers WHERE id=?", customerId)!; createAlert(t, { type: "khata_parchi", severity: "info", title: `Parchi rate badla: ${c.name} — ${n} parchi (${diff > 0 ? "+" : "−"}${pkr(Math.abs(diff))})`, body: `${req.user!.name} ne ${n} parchiyon par customer ka naya rate lagaya.${b.reason ? ` Wajah: ${b.reason}` : ""}` }); }
  return { ok: true, changed: n, diff: round2(diff) };
}));

/* ---------------- 31: templates ---------------- */
parchi.get("/parchi/templates", requirePerm("khata.manage"), h((req) => {
  const q = parse(z.object({ customer_id: z.coerce.number().int() }), req.query);
  return all("SELECT id, name, lines, created_by, created_at FROM parchi_templates WHERE tenant_id=? AND customer_id=? ORDER BY name", tid(req), q.customer_id).map((r) => ({ ...r, lines: JSON.parse(r.lines as string) }));
}));
parchi.post("/parchi/templates", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  staffOnly(req.user!.role);
  const b = parse(z.object({ customer_id: z.number().int(), name: z.string().trim().min(2).max(60),
    lines: z.array(z.object({ vehicle_no: z.string().trim().max(30).nullable().optional(), kind: z.enum(["fuel", "shop"]), product: z.string().max(12).nullable().optional(), item_id: z.number().int().nullable().optional(), qty: z.number().min(0).max(200_000).nullable().optional() })).min(1).max(100) }), req.body);
  own(t, b.customer_id);
  const ex = get("SELECT id FROM parchi_templates WHERE tenant_id=? AND customer_id=? AND LOWER(name)=LOWER(?)", t, b.customer_id, b.name);
  if (ex) run("UPDATE parchi_templates SET lines=?, created_by=?, created_at=? WHERE id=?", JSON.stringify(b.lines), req.user!.name, now(), ex.id);
  else run("INSERT INTO parchi_templates (tenant_id,customer_id,name,lines,created_by,created_at) VALUES (?,?,?,?,?,?)", t, b.customer_id, b.name, JSON.stringify(b.lines), req.user!.name, now());
  return { ok: true };
}));
parchi.delete("/parchi/templates/:id", requirePerm("khata.manage"), h((req) => {
  staffOnly(req.user!.role);
  run("DELETE FROM parchi_templates WHERE id=? AND tenant_id=?", Number(req.params.id), tid(req));
  return { ok: true };
}));

/* ---------------- 32: the same photo twice ---------------- */
const shaOf = (id: number): string | null => {
  const r = get("SELECT sha, data FROM photos WHERE id=?", id);
  if (!r) return null;
  if (r.sha) return r.sha as string;
  const sha = crypto.createHash("sha256").update(r.data as Buffer).digest("hex");
  run("UPDATE photos SET sha=? WHERE id=?", sha, id);
  return sha;
};
parchi.post("/parchi/photo-check", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  const b = parse(z.object({ photo_ids: z.array(z.number().int()).min(1).max(200) }), req.body);
  // hashes of the photos already on parchiyan (filled once, then kept)
  const onParchi = all(`SELECT ph.id, ph.sha, p.id pid, p.parchi_date, c.name customer FROM photos ph JOIN khata_ledger k ON ph.ref='khata:'||k.id JOIN parchi_lines p ON p.khata_id=k.id
      JOIN customers c ON c.id=p.customer_id WHERE ph.tenant_id=? AND p.voided=0`, t);
  const known = new Map<string, { pid: number; date: string; customer: string }>();
  for (const x of onParchi) { const s = (x.sha as string) ?? shaOf(x.id as number); if (s && !known.has(s)) known.set(s, { pid: x.pid as number, date: x.parchi_date as string, customer: x.customer as string }); }
  const seen = new Map<string, number>(), out: { photo_id: number; dup: string }[] = [];
  for (const id of b.photo_ids) {
    if (!get("SELECT 1 x FROM photos WHERE id=? AND tenant_id=?", id, t)) continue;
    const s = shaOf(id); if (!s) continue;
    const k = known.get(s);
    if (k) out.push({ photo_id: id, dup: `Yeh photo pehle PR-${k.pid} (${k.customer}, ${k.date}) par lagi hai` });
    else if (seen.has(s)) out.push({ photo_id: id, dup: "Yehi photo is list mein do dafa hai" });
    seen.set(s, id);
  }
  return out;
}));

/* ---------------- 17: litres already on a gaari that day (khata fuel + parchi fuel) ---------------- */
parchi.get("/parchi/vehicle-day", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  const q = parse(z.object({ customer_id: z.coerce.number().int(), dates: z.string().max(4000) }), req.query);
  own(t, q.customer_id);
  const dates = q.dates.split(",").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 60);
  const out: Record<string, number> = {}; // "PLATE|date" → litres
  const key = (v: string) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const d of dates) {
    for (const r of all("SELECT vehicle_no, COALESCE(SUM(litres),0) l FROM khata_ledger WHERE customer_id=? AND type='debit' AND litres > 0 AND vehicle_no IS NOT NULL AND created_at >= ? AND created_at < ? GROUP BY vehicle_no", q.customer_id, pkStart(d), pkEnd(d)))
      out[`${key(r.vehicle_no as string)}|${d}`] = round2((out[`${key(r.vehicle_no as string)}|${d}`] ?? 0) + (r.l as number));
    for (const r of all("SELECT vehicle_no, COALESCE(SUM(qty),0) l FROM parchi_lines WHERE customer_id=? AND kind='fuel' AND voided=0 AND parchi_date=? AND vehicle_no IS NOT NULL GROUP BY vehicle_no", q.customer_id, d))
      out[`${key(r.vehicle_no as string)}|${d}`] = round2((out[`${key(r.vehicle_no as string)}|${d}`] ?? 0) + (r.l as number));
  }
  return out;
}));

/** Parchi aging: unpaid parchi money by how old the parchi is (0-30 / 31-60 / 61-90 / 90+ days), per customer, oldest first. */
export function parchiAging(t: number, customerId?: number) {
  const rows = parchiBook(t, { customer_id: customerId, status: "open" }).rows.filter((r: any) => r.unpaid > 0.5);
  const B = () => ({ d0_30: 0, d31_60: 0, d61_90: 0, d90: 0 });
  const put = (b: ReturnType<typeof B>, age: number, v: number) => { const k = age <= 30 ? "d0_30" : age <= 60 ? "d31_60" : age <= 90 ? "d61_90" : "d90"; b[k] = round2(b[k] + v); };
  const total = B(); const per = new Map<number, any>();
  for (const r of rows) {
    put(total, r.age, r.unpaid);
    const c = per.get(r.customer_id) ?? { id: r.customer_id, name: r.customer, phone: r.customer_phone, unpaid: 0, n: 0, oldest_date: r.parchi_date, oldest_days: 0, buckets: B() };
    c.unpaid = round2(c.unpaid + r.unpaid); c.n++; put(c.buckets, r.age, r.unpaid);
    if (r.age >= c.oldest_days) { c.oldest_days = r.age; c.oldest_date = r.parchi_date; }
    per.set(r.customer_id, c);
  }
  const customers = [...per.values()].sort((a, b) => b.oldest_days - a.oldest_days || b.unpaid - a.unpaid);
  return { buckets: total, unpaid: round2(rows.reduce((a: number, r: any) => a + r.unpaid, 0)), n: rows.length, customers };
}
parchi.get("/parchi/aging", requirePerm("khata.manage"), h((req) => parchiAging(tid(req), parse(z.object({ customer_id: z.coerce.number().int().optional() }), req.query).customer_id)));

/** Dashboard card: parchiyan today / this month, unpaid parchi money, 90+ days, and the 5 customers owing most on parchi. */
parchi.get("/parchi/summary", requirePerm("khata.manage"), h((req) => {
  const t = tid(req), today = pkDate(), month = `${today.slice(0, 7)}-01`;
  const sum = (from: string) => get("SELECT COUNT(*) n, COALESCE(SUM(amount),0) a FROM parchi_lines WHERE tenant_id=? AND voided=0 AND parchi_date >= ? AND parchi_date <= ?", t, from, today)!;
  const d = sum(today), m = sum(month);
  const ag = parchiAging(t);
  return { today: { n: d.n, amount: round2(d.a as number) }, month: { n: m.n, amount: round2(m.a as number) }, unpaid: ag.unpaid, unpaid_n: ag.n, over90: ag.buckets.d90, buckets: ag.buckets,
    top: [...ag.customers].sort((a, b) => b.unpaid - a.unpaid).slice(0, 5).map((c) => ({ id: c.id, name: c.name, unpaid: c.unpaid, n: c.n, oldest_days: c.oldest_days })) };
}));

/** The parchi day of a khata row (Pakistan date). */
const khataDay = (at: string) => new Date(Date.parse(at) + 5 * 3600_000).toISOString().slice(0, 10);

/** Edit one parchi: date, slip, gaari, fuel / item, qty, rate — the khata entry (amount, date, note) and the balance follow.
 *  An old-style parchi (amount only, from "Sirf parchi entry") can be fixed too: kind "other" with the amount as rate. */
parchi.patch("/parchi/:id", requirePerm("khata.manage"), h((req) => {
  const t = tid(req);
  staffOnly(req.user!.role);
  const b = parse(lineSchema.extend({ kind: z.enum(["fuel", "shop", "other"]), reason: z.string().trim().max(200).optional().nullable(), customer_id: z.number().int().optional().nullable(), tag: z.string().trim().max(60).optional().nullable() }), req.body);
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
  } else line = priceLine(req, t, b as z.infer<typeof lineSchema>, "Parchi", {}, to ? to.id : p.customer_id);
  // keep the khata row's time when the day did not change (its place among same-day rows stays)
  const at = k && khataDay(k.created_at) === b.parchi_date ? k.created_at : line.at;
  const diff = round2(line.amount - (k?.amount ?? p.amount));
  const before = { parchi_date: p.parchi_date, slip_no: p.slip_no, vehicle_no: p.vehicle_no, kind: p.kind, product: p.product, item: p.item_name, qty: p.qty, rate: p.rate, amount: p.amount };
  tx(() => {
    if (b.tag !== undefined) run("UPDATE parchi_lines SET tag=? WHERE id=?", b.tag?.trim() || null, p.id);
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
