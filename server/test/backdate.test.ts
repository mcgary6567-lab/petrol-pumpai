/** A missed entry recorded a few days late on its REAL date: the khata charge / cashier receipt / other-entry lands in
 *  that day's books (created_at = that date), only the CEO or a manager may do it, and every book still ties. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";
import { tallyBooks } from "./helpers/tally.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-backdate-"));
process.env.DB_PATH = path.join(dir, "test.db");
process.env.NODE_ENV = "test";
process.env.ANTHROPIC_API_KEY = "";
process.env.WA_TOKEN = "";

let server: Server;
let base = "";
let db: typeof import("../src/db.js");
const tokens: Record<string, string> = {};
async function call(who: string, method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => null)) as any };
}
const ok = (r: { status: number; data: any }, msg: string) => { assert.equal(r.status, 200, `${msg}: ${JSON.stringify(r.data)}`); return r.data; };
const daysAgo = (n: number) => new Date(Date.now() + 5 * 3600_000 - n * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "salesman"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => server?.close());

test("khata charge recorded on a past date lands in that day's ledger; salesman cannot back-date; books tally", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cust = db.get("SELECT id FROM customers WHERE tenant_id=? AND credit_limit > 0 ORDER BY credit_limit DESC LIMIT 1", t)!;
  db.run("UPDATE customers SET credit_limit=100000000 WHERE id=?", cust.id);
  const when = daysAgo(3);

  // a salesman (not CEO/manager) may not back-date
  const refused = await call("salesman", "POST", `/api/customers/${cust.id}/khata`, { type: "credit", amount: 500, method: "Cash", entry_date: when });
  assert.equal(refused.status, 403, `salesman back-date must be refused: ${JSON.stringify(refused.data)}`);

  // the CEO records the missed charge on its real date
  const before = db.get("SELECT COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE -amount END),0) v FROM khata_ledger WHERE customer_id=?", cust.id)!.v as number;
  ok(await call("admin", "POST", `/api/customers/${cust.id}/khata`, { type: "debit", amount: 1200, note: "Reh gayi thi", entry_date: when }), "back-dated charge");
  const row = db.get("SELECT created_at, amount FROM khata_ledger WHERE customer_id=? ORDER BY id DESC LIMIT 1", cust.id)!;
  assert.equal(String(row.created_at).slice(0, 10), when, "ledger row carries the chosen past date");
  assert.equal(Math.round(row.amount), 1200, "amount stored");
  const after = db.get("SELECT COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE -amount END),0) v FROM khata_ledger WHERE customer_id=?", cust.id)!.v as number;
  assert.ok(Math.abs(after - before - 1200) < 0.01, "balance moved by the charge");
  await tallyBooks("after back-dated khata charge");
});

test("cashier receipt recorded on a past date dates both the voucher and its khata leg; books tally", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cust = db.get("SELECT id FROM customers WHERE tenant_id=? AND credit_limit > 0 ORDER BY credit_limit DESC LIMIT 1", t)!;
  const when = daysAgo(2);
  const r = ok(await call("admin", "POST", "/api/cashier/receive", { party_type: "khata", party_id: cust.id, amount: 800, method: "Cash", entry_date: when }), "back-dated receive");
  assert.equal(String(r.voucher.created_at).slice(0, 10), when, "voucher carries the past date");
  const leg = db.get("SELECT created_at FROM khata_ledger WHERE customer_id=? AND type='credit' ORDER BY id DESC LIMIT 1", cust.id)!;
  assert.equal(String(leg.created_at).slice(0, 10), when, "khata credit leg carries the past date");
  await tallyBooks("after back-dated cashier receive");
});

test("other-entry (CEO income) recorded on a past date; books tally", async () => {
  const when = daysAgo(4);
  const r = ok(await call("admin", "POST", "/api/other-entries", { kind: "income", party_type: "other", party_name: "Scrap wala", reason: "Purana scrap", amount: 3000, method: "Cash", entry_date: when }), "back-dated other-entry");
  const row = db.get("SELECT created_at FROM other_entries WHERE id=?", r.id)!;
  assert.equal(String(row.created_at).slice(0, 10), when, "other-entry carries the past date");
  await tallyBooks("after back-dated other-entry");
});
