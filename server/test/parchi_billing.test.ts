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
  db.run("UPDATE customers SET balance = balance - 1000 WHERE id=?", cid);
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

test("Parchi: a payment tied to chosen parchiyan pays them, not the oldest entry", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cid = (db.run("INSERT INTO customers (tenant_id,name,phone,type,balance,credit_limit,created_at) VALUES (?,?,?,?,?,?,?)", t, "Tied Pay Customer", "923000000781", "retail", 1000, 900000, new Date(Date.now() - 20 * 86_400_000).toISOString()) as any).id;
  // an older fuel charge (not a parchi) that oldest-first would clear first
  db.run("INSERT INTO khata_ledger (customer_id,type,amount,ref,note,created_at) VALUES (?,?,?,?,?,?)", cid, "debit", 1000, null, "old charge", new Date(Date.now() - 10 * 86_400_000).toISOString());
  const day = (n: number) => new Date(Date.now() - n * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);
  const r = ok(await call("manager", "POST", "/api/parchi/batch", { customer_id: cid, lines: [
    { parchi_date: day(2), kind: "fuel", product: "PMG", qty: 2, rate: 250 }, { parchi_date: day(1), kind: "fuel", product: "PMG", qty: 4, rate: 200 } ] }), "batch");
  const bal0 = db.get("SELECT balance FROM customers WHERE id=?", cid)!.balance;
  const pay = ok(await call("manager", "POST", `/api/customers/${cid}/khata`, { type: "credit", amount: 800, method: "Cash", notify: false }), "pay");
  assert.ok(pay.khata_id > 0, "payment returns its khata id");
  near(db.get("SELECT balance FROM customers WHERE id=?", cid)!.balance, bal0 - 800);
  const st = async () => Object.fromEntries(ok(await call("manager", "GET", `/api/parchi/book?customer_id=${cid}`), "book").rows.map((x: any) => [x.id, x.status]));
  assert.deepEqual(await st(), { [r.ids[0]]: "unpaid", [r.ids[1]]: "unpaid" }, "oldest-first: the 800 went to the old fuel");
  const a = ok(await call("manager", "POST", "/api/parchi/allocate", { customer_id: cid, khata_id: pay.khata_id, parchi_ids: [r.ids[1]] }), "allocate");
  near(a.allocated[0].amount, 800); near(a.left, 0);
  assert.deepEqual(await st(), { [r.ids[0]]: "unpaid", [r.ids[1]]: "paid" }, "the chosen parchi is paid");
  // the customer page's khata ledger shows the same: item / litres / rate on the parchi line, its status, and the payment names it
  const led = ok(await call("manager", "GET", `/api/customers/${cid}`), "customer").ledger;
  const p2 = led.find((x: any) => x.parchi?.id === r.ids[1]), p1 = led.find((x: any) => x.parchi?.id === r.ids[0]);
  assert.equal(p2.type, "debit", "a parchi is a charge on the khata");
  assert.deepEqual([p2.parchi.product, p2.parchi.qty, p2.parchi.rate, p2.parchi.status], ["PMG", 4, 200, "paid"]);
  assert.equal(p1.parchi.status, "unpaid");
  assert.equal(led.find((x: any) => x.id === pay.khata_id).pays_parchi, `PR-${r.ids[1]}`);
  near(db.get("SELECT balance FROM customers WHERE id=?", cid)!.balance, bal0 - 800, "money unchanged");
  const pays = ok(await call("manager", "GET", `/api/parchi/payments?customer_id=${cid}`), "payments");
  near(pays.find((x: any) => x.id === pay.khata_id).free, 0);
  assert.equal((await call("manager", "POST", "/api/parchi/allocate", { customer_id: cid, khata_id: pay.khata_id, parchi_ids: [r.ids[0]] })).status, 400, "fully tied already");
  assert.notEqual((await call("cashier", "POST", "/api/parchi/allocate", { customer_id: cid, khata_id: pay.khata_id, parchi_ids: [r.ids[0]] })).status, 200, "manager / CEO only");
  ok(await call("manager", "POST", `/api/parchi/allocate/${pay.khata_id}/clear`, {}), "clear");
  assert.deepEqual(await st(), { [r.ids[0]]: "unpaid", [r.ids[1]]: "unpaid" }, "untied: back to oldest-first");
  await books();
});

