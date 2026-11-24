/** Wholesale entries are findable and reversible: IDs for every entry, own-tank unload vouchers, clear full-tank refusal, cascade reversal. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-pbill-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server; let base = ""; let db: typeof import("../src/db.js");
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, m: string) => { assert.equal(r.status, 200, `${m}: ${JSON.stringify(r.data)}`); return r.data; };
const near = (a: number, b: number, m?: string) => assert.ok(Math.abs(a - b) < 0.05, `${m ?? ""} ${a} ≈ ${b}`);
const round2 = (n: number) => Math.round(n * 100) / 100;
const books = async () => { const b = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(b.ok, true, JSON.stringify(b.checks.filter((c: any) => !c.ok))); };
const cashNow = async () => ok(await call("admin", "GET", "/api/cash"), "cash").cash_in_hand as number;
const dayAgo = (n: number) => new Date(Date.now() - n * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman", "wholesale", "cashier"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("Parchi Billing: many parchiyan at once (fuel at that day's rate, shop items), only the khata moves, the book shows paid / unpaid oldest-first, void, books level", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cid = (db.run("INSERT INTO customers (tenant_id,name,phone,type,balance,credit_limit,created_at) VALUES (?,?,?,?,?,?,?)", t, "Parchi Test Customer", "923000000777", "retail", 0, 100000, new Date().toISOString()) as any).id;
  const c = db.get("SELECT id, balance, credit_limit FROM customers WHERE id=?", cid)!;
  const item = db.get("SELECT id, name, price, stock FROM shop_items WHERE tenant_id=? AND active=1 AND price > 0 ORDER BY id LIMIT 1", t)!;
  const day = (n: number) => new Date(Date.now() - n * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);
  // a price change 3 days ago: a parchi dated before it takes the old rate
  db.run("INSERT INTO prices (tenant_id,product,price,effective_from,created_by) VALUES (?,?,?,?,?)", t, "PMG", 250, new Date(Date.now() - 10 * 86_400_000).toISOString(), "test");
  db.run("INSERT INTO prices (tenant_id,product,price,effective_from,created_by) VALUES (?,?,?,?,?)", t, "PMG", 270, new Date(Date.now() - 3 * 86_400_000).toISOString(), "test");
  const meta = ok(await call("manager", "GET", `/api/parchi/meta?customer_id=${c.id}`), "meta");
  assert.ok(meta.items.length > 0 && meta.customer.id === c.id && Array.isArray(meta.vehicles));
  near(ok(await call("manager", "GET", `/api/parchi/rates?date=${day(5)}`), "rates").PMG, 250, "5 days ago: old rate");
  const snap = () => ({ sales: db.get("SELECT COUNT(*) n FROM sales")!.n, tanks: db.get("SELECT COALESCE(SUM(current_l),0) v FROM tanks")!.v,
    stock: db.get("SELECT stock FROM shop_items WHERE id=?", item.id)!.stock, shop: db.get("SELECT COUNT(*) n FROM shop_sales")!.n });
  const before = snap(); const cash0 = await cashNow();
  for (const who of ["salesman", "cashier"]) assert.notEqual((await call(who, "POST", "/api/parchi/batch", { customer_id: c.id, lines: [{ parchi_date: day(0), kind: "fuel", product: "PMG", qty: 1 }] })).status, 200, who);
  assert.equal((await call("manager", "POST", "/api/parchi/batch", { customer_id: c.id, lines: [{ parchi_date: day(-1), kind: "fuel", product: "PMG", qty: 1 }] })).status, 400, "no future date");
  const r = ok(await call("manager", "POST", "/api/parchi/batch", { customer_id: c.id, note: "Haji sahib", lines: [
    { parchi_date: day(5), slip_no: "245", vehicle_no: "LEH-677", kind: "fuel", product: "PMG", qty: 40 },
    { parchi_date: day(1), slip_no: "246", vehicle_no: "LEH-677", kind: "fuel", product: "PMG", qty: 25 },
    { parchi_date: day(0), slip_no: "248", vehicle_no: "LES-0981", kind: "shop", item_id: item.id, qty: 2 },
  ] }), "batch");
  assert.equal(r.ids.length, 3); assert.match(r.entry_ids[0], /^PR-\d+$/);
  const want = 40 * 250 + 25 * 270 + 2 * item.price;
  near(r.total, want, "fuel at each day's rate + shop at item price");
  near(db.get("SELECT balance FROM customers WHERE id=?", c.id)!.balance, c.balance + want);
  assert.deepEqual(snap(), before, "no sale, no tank, no shop stock, no shop sale"); near(await cashNow(), cash0, "no cash");
  const k = db.get("SELECT * FROM khata_ledger WHERE ref=?", r.entry_ids[0])!;
  assert.equal(k.type, "debit"); assert.equal(k.litres, null); assert.match(k.note, /🎫 Parchi · 40 L Petrol/);
  assert.equal(new Date(Date.parse(k.created_at) + 5 * 3600_000).toISOString().slice(0, 10), day(5), "khata dated the parchi's day");
  await books();
  // payment later: the oldest parchi is cleared first
  const owedBefore = ok(await call("manager", "GET", `/api/parchi/book?customer_id=${c.id}`), "book");
  const oldest = owedBefore.rows.find((x: any) => x.id === r.ids[0]);
  const pay = 40 * 250; // exactly the oldest parchi
  if (pay > 0) db.run("INSERT INTO khata_ledger (customer_id,type,amount,ref,note,created_at) VALUES (?,?,?,?,?,?)", c.id, "credit", pay, "cash", "payment", new Date().toISOString());
  db.run("UPDATE customers SET balance = balance - ? WHERE id=?", Math.max(0, pay), c.id);
  const book = ok(await call("manager", "GET", `/api/parchi/book?customer_id=${c.id}`), "book2");
  assert.equal(book.rows.find((x: any) => x.id === r.ids[0]).status, "paid", `oldest paid (was ${oldest.status})`);
  assert.equal(book.rows.find((x: any) => x.id === r.ids[1]).status, "unpaid");
  // edit a mistake: wrong gaari, wrong litres, wrong day — the khata row and the balance follow
  const bal0 = db.get("SELECT balance FROM customers WHERE id=?", c.id)!.balance;
  assert.notEqual((await call("cashier", "PATCH", `/api/parchi/${r.ids[1]}`, { parchi_date: day(1), kind: "fuel", product: "PMG", qty: 30 })).status, 200, "cashier cannot edit");
  assert.equal((await call("manager", "PATCH", `/api/parchi/${r.ids[1]}`, { parchi_date: day(-1), kind: "fuel", product: "PMG", qty: 30 })).status, 400, "no future date on edit");
  const e = ok(await call("manager", "PATCH", `/api/parchi/${r.ids[1]}`, { parchi_date: day(5), slip_no: "246A", vehicle_no: "LES-0981", kind: "fuel", product: "PMG", qty: 30, reason: "litre ghalat" }), "edit");
  near(e.amount, 30 * 250, "moved to 5 days back: old rate"); near(e.diff, 30 * 250 - 25 * 270);
  near(db.get("SELECT balance FROM customers WHERE id=?", c.id)!.balance, bal0 + e.diff, "balance follows the edit");
  const k2 = db.get("SELECT * FROM khata_ledger WHERE ref=?", r.entry_ids[1])!;
  near(k2.amount, 30 * 250); assert.equal(k2.vehicle_no, "LES-0981"); assert.equal(k2.slip_no, "246A"); assert.match(k2.note, /30 L Petrol/);
  assert.equal(new Date(Date.parse(k2.created_at) + 5 * 3600_000).toISOString().slice(0, 10), day(5), "khata re-dated");
  const pl = db.get("SELECT * FROM parchi_lines WHERE id=?", r.ids[1])!; assert.equal(pl.vehicle_no, "LES-0981"); near(pl.qty, 30);
  // typed rate, and fuel → shop
  const e2 = ok(await call("manager", "PATCH", `/api/parchi/${r.ids[1]}`, { parchi_date: day(5), kind: "shop", item_id: item.id, qty: 3, rate: 100 }), "edit2");
  near(e2.amount, 300); near(db.get("SELECT balance FROM customers WHERE id=?", c.id)!.balance, bal0 + e.diff + e2.diff);
  assert.equal(db.get("SELECT stock FROM shop_items WHERE id=?", item.id)!.stock, before.stock, "edit does not touch shop stock");
  await books();
  // wrong customer: the parchi moves to the right khata, both balances follow
  const c2 = (db.run("INSERT INTO customers (tenant_id,name,phone,type,balance,credit_limit,created_at) VALUES (?,?,?,?,?,?,?)", t, "Parchi Sahi Customer", "923000000778", "retail", 0, 0, new Date().toISOString()) as any).id;
  const b1 = db.get("SELECT balance FROM customers WHERE id=?", c.id)!.balance;
  const mv = ok(await call("manager", "PATCH", `/api/parchi/${r.ids[1]}`, { customer_id: c2, parchi_date: day(5), kind: "shop", item_id: item.id, qty: 3, rate: 120 }), "move");
  assert.equal(mv.moved, true);
  near(db.get("SELECT balance FROM customers WHERE id=?", c.id)!.balance, b1 - 300, "old customer loses the old amount");
  near(db.get("SELECT balance FROM customers WHERE id=?", c2)!.balance, 360, "right customer gets the new amount");
  assert.equal(db.get("SELECT customer_id FROM khata_ledger WHERE ref=?", r.entry_ids[1])!.customer_id, c2);
  assert.equal(ok(await call("manager", "GET", `/api/parchi/book?customer_id=${c2}`), "b-c2").rows.length, 1);
  await books();
  // void a mistake: its charge goes, the balance comes down, the book keeps it as void
  const bal = db.get("SELECT balance FROM customers WHERE id=?", c.id)!.balance;
  ok(await call("manager", "POST", `/api/parchi/${r.ids[2]}/void`, { reason: "ghalat item" }), "void");
  near(db.get("SELECT balance FROM customers WHERE id=?", c.id)!.balance, bal - 2 * item.price);
  assert.equal(db.get("SELECT COUNT(*) n FROM khata_ledger WHERE ref=?", r.entry_ids[2])!.n, 0);
  assert.equal(ok(await call("manager", "GET", `/api/parchi/book?customer_id=${c.id}&voided=1`), "b3").rows.find((x: any) => x.id === r.ids[2]).status, "void");
  await books();
});

test("Gari statement (khata / wholesale / supplier) and the Parchi Book filters + PDF", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cid = (db.run("INSERT INTO customers (tenant_id,name,phone,type,balance,credit_limit,created_at) VALUES (?,?,?,?,?,?,?)", t, "Gari Test Customer", "923000000779", "retail", 0, 500000, new Date().toISOString()) as any).id;
  const day = (n: number) => new Date(Date.now() - n * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);
  const r = ok(await call("manager", "POST", "/api/parchi/batch", { customer_id: cid, lines: [
    { parchi_date: day(3), slip_no: "11", vehicle_no: "LEH-453", kind: "fuel", product: "PMG", qty: 10, rate: 260 },
    { parchi_date: day(2), slip_no: "12", vehicle_no: "leh 453", kind: "fuel", product: "HSD", qty: 20, rate: 270 },
    { parchi_date: day(1), slip_no: "13", vehicle_no: "LES-9", kind: "fuel", product: "PMG", qty: 5, rate: 260 },
  ] }), "batch");
  db.run("INSERT INTO khata_ledger (customer_id,type,amount,ref,note,vehicle_no,created_at) VALUES (?,?,?,?,?,?,?)", cid, "credit", 1000, "cash", "payment", "LEH453", new Date().toISOString());
  const vs = ok(await call("manager", "GET", `/api/vehicle-statement/vehicles?party=khata&id=${cid}`), "vehicles");
  assert.equal(vs.find((v: any) => v.vehicle.replace(/[^A-Z0-9]/g, "") === "LEH453").entries, 3, "one gaari however it was written");
  const s = ok(await call("manager", "GET", `/api/vehicle-statement?party=khata&id=${cid}&vehicle=LEH-453`), "stmt");
  assert.equal(s.totals.entries, 3); near(s.totals.debit, 10 * 260 + 20 * 270); near(s.totals.credit, 1000); near(s.totals.litres, 30);
  near(s.totals.net, 10 * 260 + 20 * 270 - 1000); assert.equal(s.totals.by_item.length, 2);
  const ranged = ok(await call("manager", "GET", `/api/vehicle-statement?party=khata&id=${cid}&vehicle=LEH-453&from=${day(2)}&to=${day(2)}`), "ranged");
  assert.equal(ranged.totals.entries, 1, "date range");
  const pdf = await fetch(`${base}/api/docs/khata_vehicle/${cid}/pdf?vehicle=LEH-453`, { headers: { authorization: `Bearer ${tokens.manager}` } });
  assert.equal(pdf.status, 200); assert.match(pdf.headers.get("content-type") ?? "", /pdf/);
  assert.notEqual((await call("salesman", "GET", `/api/vehicle-statement?party=khata&id=${cid}&vehicle=LEH-453`)).status, 200, "salesman refused");
  // wholesale + supplier: whatever vehicle the demo data has
  const w = db.get("SELECT client_id, vehicle_no FROM wholesale_txns WHERE voided=0 AND vehicle_no IS NOT NULL AND TRIM(vehicle_no)<>'' LIMIT 1");
  if (w) {
    const ws = ok(await call("admin", "GET", `/api/vehicle-statement?party=wholesale&id=${w.client_id}&vehicle=${encodeURIComponent(w.vehicle_no)}`), "ws");
    const n = db.all("SELECT vehicle_no FROM wholesale_txns WHERE client_id=? AND voided=0", w.client_id).filter((x: any) => String(x.vehicle_no ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "") === String(w.vehicle_no).toUpperCase().replace(/[^A-Z0-9]/g, "")).length;
    assert.equal(ws.totals.entries, n);
    assert.equal((await fetch(`${base}/api/docs/wholesale_vehicle/${w.client_id}/pdf?vehicle=${encodeURIComponent(w.vehicle_no)}`, { headers: { authorization: `Bearer ${tokens.admin}` } })).status, 200);
  }
  const sp = db.get("SELECT x.supplier_id, d.tanker_no FROM supplier_txns x JOIN deliveries d ON d.id=x.delivery_id WHERE d.tanker_no IS NOT NULL AND TRIM(d.tanker_no)<>'' LIMIT 1");
  if (sp) {
    const ss = ok(await call("admin", "GET", `/api/vehicle-statement?party=supplier&id=${sp.supplier_id}&vehicle=${encodeURIComponent(sp.tanker_no)}`), "ss");
    assert.ok(ss.totals.entries >= 1 && ss.totals.debit > 0);
  }
  // Parchi Book filters
  const bk = (qs: string) => call("manager", "GET", `/api/parchi/book?customer_id=${cid}&${qs}`).then((x) => ok(x, qs));
  assert.equal((await bk("vehicle=leh453")).rows.length, 2, "gaari filter");
  assert.equal((await bk("product=HSD")).rows.length, 1);
  assert.equal((await bk("q=LES")).rows.length, 1, "text");
  assert.equal((await bk("min=2000")).rows.length, 2, "amount range");
  assert.equal((await bk("status=open")).rows.length, 3, "unpaid + part");
  assert.equal((await bk("status=part")).rows.length, 1, "the 1000 payment part-paid the oldest");
  ok(await call("manager", "POST", `/api/parchi/${r.ids[2]}/void`, { reason: "test delete" }), "void");
  assert.equal((await bk("status=void")).rows.length, 1, "deleted on asking");
  const bpdf = await fetch(`${base}/api/docs/parchi_book/${cid}/pdf?filter=${encodeURIComponent(JSON.stringify({ vehicle: "LEH-453" }))}`, { headers: { authorization: `Bearer ${tokens.manager}` } });
  assert.equal(bpdf.status, 200);
  const all0 = await fetch(`${base}/api/docs/parchi_book/0/pdf`, { headers: { authorization: `Bearer ${tokens.manager}` } });
  assert.equal(all0.status, 200, "all customers");
  const rc = await fetch(`${base}/api/docs/parchi_receipt/${r.ids[0]}/pdf`, { headers: { authorization: `Bearer ${tokens.manager}` } });
  assert.equal(rc.status, 200, "parchi receipt"); assert.match(rc.headers.get("content-type") ?? "", /pdf/);
  // a parchi written as money: exactly that amount on the khata
  const m = ok(await call("manager", "POST", "/api/parchi/batch", { customer_id: cid, lines: [{ parchi_date: day(0), kind: "fuel", product: "PMG", qty: 19.048, rate: 262.5, amount: 5000 }] }), "by amount");
  near(m.total, 5000); near(db.get("SELECT amount FROM khata_ledger WHERE ref=?", m.entry_ids[0])!.amount, 5000);
});

test("Parchi: customer rate card, batch tag, aging and the dashboard summary", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cid = (db.run("INSERT INTO customers (tenant_id,name,phone,type,balance,credit_limit,created_at,khata_rates) VALUES (?,?,?,?,?,?,?,?)", t, "Rate Card Customer", "923000000780", "retail", 0, 900000, new Date().toISOString(),
    JSON.stringify({ HSD: { mode: "minus", value: 5 } })) as any).id;
  const day = (n: number) => new Date(Date.now() - n * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);
  const board = ok(await call("manager", "GET", `/api/parchi/rates?date=${day(0)}`), "board").HSD;
  near(ok(await call("manager", "GET", `/api/parchi/rates?date=${day(0)}&customer_id=${cid}`), "card").HSD, board - 5, "pump − 5 card");
  const meta = ok(await call("manager", "GET", `/api/parchi/meta?customer_id=${cid}`), "meta");
  near(meta.rates.HSD, board - 5); near(meta.board_rates.HSD, board);
  const r = ok(await call("manager", "POST", "/api/parchi/batch", { customer_id: cid, tag: "Site B", lines: [
    { parchi_date: day(0), kind: "fuel", product: "HSD", qty: 10 }, { parchi_date: day(100), kind: "fuel", product: "PMG", qty: 2, rate: 250 }, { parchi_date: day(45), kind: "fuel", product: "PMG", qty: 4, rate: 250 } ] }), "batch");
  near(r.total, 10 * (board - 5) + 500 + 1000, "the card rate on the parchi");
  assert.ok(ok(await call("manager", "GET", "/api/parchi/meta"), "tags").tags.includes("Site B"));
  assert.equal(ok(await call("manager", "GET", `/api/parchi/book?customer_id=${cid}&tag=site b`), "tag").rows.length, 3, "tag filter");
  assert.equal(ok(await call("manager", "GET", `/api/parchi/book?customer_id=${cid}&older=90`), "older").rows.length, 1, "unpaid over 90 days");
  const ag = ok(await call("manager", "GET", `/api/parchi/aging?customer_id=${cid}`), "aging");
  near(ag.buckets.d90, 500); near(ag.buckets.d31_60, 1000); near(ag.buckets.d0_30, 10 * (board - 5)); assert.equal(ag.customers[0].oldest_days, 100);
  // edit keeps the card rate; a tag can be changed
  const e = ok(await call("manager", "PATCH", `/api/parchi/${r.ids[0]}`, { parchi_date: day(0), kind: "fuel", product: "HSD", qty: 20, tag: "Site C" }), "edit");
  near(e.amount, 20 * (board - 5));
  assert.equal(db.get("SELECT tag FROM parchi_lines WHERE id=?", r.ids[0])!.tag, "Site C");
  const sm = ok(await call("manager", "GET", "/api/parchi/summary"), "summary");
  assert.ok(sm.month.n >= 1 && sm.unpaid > 0 && sm.over90 >= 500 && sm.top.length >= 1);
  assert.notEqual((await call("cashier", "GET", "/api/parchi/summary")).status, 200, "manager / CEO only");
  await books();
});
