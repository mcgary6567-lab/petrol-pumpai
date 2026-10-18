/** Supplier accounts (payables): fuel purchases from depots and our payments to them. */
import { Router } from "express";
import { z } from "zod";
import { recordWithholding, taxSettings } from "./tax.js";
import { all, get, run, now, tx } from "../db.js";
import { linkPhotos, proofPhotos, proofCol, requireProof, isCheque } from "./capture.js";
import { bankAccountFor, accountIdField, chequeToRegister, accountName } from "./banks.js";
import { h, parse, tid, can, requirePerm } from "../auth.js";
import { AppError, assertNoDuplicateParty, normalizePhone, round2 } from "../services.js";
import { announce } from "../notifications.js";
import { bypassOwed } from "./bypass.js";

export const suppliers = Router();
// the cashier may pay a supplier (cash.pay) without seeing the rest of the supplier accounts
suppliers.use("/suppliers", (req, _res, next) =>
  can(req.user, "suppliers.manage") || (req.method === "POST" && /^\/\d+\/payment$/.test(req.path) && can(req.user, "cash.pay"))
    ? next() : next(new AppError(403, "You don't have permission for this")));

/** The oil companies a depot man can represent (free text "Other" is also allowed). */
export const OIL_COMPANIES = ["PSO", "Shell", "Total PARCO", "Attock (APL)", "GO", "Hascol", "Byco / Puma", "Be Energy", "Askar", "Other"];
/** One depot: name + address; the men inside it are supplier rows pointing here. */
const depotOut = (t: number, d: any) => {
  const r = get(`SELECT COUNT(*) n, COALESCE(SUM(s.opening_balance),0) ob FROM suppliers s WHERE s.depot_id=? AND s.tenant_id=?`, d.id, t)!;
  const owed = all("SELECT id FROM suppliers WHERE depot_id=? AND tenant_id=?", d.id, t).reduce((a, s) => a + supplierOwed(s.id), 0);
  return { ...d, contacts: r.n as number, owed: round2(owed) };
};

suppliers.get("/depots", requirePerm("suppliers.manage"), h((req) =>
  all("SELECT * FROM depots WHERE tenant_id=? ORDER BY active DESC, name", tid(req)).map((d) => depotOut(tid(req), d))));

suppliers.post("/depots", requirePerm("suppliers.manage"), h((req) => {
  const b = parse(z.object({ name: z.string().min(2).max(80), address: z.string().max(200).optional().nullable(), city: z.string().max(60).optional().nullable(),
    phone: z.string().max(30).optional().nullable(), notes: z.string().max(300).optional().nullable() }), req.body);
  const { id } = run("INSERT INTO depots (tenant_id,name,address,city,phone,notes,created_at) VALUES (?,?,?,?,?,?,?)",
    tid(req), b.name, b.address ?? null, b.city ?? null, b.phone ? normalizePhone(b.phone) : null, b.notes ?? null, now());
  return depotOut(tid(req), get("SELECT * FROM depots WHERE id=?", id));
}));

suppliers.patch("/depots/:id", requirePerm("suppliers.manage"), h((req) => {
  const d = get("SELECT * FROM depots WHERE id=? AND tenant_id=?", Number(req.params.id), tid(req));
  if (!d) throw new AppError(404, "Depot not found");
  const b = parse(z.object({ name: z.string().min(2).max(80).optional(), address: z.string().max(200).nullable().optional(), city: z.string().max(60).nullable().optional(),
    phone: z.string().max(30).nullable().optional(), notes: z.string().max(300).nullable().optional(), active: z.boolean().optional() }), req.body);
  const pick = (v: any, cur: any) => (v === undefined ? cur : v);
  run("UPDATE depots SET name=?, address=?, city=?, phone=?, notes=?, active=? WHERE id=?",
    b.name ?? d.name, pick(b.address, d.address), pick(b.city, d.city), b.phone !== undefined ? (b.phone ? normalizePhone(b.phone) : null) : d.phone,
    pick(b.notes, d.notes), b.active === undefined ? d.active : b.active ? 1 : 0, d.id);
  return depotOut(tid(req), get("SELECT * FROM depots WHERE id=?", d.id));
}));

const OWED_SQL = `CASE type WHEN 'purchase' THEN amount WHEN 'payment' THEN -amount ELSE amount END`;