test("Parchi: history, bulk change / delete, templates, rate review, vehicle-day litres, duplicate photo", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cid = (db.run("INSERT INTO customers (tenant_id,name,phone,type,balance,credit_limit,created_at) VALUES (?,?,?,?,?,?,?)", t, "Bulk Test Customer", "923000000782", "retail", 0, 900000, new Date().toISOString()) as any).id;
  const day = (n: number) => new Date(Date.now() - n * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);
  const r = ok(await call("manager", "POST", "/api/parchi/batch", { customer_id: cid, lines: [
    { parchi_date: day(0), vehicle_no: "LEH-1", kind: "fuel", product: "PMG", qty: 10 }, { parchi_date: day(0), vehicle_no: "leh 1", kind: "fuel", product: "PMG", qty: 5 },
    { parchi_date: day(0), vehicle_no: "LES-2", kind: "fuel", product: "HSD", qty: 8 } ] }), "batch");
  // 17: litres already on a gaari that day
  const vd = ok(await call("manager", "GET", `/api/parchi/vehicle-day?customer_id=${cid}&dates=${day(0)}`), "vday");
  near(vd[`LEH1|${day(0)}`], 15, "both spellings of one gaari");
  // 28: bulk tag + gaari, then history (29)
  ok(await call("manager", "POST", "/api/parchi/bulk", { ids: [r.ids[0], r.ids[1]], field: "tag", value: "Site X" }), "bulk tag");
  ok(await call("manager", "POST", "/api/parchi/bulk", { ids: [r.ids[1]], field: "vehicle", value: "les-9" }), "bulk gaari");
  assert.equal(db.get("SELECT vehicle_no FROM khata_ledger WHERE ref=?", r.entry_ids[1])!.vehicle_no, "LES-9");
  ok(await call("manager", "POST", "/api/parchi/bulk", { ids: [r.ids[2]], field: "date", value: day(1) }), "bulk date");
  assert.equal(new Date(Date.parse(db.get("SELECT created_at FROM khata_ledger WHERE ref=?", r.entry_ids[2])!.created_at) + 5 * 3600_000).toISOString().slice(0, 10), day(1));
  assert.equal((await call("manager", "POST", "/api/parchi/bulk", { ids: [r.ids[2]], field: "date", value: day(-1) })).status, 400, "no future date");
  const hs = ok(await call("manager", "GET", `/api/parchi/${r.ids[1]}/history`), "history");
  assert.ok(hs.events.length >= 3 && hs.events[0].what === "Banai gayi");
  // 31: templates
  ok(await call("manager", "POST", "/api/parchi/templates", { customer_id: cid, name: "Site X roz", lines: [{ vehicle_no: "LEH-1", kind: "fuel", product: "PMG", qty: 10 }] }), "tpl");
  ok(await call("manager", "POST", "/api/parchi/templates", { customer_id: cid, name: "site x ROZ", lines: [{ vehicle_no: "LEH-1", kind: "fuel", product: "PMG", qty: 12 }] }), "tpl again");
  const tpl = ok(await call("manager", "GET", `/api/parchi/templates?customer_id=${cid}`), "tpls");
  assert.equal(tpl.length, 1, "same name replaces"); near(tpl[0].lines[0].qty, 12);
  // 33: rate card changes → review shows the PMG parchiyan, reprice moves khata + balance
  db.run("UPDATE customers SET khata_rates=? WHERE id=?", JSON.stringify({ PMG: { mode: "minus", value: 4 } }), cid);
  const rv = ok(await call("manager", "GET", `/api/parchi/rate-review?customer_id=${cid}`), "review");
  assert.equal(rv.rows.length, 2); near(rv.diff, -4 * 15);
  const bal0 = db.get("SELECT balance FROM customers WHERE id=?", cid)!.balance;
  const rp = ok(await call("manager", "POST", "/api/parchi/reprice", { ids: rv.rows.map((x: any) => x.id) }), "reprice");
  assert.equal(rp.changed, 2); near(db.get("SELECT balance FROM customers WHERE id=?", cid)!.balance, bal0 - 60);
  assert.equal(ok(await call("manager", "GET", `/api/parchi/rate-review?customer_id=${cid}`), "review2").rows.length, 0);
  await books();
  // 28: bulk delete
  const bd = ok(await call("manager", "POST", "/api/parchi/bulk/void", { ids: [r.ids[0], r.ids[2]], reason: "ghalat customer" }), "bulk void");
  assert.equal(bd.deleted, 2); assert.equal(db.get("SELECT COUNT(*) n FROM khata_ledger WHERE ref IN (?,?)", r.entry_ids[0], r.entry_ids[2])!.n, 0);
  await books();
  // 32: the same photo twice
  const img = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const ph1 = db.run("INSERT INTO photos (tenant_id,kind,ref,mime,data,created_at) VALUES (?,?,?,?,?,?)", t, "proof", `khata:${db.get("SELECT id FROM khata_ledger WHERE ref=?", r.entry_ids[1])!.id}`, "image/png", Buffer.from(img.split(",")[1], "base64"), new Date().toISOString()) as any;
  const ph2 = db.run("INSERT INTO photos (tenant_id,kind,ref,mime,data,created_at) VALUES (?,?,?,?,?,?)", t, "proof", null, "image/png", Buffer.from(img.split(",")[1], "base64"), new Date().toISOString()) as any;
  const pc = ok(await call("manager", "POST", "/api/parchi/photo-check", { photo_ids: [ph2.id] }), "photo check");
  assert.equal(pc.length, 1); assert.match(pc[0].dup, new RegExp(`PR-${r.ids[1]}`)); void ph1;
});

