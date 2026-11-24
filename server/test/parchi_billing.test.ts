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
  // void a mistake: its charge goes, the balance comes down, the book keeps it as void
  const bal = db.get("SELECT balance FROM customers WHERE id=?", c.id)!.balance;
  ok(await call("manager", "POST", `/api/parchi/${r.ids[2]}/void`, { reason: "ghalat item" }), "void");
  near(db.get("SELECT balance FROM customers WHERE id=?", c.id)!.balance, bal - 2 * item.price);
  assert.equal(db.get("SELECT COUNT(*) n FROM khata_ledger WHERE ref=?", r.entry_ids[2])!.n, 0);
  assert.equal(ok(await call("manager", "GET", `/api/parchi/book?customer_id=${c.id}&voided=1`), "b3").rows.find((x: any) => x.id === r.ids[2]).status, "void");
  await books();
});
