/**
 * Gari statement (vehicle statement): one vehicle's entries in one party's account over a date range — every fuel /
 * item line, its litres and rate, the debit and credit, and totals by item. Customers ask for it: "Gari LEH-453 ki
 * 1 se 30 tareekh tak kitna tail, kitni entries, kitni raqam".
 *   khata     — a khata customer's khata lines carrying that vehicle (parchi, POS credit sale, a payment with the gaari)
 *   wholesale — a wholesale client's supplies / returns / kiraya / payments with that vehicle
 *   supplier  — a supplier's purchases that came in that tanker (the delivery's tanker no.)
 * Vehicle numbers match loosely: "LEH-453", "leh 453" and "LEH453" are one gaari. Read-only: nothing is written.
 */
import { all, get, pkStart, pkEnd } from "./db.js";
import { khataStatement } from "./routes/crm.js";
import { statement as wholesaleStatement } from "./routes/wholesale.js";
import { PRODUCTS } from "./config.js";
import { AppError, round2 } from "./services.js";

export type VParty = "khata" | "wholesale" | "supplier";
export type VLine = { id: number | string; at: string; no: string; slip: string | null; vehicle: string | null; item: string; product: string | null; litres: number | null; rate: number | null; debit: number; credit: number; note: string | null; running: number };

export const plateKey = (v: string | null | undefined) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const SQL_KEY = (col: string) => `REPLACE(REPLACE(REPLACE(UPPER(${col}),'-',''),' ',''),'.','')`;
const clean = (s: string | null | undefined) => String(s ?? "").replace(/[^\x20-\x7E]+/g, "").replace(/\s+·\s+·/g, " ·").replace(/^\s*·\s*/, "").trim();

/** The vehicles this party has entries for (plus a khata customer's saved gaariyan), most used first. */
export function partyVehicles(t: number, party: VParty, id: number): { vehicle: string; entries: number }[] {
  let rows: { vehicle: string; entries: number }[] = [];
  if (party === "khata") {
    if (!get("SELECT id FROM customers WHERE id=? AND tenant_id=?", id, t)) throw new AppError(404, "Customer not found");
    rows = all("SELECT vehicle_no vehicle, COUNT(*) entries FROM khata_ledger WHERE customer_id=? AND vehicle_no IS NOT NULL AND TRIM(vehicle_no)<>'' GROUP BY vehicle_no", id) as any;
    for (const v of all("SELECT plate_no FROM vehicles WHERE customer_id=?", id)) rows.push({ vehicle: v.plate_no as string, entries: 0 });
  } else if (party === "wholesale") {
    if (!get("SELECT id FROM wholesale_clients WHERE id=? AND tenant_id=?", id, t)) throw new AppError(404, "Client not found");
    rows = all("SELECT vehicle_no vehicle, COUNT(*) entries FROM wholesale_txns WHERE client_id=? AND voided=0 AND vehicle_no IS NOT NULL AND TRIM(vehicle_no)<>'' GROUP BY vehicle_no", id) as any;
  } else {
    if (!get("SELECT id FROM suppliers WHERE id=? AND tenant_id=?", id, t)) throw new AppError(404, "Supplier not found");
    rows = all(`SELECT d.tanker_no vehicle, COUNT(*) entries FROM supplier_txns x JOIN deliveries d ON d.id=x.delivery_id
      WHERE x.supplier_id=? AND d.tanker_no IS NOT NULL AND TRIM(d.tanker_no)<>'' GROUP BY d.tanker_no`, id) as any;
  }
  const m = new Map<string, { vehicle: string; entries: number }>();
  for (const r of rows) { const k = plateKey(r.vehicle); if (!k) continue; const o = m.get(k); if (o) o.entries += r.entries; else m.set(k, { vehicle: String(r.vehicle).trim().toUpperCase(), entries: r.entries }); }
  return [...m.values()].sort((a, b) => b.entries - a.entries || a.vehicle.localeCompare(b.vehicle));
}

