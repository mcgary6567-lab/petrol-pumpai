/**
 * Parties admin (CEO): delete a party that was made by mistake, or merge a duplicate into the real one.
 *
 *  - customers (khata), wholesale clients, suppliers and thekedars (carriage contractors)
 *  - DELETE only when nothing refers to the party: no sale, khata line, payment, trip, order, cheque… and no opening balance.
 *    Set-up rows (a customer's vehicles, a client's rate card) go with it. The row is kept in the audit log.
 *  - MERGE re-points every entry of the duplicate to the party kept (sales, ledgers, payments, cheques, vouchers, orders,
 *    promises, rate history…), adds the stored balances (khata balance, wallet, points, opening balance) and removes the
 *    duplicate row. Nothing is re-valued: the books tally exactly as before because every entry still exists, under one name.
 *
 * Which tables refer to a party is read from the schema itself (every table with a customer_id / client_id / supplier_id /
 * thekedar_id column, plus the party_type + party_id tables), so a table added later is covered automatically.
 */
import { Router } from "express";
import { z } from "zod";
import { all, get, run, tx } from "../db.js";
import { h, parse, tid, requirePerm } from "../auth.js";
import { AppError, audit } from "../services.js";

export const parties = Router();

type Kind = "customer" | "client" | "supplier" | "thekedar";
const KINDS: Record<Kind, { table: string; col: string; partyType: string; label: string; sum: string[]; setup: string[]; fields: string[] }> = {
  customer: { table: "customers", col: "customer_id", partyType: "khata", label: "Customer", sum: ["balance", "loyalty_points", "wallet_balance"], setup: ["vehicles"], fields: ["name", "phone", "type", "city"] },
  client: { table: "wholesale_clients", col: "client_id", partyType: "wholesale", label: "Wholesale client", sum: ["opening_balance"], setup: ["wholesale_rates", "wholesale_rate_history"], fields: ["name", "business_name", "phone", "city"] },
  supplier: { table: "suppliers", col: "supplier_id", partyType: "supplier", label: "Supplier", sum: ["opening_balance"], setup: [], fields: ["name", "company", "phone"] },
  thekedar: { table: "thekedars", col: "thekedar_id", partyType: "carriage", label: "Thekedar", sum: ["opening_balance"], setup: [], fields: ["name", "phone", "city"] },
};
/** Tables that name the party by party_type + party_id rather than a dedicated column. */
const PARTY_TYPE_TABLES = ["cheques", "cashier_vouchers", "other_entries"];
const kindOf = (s: string): Kind => { if (!(s in KINDS)) throw new AppError(404, "Unknown party kind"); return s as Kind; };

const refCache = new Map<Kind, string[]>();
/** Every table with this kind's id column (read once from the schema). */
function refTables(kind: Kind): string[] {
  const hit = refCache.get(kind);
  if (hit) return hit;
  const col = KINDS[kind].col;
  const out: string[] = [];
  for (const t of all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")) {
    if (t.name === KINDS[kind].table) continue;
    if (all(`PRAGMA table_info(${t.name})`).some((c) => c.name === col)) out.push(t.name as string);
  }
  refCache.set(kind, out);
  return out;
}
const hasPartyType = (t: string) => all(`PRAGMA table_info(${t})`).some((c) => c.name === "party_type");

function party(kind: Kind, id: number, t: number) {
  const row = get(`SELECT * FROM ${KINDS[kind].table} WHERE id=? AND tenant_id=?`, id, t);
  if (!row) throw new AppError(404, `${KINDS[kind].label} not found`);
  return row;
}

/** Row counts per table that refer to this party, split into entries (money / stock moved) and set-up rows. */
export function partyUsage(kind: Kind, id: number) {
  const k = KINDS[kind];
  const entries: Record<string, number> = {}, setup: Record<string, number> = {};
  for (const t of refTables(kind)) {
    const n = get(`SELECT COUNT(*) n FROM ${t} WHERE ${k.col}=?`, id)!.n as number;
    if (!n) continue;
    (k.setup.includes(t) ? setup : entries)[t] = n;
  }
  for (const t of PARTY_TYPE_TABLES) {
    if (!hasPartyType(t)) continue;
    const n = get(`SELECT COUNT(*) n FROM ${t} WHERE party_type=? AND party_id=?`, k.partyType, id)!.n as number;
    if (n) entries[t] = n;
  }
  return { entries, setup, total: Object.values(entries).reduce((a, b) => a + b, 0) };
}

const LABELS: Record<string, string> = { sales: "fuel sales", khata_ledger: "khata entries", orders: "orders", shop_sales: "shop sales", khata_bills: "khata bills", wallet_ledger: "wallet entries", fuel_coupons: "coupons", bookings: "bookings", complaints: "complaints", conversations: "WhatsApp chats", ratings: "ratings", payment_inbox: "payments received", loyalty_redemptions: "points redeemed", khata_guarantees: "guarantees",
  wholesale_txns: "wholesale entries", wholesale_orders: "orders", wholesale_promises: "payment promises", wholesale_cheques: "cheques", wholesale_requests: "requests", wholesale_trips: "tanker trips", bypass_drops: "bypass deliveries", bypass_fuel_payments: "bypass payments", bypass_supplier_payments: "bypass supplier payments", bypass_purchases: "bypass purchases",
  deliveries: "tanker deliveries", supplier_txns: "supplier entries", purchase_orders: "purchase orders", shortage_claims: "shortage claims", tax_withholdings: "tax entries", carriage_txns: "carriage entries",
  cheques: "cheques", cashier_vouchers: "cashier vouchers", other_entries: "other entries", vehicles: "vehicles", wholesale_rates: "rate card", wholesale_rate_history: "rate history" };
