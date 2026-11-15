/**
 * Global search (Ctrl/⌘ K): one box finds a khata customer, vehicle, wholesale client, thekedar, supplier, staff member,
 * tanker / driver, machine, voucher number or cheque number — and jumps straight to it. Each group is gated by the same
 * permission its page needs, so a salesman only sees what he may open anyway.
 */
import { Router } from "express";
import { all, get } from "../db.js";
import { h, tid, requireAuth, can } from "../auth.js";
import { round2 } from "../services.js";
import { clientDue } from "./wholesale.js";
import { thekedarDue } from "./carriage.js";
import { supplierOwed } from "./suppliers.js";

export const search = Router();

type Hit = { kind: string; label: string; sub?: string; amount?: number | null; to: string };

search.get("/search", requireAuth, h((req) => {
  const t = tid(req);
  const raw = String(req.query.q ?? "").trim();
  if (raw.length < 2) return { q: raw, hits: [] as Hit[] };
  const q = `%${raw}%`;
  const u = req.user!;
  const hits: Hit[] = [];
  const push = (arr: Hit[]) => hits.push(...arr);

  // voucher number "RV-00060" / "PV-12" → the day book of that day
  const vm = /^(RV|PV)[-\s]?0*(\d+)$/i.exec(raw);
  if (vm && can(u, "cashier.desk")) {
    const v = get("SELECT id, direction, party_name, amount, created_at, voided FROM cashier_vouchers WHERE tenant_id=? AND id=? AND direction=?", t, Number(vm[2]), vm[1].toUpperCase() === "RV" ? "in" : "out");
    if (v) push([{ kind: "voucher", label: `${vm[1].toUpperCase()}-${String(v.id).padStart(5, "0")} · ${v.party_name}${v.voided ? " (void)" : ""}`, sub: String(v.created_at).slice(0, 10), amount: v.amount, to: `/cashier?tab=daybook&date=${String(v.created_at).slice(0, 10)}` }]);
  }
  // An entry number as the lists show it (S-40018, K-3739, EX-00055, WS-91, CN-90, BYP-185, SUP-12, CR-7 …) → that entry
  const im = /^([A-Za-z]{1,4})[-\s]?0*(\d+)$/.exec(raw);
  if (im) {
    const pre = im[1].toUpperCase(), n = Number(im[2]);
    const day = (v: unknown) => String(v ?? "").slice(0, 10);
    const one = (ok: boolean, sql: string, ...a: (string | number)[]) => (ok ? get(sql, ...a) : undefined);
    if (pre === "S") { const r = one(can(u, "sales.view"), "SELECT s.id, s.product, s.litres, s.amount, s.created_at, st.name station FROM sales s JOIN stations st ON st.id=s.station_id WHERE s.id=? AND st.tenant_id=?", n, t);
      if (r) push([{ kind: "entry", label: `S-${r.id} · Sale · ${r.litres} L ${r.product}`, sub: `${day(r.created_at)} · ${r.station}`, amount: r.amount, to: `/sales-history?id=${r.id}` }]); }
    if (pre === "K") { const r = one(can(u, "customers.view"), "SELECT k.id, k.type, k.amount, k.created_at, c.id cid, c.name FROM khata_ledger k JOIN customers c ON c.id=k.customer_id WHERE k.id=? AND c.tenant_id=?", n, t);
      if (r) push([{ kind: "entry", label: `K-${r.id} · Khata ${r.type === "credit" ? "payment" : "charge"} · ${r.name}`, sub: day(r.created_at), amount: r.amount, to: `/customers/${r.cid}` }]); }
    if (pre === "EX") { const r = one(can(u, "expenses.view"), "SELECT id, category, paid_to, amount, expense_date FROM expenses WHERE id=? AND tenant_id=?", n, t);
      if (r) push([{ kind: "entry", label: `EX-${String(r.id).padStart(5, "0")} · Kharcha · ${r.category}${r.paid_to ? ` · ${r.paid_to}` : ""}`, sub: day(r.expense_date), amount: r.amount, to: "/expenses" }]); }
    if (pre === "ST") { const r = one(can(u, "staff.manage"), "SELECT l.id, l.type, l.amount, l.created_at, x.name FROM staff_ledger l JOIN users x ON x.id=l.user_id WHERE l.id=? AND x.tenant_id=?", n, t);
      if (r) push([{ kind: "entry", label: `ST-${r.id} · Staff ${r.type} · ${r.name}`, sub: day(r.created_at), amount: r.amount, to: "/staff" }]); }
    if (pre === "SUP") { const r = one(can(u, "suppliers.manage"), "SELECT x.id, x.type, x.amount, x.litres, x.product, x.txn_date, s.name FROM supplier_txns x JOIN suppliers s ON s.id=x.supplier_id WHERE x.id=? AND x.tenant_id=?", n, t);
      if (r) push([{ kind: "entry", label: `SUP-${r.id} · Supplier ${r.type} · ${r.name}${r.litres ? ` · ${r.litres} L ${r.product ?? ""}` : ""}`, sub: day(r.txn_date), amount: r.amount, to: `/suppliers?q=${encodeURIComponent(r.name)}` }]); }
    if (pre === "CR") { const r = one(can(u, "carriage.view"), "SELECT x.id, x.type, x.amount, x.txn_date, k.id kid, k.name FROM carriage_txns x JOIN thekedars k ON k.id=x.thekedar_id WHERE x.id=? AND x.tenant_id=?", n, t);
      if (r) push([{ kind: "entry", label: `CR-${r.id} · Carriage ${r.type} · ${r.name}`, sub: day(r.txn_date), amount: r.amount, to: `/carriage/${r.kid}` }]); }
    if (pre === "IV") { const r = one(can(u, "investors.manage"), "SELECT x.id, x.type, x.amount, x.created_at, i.name FROM investor_txns x JOIN investors i ON i.id=x.investor_id WHERE x.id=? AND x.tenant_id=?", n, t);
      if (r) push([{ kind: "entry", label: `IV-${r.id} · Investor ${r.type} · ${r.name}`, sub: day(r.created_at), amount: r.amount, to: "/investors" }]); }
    if (pre === "DLV") { const r = one(can(u, "stock.manage"), "SELECT d.id, d.received_l, d.supplier, d.created_at, tk.name tank FROM deliveries d JOIN tanks tk ON tk.id=d.tank_id JOIN stations st ON st.id=tk.station_id WHERE d.id=? AND st.tenant_id=?", n, t);
      if (r) push([{ kind: "entry", label: `DLV-${r.id} · Tanker delivery · ${r.received_l} L → ${r.tank}`, sub: `${day(r.created_at)} · ${r.supplier ?? ""}`, to: "/stock" }]); }
    if (pre === "DIP") { const r = one(can(u, "stock.manage"), "SELECT d.id, d.measured_l, d.created_at, tk.name tank FROM dip_readings d JOIN tanks tk ON tk.id=d.tank_id JOIN stations st ON st.id=tk.station_id WHERE d.id=? AND st.tenant_id=?", n, t);
      if (r) push([{ kind: "entry", label: `DIP-${r.id} · Dip · ${r.measured_l} L · ${r.tank}`, sub: day(r.created_at), to: "/stock" }]); }
    if (can(u, "wholesale.view")) {
      if (["BYP", "UNL", "DEL"].includes(pre)) { const r = get("SELECT id, kind, txn_date, voided, vehicle_no FROM bypass_deliveries WHERE id=? AND tenant_id=?", n, t);
        if (r) push([{ kind: "entry", label: `BYP-${r.id} · ${r.kind === "unload" ? "Tank unload" : "Bypass voucher"}${r.voided ? " (mansookh)" : ""}`, sub: `${day(r.txn_date)}${r.vehicle_no ? ` · ${r.vehicle_no}` : ""}`, to: `/wholesale?tab=trips&sub=deliveries&voucher=${r.id}` }]); }
      if (["WS", "CN", "JV", "RV"].includes(pre)) for (const w of all("SELECT w.id, w.type, w.amount, w.litres, w.product, w.txn_date, w.voided, w.voucher_no, c.id cid, c.name FROM wholesale_txns w JOIN wholesale_clients c ON c.id=w.client_id WHERE w.tenant_id=? AND (w.id=? OR w.voucher_no=?) LIMIT 6", t, n, `${pre}-${n}`)) {
        const no = (w.voucher_no as string | null) ?? `${w.type === "supply" ? "WS" : w.type === "payment" ? "RV" : w.type === "return" ? "CN" : "JV"}-${w.id}`;
        if (!no.startsWith(pre + "-")) continue;
        push([{ kind: "entry", label: `${no} · Wholesale ${w.type} · ${w.name}${w.voided ? " (mansookh)" : ""}`, sub: `${day(w.txn_date)}${w.litres ? ` · ${w.litres} L ${w.product ?? ""}` : ""}`, amount: w.amount as number, to: `/wholesale/${w.cid}?tab=statement` }]);
      }
      if (pre === "BP") { const r = get("SELECT p.id, p.litres, p.product, p.amount, p.txn_date, p.delivery_id, s.name FROM bypass_purchases p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=? AND p.tenant_id=?", n, t);
        if (r) push([{ kind: "entry", label: `BP-${r.id} · Bypass khareed · ${r.name} · ${r.litres} L ${r.product}`, sub: day(r.txn_date), amount: r.amount, to: r.delivery_id ? `/wholesale?tab=trips&sub=deliveries&voucher=${r.delivery_id}` : `/suppliers?q=${encodeURIComponent(r.name)}` }]); }
      if (pre === "SP") { const r = get("SELECT p.id, p.amount, p.txn_date, s.name FROM bypass_supplier_payments p JOIN suppliers s ON s.id=p.supplier_id WHERE p.id=? AND p.tenant_id=?", n, t);
        if (r) push([{ kind: "entry", label: `SP-${r.id} · Bypass supplier payment · ${r.name}`, sub: day(r.txn_date), amount: r.amount, to: `/suppliers?q=${encodeURIComponent(r.name)}` }]); }
      if (pre === "TRIP") { const r = get("SELECT id, litres, product, amount, trip_date FROM wholesale_trips WHERE id=? AND tenant_id=?", n, t);
        if (r) push([{ kind: "entry", label: `TRIP-${r.id} · Tanker trip · ${r.litres} L ${r.product}`, sub: day(r.trip_date), amount: r.amount, to: "/wholesale?tab=trips" }]); }
    }
  }
  if (can(u, "customers.view")) {
    push(all(`SELECT id, name, phone, balance FROM customers WHERE tenant_id=? AND (name LIKE ? OR COALESCE(phone,'') LIKE ?) ORDER BY (balance<>0) DESC, name LIMIT 8`, t, q, q)
      .map((c) => ({ kind: "customer", label: c.name, sub: c.phone ?? "khata customer", amount: round2(c.balance), to: `/customers/${c.id}` })));
    push(all(`SELECT v.plate_no, c.id cid, c.name FROM vehicles v JOIN customers c ON c.id=v.customer_id WHERE c.tenant_id=? AND v.plate_no LIKE ? LIMIT 5`, t, q)
      .map((v) => ({ kind: "vehicle", label: v.plate_no, sub: `vehicle · ${v.name}`, to: `/customers/${v.cid}` })));
  }
  if (can(u, "wholesale.view")) {
    push(all(`SELECT id, name, business_name, phone FROM wholesale_clients WHERE tenant_id=? AND active=1 AND (name LIKE ? OR COALESCE(business_name,'') LIKE ? OR COALESCE(phone,'') LIKE ?) ORDER BY name LIMIT 6`, t, q, q, q)
      .map((c) => ({ kind: "client", label: c.name, sub: c.business_name || c.phone || "wholesale client", amount: round2(clientDue(c.id)), to: `/wholesale/${c.id}` })));
    push(all(`SELECT id, number FROM tankers WHERE tenant_id=? AND number LIKE ? LIMIT 4`, t, q).map((x) => ({ kind: "tanker", label: x.number, sub: "tanker", to: "/wholesale?tab=fleet" })));
    push(all(`SELECT id, name, COALESCE(phone,'') phone FROM drivers WHERE tenant_id=? AND (name LIKE ? OR phone LIKE ?) LIMIT 4`, t, q, q).map((x) => ({ kind: "driver", label: x.name, sub: `driver${x.phone ? ` · ${x.phone}` : ""}`, to: "/wholesale?tab=fleet" })));
  }
  if (can(u, "carriage.view")) push(all(`SELECT id, name, phone FROM thekedars WHERE tenant_id=? AND (name LIKE ? OR COALESCE(phone,'') LIKE ?) ORDER BY name LIMIT 6`, t, q, q)
    .map((k) => ({ kind: "thekedar", label: k.name, sub: k.phone || "thekedar", amount: round2(thekedarDue(k.id)), to: `/carriage/${k.id}` })));
  if (can(u, "suppliers.manage")) push(all(`SELECT id, name, company, phone FROM suppliers WHERE tenant_id=? AND (name LIKE ? OR COALESCE(company,'') LIKE ? OR COALESCE(phone,'') LIKE ?) ORDER BY name LIMIT 6`, t, q, q, q)
    .map((s) => ({ kind: "supplier", label: s.name, sub: s.company || s.phone || "supplier", amount: round2(supplierOwed(s.id)), to: `/suppliers?q=${encodeURIComponent(s.name)}` })));
  if (can(u, "staff.manage")) push(all(`SELECT id, name, role, phone FROM users WHERE tenant_id=? AND active=1 AND (name LIKE ? OR COALESCE(phone,'') LIKE ?) ORDER BY name LIMIT 6`, t, q, q)
    .map((s) => ({ kind: "staff", label: s.name, sub: `${s.role}${s.phone ? ` · ${s.phone}` : ""}`, to: `/staff?q=${encodeURIComponent(s.name)}` })));
  if (can(u, "cheques.manage")) push(all(`SELECT id, direction, party_name, amount, bank, cheque_no, status FROM cheques WHERE tenant_id=? AND (cheque_no LIKE ? OR party_name LIKE ?) ORDER BY id DESC LIMIT 5`, t, q, q)
    .map((c) => ({ kind: "cheque", label: `Cheque ${c.cheque_no} · ${c.bank}`, sub: `${c.direction === "in" ? "received from" : "issued to"} ${c.party_name} · ${c.status}`, amount: c.amount, to: "/cashier?tab=cheques" })));
  // wholesale clients' cheques live in their own register but show in the same cheque list
  if (can(u, "cheques.manage")) push(all(`SELECT q.id, q.amount, q.bank, q.cheque_no, q.cheque_date, q.status, c.name party_name FROM wholesale_cheques q JOIN wholesale_clients c ON c.id=q.client_id
      WHERE q.tenant_id=? AND (q.cheque_no LIKE ? OR c.name LIKE ?) ORDER BY q.id DESC LIMIT 5`, t, q, q)
    .map((c) => ({ kind: "cheque", label: `Cheque ${c.cheque_no} · ${c.bank}`, sub: `received from ${c.party_name} (wholesale) · ${c.status} · ${c.cheque_date}`, amount: c.amount, to: "/cashier?tab=cheques" })));
  if (can(u, "sales.create")) push(all(`SELECT id, name, type, serial_no, status FROM machines WHERE tenant_id=? AND (name LIKE ? OR COALESCE(serial_no,'') LIKE ? OR COALESCE(make,'') LIKE ?) LIMIT 4`, t, q, q, q)
    .map((m) => ({ kind: "machine", label: m.name, sub: `${m.type} · ${m.status}${m.serial_no ? ` · ${m.serial_no}` : ""}`, to: `/machines?q=${encodeURIComponent(m.name)}` })));
  // the forecourt itself: stations, tanks and meters → Settings → Stations, tanks & meters
  if (can(u, "settings.manage") || can(u, "stock.manage")) {
    const to = can(u, "settings.manage") ? "/settings#set-stations" : "/stock";
    push(all(`SELECT id, name, city FROM stations WHERE tenant_id=? AND (name LIKE ? OR COALESCE(city,'') LIKE ?) LIMIT 3`, t, q, q)
      .map((x) => ({ kind: "station", label: x.name, sub: x.city || "station", to })));
    push(all(`SELECT k.id, k.name, k.product, k.current_l, s.name station FROM tanks k JOIN stations s ON s.id=k.station_id WHERE s.tenant_id=? AND k.name LIKE ? LIMIT 4`, t, q)
      .map((x) => ({ kind: "tank", label: x.name, sub: `${x.product} · ${Math.round(x.current_l)} L · ${x.station}`, to: "/stock" })));
    push(all(`SELECT n.id, n.label, n.totalizer, s.name station FROM nozzles n JOIN stations s ON s.id=n.station_id WHERE s.tenant_id=? AND n.label LIKE ? LIMIT 4`, t, q)
      .map((x) => ({ kind: "meter", label: x.label, sub: `meter · reading ${round2(x.totalizer)} · ${x.station}`, to })));
  }
  if (can(u, "stock.manage")) push(all(`SELECT id, name, price, stock, unit FROM shop_items WHERE tenant_id=? AND active=1 AND (name LIKE ? OR COALESCE(sku,'') LIKE ? OR COALESCE(barcode,'') LIKE ?) ORDER BY name LIMIT 5`, t, q, q, q)
    .map((x) => ({ kind: "item", label: x.name, sub: `shop item · ${round2(x.stock)} ${x.unit} stock`, amount: x.price, to: `/shop?q=${encodeURIComponent(x.name)}` })));
  if (can(u, "bank.view")) push(all(`SELECT id, bank, title, account_no FROM bank_accounts WHERE tenant_id=? AND active=1 AND (bank LIKE ? OR COALESCE(title,'') LIKE ? OR COALESCE(account_no,'') LIKE ?) LIMIT 4`, t, q, q, q)
    .map((x) => ({ kind: "bank", label: `${x.bank}${x.title ? ` · ${x.title}` : ""}`, sub: x.account_no ? `A/c ${x.account_no}` : "bank account", to: "/cash" })));
  return { q: raw, hits: hits.slice(0, 30) };
}));
