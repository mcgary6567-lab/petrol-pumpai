/** (1) A pump-side supplier purchase that was really a wholesale client's own fuel moves to the client (client due down,
 *  old supplier's payable down, books 0); refused once the supplier was paid. (2) The wholesale officer edits the rate /
 *  vehicle of a POS-nozzle wholesale supply; litres stay; a non-POS entry is refused for the officer. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-cshift-"));
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

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "wholesale", "salesman"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("supplier purchase → client: due and payable move, books tally, refused when supplier already paid", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const sup = ok(await call("admin", "POST", "/api/suppliers", { name: "Shift Test Depot", phone: "03001230001" }), "sup");
  const client = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "Shift Test Client", phone: "03001230002", type: "business", credit_limit: 5_000_000 }), "client");
  const stId = db.get("SELECT id FROM stations WHERE tenant_id=? ORDER BY id LIMIT 1", t)!.id as number;
  // a plain supplier purchase (no stock move) — the kind a manual depot bill makes
  const pid = db.run("INSERT INTO supplier_txns (tenant_id,supplier_id,type,product,litres,rate,amount,ref,created_by,txn_date,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    t, sup.id, "purchase", "HSD", 1000, 250, 250_000, "INV-SHIFT", "test", db.now(), db.now()).id;
  void stId;
  const owed0 = Number(ok(await call("admin", "GET", "/api/suppliers"), "sups").find((s: any) => s.id === sup.id).owed);
  near(owed0, 250_000, "purchase is owed to the supplier");
  const c0 = ok(await call("admin", "GET", `/api/wholesale/clients/${client.id}`), "client0"); const due0 = Number(c0.summary?.due ?? c0.due ?? 0);
  // the officer cannot shift (CEO entries.edit)
  assert.equal((await call("wholesale", "POST", `/api/suppliers/txns/${pid}/to-client`, { client_id: client.id, reason: "client ka maal" })).status, 403);
  const r = ok(await call("admin", "POST", `/api/suppliers/txns/${pid}/to-client`, { client_id: client.id, reason: "client ka maal tha" }), "shift");
  near(r.old_supplier_owed, 0, "old supplier no longer owed");
  near(r.client_due, due0 - 250_000, "client due down by the fuel value");
  await books();
  // the client's own supplier card nets to zero (purchase + settlement)
  const linked = db.get("SELECT id FROM suppliers WHERE tenant_id=? AND client_id=?", t, client.id)!;
  near(Number(ok(await call("admin", "GET", "/api/suppliers"), "sups2").find((s: any) => s.id === linked.id)?.owed ?? 0), 0, "client-supplier card square");
  // shifting again is refused
  assert.equal((await call("admin", "POST", `/api/suppliers/txns/${pid}/to-client`, { client_id: client.id, reason: "dobara" })).status, 400);
  // a purchase the supplier was already paid for cannot be shifted
  const pid2 = db.run("INSERT INTO supplier_txns (tenant_id,supplier_id,type,product,litres,rate,amount,ref,created_by,txn_date,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    t, sup.id, "purchase", "HSD", 100, 250, 25_000, "INV-PAID", "test", db.now(), db.now()).id;
  ok(await call("admin", "POST", `/api/suppliers/${sup.id}/payment`, { amount: 25_000, method: "Bank transfer" }), "pay");
  const refused = await call("admin", "POST", `/api/suppliers/txns/${pid2}/to-client`, { client_id: client.id, reason: "test" });
  assert.equal(refused.status, 400); assert.match(refused.data.error, /adaigi/);
  await books();
});

test("wholesale officer edits a POS-nozzle supply (rate / vehicle), litres stay; non-POS entry refused; books tally", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const st = db.get("SELECT id FROM stations WHERE tenant_id=? ORDER BY id LIMIT 1", t)!.id as number;
  const client = ok(await call("admin", "POST", "/api/wholesale/clients", { name: "POS Edit Client", phone: "03001230003", type: "business", credit_limit: 5_000_000 }), "client");
  ok(await call("admin", "PUT", `/api/wholesale/clients/${client.id}/rates`, { rates: { HSD: 260 } }), "rate");
  const sale = ok(await call("admin", "POST", "/api/sales", { station_id: st, product: "HSD", litres: 100, payment_method: "khata", wholesale_client_id: client.id, vehicle_no: "LEB-1" }), "pos ws sale");
  const supply = db.get("SELECT * FROM wholesale_txns WHERE sale_id=? AND type='supply' AND voided=0", sale.id)!;
  near(Number(supply.amount), 26_000, "billed at the rate card");
  // officer: rate 262 → amount follows, litres unchanged, POS row follows
  const e = ok(await call("wholesale", "POST", `/api/wholesale/txns/${supply.id}/pos-edit`, { rate: 262, vehicle_no: "leb-2", reason: "rate card ghalat tha" }), "pos edit");
  near(e.amount, 26_200, "new amount");
  const n = db.get("SELECT * FROM wholesale_txns WHERE id=?", e.txn_id)!;
  assert.equal(n.sale_id, sale.id); near(Number(n.litres), 100); assert.equal(n.vehicle_no, "LEB-2");
  assert.equal(db.get("SELECT voided FROM wholesale_txns WHERE id=?", supply.id)!.voided, 1);
  near(Number(db.get("SELECT amount FROM sales WHERE id=?", sale.id)!.amount), 26_200, "POS sale row follows");
  const cd = ok(await call("admin", "GET", `/api/wholesale/clients/${client.id}`), "c"); near(Number(cd.summary?.due ?? cd.due), 26_200, "client due = new amount");
  await books();
  // a manual (non-POS) supply is not the officer's to edit here
  const manual = ok(await call("wholesale", "POST", `/api/wholesale/clients/${client.id}/supply`, { product: "HSD", litres: 50, station_id: st }), "manual supply");
  const no = await call("wholesale", "POST", `/api/wholesale/txns/${manual.id}/pos-edit`, { rate: 1, reason: "test" });
  assert.equal(no.status, 400);
});
