/** Wholesale entries are findable and reversible: IDs for every entry, own-tank unload vouchers, clear full-tank refusal, cascade reversal. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-aging-"));
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
  for (const who of ["admin", "manager", "salesman", "wholesale"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("khata aging: an advance paid before the charges clears them, and the buckets never add up to more than the balance", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const { khataAging } = await import("../src/routes/crm.js");
  const c = db.run("INSERT INTO customers (tenant_id,name,phone,type,balance,credit_limit,created_at) VALUES (?,?,?,?,?,?,?)", t, "Majeed Test", "923000000999", "retail", 0, 100000, new Date().toISOString());
  const id = Number((c as any).id ?? (c as any).lastInsertRowid);
  const at = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  // paid 5,000 ahead, then took 3,000 + 4,100 of fuel: owes 2,100
  db.run("INSERT INTO khata_ledger (customer_id,type,amount,ref,note,created_at) VALUES (?,?,?,?,?,?)", id, "credit", 5000, "adv", "advance", at(10));
  db.run("INSERT INTO khata_ledger (customer_id,type,amount,ref,note,created_at) VALUES (?,?,?,?,?,?)", id, "debit", 3000, "S-1", "fuel", at(8));
  db.run("INSERT INTO khata_ledger (customer_id,type,amount,ref,note,created_at) VALUES (?,?,?,?,?,?)", id, "debit", 4100, "S-2", "fuel", at(2));
  db.run("UPDATE customers SET balance=2100 WHERE id=?", id);
  const row = khataAging(t).list.find((x: any) => x.id === id)!;
  assert.deepEqual(row.buckets, [2100, 0, 0, 0], "only the 2,100 still owed, in 0-30 days");
  // the page's total outstanding and the aging total are the same figure
  const ag = khataAging(t);
  const owed = db.all("SELECT balance FROM customers WHERE tenant_id=? AND balance > 0.009", t).reduce((a: number, x: any) => a + x.balance, 0);
  near(ag.total, owed, "aging total = total outstanding");
});
