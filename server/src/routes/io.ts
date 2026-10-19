/**
 * Import / export of master lists as CSV (Excel-friendly, UTF-8 with BOM): khata customers, wholesale clients, suppliers,
 * shop items and carriage thekedars. Export = the current list; import = paste from Excel (tab / comma / semicolon) or a .csv file:
 * preview first (new / update / error per row), then apply. Matching is by phone (or barcode / name), so a re-import never doubles
 * a party. Opening balances are only taken on NEW rows (an existing party's books are never rewritten by a spreadsheet).
 */
import { Router } from "express";
import { z } from "zod";
import { all, get, run, tx, now } from "../db.js";
import { h, parse, tid, can, type Permission as Perm } from "../auth.js";
import { AppError, audit, normalizePhone, round2 } from "../services.js";
import { PRODUCTS } from "../config.js";
import { setKhataOpening } from "./opening.js";
import { saveRates, clientDueAll } from "./wholesale.js";
import { supplierOwed, supplierOwedAll } from "./suppliers.js";
import { thekedarDue, thekedarDueAll } from "./carriage.js";
import { ensureLookups } from "./lookups.js";

export const io = Router();

type Col = { key: string; label: string; aliases?: string[]; num?: boolean; required?: boolean };
type Kind = {
  label: string; viewPerm: Perm; writePerm: Perm; cols: Col[];
  rows: (t: number) => Record<string, unknown>[];
  /** find the existing row this import line refers to (phone / barcode / name) */
  match: (t: number, r: Rec) => Record<string, unknown> | undefined;
  insert: (t: number, r: Rec, by: string) => number;
  update: (t: number, id: number, r: Rec) => void;
};
type Rec = Record<string, string | number | null>;

const lookupKeys = (t: number, kind: string) => { ensureLookups(t); return all("SELECT key FROM lookups WHERE tenant_id=? AND kind=? AND active=1", t, kind).map((x) => String(x.key).toLowerCase()); };
const str = (v: unknown, max = 200) => { const s = v == null ? "" : String(v).trim(); return s ? s.slice(0, max) : null; };
const num = (v: unknown) => { if (v == null || v === "") return null; const n = Number(String(v).replace(/[,\sRs]/gi, "")); return Number.isFinite(n) ? n : null; };
const productCols = (): Col[] => Object.keys(PRODUCTS).map((p) => ({ key: `rate_${p}`, label: `Rate ${PRODUCTS[p]} (Rs/L)`, aliases: [p.toLowerCase(), PRODUCTS[p].toLowerCase(), `rate ${PRODUCTS[p].toLowerCase()}`], num: true }));

