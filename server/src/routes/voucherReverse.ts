/**
 * Whole-voucher reversal: a tanker trip (wholesale_trips) or a bypass delivery (bypass_deliveries) taken back in ONE go,
 * every leg together — the supplier's bill, each client's drop, own-tank unloads, freight, shortage claims, orders.
 *
 *   GET  /vouchers/:kind/:id/plan   → what would reverse (per leg, in rupees / litres) and what blocks it
 *   POST /vouchers/:kind/:id/void   → does it (PIN-guarded like every void), all or nothing
 *
 * Nothing is deleted from the statements: lines are voided (struck through) with the reason, so every khata still shows
 * what happened. A reversal that would leave a book wrong (stock already sold on, a payment received on a drop, a claim
 * already recovered) is refused with the exact line to fix first — never a half reversal.
 */
import { Router } from "express";
import { z } from "zod";
import { all, get, run, tx, now } from "../db.js";
import { h, parse, tid, requirePerm } from "../auth.js";
import { AppError, round2, audit, createAlert, pkr } from "../services.js";
import { PRODUCTS } from "../config.js";
import { bypassStock } from "./bypass.js";

export const vouchers = Router();
type Kind = "trip" | "bypass";
export type Leg = { what: string; party?: string | null; amount?: number | null; litres?: number | null; tone: "khata" | "supplier" | "stock" | "tank" | "cash" | "other" };
export type Plan = { kind: Kind; id: number; title: string; date: string; legs: Leg[]; blockers: string[]; ok: boolean; voided: boolean; summary: { clients: number; suppliers: number; litres: number } };

const fuel = (p: string | null | undefined) => (p ? PRODUCTS[p] ?? p : "");

/* ------------------------------------------------------------------ bypass delivery ------------------------------------------------------------------ */
function bypassPlan(t: number, id: number): Plan {
  const d = get("SELECT * FROM bypass_deliveries WHERE id=? AND tenant_id=?", id, t);
  if (!d) throw new AppError(404, "Delivery not found");
  const legs: Leg[] = [], blockers: string[] = [];
  const purchases = all("SELECT p.*, s.name supplier, s.client_id sup_client FROM bypass_purchases p JOIN suppliers s ON s.id=p.supplier_id WHERE p.delivery_id=? AND p.voided=0 ORDER BY p.id", id);
  const drops = all(`SELECT x.*, c.name client, w.amount sale_amount, w.id wtx, w.voided wvoided FROM bypass_drops x LEFT JOIN wholesale_clients c ON c.id=x.client_id LEFT JOIN wholesale_txns w ON w.id=x.wtx_id
    WHERE x.delivery_id=? AND x.voided=0 ORDER BY x.id`, id);
  // what this voucher took in and gave out, per fuel — the stock must still hold the difference once it is gone
  const inL: Record<string, number> = {}, outL: Record<string, number> = {};
  for (const p of purchases) {
    inL[p.product] = round2((inL[p.product] ?? 0) + p.litres);
    const cf = get("SELECT f.*, c.name client FROM bypass_supplier_payments f LEFT JOIN wholesale_clients c ON c.id=f.client_id WHERE f.ref=? AND f.voided=0", `cfuel:${p.id}`);
    if (cf) legs.push({ what: `Client se khareed wapas — ${p.litres} L ${fuel(p.product)} (us ke khate se kati raqam wapas chadhegi)`, party: cf.client, amount: p.amount, litres: p.litres, tone: "khata" });
    else legs.push({ what: `Supplier bill mansookh — ${p.litres} L ${fuel(p.product)} @ ${p.cost_rate}`, party: p.supplier, amount: -p.amount, litres: -p.litres, tone: "supplier" });
  }
  for (const x of drops) {
    outL[x.product] = round2((outL[x.product] ?? 0) + x.litres);
    if (x.tank_id) {
      const tank = get("SELECT name, current_l FROM tanks WHERE id=?", x.tank_id);
      legs.push({ what: `Apne tank se wapas — ${x.litres} L ${fuel(x.product)} (${tank?.name ?? "tank"})`, party: null, litres: -x.litres, tone: "tank" });
      if (tank && tank.current_l < x.litres - 0.01) blockers.push(`${tank.name} me ab sirf ${Math.round(tank.current_l)} L hai — is voucher ke ${x.litres} L bik chuke hain. Pehle wo sale theek karein.`);
    } else {
      legs.push({ what: `Client drop mansookh — ${x.litres} L ${fuel(x.product)} (bill ${pkr(x.sale_amount ?? 0)})`, party: x.client, amount: -(x.sale_amount ?? 0), litres: x.litres, tone: "khata" });
      if (x.wtx && get("SELECT 1 x FROM cashier_vouchers WHERE tenant_id=? AND src=? AND voided=0", t, `wtx:${x.wtx}`)) blockers.push(`${x.client} ke drop par cashier voucher bana hua hai — pehle wo void karein.`);
    }
  }
  for (const p of new Set([...Object.keys(inL), ...Object.keys(outL)])) {
    const after = round2(bypassStock(t, p).litres - (inL[p] ?? 0) + (outL[p] ?? 0));
    if (after < -0.01) blockers.push(`${fuel(p)}: is bill ka ${Math.abs(after).toLocaleString()} L maal baad ke kisi voucher me nikal chuka hai — pehle wo voucher theek karein.`);
    else if (inL[p]) legs.push({ what: `Bypass stock ${fuel(p)}: ${after.toLocaleString()} L reh jayega`, litres: round2((outL[p] ?? 0) - (inL[p] ?? 0)), tone: "stock" });
  }
  if (!purchases.length && !drops.length) blockers.push("Is voucher me koi zinda line nahi (sab pehle hi mansookh).");
  const clients = new Set(drops.filter((x) => !x.tank_id).map((x) => x.client_id)).size, suppliers = new Set(purchases.map((p) => p.supplier_id)).size;
  return { kind: "bypass", id, title: `Bypass delivery #${id}`, date: d.txn_date, legs, blockers, ok: !d.voided && !blockers.length, voided: !!d.voided,
    summary: { clients, suppliers, litres: round2(Object.values(outL).reduce((a, v) => a + v, 0)) } };
}
function bypassReverse(t: number, by: string, id: number, reason: string) {
  const purchases = all("SELECT * FROM bypass_purchases WHERE delivery_id=? AND voided=0", id);
  const drops = all("SELECT * FROM bypass_drops WHERE delivery_id=? AND voided=0", id);
  const tag = ` [voucher void: ${reason}]`;
  for (const x of drops) {
    run("UPDATE bypass_drops SET voided=1, note=COALESCE(note,'') || ? WHERE id=?", tag, x.id);
    if (x.tank_id) { if (x.to_delivery_id) run("DELETE FROM deliveries WHERE id=?", x.to_delivery_id); run("UPDATE tanks SET current_l = current_l - ? WHERE id=?", x.litres, x.tank_id); }
    if (x.wtx_id) run("UPDATE wholesale_txns SET voided=1, void_reason=? WHERE id=? AND voided=0", `${by} (voucher void): ${reason}`, x.wtx_id);
  }
  for (const p of purchases) {
    run("UPDATE bypass_purchases SET voided=1 WHERE id=?", p.id);
    for (const s of all("SELECT * FROM bypass_supplier_payments WHERE tenant_id=? AND ref=? AND voided=0", t, `cfuel:${p.id}`)) {
      run("UPDATE bypass_supplier_payments SET voided=1 WHERE id=?", s.id);
      if (s.wtx_id) run("UPDATE wholesale_txns SET voided=1, void_reason=? WHERE id=? AND voided=0", `${by} (voucher void): ${reason}`, s.wtx_id);
    }
  }
  run("UPDATE bypass_deliveries SET voided=1, note=COALESCE(note,'') || ? WHERE id=?", tag, id);
}

