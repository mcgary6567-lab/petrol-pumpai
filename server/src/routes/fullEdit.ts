/**
 * CEO "full edit" of one money entry — party, kind, date, amount (litres × rate), method / bank account, ref, note, vehicle, slip —
 * from the party's own page (khata customer, wholesale client, supplier, thekedar) or a cashier voucher.
 *
 * Mechanics, the same for every kind: the old row is reversed (deleted where the table has no `voided`, voided otherwise) and a fresh
 * row is posted with the corrected values on the chosen party and day. Balances, the cash book, bank legs and the derived ledger all
 * follow from the rows, so nothing is counted twice; the audit log keeps before / after / reason. A cashier voucher that mirrors the
 * row is moved along with it (party, amount, method, source, day).
 *
 * Rows other flows own (a POS sale's khata line, an opening balance, a tanker-trip supply, a depot-direct leg, a delivery purchase,
 * a withholding-tax sibling, a cheque, a CEO other-entry) are refused with a pointer to their own editor.
 * A bypass drop (client supply of a bypass delivery) IS edited here: client, day, litres, rate, ref, note and vehicle change, and its
 * bypass_drops row follows (litres at the same unit cost); fuel and kind stay fixed and extra litres must fit in the bypass stock.
 */
import { Router } from "express";
import { z } from "zod";
import { all, get, run, tx, now, pkDate, stampFor, type Row } from "../db.js";
import { h, parse, tid, requirePerm } from "../auth.js";
import { AppError, round2, khataEntry, audit } from "../services.js";
import { bankAccountFor, DEPOT_PAY, BYPASS_PAY } from "./banks.js";
import { insertTxn, clientDue, clientDueAll } from "./wholesale.js";
import { supplierOwed, supplierOwedAll } from "./suppliers.js";
import { thekedarDue, thekedarDueAll } from "./carriage.js";
import { bypassStock } from "./bypass.js";
import { PRODUCTS } from "../config.js";

export const fullEdit = Router();

const KINDS = ["khata", "wholesale", "supplier", "carriage", "voucher"] as const;
type Kind = (typeof KINDS)[number];
const kindParam = z.enum(KINDS);
const isCashMethod = (m: string | null | undefined) => !m || /^cash$/i.test(m.trim());
const dayOf = (iso: string) => pkDate(Date.parse(iso));

/** Which editor a row belongs to, or null when this one may change it. */
function lockedWhy(t: number, kind: Kind, x: Row): string | null {
  const ref = String(x.ref ?? "");
  if (kind === "khata") {
    if (ref.startsWith("SALE-") || x.product) return "Ye POS sale ki khata line hai — Sale edit se badlein (customer, litre, rate, gaari wahan badalte hain).";
    if (ref.startsWith("SHOP-")) return "Ye shop sale ki khata line hai — Shop page se sale edit karein.";
    if (ref.startsWith("oth-")) return "Ye Other-entries (CEO) ki entry hai — Other entries page se badlein.";
    if (ref === "open:") return "Ye opening balance hai — Opening balances page se badlein.";
    if (ref.startsWith("LATE-")) return "Ye late-payment charge hai — Customer care se hatayein.";
  }
  if (kind === "wholesale") {
    if (x.trip_id) return "Ye tanker-trip (bulk) ki entry hai — trip wholesale page se badlein.";
    if (x.sale_id) return "Ye POS par bechi gayi wholesale sale hai — Sale edit se badlein.";
    if (ref.startsWith("oth-")) return "Ye Other-entries (CEO) ki entry hai — wahin se badlein.";
    if (get("SELECT 1 FROM bypass_supplier_payments WHERE tenant_id=? AND wtx_id=? AND voided=0", t, x.id)) return "Is par bypass supplier payment judi hai — Bypass page se void karein.";
    if (x.method === DEPOT_PAY || x.method === BYPASS_PAY || get("SELECT 1 FROM supplier_txns WHERE tenant_id=? AND ref=?", t, `wtx:${x.id}`)) return "Ye depot-direct payment hai — void karke dobara daalein.";
    if (x.type === "carriage") return "Ye kiraya entry hai — thekedar page se badlein.";
  }
  if (kind === "supplier") {
    if (x.method === "WHT") return "Ye withholding-tax ka hissa hai — asal payment edit karein.";
    if (x.delivery_id) return "Ye tanker delivery ki purchase hai — Delivery edit se badlein.";
    if (x.trip_id) return "Ye depot-direct trip ki purchase hai — trip se badlein.";
    if (ref.startsWith("wtx:")) return "Ye wholesale client ki depot-direct payment ka hissa hai — wholesale payment se badlein.";
    if (ref.startsWith("claim:")) return "Ye shortage claim ki credit note hai — Claims page se badlein.";
    if (ref.startsWith("shopbuy:")) return "Ye shop ke maal ki kharidari hai — Shop page se dekhein.";
    if (x.type === "payment" && get("SELECT 1 FROM supplier_txns WHERE tenant_id=? AND supplier_id=? AND method='WHT' AND txn_date=? AND id<>?", t, x.supplier_id, x.txn_date, x.id))
      return "Is payment par withholding tax laga hai — ise void karke dobara daalein.";
  }
  if (kind === "carriage") {
    if (ref.startsWith("oth-")) return "Ye Other-entries (CEO) ki entry hai — wahin se badlein.";
  }
  return null;
}