test("Parchi audit fixes: payment ties, deletes elsewhere, double save, books check", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const mk = (name: string, phone: string) => (db.run("INSERT INTO customers (tenant_id,name,phone,type,balance,credit_limit,created_at) VALUES (?,?,?,?,?,?,?)", t, name, phone, "retail", 0, 900000, new Date(Date.now() - 30 * 86_400_000).toISOString()) as any).id;
  const day = (n: number) => new Date(Date.now() - n * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);
  const status = async (cid: number) => Object.fromEntries(ok(await call("manager", "GET", `/api/parchi/book?customer_id=${cid}&voided=1`), "book").rows.map((x: any) => [x.id, x.status]));
  const bal = (cid: number) => db.get("SELECT balance FROM customers WHERE id=?", cid)!.balance as number;

  // a payment tied to the newer parchi pays IT fully (not the older one first)
  const a = mk("Audit A", "923000000790");
  const r = ok(await call("manager", "POST", "/api/parchi/batch", { customer_id: a, lines: [{ parchi_date: day(5), kind: "fuel", product: "PMG", qty: 4, rate: 250 }, { parchi_date: day(2), kind: "fuel", product: "PMG", qty: 16, rate: 250 }] }), "batch");
  const pay = ok(await call("manager", "POST", `/api/customers/${a}/khata`, { type: "credit", amount: 4000, method: "Cash", notify: false }), "pay");
  const al = ok(await call("manager", "POST", "/api/parchi/allocate", { customer_id: a, khata_id: pay.khata_id, parchi_ids: [r.ids[1], r.ids[1]] }), "allocate");
  near(al.allocated[0].amount, 4000); assert.equal(al.allocated.length, 1, "duplicate ids once");
  assert.deepEqual(await status(a), { [r.ids[0]]: "unpaid", [r.ids[1]]: "paid" });
  // deleting the tied parchi frees the payment's money
  ok(await call("manager", "POST", `/api/parchi/${r.ids[1]}/void`, { reason: "test" }), "void");
  near(ok(await call("manager", "GET", `/api/parchi/payments?customer_id=${a}`), "pays").find((x: any) => x.id === pay.khata_id).free, 4000);
  // a payment received BEFORE the parchi can still be tied to it
  const r2 = ok(await call("manager", "POST", "/api/parchi/batch", { customer_id: a, lines: [{ parchi_date: day(0), kind: "fuel", product: "PMG", qty: 2, rate: 250 }] }), "later parchi");
  ok(await call("manager", "POST", "/api/parchi/allocate", { customer_id: a, khata_id: pay.khata_id, parchi_ids: [r2.ids[0]] }), "tie earlier payment");
  assert.equal((await status(a))[r2.ids[0]], "paid");

  // moving a tied parchi to another customer drops the tie
  const b = mk("Audit B", "923000000791");
  ok(await call("manager", "PATCH", `/api/parchi/${r2.ids[0]}`, { customer_id: b, parchi_date: day(0), kind: "fuel", product: "PMG", qty: 2, rate: 250 }), "move");
  assert.equal(db.get("SELECT COUNT(*) n FROM parchi_alloc WHERE parchi_id=?", r2.ids[0])!.n, 0);
  assert.equal((await status(b))[r2.ids[0]], "unpaid");

  // corrections / full edit cannot touch a parchi's khata row
  const kid = db.get("SELECT id FROM khata_ledger WHERE ref=?", `PR-${r.ids[0]}`)!.id;
  assert.equal((await call("admin", "POST", `/api/corrections/khata/${kid}/void`, { reason: "test reason" })).status, 400, "corrections refuses parchi rows");
  // a parchi whose khata row disappears anyway (raw delete) shows as missing, never "paid", and the control check says so
  db.run("DELETE FROM khata_ledger WHERE id=?", kid); db.run("UPDATE customers SET balance = balance - 1000 WHERE id=?", a);
  assert.equal((await status(a))[r.ids[0]], "gone");
  const acc = ok(await call("manager", "GET", `/api/parchi/accounts?customer_id=${a}`), "accounts");
  assert.equal(acc.control.ok, false); assert.match(acc.control.problems[0].problem, /Khata entry nahi/);
  // a reused khata id never lets a parchi void touch someone else's row
  const c = mk("Audit C", "923000000792");
  const foreign = (db.run("INSERT INTO khata_ledger (id,customer_id,type,amount,ref,note,created_at) VALUES (?,?,?,?,?,?,?)", kid, c, "debit", 777, null, "other", new Date().toISOString()) as any);
  db.run("UPDATE customers SET balance = balance + 777 WHERE id=?", c); void foreign;
  const balA = bal(a);
  ok(await call("manager", "POST", `/api/parchi/${r.ids[0]}/void`, { reason: "test" }), "void stale");
  assert.equal(db.get("SELECT COUNT(*) n FROM khata_ledger WHERE id=?", kid)!.n, 1, "C's row untouched"); near(bal(a), balA, "A not moved again"); near(bal(c), 777);

  // the same Save twice (same browser batch id) is saved once
  const bid = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
  const s1 = ok(await call("manager", "POST", "/api/parchi/batch", { customer_id: b, batch_id: bid, lines: [{ parchi_date: day(0), kind: "fuel", product: "PMG", qty: 3, rate: 250 }] }), "s1");
  const b1 = bal(b);
  const s2 = ok(await call("manager", "POST", "/api/parchi/batch", { customer_id: b, batch_id: bid, lines: [{ parchi_date: day(0), kind: "fuel", product: "PMG", qty: 3, rate: 250 }] }), "s2");
  assert.deepEqual(s2.ids, s1.ids); assert.equal(s2.duplicate, true); near(bal(b), b1);
  // bulk delete counts only what it really deleted
  const bv = ok(await call("manager", "POST", "/api/parchi/bulk/void", { ids: [s1.ids[0], s1.ids[0], 99999999], reason: "test" }), "bulk");
  assert.equal(bv.deleted, 1);
  await books();
  // books check: two customers off in opposite directions is a failure even though the total agrees
  db.run("UPDATE customers SET balance = balance + 50 WHERE id=?", b); db.run("UPDATE customers SET balance = balance - 50 WHERE id=?", c);
  const bc = ok(await call("admin", "GET", "/api/books/check"), "check");
  assert.equal(bc.checks.find((x: any) => x.label === "Khata receivable (customers)").ok, false);
  db.run("UPDATE customers SET balance = balance - 50 WHERE id=?", b); db.run("UPDATE customers SET balance = balance + 50 WHERE id=?", c);
});