/** What we currently owe this supplier (positive = we owe them). */
export function supplierOwed(supplierId: number, before?: string): number {
  const s = get("SELECT opening_balance FROM suppliers WHERE id=?", supplierId)!;
  const r = get(`SELECT COALESCE(SUM(${OWED_SQL}),0) o FROM supplier_txns WHERE supplier_id=? ${before ? "AND txn_date < ?" : ""}`,
    ...(before ? [supplierId, before] : [supplierId]))!;
  return round2(s.opening_balance + r.o);
}

export function recordPurchase(tenantId: number, f: { supplier_id: number; delivery_id?: number | null; trip_id?: number | null; product: string | null; litres: number | null; rate: number | null;
  amount?: number; ref?: string | null; note?: string | null; by: string; at?: string }) {
  run(`INSERT INTO supplier_txns (tenant_id,supplier_id,type,delivery_id,trip_id,product,litres,rate,amount,ref,note,created_by,txn_date,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    tenantId, f.supplier_id, "purchase", f.delivery_id ?? null, f.trip_id ?? null, f.product, f.litres, f.rate, f.amount ?? round2((f.litres ?? 0) * (f.rate ?? 0)),
    f.ref ?? null, f.note ?? null, f.by, f.at ?? now(), now());
}

function own(tenantId: number, id: number) {
  const s = get("SELECT * FROM suppliers WHERE id=? AND tenant_id=?", id, tenantId);
  if (!s) throw new AppError(404, "Supplier not found");
  return s;
}

suppliers.get("/suppliers", h((req) => all(`SELECT s.*, d.name depot_name, d.address depot_address, d.city depot_city
    FROM suppliers s LEFT JOIN depots d ON d.id=s.depot_id WHERE s.tenant_id=? ORDER BY s.active DESC, COALESCE(d.name,''), s.company, s.name`, tid(req)).map((s) => ({
  ...s, owed: supplierOwed(s.id), bypass_owed: bypassOwed(s.id), total_owed: round2(supplierOwed(s.id) + bypassOwed(s.id)),
  ...get(`SELECT MAX(CASE WHEN type='purchase' THEN txn_date END) last_purchase, MAX(CASE WHEN type='payment' THEN txn_date END) last_payment,
      COALESCE(SUM(CASE WHEN type='purchase' AND txn_date >= ? THEN litres END),0) month_l FROM supplier_txns WHERE supplier_id=?`,
    new Date().toISOString().slice(0, 7) + "-01", s.id)!,
}))));

const supplierBody = z.object({
  name: z.string().min(2).max(80), phone: z.string().optional().nullable(), opening_balance: z.number().optional(),
  notes: z.string().optional().nullable(), depot_id: z.number().int().nullable().optional(), company: z.string().max(60).nullable().optional(),
});
/** Check a chosen depot belongs to this pump. */
const checkDepot = (t: number, depotId: number | null | undefined) => {
  if (depotId && !get("SELECT id FROM depots WHERE id=? AND tenant_id=?", depotId, t)) throw new AppError(400, "Depot not found");
};

suppliers.post("/suppliers", h(async (req) => {
  const b = parse(supplierBody, req.body);
  assertNoDuplicateParty("suppliers", tid(req), b.name, b.phone, "Supplier");
  checkDepot(tid(req), b.depot_id);
  const { id } = run("INSERT INTO suppliers (tenant_id,name,phone,opening_balance,notes,depot_id,company,created_at) VALUES (?,?,?,?,?,?,?,?)",
    tid(req), b.name, b.phone ? normalizePhone(b.phone) : null, b.opening_balance ?? 0, b.notes ?? null, b.depot_id ?? null, b.company ?? null, now());
  await announce(tid(req), req.user!.id, ["manager", "admin"], { type: "new_supplier", data: { supplier_id: id },
    title: `🏭 New supplier: ${[b.company, b.name].filter(Boolean).join(" — ")}`, body: `Tanker delivery par ab ye supplier chuna ja sakta hai.` });
  return { ...get("SELECT * FROM suppliers WHERE id=?", id)!, owed: supplierOwed(id) };
}));

/** Edit a supplier contact: name, phone, which depot, which company, notes, active. */
suppliers.patch("/suppliers/:id", h((req) => {
  const s = own(tid(req), Number(req.params.id));
  const b = parse(supplierBody.partial().extend({ active: z.boolean().optional() }), req.body);
  checkDepot(tid(req), b.depot_id);
  const pick = (v: any, cur: any) => (v === undefined ? cur : v);
  run("UPDATE suppliers SET name=?, phone=?, notes=?, depot_id=?, company=?, active=? WHERE id=?",
    b.name ?? s.name, b.phone !== undefined ? (b.phone ? normalizePhone(b.phone) : null) : s.phone, pick(b.notes, s.notes),
    pick(b.depot_id, s.depot_id), pick(b.company, s.company), b.active === undefined ? s.active : b.active ? 1 : 0, s.id);
  return { ...get("SELECT * FROM suppliers WHERE id=?", s.id)!, owed: supplierOwed(s.id) };
}));

suppliers.get("/suppliers/meta/companies", requirePerm("suppliers.manage"), h(() => ({ companies: OIL_COMPANIES })));

suppliers.get("/suppliers/:id", h((req) => {
  const s0 = own(tid(req), Number(req.params.id));
  const dep = s0.depot_id ? get("SELECT name, address, city FROM depots WHERE id=?", s0.depot_id) : null;
  const s = { ...s0, depot_name: dep?.name ?? null, depot_address: dep?.address ?? null, depot_city: dep?.city ?? null };
  return { ...s, owed: supplierOwed(s.id), bypass_owed: bypassOwed(s.id), total_owed: round2(supplierOwed(s.id) + bypassOwed(s.id)), lines: supplierLines(s).reverse() };
}));

/**
 * One account per supplier: the pump's own purchases/payments (supplier_txns) AND the bypass purchases/payments for clients
 * (bypass_purchases / bypass_supplier_payments), merged by date with one running balance — what we owe this supplier in all.
 * Each line says where it came from (`source`: pump | bypass). Opening balance is the pump account's.
 */
export function supplierLines(s: { id: number; opening_balance: number }) {
  const pump = all(`SELECT x.*, ${proofCol("'stx:'||x.id")} FROM supplier_txns x WHERE x.supplier_id=?`, s.id).map((t) => ({ ...t, source: "pump", effect: t.type === "payment" ? -t.amount : t.amount }));
  const byPur = all("SELECT id, 'purchase' type, txn_date, created_at, product, litres, cost_rate rate, amount, ref, note, created_by FROM bypass_purchases WHERE supplier_id=? AND voided=0", s.id)
    .map((t) => ({ ...t, id: `b${t.id}`, source: "bypass", effect: t.amount }));
  const byPay = all(`SELECT p.id, 'payment' type, p.txn_date, p.created_at, p.amount, p.mode, p.method, p.account_id, p.ref, p.note, p.created_by, c.name client_name, ${proofCol("'byp:pay:'||p.id")} FROM bypass_supplier_payments p
    LEFT JOIN wholesale_clients c ON c.id=p.client_id WHERE p.supplier_id=? AND p.voided=0`, s.id)
    .map((t) => ({ ...t, id: `b${t.id}`, source: "bypass", effect: -t.amount, note: [t.mode === "client_direct" ? `client ${t.client_name ?? ""} ne seedha diya` : t.mode === "through_us" ? `client ${t.client_name ?? ""} ka paisa hum ne aage diya` : null, t.note].filter(Boolean).join(" · ") || null }));
  const rows = [...pump, ...byPur, ...byPay].sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))));
  let bal = s.opening_balance;
  return rows.map((t) => {
    bal = round2(bal + t.effect);
    const acc = t.account_id ? get("SELECT * FROM bank_accounts WHERE id=?", t.account_id) : null;
    const { effect, ...rest } = t;
    return { ...rest, debit: effect > 0 ? effect : 0, credit: effect < 0 ? -effect : 0, balance: bal, account_name: acc ? accountName(acc) : null };
  });
}

/** The supplier's account statement as a CSV (Excel) download — oldest entry first. */
suppliers.get("/suppliers/:id/statement.csv", (req, res, next) => {
  try {
    const s = own(tid(req), Number(req.params.id));
    const lines = supplierLines(s).map((t) => {
      return { ...t, type: t.source === "bypass" ? `${t.type} (bypass)` : t.type };
    });
    const name = [s.company, s.name].filter(Boolean).join(" — ");
    const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const out = [
      ["Supplier statement", name].map(esc).join(","),
      ["Opening balance", s.opening_balance].map(esc).join(","),
      ["Date", "Type", "Product", "Litres", "Rate", "Purchased (debit)", "Paid (credit)", "We owe", "Method", "Ref", "Note"].map(esc).join(","),
      ...lines.map((t) => [String(t.txn_date).slice(0, 10), t.type, t.product ?? "", t.litres ?? "", t.rate ?? "", t.debit || "", t.credit || "", t.balance, t.method ?? "", t.ref ?? "", t.note ?? ""].map(esc).join(",")),
      ["Closing balance (we owe — pump + bypass)", round2(supplierOwed(s.id) + bypassOwed(s.id))].map(esc).join(","),
    ].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="supplier-${String(name).replace(/[^\w-]+/g, "_")}.csv"`);
    res.send("﻿" + out);
  } catch (e) { next(e); }
});