/** The live bypass drop a wholesale supply row belongs to (null for an ordinary supply). */
const dropOf = (t: number, kind: Kind, wtxId: number) =>
  kind === "wholesale" ? get("SELECT * FROM bypass_drops WHERE tenant_id=? AND wtx_id=? AND voided=0 AND tank_id IS NULL", t, wtxId) ?? null : null;

/** The row behind a kind + id, with the fields every kind shares. */
function load(t: number, kind: Kind, id: number) {
  if (kind === "khata") {
    const x = get("SELECT k.*, c.name party_name, c.tenant_id FROM khata_ledger k JOIN customers c ON c.id=k.customer_id WHERE k.id=? AND c.tenant_id=?", id, t);
    // an "advance wapas" refund is a debit whose ref is "refund:<method>" and which actually pays cash/bank out — treat it
    // as a money row (method + account) so the method can be viewed and changed, just like a payment
    const refund = Boolean(x && x.type === "debit" && String(x.ref ?? "").startsWith("refund:"));
    return x && { x, party_id: x.customer_id as number, party_name: x.party_name as string, type: x.type as string, txn_date: x.created_at as string, amount: x.amount as number,
      litres: x.litres ?? null, rate: x.rate ?? null, product: x.product ?? null,
      method: x.type === "credit" ? (x.ref ?? null) : refund ? (String(x.ref).slice("refund:".length) || "Cash") : null, account_id: x.account_id ?? null,
      ref: x.type === "credit" || refund ? null : (x.ref ?? null), note: x.note ?? null, vehicle_no: x.vehicle_no ?? null, slip_no: x.slip_no ?? null, created_by: null, voided: false, is_refund: refund };
  }
  if (kind === "wholesale") {
    const x = get("SELECT w.*, c.name party_name FROM wholesale_txns w JOIN wholesale_clients c ON c.id=w.client_id WHERE w.id=? AND w.tenant_id=?", id, t);
    return x && { x, party_id: x.client_id as number, party_name: x.party_name as string, type: x.type as string, txn_date: x.txn_date as string, amount: x.amount as number,
      litres: x.litres ?? null, rate: x.rate ?? null, product: x.product ?? null, method: x.method ?? null, account_id: x.account_id ?? null, ref: x.ref ?? null, note: x.note ?? null,
      vehicle_no: x.vehicle_no ?? null, slip_no: null, created_by: x.created_by ?? null, voided: Boolean(x.voided) };
  }
  if (kind === "supplier") {
    const x = get("SELECT x.*, s.name party_name FROM supplier_txns x JOIN suppliers s ON s.id=x.supplier_id WHERE x.id=? AND x.tenant_id=?", id, t);
    return x && { x, party_id: x.supplier_id as number, party_name: x.party_name as string, type: x.type as string, txn_date: x.txn_date as string, amount: x.amount as number,
      litres: x.litres ?? null, rate: x.rate ?? null, product: x.product ?? null, method: x.method ?? null, account_id: x.account_id ?? null, ref: x.ref ?? null, note: x.note ?? null,
      vehicle_no: null, slip_no: null, created_by: x.created_by ?? null, voided: false };
  }
  if (kind === "carriage") {
    const x = get("SELECT x.*, k.name party_name FROM carriage_txns x JOIN thekedars k ON k.id=x.thekedar_id WHERE x.id=? AND x.tenant_id=?", id, t);
    return x && { x, party_id: x.thekedar_id as number, party_name: x.party_name as string, type: x.type as string, txn_date: x.txn_date as string, amount: x.amount as number,
      litres: x.litres ?? null, rate: null, product: x.product ?? null, method: x.method ?? null, account_id: x.account_id ?? null, ref: x.ref ?? null, note: x.note ?? null,
      vehicle_no: x.vehicle_no ?? null, slip_no: null, created_by: x.created_by ?? null, voided: Boolean(x.voided) };
  }
  return null;
}