test("Parchi: voice / typed sentence → lines, and a customer's monthly parchi + payment-speed stats", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cid = (db.run("INSERT INTO customers (tenant_id,name,phone,type,balance,credit_limit,created_at) VALUES (?,?,?,?,?,?,?)", t, "Voice Customer", "923000000793", "retail", 0, 900000, new Date(Date.now() - 90 * 86_400_000).toISOString()) as any).id;
  ok(await call("manager", "POST", `/api/customers/${cid}/vehicles`, { plate_no: "LEH-453", fuel: "HSD" }), "veh");
  const v = ok(await call("manager", "POST", "/api/parchi/parse-voice", { customer_id: cid, text: "slip 245 LEH 453 pachas litre diesel, agli slip 246 gaari 453 paanch hazar ka petrol" }), "voice");
  assert.equal(v.lines.length, 2);
  assert.equal(v.lines[0].slip_no, "245"); assert.equal(v.lines[0].vehicle_no, "LEH-453"); near(v.lines[0].litres, 50); assert.equal(v.lines[0].product, "HSD");
  assert.equal(v.lines[1].slip_no, "246"); assert.equal(v.lines[1].vehicle_no, "LEH-453", "digits only → his gaari"); near(v.lines[1].amount, 5000); assert.equal(v.lines[1].product, "PMG");
  const day = (n: number) => new Date(Date.now() - n * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);
  ok(await call("manager", "POST", "/api/parchi/batch", { customer_id: cid, lines: [{ parchi_date: day(10), kind: "fuel", product: "PMG", qty: 4, rate: 250 }, { parchi_date: day(0), kind: "fuel", product: "PMG", qty: 2, rate: 250 }] }), "batch");
  ok(await call("manager", "POST", `/api/customers/${cid}/khata`, { type: "credit", amount: 1000, method: "Cash", notify: false }), "pay");
  const st = ok(await call("manager", "GET", `/api/parchi/customer-stats?customer_id=${cid}`), "stats");
  assert.equal(st.months.length, 12);
  assert.equal(st.totals.n, 2); near(st.totals.amount, 1500); near(st.totals.paid_in, 1000);
  assert.equal(st.totals.avg_days, 10, "the oldest parchi was paid 10 days after it");
});