const KINDS: Record<string, Kind> = {
  customers: {
    label: "Khata customers", viewPerm: "khata.manage", writePerm: "customers.create",
    cols: [
      { key: "name", label: "Name", required: true, aliases: ["customer", "naam"] },
      { key: "phone", label: "Phone", required: true, aliases: ["mobile", "whatsapp", "cell", "number"] },
      { key: "type", label: "Type", aliases: ["category", "kind", "qisam"] },
      { key: "city", label: "City", aliases: ["shehar"] },
      { key: "credit_limit", label: "Credit limit", num: true, aliases: ["limit", "khata limit", "had"] },
      { key: "opening_balance", label: "Opening balance (+ due / − advance)", num: true, aliases: ["balance", "opening", "baqaya", "due"] },
      { key: "vehicles", label: "Vehicles (plate | plate)", aliases: ["vehicle", "plates", "gaari", "gaariyan", "plate_no"] },
      { key: "notes", label: "Notes", aliases: ["note", "remarks"] },
    ],
    rows: (t) => all("SELECT id, name, phone, type, city, credit_limit, balance AS opening_balance, notes FROM customers WHERE tenant_id=? ORDER BY name", t)
      .map((c) => ({ ...c, vehicles: all("SELECT plate_no FROM vehicles WHERE customer_id=?", c.id).map((v) => v.plate_no).join(" | ") })),
    match: (t, r) => (r.phone ? get("SELECT * FROM customers WHERE tenant_id=? AND phone=?", t, normalizePhone(String(r.phone))) : undefined) ?? get("SELECT * FROM customers WHERE tenant_id=? AND lower(name)=lower(?)", t, String(r.name)),
    insert: (t, r, by) => {
      const types = lookupKeys(t, "customer_type");
      const type = r.type && types.includes(String(r.type).toLowerCase()) ? String(r.type).toLowerCase() : "retail";
      const { id } = run("INSERT INTO customers (tenant_id,name,phone,type,city,credit_limit,opt_in,notes,created_at) VALUES (?,?,?,?,?,?,1,?,?)",
        t, r.name, normalizePhone(String(r.phone)), type, r.city ?? null, Number(r.credit_limit ?? 0), r.notes ?? null, now());
      for (const p of String(r.vehicles ?? "").split(/[|;,/]/).map((x) => x.trim().toUpperCase()).filter((x) => x.length >= 3)) run("INSERT INTO vehicles (customer_id,plate_no) VALUES (?,?)", id, p);
      const ob = Number(r.opening_balance ?? 0);
      if (ob) setKhataOpening(t, id, ob, now());
      void by;
      return id;
    },
    update: (t, id, r) => {
      const types = lookupKeys(t, "customer_type");
      run("UPDATE customers SET name=COALESCE(?,name), city=COALESCE(?,city), credit_limit=COALESCE(?,credit_limit), notes=COALESCE(?,notes), type=COALESCE(?,type) WHERE id=? AND tenant_id=?",
        r.name ?? null, r.city ?? null, r.credit_limit ?? null, r.notes ?? null, r.type && types.includes(String(r.type).toLowerCase()) ? String(r.type).toLowerCase() : null, id, t);
      for (const p of String(r.vehicles ?? "").split(/[|;,/]/).map((x) => x.trim().toUpperCase()).filter((x) => x.length >= 3))
        if (!get("SELECT id FROM vehicles WHERE customer_id=? AND plate_no=?", id, p)) run("INSERT INTO vehicles (customer_id,plate_no) VALUES (?,?)", id, p);
    },
  },
  wholesale: {
    label: "Wholesale clients", viewPerm: "wholesale.view", writePerm: "wholesale.manage",
    cols: [
      { key: "name", label: "Name", required: true, aliases: ["client", "naam"] },
      { key: "business_name", label: "Business", aliases: ["business", "firm", "company"] },
      { key: "phone", label: "Phone", aliases: ["mobile", "whatsapp", "number"] },
      { key: "city", label: "City" }, { key: "address", label: "Address", aliases: ["pata"] },
      { key: "credit_limit", label: "Credit limit", num: true, aliases: ["limit"] },
      { key: "opening_balance", label: "Opening balance (+ due / − advance)", num: true, aliases: ["balance", "opening", "due", "baqaya"] },
      ...productCols(),
      { key: "notes", label: "Notes", aliases: ["note", "remarks"] },
    ],
    rows: (t) => {
      const dueMap = clientDueAll(t);
      const rateMap = new Map<number, Record<string, number>>();
      for (const x of all("SELECT r.client_id, r.product, r.rate FROM wholesale_rates r JOIN wholesale_clients c ON c.id=r.client_id WHERE c.tenant_id=?", t)) {
        const o = rateMap.get(x.client_id as number) ?? {}; o[`rate_${x.product}`] = x.rate as number; rateMap.set(x.client_id as number, o);
      }
      return all("SELECT id, name, business_name, phone, city, address, credit_limit, notes FROM wholesale_clients WHERE tenant_id=? AND active=1 ORDER BY name", t)
        .map((c) => ({ ...c, opening_balance: dueMap.get(c.id as number) ?? 0, ...(rateMap.get(c.id as number) ?? {}) }));
    },
    match: (t, r) => (r.phone ? get("SELECT * FROM wholesale_clients WHERE tenant_id=? AND phone=?", t, normalizePhone(String(r.phone))) : undefined) ?? get("SELECT * FROM wholesale_clients WHERE tenant_id=? AND lower(name)=lower(?)", t, String(r.name)),
    insert: (t, r, by) => {
      const { id } = run("INSERT INTO wholesale_clients (tenant_id,name,business_name,phone,city,address,credit_limit,opening_balance,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        t, r.name, r.business_name ?? null, r.phone ? normalizePhone(String(r.phone)) : null, r.city ?? null, r.address ?? null, Number(r.credit_limit ?? 0), round2(Number(r.opening_balance ?? 0)), r.notes ?? null, now());
      const rates = Object.fromEntries(Object.keys(PRODUCTS).filter((p) => Number(r[`rate_${p}`]) > 0).map((p) => [p, Number(r[`rate_${p}`])]));
      if (Object.keys(rates).length) saveRates(id, rates, by);
      return id;
    },
    update: (t, id, r) => {
      run("UPDATE wholesale_clients SET name=COALESCE(?,name), business_name=COALESCE(?,business_name), city=COALESCE(?,city), address=COALESCE(?,address), credit_limit=COALESCE(?,credit_limit), notes=COALESCE(?,notes) WHERE id=? AND tenant_id=?",
        r.name ?? null, r.business_name ?? null, r.city ?? null, r.address ?? null, r.credit_limit ?? null, r.notes ?? null, id, t);
    },
  },
  suppliers: {
    label: "Suppliers", viewPerm: "suppliers.manage", writePerm: "suppliers.manage",
    cols: [
      { key: "name", label: "Name", required: true, aliases: ["supplier", "contact", "naam"] },
      { key: "company", label: "Company (PSO / Shell …)", aliases: ["omc", "brand"] },
      { key: "phone", label: "Phone", aliases: ["mobile", "whatsapp", "number"] },
      { key: "opening_balance", label: "Opening balance (we owe)", num: true, aliases: ["balance", "opening", "owed", "dena"] },
      { key: "notes", label: "Notes", aliases: ["note", "remarks"] },
    ],
    rows: (t) => ((d) => all("SELECT id, name, company, phone, notes FROM suppliers WHERE tenant_id=? AND active=1 ORDER BY name", t).map((s) => ({ ...s, opening_balance: round2(d.get(s.id as number) ?? 0) })))(supplierOwedAll(t)),
    match: (t, r) => (r.phone ? get("SELECT * FROM suppliers WHERE tenant_id=? AND phone=?", t, normalizePhone(String(r.phone))) : undefined) ?? get("SELECT * FROM suppliers WHERE tenant_id=? AND lower(name)=lower(?)", t, String(r.name)),
    insert: (t, r) => run("INSERT INTO suppliers (tenant_id,name,phone,opening_balance,notes,company,created_at) VALUES (?,?,?,?,?,?,?)",
      t, r.name, r.phone ? normalizePhone(String(r.phone)) : null, round2(Number(r.opening_balance ?? 0)), r.notes ?? null, r.company ?? null, now()).id,
    update: (t, id, r) => { run("UPDATE suppliers SET name=COALESCE(?,name), company=COALESCE(?,company), notes=COALESCE(?,notes) WHERE id=? AND tenant_id=?", r.name ?? null, r.company ?? null, r.notes ?? null, id, t); },
  },
  shop: {
    label: "Shop items", viewPerm: "stock.manage", writePerm: "stock.manage",
    cols: [
      { key: "station", label: "Station", aliases: ["pump", "branch"] },
      { key: "name", label: "Item", required: true, aliases: ["item", "product", "description"] },
      { key: "category", label: "Category", aliases: ["type", "group"] },
      { key: "sku", label: "SKU", aliases: ["code", "item code"] }, { key: "barcode", label: "Barcode", aliases: ["ean", "upc"] },
      { key: "unit", label: "Unit", aliases: ["uom"] },
      { key: "cost", label: "Cost", num: true, aliases: ["purchase", "buy", "cost price", "khareed"] },
      { key: "price", label: "Sale price", num: true, required: true, aliases: ["sale", "sell", "rate", "mrp", "qeemat"] },
      { key: "stock", label: "Stock (opening qty)", num: true, aliases: ["qty", "quantity", "opening stock"] },
      { key: "reorder_level", label: "Reorder level", num: true, aliases: ["reorder", "min", "minimum"] },
    ],
    rows: (t) => all("SELECT i.id, s.name station, i.name, i.category, i.sku, i.barcode, i.unit, i.cost, i.price, i.stock, i.reorder_level FROM shop_items i JOIN stations s ON s.id=i.station_id WHERE i.tenant_id=? AND i.active=1 ORDER BY s.name, i.name", t),
    match: (t, r) => {
      const sid = stationFor(t, r.station);
      return (r.barcode ? get("SELECT * FROM shop_items WHERE tenant_id=? AND station_id=? AND barcode=?", t, sid, String(r.barcode)) : undefined)
        ?? get("SELECT * FROM shop_items WHERE tenant_id=? AND station_id=? AND lower(name)=lower(?)", t, sid, String(r.name));
    },
    insert: (t, r, by) => {
      const sid = stationFor(t, r.station);
      const cats = lookupKeys(t, "shop_category");
      const cat = r.category && cats.includes(String(r.category).toLowerCase()) ? String(r.category).toLowerCase() : "other";
      const stock = Math.max(0, Number(r.stock ?? 0)), cost = Math.max(0, Number(r.cost ?? 0));
      const { id } = run("INSERT INTO shop_items (tenant_id,station_id,sku,barcode,name,category,unit,cost,price,stock,reorder_level,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        t, sid, r.sku ?? null, r.barcode ?? null, r.name, cat, r.unit ?? "pc", cost, Number(r.price), stock, Math.max(0, Number(r.reorder_level ?? 0)), now());
      if (stock) run("INSERT INTO shop_moves (item_id,type,qty,cost,note,created_by,created_at) VALUES (?,?,?,?,?,?,?)", id, "opening", stock, cost, "Opening stock (import)", by, now());
      return id;
    },
    update: (t, id, r) => {
      const cats = lookupKeys(t, "shop_category");
      run("UPDATE shop_items SET name=COALESCE(?,name), sku=COALESCE(?,sku), barcode=COALESCE(?,barcode), unit=COALESCE(?,unit), cost=COALESCE(?,cost), price=COALESCE(?,price), reorder_level=COALESCE(?,reorder_level), category=COALESCE(?,category) WHERE id=? AND tenant_id=?",
        r.name ?? null, r.sku ?? null, r.barcode ?? null, r.unit ?? null, r.cost ?? null, r.price ?? null, r.reorder_level ?? null, r.category && cats.includes(String(r.category).toLowerCase()) ? String(r.category).toLowerCase() : null, id, t);
    },
  },
  thekedars: {
    label: "Carriage thekedars", viewPerm: "carriage.view", writePerm: "carriage.manage",
    cols: [
      { key: "name", label: "Name", required: true, aliases: ["thekedar", "contractor", "naam"] },
      { key: "phone", label: "Phone", aliases: ["mobile", "whatsapp", "number"] },
      { key: "cnic", label: "CNIC" }, { key: "city", label: "City" }, { key: "address", label: "Address", aliases: ["pata"] },
      { key: "opening_balance", label: "Opening balance (owes us)", num: true, aliases: ["balance", "opening", "due", "baqaya"] },
      { key: "notes", label: "Notes", aliases: ["note", "remarks"] },
    ],
    rows: (t) => ((d) => all("SELECT id, name, phone, cnic, city, address, notes FROM thekedars WHERE tenant_id=? AND active=1 ORDER BY name", t).map((k) => ({ ...k, opening_balance: round2(d.get(k.id as number) ?? 0) })))(thekedarDueAll(t)),
    match: (t, r) => (r.phone ? get("SELECT * FROM thekedars WHERE tenant_id=? AND phone=?", t, normalizePhone(String(r.phone))) : undefined) ?? get("SELECT * FROM thekedars WHERE tenant_id=? AND lower(name)=lower(?)", t, String(r.name)),
    insert: (t, r) => run("INSERT INTO thekedars (tenant_id,name,phone,cnic,city,address,opening_balance,notes,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      t, r.name, r.phone ? normalizePhone(String(r.phone)) : null, r.cnic ?? null, r.city ?? null, r.address ?? null, round2(Number(r.opening_balance ?? 0)), r.notes ?? null, now()).id,
    update: (t, id, r) => { run("UPDATE thekedars SET name=COALESCE(?,name), cnic=COALESCE(?,cnic), city=COALESCE(?,city), address=COALESCE(?,address), notes=COALESCE(?,notes) WHERE id=? AND tenant_id=?", r.name ?? null, r.cnic ?? null, r.city ?? null, r.address ?? null, r.notes ?? null, id, t); },
  },
};

function stationFor(t: number, name: unknown): number {
  const sts = all("SELECT id, name FROM stations WHERE tenant_id=? AND active=1 ORDER BY id", t);
  if (!sts.length) throw new AppError(400, "No station yet");
  if (!name) return sts[0].id as number;
  const n = String(name).trim().toLowerCase();
  const hit = sts.find((s) => String(s.name).toLowerCase() === n) ?? sts.find((s) => String(s.name).toLowerCase().includes(n));
  if (!hit) throw new AppError(400, `Station "${name}" not found (${sts.map((s) => s.name).join(", ")})`);
  return hit.id as number;
}
const kindOf = (k: string) => { const d = KINDS[k]; if (!d) throw new AppError(404, "Unknown list"); return d; };

/* ---------- CSV ---------- */
const csvCell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(cols: Col[], rows: Record<string, unknown>[]) {
  return "﻿" + [cols.map((c) => c.label).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c.key])).join(","))].join("\r\n");
}
/** Parse CSV / TSV / semicolon text (what Excel copies or saves), quotes honoured, into header + rows. */
export function parseTable(text: string): { header: string[]; rows: string[][] } {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const firstLine = src.split("\n").find((l) => l.trim()) ?? "";
  const delim = (firstLine.match(/\t/g)?.length ?? 0) > 0 ? "\t" : (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  const clean = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (!clean.length) return { header: [], rows: [] };
  return { header: clean[0].map((h) => h.trim()), rows: clean.slice(1) };
}
/** Map spreadsheet headers onto our columns by label / key / alias (case- and punctuation-insensitive). */
function mapHeader(cols: Col[], header: string[]) {
  const normal = (s: string) => s.toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const map: (Col | null)[] = header.map((hd) => {
    const n = normal(hd);
    return cols.find((c) => normal(c.label) === n || c.key.replace(/_/g, " ") === n || (c.aliases ?? []).some((a) => normal(a) === n)) ?? null;
  });
  return map;
}
function toRecords(def: Kind, text: string) {
  const { header, rows } = parseTable(text);
  if (!header.length) throw new AppError(400, "Khali file / text");
  const map = mapHeader(def.cols, header);
  const unknown = header.filter((_, i) => !map[i]);
  const missing = def.cols.filter((c) => c.required && !map.includes(c));
  if (missing.length) throw new AppError(400, `Columns missing: ${missing.map((c) => c.label).join(", ")}. Pehli line me headings honi chahiye (template download karein).`);
  const recs: Rec[] = rows.map((r) => {
    const rec: Rec = {};
    map.forEach((c, i) => { if (!c) return; const v = r[i]; rec[c.key] = c.num ? num(v) : str(v); });
    return rec;
  });
  return { recs, unknown, mapped: map.filter(Boolean).map((c) => c!.label) };
}

/** Per-row verdict: what the import would do. */
function plan(t: number, def: Kind, recs: Rec[], mode: "add" | "upsert") {
  const seen = new Set<string>();
  return recs.map((r, i) => {
    const line = i + 2;
    for (const c of def.cols) if (c.required && (r[c.key] == null || r[c.key] === "")) return { line, status: "error" as const, message: `${c.label} khali hai`, rec: r };
    if (def === KINDS.customers && normalizePhone(String(r.phone)).length < 11) return { line, status: "error" as const, message: "Phone number sahi nahi", rec: r };
    if (def === KINDS.shop && !(Number(r.price) > 0)) return { line, status: "error" as const, message: "Sale price 0 se zyada ho", rec: r };
    const key = (r.phone ? normalizePhone(String(r.phone)) : "") + "|" + String(r.name ?? "").toLowerCase() + "|" + String(r.barcode ?? "") + "|" + String(r.station ?? "");
    if (seen.has(key)) return { line, status: "error" as const, message: "File me yehi row dobara hai", rec: r };
    seen.add(key);
    let existing: Record<string, unknown> | undefined;
    try { existing = def.match(t, r); } catch (e: any) { return { line, status: "error" as const, message: e.message, rec: r }; }
    if (existing) return { line, status: mode === "upsert" ? "update" as const : "skip" as const, message: `Pehle se hai: ${existing.name}`, rec: r, id: existing.id as number };
    return { line, status: "new" as const, message: "", rec: r };
  });
}

/* ---------- routes ---------- */
io.get("/io/:kind/template.csv", h((req, res) => {
  const def = kindOf(req.params.kind);
  if (!can(req.user, def.viewPerm)) throw new AppError(403, "Not allowed");
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="${req.params.kind}-template.csv"`);
  res.send(toCsv(def.cols, []));
}));
io.get("/io/:kind.csv", h((req, res) => {
  const def = kindOf(req.params.kind);
  if (!can(req.user, def.viewPerm)) throw new AppError(403, "Not allowed");
  res.setHeader("content-type", "text/csv; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="${req.params.kind}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv(def.cols, def.rows(tid(req))));
}));
io.get("/io/:kind/columns", h((req) => { const def = kindOf(req.params.kind); return { label: def.label, cols: def.cols }; }));
const body = z.object({ text: z.string().min(1).max(5_000_000), mode: z.enum(["add", "upsert"]).default("add") });
io.post("/io/:kind/preview", h((req) => {
  const def = kindOf(req.params.kind);
  if (!can(req.user, def.writePerm)) throw new AppError(403, "Not allowed");
  const b = parse(body, req.body);
  const { recs, unknown, mapped } = toRecords(def, b.text);
  const rows = plan(tid(req), def, recs, b.mode);
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  return { label: def.label, mapped, unknown, rows: rows.slice(0, 500), total: rows.length, summary: { new: count("new"), update: count("update"), skip: count("skip"), error: count("error") } };
}));
io.post("/io/:kind/import", h((req) => {
  const def = kindOf(req.params.kind);
  const t = tid(req);
  if (!can(req.user, def.writePerm)) throw new AppError(403, "Not allowed");
  const b = parse(body, req.body);
  if (def === KINDS.customers && !can(req.user, "credit.set_limit")) {
    // a manager may add customers but not give khata credit / opening balances
    const { recs } = toRecords(def, b.text);
    if (recs.some((r) => Number(r.credit_limit) > 0 || Number(r.opening_balance))) throw new AppError(403, "Credit limit / opening balance sirf CEO import kar sakta hai");
  }
  const { recs } = toRecords(def, b.text);
  const rows = plan(t, def, recs, b.mode);
  const done = { added: 0, updated: 0, skipped: 0, errors: rows.filter((r) => r.status === "error").map((r) => `Line ${r.line}: ${r.message}`) };
  tx(() => {
    for (const r of rows) {
      if (r.status === "new") { def.insert(t, r.rec, req.user!.name); done.added++; }
      else if (r.status === "update") { def.update(t, r.id!, r.rec); done.updated++; }
      else if (r.status === "skip") done.skipped++;
    }
  });
  audit(t, req.user!, "list_imported", `io:${req.params.kind}`, { ...done, errors: done.errors.length });
  return done;
}));