/** A cashier voucher resolves to the source row it mirrors (khata / wholesale / supplier payment). */
function voucherSource(t: number, voucherId: number): { kind: Kind; id: number; voucher: Row } {
  const v = get("SELECT * FROM cashier_vouchers WHERE id=? AND tenant_id=?", voucherId, t);
  if (!v) throw new AppError(404, "Voucher nahi mila");
  if (v.voided) throw new AppError(400, "Ye voucher void ho chuka hai");
  const [k, idStr] = String(v.src ?? "").split(":");
  const map: Record<string, Kind> = { khata: "khata", wtx: "wholesale", stx: "supplier" };
  if (!map[k]) throw new AppError(400, "Is voucher ki poori edit yahan se nahi — Cashier desk ke Edit se amount / method badlein, ya void karke dobara banayein.");
  return { kind: map[k], id: Number(idStr), voucher: v };
}

const SRC: Record<Kind, string> = { khata: "khata", wholesale: "wtx", supplier: "stx", carriage: "ctx", voucher: "" };
const partyLabel: Record<Kind, string> = { khata: "Khata customer", wholesale: "Wholesale client", supplier: "Supplier", carriage: "Thekedar", voucher: "" };
function parties(t: number, kind: Kind) {
  if (kind === "khata") return all("SELECT id, name, phone, balance FROM customers WHERE tenant_id=? AND active=1 ORDER BY name", t).map((c) => ({ id: c.id, name: c.name, sub: c.phone ?? "", balance: round2(c.balance) }));
  if (kind === "wholesale") { const d = clientDueAll(t); return all("SELECT id, name, business_name, phone FROM wholesale_clients WHERE tenant_id=? AND active=1 ORDER BY name", t).map((c) => ({ id: c.id, name: c.name, sub: [c.business_name, c.phone].filter(Boolean).join(" · "), balance: d.get(c.id) ?? 0 })); }
  if (kind === "supplier") { const d = supplierOwedAll(t); return all("SELECT id, name, company, phone FROM suppliers WHERE tenant_id=? AND COALESCE(active,1)=1 ORDER BY company, name", t).map((s) => ({ id: s.id, name: [s.company, s.name].filter(Boolean).join(" — "), sub: s.phone ?? "", balance: d.get(s.id) ?? 0 })); }
  if (kind === "carriage") { const d = thekedarDueAll(t); return all("SELECT id, name, phone FROM thekedars WHERE tenant_id=? AND active=1 ORDER BY name", t).map((k) => ({ id: k.id, name: k.name, sub: k.phone ?? "", balance: d.get(k.id) ?? 0 })); }
  return [];
}
const TYPES: Record<Kind, [string, string][]> = {
  khata: [["debit", "Charge (customer par chadhao)"], ["credit", "Payment (customer ne diya)"]],
  wholesale: [["supply", "Supply (fuel diya)"], ["return", "Return (fuel wapas)"], ["payment", "Payment (client ne diya)"], ["adjustment", "Adjustment"]],
  supplier: [["purchase", "Purchase (maal liya)"], ["payment", "Payment (supplier ko diya)"], ["adjustment", "Adjustment"]],
  carriage: [["carriage", "Kiraya (thekedar par)"], ["payment", "Payment (thekedar ne diya)"], ["adjustment", "Adjustment"]],
  voucher: [],
};