export function vehicleStatement(t: number, party: VParty, id: number, vehicle: string, from?: string, to?: string) {
  const key = plateKey(vehicle);
  if (key.length < 2) throw new AppError(400, "Gaari no. chunein");
  let name = "", phone: string | null = null, extra = "";
  let raw: Omit<VLine, "running">[] = [];
  if (party === "khata") {
    const s = khataStatement(t, id, from, to);
    name = s.customer.name; phone = s.customer.phone;
    raw = s.lines.filter((l: any) => plateKey(l.vehicle_no) === key).map((l: any) => {
      const parchi = /^(PR-|PARCHI-)/.test(String(l.ref ?? ""));
      // a parchi keeps its litres / item on the parchi line (never in the khata litres column)
      const pl = parchi ? get("SELECT kind, product, item_name, qty, rate FROM parchi_lines WHERE khata_id=?", l.id) : null;
      if (pl?.kind === "fuel") return { id: l.id, at: l.created_at, no: l.ref, slip: l.slip_no ?? null, vehicle: l.vehicle_no, item: `Parchi ${PRODUCTS[pl.product as string] ?? pl.product}`,
        product: pl.product as string, litres: pl.qty as number, rate: pl.rate as number, debit: l.amount, credit: 0, note: null };
      if (pl?.kind === "shop") return { id: l.id, at: l.created_at, no: l.ref, slip: l.slip_no ?? null, vehicle: l.vehicle_no, item: `Parchi: ${pl.item_name} x ${pl.qty} @ ${pl.rate}`,
        product: null, litres: null, rate: null, debit: l.amount, credit: 0, note: null };
      const item = l.type === "credit" ? "Payment received" : l.product ? (PRODUCTS[l.product] ?? l.product)
        : parchi ? `Parchi: ${clean(String(l.note ?? "").replace(/^.*?Parchi\s*·\s*/, ""))}` : clean(l.note) || "Charge";
      return { id: l.id, at: l.created_at, no: l.ref && /^(PR|SALE|SHOP)-/i.test(l.ref) ? l.ref : `K-${l.id}`, slip: l.slip_no ?? null, vehicle: l.vehicle_no, item,
        product: l.product ?? null, litres: l.litres ?? null, rate: l.rate ?? (l.litres ? round2(l.amount / l.litres) : null),
        debit: l.type === "debit" ? l.amount : 0, credit: l.type === "credit" ? l.amount : 0, note: l.type === "credit" ? clean(l.ref) || null : null };
    });
  } else if (party === "wholesale") {
    const s = wholesaleStatement(t, id, from, to);
    name = s.client.name; phone = s.client.phone; extra = s.client.business_name ?? "";
    const lbl: Record<string, string> = { supply: "Fuel supplied", return: "Returned", payment: "Payment received", adjustment: "Adjustment", carriage: "Kiraya" };
    raw = s.lines.filter((l: any) => l.type !== "fuel_note" && !l.voided && plateKey(l.vehicle_no) === key).map((l: any) => ({
      id: l.id, at: l.txn_date, no: l.voucher_no ?? `${l.type === "supply" ? "WS" : l.type === "return" ? "CN" : l.type === "payment" ? "RV" : "JV"}-${l.id}`, slip: l.ref ?? null, vehicle: l.vehicle_no,
      item: `${lbl[l.type] ?? l.type}${l.product ? ` ${PRODUCTS[l.product] ?? l.product}` : ""}`, product: l.product ?? null,
      litres: l.litres ? (l.type === "return" ? -l.litres : l.litres) : null, rate: l.rate ?? null, debit: l.debit, credit: l.credit, note: clean(l.note) || null }));
  } else {
    const s = get("SELECT * FROM suppliers WHERE id=? AND tenant_id=?", id, t);
    if (!s) throw new AppError(404, "Supplier not found");
    name = s.name as string; phone = (s.phone as string) ?? null; extra = (s.company as string) ?? "";
    raw = all(`SELECT x.*, d.tanker_no FROM supplier_txns x JOIN deliveries d ON d.id=x.delivery_id WHERE x.supplier_id=? AND ${SQL_KEY("d.tanker_no")}=?
        ${from ? "AND x.txn_date >= ?" : ""} ${to ? "AND x.txn_date < ?" : ""} ORDER BY x.txn_date, x.id`, ...[s.id, key, ...(from ? [pkStart(from)] : []), ...(to ? [pkEnd(to)] : [])])
      .map((x) => { const e = x.type === "payment" ? -x.amount : x.amount; return { id: x.id, at: x.txn_date, no: `PU-${x.id}`, slip: x.ref ?? null, vehicle: x.tanker_no,
        item: `${x.type === "purchase" ? "Purchase" : x.type === "payment" ? "Paid" : "Adjustment"}${x.product ? ` ${PRODUCTS[x.product] ?? x.product}` : ""}`, product: x.product ?? null,
        litres: x.litres ?? null, rate: x.rate ?? null, debit: e > 0 ? e : 0, credit: e < 0 ? -e : 0, note: clean(x.note) || null }; });
  }
  raw.sort((a, b) => String(a.at).localeCompare(String(b.at)) || Number(a.id) - Number(b.id));
  let run = 0;
  const lines: VLine[] = raw.map((l) => { run = round2(run + l.debit - l.credit); return { ...l, running: run }; });
  const by: Record<string, { item: string; entries: number; litres: number; amount: number }> = {};
  for (const l of lines.filter((x) => x.debit > 0 || (x.litres ?? 0) < 0)) {
    const item = l.product ? (PRODUCTS[l.product] ?? l.product) : l.item.startsWith("Parchi") ? "Parchi (shop / other)" : l.item;
    by[item] ??= { item, entries: 0, litres: 0, amount: 0 };
    by[item].entries++; by[item].litres = round2(by[item].litres + (l.litres ?? 0)); by[item].amount = round2(by[item].amount + l.debit - (l.debit ? 0 : l.credit));
  }
  const debit = round2(lines.reduce((a, l) => a + l.debit, 0)), credit = round2(lines.reduce((a, l) => a + l.credit, 0));
  return {
    party: { type: party, id, name, phone, extra }, vehicle: vehicle.trim().toUpperCase(), from: from ?? null, to: to ?? null, lines,
    totals: { entries: lines.length, litres: round2(lines.reduce((a, l) => a + (l.product ? (l.litres ?? 0) : 0), 0)), debit, credit, net: round2(debit - credit),
      by_item: Object.values(by).sort((a, b) => b.amount - a.amount), first: lines[0]?.at ?? null, last: lines[lines.length - 1]?.at ?? null },
  };
}
