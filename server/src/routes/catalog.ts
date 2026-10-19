/**
 * Master shop catalog: the list of things a Pakistani pump's shop sells (filters, oils, brake oil, coolant…), kept once
 * at platform level so no pump types it again. The super admin curates it (add / edit / paste from Excel / copy a pump's
 * shop items / read an old PumpAI backup .db); every pump pulls what it stocks into its own shop with one click.
 * Prices in the catalog are defaults — each pump keeps its own cost / price after import.
 */
import { Router } from "express";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { all, get, run, now, tx, db } from "../db.js";
import { h, parse, tid, requirePerm } from "../auth.js";
import { AppError } from "../services.js";
import { lookupKeys } from "./lookups.js";

db.exec(`CREATE TABLE IF NOT EXISTS catalog_items (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'other', brand TEXT, unit TEXT NOT NULL DEFAULT 'pc',
  cost REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, sku TEXT, barcode TEXT, sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_name ON catalog_items(name COLLATE NOCASE)");

/** The starter list (Guard filter range and the usual oils). Prices are what one pump charged in Oct 2026; 0 = set at the pump. */
const STARTER: [string, string, number, number, string?][] = [
  ["Guard Brake oil", "lubricant", 0, 600, "Guard"],
  ...["0060:500", "135:800", "153:1000", "158:500", "198:800", "199:800", "2002:3500", "206:650", "212:800", "215:600", "2250:1500", "333:900", "334:800", "337:1500", "402 A:0", "419:0", "501:0", "506A:0"]
    .map((s) => s.split(":")).map(([m, p]) => [`Guard Filters ${m}`, "filter", 0, Number(p), "Guard"] as [string, string, number, number, string]),
  ["Guard Oil Filter (car)", "filter", 0, 0, "Guard"], ["Guard Air Filter (car)", "filter", 0, 0, "Guard"],
  ["Shell Helix HX5 15W-40 1L", "lubricant", 0, 0, "Shell"], ["Shell Helix HX5 15W-40 3L", "lubricant", 0, 0, "Shell"], ["Shell Helix HX5 15W-40 4L", "lubricant", 0, 0, "Shell"],
  ["Shell Helix HX7 10W-40 4L", "lubricant", 0, 0, "Shell"], ["Shell Advance AX5 (bike) 1L", "lubricant", 0, 0, "Shell"],
  ["PSO Carient 20W-50 1L", "lubricant", 0, 0, "PSO"], ["PSO Carient 20W-50 4L", "lubricant", 0, 0, "PSO"], ["PSO Blaze 4T 1L", "lubricant", 0, 0, "PSO"],
  ["Total Quartz 7000 10W-40 4L", "lubricant", 0, 0, "Total"], ["Total Hi-Perf 4T 1L", "lubricant", 0, 0, "Total"],
  ["Caltex Havoline 20W-50 4L", "lubricant", 0, 0, "Caltex"], ["ZIC X7 10W-40 4L", "lubricant", 0, 0, "ZIC"],
  ["Diesel engine oil 15W-40 10L (HDEO)", "lubricant", 0, 0, null as any], ["Gear oil 90 1L", "lubricant", 0, 0, null as any], ["Hydraulic oil 68 1L", "lubricant", 0, 0, null as any],
  ["Coolant 1L", "coolant", 0, 0, null as any], ["Coolant 4L", "coolant", 0, 0, null as any], ["Battery water 1L", "battery", 0, 0, null as any],
  ["Brake fluid DOT 3", "lubricant", 0, 0, null as any], ["Grease 500g", "lubricant", 0, 0, null as any], ["Mobil tin 1L (mixing)", "lubricant", 0, 0, null as any],
  ["Air freshener", "other", 0, 0, null as any], ["Windscreen washer 1L", "other", 0, 0, null as any], ["Tyre puncture (service)", "service", 0, 0, null as any],
  // one pump's shop list (Oct 2026) — names kept exactly as the shop uses them
  ["Dimond Brake Shoe Imported", "other", 0, 400, "Dimond"], ["Dimond Brake Shoe Local", "other", 0, 300, "Dimond"], ["Dimond Chain Kit back", "other", 0, 2200, "Dimond"], ["Dimond Chain kit Front", "other", 0, 1500, "Dimond"],
  ["Blaze 07", "lubricant", 0, 650, "PSO"], ["Blaze 1 ltr", "lubricant", 0, 850, "PSO"], ["Blaze Xtreme", "lubricant", 0, 1000, "PSO"],
  ["Carient 5W-30", "lubricant", 0, 5000, "PSO"], ["Carient plus 1 ltr", "lubricant", 0, 1000, "PSO"], ["Carient plus 3 ltr", "lubricant", 0, 3000, "PSO"], ["Carient plus 4 ltr", "lubricant", 0, 4000, "PSO"],
  ["Costrol 20W40 07", "lubricant", 0, 650, "Castrol"], ["Costrol 20W50 1 Ltr", "lubricant", 0, 1200, "Castrol"], ["Costrol 20W50 3 Ltr", "lubricant", 0, 3000, "Castrol"], ["Costrol 20W50 4 Ltr", "lubricant", 0, 4000, "Castrol"],
  ["Delo Gold Ultra 15W40 4 Ltr", "lubricant", 0, 6000, "Caltex"], ["Delo Silver 20W/50 4 Ltr", "lubricant", 0, 5200, "Caltex"],
  ["Deo 3000 4 ltr", "lubricant", 0, 3600, "PSO"], ["Deo 6000 4 ltr", "lubricant", 0, 4000, "PSO"], ["Deo 8000 4 ltr", "lubricant", 0, 4500, "PSO"],
  ["Diamond Lube 5 Ltr", "lubricant", 0, 3600, null as any], ["Dimond 07", "lubricant", 0, 500, null as any], ["Gear Lube M6", "lubricant", 0, 2500, null as any],
  ["Havoline 0W20 4Ltr", "lubricant", 0, 10000, "Caltex"], ["Havoline 20W40 07", "lubricant", 0, 850, "Caltex"], ["Havoline 20W40 1Ltr", "lubricant", 0, 1200, "Caltex"], ["Havoline 20W50 3 Ltr", "lubricant", 0, 4500, "Caltex"],
  ["Havoline Formula 10W30 3 Ltr", "lubricant", 0, 5500, "Caltex"], ["Havoline Motor Oil 4 Ltr", "lubricant", 0, 6000, "Caltex"], ["Havoline Super 1Ltr", "lubricant", 0, 1400, "Caltex"],
  ["Motar Oil 30/40", "lubricant", 0, 8000, null as any], ["Rimula R2 EXtra 4 ltr", "lubricant", 0, 4500, "Shell"], ["Target 07", "lubricant", 0, 650, null as any],
  ["Toyota Filter 23390 0LO70", "filter", 0, 2000, "Toyota"], ["Victory HD Plus", "lubricant", 0, 2400, null as any], ["Walvo 08", "lubricant", 0, 650, null as any], ["Walvo Extra 07", "lubricant", 0, 600, null as any],
  ["Zic X7 3 ltr", "lubricant", 0, 6000, "ZIC"], ["Zic X7 4 ltr", "lubricant", 0, 8000, "ZIC"],
];
export function seedCatalog() {
  const ts = now();
  // additive: a starter row is inserted only when no row of that name exists (active or removed), so edits and removals stick
  tx(() => { STARTER.forEach(([name, category, cost, price, brand], i) => run("INSERT OR IGNORE INTO catalog_items (name,category,brand,unit,cost,price,sort,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", name, category, brand ?? null, "pc", cost, price, i, "starter", ts, ts)); });
}

type Up = { name: string; category?: string | null; brand?: string | null; unit?: string | null; cost?: number | null; price?: number | null; sku?: string | null; barcode?: string | null };
/** Insert or refresh by name (case-insensitive). Prices only move when the incoming row has one. */
export function upsertCatalog(rows: Up[], source: string) {
  let added = 0, updated = 0;
  const ts = now();
  tx(() => {
    for (const r of rows) {
      const name = String(r.name ?? "").trim().replace(/\s+/g, " ");
      if (name.length < 2) continue;
      const cat = (r.category ?? "other").toString().trim().toLowerCase() || "other";
      const hit = get("SELECT * FROM catalog_items WHERE name=? COLLATE NOCASE", name);
      if (hit) {
        run("UPDATE catalog_items SET category=?, brand=COALESCE(?,brand), unit=COALESCE(?,unit), cost=CASE WHEN ?>0 THEN ? ELSE cost END, price=CASE WHEN ?>0 THEN ? ELSE price END, sku=COALESCE(?,sku), barcode=COALESCE(?,barcode), active=1, updated_at=? WHERE id=?",
          cat, r.brand ?? null, r.unit ?? null, r.cost ?? 0, r.cost ?? 0, r.price ?? 0, r.price ?? 0, r.sku ?? null, r.barcode ?? null, ts, hit.id);
        updated++;
      } else {
        run("INSERT INTO catalog_items (name,category,brand,unit,cost,price,sku,barcode,sort,source,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          name, cat, r.brand ?? null, r.unit ?? "pc", Number(r.cost ?? 0), Number(r.price ?? 0), r.sku ?? null, r.barcode ?? null, 1000, source, ts, ts);
        added++;
      }
    }
  });
  return { added, updated };
}
seedCatalog(); // the starter list on first run, wherever the catalog module is loaded from
const list = () => all("SELECT * FROM catalog_items WHERE active=1 ORDER BY category, sort, name COLLATE NOCASE");

/* ================= platform (super admin) ================= */
export const catalogPlatform = Router();
catalogPlatform.get("/catalog", h(() => ({ items: list(), categories: [...new Set(list().map((x) => x.category))] })));
const rowBody = z.object({ name: z.string().min(2).max(80), category: z.string().max(40).default("other"), brand: z.string().max(40).optional().nullable(), unit: z.string().max(12).optional().nullable(),
  cost: z.number().min(0).default(0), price: z.number().min(0).default(0), sku: z.string().max(40).optional().nullable(), barcode: z.string().max(40).optional().nullable() });
catalogPlatform.post("/catalog", h((req) => { const b = parse(rowBody, req.body); const r = upsertCatalog([b], "manual"); return { ...r, items: list() }; }));
catalogPlatform.put("/catalog/:id", h((req) => {
  const b = parse(rowBody.partial(), req.body);
  const it = get("SELECT * FROM catalog_items WHERE id=?", Number(req.params.id));
  if (!it) throw new AppError(404, "Item nahi mila");
  if (b.name && get("SELECT id FROM catalog_items WHERE name=? COLLATE NOCASE AND id<>?", b.name.trim(), it.id)) throw new AppError(400, "Is naam ka item pehle se hai");
  run("UPDATE catalog_items SET name=?, category=?, brand=?, unit=?, cost=?, price=?, sku=?, barcode=?, updated_at=? WHERE id=?",
    b.name?.trim() ?? it.name, b.category ?? it.category, b.brand === undefined ? it.brand : b.brand, b.unit ?? it.unit, b.cost ?? it.cost, b.price ?? it.price, b.sku === undefined ? it.sku : b.sku, b.barcode === undefined ? it.barcode : b.barcode, now(), it.id);
  return get("SELECT * FROM catalog_items WHERE id=?", it.id);
}));
catalogPlatform.delete("/catalog/:id", h((req) => { run("UPDATE catalog_items SET active=0, updated_at=? WHERE id=?", now(), Number(req.params.id)); return { ok: true }; }));
/** Paste from Excel: name, category, cost, price, brand, unit — tab / comma / semicolon separated, header row optional. */
catalogPlatform.post("/catalog/bulk", h((req) => {
  const b = parse(z.object({ text: z.string().min(2).max(2_000_000) }), req.body);
  const lines = b.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sep = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
  let cols = ["name", "category", "cost", "price", "brand", "unit"];
  const first = lines[0].split(sep).map((x) => x.trim().toLowerCase());
  if (first.includes("name") || first.includes("item")) { cols = first.map((c) => (c === "item" ? "name" : c)); lines.shift(); }
  const rows: Up[] = lines.map((l) => { const v = l.split(sep).map((x) => x.trim().replace(/^"|"$/g, "")); const o: any = {}; cols.forEach((c, i) => { o[c] = v[i]; }); return { name: o.name, category: o.category || "other", brand: o.brand || null, unit: o.unit || "pc", cost: Number(o.cost) || 0, price: Number(o.price) || 0, sku: o.sku || null, barcode: o.barcode || null }; });
  return { ...upsertCatalog(rows, "paste"), rows: rows.length, items: list() };
}));
/** Copy one pump's shop items (names, categories, prices) into the master list. */
catalogPlatform.post("/catalog/from-tenant/:id", h((req) => {
  const t = get("SELECT id, name FROM tenants WHERE id=?", Number(req.params.id));
  if (!t) throw new AppError(404, "Pump nahi mila");
  const rows = all("SELECT name, category, unit, cost, price, sku, barcode FROM shop_items WHERE tenant_id=? AND active=1", t.id);
  return { ...upsertCatalog(rows, `pump:${t.id}`), rows: rows.length, pump: t.name, items: list() };
}));
/** An old PumpAI backup (.db) uploaded as the raw body: its shop_items go into the master list (read-only, file removed after). */
catalogPlatform.post("/catalog/from-backup", h((req) => {
  const buf: Buffer | undefined = (req as any).body instanceof Buffer ? (req as any).body : undefined;
  if (!buf || buf.length < 100) throw new AppError(400, "Backup file (.db) upload karein");
  if (buf.subarray(0, 15).toString("latin1") !== "SQLite format 3") throw new AppError(400, "Ye SQLite database file nahi hai");
  const tmp = path.join(os.tmpdir(), `catalog-import-${Date.now()}.db`);
  fs.writeFileSync(tmp, buf);
  try {
    const src = new DatabaseSync(tmp, { readOnly: true });
    try {
      if (!src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shop_items'").get()) throw new AppError(400, "Is backup me shop_items table nahi");
      const cols = (src.prepare("PRAGMA table_info(shop_items)").all() as any[]).map((c) => c.name);
      const has = (c: string) => cols.includes(c);
      const rows = src.prepare(`SELECT name, ${has("category") ? "category" : "'other' category"}, ${has("unit") ? "unit" : "'pc' unit"}, ${has("cost") ? "cost" : "0 cost"}, price, ${has("sku") ? "sku" : "NULL sku"}, ${has("barcode") ? "barcode" : "NULL barcode"} FROM shop_items ${has("active") ? "WHERE active=1" : ""}`).all() as Up[];
      return { ...upsertCatalog(rows, "backup"), rows: rows.length, items: list() };
    } finally { src.close(); }
  } finally { try { fs.unlinkSync(tmp); } catch { /* */ } }
}));

/* ================= pump side ================= */
export const catalogTenant = Router();
/** The master list with "already in this station's shop" flags. */
catalogTenant.get("/catalog", requirePerm("stock.manage"), h((req) => {
  const sid = Number(req.query.station_id);
  const mine = sid ? all("SELECT lower(name) n FROM shop_items WHERE tenant_id=? AND station_id=? AND active=1", tid(req), sid).map((x) => x.n) : [];
  const have = new Set(mine);
  return { items: list().map((x) => ({ ...x, in_shop: have.has(String(x.name).toLowerCase()) })) };
}));
/** Pull chosen catalog items into this station's shop (stock 0; opening qty comes via stock-in). Price can be overridden per row. */
catalogTenant.post("/catalog/import", requirePerm("stock.manage"), h((req) => {
  const b = parse(z.object({ station_id: z.number().int(), rows: z.array(z.object({ id: z.number().int(), price: z.number().min(0).optional(), cost: z.number().min(0).optional() })).min(1).max(1000) }), req.body);
  const t = tid(req);
  if (!get("SELECT id FROM stations WHERE id=? AND tenant_id=?", b.station_id, t)) throw new AppError(400, "Station not found");
  const cats = new Set(lookupKeys(t, "shop_category"));
  let added = 0, skipped = 0, noPrice = 0;
  const made: string[] = [];
  tx(() => {
    for (const r of b.rows) {
      const c = get("SELECT * FROM catalog_items WHERE id=? AND active=1", r.id);
      if (!c) continue;
      const price = Number(r.price ?? c.price) || 0;
      if (price <= 0) { noPrice++; continue; }
      if (get("SELECT id FROM shop_items WHERE tenant_id=? AND station_id=? AND lower(name)=lower(?)", t, b.station_id, c.name)) { skipped++; continue; }
      if (!cats.has(c.category)) { // the pump's own category list gets the new head so the item files correctly
        run("INSERT OR IGNORE INTO lookups (tenant_id,kind,key,label,extra,sort,active) VALUES (?,?,?,?,'{}',99,1)", t, "shop_category", c.category, c.category.charAt(0).toUpperCase() + c.category.slice(1));
        cats.add(c.category);
      }
      run("INSERT INTO shop_items (tenant_id,station_id,sku,barcode,name,category,unit,cost,price,stock,reorder_level,created_at) VALUES (?,?,?,?,?,?,?,?,?,0,0,?)",
        t, b.station_id, c.sku ?? null, null, c.name, c.category, c.unit ?? "pc", Number(r.cost ?? c.cost) || 0, price, now());
      added++; made.push(c.name);
    }
  });
  return { added, skipped, no_price: noPrice, names: made.slice(0, 20) };
}));
