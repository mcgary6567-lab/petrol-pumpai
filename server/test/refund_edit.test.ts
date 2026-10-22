/** A khata "advance wapas" refund can be viewed with its method and re-edited: change the method (cash → bank) and the
 *  cash book / bank both follow, the ledger ref stays refund:<method>, and every book still ties. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";
import { tallyBooks } from "./helpers/tally.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-refund-"));
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

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  tokens.admin = (await call("", "POST", "/api/auth/login", { email: "admin@pumpai.pk", password: "demo1234" })).data.token;
});
after(() => server?.close());

test("khata refund: method shows in the view, and editing cash → bank moves the money and keeps books tied", async () => {
  const t = db.get("SELECT id FROM tenants ORDER BY id LIMIT 1")!.id as number;
  const cust = db.get("SELECT id FROM customers WHERE tenant_id=? AND credit_limit > 0 ORDER BY credit_limit DESC LIMIT 1", t)!;
  db.run("UPDATE customers SET credit_limit=100000000 WHERE id=?", cust.id);
  const bank = db.get("SELECT id FROM bank_accounts WHERE tenant_id=? AND active=1 ORDER BY id LIMIT 1", t)!;

  // the customer leaves an advance (cash payment beyond what's due), then we return Rs 2,000 of it in cash
  ok(await call("admin", "POST", `/api/customers/${cust.id}/khata`, { type: "credit", amount: 9000, method: "Cash" }), "advance in");
  ok(await call("admin", "POST", `/api/customers/${cust.id}/khata`, { type: "refund", amount: 2000, method: "Cash" }), "refund cash");
  const refund = db.get("SELECT id, ref, account_id FROM khata_ledger WHERE customer_id=? AND type='debit' AND ref LIKE 'refund:%' ORDER BY id DESC LIMIT 1", cust.id)!;
  assert.equal(String(refund.ref), "refund:Cash", "refund ref carries the method");

  // the View detail surfaces the method
  const det = ok(await call("admin", "GET", `/api/customers/${cust.id}/ledger/${refund.id}/detail`), "detail");
  assert.equal(det.method, "Cash", "view shows the refund method");
  assert.equal(det.is_refund, true, "view marks it a refund");
  assert.equal(det.can_edit_entry, true, "refund is editable");

  await tallyBooks("after cash refund");

  // CEO edits the refund: it actually went out from the bank, not the drawer
  ok(await call("admin", "POST", `/api/corrections/entry/khata/${refund.id}/full-edit`, { reason: "Bank se gaya tha", method: "Bank transfer", account_id: bank.id }), "edit method to bank");
  const after = db.get("SELECT ref, account_id FROM khata_ledger WHERE customer_id=? AND type='debit' AND ref LIKE 'refund:%' ORDER BY id DESC LIMIT 1", cust.id)!;
  assert.equal(String(after.ref), "refund:Bank transfer", "ref now carries the new method");
  assert.equal(after.account_id, bank.id, "refund now points at the bank account");
  await tallyBooks("after refund method edit");
});
