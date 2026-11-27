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
import { dropClientFuelSettlement } from "./clientFuel.js";
import { z } from "zod";
import { all, get, run, tx, now } from "../db.js";
import { h, parse, tid, requirePerm } from "../auth.js";
import { AppError, round2, audit, createAlert, pkr } from "../services.js";
import { PRODUCTS } from "../config.js";
import { bypassStock, bypassLotState, closeEmptyVoucher } from "./bypass.js";
export const vouchers = Router();
const fuel = (p) => (p ? PRODUCTS[p] ?? p : "");
/* ------------------------------------------------------------------ bypass delivery ------------------------------------------------------------------ */
function bypassPlan(t, id) {
    const d = get("SELECT * FROM bypass_deliveries WHERE id=? AND tenant_id=?", id, t);
    if (!d)
        throw new AppError(404, "Delivery not found");
    const legs = [], blockers = [], links = [];
    const purchases = all("SELECT p.*, s.name supplier, s.client_id sup_client FROM bypass_purchases p JOIN suppliers s ON s.id=p.supplier_id WHERE p.delivery_id=? AND p.voided=0 ORDER BY p.id", id);
    const drops = all(`SELECT x.*, c.name client, w.amount sale_amount, w.id wtx, w.voided wvoided FROM bypass_drops x LEFT JOIN wholesale_clients c ON c.id=x.client_id LEFT JOIN wholesale_txns w ON w.id=x.wtx_id
    WHERE x.delivery_id=? AND x.voided=0 ORDER BY x.id`, id);
    // what this voucher took in and gave out, per fuel — the stock must still hold the difference once it is gone
    const inL = {}, outL = {};
    for (const p of purchases) {
        inL[p.product] = round2((inL[p.product] ?? 0) + p.litres);
        const cf = get("SELECT f.*, c.name client FROM bypass_supplier_payments f LEFT JOIN wholesale_clients c ON c.id=f.client_id WHERE f.ref=? AND f.voided=0", `cfuel:${p.id}`);
        if (cf)
            legs.push({ what: `Client se khareed wapas — ${p.litres} L ${fuel(p.product)} (us ke khate se kati raqam wapas chadhegi)`, party: cf.client, amount: p.amount, litres: p.litres, tone: "khata" });
        else
            legs.push({ what: `Supplier bill mansookh — ${p.litres} L ${fuel(p.product)} @ ${p.cost_rate}`, party: p.supplier, amount: -p.amount, litres: -p.litres, tone: "supplier" });
    }
    for (const x of drops) {
        outL[x.product] = round2((outL[x.product] ?? 0) + x.litres);
        if (x.tank_id) {
            const tank = get("SELECT name, current_l FROM tanks WHERE id=?", x.tank_id);
            legs.push({ what: `Apne tank se wapas — ${x.litres} L ${fuel(x.product)} (${tank?.name ?? "tank"})`, party: null, litres: -x.litres, tone: "tank" });
            if (tank && tank.current_l < x.litres - 0.01)
                blockers.push(`${tank.name} me ab sirf ${Math.round(tank.current_l)} L hai — is voucher ke ${x.litres} L bik chuke hain. Pehle wo sale theek karein.`);
        }
        else {
            legs.push({ what: `Client drop mansookh — ${x.litres} L ${fuel(x.product)} (bill ${pkr(x.sale_amount ?? 0)})`, party: x.client, amount: -(x.sale_amount ?? 0), litres: x.litres, tone: "khata" });
            if (x.wtx && get("SELECT 1 x FROM cashier_vouchers WHERE tenant_id=? AND src=? AND voided=0", t, `wtx:${x.wtx}`))
                blockers.push(`${x.client} ke drop par cashier voucher bana hua hai — pehle wo void karein.`);
        }
    }
    // This voucher's fuel that went out LATER under other vouchers (held stock delivered to a client, or put in our tank):
    // those lines go with it — voiding the supplier's bill takes back every drop made from it, in one go.
    const taken = new Map();
    for (const k of bypassLotState(t).takes)
        if (k.lot_delivery === id && k.out_delivery !== id)
            taken.set(k.out_id, round2((taken.get(k.out_id) ?? 0) + k.litres));
    const cascade = [];
    for (const [dropId] of taken) {
        const x = get(`SELECT x.*, c.name client, w.amount sale_amount, w.id wtx FROM bypass_drops x LEFT JOIN wholesale_clients c ON c.id=x.client_id LEFT JOIN wholesale_txns w ON w.id=x.wtx_id WHERE x.id=? AND x.voided=0`, dropId);
        if (!x)
            continue;
        const label = x.delivery_id ? `BYP-${x.delivery_id}` : `Unload #${x.id}`;
        outL[x.product] = round2((outL[x.product] ?? 0) + x.litres);
        cascade.push({ drop_id: x.id, delivery_id: x.delivery_id ?? null, label });
        links.push({ blocker: -1, kind: x.delivery_id ? "bypass" : "unload", id: x.delivery_id ?? x.id, label, litres: x.litres, date: x.txn_date });
        if (x.tank_id) {
            const tank = get("SELECT name, current_l FROM tanks WHERE id=?", x.tank_id);
            legs.push({ what: `${label} bhi: apne tank se wapas — ${x.litres} L ${fuel(x.product)} (${tank?.name ?? "tank"}) — isi khareed ka maal tha`, party: null, litres: -x.litres, tone: "tank" });
            if (tank && tank.current_l < x.litres - 0.01)
                blockers.push(`${label}: ${tank.name} me ab sirf ${Math.round(tank.current_l)} L hai — is khareed ke ${x.litres} L wahan se bik chuke hain. Pehle wo sale theek karein.`);
        }
        else {
            legs.push({ what: `${label} bhi: client drop mansookh — ${x.litres} L ${fuel(x.product)} (bill ${pkr(x.sale_amount ?? 0)}) — isi khareed ka maal tha`, party: x.client, amount: -(x.sale_amount ?? 0), litres: x.litres, tone: "khata" });
            if (x.wtx && get("SELECT 1 x FROM cashier_vouchers WHERE tenant_id=? AND src=? AND voided=0", t, `wtx:${x.wtx}`))
                blockers.push(`${label}: ${x.client} ke drop par cashier voucher bana hua hai — pehle wo void karein.`);
        }
    }
    for (const p of new Set([...Object.keys(inL), ...Object.keys(outL)])) {
        const after = round2(bypassStock(t, p).litres - (inL[p] ?? 0) + (outL[p] ?? 0));
        if (after < -0.01)
            blockers.push(`${fuel(p)}: is voucher ke baghair bypass stock ${Math.abs(after).toLocaleString()} L minus ho jata hai — Baqi stock tab me "zyada nikla" entries pehle theek karein.`);
        else if (inL[p])
            legs.push({ what: `Bypass stock ${fuel(p)}: ${after.toLocaleString()} L reh jayega`, litres: round2((outL[p] ?? 0) - (inL[p] ?? 0)), tone: "stock" });
    }
    if (!purchases.length && !drops.length)
        blockers.push("Is voucher me koi zinda line nahi (sab pehle hi mansookh).");
    const clients = new Set(drops.filter((x) => !x.tank_id).map((x) => x.client_id)).size, suppliers = new Set(purchases.map((p) => p.supplier_id)).size;
    return { kind: "bypass", id, title: `Voucher BYP-${id}`, date: d.txn_date, legs, blockers, links, cascade, ok: !d.voided && !blockers.length, voided: !!d.voided,
        summary: { clients, suppliers, litres: round2(Object.values(outL).reduce((a, v) => a + v, 0)) } };
}
function bypassReverse(t, by, id, reason, cascade = []) {
    const purchases = all("SELECT * FROM bypass_purchases WHERE delivery_id=? AND voided=0", id);
    const drops = all("SELECT * FROM bypass_drops WHERE delivery_id=? AND voided=0", id);
    // the later drops / unloads made from this voucher's fuel go with it
    for (const c of cascade) {
        const x = get("SELECT * FROM bypass_drops WHERE id=? AND tenant_id=? AND voided=0", c.drop_id, t);
        if (x)
            drops.push(x);
    }
    const tag = ` [voucher void BYP-${id}: ${reason}]`;
    for (const x of drops) {
        run("UPDATE bypass_drops SET voided=1, note=COALESCE(note,'') || ? WHERE id=?", tag, x.id);
        if (x.tank_id) {
            if (x.to_delivery_id)
                run("DELETE FROM deliveries WHERE id=?", x.to_delivery_id);
            run("UPDATE tanks SET current_l = current_l - ? WHERE id=?", x.litres, x.tank_id);
        }
        if (x.wtx_id) {
            run("UPDATE wholesale_txns SET voided=1, void_reason=? WHERE id=? AND voided=0", `${by} (voucher void): ${reason}`, x.wtx_id);
            run("UPDATE wholesale_orders SET status='open', txn_id=NULL, done_at=NULL WHERE tenant_id=? AND txn_id=? AND status='done'", t, x.wtx_id);
        }
    }
    for (const p of purchases) {
        run("UPDATE bypass_purchases SET voided=1 WHERE id=?", p.id);
        for (const s of all("SELECT * FROM bypass_supplier_payments WHERE tenant_id=? AND ref=? AND voided=0", t, `cfuel:${p.id}`)) {
            run("UPDATE bypass_supplier_payments SET voided=1 WHERE id=?", s.id);
            if (s.wtx_id)
                run("UPDATE wholesale_txns SET voided=1, void_reason=? WHERE id=? AND voided=0", `${by} (voucher void): ${reason}`, s.wtx_id);
        }
    }
    run("UPDATE bypass_deliveries SET voided=1, note=COALESCE(note,'') || ? WHERE id=?", tag, id);
    for (const c of cascade)
        if (c.delivery_id && c.delivery_id !== id)
            closeEmptyVoucher(c.delivery_id, tag);
}
/* ------------------------------------------------------------------ tanker trip ------------------------------------------------------------------ */
function tripPlan(t, id) {
    const tr = get("SELECT tr.*, sp.name supplier FROM wholesale_trips tr LEFT JOIN suppliers sp ON sp.id=tr.supplier_id WHERE tr.id=? AND tr.tenant_id=?", id, t);
    if (!tr)
        throw new AppError(404, "Trip not found");
    const legs = [], blockers = [];
    const drops = all("SELECT w.*, c.name client, tk.name tank_name, tk.current_l FROM wholesale_txns w JOIN wholesale_clients c ON c.id=w.client_id LEFT JOIN tanks tk ON tk.id=w.tank_id WHERE w.trip_id=? AND w.voided=0 AND w.type='supply' ORDER BY w.id", id);
    const perTank = {};
    for (const w of drops) {
        legs.push({ what: `Client drop mansookh — ${w.litres} L ${fuel(w.product)} @ ${w.rate}`, party: w.client, amount: -w.amount, litres: w.litres, tone: "khata" });
        if (w.tank_id)
            perTank[w.tank_id] = round2((perTank[w.tank_id] ?? 0) + w.litres);
        if (get("SELECT 1 x FROM cashier_vouchers WHERE tenant_id=? AND src=? AND voided=0", t, `wtx:${w.id}`))
            blockers.push(`${w.client} ke drop par cashier voucher bana hua hai — pehle wo void karein.`);
    }
    for (const [tk, l] of Object.entries(perTank)) {
        const tank = get("SELECT name, capacity_l, current_l FROM tanks WHERE id=?", Number(tk));
        legs.push({ what: `Tank me wapas — ${l} L (${tank.name})`, litres: l, tone: "tank" });
        if (tank.current_l + l > tank.capacity_l * 1.001)
            blockers.push(`${tank.name} me ${l} L wapas nahi samata (capacity ${Math.round(tank.capacity_l)} L, ab ${Math.round(tank.current_l)} L).`);
    }
    for (const p of all("SELECT * FROM supplier_txns WHERE trip_id=? AND type='purchase'", id))
        legs.push({ what: p.product ? `Depot bill mansookh — ${p.litres} L ${fuel(p.product)} @ ${p.rate}` : "Depot freight (bill par) mansookh", party: tr.supplier, amount: -p.amount, litres: p.product ? -p.litres : null, tone: "supplier" });
    for (const c of all("SELECT * FROM shortage_claims WHERE trip_id=?", id)) {
        if ((c.recovered ?? 0) > 0 || c.status === "recovered")
            blockers.push(`Shortage claim #${c.id} (${pkr(c.amount)}) recover ho chuka hai — pehle usay dekhein.`);
        else
            legs.push({ what: `Shortage claim #${c.id} hat jayega`, party: tr.supplier, amount: -c.amount, tone: "other" });
    }
    for (const e of all("SELECT e.*, sh.status shift_status FROM expenses e LEFT JOIN shifts sh ON sh.id=e.shift_id WHERE e.tenant_id=? AND e.note LIKE ? AND e.status<>'rejected'", t, `Trip #${id} —%`)) {
        legs.push({ what: `Kiraya (cash) kharcha wapas`, amount: e.amount, tone: "cash" });
        if (e.shift_status === "closed")
            blockers.push(`Kiraya ka kharcha band shift ka hai — cash wapas nahi ho sakta. Pehle shift ki correction karein.`);
    }
    if (!drops.length)
        blockers.push("Is trip me koi zinda drop nahi (sab pehle hi mansookh).");
    return { kind: "trip", id, title: `Tanker trip #${id}`, date: tr.trip_date, legs, blockers, ok: !tr.voided && !blockers.length, voided: !!tr.voided,
        summary: { clients: new Set(drops.map((w) => w.client_id)).size, suppliers: tr.supplier_id ? 1 : 0, litres: round2(drops.reduce((a, w) => a + w.litres, 0)) } };
}
function tripReverse(t, by, id, reason) {
    for (const w of all("SELECT * FROM wholesale_txns WHERE trip_id=? AND voided=0 AND type='supply'", id)) {
        if (w.tank_id && w.litres)
            run("UPDATE tanks SET current_l = current_l + ? WHERE id=?", w.litres, w.tank_id);
        run("UPDATE wholesale_txns SET voided=1, void_reason=? WHERE id=?", `${by} (voucher void): ${reason}`, w.id);
        run("UPDATE wholesale_orders SET status='open', txn_id=NULL, done_at=NULL WHERE tenant_id=? AND txn_id=? AND status='done'", t, w.id);
    }
    for (const p of all("SELECT id FROM supplier_txns WHERE tenant_id=? AND trip_id=? AND type='purchase'", t, id))
        dropClientFuelSettlement(t, p.id, `${by} (voucher void): ${reason}`);
    run("DELETE FROM supplier_txns WHERE tenant_id=? AND trip_id=? AND type='purchase'", t, id);
    run("DELETE FROM shortage_claims WHERE tenant_id=? AND trip_id=?", t, id);
    run("DELETE FROM expenses WHERE tenant_id=? AND note LIKE ? AND status<>'rejected'", t, `Trip #${id} —%`);
    run("UPDATE wholesale_trips SET voided=1, void_reason=?, voided_by=?, voided_at=? WHERE id=?", reason, by, now(), id);
}
/* ------------------------------------------------------------------ routes ------------------------------------------------------------------ */
export function voucherPlan(t, kind, id) { return kind === "trip" ? tripPlan(t, id) : bypassPlan(t, id); }
const kindParam = z.enum(["trip", "bypass"]);
vouchers.get("/vouchers/:kind/:id/plan", requirePerm("wholesale.void"), h((req) => voucherPlan(tid(req), kindParam.parse(req.params.kind), Number(req.params.id))));
vouchers.post("/vouchers/:kind/:id/void", requirePerm("wholesale.void"), h((req) => {
    const t = tid(req), kind = kindParam.parse(req.params.kind), id = Number(req.params.id);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, "Wajah likhein (kam se kam 3 harf)").max(200) }), req.body);
    const plan = voucherPlan(t, kind, id);
    if (plan.voided)
        throw new AppError(400, "Ye voucher pehle hi mansookh hai");
    if (!plan.ok)
        throw new AppError(400, `Mansookh nahi ho sakta: ${plan.blockers[0]}`);
    tx(() => { if (kind === "trip")
        tripReverse(t, req.user.name, id, reason);
    else
        bypassReverse(t, req.user.name, id, reason, plan.cascade ?? []); });
    audit(t, req.user, "voucher_void", `${kind}:${id}`, { reason, legs: plan.legs.length, summary: plan.summary });
    createAlert(t, { type: "wholesale_void", severity: "info", title: `${plan.title} poora mansookh — ${req.user.name}`, body: `${plan.summary.clients} client, ${plan.summary.litres.toLocaleString()} L. Wajah: ${reason}` });
    return { ok: true, plan };
}));
/* ------------------------------------------------------------------ find by ID ------------------------------------------------------------------ */
/** Every wholesale entry has a number; type it and get the entry: BYP-185 (depot / balance-stock / unload voucher),
 *  WS- / WR- / CN- / JV- (a client's supply, receipt, return, journal; RV- is the cashier's receipt voucher), TRIP-12 (tanker trip from our tank),
 *  BP-40 (one supplier bill line), SP-7 (a payment to a bypass supplier). A bare number is tried against all of them.
 *  Mansookh entries are found too (marked voided) — nothing disappears. */