/** Everything the modal needs: the entry, who else it could belong to, what may change. */
fullEdit.get("/corrections/entry/:kind/:id", requirePerm("entries.edit"), h((req) => {
  const t = tid(req);
  let kind = kindParam.parse(req.params.kind); let id = Number(req.params.id); let voucher: Row | null = null;
  if (kind === "voucher") { const s = voucherSource(t, id); kind = s.kind; id = s.id; voucher = s.voucher; }
  if (!voucher) voucher = get("SELECT * FROM cashier_vouchers WHERE tenant_id=? AND src=? AND voided=0", t, `${SRC[kind]}:${id}`) ?? null;
  const e = load(t, kind, id);
  if (!e) throw new AppError(404, "Entry nahi mili");
  if (e.voided) throw new AppError(400, "Ye entry pehle hi void hai");
  const locked = lockedWhy(t, kind, e.x);
  const { x, ...entry } = e;
  const hasMoney = (kind === "khata" && (entry.type === "credit" || (entry as { is_refund?: boolean }).is_refund)) || entry.type === "payment";
  return {
    kind, id, party_label: partyLabel[kind], entry: { ...entry, day: dayOf(entry.txn_date), has_litres: kind !== "khata" && (entry.type === "supply" || entry.type === "return" || entry.type === "purchase" || entry.type === "carriage"), has_money: hasMoney, tank_id: x.tank_id ?? null },
    voucher: voucher ? { id: voucher.id, no: `CV-${String(voucher.id).padStart(5, "0")}` } : null,
    parties: parties(t, kind), types: TYPES[kind], products: Object.entries(PRODUCTS).map(([k, v]) => ({ key: k, label: v })),
    accounts: all("SELECT id, bank, title, account_no FROM bank_accounts WHERE tenant_id=? AND active=1 ORDER BY bank", t).map((a) => ({ id: a.id, label: `${a.bank}${a.title ? ` · ${a.title}` : ""}${a.account_no ? ` ·${String(a.account_no).slice(-4)}` : ""}` })),
    locked, created_by: entry.created_by,
    bypass_drop: (() => { const d = dropOf(t, kind, id); return d ? { delivery_id: d.delivery_id, litres: d.litres, stock_litres: bypassStock(t, d.product).litres } : null; })(),
  };
}));