/* ------------------------------------------------------------------ tanker trip ------------------------------------------------------------------ */
function tripPlan(t: number, id: number): Plan {
  const tr = get("SELECT tr.*, sp.name supplier FROM wholesale_trips tr LEFT JOIN suppliers sp ON sp.id=tr.supplier_id WHERE tr.id=? AND tr.tenant_id=?", id, t);
  if (!tr) throw new AppError(404, "Trip not found");
  const legs: Leg[] = [], blockers: string[] = [];
  const drops = all("SELECT w.*, c.name client, tk.name tank_name, tk.current_l FROM wholesale_txns w JOIN wholesale_clients c ON c.id=w.client_id LEFT JOIN tanks tk ON tk.id=w.tank_id WHERE w.trip_id=? AND w.voided=0 AND w.type='supply' ORDER BY w.id", id);
  const perTank: Record<number, number> = {};
  for (const w of drops) {
    legs.push({ what: `Client drop mansookh — ${w.litres} L ${fuel(w.product)} @ ${w.rate}`, party: w.client, amount: -w.amount, litres: w.litres, tone: "khata" });
    if (w.tank_id) perTank[w.tank_id] = round2((perTank[w.tank_id] ?? 0) + w.litres);
    if (get("SELECT 1 x FROM cashier_vouchers WHERE tenant_id=? AND src=? AND voided=0", t, `wtx:${w.id}`)) blockers.push(`${w.client} ke drop par cashier voucher bana hua hai — pehle wo void karein.`);
  }
  for (const [tk, l] of Object.entries(perTank)) {
    const tank = get("SELECT name, capacity_l, current_l FROM tanks WHERE id=?", Number(tk))!;
    legs.push({ what: `Tank me wapas — ${l} L (${tank.name})`, litres: l, tone: "tank" });
    if (tank.current_l + l > tank.capacity_l * 1.001) blockers.push(`${tank.name} me ${l} L wapas nahi samata (capacity ${Math.round(tank.capacity_l)} L, ab ${Math.round(tank.current_l)} L).`);
  }
  for (const p of all("SELECT * FROM supplier_txns WHERE trip_id=? AND type='purchase'", id))
    legs.push({ what: p.product ? `Depot bill mansookh — ${p.litres} L ${fuel(p.product)} @ ${p.rate}` : "Depot freight (bill par) mansookh", party: tr.supplier, amount: -p.amount, litres: p.product ? -p.litres : null, tone: "supplier" });
  for (const c of all("SELECT * FROM shortage_claims WHERE trip_id=?", id)) {
    if ((c.recovered ?? 0) > 0 || c.status === "recovered") blockers.push(`Shortage claim #${c.id} (${pkr(c.amount)}) recover ho chuka hai — pehle usay dekhein.`);
    else legs.push({ what: `Shortage claim #${c.id} hat jayega`, party: tr.supplier, amount: -c.amount, tone: "other" });
  }
  for (const e of all("SELECT e.*, sh.status shift_status FROM expenses e LEFT JOIN shifts sh ON sh.id=e.shift_id WHERE e.tenant_id=? AND e.note LIKE ? AND e.status<>'rejected'", t, `Trip #${id} —%`)) {
    legs.push({ what: `Kiraya (cash) kharcha wapas`, amount: e.amount, tone: "cash" });
    if (e.shift_status === "closed") blockers.push(`Kiraya ka kharcha band shift ka hai — cash wapas nahi ho sakta. Pehle shift ki correction karein.`);
  }
  if (!drops.length) blockers.push("Is trip me koi zinda drop nahi (sab pehle hi mansookh).");
  return { kind: "trip", id, title: `Tanker trip #${id}`, date: tr.trip_date, legs, blockers, ok: !tr.voided && !blockers.length, voided: !!tr.voided,
    summary: { clients: new Set(drops.map((w) => w.client_id)).size, suppliers: tr.supplier_id ? 1 : 0, litres: round2(drops.reduce((a, w) => a + w.litres, 0)) } };
}
function tripReverse(t: number, by: string, id: number, reason: string) {
  for (const w of all("SELECT * FROM wholesale_txns WHERE trip_id=? AND voided=0 AND type='supply'", id)) {
    if (w.tank_id && w.litres) run("UPDATE tanks SET current_l = current_l + ? WHERE id=?", w.litres, w.tank_id);
    run("UPDATE wholesale_txns SET voided=1, void_reason=? WHERE id=?", `${by} (voucher void): ${reason}`, w.id);
    run("UPDATE wholesale_orders SET status='open', txn_id=NULL, done_at=NULL WHERE tenant_id=? AND txn_id=? AND status='done'", t, w.id);
  }
  run("DELETE FROM supplier_txns WHERE tenant_id=? AND trip_id=? AND type='purchase'", t, id);
  run("DELETE FROM shortage_claims WHERE tenant_id=? AND trip_id=?", t, id);
  run("DELETE FROM expenses WHERE tenant_id=? AND note LIKE ? AND status<>'rejected'", t, `Trip #${id} —%`);
  run("UPDATE wholesale_trips SET voided=1, void_reason=?, voided_by=?, voided_at=? WHERE id=?", reason, by, now(), id);
}

