/**
 * Wholesale ERP views on top of the ledger (read-only — nothing here moves money or stock):
 * supply invoices (each voucher / supply as one bill with paid / unpaid status), the order-to-cash board and the
 * client 360 page (smart counts + one activity timeline). Unpaid is the same FIFO match the ledger and ageing use.
 */
import { Router } from "express";
import { z } from "zod";
import { all, get, pkDate, pkStart, pkEnd, type Row } from "../db.js";
import { h, parse, tid, requirePerm } from "../auth.js";
import { wholesaleBillMessage } from "../billing.js";
import { AppError, round2 } from "../services.js";
import { PRODUCTS } from "../config.js";
import { clientDue, clientDueAll, unpaidBills } from "./wholesale.js";
import { clientRequests, openOrders } from "./wholesaleDesk.js";

export const wholesaleErp = Router();
wholesaleErp.use("/wholesale", requirePerm("wholesale.view"));

const DAY = 86_400_000;
/** YYYY-MM-DD that is a real calendar day (2026-13-45 matches the shape but is not a date → 400, never a 500 from SQLite). */
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => !Number.isNaN(Date.parse(v + "T00:00:00Z")) && new Date(v + "T00:00:00Z").toISOString().slice(0, 10) === v, "Invalid date");
const OVERDUE_DAYS = 30;
/** Invoice number of a supply / kiraya line: its voucher's number, else WS-<id> (supply) or JV-<id> (stand-alone kiraya). */
const KEY = "COALESCE(x.voucher_no, CASE x.type WHEN 'supply' THEN 'WS-' ELSE 'JV-' END || x.id)";

/** txn id → what is still unpaid on it, for every client of the tenant (or one client). */
function unpaidMap(t: number, clientId?: number) {
  const m = new Map<number, number>();
  const dues = clientId ? new Map([[clientId, clientDue(clientId)]]) : clientDueAll(t);
  for (const [cid, due] of dues) if (due > 0.01) for (const b of unpaidBills(cid, due).bills) m.set(b.id, b.unpaid);
  return m;
}

type Inv = { no: string; client_id: number; client_name: string; city: string | null; txn_date: string; created_by: string | null; ref: string | null; vehicle_no: string | null;
  lines: Row[]; litres: number; amount: number; unpaid: number; days: number; status: "paid" | "partly" | "unpaid" | "overdue" | "void"; products: string[] };
function group(rows: Row[], unpaid: Map<number, number>, nowMs: number): Inv[] {
  const g = new Map<string, Inv>();
  for (const r of rows) {
    let inv = g.get(r.inv_no);
    if (!inv) {
      inv = { no: r.inv_no, client_id: r.client_id, client_name: r.client_name, city: r.city, txn_date: r.txn_date, created_by: r.created_by, ref: r.ref, vehicle_no: r.vehicle_no,
        lines: [], litres: 0, amount: 0, unpaid: 0, days: Math.floor((nowMs - Date.parse(r.txn_date)) / DAY), status: "paid", products: [] };
      g.set(r.inv_no, inv);
    }
    inv.lines.push(r);
    if (r.voided) continue;
    inv.amount = round2(inv.amount + r.amount);
    if (r.type === "supply") { inv.litres = round2(inv.litres + (r.litres ?? 0)); if (r.product && !inv.products.includes(r.product)) inv.products.push(r.product); }
    inv.unpaid = round2(inv.unpaid + (unpaid.get(r.id) ?? 0));
  }
  for (const inv of g.values()) {
    inv.lines.sort((a, b) => a.id - b.id); // fuel lines first, then the kiraya — in the order they were posted
    if (inv.lines.every((l) => l.voided)) inv.status = "void";
    else if (inv.unpaid < 0.5) inv.status = "paid";
    else if (inv.days > OVERDUE_DAYS) inv.status = "overdue";
    else inv.status = inv.unpaid < inv.amount - 0.5 ? "partly" : "unpaid";
  }
  return [...g.values()].sort((a, b) => (a.txn_date < b.txn_date ? 1 : a.txn_date > b.txn_date ? -1 : b.no.localeCompare(a.no)));
}
const invRows = (t: number, where: string, args: (string | number)[]) => all(
  `SELECT x.*, ${KEY} inv_no, c.name client_name, c.city, st.name station_name, tk.name tank_name
   FROM wholesale_txns x JOIN wholesale_clients c ON c.id=x.client_id LEFT JOIN stations st ON st.id=x.station_id LEFT JOIN tanks tk ON tk.id=x.tank_id
   WHERE x.tenant_id=? AND x.type IN ('supply','carriage') ${where} ORDER BY x.txn_date DESC, x.id`, t, ...args);