const describe = (counts: Record<string, number>) => Object.entries(counts).map(([t, n]) => ({ table: t, label: LABELS[t] ?? t.replace(/_/g, " "), n }));

parties.get("/parties/:kind/:id/usage", requirePerm("corrections.manage"), h((req) => {
  const kind = kindOf(req.params.kind), t = tid(req);
  const p = party(kind, Number(req.params.id), t);
  const u = partyUsage(kind, p.id);
  const opening = kind === "customer" ? 0 : Number(p.opening_balance ?? 0);
  return { kind, id: p.id, name: p.name, entries: describe(u.entries), setup: describe(u.setup), total: u.total, opening_balance: opening,
    deletable: u.total === 0 && Math.abs(opening) < 0.005 && (kind !== "customer" || (Math.abs(p.balance ?? 0) < 0.005 && Math.abs(p.wallet_balance ?? 0) < 0.005)) };
}));

/** Other parties of the same kind to merge into (same pump, not this one). */
parties.get("/parties/:kind/search", requirePerm("corrections.manage"), h((req) => {
  const kind = kindOf(req.params.kind), k = KINDS[kind];
  const q = String(req.query.q ?? "").trim().toLowerCase();
  const not = Number(req.query.not ?? 0);
  const rows = all(`SELECT id, ${k.fields.join(", ")}, active FROM ${k.table} WHERE tenant_id=? AND id<>? ORDER BY active DESC, name`, tid(req), not);
  return rows.filter((r) => !q || k.fields.some((f) => String(r[f] ?? "").toLowerCase().includes(q))).slice(0, 30)
    .map((r) => ({ id: r.id, name: r.name, active: Boolean(r.active), sub: k.fields.slice(1).map((f) => r[f]).filter(Boolean).join(" · ") }));
}));

parties.delete("/parties/:kind/:id", requirePerm("corrections.manage"), h((req) => {
  const kind = kindOf(req.params.kind), k = KINDS[kind], t = tid(req);
  const p = party(kind, Number(req.params.id), t);
  const u = partyUsage(kind, p.id);
  if (u.total > 0) throw new AppError(400, `${p.name} ki ${u.total} entries hain (${describe(u.entries).map((x) => `${x.n} ${x.label}`).join(", ")}) — delete nahi ho sakta. Duplicate hai to asal wale me merge karein, warna archive.`);
  if (kind !== "customer" && Math.abs(Number(p.opening_balance ?? 0)) >= 0.005) throw new AppError(400, `${p.name} par opening balance likha hai — pehle use 0 karein ya merge karein`);
  if (kind === "customer" && (Math.abs(p.balance ?? 0) >= 0.005 || Math.abs(p.wallet_balance ?? 0) >= 0.005)) throw new AppError(400, `${p.name} ka khata / wallet balance hai — delete nahi ho sakta`);
  tx(() => {
    for (const s of k.setup) if (refTables(kind).includes(s)) run(`DELETE FROM ${s} WHERE ${k.col}=?`, p.id);
    run(`DELETE FROM ${k.table} WHERE id=? AND tenant_id=?`, p.id, t);
  });
  audit(t, req.user!, `${kind}_delete`, `${kind}:${p.id}`, { row: p, setup: u.setup });
  return { ok: true, deleted: { id: p.id, name: p.name } };
}));

/** Merge this (duplicate) party into another: every entry moves, balances add up, the duplicate row goes. */
parties.post("/parties/:kind/:id/merge", requirePerm("corrections.manage"), h((req) => {
  const kind = kindOf(req.params.kind), k = KINDS[kind], t = tid(req);
  const b = parse(z.object({ into: z.number().int() }), req.body);
  const src = party(kind, Number(req.params.id), t);
  if (b.into === src.id) throw new AppError(400, "Same party — kisi doosre me merge karein");
  const dst = party(kind, b.into, t);
  const moved: Record<string, number> = {};
  tx(() => {
    for (const tbl of refTables(kind)) {
      if (tbl === "wholesale_rates") {
        // one rate per client & product: the kept client's own rate wins, the duplicate's fills any gap
        run("DELETE FROM wholesale_rates WHERE client_id=? AND product IN (SELECT product FROM wholesale_rates WHERE client_id=?)", src.id, dst.id);
      }
      const n = run(`UPDATE ${tbl} SET ${k.col}=? WHERE ${k.col}=?`, dst.id, src.id).changes;
      if (n) moved[tbl] = n;
    }
    for (const tbl of PARTY_TYPE_TABLES) {
      if (!hasPartyType(tbl)) continue;
      const n = run(`UPDATE ${tbl} SET party_id=?, party_name=? WHERE party_type=? AND party_id=?`, dst.id, dst.name, k.partyType, src.id).changes;
      if (n) moved[tbl] = n;
    }
    if (k.sum.length) run(`UPDATE ${k.table} SET ${k.sum.map((c) => `${c}=COALESCE(${c},0)+?`).join(", ")} WHERE id=?`, ...k.sum.map((c) => Number(src[c] ?? 0)), dst.id);
    // a duplicate with a phone the kept one lacks: keep the phone
    if (!dst.phone && src.phone) run(`UPDATE ${k.table} SET phone=? WHERE id=?`, src.phone, dst.id);
    run(`DELETE FROM ${k.table} WHERE id=? AND tenant_id=?`, src.id, t);
  });
  audit(t, req.user!, `${kind}_merge`, `${kind}:${dst.id}`, { from: src, into: { id: dst.id, name: dst.name }, moved });
  return { ok: true, into: { id: dst.id, name: dst.name }, from: { id: src.id, name: src.name }, moved: describe(moved), total: Object.values(moved).reduce((a, b) => a + b, 0) };
}));
