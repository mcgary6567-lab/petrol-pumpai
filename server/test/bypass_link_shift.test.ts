/** Bypass bill bought from a supplier who is really a wholesale client: shift the bill WITH the payment we made for it
 *  (option 1), and link the supplier card to the client once (the client's old card merges in). Books stay at 0 farq. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-blink-"));
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
const books = async () => { const b = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.equal(b.ok, true, JSON.stringify(b.checks.filter((c: any) => !c.ok))); };
const pkMinute = (iso: string) => new Date(Date.parse(iso) + 5 * 3600_000).toISOString().slice(0, 16);

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "manager", "salesman", "wholesale", "cashier"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("shift a paid bypass bill with its payment; partly paid bill settles only the rest on the client's khata; link merges the old card", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const st = db.get("SELECT id FROM stations WHERE tenant_id=? ORDER BY id LIMIT 1", t)!.id as number;
  const acc = ok(await call("admin", "POST", "/api/bank/accounts", { bank: "Meezan Bank", account_no: "0202 5511", opening_balance: 9_000_000 }), "bank").id;
  const S = ok(await call("admin", "POST", "/api/suppliers", { name: "Nawab And Sons Test", company: "PSO" }), "supplier");
  const C = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "Nawab FS Test", phone: "03001239411", type: "business", credit_limit: 9_000_000 }), "client");
  const bOwed = async (id: number) => ok(await call("wholesale", "GET", `/api/bypass/suppliers/${id}/statement`), "st").supplier.bypass_owed as number;
  const due = () => Number(db.get("SELECT COALESCE(SUM(CASE WHEN type IN ('supply') THEN amount WHEN type='adjustment' THEN amount WHEN type IN ('payment','return') THEN -amount ELSE 0 END),0) v FROM wholesale_txns WHERE client_id=? AND voided=0", C.id)!.v);
  // bill 1: 1,000 L @ 250 from S, then we pay S 3,00,000 (more than the bill)
  const d1 = ok(await call("admin", "POST", "/api/bypass/deliveries", { station_id: st, purchases: [{ supplier_id: S.id, product: "HSD", litres: 1000, cost_rate: 250 }] }), "bill 1");
  ok(await call("wholesale", "POST", `/api/bypass/suppliers/${S.id}/payment`, { amount: 300_000, mode: "we_pay", method: "Bank transfer", account_id: acc, ref: "TT-9" }), "pay S");
  near(await bOwed(S.id), -50_000, "S over-paid by 50k");
  const p1 = db.get("SELECT id FROM bypass_purchases WHERE delivery_id=?", d1.id)!.id;
  const chk = ok(await call("admin", "GET", `/api/bypass/purchases/${p1}/to-client/check`), "check");
  near(chk.paid, 250_000, "the whole bill was paid");
  // without the option → refused with the hint; with it → bill and payment travel together
  const no = await call("admin", "POST", `/api/bypass/purchases/${p1}/to-client`, { client_id: C.id, reason: "client ka maal" });
  assert.equal(no.status, 400); assert.match(no.data.error, /Adaigi bhi client ki/);
  const due0 = due();
  const r1 = ok(await call("admin", "POST", `/api/bypass/purchases/${p1}/to-client`, { client_id: C.id, reason: "client ka maal", with_payment: true }), "shift with payment");
  near(r1.paid_moved, 250_000); assert.equal(r1.wtx_id, null, "nothing on the client's khata");
  near(await bOwed(S.id), -50_000, "S unchanged");
  const card = db.get("SELECT id FROM suppliers WHERE client_id=?", C.id)!.id as number;
  near(await bOwed(card), 0, "client's card: bill and payment, owe 0");
  near(due(), due0, "client's due unchanged");
  near(Number(db.get("SELECT COALESCE(SUM(amount),0) v FROM bypass_supplier_payments WHERE supplier_id IN (?,?) AND voided=0", S.id, card)!.v), 300_000, "payment total unchanged (split)");
  await books();

  // bill 2: 1,000 L @ 250 again; S now owes 2,00,000 of it, so 50,000 was paid
  const d2 = ok(await call("admin", "POST", "/api/bypass/deliveries", { station_id: st, purchases: [{ supplier_id: S.id, product: "HSD", litres: 1000, cost_rate: 250 }] }), "bill 2");
  const p2 = db.get("SELECT id FROM bypass_purchases WHERE delivery_id=?", d2.id)!.id;
  const r2 = ok(await call("admin", "POST", `/api/bypass/purchases/${p2}/to-client`, { client_id: C.id, reason: "client ka maal", with_payment: true }), "partly paid");
  near(r2.paid_moved, 50_000); assert.ok(r2.wtx_id, "rest settled on the client's khata");
  near(due(), due0 - 200_000, "client's due down by the unpaid part only");
  near(await bOwed(S.id), 0); near(await bOwed(card), 0);
  await books();

  // link: S IS this client; the client's old card merges into S
  assert.equal((await call("wholesale", "POST", `/api/suppliers/${S.id}/link-client`, { client_id: C.id })).status, 403, "officer cannot");
  const l = ok(await call("admin", "POST", `/api/suppliers/${S.id}/link-client`, { client_id: C.id }), "link");
  assert.ok(l.merged && l.merged.rows > 0, "old card merged");
  assert.equal(db.get("SELECT id FROM suppliers WHERE id=?", card), undefined, "old card gone");
  assert.equal(db.get("SELECT client_id FROM suppliers WHERE id=?", S.id)!.client_id, C.id);
  near(await bOwed(S.id), 0, "S holds both bills and all payments");
  // a new bill on S is already the client's: shifting it is refused as already there
  const d3 = ok(await call("admin", "POST", "/api/bypass/deliveries", { station_id: st, purchases: [{ supplier_id: S.id, product: "HSD", litres: 100, cost_rate: 250 }] }), "bill 3");
  const p3 = db.get("SELECT id FROM bypass_purchases WHERE delivery_id=?", d3.id)!.id;
  assert.equal((await call("admin", "POST", `/api/bypass/purchases/${p3}/to-client`, { client_id: C.id, reason: "x" + "yz" })).status, 400);
  await books();
});
