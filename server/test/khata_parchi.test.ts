/** Wholesale entries are findable and reversible: IDs for every entry, own-tank unload vouchers, clear full-tank refusal, cascade reversal. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-parchi-"));
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

test("sirf parchi entry: the khata goes up, nothing else moves (no fuel, stock, bag or bank), books stay level, only manager / CEO, the owner is alerted", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const c = db.get("SELECT id, balance FROM customers WHERE tenant_id=? AND credit_limit > 0 ORDER BY id LIMIT 1", t)!;
  const snap = () => ({
    sales: db.get("SELECT COUNT(*) n FROM sales")!.n, stock: db.get("SELECT COALESCE(SUM(current_l),0) v FROM tanks")!.v,
    shop: db.get("SELECT COUNT(*) n FROM shop_sales")!.n, deposits: db.get("SELECT COUNT(*) n FROM bank_deposits")!.n,
  });
  const before = snap();
  const cash0 = await cashNow();
  for (const who of ["salesman", "cashier"]) assert.notEqual((await call(who, "POST", `/api/customers/${c.id}/parchi`, { amount: 5000 })).status, 200, `${who} may not`);
  const r = ok(await call("manager", "POST", `/api/customers/${c.id}/parchi`, { amount: 7500, slip_no: "245", vehicle_no: "LEH-677", product: "HSD", litres: 25, rate: 300, note: "Majeed ki parchi" }), "parchi");
  assert.match(r.entry_id, /^K-\d+$/);
  near(db.get("SELECT balance FROM customers WHERE id=?", c.id)!.balance, c.balance + 7500, "khata up by the parchi");
  const k = db.get("SELECT * FROM khata_ledger WHERE id=?", r.id)!;
  assert.equal(k.type, "debit"); assert.equal(k.ref, `PARCHI-${r.id}`); assert.equal(k.slip_no, "245"); assert.equal(k.vehicle_no, "LEH-677");
  assert.equal(k.litres, null, "litres only in the note — no report counts them as fuel"); assert.match(k.note, /Parchi entry .* 25 L Diesel/);
  assert.deepEqual(snap(), before, "no sale, no stock, no shop, no bank movement");
  near(await cashNow(), cash0, "no cash moved");
  assert.ok(db.get("SELECT id FROM alerts WHERE type='khata_parchi' AND title LIKE ?", "%7,500%"), "owner alerted");
  const list = ok(await call("admin", "GET", "/api/khata/parchi-entries"), "list");
  assert.equal(list.rows[0].id, r.id); assert.equal(list.rows[0].by_name, db.get("SELECT name FROM users WHERE email='manager@pumpai.pk'")!.name);
  const st = ok(await call("admin", "GET", `/api/customers/${c.id}/statement`), "stmt");
  assert.ok(st.lines.some((l: any) => l.id === r.id && l.type === "debit"), "on the khata statement");
  await books();
});