/* ---------------- Supply invoices ---------------- */
const listQ = z.object({
  status: z.enum(["all", "unpaid", "partly", "overdue", "paid", "void", "open"]).default("all"),
  q: z.string().trim().max(80).optional(), client: z.coerce.number().int().optional(),
  from: z.preprocess((v) => (v === "" ? undefined : v), isoDay.optional()), to: z.preprocess((v) => (v === "" ? undefined : v), isoDay.optional()),
});
wholesaleErp.get("/wholesale/invoices", h((req) => {
  const t = tid(req), q = parse(listQ, req.query);
  const from = q.from ?? new Date(Date.now() - 89 * DAY + 5 * 3600_000).toISOString().slice(0, 10);
  const where = [`AND x.txn_date >= ?`, ...(q.to ? ["AND x.txn_date < ?"] : []), ...(q.client ? ["AND x.client_id=?"] : [])].join(" ");
  const rows = invRows(t, where, [pkStart(from), ...(q.to ? [pkEnd(q.to)] : []), ...(q.client ? [q.client] : [])]);
  let list = group(rows, unpaidMap(t, q.client), Date.now());
  const counts = { all: list.length, unpaid: 0, partly: 0, overdue: 0, paid: 0, void: 0, open: 0 };
  for (const i of list) { counts[i.status]++; if (i.unpaid > 0.5) counts.open++; }
  const live = list.filter((i) => i.status !== "void");
  const billed = round2(live.reduce((a, i) => a + i.amount, 0)), open = round2(live.reduce((a, i) => a + i.unpaid, 0));
  const totals = { billed, unpaid: open, collected: round2(billed - open), litres: round2(live.reduce((a, i) => a + i.litres, 0)),
    overdue: round2(live.filter((i) => i.status === "overdue").reduce((a, i) => a + i.unpaid, 0)) };
  if (q.status === "open") list = list.filter((i) => i.unpaid > 0.5);
  else if (q.status !== "all") list = list.filter((i) => i.status === q.status);
  if (q.q) { const s = q.q.toLowerCase().replace(/^#/, ""); list = list.filter((i) => [i.no, i.client_name, i.ref, i.vehicle_no, i.city, i.status, i.amount, i.unpaid, i.created_by].some((v) => String(v ?? "").toLowerCase().includes(s))); }
  return { from, to: q.to ?? null, counts, totals, invoices: list.slice(0, 500).map(({ lines, ...i }) => ({ ...i, lines: lines.length })) };
}));

wholesaleErp.get("/wholesale/invoices/:no", h((req) => {
  const t = tid(req), no = String(req.params.no).toUpperCase();
  const m = /^(WS|JV)-(\d+)$/.exec(no);
  if (!m) throw new AppError(400, "Invoice number like WS-123");
  const id = Number(m[2]);
  const rows = invRows(t, `AND (x.voucher_no=? OR (x.voucher_no IS NULL AND x.id=?))`, [no, id]).filter((r) => r.inv_no === no);
  if (!rows.length) throw new AppError(404, "Invoice nahi mila");
  const inv = group(rows, unpaidMap(t, rows[0].client_id), Date.now())[0];
  const c = get("SELECT id, name, business_name, phone, city, address, credit_limit FROM wholesale_clients WHERE id=?", inv.client_id)!;
  const live = inv.lines.filter((l) => !l.voided);
  const posting = live.length ? [
    { account: `Receivable — ${c.name}`, dr: inv.amount, cr: 0 },
    ...Object.entries(live.filter((l) => l.type === "supply").reduce((a: Record<string, number>, l) => ({ ...a, [l.product]: round2((a[l.product] ?? 0) + l.amount) }), {}))
      .map(([p, v]) => ({ account: `Wholesale sales — ${PRODUCTS[p] ?? p}`, dr: 0, cr: v })),
    ...(live.some((l) => l.type === "carriage") ? [{ account: "Carriage income (kiraya)", dr: 0, cr: round2(live.filter((l) => l.type === "carriage").reduce((a, l) => a + l.amount, 0)) }] : []),
  ] : [];
  const activity = [
    { at: rows[0].created_at, who: rows[0].created_by, text: `Posted · ${inv.lines.length} line${inv.lines.length > 1 ? "s" : ""}` },
    ...rows.filter((l) => l.voided).map((l) => ({ at: null, who: null, text: `Line ${l.id} voided — ${l.void_reason ?? ""}` })),
    ...(inv.status === "paid" ? [{ at: null, who: null, text: "Fully paid (older bills are cleared first)" }] : inv.unpaid > 0.5 && inv.unpaid < inv.amount - 0.5 ? [{ at: null, who: null, text: `Partly paid — ${round2(inv.amount - inv.unpaid)} received against it` }] : []),
  ];
  return { ...inv, lines: inv.lines, client: { ...c, due: clientDue(c.id) }, posting, activity };
}));

/** Send the whole bill (all its lines) as one WhatsApp message. */
wholesaleErp.post("/wholesale/invoices/:no/whatsapp", requirePerm("wholesale.manage"), h(async (req) => {
  const t = tid(req), no = String(req.params.no).toUpperCase();
  const m = /^(WS|JV)-(\d+)$/.exec(no);
  if (!m) throw new AppError(400, "Invoice number like WS-123");
  const rows = all(`SELECT x.* FROM wholesale_txns x WHERE x.tenant_id=? AND x.type IN ('supply','carriage') AND (x.voucher_no=? OR (x.voucher_no IS NULL AND x.id=?)) ORDER BY x.id`, t, no, Number(m[2]));
  if (!rows.length) throw new AppError(404, "Bill nahi mila");
  const c = get("SELECT phone FROM wholesale_clients WHERE id=?", rows[0].client_id);
  if (!c?.phone) throw new AppError(400, "Is client ka WhatsApp number nahi — pehle number add karein");
  const sent = await wholesaleBillMessage(t, rows[0].client_id, no, rows);
  if (!sent) throw new AppError(400, "Wholesale WhatsApp messages band hain (Settings → WhatsApp) ya bill void hai");
  return { ok: true };
}));

/* ---------------- Order to cash board ---------------- */
wholesaleErp.get("/wholesale/pipeline", h((req) => {
  const t = tid(req), today = pkDate(), nowMs = Date.now();
  const requests = clientRequests(t).filter((r) => r.status === "pending");
  const orders = openOrders(t).map((o) => ({ ...o, state: o.needed_on < today ? "late" : o.needed_on === today ? "today" : "upcoming" }));
  const unpaid = unpaidMap(t);
  const ids = [...unpaid.keys()];
  const open = ids.length ? group(invRows(t, `AND x.id IN (${ids.map(() => "?").join(",")})`, ids), unpaid, nowMs).filter((i) => i.unpaid > 0.5) : [];
  const paid = all(`SELECT x.id, x.client_id, x.amount, x.method, x.ref, x.txn_date, x.created_by, c.name client_name FROM wholesale_txns x JOIN wholesale_clients c ON c.id=x.client_id
    WHERE x.tenant_id=? AND x.type='payment' AND x.voided=0 AND x.txn_date >= ? ORDER BY x.txn_date DESC, x.id DESC`, t, new Date(nowMs - 7 * DAY).toISOString());
  const strip = (i: Inv) => { const { lines, ...r } = i; return { ...r, lines: lines.length }; };
  const col = (key: string, items: any[], litres: number | null, amount: number | null) => ({ key, count: items.length, litres: litres == null ? null : round2(litres), amount: amount == null ? null : round2(amount), items });
  const dueNow = open.filter((i) => i.status !== "overdue"), overdue = open.filter((i) => i.status === "overdue");
  return {
    columns: [
      col("requests", requests, requests.reduce((a, r) => a + r.litres, 0), null),
      col("orders", orders, orders.reduce((a, o) => a + o.litres, 0), null),
      col("unpaid", dueNow.map(strip), null, dueNow.reduce((a, i) => a + i.unpaid, 0)),
      col("overdue", overdue.sort((a, b) => b.days - a.days).map(strip), null, overdue.reduce((a, i) => a + i.unpaid, 0)),
      col("paid", paid, null, paid.reduce((a, p) => a + p.amount, 0)),
    ],
  };
}));

/* ---------------- Client 360: smart counts + activity timeline ---------------- */
wholesaleErp.get("/wholesale/clients/:id/360", h((req) => {
  const t = tid(req);
  const c = get("SELECT * FROM wholesale_clients WHERE id=? AND tenant_id=?", Number(req.params.id), t);
  if (!c) throw new AppError(404, "Wholesale client not found");
  const yearStart = new Date(`${pkDate().slice(0, 4)}-01-01T00:00:00+05:00`).toISOString();
  const k = get(`SELECT COUNT(DISTINCT CASE WHEN type IN ('supply','carriage') THEN ${KEY.replaceAll("x.", "")} END) invoices,
      COUNT(CASE WHEN type='payment' THEN 1 END) payments, COUNT(DISTINCT CASE WHEN type='supply' AND vehicle_no IS NOT NULL AND vehicle_no<>'' THEN UPPER(vehicle_no) END) vehicles,
      COALESCE(SUM(CASE WHEN type='supply' AND txn_date >= ? THEN litres END),0) litres_year, COALESCE(SUM(CASE WHEN type='payment' AND txn_date >= ? THEN amount END),0) paid_year,
      MAX(CASE WHEN type='supply' THEN txn_date END) last_supply, MAX(CASE WHEN type='payment' THEN txn_date END) last_payment
    FROM wholesale_txns WHERE client_id=? AND voided=0`, yearStart, yearStart, c.id)!;
  const due = clientDue(c.id);
  const up = unpaidBills(c.id, due);
  const oldest = up.bills.length ? Math.max(...up.bills.map((b) => b.days)) : 0;
  const orders = openOrders(t, c.id);
  const pendingReq = clientRequests(t, c.id).filter((r) => r.status === "pending").length;
  const tags: { label: string; tone: string }[] = [];
  if (!c.active) tags.push({ label: "Inactive", tone: "slate" });
  if (due > 0.5 && oldest > 60) tags.push({ label: `Overdue ${oldest} days`, tone: "red" });
  else if (due > 0.5 && oldest > OVERDUE_DAYS) tags.push({ label: `Late payer · ${oldest} days`, tone: "amber" });
  else if (k.payments >= 2) tags.push({ label: "Pays on time", tone: "green" });
  if (c.credit_limit > 0 && due >= 0.9 * c.credit_limit) tags.push({ label: `${Math.round((due / c.credit_limit) * 100)}% of limit`, tone: "red" });
  if (due < -0.5) tags.push({ label: "Advance with us", tone: "green" });

  // one timeline: ledger entries, orders, promises, cheques, portal requests (newest first)
  const ev: { at: string; who: string | null; kind: string; text: string; amount?: number | null; voided?: boolean; txn_id?: number }[] = [];
  const P = (p: string | null) => PRODUCTS[p ?? ""] ?? p ?? "";
  for (const x of all(`SELECT x.*, ${KEY} inv_no FROM wholesale_txns x WHERE x.client_id=? ORDER BY x.created_at DESC, x.id DESC LIMIT 40`, c.id))
    ev.push({ at: x.created_at, who: x.created_by, kind: x.type, txn_id: x.id, voided: !!x.voided, amount: x.amount,
      text: x.type === "supply" ? `Supply ${x.inv_no} · ${Math.round(x.litres ?? 0).toLocaleString("en-PK")} L ${P(x.product)}${x.vehicle_no ? ` · ${x.vehicle_no}` : ""}`
        : x.type === "payment" ? `Payment received · ${x.method ?? "cash"}${x.ref && x.ref !== "refund:" ? ` · ${x.ref}` : ""}`
        : x.type === "return" ? `Return · ${Math.round(x.litres ?? 0)} L ${P(x.product)}`
        : x.type === "carriage" ? `Kiraya ${x.inv_no}` : x.ref === "refund:" ? "Advance returned" : `Adjustment${x.note ? ` · ${x.note}` : ""}` });
  for (const o of all("SELECT * FROM wholesale_orders WHERE client_id=? AND tenant_id=? ORDER BY id DESC LIMIT 15", c.id, t))
    ev.push({ at: o.created_at, who: o.created_by, kind: "order", text: `Order SO-${o.id} · ${Math.round(o.litres).toLocaleString("en-PK")} L ${P(o.product)} for ${o.needed_on}${o.status === "done" ? " · delivered" : o.status === "open" ? " · open" : ` · ${o.status}`}` });
  for (const p of all("SELECT * FROM wholesale_promises WHERE client_id=? AND tenant_id=? ORDER BY id DESC LIMIT 10", c.id, t))
    ev.push({ at: p.created_at, who: p.created_by, kind: "promise", amount: p.amount, text: `Promised to pay on ${p.promised_on}${p.note ? ` · ${p.note}` : ""}` });
  for (const q of all("SELECT * FROM wholesale_cheques WHERE client_id=? AND tenant_id=? ORDER BY id DESC LIMIT 10", c.id, t))
    ev.push({ at: q.created_at, who: q.created_by, kind: "cheque", amount: q.amount, text: `Cheque ${q.bank} #${q.cheque_no} dated ${q.cheque_date} · ${String(q.status).replace("_", " ")}` });
  for (const r of clientRequests(t, c.id, true).slice(0, 10))
    ev.push({ at: r.created_at, who: "Client (portal)", kind: "request", text: `Asked for ${Math.round(r.litres).toLocaleString("en-PK")} L ${P(r.product)} on ${r.want_date} · ${r.status}${r.decided_by ? ` by ${r.decided_by}` : ""}` });
  ev.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return {
    since: c.created_at, due, oldest_days: oldest, tags,
    counts: { invoices: k.invoices, unpaid_invoices: up.bills.filter((b) => b.type !== "adjustment").length, payments: k.payments, open_orders: orders.length, open_orders_l: round2(orders.reduce((a, o) => a + o.litres, 0)),
      pending_requests: pendingReq, vehicles: k.vehicles, litres_year: round2(k.litres_year), paid_year: round2(k.paid_year) },
    last_supply: k.last_supply, last_payment: k.last_payment,
    vehicles: all("SELECT UPPER(vehicle_no) v, COUNT(*) n, MAX(txn_date) last FROM wholesale_txns WHERE client_id=? AND voided=0 AND type='supply' AND vehicle_no IS NOT NULL AND vehicle_no<>'' GROUP BY UPPER(vehicle_no) ORDER BY n DESC LIMIT 20", c.id),
    activity: ev.slice(0, 40),
  };
}));