suppliers.post("/suppliers/:id/payment", h((req) => {
  const s = own(tid(req), Number(req.params.id));
  const b = parse(z.object({ amount: z.number().positive(), method: z.string().min(2), ref: z.string().optional().nullable(), note: z.string().optional().nullable(),
    txn_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
    /** income tax withheld from this payment (paid to FBR instead of the supplier) */
    withholding: z.number().min(0).optional(), wht_section: z.string().max(30).optional().nullable(), photo_ids: proofPhotos, account_id: accountIdField }), req.body);
  const ts = b.txn_date ? new Date(b.txn_date).toISOString() : now();
  const t = tid(req);
  if (isCheque(b.method)) requireProof(t, b.photo_ids, "cheque");
  const accountId = bankAccountFor(t, b.account_id, b.method);
  // our cheque leaves the bank only when the depot cashes it: it waits in the cheque register until then
  if (isCheque(b.method) && !b.withholding) {
    if (!accountId && get("SELECT id FROM bank_accounts WHERE tenant_id=? AND active=1", t)) throw new AppError(400, "Choose the bank account the cheque is drawn on");
    const id = chequeToRegister(t, { direction: "out", party_type: "supplier", party_id: s.id, party_name: s.name, amount: b.amount, bank: accountId ? get("SELECT bank FROM bank_accounts WHERE id=?", accountId)!.bank : null,
      cheque_no: b.ref, cheque_date: b.txn_date?.slice(0, 10), account_id: accountId, note: b.note, by: req.user!.name });
    linkPhotos(t, b.photo_ids, `chq:${id}`);
    return { owed: supplierOwed(s.id), cheque_pending: true, message: "Cheque is in the register — mark it cleared when the bank pays it" };
  }
  let pid = 0;
  tx(() => {
    pid = run("INSERT INTO supplier_txns (tenant_id,supplier_id,type,amount,method,ref,note,created_by,txn_date,created_at,account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      t, s.id, "payment", b.amount, b.method, b.ref ?? null, b.note ?? null, req.user!.name, ts, now(), accountId).id;
    linkPhotos(t, b.photo_ids, `stx:${pid}`);
    if (b.withholding) {
      const w = run("INSERT INTO supplier_txns (tenant_id,supplier_id,type,amount,method,ref,note,created_by,txn_date,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        t, s.id, "payment", b.withholding, "WHT", b.ref ?? null, "Income tax withheld", req.user!.name, ts, now()).id;
      recordWithholding(t, { payee: s.name, supplier_id: s.id, supplier_txn_id: w, section: b.wht_section ?? taxSettings(t).wht_section, gross: round2(b.amount + b.withholding),
        rate: round2((b.withholding / (b.amount + b.withholding)) * 100), amount: b.withholding, note: b.ref ? `Payment ${b.ref}` : null, by: req.user!.name, date: ts });
    }
  });
  // the payment as saved, for the voucher printed straight after
  const acc = accountId ? get("SELECT * FROM bank_accounts WHERE id=?", accountId) : null;
  return { owed: supplierOwed(s.id), payment: { ...get("SELECT * FROM supplier_txns WHERE id=?", pid), account_name: acc ? accountName(acc) : null, withholding: b.withholding ?? 0 } };
}));

suppliers.post("/suppliers/:id/adjustment", h((req) => {
  const s = own(tid(req), Number(req.params.id));
  const b = parse(z.object({ amount: z.number().refine((v) => v !== 0), note: z.string().min(3, "Give a reason") }), req.body);
  run("INSERT INTO supplier_txns (tenant_id,supplier_id,type,amount,note,created_by,txn_date,created_at) VALUES (?,?,?,?,?,?,?,?)",
    tid(req), s.id, "adjustment", b.amount, b.note, req.user!.name, now(), now());
  return { owed: supplierOwed(s.id) };
}));