vouchers.get("/vouchers/find", requirePerm("wholesale.manage"), h((req) => {
    const t = tid(req);
    const raw = parse(z.object({ q: z.string().trim().min(1).max(40) }), req.query).q.replace(/^#/, "").toUpperCase().replace(/\s+/g, "");
    const m = raw.match(/^([A-Z]+)?-?(\d+)$/);
    if (!m)
        return { q: raw, results: [] };
    const pre = m[1] ?? "", n = Number(m[2]);
    const want = (...p) => !pre || p.includes(pre);
    const out = [];
    if (want("BYP", "DEL", "UNL")) {
        const d = get(`SELECT d.*, (SELECT COALESCE(SUM(litres),0) FROM bypass_purchases WHERE delivery_id=d.id) bought, (SELECT COALESCE(SUM(litres),0) FROM bypass_drops WHERE delivery_id=d.id AND tank_id IS NULL) dropped,
        (SELECT COALESCE(SUM(litres),0) FROM bypass_drops WHERE delivery_id=d.id AND tank_id IS NOT NULL) unloaded,
        (SELECT GROUP_CONCAT(DISTINCT c.name) FROM bypass_drops x JOIN wholesale_clients c ON c.id=x.client_id WHERE x.delivery_id=d.id) clients,
        (SELECT GROUP_CONCAT(DISTINCT s.name) FROM bypass_purchases p JOIN suppliers s ON s.id=p.supplier_id WHERE p.delivery_id=d.id) sups
      FROM bypass_deliveries d WHERE d.id=? AND d.tenant_id=?`, n, t);
        if (d)
            out.push({ kind: d.kind === "unload" ? "Tank unload" : d.bought > 0 ? "Depot bypass" : "Balance stock delivery", id: d.id, no: `BYP-${d.id}`, date: d.txn_date, voided: !!d.voided,
                title: [d.bought ? `khareeda ${d.bought} L` : "", d.dropped ? `client ko ${d.dropped} L` : "", d.unloaded ? `apne tank ${d.unloaded} L` : "", d.vehicle_no].filter(Boolean).join(" · "),
                litres: d.bought || d.dropped || d.unloaded, party: [d.sups, d.clients].filter(Boolean).join(" → ") || null, open: { type: "bypass", id: d.id } });
    }
    if (want("WS", "WR", "RV", "CN", "JV")) {
        for (const w of all(`SELECT w.*, c.name client FROM wholesale_txns w JOIN wholesale_clients c ON c.id=w.client_id WHERE w.tenant_id=? AND (w.id=? OR w.voucher_no=?) ORDER BY w.id LIMIT 12`, t, n, `${pre || "WS"}-${n}`)) {
            const no = w.voucher_no ?? `${w.type === "supply" ? "WS" : w.type === "payment" ? "WR" : w.type === "return" ? "CN" : "JV"}-${w.id}`;
            if (pre && !no.startsWith((pre === "RV" ? "WR" : pre) + "-"))
                continue; // an old printed RV-89 still finds the payment
            out.push({ kind: w.type === "supply" ? "Client supply" : w.type === "payment" ? "Client payment" : w.type === "return" ? "Return" : w.type === "carriage" ? "Kiraya" : "Adjustment", id: w.id, no, date: w.txn_date, voided: !!w.voided,
                title: [w.litres ? `${w.litres} L ${fuel(w.product)}` : "", w.method, w.vehicle_no, w.ref].filter(Boolean).join(" · "), amount: w.amount, litres: w.litres, party: w.client, open: { type: "wtx", id: w.id, client_id: w.client_id } });
        }
    }
    if (want("TRIP", "T")) {
        const tr = get("SELECT * FROM wholesale_trips WHERE id=? AND tenant_id=?", n, t);
        if (tr)
            out.push({ kind: "Tanker trip", id: tr.id, no: `TRIP-${tr.id}`, date: tr.trip_date, voided: !!tr.voided, title: [`${tr.litres} L ${fuel(tr.product)}`, `${tr.drops} drop`, tr.vehicle_no].filter(Boolean).join(" · "), amount: tr.amount, litres: tr.litres, party: null, open: { type: "trip", id: tr.id } });
    }
    if (want("BP")) {
        const p = get("SELECT p.*, s.name supplier FROM bypass_purchases p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=? AND p.tenant_id=?", n, t);
        if (p)
            out.push({ kind: "Supplier bill (bypass)", id: p.id, no: `BP-${p.id}`, date: p.txn_date, voided: !!p.voided, title: `${p.litres} L ${fuel(p.product)} @ ${p.cost_rate}${p.delivery_id ? ` · BYP-${p.delivery_id}` : ""}`, amount: p.amount, litres: p.litres, party: p.supplier,
                open: p.delivery_id ? { type: "bypass", id: p.delivery_id } : { type: "supplier", id: p.id, supplier_id: p.supplier_id } });
    }
    if (want("SP")) {
        const p = get("SELECT p.*, s.name supplier FROM bypass_supplier_payments p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=? AND p.tenant_id=?", n, t);
        if (p)
            out.push({ kind: "Supplier payment (bypass)", id: p.id, no: `SP-${p.id}`, date: p.txn_date, voided: !!p.voided, title: [p.mode, p.method, p.ref].filter(Boolean).join(" · "), amount: p.amount, party: p.supplier, open: { type: "supplier", id: p.id, supplier_id: p.supplier_id } });
    }
    return { q: raw, results: out };
}));