/* ------------------------------------------------------------------ routes ------------------------------------------------------------------ */
export function voucherPlan(t: number, kind: Kind, id: number): Plan { return kind === "trip" ? tripPlan(t, id) : bypassPlan(t, id); }
const kindParam = z.enum(["trip", "bypass"]);
vouchers.get("/vouchers/:kind/:id/plan", requirePerm("wholesale.void"), h((req) => voucherPlan(tid(req), kindParam.parse(req.params.kind), Number(req.params.id))));
vouchers.post("/vouchers/:kind/:id/void", requirePerm("wholesale.void"), h((req) => {
  const t = tid(req), kind = kindParam.parse(req.params.kind), id = Number(req.params.id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3, "Wajah likhein (kam se kam 3 harf)").max(200) }), req.body);
  const plan = voucherPlan(t, kind, id);
  if (plan.voided) throw new AppError(400, "Ye voucher pehle hi mansookh hai");
  if (!plan.ok) throw new AppError(400, `Mansookh nahi ho sakta: ${plan.blockers[0]}`);
  tx(() => { if (kind === "trip") tripReverse(t, req.user!.name, id, reason); else bypassReverse(t, req.user!.name, id, reason); });
  audit(t, req.user!, "voucher_void", `${kind}:${id}`, { reason, legs: plan.legs.length, summary: plan.summary });
  createAlert(t, { type: "wholesale_void", severity: "info", title: `${plan.title} poora mansookh — ${req.user!.name}`, body: `${plan.summary.clients} client, ${plan.summary.litres.toLocaleString()} L. Wajah: ${reason}` });
  return { ok: true, plan };
}));