const body = z.object({
  reason: z.string().trim().min(3, "Wajah likhein (kam se kam 3 harf)"),
  party_id: z.number().int().positive().optional(), type: z.string().max(20).optional(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  amount: z.number().max(1_000_000_000).optional(), litres: z.number().positive().max(10_000_000).nullable().optional(), rate: z.number().positive().max(100000).nullable().optional(),
  product: z.string().max(20).nullable().optional(), method: z.string().max(40).nullable().optional(), account_id: z.number().int().positive().nullable().optional(),
  ref: z.string().max(120).nullable().optional(), note: z.string().max(200).nullable().optional(), vehicle_no: z.string().max(40).nullable().optional(), slip_no: z.string().max(40).nullable().optional(),
});

fullEdit.post("/corrections/entry/:kind/:id/full-edit", requirePerm("entries.edit"), h((req) => {
  const t = tid(req);
  const b = parse(body, req.body);
  let kind = kindParam.parse(req.params.kind); let id = Number(req.params.id); let voucher: Row | null = null;
  if (kind === "voucher") { const s = voucherSource(t, id); kind = s.kind; id = s.id; voucher = s.voucher; }
  if (!voucher) voucher = get("SELECT * FROM cashier_vouchers WHERE tenant_id=? AND src=? AND voided=0", t, `${SRC[kind]}:${id}`) ?? null;
  const e = load(t, kind, id);
  if (!e) throw new AppError(404, "Entry nahi mili");
  if (e.voided) throw new AppError(400, "Ye entry pehle hi void hai");
  { const why = lockedWhy(t, kind, e.x); if (why) throw new AppError(400, why); }
  const x = e.x;
  const who = req.user!.name;

  // ---- the corrected values ----
  const type = b.type ?? e.type;
  if (!TYPES[kind].some(([k]) => k === type)) throw new AppError(400, "Kism theek nahi");
  const partyId = b.party_id ?? e.party_id;
  const party = parties(t, kind).find((p) => p.id === partyId);
  if (!party) throw new AppError(400, `${partyLabel[kind]} nahi mila`);
  const oldDay = dayOf(e.txn_date);
  const day = b.day ?? oldDay;
  if (day > pkDate()) throw new AppError(400, "Aane wali tareekh nahi");
  const stamp = day === oldDay ? e.txn_date : stampFor(day);
  const withLitres = kind !== "khata" && ["supply", "return", "purchase", "carriage"].includes(type);
  const litres = withLitres ? (b.litres !== undefined ? b.litres : e.litres) : null;
  const rate = withLitres && kind !== "carriage" ? (b.rate !== undefined ? b.rate : e.rate) : null;
  const product = withLitres ? (b.product !== undefined ? b.product : e.product) : null;
  let amount = b.amount != null ? round2(b.amount) : withLitres && litres && rate ? round2(litres * rate) : round2(e.amount);
  // a bypass drop stays a supply of the same fuel; extra litres must come out of the bypass stock still on hand
  const drop = dropOf(t, kind, x.id);
  if (drop) {
    if (type !== "supply") throw new AppError(400, "Bypass drop ki kism nahi badalti — ye supply hi rahegi (hatana ho to Void karein).");
    if (product !== drop.product) throw new AppError(400, "Bypass drop ka fuel nahi badalta — Void karke sahi fuel ki delivery daalein.");
    if (!litres || litres <= 0) throw new AppError(400, "Litre daalein");
    const extra = round2(litres - drop.litres), held = bypassStock(t, drop.product).litres;
    if (extra > held + 0.01) throw new AppError(400, `${PRODUCTS[drop.product] ?? drop.product}: bypass stock me sirf ${held} L bacha hai — ${extra} L zyada nahi diye ja sakte.`);
  }
  if (type === "adjustment" ? amount === 0 : amount <= 0) throw new AppError(400, "Amount theek nahi");
  // a khata "advance wapas" refund (debit, ref refund:<method>) is a money row too — keep it one unless the type changes
  const wasRefund = kind === "khata" && x.type === "debit" && String(x.ref ?? "").startsWith("refund:");
  const moneyRow = (kind === "khata" && (type === "credit" || (type === "debit" && wasRefund))) || type === "payment";
  const method = moneyRow ? (b.method !== undefined ? (b.method || "Cash") : (e.method || "Cash")) : null;
  if (method && /cheque/i.test(method)) throw new AppError(400, "Cheque method yahan se nahi — cheque register se banayein.");
  const account = moneyRow && method && !isCashMethod(method) ? bankAccountFor(t, b.account_id !== undefined ? b.account_id : e.account_id, method) : null;
  const ref = b.ref !== undefined ? b.ref : e.ref, note = b.note !== undefined ? b.note : e.note;
  const vehicle = b.vehicle_no !== undefined ? b.vehicle_no : e.vehicle_no, slip = b.slip_no !== undefined ? b.slip_no : e.slip_no;
  const before = { party_id: e.party_id, party: e.party_name, type: e.type, day: oldDay, amount: e.amount, litres: e.litres, rate: e.rate, method: e.method, account_id: e.account_id, ref: e.ref, note: e.note, vehicle_no: e.vehicle_no, slip_no: e.slip_no };
  const after = { party_id: partyId, party: party.name, type, day, amount, litres, rate, method, account_id: account, ref, note, vehicle_no: vehicle, slip_no: slip };
  const reason = `${who} (edit): ${b.reason}`;

  let newId = 0;
  tx(() => {
    if (kind === "khata") {
      // reverse the old row's balance move and drop it; post the corrected one on the chosen customer
      run("UPDATE customers SET balance = balance + ? WHERE id=?", x.type === "credit" ? x.amount : -x.amount, x.customer_id);
      run("DELETE FROM khata_ledger WHERE id=?", x.id);
      // credit → ref is the method; a kept refund → ref stays "refund:<method>" (so cash/bank go back out); else a plain charge ref
      const khataRef = type === "credit" ? method : (type === "debit" && wasRefund) ? `refund:${method || "Cash"}` : (ref ?? null);
      khataEntry(partyId, type as "debit" | "credit", amount, khataRef, note ?? null, (type === "credit" || (type === "debit" && wasRefund)) ? account : null);
      newId = get("SELECT MAX(id) id FROM khata_ledger WHERE customer_id=?", partyId)!.id as number;
      run("UPDATE khata_ledger SET created_at=?, vehicle_no=?, slip_no=?, station_id=? WHERE id=?", stamp, vehicle ?? null, slip ?? null, x.station_id ?? null, newId);
      run("UPDATE photos SET ref=? WHERE tenant_id=? AND ref=?", `khata:${newId}`, t, `khata:${x.id}`);
    } else if (kind === "wholesale") {
      // a tank supply must still fit once the old litres are handed back
      if (type === "supply" && x.tank_id && litres) {
        const avail = round2((get("SELECT current_l FROM tanks WHERE id=?", x.tank_id)?.current_l ?? 0) + (x.type === "supply" ? x.litres ?? 0 : 0));
        if (litres > avail) throw new AppError(400, `Tank me itna stock nahi (${Math.round(avail)} L mojood)`);
      }
      run("UPDATE wholesale_txns SET voided=1, void_reason=? WHERE id=?", reason, x.id);
      if (x.tank_id && x.type === "supply" && x.litres) run("UPDATE tanks SET current_l = current_l + ? WHERE id=?", x.litres, x.tank_id);
      if (x.tank_id && type === "supply" && litres) run("UPDATE tanks SET current_l = current_l - ? WHERE id=?", litres, x.tank_id);
      const r = insertTxn(req, partyId, { type, station_id: x.station_id, tank_id: type === "supply" || type === "return" ? x.tank_id : null, product, litres, rate, amount, method: method ?? (type === "supply" || type === "return" ? x.method : null),
        vehicle_no: vehicle, ref, note, txn_date: stamp, account_id: account, location: x.location ?? null, tanker_id: x.tanker_id ?? null, driver_id: x.driver_id ?? null, driver_name: x.driver_name ?? null, silent: true });
      newId = r.id as number;
      run("UPDATE wholesale_txns SET created_at=? WHERE id=?", x.created_at ?? now(), newId);
      // the bypass drop and any order closed by this supply point at the corrected row
      if (drop) run("UPDATE bypass_drops SET wtx_id=?, client_id=?, litres=?, cost_amount=?, txn_date=? WHERE id=?", newId, partyId, round2(litres!), round2(litres! * drop.unit_cost), stamp, drop.id);
      run("UPDATE wholesale_orders SET txn_id=? WHERE tenant_id=? AND txn_id=?", newId, t, x.id);
      run("UPDATE photos SET ref=? WHERE tenant_id=? AND ref=?", `wtx:${newId}`, t, `wtx:${x.id}`);
    } else if (kind === "supplier") {
      run("DELETE FROM supplier_txns WHERE id=? AND tenant_id=?", x.id, t);
      newId = run(`INSERT INTO supplier_txns (tenant_id,supplier_id,type,amount,method,ref,note,product,litres,rate,created_by,txn_date,created_at,account_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, t, partyId, type, amount, method ?? (type === "payment" ? "Cash" : null), ref ?? null, note ?? null, product ?? null, litres, rate, x.created_by ?? who, stamp, x.created_at ?? now(), account).id as number;
      run("UPDATE photos SET ref=? WHERE tenant_id=? AND ref=?", `stx:${newId}`, t, `stx:${x.id}`);
    } else if (kind === "carriage") {
      run("UPDATE carriage_txns SET voided=1, void_reason=? WHERE id=?", reason, x.id);
      // a kiraya row keeps its govt cut: the gross follows the new net at the same percentage
      const pct = Number(x.govt_pct ?? 0);
      const gross = type === "carriage" ? (pct > 0 && pct < 100 ? round2(amount / (1 - pct / 100)) : amount) : null;
      newId = run(`INSERT INTO carriage_txns (tenant_id,thekedar_id,type,supplier_id,product,litres,amount,gross_amount,govt_pct,method,account_id,vehicle_no,ref,note,created_by,txn_date,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, t, partyId, type, type === "carriage" ? x.supplier_id ?? null : null, product, litres, amount, gross, type === "carriage" ? (pct || null) : null,
        method, account, vehicle ?? null, ref ?? null, note ?? null, x.created_by ?? who, stamp, x.created_at ?? now()).id as number;
      run("UPDATE photos SET ref=? WHERE tenant_id=? AND ref=?", `carr:${newId}`, t, `carr:${x.id}`);
    }
    // the cashier voucher that mirrors this row follows it (slip number stays the same)
    if (voucher) {
      const src = `${SRC[kind]}:${newId}`;
      run("UPDATE cashier_vouchers SET party_id=?, party_name=?, amount=?, method=?, account_id=?, note=?, ref=?, src=?, created_at=? WHERE id=? AND tenant_id=?",
        partyId, party.name, amount, method ?? voucher.method, account, note ?? null, ref ?? voucher.ref ?? null, src, stamp, voucher.id, t);
    }
  });
  audit(t, req.user!, `${kind}_full_edit`, `${kind}:${x.id}`, { before, after, new_id: newId, voucher_id: voucher?.id ?? null, reason: b.reason });
  const balances = { old_party: balanceOf(kind, e.party_id), new_party: balanceOf(kind, partyId) };
  return { ok: true, new_id: newId, balances };
}));

function balanceOf(kind: Kind, id: number) {
  if (kind === "khata") return round2(get("SELECT balance FROM customers WHERE id=?", id)?.balance ?? 0);
  if (kind === "wholesale") return clientDue(id);
  if (kind === "supplier") return supplierOwed(id);
  if (kind === "carriage") return thekedarDue(id);
  return 0;
}
