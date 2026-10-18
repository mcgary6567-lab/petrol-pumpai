/** CEO full edit: party, kind, date, amount, method move together; old party's balance comes back, new one takes it; cash book, voucher and books follow. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { Server } from "node:http";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pumpai-fulledit-"));
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
const near = (a: number, b: number, m?: string) => assert.ok(Math.abs(a - b) < 0.6, `${m ?? ""} ${a} ≈ ${b}`);
const books = async () => { const c = ok(await call("admin", "GET", "/api/books/check"), "books"); assert.deepEqual(c.checks.filter((r: any) => !r.ok && !r.advisory).map((r: any) => r.label), [], "books tally"); };
const cashNow = async () => ok(await call("admin", "GET", "/api/owner/overview"), "overview").money.office_cash as number;

before(async () => {
  const { app } = await import("../src/index.js");
  db = await import("../src/db.js");
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  for (const who of ["admin", "cashier", "wholesale"]) tokens[who] = (await call("", "POST", "/api/auth/login", { email: `${who}@pumpai.pk`, password: "demo1234" })).data.token;
});
after(() => { server?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test("khata: a cashier's cash payment moved to another customer, another day, another amount — balances, cash and the voucher follow", async () => {
  const custs = ok(await call("admin", "GET", "/api/customers?q="), "customers").filter((c: any) => c.balance > 10000);
  const [a, b] = custs;
  const balA0 = a.balance, balB0 = b.balance, cash0 = await cashNow();
  // the cashier books 52,00,000 cash on A by mistake (meant 52,000 on B, two days ago)
  const v = ok(await call("cashier", "POST", "/api/cashier/receive", { party_type: "khata", party_id: a.id, amount: 5200000, method: "Cash", notify: false }), "receive").voucher;
  near(await cashNow(), cash0 + 5200000, "cash up by the wrong amount");
  const khataId = Number(String(v.src).split(":")[1]);
  const info = ok(await call("admin", "GET", `/api/corrections/entry/khata/${khataId}`), "entry info");
  assert.equal(info.kind, "khata"); assert.equal(info.entry.party_id, a.id); assert.equal(info.voucher.id, v.id); assert.ok(info.parties.some((p: any) => p.id === b.id));
  const twoDaysAgo = new Date(Date.now() + 5 * 3600_000 - 2 * 86400_000).toISOString().slice(0, 10);
  const r = ok(await call("admin", "POST", `/api/corrections/entry/khata/${khataId}/full-edit`, { reason: "galat customer, galat raqam", party_id: b.id, day: twoDaysAgo, amount: 52000, method: "Cash", ref: "123" }), "full edit");
  near(r.balances.old_party, balA0, "A back to where it was");
  near(r.balances.new_party, balB0 - 52000, "B paid 52,000");
  // moved before the last cash count → that count already covers it (cash back to the counted figure); after it → +52,000
  const nkRow = db.get("SELECT created_at FROM khata_ledger WHERE id=?", r.new_id) as any;
  const lastCount = db.get("SELECT created_at FROM cash_counts WHERE tenant_id=1 ORDER BY created_at DESC LIMIT 1") as any;
  near(await cashNow(), lastCount && lastCount.created_at >= nkRow.created_at ? cash0 : cash0 + 52000, "cash follows the corrected entry on its day");
  const nk = db.get("SELECT * FROM khata_ledger WHERE id=?", r.new_id) as any;
  assert.equal(nk.customer_id, b.id); assert.ok(new Date(nk.created_at).getTime() < Date.now() - 86400_000, "stamped on the earlier day");
  const oldRow = db.get("SELECT id, customer_id, amount FROM khata_ledger WHERE id=?", khataId) as any;
  assert.ok(!oldRow || (oldRow.id === r.new_id && oldRow.customer_id === b.id), "old row gone (or its id reused by the corrected row)");
  const nv = db.get("SELECT * FROM cashier_vouchers WHERE id=?", v.id) as any;
  assert.equal(nv.party_id, b.id); near(nv.amount, 52000); assert.equal(nv.src, `khata:${r.new_id}`);
  // the same editor reached through the voucher
  const viaV = ok(await call("admin", "GET", `/api/corrections/entry/voucher/${v.id}`), "via voucher");
  assert.equal(viaV.kind, "khata"); assert.equal(viaV.id, r.new_id);
  await books();
});

test("wholesale: a payment moved to another client and switched to bank; supplier payment's date and amount changed; a POS sale line is refused", async () => {
  const clients = ok(await call("wholesale", "GET", "/api/wholesale/clients"), "clients");
  const [c1, c2] = clients;
  const acc = ok(await call("admin", "GET", "/api/bank/accounts"), "banks").accounts.find((x: any) => x.active).id;
  const due1 = c1.due, due2 = c2.due;
  const p = ok(await call("wholesale", "POST", `/api/wholesale/clients/${c1.id}/payment`, { amount: 10000, method: "Cash" }), "pay c1");
  const wid = p.id ?? p.txn?.id ?? (db.get("SELECT MAX(id) id FROM wholesale_txns WHERE client_id=? AND type='payment'", c1.id) as any).id;
  const r = ok(await call("admin", "POST", `/api/corrections/entry/wholesale/${wid}/full-edit`, { reason: "doosre client ki thi, bank se aayi", party_id: c2.id, method: "Bank transfer", account_id: acc, amount: 10000 }), "wholesale full edit");
  near(r.balances.old_party, due1, "c1 due back"); near(r.balances.new_party, due2 - 10000, "c2 due down");
  assert.equal((db.get("SELECT voided FROM wholesale_txns WHERE id=?", wid) as any).voided, 1);
  const nw = db.get("SELECT * FROM wholesale_txns WHERE id=?", r.new_id) as any;
  assert.equal(nw.client_id, c2.id); assert.equal(nw.method, "Bank transfer"); assert.equal(nw.account_id, acc);

  const sup = ok(await call("admin", "GET", "/api/suppliers"), "suppliers")[0];
  const owed0 = sup.owed;
  ok(await call("admin", "POST", `/api/suppliers/${sup.id}/payment`, { amount: 7000, method: "Cash" }), "pay supplier");
  const sid = (db.get("SELECT MAX(id) id FROM supplier_txns WHERE supplier_id=? AND type='payment'", sup.id) as any).id;
  const lastWeek = new Date(Date.now() + 5 * 3600_000 - 7 * 86400_000).toISOString().slice(0, 10);
  const r2 = ok(await call("admin", "POST", `/api/corrections/entry/supplier/${sid}/full-edit`, { reason: "pichle hafte ki thi, 7,500", day: lastWeek, amount: 7500 }), "supplier full edit");
  near(r2.balances.new_party, owed0 - 7500, "supplier owed reflects 7,500");
  const ns = db.get("SELECT * FROM supplier_txns WHERE id=?", r2.new_id) as any;
  assert.equal(ns.txn_date.slice(0, 10) <= lastWeek, true, "moved to last week");

  // a khata line that came from a POS sale is not this editor's
  const saleLine = db.get("SELECT k.id FROM khata_ledger k JOIN customers c ON c.id=k.customer_id WHERE c.tenant_id=1 AND k.product IS NOT NULL LIMIT 1") as any;
  if (saleLine) { const info = ok(await call("admin", "GET", `/api/corrections/entry/khata/${saleLine.id}`), "sale line info"); assert.match(info.locked, /Sale edit/); assert.equal((await call("admin", "POST", `/api/corrections/entry/khata/${saleLine.id}/full-edit`, { reason: "try", amount: 1 })).status, 400); }
  // a manager cannot
  assert.equal((await call("cashier", "POST", `/api/corrections/entry/supplier/${r2.new_id}/full-edit`, { reason: "try", amount: 1 })).status, 403);
  await books();
});
